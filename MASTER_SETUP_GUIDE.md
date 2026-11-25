# Master Setup Guide: Samsung Smart TV (Tizen OS) to Google Home Bridge (`v3.1-zero-trust-locked`)

> **Control your Samsung Smart TV with Google Home & Nest Hub — with real HDMI device names (Xbox, PlayStation, Switch), sub-5ms Local Home SDK Wi-Fi control, volume controls, mute, and app launching.**
> 
> **100% Free Forever • Serverless on Cloudflare Workers (Zero Credit Card Required) • Zero-Trust Cryptographic Security • Permanent 24/7 Connection**

---

## Table of Contents

1. [Why This Bridge Is Needed](#why-this-bridge-is-needed)
2. [What You Will Need (Prerequisites)](#what-you-will-need-prerequisites)
3. [Architecture & Zero-Trust Security Overview](#architecture--zero-trust-security-overview)
4. [Phase 1: Deploy the Cloudflare Worker, KV Storage & Security Variables](#phase-1-deploy-the-cloudflare-worker-kv-storage--security-variables)
5. [Phase 2: Register the SmartThings Webhook SmartApp](#phase-2-register-the-smartthings-webhook-smartapp)
6. [Phase 3: Link Your Samsung Account & Lock Down Your TV Device ID](#phase-3-link-your-samsung-account--lock-down-your-tv-device-id)
7. [Phase 4: Set Up the Google Home Developer Project & Link App](#phase-4-set-up-the-google-home-developer-project--link-app)
8. [Phase 5: Voice Commands Cheat Sheet & Verification](#phase-5-voice-commands-cheat-sheet--verification)
9. [Phase 6: Enable Sub-5ms Local Wi-Fi Control (Google Local Home SDK)](#phase-6-enable-sub-5ms-local-wi-fi-control-google-local-home-sdk)
10. [Frequently Asked Questions](#frequently-asked-questions)

---

## Why This Bridge Is Needed

When you connect a Samsung Smart TV directly to Google Home using the default integration, you usually only get:
- ❌ A basic On/Off toggle.
- ❌ Generic input labels (`HDMI 1`, `HDMI 2`) that don't know what device is plugged in.
- ❌ Sluggish cloud delays or broken volume control when using Bluetooth headphones or soundbars.

### What This Bridge Gives You:
- ✅ **Dynamic Connected Device Names**: Queries Samsung SmartThings for your TV's live hardware inputs. If you have an Xbox plugged into HDMI 2, Google Home automatically displays **"XBOX SeriesX|S"** and accepts voice commands like *"Hey Google, switch input to Xbox on TV"*.
- ✅ **Sub-5ms Local Wi-Fi Execution + Cloud Fallback**: Includes a Google Local Home SDK bundle (`local-home-node.js` / `local-home-chrome.js`) with 25-second WebSocket connection pooling so your Nest Hub and Nest speakers control your TV directly over local Wi-Fi in 2–5ms, automatically falling back to Cloudflare when you are away from home.
- ✅ **Zero-Trust Cryptographic Lockdown (`v3.1-zero-trust-locked`)**:
  - **Zero Public Metadata & Zero Public KV Reads**: Unauthenticated requests to `/` or `/health` reveal nothing about your TV, your SmartThings account, or your configuration, and consume zero KV reads.
  - **HMAC-SHA256 Signed Google Home OAuth**: Account linking (`/google/auth`) is password-protected by your `BRIDGE_SECRET` and issues deterministic HMAC-SHA256 Bearer tokens (`st-access-...`). Every Google Home `SYNC`, `QUERY`, and `EXECUTE` request on `/smarthome` is cryptographically verified.
  - **Webhook Ownership Verification**: SmartThings webhook lifecycle events (`INSTALL` / `UPDATE`) validate tokens live against `api.smartthings.com` and verify ownership of your locked `SMARTTHINGS_DEVICE_ID`, preventing unauthorized token poisoning.
- ✅ **Permanent 24/7 OAuth Connection**: Automatically refreshes SmartThings single-use refresh tokens in Cloudflare KV (with a 12-hour Cron Trigger and cross-isolate race recovery) so your connection never expires.
- ✅ **100% Free**: Runs entirely on the Cloudflare Workers Free Tier (100,000 requests/day, $0.00/month, no credit card required).

---

## What You Will Need (Prerequisites)

You do **not** need a home server, Raspberry Pi, or any paid subscriptions. You only need:
1. A **Samsung Smart TV** running Tizen OS (2017 or newer) already connected to the **SmartThings** mobile app on your phone.
2. A free **Cloudflare Account** ([dash.cloudflare.com](https://dash.cloudflare.com/sign-up)).
3. A free **Samsung Developer Account** (Log in at [smartthings.developer.samsung.com/workspace](https://smartthings.developer.samsung.com/workspace) using your Samsung account).
4. A free **Google Developer Account** (Log in at [console.home.google.com](https://console.home.google.com) or [console.actions.google.com](https://console.actions.google.com) using your Google account).
5. The **SmartThings app** and **Google Home app** installed on your phone.

---

## Architecture & Zero-Trust Security Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    Google Home & Nest Hub                        │
│   1. Sub-5ms Local Wi-Fi WebSocket (Port 8002/8001) on LAN       │
│   2. Cloud Fulfillment (/smarthome) with HMAC Bearer Token       │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                │ HTTPS (Authorization: Bearer st-access-<HMAC>)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│        Your Cloudflare Worker (v3.1-zero-trust-locked)           │
│                                                                  │
│  • BRIDGE_SECRET: Protects /google/auth, /debug, /devices,       │
│    /tv/status, /local-devices, /oauth/login, /voice-command      │
│  • Cloudflare KV (TIZEN_KV): Stores encrypted OAuth tokens       │
│  • 12-Hour Cron Trigger: Proactively rotates SmartThings tokens  │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                │ SmartThings REST API
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Samsung SmartThings Cloud                      │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Samsung Smart TV (Tizen OS)                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Deploy the Cloudflare Worker, KV Storage & Security Variables

Cloudflare Workers provides 100,000 free requests per day forever with zero cost and no credit card required.

### Step 1.1: Create a Free Cloudflare Account
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) and create a free account.
2. Choose your free Workers subdomain (e.g., `yourname.workers.dev`).

### Step 1.2: Create the KV Storage
The worker uses Cloudflare KV (Key-Value storage) to permanently store your TV's auto-rotating OAuth tokens and cached HDMI input map.
1. In the Cloudflare dashboard left menu, navigate to **Workers & Pages** $\rightarrow$ **KV**.
2. Click **Create a namespace**.
3. Name it: `TIZEN_KV` and click **Add**.

### Step 1.3: Create the Worker
1. In the left menu, navigate to **Workers & Pages** $\rightarrow$ **Overview**.
2. Click **Create application** $\rightarrow$ select the **Workers** tab $\rightarrow$ click **Create Worker**.
3. Name your worker: `tizen-bridge` and click **Deploy**.
4. Once deployed, click **Edit code** (or **Quick Edit**).

### Step 1.4: Paste the Code
1. Delete all existing code in the editor.
2. Copy the entire contents of [`worker.js`](./worker.js) from this repository and paste it into the editor.
3. Click **Deploy** (or **Save and Deploy**) in the top right.

### Step 1.5: Bind the KV Namespace
1. Click the back arrow `<-` to return to your Worker details page.
2. Click the **Settings** tab $\rightarrow$ **Bindings** (or **Variables and Secrets**).
3. Under **KV Namespace Bindings**, click **Add binding**.
4. Set:
   - **Variable name**: `TIZEN_KV` *(must be exact uppercase)*
   - **KV namespace**: Select `TIZEN_KV` from the dropdown.
5. Click **Save and deploy**.

### Step 1.6: Add Your `BRIDGE_SECRET` & Environment Variables (Security Hardening)
To ensure nobody on the internet can view your TV status, trigger commands, or link their Google Home account to your worker, configure the following variables in Cloudflare Dashboard $\rightarrow$ Worker **Settings** $\rightarrow$ **Variables and Secrets**:

| Variable Name | Type | Required? | Purpose & Description |
| :--- | :--- | :--- | :--- |
| **`BRIDGE_SECRET`** | **Secret** | **Highly Recommended** | Master passphrase (e.g. a random 20+ character string like `xK9mP2vL8nQ4rT7wY3zA`). Locks down all diagnostic/admin endpoints (`/debug`, `/devices`, `/tv/status`, `/local-devices`, `/oauth/login`, `/voice-command`), password-protects the Google Home linking screen (`/google/auth`), and cryptographically signs Google Home OAuth Bearer tokens for `/smarthome`. |
| **`TV_NAME`** | Text | Optional | Friendly name shown in Google Home (defaults to `Living Room TV`). Example: `Living Room TV` or `Bedroom TV`. |
| **`SMARTTHINGS_CLIENT_ID`** | Secret | Required (Phase 2) | OAuth Client ID from your SmartThings Developer Workspace SmartApp. |
| **`SMARTTHINGS_CLIENT_SECRET`** | Secret | Required (Phase 2) | OAuth Client Secret from your SmartThings Developer Workspace SmartApp. |
| **`SMARTTHINGS_DEVICE_ID`** | Text | Recommended (Phase 3) | Your Samsung TV's UUID (e.g. `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Pinning this in Cloudflare variables permanently locks the worker to your specific TV and verifies device ownership on every webhook event. |
| **`GOOGLE_CLIENT_ID`** | Text | Optional (Phase 4) | E.g. `google-tizen-client`. If set, `/google/auth` and `/google/token` strictly enforce that Google Home sends this exact Client ID. |
| **`GOOGLE_CLIENT_SECRET`** | Secret | Optional (Phase 4) | E.g. a strong random string. If set, `/google/token` strictly enforces that Google Home authenticates with this exact Client Secret during token exchanges. |

> **How `BRIDGE_SECRET` Protects You Without Slowing Down Google Home:**
> - When you link SmartBridge in the Google Home mobile app, the `/google/auth` screen will ask you to enter your `BRIDGE_SECRET` once.
> - Upon verification, your worker issues an HMAC-SHA256 derived OAuth token (`st-access-...`) to Google's servers.
> - Google Home automatically attaches `Authorization: Bearer st-access-...` to every `SYNC`, `QUERY`, and `EXECUTE` voice or touch command behind the scenes, while all public/unauthenticated requests are blocked with `401 Unauthorized`.

### Step 1.7: Enable the 12-Hour Cron Trigger (Automatic Token Rotation)
SmartThings OAuth access tokens expire every 24 hours. Adding a Cloudflare Cron Trigger guarantees your worker refreshes its token in the background every 12 hours even if you go on vacation and don't use your TV for weeks:
1. In your Cloudflare Worker dashboard, go to **Settings** $\rightarrow$ **Triggers** $\rightarrow$ **Cron Triggers**.
2. Click **Add Cron Trigger**.
3. Enter the schedule: `0 */12 * * *` (runs every 12 hours).
4. Click **Add Trigger**.

---

## Phase 2: Register the SmartThings Webhook SmartApp

To allow your worker to communicate with your TV permanently, register a Webhook SmartApp in Samsung's Developer Workspace.

1. Go to the [SmartThings Developer Workspace](https://smartthings.developer.samsung.com/workspace).
2. Sign in with the **same Samsung Account** that is signed in on your TV and SmartThings phone app.
3. Click **New Project** $\rightarrow$ choose **Automation for SmartThings** (`SmartApp` $\rightarrow$ `Webhook Endpoint`).
4. Fill in the details:
   - **App Name / Display Name**: `Tizen Bridge`
   - **Description**: `Google Home TV Integration`
   - **Target URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/webhook
     ```
     *(Note: `/smartthings/webhook` is also supported).*
   - **Redirect URI** (if configuring OAuth-In):
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/oauth/callback
     ```
5. Under **Permissions / Scopes**, check the following boxes:
   - `r:devices:*` (Read devices)
   - `w:devices:*` (Control devices)
   - `x:devices:*` (Execute device commands)
6. Click **Save** (or **Next**).
7. **Instant Webhook Verification**:
   - SmartThings will ask you to verify your target URL.
   - Click **Verify**.
   - Your deployed Cloudflare Worker automatically validates that the `confirmationUrl` belongs to `https://*.smartthings.com` and completes Samsung's verification handshake immediately.
8. Copy your **Client ID** and **Client Secret** and save them into your Cloudflare Worker **Settings** $\rightarrow$ **Variables and Secrets** as:
   - `SMARTTHINGS_CLIENT_ID`
   - `SMARTTHINGS_CLIENT_SECRET`
9. Click **Deploy**.

---

## Phase 3: Link Your Samsung Account & Lock Down Your TV Device ID

You can authenticate your worker with SmartThings using **either** the browser OAuth flow (`/oauth/login`) **or** the SmartThings Mobile App installation flow.

### Option A (Fastest): Direct Browser OAuth Login
1. Open your browser and visit your worker's OAuth login endpoint with your `BRIDGE_SECRET`:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/oauth/login?key=YOUR_BRIDGE_SECRET
   ```
2. Click **Connect Samsung SmartThings Account** and authorize access.
3. Your worker verifies the HMAC-signed OAuth `state`, exchanges the authorization code, and automatically saves both `AUTH_TOKEN` and `REFRESH_TOKEN` into `TIZEN_KV`!

### Option B: Install "Tizen Bridge" in the SmartThings Mobile App
1. Open the **SmartThings mobile app** on your phone $\rightarrow$ **Menu** $\rightarrow$ **Settings** (gear icon) $\rightarrow$ **About SmartThings**.
2. Tap the **Version number** continuously **10 times** until **Developer Mode** appears, toggle it **ON**, and force-close/reopen the app.
3. Go to **Automations / Routines** $\rightarrow$ tap **`+`** $\rightarrow$ scroll down to **Custom / Developer SmartApps** $\rightarrow$ tap **Tizen Bridge**.
4. Select your Samsung TV and tap **Done**.

### Step 3.3: Find & Lock Down Your `SMARTTHINGS_DEVICE_ID`
1. Open your browser and visit:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/devices?key=YOUR_BRIDGE_SECRET
   ```
2. Copy the `deviceId` of your Samsung TV (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
3. In Cloudflare Dashboard $\rightarrow$ Worker **Settings** $\rightarrow$ **Variables and Secrets**, add:
   - **`SMARTTHINGS_DEVICE_ID`**: Paste your TV's `deviceId`.
4. Click **Deploy**.
   - *Security Benefit*: Once `SMARTTHINGS_DEVICE_ID` is pinned, the `/webhook` endpoint enforces strict device-ownership validation—rejecting any webhook event whose SmartThings token does not own your exact TV.

### Step 3.4: Verify Connection in Your Browser
Visit your protected debug endpoint:
```
https://tizen-bridge.<your-subdomain>.workers.dev/debug?key=YOUR_BRIDGE_SECRET
```
You will see `"isKvBound": true`, your masked token status (`"Present (36 chars)"`), and `"statusSummary": "Authentication verified! SmartThings is fully linked to your TV. Google Home is ready."`

---

## Phase 4: Set Up the Google Home Developer Project & Link App

Now tell Google Home how to communicate with your Cloudflare Worker.

### Step 4.1: Create a Smart Home Project
1. Open the [Google Home Developer Console](https://console.home.google.com) or [Google Actions Console](https://console.actions.google.com).
2. Click **New Project** (e.g., `My Samsung TV Bridge`) and select **Cloud-to-cloud / Smart Home**.

### Step 4.2: Configure Cloud Fulfillment
1. Set your action display name (e.g., `SmartBridge Tizen`).
2. In the **Fulfillment URL** field, enter:
   ```
   https://tizen-bridge.<your-subdomain>.workers.dev/smarthome
   ```
3. Click **Save**.

### Step 4.3: Configure Account Linking
1. Open **Account Linking** in the console settings.
2. Set the following fields:
   - **Client ID**: `google-tizen-client` *(if you set `GOOGLE_CLIENT_ID` in Cloudflare, use that exact value)*
   - **Client Secret**: `google-tizen-secret-123` *(if you set `GOOGLE_CLIENT_SECRET` in Cloudflare, use that exact value)*
   - **Authorization URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/google/auth
     ```
   - **Token URL**:
     ```
     https://tizen-bridge.<your-subdomain>.workers.dev/google/token
     ```
   - **Scopes**: *(Leave blank or enter `smarthome`)*
3. Click **Save** and ensure **Test** mode is enabled.

### Step 4.4: Link in the Google Home Mobile App (With `BRIDGE_SECRET`)
1. Open the **Google Home app** on your phone.
2. Tap **`+`** $\rightarrow$ **Works with Google**.
3. Search for your test integration: `[test] My Samsung TV Bridge` and tap it.
4. Your Cloudflare Worker's secure authorization screen will open:
   - Enter your **`BRIDGE_SECRET`** into the password box.
   - Tap **Authorize & Link**.
5. Assign your TV to a room (e.g., *Living Room*).

✨ **Done! Your Samsung TV is now cryptographically linked to Google Home!**

---

## Phase 5: Voice Commands Cheat Sheet & Verification

### Browser Diagnostic Check (Authenticated)
Note that unauthenticated requests to `/health` return only `{"service":"SmartBridge Tizen","status":"online","version":"v3.1-zero-trust-locked"}`. To inspect live TV status in your browser, append `?key=YOUR_BRIDGE_SECRET`:
```
https://tizen-bridge.<your-subdomain>.workers.dev/tv/status?key=YOUR_BRIDGE_SECRET
```
This displays:
- Power status (`on` / `off`), volume level, and mute state.
- Current active input (`HDMI1`, `HDMI2`, `dtv`, etc.).
- All detected HDMI devices and their friendly names (`supportedInputSourcesMap`).

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
- *"Hey Google, turn up the TV volume"*
- *"Hey Google, volume down on Living Room TV"*
- *"Hey Google, mute Living Room TV"*
- *"Hey Google, unmute TV"*

#### App Launching:
- *"Hey Google, open YouTube on TV"*
- *"Hey Google, open Netflix on TV"*
- *"Hey Google, open Disney+ on TV"*
- *"Hey Google, open Spotify on Living Room TV"*
- *"Hey Google, open Prime Video on TV"*

#### Media Playback:
- *"Hey Google, pause TV"*
- *"Hey Google, resume TV"*
- *"Hey Google, stop TV"*

---

## Phase 6: Enable Sub-5ms Local Wi-Fi Control (Google Local Home SDK)

By default, Google Assistant contacts your Cloudflare Worker over the internet. You can enable **Google Local Home SDK** so your Google Nest Hub, Nest speakers, and phone send commands directly to your Samsung TV over your home Wi-Fi network in **2 to 5 milliseconds** using a 25-second pooled WebSocket connection.

If you are away from home on 5G mobile data, or if the TV is asleep, Google Assistant **automatically falls back to Cloudflare**.

### Step 6.1: Register Your TV's Local Static IP with Your Worker (Recommended)
To give your Nest devices instant access to your TV's LAN IP and local WebSocket token via `customData`, send a one-time authenticated `POST` request to `/local-devices`:
```bash
curl -X POST "https://tizen-bridge.<your-subdomain>.workers.dev/local-devices?key=YOUR_BRIDGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "YOUR_SMARTTHINGS_DEVICE_ID",
    "name": "Living Room TV",
    "localIp": "192.168.1.50",
    "wifiMac": "AA:BB:CC:DD:EE:FF"
  }'
```

### Step 6.2: Configure Local Home SDK in Google Home Developer Console
1. Navigate to your project in the [Google Home Developer Console](https://console.home.google.com).
2. Go to **Cloud-to-cloud** $\rightarrow$ **Local fulfillment** and toggle **Enable local fulfillment** to **ON**.
3. Set the **Testing URLs**:
   - **Testing URL for Chrome**: `https://tizen-bridge.<your-subdomain>.workers.dev/local-home/app.js`
   - **Testing URL for Node**: `https://tizen-bridge.<your-subdomain>.workers.dev/local-home/app.js`
4. **Upload JavaScript bundles**:
   - Upload [`local-home-node.js`](./local-home-node.js) for **Node**.
   - Upload [`local-home-chrome.js`](./local-home-chrome.js) for **Chrome**.
5. **Add Device Scan Configuration**:
   - **Protocol 1 (mDNS)**: Service type `_samsungmsf._tcp.local`
   - **Protocol 2 (UPnP)**: Device type `urn:samsung.com:device:RemoteControlReceiver:1`
6. Click **Save**.

### Step 6.3: One-Time On-Screen TV Approval
1. Issue a command to your TV from your Google Nest Hub or speaker while on home Wi-Fi.
2. The first time, your Samsung TV screen will prompt:
   > *"Allow 'GoogleNestBridge' to connect to your TV? [Allow] [Deny]"*
3. Select **Allow** with your physical Samsung remote. Your TV permanently whitelists the bridge.

---

## Frequently Asked Questions

### 1. Does this work when the TV is turned off?
Yes, **provided your TV's Network Standby is turned on**.
On your Samsung TV:
- Go to **Settings** $\rightarrow$ **General** $\rightarrow$ **Network** $\rightarrow$ **Expert Settings**.
- Make sure **Power On with Mobile** and **IP Remote** are both set to **ON**.
- Make sure **Anynet+ (HDMI-CEC)** is **ON** in General $\rightarrow$ External Device Manager.

### 2. What happens if I change or rotate my `BRIDGE_SECRET`?
Because Google Home's OAuth Bearer token (`st-access-...`) is cryptographically derived from `BRIDGE_SECRET` via HMAC-SHA256, rotating `BRIDGE_SECRET` immediately invalidates old Bearer tokens. After updating `BRIDGE_SECRET` in Cloudflare, simply open the **Google Home app** $\rightarrow$ **Settings** $\rightarrow$ **Works with Google**, unlink your test bridge, and relink it using your new `BRIDGE_SECRET`.

### 3. Do I ever need to re-login or update SmartThings tokens?
**No.** Unlike Personal Access Tokens (which expire after 24 hours), the worker automatically refreshes your SmartThings OAuth token in Cloudflare KV and rotates it every 12 hours via the Cron Trigger.

### 4. What is the Cloudflare usage cost?
**$0.00 forever.** Cloudflare Workers provides 100,000 requests/day on the free tier, and unauthenticated public probes consume zero KV reads.
