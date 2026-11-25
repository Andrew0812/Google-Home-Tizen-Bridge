/**
 * Google Local Home SDK Application for Samsung Tizen TV Bridge
 * Executes directly on Google Nest Hub, Google Home speakers, and mobile devices
 * 
 * Flow:
 * 1. onIdentify: Discovers Samsung TVs on the local Wi-Fi via mDNS / UPnP / REST
 * 2. onExecute: Dispatches volume (+/-) and key commands via local WebSocket (port 8002) in 2-5ms
 * 3. Automatic Cloud Fallback: Throws HandlerError if local TV is unreachable, triggering Cloudflare
 */

(function () {
  'use strict';

  // In Node.js runtime (Nest Audio / Nest Mini), allow self-signed Samsung TV TLS certificates on port 8002
  if (typeof process !== 'undefined' && process.env) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  // Universal smarthome resolution for both Chrome (Nest Hub) and Node.js (Nest Audio / Mini)
  var globalScope = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : {}));
  var smarthome = globalScope.smarthome;
  if (!smarthome && typeof require === 'function') {
    try {
      smarthome = require('@google/local-home-sdk');
    } catch (e) {}
  }

  if (!smarthome) {
    console.warn('[LocalHome] smarthome namespace not found. Ensure this runs inside Google Local Home SDK runtime.');
    return;
  }

  var app = new smarthome.App('1.0.0');

  // Helper: Base64 encoder compatible with both Browser and Node.js
  function toBase64(str) {
    if (typeof btoa === 'function') return btoa(str);
    if (typeof Buffer !== 'undefined') return Buffer.from(str).toString('base64');
    return '';
  }

  // Local IP, Token, and Active WebSocket connection pools mapped by Device ID / IP
  var localDeviceMap = new Map();
  var tokenCacheByIp = new Map();
  var wsPoolByIp = new Map();

  function cleanMac(mac) {
    return String(mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  }

  function extractIpFromScanData(scanData) {
    if (!scanData) return null;
    if (scanData.ipAddress) return scanData.ipAddress;
    if (scanData.address) return scanData.address;
    if (scanData.location) {
      try {
        var u = new URL(scanData.location);
        if (u.hostname) return u.hostname;
      } catch (e) {}
    }
    if (scanData.host) {
      return scanData.host.replace(/:[0-9]+$/, '');
    }
    return null;
  }

  /**
   * Handler 1: IDENTIFY (Matches discovered local TV to Google Home device ID)
   */
  app.onIdentify(async function (identifyRequest) {
    var device = identifyRequest.inputs[0]?.payload?.device;
    if (!device) {
      throw new smarthome.IntentFlow.HandlerError(identifyRequest.requestId, 'deviceNotFound');
    }

    var scanData = device.mdnsScanData || device.upnpScanData || device.udpScanData;
    var ip = extractIpFromScanData(scanData);

    if (!ip) {
      throw new smarthome.IntentFlow.HandlerError(identifyRequest.requestId, 'deviceNotFound');
    }

    // Probe TV local REST info endpoint (port 8001) for unique hardware details
    var tvInfo = null;
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 1200);
      var res = await fetch('http://' + ip + ':8001/api/v2/', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        tvInfo = await res.json();
      }
    } catch (e) {}

    var wifiMac = cleanMac(tvInfo?.device?.wifiMac || tvInfo?.device?.mac);
    var duid = tvInfo?.device?.id || '';
    var tvName = tvInfo?.device?.name || 'Samsung TV';

    // Match against existing synced devices (supports multi-TV setups via customData.deviceId, MAC, or DUID)
    var matchedVerificationId = 'samsung-tizen-tv-local';
    var existingDevices = identifyRequest.devices || [];
    for (var d = 0; d < existingDevices.length; d++) {
      var existing = existingDevices[d];
      var cData = existing.customData || {};
      if (cData.localIp && cData.localIp === ip && existing.id) {
        matchedVerificationId = existing.id;
        break;
      }
      if (duid && cData.duid === duid && existing.id) {
        matchedVerificationId = existing.id;
        break;
      }
      if (wifiMac && cleanMac(cData.wifiMac) === wifiMac && existing.id) {
        matchedVerificationId = existing.id;
        break;
      }
    }

    var entry = { ip: ip, wifiMac: wifiMac, duid: duid, tvName: tvName, lastSeen: Date.now() };
    localDeviceMap.set(matchedVerificationId, entry);
    localDeviceMap.set('samsung-tizen-tv-local', entry);
    localDeviceMap.set('samsung-tv-local', entry);
    localDeviceMap.set('default-tv', entry);
    if (duid) localDeviceMap.set(duid, entry);
    if (wifiMac) localDeviceMap.set(wifiMac, entry);

    return {
      intent: smarthome.Intents.IDENTIFY,
      requestId: identifyRequest.requestId,
      payload: {
        device: {
          id: matchedVerificationId,
          verificationId: matchedVerificationId,
        },
      },
    };
  });

  /**
   * Helper: Connect or reuse a pooled WebSocket to Samsung TV (waits for ms.channel.connect)
   * Automatically falls back from wss://:8002 to ws://:8001 if self-signed TLS is rejected by runtime
   */
  function getOrConnectTvSocket(ip, initialToken) {
    var pooled = wsPoolByIp.get(ip);
    if (pooled && pooled.ws && pooled.ready && pooled.ws.readyState === 1) {
      return Promise.resolve(pooled.ws);
    }

    var activeToken = tokenCacheByIp.get(ip) || initialToken || '';
    var appNameBase64 = toBase64('GoogleNestBridge');

    function attemptConnection(useTls) {
      return new Promise(function (resolve, reject) {
        var tokenParam = activeToken ? ('&token=' + encodeURIComponent(activeToken)) : '';
        var wsUrl = useTls
          ? ('wss://' + ip + ':8002/api/v2/channels/samsung.remote.control?name=' + appNameBase64 + tokenParam)
          : ('ws://' + ip + ':8001/api/v2/channels/samsung.remote.control?name=' + appNameBase64 + tokenParam);

        var ws;
        var settled = false;
        var connectTimer = setTimeout(function () {
          if (!settled) {
            settled = true;
            try { if (ws) ws.close(); } catch (e) {}
            reject(new Error('WebSocket handshake timeout on ' + wsUrl));
          }
        }, 1600);

        try {
          ws = new WebSocket(wsUrl);
        } catch (err) {
          clearTimeout(connectTimer);
          return reject(err);
        }

        function markReady() {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          var idleTimer = setTimeout(function () {
            try { ws.close(); } catch (e) {}
            wsPoolByIp.delete(ip);
          }, 25000);
          wsPoolByIp.set(ip, { ws: ws, ready: true, idleTimer: idleTimer });
          resolve(ws);
        }

        ws.onopen = function () {
          // Wait up to 350ms for ms.channel.connect before marking ready as fallback
          setTimeout(function () {
            if (!settled && ws.readyState === 1) {
              markReady();
            }
          }, 350);
        };

        ws.onmessage = function (event) {
          try {
            var data = JSON.parse(event.data);
            if (data.event === 'ms.channel.connect') {
              if (data.data && data.data.token) {
                tokenCacheByIp.set(ip, String(data.data.token));
              }
              markReady();
            } else if (data.event === 'ms.channel.unauthorized') {
              if (!settled) {
                settled = true;
                clearTimeout(connectTimer);
                reject(new Error('TV remote connection unauthorized'));
              }
            }
          } catch (e) {}
        };

        ws.onerror = function (err) {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            try { ws.close(); } catch (e) {}
            reject(err || new Error('WebSocket error on ' + wsUrl));
          }
        };

        ws.onclose = function () {
          wsPoolByIp.delete(ip);
        };
      });
    }

    return attemptConnection(true).catch(function () {
      return attemptConnection(false);
    });
  }

  /**
   * Helper: Send one or more hardware key commands over a single persistent WebSocket
   */
  async function sendLocalKeyBatch(ip, keys, token) {
    var keyList = Array.isArray(keys) ? keys : [keys];
    var ws = await getOrConnectTvSocket(ip, token);

    for (var idx = 0; idx < keyList.length; idx++) {
      var payload = {
        method: 'ms.remote.control',
        params: {
          Cmd: 'Click',
          DataOfCmd: keyList[idx],
          Option: 'false',
          TypeOfRemote: 'SendRemoteKey',
        },
      };
      ws.send(JSON.stringify(payload));
      if (idx < keyList.length - 1) {
        await new Promise(function (r) { setTimeout(r, 45); });
      }
    }
    return { success: true, count: keyList.length };
  }

  /**
   * Handler 2: EXECUTE (Local Wi-Fi Command Execution with Cloud Fallback)
   */
  app.onExecute(async function (executeRequest) {
    var commands = executeRequest.inputs[0]?.payload?.commands || [];
    var commandResponses = [];

    for (var i = 0; i < commands.length; i++) {
      var commandGroup = commands[i];
      for (var j = 0; j < commandGroup.devices.length; j++) {
        var targetDevice = commandGroup.devices[j];
        var deviceId = targetDevice.id;
        var customData = targetDevice.customData || {};

        var targetIp = customData.localIp || null;
        var cachedToken = customData.localToken || '';

        if (!targetIp && localDeviceMap.has(deviceId)) {
          targetIp = localDeviceMap.get(deviceId).ip;
        }
        if (!targetIp && localDeviceMap.has('samsung-tizen-tv-local')) {
          targetIp = localDeviceMap.get('samsung-tizen-tv-local').ip;
        }
        if (!targetIp && localDeviceMap.has('default-tv')) {
          targetIp = localDeviceMap.get('default-tv').ip;
        }

        if (!targetIp) {
          throw new smarthome.IntentFlow.HandlerError(executeRequest.requestId, 'deviceOffline');
        }

        var states = { online: true };

        try {
          for (var k = 0; k < commandGroup.execution.length; k++) {
            var execution = commandGroup.execution[k];
            var command = execution.command;
            var params = execution.params || {};

            switch (command) {
              case 'action.devices.commands.volumeRelative': {
                var isUp = params.volumeRelativeLevel > 0;
                var stepCount = Math.min(Math.max(1, Math.abs(params.volumeRelativeLevel || 1)), 6);
                var key = isUp ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
                var batchKeys = [];
                for (var s = 0; s < stepCount; s++) {
                  batchKeys.push(key);
                }
                await sendLocalKeyBatch(targetIp, batchKeys, cachedToken);
                states.isMuted = false;
                break;
              }

              case 'action.devices.commands.mute': {
                await sendLocalKeyBatch(targetIp, ['KEY_MUTE'], cachedToken);
                states.isMuted = params.mute;
                break;
              }

              case 'action.devices.commands.OnOff': {
                var powerKey = params.on ? 'KEY_POWER' : 'KEY_POWEROFF';
                await sendLocalKeyBatch(targetIp, [powerKey], cachedToken);
                states.on = params.on;
                states.activityState = params.on ? 'ACTIVE' : 'STANDBY';
                if (!params.on) states.playbackState = 'STOPPED';
                break;
              }

              case 'action.devices.commands.mediaPause': {
                await sendLocalKeyBatch(targetIp, ['KEY_PAUSE'], cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PAUSED';
                break;
              }

              case 'action.devices.commands.mediaResume': {
                await sendLocalKeyBatch(targetIp, ['KEY_PLAY'], cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PLAYING';
                break;
              }

              case 'action.devices.commands.mediaStop': {
                await sendLocalKeyBatch(targetIp, ['KEY_STOP'], cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'STOPPED';
                break;
              }

              case 'action.devices.commands.mediaNext': {
                await sendLocalKeyBatch(targetIp, ['KEY_FF'], cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PLAYING';
                break;
              }

              case 'action.devices.commands.mediaPrevious': {
                await sendLocalKeyBatch(targetIp, ['KEY_REWIND'], cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PLAYING';
                break;
              }

              default:
                throw new Error('Command ' + command + ' delegates to cloud');
            }
          }

          commandResponses.push({
            ids: [deviceId],
            status: 'SUCCESS',
            states: states,
          });
        } catch (execError) {
          throw new smarthome.IntentFlow.HandlerError(executeRequest.requestId, 'deviceOffline');
        }
      }
    }

    return {
      intent: smarthome.Intents.EXECUTE,
      requestId: executeRequest.requestId,
      payload: {
        commands: commandResponses,
      },
    };
  });

  app.listen().catch(function (err) {
    console.error('[LocalHome] Failed to start Local Home SDK listener:', err);
  });
})();
