# Samsung Smart TV (Tizen OS) to Google Home Bridge

Connect Google Home, Google Nest Hub, and Google Assistant to Samsung Smart TVs with:
- 🎮 **Dynamic HDMI Device Names**: Recognizes "XBOX SeriesX|S", "PlayStation 5", "Nintendo Switch", "Apple TV", etc.
- 🔊 **Full Volume & Mute**: Voice commands for exact volume percentages and mute toggles.
- 📺 **Interactive Google Nest Hub Card**: Touchscreen volume slider, power button, and source picker.
- 🚀 **100% Free Forever**: Runs on Cloudflare Workers Free Tier (100k requests/day, no credit card required).
- 🔒 **Permanent Authentication**: Uses official SmartThings Webhook SmartApp with auto-refreshing OAuth tokens in Cloudflare KV.

---

## 📂 Files Included

- **[`MASTER_SETUP_GUIDE.md`](./MASTER_SETUP_GUIDE.md)**: Complete step-by-step beginner guide with exact instructions for Cloudflare, SmartThings Developer Workspace, the SmartThings phone app, and the Google Actions Developer Console.
- **[`worker.js`](./worker.js)**: Production-ready Cloudflare Worker code with zero personal information, fully commented.
- **[`wrangler.toml`](./wrangler.toml)**: Ready-to-use Cloudflare Workers deployment configuration file.
- **[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)**: Common fixes for offline TV states, network standby, and input syncing.

---

## 🚀 Quick Start

1. Open **[`MASTER_SETUP_GUIDE.md`](./MASTER_SETUP_GUIDE.md)** and follow the 4 simple setup phases.
2. Deploy [`worker.js`](./worker.js) to your free Cloudflare account.
3. Link with Google Home on your phone.
4. Enjoy voice and touch control over your Samsung TV!
