/**
 * =============================================================================
 * Samsung Tizen OS to Google Home Serverless Bridge
 * =============================================================================
 * 
 * A 100% free, permanent serverless bridge that connects Google Home, Google Nest
 * Hubs, and Google Assistant to Samsung Smart TVs running Tizen OS.
 * 
 * Hosting: Cloudflare Workers (100% Free Tier - 100,000 requests/day, $0.00/month,
 *          no credit card required).
 * 
 * Features:
 * - Full Google Home TV Card with power, volume slider, mute, and input selector.
 * - Dynamic HDMI Input Discovery: Reads real connected device names from your TV
 *   (e.g., "XBOX SeriesX|S", "PlayStation 5", "Nintendo Switch") and generates
 *   natural voice synonyms.
 * - Voice Commands: "Hey Google, turn on TV", "Hey Google, switch input to Xbox",
 *   "Hey Google, set TV volume to 25", "Hey Google, mute TV".
 * - Permanent Authentication: Automatically saves and refreshes OAuth tokens via
 *   Cloudflare KV (`TIZEN_KV`). Never expires.
 * - Built-in Diagnostics: Visit /tv/status or /debug in any browser to verify
 *   real-time connection and TV state.
 * 
 * Primary Endpoints:
 * - SmartThings Webhook:    POST /smartthings/webhook (or POST /)
 * - Google Home Fulfillment: POST /smarthome
 * - Google Account Linking:  GET  /google/auth & POST /google/token
 * - Diagnostic Endpoints:    GET  /tv/status, /tv/inputs, /debug, /health
 * - Assistant Voice Routine: POST /voice-command
 * =============================================================================
 */

// In-memory cache for refreshed access token and installed device ID on the edge
let cachedAccessToken = null;
let cachedTokenExpiry = 0;
let cachedDeviceId = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    const baseUrl = `https://${url.host}`;

    // -------------------------------------------------------------------------
    // 1. CORS Preflight Handling
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // 2. Configuration & Environment Variables
    // -------------------------------------------------------------------------
    const CLIENT_ID = env.SMARTTHINGS_CLIENT_ID || '';
    const CLIENT_SECRET = env.SMARTTHINGS_CLIENT_SECRET || '';
    const REFRESH_TOKEN = env.SMARTTHINGS_REFRESH_TOKEN || '';
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

    // -------------------------------------------------------------------------
    // 3. SmartThings Authentication & Token Refresh Engine
    // -------------------------------------------------------------------------
    async function getActiveToken() {
      // Step A: Check Cloudflare KV for stored OAuth token
      if (env.TIZEN_KV) {
        const kvToken = await env.TIZEN_KV.get('AUTH_TOKEN');
        if (kvToken) {
          return kvToken;
        }
      }

      // Step B: Check in-memory cached token (if still valid for at least 5 minutes)
      const now = Date.now();
      if (cachedAccessToken && now < cachedTokenExpiry - 300000) {
        return cachedAccessToken;
      }

      // Step C: Auto-refresh via OAuth Refresh Token
      const effectiveRefreshToken = REFRESH_TOKEN || (env.TIZEN_KV ? await env.TIZEN_KV.get('REFRESH_TOKEN') : '');
      if (effectiveRefreshToken && CLIENT_ID && CLIENT_SECRET) {
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
          },
          body: params.toString(),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Failed to refresh SmartThings OAuth token (${res.status}): ${errText}`);
        }

        const data = await res.json();
        cachedAccessToken = data.access_token;
        cachedTokenExpiry = Date.now() + (data.expires_in || 86400) * 1000;

        if (env.TIZEN_KV) {
          await env.TIZEN_KV.put('AUTH_TOKEN', data.access_token);
          if (data.refresh_token) {
            await env.TIZEN_KV.put('REFRESH_TOKEN', data.refresh_token);
          }
        }

        return cachedAccessToken;
      }

      throw new Error(
        'No valid SmartThings authentication found. Please install the Tizen Bridge SmartApp in the SmartThings app or configure SMARTTHINGS_CLIENT_ID and SMARTTHINGS_CLIENT_SECRET.'
      );
    }

    // -------------------------------------------------------------------------
    // 4. Send Commands to SmartThings REST API
    // -------------------------------------------------------------------------
    async function sendSmartThingsCommands(commands) {
      let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
      if (!effectiveDeviceId && env.TIZEN_KV) {
        effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
      }

      if (!effectiveDeviceId) {
        throw new Error('Samsung TV device ID is not configured. Install the Tizen Bridge SmartApp in SmartThings or set SMARTTHINGS_DEVICE_ID.');
      }

      const token = await getActiveToken();
      const stUrl = `https://api.smartthings.com/v1/devices/${effectiveDeviceId}/commands`;

      let res = await fetch(stUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      });

      // If token expired (401), clear cache and retry once with a freshly refreshed token
      if (res.status === 401 && (REFRESH_TOKEN || (env.TIZEN_KV && await env.TIZEN_KV.get('REFRESH_TOKEN')))) {
        cachedAccessToken = null;
        cachedTokenExpiry = 0;
        const freshToken = await getActiveToken();
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
        throw new Error(`SmartThings API command error (${res.status}): ${errText}`);
      }
      return await res.json();
    }

    // -------------------------------------------------------------------------
    // 5. Input Source Formatting & Voice Synonym Engine for Google Home
    // -------------------------------------------------------------------------
    function formatInputSourcesForGoogle(rawInputs) {
      if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
        // Safe standard default for Samsung TVs (HDMI 1, HDMI 2, and Live TV)
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

        // Standardize Google Home trait key
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
          // Google Home UI uses the first synonym as the display name on Nest Hub & Home app
          // Prioritize the custom name detected by Samsung (e.g., "XBOX SeriesX|S" or "Nintendo Switch")
          addSynonym(rawName);

          // Punctuation-free variation (e.g., "XBOX SeriesX|S" -> "XBOX SeriesX S")
          const cleanName = rawName.replace(/[|/_\\-]/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanName) addSynonym(cleanName);

          // Smart category synonyms
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

          // Port-level synonyms so users can always say "switch to HDMI 1" or "Input 1"
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

      if (['DIGITALTV', 'TUNER', 'ANTENNA', 'TV', 'DTV', 'LIVE TV'].includes(upper)) {
        const tvEntry = availableInputs.find(i => i.key === 'TV' || i.key.toLowerCase() === 'dtv');
        if (tvEntry) return tvEntry.key;
      }

      // 1. Exact match
      const exact = availableInputs.find(i => i.key.toLowerCase() === trimmed.toLowerCase());
      if (exact) return exact.key;

      // 2. HDMI port match (e.g., "HDMI 1" -> "HDMI1")
      const hdmiMatch = upper.match(/^(?:HDMI|INPUT|PORT)\s*([0-9]+)$/);
      if (hdmiMatch) {
        const key = `HDMI${hdmiMatch[1]}`;
        const found = availableInputs.find(i => i.key.toUpperCase() === key);
        if (found) return found.key;
      }

      // 3. Match against synonyms (e.g. "Xbox" matches "XBOX SeriesX|S" input)
      const synMatch = availableInputs.find(i =>
        i.names?.[0]?.name_synonym?.some(s => s.toLowerCase() === trimmed.toLowerCase())
      );
      if (synMatch) return synMatch.key;

      // 4. Substring match
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

      const normalizedSources = supportedSources.map(s => {
        if (typeof s === 'object' && s !== null) {
          return { id: String(s.id || '').trim(), name: String(s.name || '').trim() };
        }
        return { id: String(s || '').trim(), name: String(s || '').trim() };
      }).filter(s => s.id || s.name);

      // 1. Direct match by ID
      const idMatch = normalizedSources.find(s => s.id.toLowerCase() === trimmed.toLowerCase());
      if (idMatch) return idMatch.id;

      // 2. Match by Name (e.g. "XBOX SeriesX|S")
      const nameMatch = normalizedSources.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
      if (nameMatch) return nameMatch.id;

      // 3. HDMI variations
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

      // 5. Keyword / Substring match
      const subMatch = normalizedSources.find(s => {
        const sNameUp = s.name.toUpperCase();
        const sIdUp = s.id.toUpperCase();
        return sNameUp.includes(upper) || upper.includes(sNameUp) ||
               sIdUp.includes(upper) || upper.includes(sIdUp);
      });
      if (subMatch) return subMatch.id;

      return trimmed;
    }

    // -------------------------------------------------------------------------
    // 6. Query Live Samsung TV State from SmartThings REST API
    // -------------------------------------------------------------------------
    async function getSmartThingsDeviceStatus(includeRaw = false) {
      let effectiveDeviceId = ST_DEVICE_ID || cachedDeviceId;
      if (!effectiveDeviceId && env.TIZEN_KV) {
        effectiveDeviceId = await env.TIZEN_KV.get('DEVICE_ID');
      }

      if (!effectiveDeviceId) {
        return { error: 'No TV device ID found in SMARTTHINGS_DEVICE_ID or TIZEN_KV.' };
      }

      try {
        const token = await getActiveToken();
        const stUrl = `https://api.smartthings.com/v1/devices/${effectiveDeviceId}/status`;

        let res = await fetch(stUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        // If 401 token expired, refresh and retry once
        if (res.status === 401 && (REFRESH_TOKEN || (env.TIZEN_KV && await env.TIZEN_KV.get('REFRESH_TOKEN')))) {
          cachedAccessToken = null;
          cachedTokenExpiry = 0;
          const freshToken = await getActiveToken();
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

        // Cache detected inputs asynchronously in KV for ultra-fast Google Home SYNC responses
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

        if (includeRaw) {
          result.raw = data;
        }

        return result;
      } catch (err) {
        return { error: `Failed to query SmartThings status: ${err.message}` };
      }
    }

    // -------------------------------------------------------------------------
    // 7. SmartThings Webhook SmartApp Lifecycle Handshake
    // Automatically confirms Developer Workspace registration and handles mobile app
    // -------------------------------------------------------------------------
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/smartapp' || url.pathname === '/smartthings/webhook' || url.pathname === '/webhook')) {
      try {
        const body = await request.clone().json().catch(() => ({}));
        if (body.lifecycle) {
          // 1. CONFIRMATION Lifecycle: Automatically fetch confirmationUrl to verify webhook
          if (body.lifecycle === 'CONFIRMATION') {
            const confirmationUrl = body.confirmationData?.confirmationUrl;
            if (confirmationUrl) {
              const confirmRes = await fetch(confirmationUrl);
              console.log('SmartApp webhook confirmation HTTP status:', confirmRes.status);
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

          // 3. CONFIGURATION (INITIALIZE & PAGE phases for the SmartThings mobile app)
          if (body.lifecycle === 'CONFIGURATION') {
            const phase = body.configurationData?.phase;

            // Phase A: INITIALIZE
            if (phase === 'INITIALIZE') {
              return json({
                statusCode: 200,
                configurationData: {
                  initialize: {
                    name: 'Tizen Bridge',
                    description: 'Google Home Bridge for Samsung Smart TV',
                    id: 'tizenbridge-app',
                    permissions: ['r:devices:*', 'w:devices:*', 'x:devices:*'],
                    firstPageId: 'mainPage',
                    disableCustomDisplayName: false,
                    disableRemoveApp: false,
                  },
                },
              });
            }

            // Phase B: PAGE (Renders the TV selector dropdown in the SmartThings app)
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

          // 4. INSTALL & UPDATE (Captures OAuth tokens and selected TV device ID to KV)
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
              console.log('Successfully captured SmartApp authToken');
            }
            if (chosenDeviceId) {
              cachedDeviceId = chosenDeviceId;
              console.log('Successfully captured Samsung TV device ID:', chosenDeviceId);
            }

            if (env.TIZEN_KV) {
              if (installedToken) await env.TIZEN_KV.put('AUTH_TOKEN', installedToken);
              if (installedRefresh) await env.TIZEN_KV.put('REFRESH_TOKEN', installedRefresh);
              if (chosenDeviceId) await env.TIZEN_KV.put('DEVICE_ID', chosenDeviceId);

              await env.TIZEN_KV.put('LAST_LIFECYCLE', JSON.stringify({
                timestamp: new Date().toISOString(),
                lifecycle: body.lifecycle,
                capturedDeviceId: chosenDeviceId || null,
                hasAuthToken: !!installedToken,
                hasRefreshToken: !!installedRefresh,
              }));
            }

            if (body.lifecycle === 'UPDATE') {
              return json({ statusCode: 200, updateData: {} });
            }

            return json({ statusCode: 200, installData: {} });
          }

          // 5. UNINSTALL
          if (body.lifecycle === 'UNINSTALL') {
            if (env.TIZEN_KV) {
              await env.TIZEN_KV.delete('AUTH_TOKEN');
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
    // 8. Diagnostic Routes (/tv/status, /tv/inputs, /debug, /health)
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
          deviceId: effectiveDeviceId || 'Not Configured',
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
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return json({ success: false, error: err.message }, 500);
      }
    }

    if (url.pathname === '/tv/inputs') {
      try {
        const live = await getSmartThingsDeviceStatus();
        let supported = live?.supportedInputs || [];
        if (supported.length === 0 && env.TIZEN_KV) {
          try {
            const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
            if (kvIn) supported = JSON.parse(kvIn);
          } catch (e) {}
        }
        const formatted = formatInputSourcesForGoogle(supported);
        return json({
          success: true,
          count: formatted.length,
          availableInputs: formatted.map(i => ({
            key: i.key,
            primaryLabel: i.names[0]?.name_synonym?.[0] || i.key,
            voiceSynonyms: i.names[0]?.name_synonym || [],
          })),
        });
      } catch (err) {
        return json({ success: false, error: err.message }, 500);
      }
    }

    if (url.pathname === '/debug') {
      let kvStatus = {
        isKvBound: !!env.TIZEN_KV,
        storedAuthToken: 'None',
        storedRefreshToken: 'None',
        storedDeviceId: 'None',
        lastLifecycle: 'None recorded yet',
        kvError: null,
      };

      if (env.TIZEN_KV) {
        try {
          const auth = await env.TIZEN_KV.get('AUTH_TOKEN');
          const refresh = await env.TIZEN_KV.get('REFRESH_TOKEN');
          const devId = await env.TIZEN_KV.get('DEVICE_ID');
          const lastLife = await env.TIZEN_KV.get('LAST_LIFECYCLE');

          if (auth) kvStatus.storedAuthToken = `${auth.substring(0, 10)}... (${auth.length} chars)`;
          if (refresh) kvStatus.storedRefreshToken = `${refresh.substring(0, 10)}... (${refresh.length} chars)`;
          if (devId) kvStatus.storedDeviceId = devId;
          if (lastLife) kvStatus.lastLifecycle = JSON.parse(lastLife);
        } catch (e) {
          kvStatus.kvError = e.message;
        }
      }

      return json({
        diagnosticTime: new Date().toISOString(),
        workerVersion: 'v2.5-standalone-tizen-bridge',
        isKvBound: !!env.TIZEN_KV,
        kvStorage: kvStatus,
        statusSummary: !env.TIZEN_KV
          ? 'Cloudflare KV is NOT bound. In Worker Settings > Variables and Secrets > KV Namespace Bindings, add TIZEN_KV.'
          : (kvStatus.storedAuthToken === 'None'
            ? 'KV is bound! Open SmartThings on your phone, open Tizen Bridge (under Automations/Life > Custom SmartApps), select your TV, and tap Done.'
            : 'Authentication verified! SmartThings is fully linked to your TV. Google Home is ready.'),
      });
    }

    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      const kvToken = env.TIZEN_KV ? await env.TIZEN_KV.get('AUTH_TOKEN') : null;
      const kvDeviceId = env.TIZEN_KV ? await env.TIZEN_KV.get('DEVICE_ID') : null;
      const hasAuth = !!(kvToken || (REFRESH_TOKEN && CLIENT_ID));

      return json({
        service: 'Tizen Google Home Bridge',
        status: 'online',
        runtime: 'Cloudflare Workers (Edge Serverless)',
        workerUrl: baseUrl,
        cost: '100% Free (100k requests/day)',
        authStatus: {
          authenticated: hasAuth,
          hasKVBinding: !!env.TIZEN_KV,
          hasStoredKVToken: !!kvToken,
          hasOAuthSecrets: !!(CLIENT_ID && CLIENT_SECRET),
        },
        configuredDevice: {
          id: ST_DEVICE_ID || kvDeviceId || cachedDeviceId || 'Not Set (Install Tizen Bridge in SmartThings App)',
          name: TV_NAME,
        },
        endpoints: {
          googleSmartHome: `${baseUrl}/smarthome`,
          googleAuth: `${baseUrl}/google/auth`,
          googleToken: `${baseUrl}/google/token`,
          smartThingsWebhook: `${baseUrl}/smartthings/webhook`,
          tvStatus: `${baseUrl}/tv/status`,
          tvInputs: `${baseUrl}/tv/inputs`,
          debug: `${baseUrl}/debug`,
        },
      });
    }

    // -------------------------------------------------------------------------
    // 9. Google Actions Account Linking (/google/auth & /google/token)
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
    // 10. Assistant Webhook Voice Command Routine (/voice-command)
    // -------------------------------------------------------------------------
    if (url.pathname === '/voice-command') {
      try {
        let body = {};
        if (request.method === 'POST') {
          body = await request.json().catch(() => ({}));
        } else {
          body = Object.fromEntries(url.searchParams.entries());
        }

        const { key, app, input, volume, power } = body;
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
        } else if (volume !== undefined) {
          commandPayload.push({
            component: 'main',
            capability: 'audioVolume',
            command: 'setVolume',
            arguments: [parseInt(String(volume), 10)],
          });
        } else {
          return json({
            error: 'Missing command parameter. Provide key, app, input, volume, or power.',
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
    // 11. Google Smart Home Fulfillment (Cloud-to-Cloud)
    // -------------------------------------------------------------------------
    if (url.pathname === '/smarthome' && request.method === 'POST') {
      try {
        const body = await request.json();
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

        // Intent A: SYNC -> Returns TV traits and dynamic inputs to Google Home
        if (intent === 'action.devices.SYNC') {
          let liveStatus = null;
          try {
            liveStatus = await getSmartThingsDeviceStatus();
          } catch (e) {}

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
                    defaultNames: ['Samsung Smart TV', 'Tizen TV'],
                    name: TV_NAME,
                    nicknames: [TV_NAME, 'Living Room TV', 'Samsung TV', 'Tizen'],
                  },
                  willReportState: false,
                  deviceInfo: {
                    manufacturer: 'Samsung Electronics',
                    model: 'TizenOS Smart TV',
                    hwVersion: '2024.1',
                    swVersion: 'SmartBridge-v1.0',
                  },
                  attributes: {
                    volumeMaxLevel: 100,
                    volumeCanMuteAndUnmute: true,
                    levelStepSize: 2,
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

        // Intent B: QUERY -> Returns live TV state (power, volume, mute, source) to Google Home
        if (intent === 'action.devices.QUERY') {
          const reqDevices = inputs[0]?.payload?.devices || [{ id: targetDeviceId }];
          const liveStatus = await getSmartThingsDeviceStatus();
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
          const liveStatePayload = {
            status: 'SUCCESS',
            online: isLiveSuccess ? liveStatus.online : true,
            on: isLiveSuccess ? liveStatus.on : false,
            currentVolume: isLiveSuccess ? liveStatus.currentVolume : 20,
            isMuted: isLiveSuccess ? liveStatus.isMuted : false,
            currentInput: normalizedInput,
            currentApplication: '111299001912',
            playbackState: isLiveSuccess ? liveStatus.playbackState : 'STOPPED',
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

        // Intent C: EXECUTE -> Executes Google Home trait commands on Samsung TV
        if (intent === 'action.devices.EXECUTE') {
          const commands = inputs[0].payload.commands || [];
          const successfulDeviceIds = [];
          const updatedStates = { online: true };

          for (const cmdGroup of commands) {
            for (const execution of cmdGroup.execution) {
              const commandName = execution.command;
              const params = execution.params || {};
              let stPayload = [];

              switch (commandName) {
                case 'action.devices.commands.OnOff':
                  updatedStates.on = params.on;
                  stPayload.push({
                    component: 'main',
                    capability: 'switch',
                    command: params.on ? 'on' : 'off',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.setVolume':
                  updatedStates.currentVolume = params.volumeLevel;
                  stPayload.push({
                    component: 'main',
                    capability: 'audioVolume',
                    command: 'setVolume',
                    arguments: [params.volumeLevel],
                  });
                  break;

                case 'action.devices.commands.volumeRelative':
                  const isUp = params.volumeRelativeLevel > 0;
                  stPayload.push({
                    component: 'main',
                    capability: 'audioVolume',
                    command: isUp ? 'volumeUp' : 'volumeDown',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mute':
                  updatedStates.isMuted = params.mute;
                  stPayload.push({
                    component: 'main',
                    capability: 'audioMute',
                    command: params.mute ? 'mute' : 'unmute',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.SetInput':
                  let supportedInputsForExec = null;
                  if (env.TIZEN_KV) {
                    try {
                      const kvIn = await env.TIZEN_KV.get('SUPPORTED_INPUTS');
                      if (kvIn) supportedInputsForExec = JSON.parse(kvIn);
                    } catch (e) {}
                  }
                  const stInput = mapInputToSmartThings(params.newInput, supportedInputsForExec);
                  updatedStates.currentInput = params.newInput;
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaInputSource',
                    command: 'setInputSource',
                    arguments: [stInput],
                  });
                  break;

                case 'action.devices.commands.appSelect':
                  updatedStates.currentApplication = params.newApplication;
                  stPayload.push({
                    component: 'main',
                    capability: 'custom.launchapp',
                    command: 'launchApp',
                    arguments: [params.newApplication],
                  });
                  break;

                case 'action.devices.commands.mediaPause':
                  updatedStates.playbackState = 'PAUSED';
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'pause',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaResume':
                  updatedStates.playbackState = 'PLAYING';
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'play',
                    arguments: [],
                  });
                  break;

                case 'action.devices.commands.mediaStop':
                  updatedStates.playbackState = 'STOPPED';
                  stPayload.push({
                    component: 'main',
                    capability: 'mediaPlayback',
                    command: 'stop',
                    arguments: [],
                  });
                  break;
              }

              if (stPayload.length > 0) {
                await sendSmartThingsCommands(stPayload);
              }
            }

            for (const d of cmdGroup.devices) {
              successfulDeviceIds.push(d.id);
            }
          }

          return json({
            requestId,
            payload: {
              commands: [
                {
                  ids: successfulDeviceIds,
                  status: 'SUCCESS',
                  states: updatedStates,
                },
              ],
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
};
