const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createDashboardServer } = require("./server.cjs");

const forceLoadDist = process.env.CLIPROXY_TRAY_LOAD_DIST === "1" || process.argv.includes("--dist");
const isStartupLaunch = process.argv.includes("--startup") || process.argv.includes("--hidden") || process.argv.includes("--autostart");
const isDev = !app.isPackaged && !forceLoadDist;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const APP_ENTRY_PATH = path.resolve(__dirname, "..", "dist", "index.html");
const WINDOW_SIZE = { width: 860, height: 660 };
const WINDOW_MARGIN = 12;
const TRAY_ICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbklEQVR42mNgwAK+/Pj/nxaYAR+glaVEOYbelmM4YlA54NiV1zTFGA5AdxW6ImpibGaPOoDqDhCVN0DBow4Yvg7Q3z8RBY86YNQBw9cB/j3fUfCoA0YdMOqAQVMODJ8m2YA3y0d7RoOiczqQ3XMAipnTBBuakRwAAAAASUVORK5CYII=";

let tray = null;
let mainWindow = null;
let isPinned = false;
let isQuitting = false;
let collectorStopRequested = false;
let dashboardServer = null;
let initialShowPending = !isStartupLaunch && (process.env.CLIPROXY_TRAY_SHOW === "1" || process.argv.includes("--show"));

app.setName("CLIProxy Quota Tray");

function appendRuntimeLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(__dirname, "..", "electron-runtime.log"), line, "utf8");
  } catch {
    // Runtime logging must never break the tray process.
  }
}

function hasLaunchArg(commandLine = [], arg) {
  return commandLine.some((item) => String(item || "").toLowerCase() === arg);
}

function autoStartOptions() {
  if (app.isPackaged) {
    return {
      openAtLogin: true,
      openAsHidden: true,
      path: process.execPath,
      args: ["--startup"],
      name: app.getName()
    };
  }

  return {
    openAtLogin: true,
    path: process.execPath,
    args: [app.getAppPath(), "--dist", "--startup"],
    name: app.getName()
  };
}

function quotePwsh(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteVbs(value) {
  return `"""${String(value).replaceAll('"', '""')}"""`;
}

function ensureDevAutoStartScript() {
  const startupDir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  fs.mkdirSync(startupDir, { recursive: true });

  const cmdPath = path.join(startupDir, "CLIProxy Quota Tray.cmd");
  const vbsPath = path.join(startupDir, "CLIProxy Quota Tray.vbs");
  const appPath = app.getAppPath();
  const electronPath = process.execPath;
  const psCommand = [
    `$project = ${quotePwsh(appPath)}`,
    `$electron = ${quotePwsh(electronPath)}`,
    '$existing = Get-CimInstance Win32_Process -Filter "name = \'electron.exe\'" | Where-Object { $_.CommandLine -like "*$project*" -and $_.CommandLine -notmatch "--type=" }',
    'if (-not $existing) { Start-Process -FilePath $electron -ArgumentList @($project, "--dist", "--startup") -WorkingDirectory $project -WindowStyle Hidden }'
  ].join("; ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");

  const cmdContent = [
    "@echo off",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodedCommand}`
  ].join("\r\n") + "\r\n";

  const vbsContent = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${quoteVbs(cmdPath)}, 0, False`
  ].join("\r\n") + "\r\n";

  fs.writeFileSync(cmdPath, cmdContent, "utf8");
  fs.writeFileSync(vbsPath, vbsContent, "utf8");
  appendRuntimeLog(`[startup] script=${vbsPath}`);
}

function removeLegacyPackagedStartupShortcut() {
  const shortcutPath = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "CLIProxy Quota Tray.lnk"
  );
  try {
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath);
      appendRuntimeLog(`[startup] removed legacy shortcut=${shortcutPath}`);
    }
  } catch (error) {
    appendRuntimeLog(`[startup-shortcut-cleanup-error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureAutoStart() {
  if (process.platform !== "win32") return;
  if (app.isPackaged) {
    // Electron's login-item API is the single source of truth for packaged builds.
    // Remove the shortcut created by older releases so upgrades do not launch twice.
    removeLegacyPackagedStartupShortcut();
    try {
      const options = autoStartOptions();
      app.setLoginItemSettings(options);
      const current = app.getLoginItemSettings(options);
      appendRuntimeLog(`[startup] openAtLogin=${current.openAtLogin}`);
    } catch (error) {
      appendRuntimeLog(`[startup-login-item-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  try {
    ensureDevAutoStartScript();
  } catch (error) {
    appendRuntimeLog(`[startup-error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createTrayIcon() {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  return image.resize({ width: 16, height: 16 });
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function normalizeLocalPath(filePath) {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isAllowedRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return normalizeLocalPath(fileURLToPath(url)) === normalizeLocalPath(APP_ENTRY_PATH);
    }

    if (!isDev) return false;
    const devUrl = new URL(DEV_URL);
    const normalizePathname = (value) => value === "/" ? value : value.replace(/\/+$/, "");
    return url.origin === devUrl.origin && normalizePathname(url.pathname) === normalizePathname(devUrl.pathname);
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event) {
  const window = getMainWindow();
  if (!window || event.sender !== window.webContents) return false;
  const senderFrame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!senderFrame || !mainFrame) return false;
  if (senderFrame.processId !== mainFrame.processId || senderFrame.routingId !== mainFrame.routingId) return false;
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  return isAllowedRendererUrl(senderUrl);
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      appendRuntimeLog(`[ipc-denied] ${channel}`);
      throw new Error("Unauthorized IPC sender");
    }
    return handler(event, ...args);
  });
}

function positionWindow() {
  const window = getMainWindow();
  if (!window) return;

  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const marginX = Math.min(WINDOW_MARGIN, Math.max(0, Math.floor((workArea.width - 1) / 2)));
  const marginY = Math.min(WINDOW_MARGIN, Math.max(0, Math.floor((workArea.height - 1) / 2)));
  const width = Math.max(1, Math.min(WINDOW_SIZE.width, workArea.width - marginX * 2));
  const height = Math.max(1, Math.min(WINDOW_SIZE.height, workArea.height - marginY * 2));
  const x = workArea.x + workArea.width - width - marginX;
  const y = workArea.y + workArea.height - height - marginY;
  window.setBounds({ width, height, x, y });
}

function showWindow() {
  if (!app.isReady()) {
    initialShowPending = true;
    return null;
  }
  initialShowPending = false;
  const window = getMainWindow() || createWindow();
  if (!window || window.isDestroyed()) return;
  positionWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  window.focus();
}

function toggleWindow() {
  const window = getMainWindow();
  if (window?.isVisible()) {
    window.hide();
    return;
  }
  showWindow();
}

function sendPinChange() {
  const window = getMainWindow();
  if (!window || window.webContents.isDestroyed()) return;
  window.webContents.send("pin-change", isPinned);
}

function createWindow() {
  const existingWindow = getMainWindow();
  if (existingWindow) return existingWindow;

  const window = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: "CLIProxy Quota Tray",
    frame: false,
    transparent: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: isPinned,
    icon: createTrayIcon(),
    backgroundColor: "#0e1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  mainWindow = window;
  positionWindow();

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (details) => {
    if (!isAllowedRendererUrl(details.url)) details.preventDefault();
  });
  window.webContents.on("will-redirect", (details) => {
    if (!isAllowedRendererUrl(details.url)) details.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  if (isDev) {
    window.loadURL(DEV_URL).catch((error) => console.error("Failed to load dev URL:", error));
  } else {
    window.loadFile(APP_ENTRY_PATH).catch((error) => console.error("Failed to load dist:", error));
  }

  window.webContents.on("console-message", (details) => {
    const level = details.level;
    if (level === "warning" || level === "error" || (typeof level === "number" && level >= 2)) {
      appendRuntimeLog(`[renderer] ${details.message || ""} (${details.sourceId || "unknown"}:${details.lineNumber || 0})`);
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    appendRuntimeLog(`[renderer-gone] ${JSON.stringify(details)}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    appendRuntimeLog(`[load-failed] ${code} ${description} ${url}`);
  });

  window.webContents.once("did-finish-load", () => {
    sendPinChange();
    if (initialShowPending) showWindow();
  });

  window.on("blur", () => {
    if (!isPinned && !window.isDestroyed()) window.hide();
  });
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (!window.isDestroyed()) window.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("CLIProxy Quota Monitor");
  tray.on("click", toggleWindow);
  tray.on("right-click", () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: "Open Dashboard", click: showWindow },
      {
        label: isPinned ? "Unpin Window" : "Pin Window",
        click: () => {
          isPinned = !isPinned;
          const window = getMainWindow();
          if (window) window.setAlwaysOnTop(isPinned, "floating");
          sendPinChange();
        }
      },
      { type: "separator" },
      {
        label: "Open Data Folder",
        click: () => {
          const storeDir = dashboardServer?.getStoreDir?.() || path.join(app.getPath("userData"), "quota-monitor");
          shell.openPath(storeDir).catch((error) => appendRuntimeLog(`[open-data-folder-error] ${error.message}`));
        }
      },
      { label: "Quit", click: () => app.quit() }
    ]));
  });
}

function registerIpcHandlers() {
  handleTrusted("snapshot", (_event, options = {}) => {
    return dashboardServer.collectSnapshot({ forceQuotaRefresh: options?.forceQuotaRefresh === true });
  });
  handleTrusted("settings:read", () => dashboardServer.getPublicSettings());
  handleTrusted("settings:save", (_event, settings) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new TypeError("Settings must be an object");
    }
    dashboardServer.writeSettings(settings);
    return dashboardServer.getPublicSettings();
  });
  handleTrusted("usage:clear", () => dashboardServer.clearUsage());
  handleTrusted("usage:enable", () => dashboardServer.enableUsageStatistics());
  handleTrusted("window:hide", () => {
    getMainWindow()?.hide();
  });
  handleTrusted("window:pin", (_event, nextPinned) => {
    isPinned = Boolean(nextPinned);
    const window = getMainWindow();
    if (window) window.setAlwaysOnTop(isPinned, "floating");
    sendPinChange();
    return isPinned;
  });
}

function stopUsageCollectorBeforeQuit(event) {
  isQuitting = true;
  if (collectorStopRequested || !dashboardServer?.stopUsageCollector) return;
  collectorStopRequested = true;

  try {
    const pendingStop = dashboardServer.stopUsageCollector();
    if (pendingStop && typeof pendingStop.then === "function") {
      event.preventDefault();
      Promise.resolve(pendingStop)
        .catch((error) => appendRuntimeLog(`[usage-collector-stop-error] ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => app.quit());
    }
  } catch (error) {
    appendRuntimeLog(`[usage-collector-stop-error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("before-quit", stopUsageCollectorBeforeQuit);

  app.on("second-instance", (_event, commandLine) => {
    if (hasLaunchArg(commandLine, "--startup") || hasLaunchArg(commandLine, "--hidden") || hasLaunchArg(commandLine, "--autostart")) {
      return;
    }
    showWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    ensureAutoStart();
    dashboardServer = createDashboardServer({ userDataPath: app.getPath("userData") });
    try {
      await dashboardServer.startUsageCollector();
    } catch (error) {
      appendRuntimeLog(`[usage-collector-start-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    registerIpcHandlers();
    createWindow();
    createTray();

    app.on("activate", () => {
      showWindow();
    });
  }).catch((error) => {
    appendRuntimeLog(`[startup-fatal] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    app.quit();
  });

  // Keeping a tray process alive when its hidden window is destroyed is intentional.
  app.on("window-all-closed", () => {});
}
