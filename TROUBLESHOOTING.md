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

---

## 8. Volume Won't Change on Bluetooth Headphones or External Soundbar

### Cause:
When Bluetooth speakers or headphones are connected, Samsung Tizen OS bypasses its internal speaker digital amplifier and hands volume over to the Bluetooth audio profile (AVRCP).
In Bluetooth mode, Samsung TVs **ignore direct `audioVolume:setVolume` percentage commands**, which is why the slider appears not to work. The TV only responds to remote control pulses (`VOLUP` and `VOLDOWN`), exactly like when pressing the physical remote.

### Fix:
1. Ensure you are using `worker.js` (version with the Hybrid Volume Engine).
2. The worker automatically sends both `audioVolume` commands (for TV speakers) and `samsungvd.remoteControl:send(["VOLUP"/"VOLDOWN"])` pulses (for Bluetooth headphones/soundbars).
3. If using voice, saying *"Hey Google, volume up on TV"* sends dedicated remote pulses that adjust Bluetooth volume instantly.

---

## 9. Google Nest Hub Says "The TV is Currently Offline"

### Cause:
Google Nest Hub displays have a strict **3-second timeout** on all status queries (`action.devices.QUERY`). If querying the SmartThings cloud directly takes more than 3 seconds (especially during audio source transitions or input switches), the Nest Hub displays *"The TV is currently offline"*.

### Fix:
1. The updated `worker.js` uses **Sub-20ms Edge Caching**. It answers Google Nest Hub's queries immediately from the edge and refreshes device status in the background using `ctx.waitUntil`.
2. Nest Hub queries will now return in under 20 milliseconds, permanently preventing the 3-second timeout.

---

## 10. Google Assistant Says "I Couldn't Find the TV"

### Cause:
When asking Google Assistant to change volume (*"Hey Google, set the TV volume to 30"*), Google's Natural Language parser strictly matches against registered device nicknames. If `"TV"` or `"The TV"` is not in the device's nicknames, Google Assistant replies: *"I couldn't find the TV."*

### Fix:
1. In `worker.js`, the device is now registered with universal nicknames:
   ```javascript
   nicknames: ['TV', 'The TV', 'Television', 'Samsung TV', 'Living Room TV']
   ```
2. Say to your Google Nest speaker or phone:
   > **"Hey Google, sync my devices."**
3. In the Google Home mobile app, open the TV card $\rightarrow$ tap the **Settings (gear icon)** $\rightarrow$ tap **Name** $\rightarrow$ ensure its name is set to **`TV`** and assigned to a Room (e.g., Living Room).
4. If an old official SmartThings TV device is still present as a duplicate in Google Home, unlink the old service so Google Assistant routes all voice commands to your Tizen Bridge.

---

## 11. Changing the Volume Card: Slider vs. `+` / `-` Step Buttons

Google Home's user interface is governed by the `commandOnlyVolume` attribute in `worker.js`:

### Discrete `+` and `-` Step Buttons (Recommended for Bluetooth & Zero Lag)
By setting `commandOnlyVolume: true` under `action.devices.SYNC` attributes:
* **UI**: Google Home replaces the 0–100% volume slider with discrete **`+`** and **`-`** buttons on the device card.
* **Benefits**: No slider dragging lag, no rubber-banding, and works smoothly for both internal TV speakers and Bluetooth headphones.
* **Trade-off**: Absolute percentage voice commands (*"set volume to 25%"*) are disabled by Google; voice commands use relative stepping (*"volume up"*, *"volume down"*, *"turn it up by 5"*).

### Switching Back to the 0–100% Volume Slider
If you prefer the continuous 0–100% slider:
1. Open `worker.js` and change `commandOnlyVolume: true` to `commandOnlyVolume: false` (or remove the line).
2. Restore `currentVolume` in `liveStatePayload` under `action.devices.QUERY`.
3. Deploy the worker and say: **"Hey Google, sync my devices."**
4. Force-close and reopen the Google Home app.

