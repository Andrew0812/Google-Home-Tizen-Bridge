# Troubleshooting & Common Issues: Tizen Google Home Bridge (`v3.1-zero-trust-locked`)

This guide covers the most frequent questions and edge cases when connecting Samsung Smart TVs to Google Home.

---

## 1. Browser Diagnostic URLs Return `401 Unauthorized: Valid BRIDGE_SECRET required`

### Cause:
When `BRIDGE_SECRET` is configured in Cloudflare Variables, all diagnostic, OAuth, and device discovery endpoints (`/debug`, `/devices`, `/tv/status`, `/local-devices`, `/local-config`, `/oauth/login`, `/oauth/refresh`, and `/voice-command`) are locked down against public internet scanners.

### Fix:
Append `?key=YOUR_BRIDGE_SECRET` to the URL when opening it in your browser:
- **Health (Detailed)**: `https://tizen-bridge.<your-subdomain>.workers.dev/health?key=YOUR_BRIDGE_SECRET`
- **Debug & KV Status**: `https://tizen-bridge.<your-subdomain>.workers.dev/debug?key=YOUR_BRIDGE_SECRET`
- **List SmartThings Devices**: `https://tizen-bridge.<your-subdomain>.workers.dev/devices?key=YOUR_BRIDGE_SECRET`
- **Live TV Status**: `https://tizen-bridge.<your-subdomain>.workers.dev/tv/status?key=YOUR_BRIDGE_SECRET`
- **SmartThings OAuth Login**: `https://tizen-bridge.<your-subdomain>.workers.dev/oauth/login?key=YOUR_BRIDGE_SECRET`

*(For automated scripts or cURL, you can also pass `Authorization: Bearer YOUR_BRIDGE_SECRET` or `X-Bridge-Secret: YOUR_BRIDGE_SECRET` in the request headers instead of the URL query string).*

---

## 2. Google Home Stops Controlling TV After Adding or Changing `BRIDGE_SECRET`

### Cause:
In `v3.1-zero-trust-locked`, the `/smarthome` fulfillment endpoint verifies that Google Home presents an HMAC-SHA256 Bearer token (`st-access-...`) derived from your `BRIDGE_SECRET`. If you linked Google Home *before* setting `BRIDGE_SECRET` (or if you rotated `BRIDGE_SECRET`), Google Home is still sending the old token.

### Fix:
1. Open the **Google Home app** on your phone.
2. Go to **Settings** $\rightarrow$ **Works with Google**.
3. Tap your linked `[test]` SmartBridge action and select **Unlink account** (or **Reconnect account**).
4. Re-link the action, enter your current **`BRIDGE_SECRET`** on the password prompt screen, and tap **Authorize & Link**.

---

## 3. TV Won't Turn On via Google Assistant When Turned Off

### Cause:
When a Samsung TV is turned off, it enters a low-power standby mode. If network standby is disabled, the TV cuts off its Wi-Fi/Ethernet chip and cannot hear wake commands from SmartThings.

### Fix (On your Samsung TV):
1. Grab your Samsung physical TV remote.
2. Go to **Settings** $\rightarrow$ **General & Privacy** (or **General**).
3. Navigate to **Network** $\rightarrow$ **Expert Settings**.
4. Turn **ON** both:
   - **Power On with Mobile**
   - **IP Remote**
5. Navigate to **General** $\rightarrow$ **External Device Manager**:
   - Turn **ON** **Anynet+ (HDMI-CEC)**.
6. Navigate to **General** $\rightarrow$ **Power and Energy Saving** (or **Eco Solution**):
   - Turn **OFF** **Auto Power Off** or any deep sleep modes that sever network connectivity.

---

## 4. Google Home Shows "HDMI 1 / HDMI 2" Instead of "Xbox" or "PlayStation"

### Cause:
Samsung Tizen TVs populate the custom name (like `XBOX SeriesX|S` or `Nintendo Switch`) in their internal input table (`supportedInputSourcesMap`) when the HDMI device is plugged in and recognized via HDMI-CEC. If the console was in deep sleep when Google Home first synced, Google may have cached the fallback HDMI names.

### Fix:
1. Turn on your TV and turn on your console/device (Xbox, PlayStation, Apple TV).
2. Open your browser and visit:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/tv/status?key=YOUR_BRIDGE_SECRET
   ```
3. Check the `inputs` block in the JSON. You should see your console listed under `detectedFromTv`.
4. Now simply say to any Google Nest speaker or your phone:
   > **"Hey Google, sync my devices."**
5. Google Assistant will reply: *"Syncing devices for Smart Home..."*. Force-close the Google Home app and reopen it. Your TV card will now display your custom input names!

---

## 5. Google Home Says "Living Room TV isn't available right now"

### Diagnostic Step:
Open your browser and visit your Worker's debug endpoint:
```
https://tizen-bridge.<your-subdomain>.workers.dev/debug?key=YOUR_BRIDGE_SECRET
```

### What to check:
1. **`isKvBound: false`**:
   - **Fix**: Bind the `TIZEN_KV` namespace in Cloudflare under **Worker Settings** $\rightarrow$ **Bindings / Variables and Secrets** $\rightarrow$ **KV Namespace Bindings**, and click **Deploy**.
2. **`storedAuthToken: "None"`**:
   - **Fix**: Visit `https://tizen-bridge.<your-subdomain>.workers.dev/oauth/login?key=YOUR_BRIDGE_SECRET` to link your SmartThings account, or install the Tizen Bridge SmartApp in your SmartThings mobile app.
3. **`SmartThings API error: 401 Unauthorized`**:
   - **Fix**: Ensure `SMARTTHINGS_CLIENT_ID` and `SMARTTHINGS_CLIENT_SECRET` are saved in your Worker's Variables and Secrets in Cloudflare, then visit `/oauth/refresh?key=YOUR_BRIDGE_SECRET` (or `/oauth/login?key=YOUR_BRIDGE_SECRET`).

---

## 6. SmartThings Developer Workspace Webhook Verification Fails

### Cause:
When you click **Verify** in the Samsung Developer Workspace, Samsung sends an HTTP POST request with a `confirmationUrl` belonging to `https://*.smartthings.com`. The worker validates the domain and fetches the confirmation URL automatically.

### Fix:
1. Test your worker in your browser first by visiting:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/health
   ```
   Confirm it returns `{"service":"SmartBridge Tizen","status":"online","version":"v3.1-zero-trust-locked"}`.
2. In the Developer Workspace, make sure the Target URL ends with `/webhook` (or `/smartthings/webhook`):
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/webhook
   ```
3. Click **Verify** again.

---

## 7. Fast Voice Routine Shortcuts (Advanced)

If you have a Google Nest Hub or Nest Mini and want to trigger custom Tizen keys (like D-Pad buttons or Picture Modes), you can call your Worker's `/voice-command` endpoint (passing `key=YOUR_BRIDGE_SECRET` and `key_cmd=<TIZEN_KEY>`):

- **Volume by Steps**: `POST /voice-command?key=YOUR_BRIDGE_SECRET&volume=30`
- **Tizen D-Pad Keys**: `POST /voice-command?key=YOUR_BRIDGE_SECRET&key_cmd=UP` or `key_cmd=ENTER`
- **Picture Modes**: `POST /voice-command?key=YOUR_BRIDGE_SECRET&pictureMode=FILMMAKER MODE`

---

## 8. Volume Won't Change on Bluetooth Headphones or External Soundbar

### Cause:
When Bluetooth speakers or headphones are connected, Samsung Tizen OS bypasses its internal speaker digital amplifier and hands volume over to the Bluetooth audio profile (AVRCP).
In Bluetooth mode, Samsung TVs **ignore direct `audioVolume:setVolume` percentage commands** and only respond to remote control pulses (`VOLUP` / `VOLDOWN` or `audioVolume:volumeUp` / `volumeDown`).

### Fix:
1. Ensure you are using `worker.js` (`v3.1-zero-trust-locked`) which configures `commandOnlyVolume: true` and uses the Hybrid Volume Engine + Local Home SDK batched WebSocket key pulses (`KEY_VOLUP` / `KEY_VOLDOWN`).
2. Tap the discrete `+` and `-` volume buttons on the Google Home device card or say *"Hey Google, volume up on TV"*.
