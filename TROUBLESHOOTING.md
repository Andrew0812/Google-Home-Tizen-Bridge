# Troubleshooting & Common Issues: Tizen Google Home Bridge

This guide covers the most frequent questions and edge cases when connecting Samsung Smart TVs to Google Home.

---

## 1. TV Won't Turn On via Google Assistant When Turned Off

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

## 2. Google Home Shows "HDMI 1 / HDMI 2" Instead of "Xbox" or "PlayStation"

### Cause:
Samsung Tizen TVs populate the custom name (like `XBOX SeriesX|S` or `Nintendo Switch`) in their internal input table (`supportedInputSourcesMap`) when the HDMI device is plugged in and recognized via HDMI-CEC. If the console was in deep sleep when Google Home first synced, Google may have cached the fallback HDMI names.

### Fix:
1. Turn on your TV and turn on your console/device (Xbox, PlayStation, Apple TV).
2. Open your browser and visit:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/tv/status
   ```
3. Check the `inputs` block in the JSON. You should see your console listed under `detectedFromTv`.
4. Now simply say to any Google Nest speaker or your phone:
   > **"Hey Google, sync my devices."**
5. Google Assistant will reply: *"Syncing devices for Smart Home..."*. Force-close the Google Home app and reopen it. Your TV card will now display your custom input names!

---

## 3. Google Home Says "Living Room TV isn't available right now"

### Diagnostic Step:
Open your browser and visit your Worker's debug endpoint:
```
https://tizen-bridge.<your-subdomain>.workers.dev/debug
```

### What to check:
1. **`isKvBound: false`**:
   - **Fix**: You forgot to bind the KV namespace in Cloudflare. Go to **Worker Settings** $\rightarrow$ **Variables and Secrets** $\rightarrow$ **KV Namespace Bindings**, add `TIZEN_KV`, and click **Deploy**.
2. **`storedAuthToken: "None"`**:
   - **Fix**: The Tizen Bridge SmartApp hasn't been installed in your mobile SmartThings app yet. Follow Phase 3 of the Master Setup Guide to enable Developer Mode and add the app from Routines/Automations.
3. **`SmartThings API error: 401 Unauthorized`**:
   - **Fix**: Ensure `SMARTTHINGS_CLIENT_ID` and `SMARTTHINGS_CLIENT_SECRET` are added to your Worker's Secrets in Cloudflare. If they are already set, simply open the Tizen Bridge SmartApp in the SmartThings phone app and tap **Done** to refresh your token.

---

## 4. SmartThings Developer Workspace Webhook Verification Fails

### Cause:
When you click **Verify** in the Samsung Developer Workspace, Samsung sends an HTTP POST request with a challenge code. The worker must immediately fetch the verification URL and reply with HTTP 200.

### Fix:
1. Test your worker in your browser first by visiting:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/health
   ```
   If it doesn't return `{"status": "online"}`, your worker code is not saved and deployed.
2. In the Developer Workspace, make sure the Target URL ends with `/smartthings/webhook`:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/smartthings/webhook
   ```
3. Click **Verify** again.

---

## 5. Developer Mode in SmartThings App Doesn't Show "Tizen Bridge"

### Cause:
SmartThings requires Developer Mode to be enabled on your phone to list unpublished SmartApps under the Automations tab.

### Fix:
1. In the SmartThings mobile app, tap **Menu** (bottom right) $\rightarrow$ **Settings** (gear icon) $\rightarrow$ **About SmartThings**.
2. Rapidly tap the **Version number** 10 times in a row until you see the prompt: *"Developer mode enabled"*.
3. Scroll down in Settings and make sure the new toggle **Developer Mode** is turned **ON**.
4. **Important**: Force-close the SmartThings app completely (swipe it away from your phone's recent apps screen) and reopen it.
5. Go to **Automations** (or **Routines** / **Life**) $\rightarrow$ tap the **`+`** icon $\rightarrow$ scroll to the very bottom to **Custom / Developer SmartApps**.

---

## 6. Google Home Account Linking Screen Doesn't Open or Fails

### Fix:
1. In the [Google Actions Console](https://console.actions.google.com), verify under **Develop** $\rightarrow$ **Account Linking**:
   - Authorization URL: `https://tizen-bridge.<your-subdomain>.workers.dev/google/auth`
   - Token URL: `https://tizen-bridge.<your-subdomain>.workers.dev/google/token`
   - Client ID: `google-tizen-client` (can be any string)
   - Client Secret: `google-tizen-secret-123` (can be any string)
2. In the **Test** tab of the Actions Console, make sure the simulator is active.
3. In the Google Home app, search for `[test]` when linking.

---

## 7. Fast Voice Routine Shortcuts (Advanced)

If you have a Google Nest Hub or Nest Mini and want to trigger custom Tizen keys (like D-Pad buttons or Picture Modes), you can create Google Assistant Routines that call your Worker's `/voice-command` endpoint:

- **Volume by Steps**: `POST /voice-command?volume=30`
- **Tizen D-Pad Keys**: `POST /voice-command?key=UP` or `key=OK`
- **Picture Modes**: `POST /voice-command?pictureMode=FILMMAKER MODE`
