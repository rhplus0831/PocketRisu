<p align="center">
  <strong>English</strong> | <a href="../ko/remote.md">한국어</a> | <a href="../de/remote.md">Deutsch</a> | <a href="../cn/remote.md">简体中文</a> | <a href="../es/remote.md">Español</a> | <a href="../vi/remote.md">Tiếng Việt</a> | <a href="../zh-Hant/remote.md">繁體中文</a>
</p>

# Remote Access Guide

Use Tailscale to access PocketRisu running on your PC from another device (smartphone, tablet, or another PC) over HTTPS.

## Tailscale

Builds a private network (VPN) accessible only from devices logged in with the same account. The URL persists across server restarts.

### Step 1: Install Tailscale

- PC: [tailscale.com](https://tailscale.com/)
- Smartphone: Search for "Tailscale" in App Store / Google Play
- Other PC: Same — [tailscale.com](https://tailscale.com/)

### Step 2: Sign in with the same account

Sign into the Tailscale app on the PC and on every device you'll access from, using the same account (Google, Microsoft, etc.).

### Step 3: Enable HTTPS sharing on the PC

In the terminal on the PC running PocketRisu, run once:

```bash
tailscale serve --bg http://localhost:6001
```

### Step 4: Access from another device

Open in a browser using this URL format:

```
https://your-pc-name.tail-something.ts.net
```

Find the exact address from your PC's entry in the Tailscale app's device list. Bookmark it in the browser, and from then on you only need to start the server on the PC to access from any device.


---

← [Back to README](../../README.md)
