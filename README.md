# Samsung Smart TV (Tizen OS) to Google Home Bridge (`v3.1-zero-trust-locked`)

Connect Google Home, Google Nest Hub, and Google Assistant to Samsung Smart TVs with:
- 🎮 **Dynamic HDMI Device Names**: Recognizes "XBOX SeriesX|S", "PlayStation 5", "Nintendo Switch", "Apple TV", etc.
- ⚡ **Sub-5ms Local Home SDK Wi-Fi Control**: Direct LAN WebSocket execution (`wss://:8002` / `ws://:8001`) with 25-second connection pooling and automatic Cloudflare fallback.
- 🛡️ **Zero-Trust Cryptographic Security**: HMAC-SHA256 signed Google Home OAuth tokens, constant-time `BRIDGE_SECRET` verification, SmartThings device-ownership verification, and zero public metadata leaks.
- 🔊 **Full Volume & Mute**: Works seamlessly across internal TV speakers, external soundbars, and Bluetooth headphones.
- 🚀 **100% Free Forever**: Runs on Cloudflare Workers Free Tier (100k requests/day, no credit card required) with automated 12-hour OAuth token rotation in Cloudflare KV.

---

## 📂 Files Included

- **[`MASTER_SETUP_GUIDE.md`](./MASTER_SETUP_GUIDE.md)**: Complete step-by-step guide covering Cloudflare deployment, `BRIDGE_SECRET` & security hardening variables, SmartThings registration, Google Home linking, and Local Home SDK setup.
- **[`worker.js`](./worker.js)**: Production-ready Cloudflare Worker code (`v3.1-zero-trust-locked`) scrubbed of all personal information.
- **[`local-home-node.js`](./local-home-node.js)** & **[`local-home-chrome.js`](./local-home-chrome.js)**: Ready-to-upload Google Local Home SDK JavaScript bundles for Nest Audio/Mini speakers (Node) and Nest Hub smart displays (Chrome).
- **[`wrangler.toml`](./wrangler.toml)**: Ready-to-use Cloudflare Workers deployment configuration file with the 12-hour Cron Trigger preconfigured.
- **[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)**: Common fixes for `BRIDGE_SECRET` authentication, offline TV states, network standby, Bluetooth volume, and input syncing.

---

## 🚀 Quick Start

1. Open **[`MASTER_SETUP_GUIDE.md`](./MASTER_SETUP_GUIDE.md)** and follow the setup phases.
2. Deploy [`worker.js`](./worker.js) to your free Cloudflare account and set your `BRIDGE_SECRET`.
3. Link your SmartThings account and Google Home app.
4. Enjoy fast, zero-trust voice and touch control over your Samsung TV!
