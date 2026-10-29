# Master Setup Guide: Samsung Smart TV (Tizen OS) to Google Home Bridge

> **Control your Samsung Smart TV with Google Home & Nest Hub — with real HDMI device names (Xbox, PlayStation, Switch), volume sliders, mute, and app launching.**
> 
> **100% Free Forever • Serverless on Cloudflare Workers (Zero Credit Card Required) • Permanent Connection (Never Expires)**

---

## Table of Contents

1. [Why This Bridge Is Needed](#why-this-bridge-is-needed)
2. [What You Will Need (Prerequisites)](#what-you-will-need-prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Deploy the Cloudflare Worker & KV Storage](#phase-1-deploy-the-cloudflare-worker--kv-storage)
5. [Phase 2: Register the SmartThings Webhook SmartApp](#phase-2-register-the-smartthings-webhook-smartapp)
6. [Phase 3: Install "Tizen Bridge" in the SmartThings Mobile App](#phase-3-install-tizen-bridge-in-the-smartthings-mobile-app)
7. [Phase 4: Set Up the Google Home Developer Project & Link App](#phase-4-set-up-the-google-home-developer-project--link-app)
8. [Phase 5: Voice Commands Cheat Sheet & Verification](#phase-5-voice-commands-cheat-sheet--verification)
9. [Frequently Asked Questions](#frequently-asked-questions)

---

## Why This Bridge Is Needed

When you connect a Samsung Smart TV directly to Google Home using the official SmartThings action, you usually only get:
- ❌ A basic On/Off toggle.
- ❌ Generic input labels (`HDMI 1`, `HDMI 2`) that don't know what device is plugged in.
- ❌ No native volume slider or precise volume control.

### What This Bridge Gives You:
- ✅ **Dynamic Connected Device Names**: It queries Samsung SmartThings for your TV's live hardware inputs. If you have an Xbox plugged into HDMI 2, Google Home automatically displays **"XBOX SeriesX|S"** and accepts voice commands like *"Hey Google, switch input to Xbox on TV"*.
- ✅ **Full Volume & Mute**: *"Hey Google, set TV volume to 25"* or *"Hey Google, mute Living Room TV"*.
- ✅ **Touch Controls on Google Nest Hub**: Full interactive card with volume slider, power button, and source selector.
- ✅ **Permanent Connection**: Uses official OAuth with auto-refreshing tokens stored securely in Cloudflare KV. It never expires after 24 hours.
- ✅ **100% Free**: Runs on Cloudflare Workers Free Tier (100,000 requests/day, no credit card required).

---

## What You Will Need (Prerequisites)

You do **not** need a home server, Raspberry Pi, or any paid subscriptions. You only need:
1. A **Samsung Smart TV** running Tizen OS (2017 or newer) already connected to the **SmartThings** mobile app on your phone.
2. A free **Cloudflare Account** ([dash.cloudflare.com](https://dash.cloudflare.com/sign-up)).
3. A free **Samsung Developer Account** (Log in at [smartthings.developer.samsung.com/workspace](https://smartthings.developer.samsung.com/workspace) using your Samsung account).
4. A free **Google Developer Account** (Log in at [console.actions.google.com](https://console.actions.google.com) using your Google account).
5. The **SmartThings app** and **Google Home app** installed on your phone.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│               Google Home & Nest Hub                   │
│   (Voice commands: "Turn on TV", "Switch to Xbox")     │
└───────────────────────────┬────────────────────────────┘
                            │
                            │ HTTPS Webhook (/smarthome)
                            ▼
┌────────────────────────────────────────────────────────┐
│        Your Cloudflare Worker (100% Free)              │
│                                                        │
│  • worker.js (Translates Google intents to SmartThings)│
│  • Cloudflare KV (Stores permanent OAuth tokens & TV ID)
└───────────────────────────┬────────────────────────────┘
                            │
                            │ SmartThings REST API
                            ▼
┌────────────────────────────────────────────────────────┐
│               Samsung SmartThings Cloud                │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Samsung Smart TV (Tizen OS)              │
└────────────────────────────────────────────────────────┘
```

---

## Phase 1: Deploy the Cloudflare Worker & KV Storage

Cloudflare Workers provides 100,000 free requests per day forever with zero cost and no credit card required.

### Step 1.1: Create a Free Cloudflare Account
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) and create a free account.
2. Choose your free Workers subdomain (e.g., `yourname.workers.dev`).

### Step 1.2: Create the KV Storage
The worker uses Cloudflare KV (Key-Value storage) to permanently store your TV's connection token and device ID.
1. In the Cloudflare dashboard left menu, navigate to **Storage & databases** $\rightarrow$ **Workers KV**.
2. Click **Create a KV namespace**.
3. Name it: `TIZEN_KV`, leave "Data Location" as "Standard" and click **Create**.

### Step 1.3: Create the Worker
1. In the left menu, navigate to **Compute** $\rightarrow$ **Workers & Pages** $\rightarrow$ **Overview**.
2. Click **Create application** $\rightarrow$ select **Start with Hello World!**.
3. Name your worker: `tizen-bridge` and click **Deploy**.
4. Once deployed, click **Edit code** (or **Quick Edit**) in the top-right.

### Step 1.4: Paste the Code
1. Delete all existing code in the editor.
2. Copy the entire contents of [`worker.js`](./worker.js) from this repository and paste it into the editor.
3. Click **Deploy** (or **Save and Deploy**) in the top right.

### Step 1.5: Bind the KV Namespace
1. Click the back arrow `<-` to return to your Worker details page.
2. Click the **Settings** tab.
3. Click **Add binding** in the **Bindings** section.
4. Scroll down to **KV Namespace Bindings** and click **Add binding**.
5. Set:
   - **Variable name**: `TIZEN_KV` *(must be exact uppercase)*
   - **KV namespace**: Select `TIZEN_KV` from the dropdown.
6. Click **Save and deploy**.

### Step 1.6: Note Your Worker URL
Your worker now has a public URL visible at the top of the Worker page:
```
https://tizen-bridge.<your-subdomain>.workers.dev
```
*(Keep this URL handy — you will need it for SmartThings and Google Home).*

---

## Phase 2: Register the SmartThings Webhook SmartApp

To allow your worker to communicate with your TV permanently, register a Webhook SmartApp in Samsung's Developer Workspace.

1. Go to the [SmartThings Developer Workspace](https://developer.smartthings.com/workspace).
2. Sign in with the **same Samsung Account** that is signed in on your TV and SmartThings phone app.
3. In the left sidebar, click **Automation for SmartThings** (or **Projects** $\rightarrow$ **New Project**).
4. Choose **SmartApp** $\rightarrow$ **Webhook Endpoint**.
5. Fill in the details:
   - **App Name / Display Name**: `Tizen Bridge`
   - **Description**: `Google Home TV Integration`
   - **Target URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/smartthings/webhook
     ```
6. Under **Permissions / Scopes**, check the following boxes:
   - `r:devices:*` (Read devices)
   - `w:devices:*` (Control devices)
   - `x:devices:*` (Execute device commands)
7. Click **Save** (or **Next**).
8. **Instant Webhook Verification**:
   - SmartThings will ask you to verify your target URL.
   - Click **Verify**.
   - Your deployed Cloudflare Worker will automatically respond to Samsung's verification challenge and verify the URL instantly!
9. After creation, open your SmartApp settings and note:
   - **Client ID**
   - **Client Secret**
10. *(Recommended)* Add these to your Cloudflare Worker:
    - In Cloudflare Dashboard $\rightarrow$ **Compute** $\rightarrow$ **Workers & Pages** $\rightarrow$ **tizenbridge** $\rightarrow$ **Settings tab**.
    - Click **Add variable** at the top of the page next to **Runtime variables and secrets**
    - Add `SMARTTHINGS_CLIENT_ID` with your Client ID.
    - Add `SMARTTHINGS_CLIENT_SECRET` with your Client Secret.
    - Click **Deploy**.

---

## Phase 3: Install "Tizen Bridge" in the SmartThings Mobile App

Now install your custom SmartApp on your phone so it can grant access to your Samsung TV and store the authorization in your Cloudflare KV.

### Step 3.1: Enable Developer Mode in the SmartThings App
1. Open the **SmartThings mobile app** on your phone (iOS or Android).
2. Tap **Menu** (three lines) $\rightarrow$ tap the **Settings** gear icon.
3. Scroll down to **About SmartThings**.
4. **The Developer Secret**: Tap and hold the **About SmartThings** button for **10 seconds**.
5. A new toggle titled **Developer Mode** will appear below the **About SmartThings** button. Turn it **ON**.
6. Completely **force-close** the SmartThings app and reopen it.

### Step 3.2: Add the "Tizen Bridge" SmartApp
1. In the SmartThings app, navigate to **Routines** (or the **Life** / **Automations** tab depending on your app version).
2. Go to the **Discover** tab at the top.
3. Scroll all the way down past the built-in services until you see **Tizen Bridge**.
4. Tap **Tizen Bridge**.
5. Set **Name** to "TizenBridge".
6. Select your TV from the list below.
7. Tap **Done** (or **Save**).

### Step 3.3: Verify Connection in Your Browser
Open your browser and navigate to:
```
https://tizen-bridge.<your-subdomain>.workers.dev/debug
```
You should see:
```json
{
  "isKvBound": true,
  "statusSummary": "Authentication verified! SmartThings is fully linked to your TV. Google Home is ready."
}
```
🎉 **Your Cloudflare Worker is now permanently authenticated with your TV!**

---

## Phase 4: Set Up the Google Home Developer Project & Link App

Now tell Google Home how to communicate with your Cloudflare Worker.

### Step 4.1: Create a Smart Home Project in Google Home Console
1. Open the [Google Home Console](https://console.home.google.com).
2. Click **Create a Project**.
3. Enter a project name (e.g., `My Samsung TV Bridge`) and click **Create Project**.

### Step 4.2: Configure Cloud Fulfillment
1. On the **Project Home** page, click **Add cloud-to-cloud integration**.
2. Click **Next: Develop** at the bottom of the page.
3. Click **Next: Setup** at the bottom of the page.
4. Set **Integration name** to "Samsung TV Bridge"
5. Set **Device type** to "TV"
6. In the **App branding** field, upload your app icon (can use the SamsungTVBridge.png file provided on the Github repo)
7. Scroll down to **Cloud fulfillment URL**
8. In the **Fulfillment URL** field, enter:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/smarthome
   ```
9. Click **Save**.

### Step 4.3: Configure Account Linking
1. On the same page, scroll to the **Account Linking** section.
2. Set the following fields:
   - **Client ID**: `tizenbridge`.
   - **Client Secret**: `tizenbridge`.
   - **Authorization URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/google/auth
     ```
   - **Token URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/google/token
     ```
   - **Scopes**: (Leave blank)

### Step 4.4: Enable Testing
1. In the side navigation bar, click **Cloud-to-cloud** $\rightarrow$ **Test**.
2. Click **Start Testing** or **Test** This makes the test action visible in your personal Google Home mobile app.

### Step 4.5: Link in the Google Home Mobile App
1. Open the **Google Home app** on your phone.
2. Tap the **`+`** button (or go to **Devices** $\rightarrow$ **Add device**).
3. Select **Link app or service**
4. Select **Works with Google**.
5. Search for: `[test] My Samsung TV Bridge` (it will have the `[test]` prefix).
6. Tap it. A clean authorization page will open:
   - Tap the blue **Authorize & Link** button.
7. Assign your TV to a room (e.g., *Living Room*).

✨ **Done! Your Samsung TV now appears in Google Home with full controls and dynamic device names!**

---

## Phase 5: Voice Commands Cheat Sheet & Verification

### Browser Diagnostic Check
You can check the live status of your TV anytime in any browser:
```
https://tizen-bridge.<your-subdomain>.workers.dev/tv/status
```
This shows:
- Power status (`on` / `off`).
- Real volume level and mute state.
- Current active input.
- All detected HDMI devices and their friendly names.

---

### Voice Commands Reference

You can now use any Google Assistant device (Nest Mini, Nest Hub, Android phone, etc.):

#### Power:
- *"Hey Google, turn on Living Room TV"*
- *"Hey Google, turn off the TV"*

#### Inputs & Connected Devices (Dynamic HDMI Names):
- *"Hey Google, switch input to Xbox on TV"*
- *"Hey Google, switch input to PlayStation on Living Room TV"*
- *"Hey Google, switch TV to Nintendo Switch"*
- *"Hey Google, switch to Apple TV"*
- *"Hey Google, switch TV input to HDMI 2"*
- *"Hey Google, switch TV to Live TV"*

#### Volume & Audio:
- *"Hey Google, set TV volume to 20"*
- *"Hey Google, turn up the TV volume"*
- *"Hey Google, volume down on Living Room TV"*
- *"Hey Google, mute Living Room TV"*
- *"Hey Google, unmute TV"*

#### App Launching:
- *"Hey Google, open YouTube on TV"*
- *"Hey Google, open Netflix on TV"*
- *"Hey Google, open Spotify on Living Room TV"*
- *"Hey Google, open Prime Video on TV"*

#### Media Playback:
- *"Hey Google, pause TV"*
- *"Hey Google, resume TV"*
- *"Hey Google, stop TV"*

---

## Frequently Asked Questions

### 1. Does this work when the TV is turned off?
Yes, **provided your TV's Network Standby is turned on**.
On your Samsung TV:
- Go to **Settings** $\rightarrow$ **General** $\rightarrow$ **Network** $\rightarrow$ **Expert Settings**.
- Make sure **Power On with Mobile** and **IP Remote** are both set to **ON**.
- Make sure **Anynet+ (HDMI-CEC)** is **ON** in General $\rightarrow$ External Device Manager.

### 2. What happens if I move my Xbox from HDMI 1 to HDMI 2?
SmartThings automatically senses the HDMI-CEC handshake from the Xbox. When you switch or turn it on, the bridge dynamically updates the input map. To immediately force Google Home to update its list of sources, simply say:
> *"Hey Google, sync my devices."*

### 3. Do I ever need to re-login or update tokens?
**No.** Unlike Personal Access Tokens (which expire after 24 hours), the Tizen Bridge SmartApp uses OAuth with automatic background token refreshes stored in Cloudflare KV. It runs continuously 24/7 without intervention.

### 4. What is the Cloudflare usage cost?
**$0.00 forever.** Cloudflare Workers provides 100,000 requests every single day on the free tier. A typical household sending 100 TV commands per day uses 0.1% of the free quota.

---

*Enjoy controlling your Samsung Smart TV with Google Home!*
