// api-dash — Electron main process
// Spawns server.js, creates a BrowserWindow, system tray, and global hotkey

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = parseInt(process.env.PORT || "3737", 10);
const URL  = `http://localhost:${PORT}`;

let win    = null;
let tray   = null;
let server = null;

// ── Server ────────────────────────────────────────────────────────────────────

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit",
  });
  server.on("error", (e) => console.error("[api-dash] server error:", e.message));
}

function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(URL, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (++attempts >= retries) return reject(new Error("Server did not start"));
        setTimeout(check, 500);
      });
    };
    check();
  });
}

// ── Tray icon ─────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("api-dash — API Spend Monitor");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Dashboard",
      click: () => showWindow(),
    },
    { type: "separator" },
    {
      label: `Open in Browser`,
      click: () => shell.openExternal(URL),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => toggleWindow());
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: "api-dash",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // shown after server ready
  });

  win.loadURL(URL);

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // F12 opens DevTools
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") win.webContents.openDevTools();
  });

  // Minimize to tray instead of closing
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => { win = null; });
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || !win.isVisible()) {
    showWindow();
  } else {
    win.hide();
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.on("ready", async () => {
  startServer();
  createTray();

  // Register Shift+Alt+I global hotkey
  globalShortcut.register("Shift+Alt+I", () => toggleWindow());

  try {
    await waitForServer();
  } catch (e) {
    console.error("[api-dash] Could not connect to server:", e.message);
  }

  createWindow();
});

app.on("window-all-closed", (e) => {
  // Keep running in tray — don't quit when window closes
  e.preventDefault();
});

app.on("activate", () => {
  // macOS: re-open window when dock icon clicked
  if (!win) createWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (server) server.kill();
});
