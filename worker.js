/**
 * SmartBridge Tizen — Cloudflare Worker Serverless Bridge
 * 
 * Connects Google Home / Google Nest Hub to Samsung Smart TVs running TizenOS via SmartThings.
 * 
 * Hosting: Cloudflare Workers (100% Free Forever - 100,000 requests/day, $0.00/mo, No Credit Card Required)
 * Worker URL: https://tizen-bridge.<your-subdomain>.workers.dev
 * 
 * AUTHENTICATION MODES:
 * 1. Permanent Automated 24/7 Mode (OAuth 2.0 with Auto-Refresh):
 *    - Visit https://tizen-bridge.<your-subdomain>.workers.dev/oauth/login to link your Samsung account.
 *    - Automatically exchanges tokens and uses SMARTTHINGS_REFRESH_TOKEN to renew access tokens forever.
 * 
 * 2. Instant Testing Mode (Personal Access Token - valid 24 hours):
 *    - Generate at https://account.smartthings.com/tokens and set SMARTTHINGS_TOKEN in Cloudflare Variables.
 * 
 * Endpoints:
 * - Google Cloud-to-Cloud Fulfillment: https://tizen-bridge.<your-subdomain>.workers.dev/smarthome
 * - Google Assistant Voice Routine:     https://tizen-bridge.<your-subdomain>.workers.dev/voice-command
 * - OAuth Login (Generate Refresh Token):https://tizen-bridge.<your-subdomain>.workers.dev/oauth/login
 * - Device List (Find Your TV ID):      https://tizen-bridge.<your-subdomain>.workers.dev/devices
 * - Health & Status Check:             https://tizen-bridge.<your-subdomain>.workers.dev/health
 */

// In-memory cache for refreshed access token and installed device ID on the edge
let cachedAccessToken = null;
let cachedTokenExpiry = 0;
let refreshInFlight = null;
let cachedDeviceId = null;
let cachedTvStatus = null;
let cachedTvStatusExpiry = 0;

// Google Local Home SDK Application bundle served directly to Nest Hubs & Phones
const LOCAL_HOME_APP_SCRIPT = `/**
 * Google Local Home SDK Application for Samsung Tizen TV Bridge
 * Executes directly on Google Nest Hub, Google Home speakers, and mobile devices
 */
(function () {
  'use strict';
  var globalScope = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : {}));
  var smarthome = globalScope.smarthome;
  if (!smarthome && typeof require === 'function') {
    try { smarthome = require('@google/local-home-sdk'); } catch (e) {}
  }
  if (!smarthome) {
    console.warn('[LocalHome] smarthome namespace not found.');
    return;
  }
  var app = new smarthome.App('1.0.0');
  var localDeviceMap = new Map();

  function toBase64(str) {
    if (typeof btoa === 'function') return btoa(str);
    if (typeof Buffer !== 'undefined') return Buffer.from(str).toString('base64');
    return '';
  }

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
    if (scanData.host) return scanData.host.replace(/:[0-9]+$/, '');
    return null;
  }

  app.onIdentify(async function (identifyRequest) {
    var device = identifyRequest.inputs[0]?.payload?.device;
    if (!device) throw new smarthome.IntentFlow.HandlerError(identifyRequest.requestId, 'deviceNotFound');

    var scanData = device.mdnsScanData || device.upnpScanData || device.udpScanData;
    var ip = extractIpFromScanData(scanData);
    if (!ip) throw new smarthome.IntentFlow.HandlerError(identifyRequest.requestId, 'deviceNotFound');

    var tvInfo = null;
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 1200);
      var res = await fetch('http://' + ip + ':8001/api/v2/', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) tvInfo = await res.json();
    } catch (e) {}

    var wifiMac = cleanMac(tvInfo?.device?.wifiMac || tvInfo?.device?.mac);
    var duid = tvInfo?.device?.id || '';
    var tvName = tvInfo?.device?.name || 'Samsung TV';

    var primaryVerificationId = 'samsung-tizen-tv-local';
    var entry = { ip: ip, wifiMac: wifiMac, duid: duid, tvName: tvName, lastSeen: Date.now() };
    localDeviceMap.set(primaryVerificationId, entry);
    localDeviceMap.set('default-tv', entry);
    if (duid) localDeviceMap.set(duid, entry);
    if (wifiMac) localDeviceMap.set(wifiMac, entry);

    return {
      intent: smarthome.Intents.IDENTIFY,
      requestId: identifyRequest.requestId,
      payload: {
        device: {
          id: primaryVerificationId,
          verificationId: primaryVerificationId,
        },
      },
    };
  });

  function sendLocalKeyCommand(ip, key, token) {
    return new Promise(function (resolve, reject) {
      var appNameBase64 = toBase64('GoogleNestBridge');
      var tokenParam = token ? ('&token=' + encodeURIComponent(token)) : '';
      var wsUrl = 'wss://' + ip + ':8002/api/v2/channels/samsung.remote.control?name=' + appNameBase64 + tokenParam;

      var ws;
      var timer = setTimeout(function () {
        if (ws) {
          try { ws.close(); } catch (e) {}
        }
        reject(new Error('WebSocket to ' + ip + ':8002 timed out'));
      }, 1500);

      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      ws.onopen = function () {
        var payload = {
          method: 'ms.remote.control',
          params: {
            Cmd: 'Click',
            DataOfCmd: key,
            Option: 'false',
            TypeOfRemote: 'SendRemoteKey',
          },
        };
        ws.send(JSON.stringify(payload));
        setTimeout(function () {
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          resolve({ success: true, key: key });
        }, 60);
      };

      ws.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data);
          if (data.event === 'ms.channel.connect' && data.data?.token) {
            console.log('[LocalHome] Received pairing token: ' + data.data.token);
          }
        } catch (e) {}
      };

      ws.onerror = function (err) {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

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
                var stepCount = Math.min(Math.max(1, Math.abs(params.volumeRelativeLevel || 1)), 5);
                var key = isUp ? 'KEY_VOLUP' : 'KEY_VOLDOWN';

                for (var s = 0; s < stepCount; s++) {
                  await sendLocalKeyCommand(targetIp, key, cachedToken);
                }
                states.isMuted = false;
                break;
              }

              case 'action.devices.commands.mute': {
                await sendLocalKeyCommand(targetIp, 'KEY_MUTE', cachedToken);
                states.isMuted = params.mute;
                break;
              }

              case 'action.devices.commands.OnOff': {
                var powerKey = params.on ? 'KEY_POWER' : 'KEY_POWEROFF';
                await sendLocalKeyCommand(targetIp, powerKey, cachedToken);
                states.on = params.on;
                break;
              }

              case 'action.devices.commands.mediaPause': {
                await sendLocalKeyCommand(targetIp, 'KEY_PAUSE', cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PAUSED';
                break;
              }

              case 'action.devices.commands.mediaResume': {
                await sendLocalKeyCommand(targetIp, 'KEY_PLAY', cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'PLAYING';
                break;
              }

              case 'action.devices.commands.mediaStop': {
                await sendLocalKeyCommand(targetIp, 'KEY_STOP', cachedToken);
                states.activityState = 'ACTIVE';
                states.playbackState = 'STOPPED';
                break;
              }

              default:
                throw new Error('Unsupported local command, delegating to cloud');
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

  app.listen().catch(function (err) { console.error('[LocalHome] Listener error:', err); });
})();
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    const baseUrl = `https://${url.host}`;

    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Configuration from Cloudflare Environment Variables / Secrets
    const CLIENT_ID = env.SMARTTHINGS_CLIENT_ID || '';
    const CLIENT_SECRET = env.SMARTTHINGS_CLIENT_SECRET || '';
    const REFRESH_TOKEN = env.SMARTTHINGS_REFRESH_TOKEN || '';
    const DIRECT_TOKEN = env.SMARTTHINGS_TOKEN || '';
    const ST_DEVICE_ID = env.SMARTTHINGS_DEVICE_ID || '';
    const TV_NAME = env.TV_NAME || 'Living Room TV';

    // Helper: JSON response with CORS
    const json = (data, status = 200) => {
      return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    };

    // Helper: HTML response
    const html = (content, status = 200) => {
      return new Response(content, {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    };

    // Helper: Refresh SmartThings OAuth token safely (with concurrency lock & KV-first single-use token rotation)
    async function refreshSmartThingsToken() {
      if (refreshInFlight) {
        return refreshInFlight;
      }

      refreshInFlight = (async () => {
        // CRITICAL: Always read KV REFRESH_TOKEN before static env var,
        // because SmartThings refresh tokens are single-use and rotate on every refresh!
        const kvRefresh = env.TIZEN_KV ? await env.TIZEN_KV.get('REFRESH_TOKEN') : '';
        const effectiveRefreshToken = kvRefresh || REFRESH_TOKEN;

        if (!effectiveRefreshToken || !CLIENT_ID || !CLIENT_SECRET) {
          throw new Error(
            'Cannot refresh SmartThings token: missing REFRESH_TOKEN, SMARTTHINGS_CLIENT_ID, or SMARTTHINGS_CLIENT_SECRET.'
          );
        }

        const tokenUrl = 'https://api.smartthings.com/oauth/token';
        const basicAuth = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

        const params = new URLSearchParams();
        params.append('grant_type', 'refresh_token');
        params.append('client_id', CLIENT_ID);
        params.append('refresh_token', effectiveRefreshToken);

        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: params.toString(),
        });

        if (!res.ok) {
          const errText = await res.text();
          if (env.TIZEN_KV) {
            await env.TIZEN_KV.put('LAST_ERROR', JSON.stringify({
              timestamp: new Date().toISOString(),
              source: 'refreshSmartThingsToken',
              status: res.status,
              error: errText,
            })).catch(() => {});
          }
          throw new Error(`Failed to refresh SmartThings OAuth token (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const expiresInSec = Number(data.expires_in) || 86400;
        const expiryMs = Date.now() + expiresInSec * 1000;

        cachedAccessToken = data.access_token;
        cachedTokenExpiry = expiryMs;

        if (env.TIZEN_KV) {
          await env.TIZEN_KV.put('AUTH_TOKEN', data.access_token);
          await env.TIZEN_KV.put('AUTH_TOKEN_EXPIRY', String(expiryMs));
          if (data.refresh_token) {
            await env.TIZEN_KV.put('REFRESH_TOKEN', data.refresh_token);
          }
          await env.TIZEN_KV.put('LAST_TOKEN_REFRESH', JSON.stringify({
            timestamp: new Date().toISOString(),
            expiresAt: new Date(expiryMs).toISOString(),
            rotatedRefreshToken: !!data.refresh_token,
          }));
          await env.TIZEN_KV.delete('LAST_ERROR').catch(() => {});
        }

        return cachedAccessToken;
      })();

      try {
        return await refreshInFlight;
      } finally {
        refreshInFlight = null;
      }
    }

    // Helper: Check if OAuth auto-refresh is available
    async function canAutoRefresh() {
      if (!CLIENT_ID || !CLIENT_SECRET) return false;
      if (REFRESH_TOKEN) return true;
      if (env.TIZEN_KV) {
        const kvRefresh = await env.TIZEN_KV.get('REFRESH_TOKEN');
        if (kvRefresh) return true;
      }
      return false;
    }

    // Helper: Get a valid access token (using direct token, KV storage with expiry check, or OAuth refresh)
    async function getActiveToken(forceRefresh = false) {
      // 1. Direct Personal Access Token (if provided in Cloudflare Variables)
      if (DIRECT_TOKEN) {
        return DIRECT_TOKEN;
      }

      const now = Date.now();

      // 2. Forced refresh (e.g. after a 401 from SmartThings) bypasses stale memory & KV access tokens
      if (forceRefresh) {
        cachedAccessToken = null;
        cachedTokenExpiry = 0;
        return await refreshSmartThingsToken();
      }

      // 3. Cached in-memory token (if still valid for at least 15 minutes)
      if (cachedAccessToken && now < cachedTokenExpiry - 900000) {
        return cachedAccessToken;
      }

      // 4. Persistent Token from Cloudflare KV (if bound and not known to be expired)
      if (env.TIZEN_KV) {
        const kvToken = await env.TIZEN_KV.get('AUTH_TOKEN');
        const kvExpiryRaw = await env.TIZEN_KV.get('AUTH_TOKEN_EXPIRY');
        const kvExpiry = kvExpiryRaw ? parseInt(kvExpiryRaw, 10) : 0;

        if (kvToken) {
          const isKnownExpired = kvExpiry > 0 && now >= kvExpiry - 900000;
          if (!isKnownExpired) {
            cachedAccessToken = kvToken;
            cachedTokenExpiry = kvExpiry > 0 ? kvExpiry : (now + 3600000);
            return kvToken;
          }
        }
      }

      // 5. Auto-refresh via OAuth Refresh Token
      if (await canAutoRefresh()) {
        return await refreshSmartThingsToken();
      }

      throw new Error(
        'No valid SmartThings authentication found. Set SMARTTHINGS_TOKEN in Cloudflare Variables, or bind TIZEN_KV in Cloudflare Settings > Bindings.'
      );
    }

    // Helper: Send commands to SmartThings REST API
    async function sendSmartThingsCommands(commands) {
      let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
      if (!effectiveDeviceId && env.TIZEN_KV) {
        effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
      }

      if (!effectiveDeviceId) {
        throw new Error('SMARTTHINGS_DEVICE_ID is not configured in Cloudflare environment variables.');
      }

      const token = await getActiveToken(false);
      const stUrl = `https://api.smartthings.com/v1/devices/${effectiveDeviceId}/commands`;

      let res = await fetch(stUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      });

      // If token expired, force-refresh (bypassing stale KV AUTH_TOKEN) and retry once
      if (res.status === 401 && await canAutoRefresh()) {
        const freshToken = await getActiveToken(true);
        res = await fetch(stUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${freshToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ commands }),
        });
      }

      if (!res.ok) {
        const errText = await res.text();
        if (env.TIZEN_KV) {
          await env.TIZEN_KV.put('LAST_ERROR', JSON.stringify({
            timestamp: new Date().toISOString(),
            source: 'sendSmartThingsCommands',
            status: res.status,
            error: errText,
          })).catch(() => {});
        }
        throw new Error(`SmartThings API error (${res.status}): ${errText}`);
      }
      return await res.json();
    }

    // -------------------------------------------------------------------------
    // Helpers: Input Source Formatting & Normalization for Google Home
    // -------------------------------------------------------------------------
    function formatInputSourcesForGoogle(rawInputs) {
      if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
        // Safe 2-port default for Samsung TVs (HDMI 1, HDMI 2, and TV/Antenna)
        return [
          { key: 'HDMI1', names: [{ lang: 'en', name_synonym: ['HDMI 1', 'HDMI One', 'Input 1', 'Apple TV', 'PlayStation'] }] },
          { key: 'HDMI2', names: [{ lang: 'en', name_synonym: ['HDMI 2', 'HDMI Two', 'Input 2', 'Xbox', 'Console'] }] },
          { key: 'TV', names: [{ lang: 'en', name_synonym: ['TV', 'Live TV', 'Antenna', 'Digital TV'] }] },
        ];
      }

      const result = [];
      const seenKeys = new Set();

      for (const raw of rawInputs) {
        let rawId = '';
        let rawName = '';

        if (typeof raw === 'object' && raw !== null) {
          rawId = String(raw.id || '').trim();
          rawName = String(raw.name || '').trim();
        } else {
          rawId = String(raw || '').trim();
          rawName = rawId;
        }

        if (!rawId && !rawName) continue;
        if (!rawId) rawId = rawName;
        if (!rawName) rawName = rawId;

        const idUpper = rawId.toUpperCase();
        const nameUpper = rawName.toUpperCase();

        // Determine standardized Google trait key
        let key = rawId;
        const isTv = ['DTV', 'TV', 'DIGITALTV', 'ANTENNA', 'TUNER'].includes(idUpper) ||
                     ['DTV', 'TV', 'DIGITALTV', 'ANTENNA', 'TUNER', 'LIVE TV'].includes(nameUpper);

        const hdmiMatch = idUpper.match(/^HDMI\s*([0-9]+)$/) || nameUpper.match(/^HDMI\s*([0-9]+)$/);

        if (isTv) {
          key = 'TV';
        } else if (hdmiMatch) {
          key = `HDMI${hdmiMatch[1]}`;
        }

        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const synonyms = [];
        const addSynonym = (syn) => {
          const s = String(syn || '').trim();
          if (s && !synonyms.some(existing => existing.toLowerCase() === s.toLowerCase())) {
            synonyms.push(s);
          }
        };

        if (isTv) {
          addSynonym(rawName || 'TV');
          ['TV', 'Live TV', 'Antenna', 'Digital TV', 'dtv', 'Tuner', 'Television'].forEach(addSynonym);
        } else {
          // In Google Home UI, the first entry in name_synonym is the display label!
          // Prioritize the custom name detected by Samsung (e.g. "XBOX SeriesX|S" or "Game Console")
          addSynonym(rawName);

          // Punctuation-free variation (e.g. "XBOX SeriesX|S" -> "XBOX SeriesX S")
          const cleanName = rawName.replace(/[|/_\\-]/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanName) addSynonym(cleanName);

          // Smart device category synonyms based on name
          const combined = `${nameUpper} ${idUpper}`;
          if (combined.includes('XBOX')) {
            ['Xbox', 'Xbox Series X', 'Xbox Series S', 'Xbox One', 'Console', 'Game Console'].forEach(addSynonym);
          } else if (combined.includes('PLAYSTATION') || combined.includes('PS5') || combined.includes('PS4')) {
            ['PlayStation', 'PlayStation 5', 'PS5', 'PS4', 'Console', 'Game Console'].forEach(addSynonym);
          } else if (combined.includes('SWITCH') || combined.includes('NINTENDO')) {
            ['Nintendo Switch', 'Switch', 'Nintendo', 'Console'].forEach(addSynonym);
          } else if (combined.includes('APPLE')) {
            ['Apple TV', 'AppleTV'].forEach(addSynonym);
          } else if (combined.includes('CHROMECAST') || combined.includes('GOOGLE')) {
            ['Chromecast', 'Google TV'].forEach(addSynonym);
          } else if (combined.includes('SHIELD')) {
            ['Nvidia Shield', 'Shield'].forEach(addSynonym);
          } else if (combined.includes('GAME') || combined.includes('CONSOLE')) {
            ['Console', 'Game Console', 'Gaming'].forEach(addSynonym);
          } else if (combined.includes('PC') || combined.includes('COMPUTER')) {
            ['PC', 'Computer', 'Desktop', 'Laptop'].forEach(addSynonym);
          } else if (combined.includes('CABLE') || combined.includes('SET TOP') || combined.includes('STB')) {
            ['Cable', 'Cable Box', 'Set Top Box'].forEach(addSynonym);
          }

          // Port-level synonyms so the user can always say "switch to HDMI 1" or "Input 1"
          if (hdmiMatch) {
            const num = hdmiMatch[1];
            const numWords = { '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four' };
            const word = numWords[num] || num;
            [`HDMI ${num}`, `HDMI${num}`, `HDMI ${word}`, `Input ${num}`, `Port ${num}`].forEach(addSynonym);
          } else {
            addSynonym(rawId);
          }
        }

        result.push({
          key,
          names: [{ lang: 'en', name_synonym: synonyms }],
        });
      }

      if (result.length === 0) {
        return [
          { key: 'HDMI1', names: [{ lang: 'en', name_synonym: ['HDMI 1', 'Apple TV', 'PlayStation'] }] },
          { key: 'HDMI2', names: [{ lang: 'en', name_synonym: ['HDMI 2', 'Xbox', 'Console'] }] },
          { key: 'TV', names: [{ lang: 'en', name_synonym: ['TV', 'Live TV', 'Antenna'] }] },
        ];
      }

      return result;
    }

    function normalizeInputForGoogle(rawInput, availableInputs) {
      if (!Array.isArray(availableInputs) || availableInputs.length === 0) return 'HDMI1';
      if (!rawInput) return availableInputs[0].key;

      const trimmed = String(rawInput).trim();
      const upper = trimmed.toUpperCase();

      // TV / Antenna match
      if (['DIGITALTV', 'TUNER', 'ANTENNA', 'TV', 'DTV', 'LIVE TV'].includes(upper)) {
        const tvEntry = availableInputs.find(i => i.key === 'TV' || i.key.toLowerCase() === 'dtv');
        if (tvEntry) return tvEntry.key;
      }

      // 1. Exact case-insensitive key match
      const exact = availableInputs.find(i => i.key.toLowerCase() === trimmed.toLowerCase());
      if (exact) return exact.key;

      // 2. HDMI port match (e.g. "HDMI 1" -> "HDMI1")
      const hdmiMatch = upper.match(/^(?:HDMI|INPUT|PORT)\s*([0-9]+)$/);
      if (hdmiMatch) {
        const key = `HDMI${hdmiMatch[1]}`;
        const found = availableInputs.find(i => i.key.toUpperCase() === key);
        if (found) return found.key;
      }

      // 3. Match against synonyms (e.g. "Xbox" matches "XBOX SeriesX|S" input entry)
      const synMatch = availableInputs.find(i =>
        i.names?.[0]?.name_synonym?.some(s => s.toLowerCase() === trimmed.toLowerCase())
      );
      if (synMatch) return synMatch.key;

      // 4. Substring / partial match on name or key
      const subMatch = availableInputs.find(i => {
        const keyUp = i.key.toUpperCase();
        if (keyUp.includes(upper) || upper.includes(keyUp)) return true;
        return i.names?.[0]?.name_synonym?.some(s => {
          const sUp = s.toUpperCase();
          return sUp.includes(upper) || upper.includes(sUp);
        });
      });
      if (subMatch) return subMatch.key;

      return availableInputs[0]?.key || trimmed;
    }

    function mapInputToSmartThings(inputKey, supportedSources) {
      if (!inputKey) return 'HDMI1';
      const trimmed = String(inputKey).trim();
      const upper = trimmed.toUpperCase();

      if (!Array.isArray(supportedSources) || supportedSources.length === 0) {
        if (['TV', 'ANTENNA', 'TUNER', 'DTV', 'DIGITALTV'].includes(upper)) return 'dtv';
        const hdmi = upper.match(/^HDMI\s*([0-9]+)$/);
        if (hdmi) return `HDMI${hdmi[1]}`;
        return trimmed;
      }

      // Normalize all items to { id: string, name: string }
      const normalizedSources = supportedSources.map(s => {
        if (typeof s === 'object' && s !== null) {
          return { id: String(s.id || '').trim(), name: String(s.name || '').trim() };
        }
        return { id: String(s || '').trim(), name: String(s || '').trim() };
      }).filter(s => s.id || s.name);

      // 1. Direct match by ID (e.g. "HDMI1" === "HDMI1", "dtv" === "dtv")
      const idMatch = normalizedSources.find(s => s.id.toLowerCase() === trimmed.toLowerCase());
      if (idMatch) return idMatch.id;

      // 2. Match by Name (e.g. "XBOX SeriesX|S", "Game Console")
      const nameMatch = normalizedSources.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
      if (nameMatch) return nameMatch.id;

      // 3. HDMI variations (e.g. "HDMI 1", "HDMI1", "Input 1")
      const hdmiMatch = upper.match(/^(?:HDMI|INPUT|PORT)\s*([0-9]+)$/);
      if (hdmiMatch) {
        const num = hdmiMatch[1];
        const match = normalizedSources.find(s => {
          const sIdUp = s.id.toUpperCase();
          const sNameUp = s.name.toUpperCase();
          return sIdUp === `HDMI${num}` || sIdUp === `HDMI ${num}` ||
                 sNameUp === `HDMI${num}` || sNameUp === `HDMI ${num}`;
        });
        if (match) return match.id;
        return `HDMI${num}`;
      }

      // 4. TV / DTV / Tuner / Antenna
      if (['TV', 'DIGITALTV', 'ANTENNA', 'TUNER', 'DTV', 'LIVE TV'].includes(upper)) {
        const tvMatch = normalizedSources.find(s => {
          const sIdUp = s.id.toUpperCase();
          const sNameUp = s.name.toUpperCase();
          return ['DTV', 'TV', 'DIGITALTV', 'ANTENNA'].includes(sIdUp) ||
                 ['DTV', 'TV', 'DIGITALTV', 'ANTENNA', 'LIVE TV'].includes(sNameUp);
        });
        if (tvMatch) return tvMatch.id;
        return 'dtv';
      }

      // 5. Keyword / Substring match (e.g. "Xbox" matching "XBOX SeriesX|S")
      const subMatch = normalizedSources.find(s => {
        const sNameUp = s.name.toUpperCase();
        const sIdUp = s.id.toUpperCase();
        return sNameUp.includes(upper) || upper.includes(sNameUp) ||
               sIdUp.includes(upper) || upper.includes(sIdUp);
      });
      if (subMatch) return subMatch.id;

      return trimmed;
    }

    // Helper: Query live Samsung TV status from SmartThings REST API (with edge caching)
    async function getSmartThingsDeviceStatus(includeRaw = false, forceRefresh = false) {
      if (!forceRefresh && !includeRaw && cachedTvStatus && Date.now() < cachedTvStatusExpiry) {
        return cachedTvStatus;
      }

      let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
      if (!effectiveDeviceId && env.TIZEN_KV) {
        effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
      }

      if (!effectiveDeviceId) {
        return { error: 'No device ID configured in SMARTTHINGS_DEVICE_ID or TIZEN_KV.' };
      }

      try {
        const token = await getActiveToken(false);
        const stUrl = `https://api.smartthings.com/v1/devices/${effectiveDeviceId}/status`;

        let res = await fetch(stUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        // If 401 token expired, force-refresh (bypassing stale KV AUTH_TOKEN) and retry once
        if (res.status === 401 && await canAutoRefresh()) {
          const freshToken = await getActiveToken(true);
          res = await fetch(stUrl, {
            headers: {
              'Authorization': `Bearer ${freshToken}`,
            },
          });
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return { error: `SmartThings API error (${res.status}): ${errText}` };
        }

        const data = await res.json();
        const main = data.components?.main || {};

        const switchVal = main.switch?.switch?.value;
        const isOn = switchVal === 'on';
        const volumeVal = main.audioVolume?.volume?.value;
        const isMuted = main.audioMute?.mute?.value === 'muted';

        const samsungInput = main['samsungvd.mediaInputSource'] || {};
        const standardInput = main.mediaInputSource || {};

        // Modern Samsung Tizen TVs report active source in samsungvd.mediaInputSource
        const rawInputVal = samsungInput.inputSource?.value || standardInput.inputSource?.value || 'HDMI1';

        // Extract supported inputs (prioritize supportedInputSourcesMap with friendly device names)
        let supportedSources = [];
        if (Array.isArray(samsungInput.supportedInputSourcesMap?.value) && samsungInput.supportedInputSourcesMap.value.length > 0) {
          supportedSources = samsungInput.supportedInputSourcesMap.value;
        } else if (Array.isArray(standardInput.supportedInputSources?.value) && standardInput.supportedInputSources.value.length > 0) {
          supportedSources = standardInput.supportedInputSources.value;
        } else if (Array.isArray(samsungInput.supportedInputSources?.value) && samsungInput.supportedInputSources.value.length > 0) {
          supportedSources = samsungInput.supportedInputSources.value;
        }

        // Save detected inputs to KV cache asynchronously for fast SYNC responses
        if (Array.isArray(supportedSources) && supportedSources.length > 0 && env.TIZEN_KV) {
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(env.TIZEN_KV.put('SUPPORTED_INPUTS', JSON.stringify(supportedSources)).catch(() => {}));
          } else {
            env.TIZEN_KV.put('SUPPORTED_INPUTS', JSON.stringify(supportedSources)).catch(() => {});
          }
        }

        const playbackVal = (main.mediaPlayback?.playbackStatus?.value || 'playing').toUpperCase();

        const result = {
          online: switchVal !== undefined,
          on: isOn,
          currentVolume: typeof volumeVal === 'number' ? volumeVal : (parseInt(volumeVal, 10) || 20),
          isMuted: isMuted,
          currentInput: rawInputVal,
          supportedInputs: supportedSources,
          playbackState: playbackVal === 'PAUSED' ? 'PAUSED' : playbackVal === 'STOPPED' ? 'STOPPED' : 'PLAYING',
        };

        // Cache live state at edge for sub-20ms Google Home responses
        cachedTvStatus = { ...result };
        cachedTvStatusExpiry = Date.now() + 25000;

        if (includeRaw) {
          result.raw = data;
        }

        return result;
      } catch (err) {
        return { error: `Failed to query SmartThings status: ${err.message}` };
      }
    }

    // -------------------------------------------------------------------------
    // SmartThings Webhook SmartApp Lifecycle Handshake (CONFIRMATION & PING)
    // Automatically confirms registration in Developer Workspace
    // -------------------------------------------------------------------------
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/smartapp' || url.pathname === '/webhook' || url.pathname === '/smartthings/webhook')) {
      try {
        const body = await request.clone().json().catch(() => ({}));
        if (body.lifecycle) {
          // 1. CONFIRMATION Lifecycle: Must perform a GET to confirmationUrl
          if (body.lifecycle === 'CONFIRMATION') {
            const confirmationUrl = body.confirmationData?.confirmationUrl;
            if (confirmationUrl) {
              const confirmRes = await fetch(confirmationUrl);
              console.log('SmartApp confirmation status:', confirmRes.status);
            }
            return json({
              targetUrl: body.confirmationData?.targetUrl || url.href,
            });
          }

          // 2. PING Lifecycle: Return challenge
          if (body.lifecycle === 'PING') {
            return json({
              pingData: body.pingData || {},
            });
          }

          // 3. CONFIGURATION (INITIALIZE & PAGE phases for the mobile app)
          if (body.lifecycle === 'CONFIGURATION') {
            const phase = body.configurationData?.phase;

            // Phase 1: INITIALIZE
            if (phase === 'INITIALIZE') {
              return json({
                statusCode: 200,
                configurationData: {
                  initialize: {
                    name: 'TizenBridge',
                    description: 'Google Home Bridge for Samsung TV',
                    id: 'tizenbridge-app',
                    permissions: ['r:devices:*', 'w:devices:*', 'x:devices:*'],
                    firstPageId: 'mainPage',
                    disableCustomDisplayName: false,
                    disableRemoveApp: false,
                  },
                },
              });
            }

            // Phase 2: PAGE (Renders the TV selector page in the phone app)
            return json({
              statusCode: 200,
              configurationData: {
                page: {
                  pageId: 'mainPage',
                  name: 'Connect Samsung TV',
                  complete: true,
                  sections: [
                    {
                      name: 'Select your Samsung TV',
                      settings: [
                        {
                          id: 'selectedTv',
                          name: 'Samsung TV',
                          description: 'Select the TV you want Google Home to control',
                          type: 'DEVICE',
                          required: true,
                          multiple: false,
                          capabilities: ['switch'],
                          permissions: ['r', 'w', 'x'],
                        },
                      ],
                    },
                  ],
                },
              },
            });
          }

          // 4. INSTALL & UPDATE (Saves auth token and chosen device ID)
          if (body.lifecycle === 'INSTALL' || body.lifecycle === 'UPDATE') {
            const dataObj = body.installData || body.updateData || body.installedApp || {};
            const installedToken =
              dataObj.authToken ||
              body.installData?.authToken ||
              body.updateData?.authToken;
            const installedRefresh =
              dataObj.refreshToken ||
              body.installData?.refreshToken ||
              body.updateData?.refreshToken;
            const chosenDeviceId =
              dataObj.installedApp?.config?.selectedTv?.[0]?.deviceConfig?.deviceId ||
              body.installData?.installedApp?.config?.selectedTv?.[0]?.deviceConfig?.deviceId ||
              body.updateData?.installedApp?.config?.selectedTv?.[0]?.deviceConfig?.deviceId;

            if (installedToken) {
              cachedAccessToken = installedToken;
              cachedTokenExpiry = Date.now() + 86400 * 1000;
              console.log('Successfully captured SmartApp authToken:', installedToken);
            }
            if (chosenDeviceId) {
              cachedDeviceId = chosenDeviceId;
              console.log('Successfully captured Samsung TV device ID:', chosenDeviceId);
            }

            if (env.TIZEN_KV) {
              if (installedToken) {
                await env.TIZEN_KV.put('AUTH_TOKEN', installedToken);
                await env.TIZEN_KV.put('AUTH_TOKEN_EXPIRY', String(Date.now() + 86400 * 1000));
              }
              if (installedRefresh) await env.TIZEN_KV.put('REFRESH_TOKEN', installedRefresh);
              if (chosenDeviceId) await env.TIZEN_KV.put('DEVICE_ID', chosenDeviceId);
              await env.TIZEN_KV.delete('LAST_ERROR').catch(() => {});

              await env.TIZEN_KV.put('LAST_LIFECYCLE', JSON.stringify({
                timestamp: new Date().toISOString(),
                lifecycle: body.lifecycle,
                capturedDeviceId: chosenDeviceId || null,
                hasAuthToken: !!installedToken,
                hasRefreshToken: !!installedRefresh,
              }));
            }

            if (body.lifecycle === 'UPDATE') {
              return json({
                statusCode: 200,
                updateData: {},
              });
            }

            return json({
              statusCode: 200,
              installData: {},
            });
          }

          // 5. UNINSTALL
          if (body.lifecycle === 'UNINSTALL') {
            cachedAccessToken = null;
            cachedTokenExpiry = 0;
            if (env.TIZEN_KV) {
              await env.TIZEN_KV.delete('AUTH_TOKEN');
              await env.TIZEN_KV.delete('AUTH_TOKEN_EXPIRY');
              await env.TIZEN_KV.delete('REFRESH_TOKEN');
              await env.TIZEN_KV.delete('DEVICE_ID');
            }
            return json({ statusCode: 200, uninstallData: {} });
          }

          if (body.lifecycle === 'EVENT') {
            return json({ statusCode: 200, eventData: {} });
          }
        }
      } catch (err) {
        console.error('SmartApp lifecycle error:', err);
      }
    }

    // -------------------------------------------------------------------------
    // Route: On-Demand SmartThings Token Refresh Test (/oauth/refresh)
    // -------------------------------------------------------------------------
    if (url.pathname === '/oauth/refresh') {
      try {
        const newToken = await refreshSmartThingsToken();
        return json({
          success: true,
          message: 'SmartThings OAuth token refreshed and saved to KV successfully.',
          tokenPreview: `${newToken.substring(0, 10)}... (${newToken.length} chars)`,
          expiresAt: new Date(cachedTokenExpiry).toISOString(),
        });
      } catch (err) {
        return json({
          success: false,
          error: err.message,
          hint: 'If SmartThings rejected the refresh token as expired/invalid, open SmartThings app > Routines/Automations > TizenBridge and tap Save/Done to issue fresh tokens.',
        }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // Route: Diagnostics & KV Debug Inspector
    // -------------------------------------------------------------------------
    if (url.pathname === '/debug') {
      let kvStatus = {
        isKvBound: !!env.TIZEN_KV,
        storedAuthToken: 'None',
        storedTokenExpiry: 'Not tracked yet',
        storedRefreshToken: 'None',
        storedDeviceId: 'None',
        lastLifecycle: 'None recorded yet',
        lastTokenRefresh: 'None recorded yet',
        lastError: null,
        kvError: null,
      };

      if (env.TIZEN_KV) {
        try {
          const auth = await env.TIZEN_KV.get('AUTH_TOKEN');
          const authExp = await env.TIZEN_KV.get('AUTH_TOKEN_EXPIRY');
          const refresh = await env.TIZEN_KV.get('REFRESH_TOKEN');
          const devId = await env.TIZEN_KV.get('DEVICE_ID');
          const lastLife = await env.TIZEN_KV.get('LAST_LIFECYCLE');
          const lastRefresh = await env.TIZEN_KV.get('LAST_TOKEN_REFRESH');
          const lastErr = await env.TIZEN_KV.get('LAST_ERROR');

          if (auth) kvStatus.storedAuthToken = `${auth.substring(0, 10)}... (${auth.length} chars)`;
          if (authExp) {
            const expNum = parseInt(authExp, 10);
            kvStatus.storedTokenExpiry = `${new Date(expNum).toISOString()} (${Date.now() < expNum ? 'valid' : 'expired'})`;
          }
          if (refresh) kvStatus.storedRefreshToken = `${refresh.substring(0, 10)}... (${refresh.length} chars)`;
          if (devId) kvStatus.storedDeviceId = devId;
          if (lastLife) kvStatus.lastLifecycle = JSON.parse(lastLife);
          if (lastRefresh) kvStatus.lastTokenRefresh = JSON.parse(lastRefresh);
          if (lastErr) kvStatus.lastError = JSON.parse(lastErr);
        } catch (e) {
          kvStatus.kvError = e.message;
        }
      }

      return json({
        diagnosticTime: new Date().toISOString(),
        workerVersion: 'v2.8-auto-refresh-fix',
        isKvBound: !!env.TIZEN_KV,
        hasDirectPatToken: !!DIRECT_TOKEN,
        hasOAuthClientSecrets: !!(CLIENT_ID && CLIENT_SECRET),
        kvStorage: kvStatus,
        statusSummary: !env.TIZEN_KV
          ? 'Cloudflare KV is NOT bound. In Cloudflare Worker Settings > Bindings, add KV binding named TIZEN_KV and click Save and Deploy.'
          : (kvStatus.storedAuthToken === 'None'
            ? 'KV is bound! Now open SmartThings on your phone, open TizenBridge (under Routines/Automations), select your TV, and tap Save/Done.'
            : 'SmartThings credentials stored in KV. Visit /tv/status to verify live TV connection or /oauth/refresh to refresh tokens.'),
      });
    }

    // -------------------------------------------------------------------------
    // Route: Root / Health Check
    // -------------------------------------------------------------------------
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      const kvToken = env.TIZEN_KV ? await env.TIZEN_KV.get('AUTH_TOKEN') : null;
      const kvDeviceId = env.TIZEN_KV ? await env.TIZEN_KV.get('DEVICE_ID') : null;
      const hasAuth = !!(DIRECT_TOKEN || kvToken || (REFRESH_TOKEN && CLIENT_ID));

      const authType = DIRECT_TOKEN
        ? 'Personal Access Token'
        : (kvToken ? 'SmartApp Mobile Authorization (Permanent via KV)' : (REFRESH_TOKEN ? 'OAuth 2.0 Auto-Refresh' : 'Not Configured'));

      return json({
        service: 'SmartBridge Tizen',
        status: 'online',
        runtime: 'Cloudflare Workers (Edge Serverless)',
        workerUrl: baseUrl,
        cost: '100% Free (100k requests/day)',
        authStatus: {
          mode: authType,
          authenticated: hasAuth,
          hasDirectToken: !!DIRECT_TOKEN,
          hasKVBinding: !!env.TIZEN_KV,
          hasStoredKVToken: !!kvToken,
          hasOAuthSecrets: !!(CLIENT_ID && CLIENT_SECRET),
          hasRefreshToken: !!REFRESH_TOKEN,
        },
        configuredDevice: {
          id: ST_DEVICE_ID || kvDeviceId || cachedDeviceId || 'Not Set',
          name: TV_NAME,
        },
        endpoints: {
          googleSmartHome: `${baseUrl}/smarthome`,
          localHomeSdkScript: `${baseUrl}/local-home/app.js`,
          localHomeSetup: `${baseUrl}/local-devices`,
          voiceCommand: `${baseUrl}/voice-command`,
          listDevices: `${baseUrl}/devices`,
        },
      });
    }

    // -------------------------------------------------------------------------
    // Route: Google Local Home SDK Application (/local-home/app.js)
    // Runs locally inside Google Nest Hub & Phone for zero-latency local Wi-Fi control
    // -------------------------------------------------------------------------
    if (url.pathname === '/local-home/app.js' || url.pathname === '/local/app.js' || url.pathname === '/local-home/bundle.js') {
      return new Response(LOCAL_HOME_APP_SCRIPT, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // -------------------------------------------------------------------------
    // Route: Local Wi-Fi Diagnostic & Setup Helper (/local-devices or /local-config)
    // -------------------------------------------------------------------------
    if (url.pathname === '/local-devices' || url.pathname === '/local-config') {
      if (request.method === 'POST') {
        try {
          const body = await request.json().catch(() => ({}));
          if (env.TIZEN_KV) {
            if (body.localIp !== undefined) await env.TIZEN_KV.put('LOCAL_TV_IP', String(body.localIp).trim());
            if (body.localToken !== undefined) await env.TIZEN_KV.put('LOCAL_TV_TOKEN', String(body.localToken).trim());
          }
          return json({ success: true, saved: body });
        } catch (e) {
          return json({ success: false, error: e.message }, 500);
        }
      }

      const configuredLocalIp = env.LOCAL_TV_IP || (env.TIZEN_KV ? await env.TIZEN_KV.get('LOCAL_TV_IP') : '') || '';
      const configuredLocalToken = env.LOCAL_TV_TOKEN || (env.TIZEN_KV ? await env.TIZEN_KV.get('LOCAL_TV_TOKEN') : '') || '';

      return html(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Local Wi-Fi Control Setup</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem 1rem; max-width: 680px; margin: auto; }
              .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
              h1 { font-size: 1.5rem; margin-top: 0; color: #38bdf8; }
              h2 { font-size: 1.15rem; margin-top: 0; color: #f1f5f9; }
              code { background: #020617; padding: 0.2rem 0.4rem; border-radius: 4px; color: #38bdf8; font-family: monospace; word-break: break-all; }
              .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 12px; font-weight: 600; background: #064e3b; color: #34d399; margin-bottom: 1rem; }
              .info-box { background: #020617; border-left: 4px solid #38bdf8; padding: 0.75rem 1rem; border-radius: 4px; font-size: 13px; line-height: 1.6; margin: 1rem 0; }
              ol { line-height: 1.8; font-size: 14px; padding-left: 1.25rem; }
            </style>
          </head>
          <body>
            <div class="card">
              <span class="badge">⚡ Sub-5ms Local Wi-Fi Control</span>
              <h1>Google Local Home SDK Configuration</h1>
              <p style="color: #94a3b8; font-size: 14px; line-height: 1.6;">
                Google Nest Hub and your phone can send commands directly to your Samsung TV over your home Wi-Fi with virtually zero latency.
              </p>

              <div class="info-box">
                <strong>Local SDK Bundle URL:</strong><br>
                <code>${baseUrl}/local-home/app.js</code>
              </div>

              <h2>Step 1: Enable in Google Actions Console</h2>
              <ol>
                <li>Open the <a href="https://console.actions.google.com" target="_blank" style="color: #38bdf8;">Google Actions Console</a>.</li>
                <li>Go to <strong>Develop &gt; Actions &gt; Local Fulfillment</strong>.</li>
                <li>Toggle <strong>Enable local fulfillment</strong> to <strong>ON</strong>.</li>
                <li>Enter the Local SDK URL above: <code>${baseUrl}/local-home/app.js</code></li>
                <li>Under <strong>Device scan configuration</strong>, click <strong>New scan config</strong>:
                  <ul>
                    <li>Protocol: <strong>mDNS</strong> &rarr; Service type: <code>_samsungmsf._tcp.local</code></li>
                    <li>Protocol: <strong>UPnP</strong> &rarr; Device type: <code>urn:samsung.com:device:RemoteControlReceiver:1</code></li>
                  </ul>
                </li>
                <li>Click <strong>Save</strong>.</li>
              </ol>

              <h2>Step 2: How It Operates</h2>
              <ul style="line-height: 1.7; font-size: 14px; color: #cbd5e1;">
                <li><strong>Automatic Discovery:</strong> Your Nest Hub discovers the TV automatically via mDNS/UPnP without needing a static IP.</li>
                <li><strong>One-Time TV Approval:</strong> The very first time, your TV will ask <em>"Allow Google Nest to connect?"</em>. Press <strong>Allow</strong> on your TV remote. The TV remembers this forever.</li>
                <li><strong>Automatic Cloud Fallback:</strong> If you are away from home on 5G or if the TV is turned off, Google automatically falls back to your Cloudflare Worker.</li>
              </ul>
            </div>
          </body>
        </html>
      `);
    }

    // -------------------------------------------------------------------------
    // Route: List SmartThings Devices (Helps user find their TV Device ID)
    // -------------------------------------------------------------------------
    if (url.pathname === '/devices') {
      try {
        const token = await getActiveToken(false);
        let res = await fetch('https://api.smartthings.com/v1/devices', {
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (res.status === 401 && await canAutoRefresh()) {
          const freshToken = await getActiveToken(true);
          res = await fetch('https://api.smartthings.com/v1/devices', {
            headers: { 'Authorization': `Bearer ${freshToken}` },
          });
        }

        if (!res.ok) {
          const errText = await res.text();
          return json({ error: `SmartThings API error: ${errText}` }, res.status);
        }

        const data = await res.json();
        const devices = (data.items || []).map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          label: d.label || d.name,
          manufacturerName: d.manufacturerName,
        }));

        return json({
          success: true,
          count: devices.length,
          devices,
          instruction: 'Copy your TV deviceId and add it to Cloudflare Variables as SMARTTHINGS_DEVICE_ID',
        });
      } catch (err) {
        return json({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // Route: OAuth 2.0 Start (/oauth/login)
    // -------------------------------------------------------------------------
    if (url.pathname === '/oauth/login') {
      if (!CLIENT_ID) {
        return html(`
          <!DOCTYPE html>
          <html>
            <body style="font-family: system-ui; background: #0f172a; color: #f8fafc; padding: 2rem;">
              <h2>Missing SMARTTHINGS_CLIENT_ID</h2>
              <p>Add <code>SMARTTHINGS_CLIENT_ID</code> and <code>SMARTTHINGS_CLIENT_SECRET</code> to your Cloudflare Worker Settings &gt; Variables.</p>
            </body>
          </html>
        `, 400);
      }

      // Check if user clicked a specific redirect option
      const redirectType = url.searchParams.get('type');
      let targetRedirectUri = `${baseUrl}/`;

      if (redirectType === 'callback') {
        targetRedirectUri = `${baseUrl}/oauth/callback`;
      } else if (redirectType === 'noslash') {
        targetRedirectUri = baseUrl;
      } else if (redirectType === 'root') {
        targetRedirectUri = `${baseUrl}/`;
      }

      // If a specific type parameter is passed, redirect straight to SmartThings
      if (redirectType) {
        const authUrl = `https://api.smartthings.com/oauth/authorize?client_id=${encodeURIComponent(
          CLIENT_ID
        )}&response_type=code&redirect_uri=${encodeURIComponent(
          targetRedirectUri
        )}&scope=r:devices:*%20w:devices:*%20x:devices:*`;
        return Response.redirect(authUrl, 302);
      }

      // Otherwise show launch selector matching their registered SmartThings Target URL
      return html(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>SmartThings Authorizer</title>
            <style>
              body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 600px; margin: auto; }
              .card { background: #1e293b; padding: 1.5rem; border-radius: 0.75rem; border: 1px solid #334155; }
              .btn { display: block; text-align: center; background: #2563eb; color: white; padding: 0.75rem 1rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600; margin: 0.75rem 0; font-size: 14px; }
              .btn:hover { background: #1d4ed8; }
              .btn-sec { background: #334155; }
              .btn-sec:hover { background: #475569; }
              code { background: #020617; padding: 0.2rem 0.4rem; border-radius: 4px; color: #38bdf8; font-family: monospace; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2 style="margin-top: 0;">Connect Samsung Account</h2>
              <p style="color: #94a3b8; font-size: 13px;">
                SmartThings validates the <code>redirect_uri</code> against the Target URL you entered when creating your SmartApp in Developer Workspace. Click the button that matches:
              </p>
              
              <a href="/oauth/login?type=root" class="btn">
                1. Authorize with Target URL (Recommended)<br>
                <span style="font-size: 11px; font-weight: normal; opacity: 0.85;">${baseUrl}/</span>
              </a>

              <a href="/oauth/login?type=noslash" class="btn btn-sec">
                2. Authorize without Trailing Slash<br>
                <span style="font-size: 11px; font-weight: normal; opacity: 0.85;">${baseUrl}</span>
              </a>

              <a href="/oauth/login?type=callback" class="btn btn-sec">
                3. Authorize with /oauth/callback<br>
                <span style="font-size: 11px; font-weight: normal; opacity: 0.85;">${baseUrl}/oauth/callback</span>
              </a>
            </div>
          </body>
        </html>
      `);
    }

    // -------------------------------------------------------------------------
    // Route: OAuth 2.0 Callback (Catches authorization code on /oauth/callback OR /)
    // -------------------------------------------------------------------------
    const authCode = url.searchParams.get('code');
    if (authCode && (url.pathname === '/oauth/callback' || url.pathname === '/' || url.pathname === '')) {
      try {
        const tokenUrl = 'https://api.smartthings.com/oauth/token';
        const basicAuth = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

        // Try exchanging with the exact redirect_uri that was requested
        // Check potential redirect_uris
        const possibleUris = [
          url.origin + url.pathname,
          `${baseUrl}/`,
          baseUrl,
          `${baseUrl}/oauth/callback`,
        ];

        let tokenData = null;
        let lastError = null;

        for (const redUri of possibleUris) {
          const params = new URLSearchParams();
          params.append('grant_type', 'authorization_code');
          params.append('client_id', CLIENT_ID);
          params.append('code', authCode);
          params.append('redirect_uri', redUri);

          const tokenRes = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          });

          if (tokenRes.ok) {
            tokenData = await tokenRes.json();
            break;
          } else {
            lastError = await tokenRes.text();
          }
        }

        if (!tokenData) {
          throw new Error(`Token exchange error: ${lastError}`);
        }

        const refreshToken = tokenData.refresh_token;

        return html(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>SmartThings OAuth Success</title>
              <style>
                body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 680px; margin: auto; }
                .box { background: #1e293b; padding: 1.5rem; border-radius: 0.75rem; border: 1px solid #334155; }
                code { background: #020617; padding: 0.25rem 0.5rem; border-radius: 4px; color: #38bdf8; font-family: monospace; word-break: break-all; }
                .token-box { background: #020617; padding: 1rem; border-radius: 6px; font-family: monospace; color: #4ade80; word-break: break-all; margin: 1rem 0; border: 1px solid #1e293b; font-size: 13px; }
                h2 { color: #4ade80; margin-top: 0; }
              </style>
            </head>
            <body>
              <div class="box">
                <h2>OAuth Authorization Successful!</h2>
                <p>Your permanent <strong>Refresh Token</strong> has been generated! This allows your Cloudflare Worker to stay connected to your Samsung TV 24/7 forever without expiring.</p>
                
                <p><strong>Step 1: Copy this Refresh Token:</strong></p>
                <div class="token-box">${refreshToken}</div>

                <p><strong>Step 2: Add it to Cloudflare:</strong></p>
                <ol style="line-height: 1.8; font-size: 14px;">
                  <li>Open Cloudflare Dashboard (your <strong>tizen-bridge</strong> worker).</li>
                  <li>Go to <strong>Settings &gt; Variables and Secrets</strong>.</li>
                  <li>Add variable name: <code>SMARTTHINGS_REFRESH_TOKEN</code> and paste the token above.</li>
                  <li>Click <strong>Deploy</strong>.</li>
                </ol>
                <p>After saving, you can visit <a href="/devices" style="color: #38bdf8; font-weight: bold;">/devices</a> to view and pick your TV device ID!</p>
              </div>
            </body>
          </html>
        `);
      } catch (err) {
        return html(`<h3>Error exchanging OAuth code: ${err.message}</h3>`, 500);
      }
    }

    // -------------------------------------------------------------------------
    // Route: Google Assistant Routine / Webhook Voice Command
    // Usage:
    // - POST /voice-command {"key": "UP"}
    // - POST /voice-command {"app": "Netflix"}
    // - POST /voice-command {"input": "HDMI2"}
    // - POST /voice-command {"pictureMode": "FILMMAKER MODE"}
    // - GET  /voice-command?key=OK
    // -------------------------------------------------------------------------
    if (url.pathname === '/voice-command') {
      try {
        let body = {};
        if (request.method === 'POST') {
          body = await request.json().catch(() => ({}));
        } else {
          body = Object.fromEntries(url.searchParams.entries());
        }

        const { key, app, input, pictureMode, volume, power } = body;
        let commandPayload = [];

        if (power) {
          commandPayload.push({
            component: 'main',
            capability: 'switch',
            command: String(power).toLowerCase() === 'on' ? 'on' : 'off',
            arguments: [],
          });
        } else if (key) {
          // Send Tizen D-Pad / System Key
          commandPayload.push({
            component: 'main',
            capability: 'samsungvd.remoteControl',
            command: 'send',
            arguments: [String(key).toUpperCase()],
          });
        } else if (app) {
          // App name to Tizen App ID map
          const appMap = {
            'netflix': '3201907018807',
            'youtube': '111299001912',
            'prime video': '3201512006785',
            'amazon prime': '3201512006785',
            'disney+': '3201901017640',
            'disney': '3201901017640',
            'spotify': '3201606009684',
            'apple tv': '3201807016597',
            'browser': 'org.tizen.browser',
            'plex': '3201512006963',
          };
          const appId = appMap[String(app).toLowerCase()] || String(app);
          commandPayload.push({
            component: 'main',
            capability: 'custom.launchapp',
            command: 'launchApp',
            arguments: [appId],
          });
        } else if (input) {
          let cachedInputs = null;
          if (env.TIZEN_KV) {
            try {
              const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
              if (kvIn) cachedInputs = JSON.parse(kvIn);
            } catch (e) {}
          }
          const stInput = mapInputToSmartThings(String(input), cachedInputs);
          commandPayload.push({
            component: 'main',
            capability: 'mediaInputSource',
            command: 'setInputSource',
            arguments: [stInput],
          });
        } else if (pictureMode) {
          commandPayload.push({
            component: 'main',
            capability: 'custom.picturemode',
            command: 'setPictureMode',
            arguments: [String(pictureMode)],
          });
        } else if (volume !== undefined) {
          commandPayload.push({
            component: 'main',
            capability: 'audioVolume',
            command: 'setVolume',
            arguments: [parseInt(String(volume), 10)],
          });
        } else {
          return json({
            error: 'Missing command parameter. Provide key, app, input, pictureMode, volume, or power.',
          }, 400);
        }

        const stResult = await sendSmartThingsCommands(commandPayload);
        return json({
          success: true,
          action: body,
          smartThingsResult: stResult,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return json({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // Route: Google Actions Account Linking (/google/auth & /google/token)
    // -------------------------------------------------------------------------
    if (url.pathname === '/google/auth' || url.pathname === '/google/auth/') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') || '';

      if (url.searchParams.get('confirm') === 'true' && redirectUri) {
        const authCode = `auth-code-${Date.now()}`;
        const target = new URL(redirectUri);
        target.searchParams.set('code', authCode);
        target.searchParams.set('state', state);
        return Response.redirect(target.toString(), 302);
      }

      return html(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Link with Google Home</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
              .card { background: #1e293b; border: 1px solid #334155; border-radius: 1rem; max-width: 440px; width: 100%; padding: 2rem; text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
              .logo { width: 56px; height: 56px; background: #2563eb; border-radius: 1rem; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1.25rem; font-size: 28px; margin-left: auto; margin-right: auto; }
              h1 { font-size: 1.5rem; margin: 0 0 0.5rem; font-weight: 700; }
              p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; }
              .badge { display: inline-block; background: #064e3b; color: #34d399; font-size: 0.8rem; font-weight: 600; padding: 0.25rem 0.75rem; border-radius: 9999px; margin-bottom: 1.5rem; }
              .btn { display: block; width: 100%; background: #2563eb; color: white; padding: 0.875rem; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; text-decoration: none; border: none; cursor: pointer; transition: background 0.2s; box-sizing: border-box; }
              .btn:hover { background: #1d4ed8; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="logo">📺</div>
              <div class="badge">✓ Connected to ${TV_NAME}</div>
              <h1>Link with Google Home</h1>
              <p>Connect your Samsung Smart TV to Google Assistant and your Google Nest Hub for hands-free voice and screen control.</p>
              <a href="/google/auth?confirm=true&redirect_uri=${encodeURIComponent(redirectUri || '')}&state=${encodeURIComponent(state)}" class="btn">
                Authorize &amp; Link
              </a>
            </div>
          </body>
        </html>
      `);
    }

    if ((url.pathname === '/google/token' || url.pathname === '/google/token/') && (request.method === 'POST' || request.method === 'GET')) {
      return json({
        token_type: 'bearer',
        access_token: `google-bridge-token-${Date.now()}`,
        refresh_token: `google-bridge-refresh-${Date.now()}`,
        expires_in: 315360000,
      });
    }

    // -------------------------------------------------------------------------
    // Route: Google Smart Home Fulfillment (Cloud-to-Cloud)
    // Used by Google Nest Hub and Google Actions Console
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Route: Real-Time TV Status Inspector (/tv/status)
    // -------------------------------------------------------------------------
    if (url.pathname === '/tv/status' || url.pathname === '/status') {
      try {
        let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
        if (!effectiveDeviceId && env.TIZEN_KV) {
          effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
        }

        const live = await getSmartThingsDeviceStatus(true);
        const hasError = !live || !!live.error;

        let supportedInputsList = live?.supportedInputs || [];
        if (supportedInputsList.length === 0 && env.TIZEN_KV) {
          try {
            const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
            if (kvIn) supportedInputsList = JSON.parse(kvIn);
          } catch (e) {}
        }

        const googleInputs = formatInputSourcesForGoogle(supportedInputsList);
        const normalizedInput = normalizeInputForGoogle(live?.currentInput, googleInputs);

        return json({
          success: !hasError,
          deviceId: effectiveDeviceId || 'Unknown',
          liveState: hasError ? { error: live?.error || 'Could not query status from SmartThings API' } : {
            online: live.online,
            on: live.on,
            currentVolume: live.currentVolume,
            isMuted: live.isMuted,
            currentInput: normalizedInput,
            rawInputFromTv: live.currentInput,
            playbackState: live.playbackState,
          },
          inputs: {
            detectedFromTv: supportedInputsList,
            activeSourceRaw: live?.currentInput || 'Unknown',
            googleHomeActiveKey: normalizedInput,
            googleHomeAvailableInputs: googleInputs.map(i => ({
              key: i.key,
              displayName: i.names[0]?.name_synonym?.[0] || i.key,
              synonyms: i.names[0]?.name_synonym || [],
            })),
          },
          samsungvdMediaInputSource: live?.raw?.components?.main?.['samsungvd.mediaInputSource'] || null,
          rawMediaInputSource: live?.raw?.components?.main?.mediaInputSource || null,
          rawSmartThings: live?.raw || null,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return json({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // Route: Google Smart Home Fulfillment (Cloud-to-Cloud)
    // Used by Google Nest Hub and Google Actions Console
    // -------------------------------------------------------------------------
    const isSmarthomeRoute = [
      '/smarthome',
      '/smarthome/',
      '/api/smarthome',
      '/api/smarthome/',
      '/fulfillment',
      '/fulfillment/',
      '/api/fulfillment',
      '/api/fulfillment/',
    ].includes(url.pathname);

    // Browser diagnostic GET for developer testing
    if (isSmarthomeRoute && request.method === 'GET') {
      return json({
        status: 'online',
        service: 'Google Smart Home Fulfillment Endpoint',
        acceptedMethod: 'POST',
        supportedIntents: ['action.devices.SYNC', 'action.devices.QUERY', 'action.devices.EXECUTE'],
        configuredDeviceId: ST_DEVICE_ID || (env.TIZEN_KV ? await env.TIZEN_KV.get('DEVICE_ID') : cachedDeviceId) || 'samsung-tizen-tv-01',
        timestamp: new Date().toISOString(),
      });
    }

    // Intercept smarthome POST or any POST containing Google Home intent inputs
    let isGoogleIntent = isSmarthomeRoute && request.method === 'POST';
    let googleBody = null;
    if (request.method === 'POST') {
      try {
        const clone = await request.clone().json().catch(() => null);
        if (clone && Array.isArray(clone.inputs) && clone.inputs.length > 0 && String(clone.inputs[0]?.intent || '').startsWith('action.devices.')) {
          isGoogleIntent = true;
          googleBody = clone;
        }
      } catch (e) {}
    }

    if (isGoogleIntent) {
      try {
        const body = googleBody || (await request.json());
        const requestId = body.requestId || `req-${Date.now()}`;
        const inputs = body.inputs || [];

        if (inputs.length === 0) {
          return json({ requestId, payload: { errorCode: 'protocolError' } }, 400);
        }

        const intent = inputs[0].intent;
        let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
        if (!effectiveDeviceId && env.TIZEN_KV) {
          effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
        }
        const targetDeviceId = effectiveDeviceId || 'samsung-tizen-tv-01';

        // 1. SYNC Intent -> Returns Device Traits to Google
        // Guaranteed fast sub-second response so Google Cloud / Nest Hub never times out
        if (intent === 'action.devices.SYNC') {
          let liveStatus = null;
          if (cachedTvStatus && cachedTvStatus.supportedInputs) {
            liveStatus = cachedTvStatus;
          } else if (env.TIZEN_KV) {
            try {
              const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
              if (kvIn) liveStatus = { supportedInputs: JSON.parse(kvIn) };
            } catch (e) {}
          }

          if (!liveStatus) {
            try {
              const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500));
              liveStatus = await Promise.race([getSmartThingsDeviceStatus(), timeoutPromise]);
            } catch (e) {}
          }

          let supportedInputsList = (liveStatus && Array.isArray(liveStatus.supportedInputs) && liveStatus.supportedInputs.length > 0)
            ? liveStatus.supportedInputs
            : null;

          if (!supportedInputsList && env.TIZEN_KV) {
            try {
              const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
              if (kvIn) supportedInputsList = JSON.parse(kvIn);
            } catch (e) {}
          }

          const dynamicAvailableInputs = formatInputSourcesForGoogle(supportedInputsList);

          return json({
            requestId,
            payload: {
              agentUserId: 'cloudflare-tizen-user',
              devices: [
                {
                  id: targetDeviceId,
                  type: 'action.devices.types.TV',
                  traits: [
                    'action.devices.traits.OnOff',
                    'action.devices.traits.Volume',
                    'action.devices.traits.InputSelector',
                    'action.devices.traits.AppSelector',
                    'action.devices.traits.TransportControl',
                    'action.devices.traits.MediaState',
                  ],
                  name: {
                    defaultNames: ['Samsung Smart TV', 'Tizen TV', 'TV'],
                    name: 'TV',
                    nicknames: ['TV', 'The TV', 'Television', 'Samsung TV', 'Living Room TV', TV_NAME],
                  },
                  willReportState: false,
                  otherDeviceIds: [
                    { deviceId: targetDeviceId },
                    { deviceId: 'samsung-tizen-tv-local' },
                    { deviceId: 'samsung-tv-local' },
                  ],
                  customData: {
                    deviceId: targetDeviceId,
                    localIp: (env.LOCAL_TV_IP || (env.TIZEN_KV ? await env.TIZEN_KV.get('LOCAL_TV_IP') : '')) || '',
                    localToken: (env.LOCAL_TV_TOKEN || (env.TIZEN_KV ? await env.TIZEN_KV.get('LOCAL_TV_TOKEN') : '')) || '',
                  },
                  deviceInfo: {
                    manufacturer: 'Samsung Electronics',
                    model: 'TizenOS Smart TV',
                    hwVersion: '2024.1',
                    swVersion: 'SmartBridge-v1.0',
                  },
                  attributes: {
                    volumeMaxLevel: 100,
                    volumeCanMuteAndUnmute: true,
                    levelStepSize: 1,
                    commandOnlyVolume: true,
                    supportActivityState: true,
                    supportPlaybackState: true,
                    availableInputs: dynamicAvailableInputs,
                    availableApplications: [
                      { key: '3201907018807', names: [{ lang: 'en', name_synonym: ['Netflix'] }] },
                      { key: '111299001912', names: [{ lang: 'en', name_synonym: ['YouTube'] }] },
                      { key: '3201512006785', names: [{ lang: 'en', name_synonym: ['Prime Video', 'Amazon Prime'] }] },
                      { key: '3201901017640', names: [{ lang: 'en', name_synonym: ['Disney Plus', 'Disney+'] }] },
                      { key: '3201606009684', names: [{ lang: 'en', name_synonym: ['Spotify'] }] },
                      { key: '3201807016597', names: [{ lang: 'en', name_synonym: ['Apple TV'] }] },
                    ],
                    transportControlSupportedCommands: ['PAUSE', 'RESUME', 'STOP', 'NEXT', 'PREVIOUS'],
                  },
                },
              ],
            },
          });
        }

        // 2. QUERY Intent -> Returns LIVE TV state from SmartThings to Google Home
        // Fast edge-cached response (<20ms) so Google Nest Hub never hits its 3-second timeout
        if (intent === 'action.devices.QUERY') {
          const reqDevices = inputs[0]?.payload?.devices || [{ id: targetDeviceId }];
          
          let liveStatus = null;
          // If we have cached status, use it and trigger background refresh if older than 10s
          if (cachedTvStatus) {
            liveStatus = cachedTvStatus;
            if (Date.now() > cachedTvStatusExpiry && ctx && typeof ctx.waitUntil === 'function') {
              ctx.waitUntil(getSmartThingsDeviceStatus(false, true).catch(() => {}));
            }
          } else {
            liveStatus = await getSmartThingsDeviceStatus();
          }

          const isLiveSuccess = liveStatus && !liveStatus.error;

          let supportedInputsList = liveStatus?.supportedInputs || null;
          if ((!supportedInputsList || supportedInputsList.length === 0) && env.TIZEN_KV) {
            try {
              const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
              if (kvIn) supportedInputsList = JSON.parse(kvIn);
            } catch (e) {}
          }
          const dynamicInputs = formatInputSourcesForGoogle(supportedInputsList);
          const normalizedInput = normalizeInputForGoogle(liveStatus?.currentInput, dynamicInputs);

          const deviceStates = {};
          const isOn = isLiveSuccess ? liveStatus.on : true;
          const liveStatePayload = {
            status: 'SUCCESS',
            online: true,
            on: isOn,
            isMuted: isLiveSuccess ? liveStatus.isMuted : false,
            currentInput: normalizedInput,
            currentApplication: '111299001912',
            activityState: isOn ? 'ACTIVE' : 'STANDBY',
            playbackState: isOn ? (isLiveSuccess && liveStatus.playbackState ? liveStatus.playbackState : 'PLAYING') : 'STOPPED',
          };

          for (const dev of reqDevices) {
            deviceStates[dev.id] = liveStatePayload;
          }
          if (targetDeviceId) {
            deviceStates[targetDeviceId] = liveStatePayload;
          }

          return json({
            requestId,
            payload: {
              devices: deviceStates,
            },
          });
        }

        // 3. EXECUTE Intent -> Executes trait command on Samsung TV
        if (intent === 'action.devices.EXECUTE') {
          const commands = inputs[0].payload.commands || [];
          const commandResponses = [];

          for (const cmdGroup of commands) {
            const groupDeviceIds = (cmdGroup.devices || []).map(d => d.id);
            const updatedStates = { online: true };
            let stPayload = [];

            for (const execution of cmdGroup.execution) {
              const commandName = execution.command;
              const params = execution.params || {};

              switch (commandName) {
                case 'action.devices.commands.OnOff':
                  updatedStates.on = params.on;
                  updatedStates.activityState = params.on ? 'ACTIVE' : 'STANDBY';
                  if (cachedTvStatus) {
                    cachedTvStatus.on = params.on;
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  stPayload.push({
                    component: 'main',
                    capability: 'switch',
                    command: params.on ? 'on' : 'off',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.setVolume': {
                  const targetVol = Math.max(0, Math.min(100, params.volumeLevel));

                  if (cachedTvStatus) {
                    cachedTvStatus.currentVolume = targetVol;
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  updatedStates.currentVolume = targetVol;

                  stPayload.push({
                    component: 'main',
                    capability: 'audioVolume',
                    command: 'setVolume',
                    arguments: [targetVol],
                  });
                  break;
                }

                case 'action.devices.commands.volumeRelative': {
                  const isUp = params.volumeRelativeLevel > 0;
                  const stepCount = Math.min(Math.max(1, Math.abs(params.volumeRelativeLevel !== undefined ? params.volumeRelativeLevel : 1)), 6);
                  const pulseKey = isUp ? 'VOLUP' : 'VOLDOWN';

                  if (cachedTvStatus) {
                    const cur = typeof cachedTvStatus.currentVolume === 'number' ? cachedTvStatus.currentVolume : 20;
                    cachedTvStatus.currentVolume = Math.max(0, Math.min(100, cur + (isUp ? stepCount : -stepCount)));
                    cachedTvStatus.isMuted = false;
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  updatedStates.isMuted = false;

                  // Use remoteControl VOLUP/VOLDOWN (works on both TV speakers and Bluetooth headphones without double-stepping)
                  for (let p = 0; p < stepCount; p++) {
                    stPayload.push({
                      component: 'main',
                      capability: 'samsungvd.remoteControl',
                      command: 'send',
                      arguments: [pulseKey],
                    });
                  }
                  break;
                }

                case 'action.devices.commands.mute': {
                  updatedStates.isMuted = params.mute;
                  if (cachedTvStatus) {
                    cachedTvStatus.isMuted = params.mute;
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  // Use idempotent audioMute only (avoid sending toggle key MUTE which cancels out or accidentally mutes)
                  stPayload.push({
                    component: 'main',
                    capability: 'audioMute',
                    command: params.mute ? 'mute' : 'unmute',
                    arguments: [],
                  });
                  break;
                }

                case 'action.devices.commands.SetInput': {
                  let supportedInputsForExec = null;
                  if (env.TIZEN_KV) {
                    try {
                      const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
                      if (kvIn) supportedInputsForExec = JSON.parse(kvIn);
                    } catch (e) {}
                  }
                  const stInput = mapInputToSmartThings(params.newInput, supportedInputsForExec);
                  updatedStates.currentInput = params.newInput;
                  if (cachedTvStatus) {
                    cachedTvStatus.currentInput = params.newInput;
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaInputSource',
                    command: 'setInputSource',
                    arguments: [stInput],
                  });
                  break;
                }

                case 'action.devices.commands.appSelect':
                  updatedStates.currentApplication = params.newApplication;
                  updatedStates.activityState = 'ACTIVE';
                  stPayload.push({
                    component: 'main',
                    capability: 'custom.launchapp',
                    command: 'launchApp',
                    arguments: [params.newApplication],
                  });
                  break;

                case 'action.devices.commands.mediaPause':
                  updatedStates.activityState = 'ACTIVE';
                  updatedStates.playbackState = 'PAUSED';
                  if (cachedTvStatus) {
                    cachedTvStatus.playbackState = 'PAUSED';
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'pause',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaResume':
                  updatedStates.activityState = 'ACTIVE';
                  updatedStates.playbackState = 'PLAYING';
                  if (cachedTvStatus) {
                    cachedTvStatus.playbackState = 'PLAYING';
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'play',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaStop':
                  updatedStates.activityState = 'ACTIVE';
                  updatedStates.playbackState = 'STOPPED';
                  if (cachedTvStatus) {
                    cachedTvStatus.playbackState = 'STOPPED';
                    cachedTvStatusExpiry = Date.now() + 30000;
                  }
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'stop',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaNext':
                  updatedStates.activityState = 'ACTIVE';
                  updatedStates.playbackState = 'PLAYING';
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'fastForward',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaPrevious':
                  updatedStates.activityState = 'ACTIVE';
                  updatedStates.playbackState = 'PLAYING';
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'rewind',
                    arguments: [],
                  });
                  break;
              }
            }

            if (stPayload.length > 0) {
              try {
                await sendSmartThingsCommands(stPayload);
                commandResponses.push({
                  ids: groupDeviceIds,
                  status: 'SUCCESS',
                  states: updatedStates,
                });
              } catch (execErr) {
                console.error('SmartThings EXECUTE error:', execErr);
                const msg = String(execErr?.message || '');
                const isAuthErr = msg.includes('401') || msg.toLowerCase().includes('oauth') || msg.toLowerCase().includes('token') || msg.toLowerCase().includes('authentication');
                commandResponses.push({
                  ids: groupDeviceIds,
                  status: 'ERROR',
                  errorCode: isAuthErr ? 'authFailure' : 'deviceOffline',
                  debugString: msg,
                });
              }
            } else {
              commandResponses.push({
                ids: groupDeviceIds,
                status: 'SUCCESS',
                states: updatedStates,
              });
            }
          }

          return json({
            requestId,
            payload: {
              commands: commandResponses,
            },
          });
        }

        return json({ requestId, payload: { errorCode: 'notSupported' } }, 400);
      } catch (err) {
        return json({
          requestId: `err-${Date.now()}`,
          payload: {
            errorCode: 'hardError',
            debugString: err.message,
          },
        }, 500);
      }
    }

    return json({ error: 'Endpoint Not Found' }, 404);
  },

  // Optional Cloudflare Cron Trigger handler (e.g. "0 0 */7 * *")
  // Keeps SmartThings 30-day refresh token alive indefinitely even when TV is unused
  async scheduled(event, env, ctx) {
    const CLIENT_ID = env.SMARTTHINGS_CLIENT_ID || '';
    const CLIENT_SECRET = env.SMARTTHINGS_CLIENT_SECRET || '';
    const kvRefresh = env.TIZEN_KV ? await env.TIZEN_KV.get('REFRESH_TOKEN') : '';
    const effectiveRefreshToken = kvRefresh || env.SMARTTHINGS_REFRESH_TOKEN || '';

    if (!effectiveRefreshToken || !CLIENT_ID || !CLIENT_SECRET) {
      return;
    }

    try {
      const basicAuth = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', CLIENT_ID);
      params.append('refresh_token', effectiveRefreshToken);

      const res = await fetch('https://api.smartthings.com/oauth/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (env.TIZEN_KV) {
          await env.TIZEN_KV.put('LAST_ERROR', JSON.stringify({
            timestamp: new Date().toISOString(),
            source: 'scheduledRefresh',
            status: res.status,
            error: errText,
          }));
        }
        return;
      }

      const data = await res.json();
      const expiryMs = Date.now() + (Number(data.expires_in) || 86400) * 1000;
      cachedAccessToken = data.access_token;
      cachedTokenExpiry = expiryMs;

      if (env.TIZEN_KV) {
        await env.TIZEN_KV.put('AUTH_TOKEN', data.access_token);
        await env.TIZEN_KV.put('AUTH_TOKEN_EXPIRY', String(expiryMs));
        if (data.refresh_token) {
          await env.TIZEN_KV.put('REFRESH_TOKEN', data.refresh_token);
        }
        await env.TIZEN_KV.put('LAST_TOKEN_REFRESH', JSON.stringify({
          timestamp: new Date().toISOString(),
          source: 'scheduled',
          expiresAt: new Date(expiryMs).toISOString(),
          rotatedRefreshToken: !!data.refresh_token,
        }));
        await env.TIZEN_KV.delete('LAST_ERROR').catch(() => {});
      }
    } catch (err) {
      if (env.TIZEN_KV) {
        await env.TIZEN_KV.put('LAST_ERROR', JSON.stringify({
          timestamp: new Date().toISOString(),
          source: 'scheduledRefresh',
          error: err.message,
        })).catch(() => {});
      }
    }
  },
};
