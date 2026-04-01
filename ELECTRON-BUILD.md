# Electron Build — api-dash.exe

## Current status
A working portable build already exists at:
```
dist/win-unpacked/api-dash.exe
```
This folder is **gitignored** (not committed to source). The exe wraps `server.js` + the frontend in a standalone Electron desktop app with system tray, global hotkey, and auto-open browser.

Aaron pinned `dist/win-unpacked/api-dash.exe` to the Windows taskbar.

---

## To run (no rebuild needed)
```bash
# Option 1: Launch the existing exe directly
start dist/win-unpacked/api-dash.exe

# Option 2: Dev mode — Electron wrapper, loads from source (live edits apply)
npm run app
# Opens Electron window pointing to localhost:3737

# Option 3: Server only (no Electron chrome)
npm start
# Then open http://localhost:3737 in browser
```

---

## To rebuild the exe (portable/unpacked)
Use the `--dir` flag to get the same unpacked folder format:
```bash
npm install                              # ensure electron-builder is installed
npx electron-builder --win --x64 --dir  # builds to dist/win-unpacked/api-dash.exe
```

To build the NSIS installer instead (what `npm run build` does):
```bash
npm run build   # → dist/api-dash Setup x.x.x.exe
```

---

## Key files
- `main.js` — Electron main process: spawns `server.js`, creates BrowserWindow + system tray
- `server.js` — all backend logic (API fetchers, /api/* endpoints, WebSocket)
- `public/index.html` — frontend UI
- `assets/icon.ico` — app icon (required for build)
- `.env.local` — API keys (gitignored, bundled into exe via `extraResources`)
- `package.json` — build config under `"build"` key

---

## Troubleshooting
- **Blank window on launch**: server.js didn't start — check `.env.local` exists
- **Port conflict**: set `PORT=3738` in `.env.local`
- **Missing icon error on build**: run `npm run make-icon` first
- **`electron-builder` not found**: run `npm install` — it's a devDependency
