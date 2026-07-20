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
const LINUX_AUTOSTART_FILE = "cliproxy-quota-tray.desktop";
// Visible teal circle on transparent background — the previous icon was nearly empty and invisible in Linux trays.
const TRAY_ICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdklEQVR42mNgGEqAT1D8PzF4QCyliWPQDZM8XEsUpoojyLEYn0PobjnZjqCWxbgcQjefkxwStLScKEfQ2nKCUTGgDqCX5TgdMeqAUQeMOmDUAQPugNG6YFBUxwPeIBkUTbJB0SgdFM3yQdExGRRds0HROaU1AAD4ivoQD2u6mAAAAABJRU5ErkJggg==";

let tray = null;
let mainWindow = null;
let isPinned = false;
let isQuitting = false;
let collectorStopRequested = false;
let dashboardServer = null;
let ignoreBlurUntil = 0;
let initialShowPending = !isStartupLaunch && (process.env.CLIPROXY_TRAY_SHOW === "1" || process.argv.includes("--show"));

app.setName("CLIProxy Quota Tray");

// Linux: prefer native Wayland in Wayland sessions. Keep GPU on by default there —
// disable-gpu produced "visible=true" windows that never appeared on screen.
if (process.platform === "linux") {
  const sessionWayland = process.env.XDG_SESSION_TYPE === "wayland";
  const ozoneHint = String(process.env.ELECTRON_OZONE_PLATFORM_HINT || process.env.OZONE_PLATFORM || "").toLowerCase();
  const wantGpu = process.env.CLIPROXY_TRAY_GPU === "1" || (process.env.CLIPROXY_TRAY_GPU !== "0" && sessionWayland && ozoneHint !== "x11");
  if (!wantGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
  }
  if (ozoneHint === "x11") {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
    app.commandLine.appendSwitch("ozone-platform", "x11");
  } else if (ozoneHint === "wayland" || (!ozoneHint && sessionWayland)) {
    app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
    app.commandLine.appendSwitch("ozone-platform", "wayland");
    // Mutter + Electron can break when Vulkan is selected under Wayland.
    app.commandLine.appendSwitch("disable-features", "Vulkan");
    app.commandLine.appendSwitch("use-angle", "gl");
  }
}

function runtimeLogPath() {
  try {
    return path.join(app.getPath("userData"), "electron-runtime.log");
  } catch {
    return path.join(__dirname, "..", "electron-runtime.log");
  }
}

function appendRuntimeLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(runtimeLogPath(), line, "utf8");
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

function quoteDesktopExec(value) {
  // Desktop Entry Exec keys need quoting when paths contain spaces.
  if (/[\s"\\]/.test(value)) {
    return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return String(value);
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

function linuxAutostartPath() {
  return path.join(app.getPath("home"), ".config", "autostart", LINUX_AUTOSTART_FILE);
}

function buildLinuxAutostartDesktop() {
  const execParts = app.isPackaged
    ? [quoteDesktopExec(process.execPath), "--startup"]
    : [quoteDesktopExec(process.execPath), quoteDesktopExec(app.getAppPath()), "--dist", "--startup"];

  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=CLIProxy Quota Tray",
    "Comment=CLIProxyAPI OAuth quota tray dashboard",
    `Exec=${execParts.join(" ")}`,
    "Terminal=false",
    "Categories=Utility;Network;",
    "X-GNOME-Autostart-enabled=true",
    "StartupNotify=false",
    "X-GNOME-UsesNotifications=false"
  ].join("\n") + "\n";
}

function ensureLinuxAutoStart() {
  const desktopPath = linuxAutostartPath();
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(desktopPath, buildLinuxAutostartDesktop(), "utf8");
  appendRuntimeLog(`[startup] linux-autostart=${desktopPath}`);
  // Do NOT call app.setLoginItemSettings on Linux: the FreeDesktop portal can
  // block the Electron main process and freeze the tray UI on GNOME/Zorin.
}

function ensureAutoStart() {
  if (process.platform === "linux") {
    try {
      ensureLinuxAutoStart();
    } catch (error) {
      appendRuntimeLog(`[startup-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

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
  // Linux status indicators look better closer to the source 32px asset; Windows tray prefers 16px.
  const size = process.platform === "linux" ? 24 : 16;
  return image.resize({ width: size, height: size });
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

function clampWindowSize(workArea) {
  const marginX = Math.min(WINDOW_MARGIN, Math.max(0, Math.floor((workArea.width - 1) / 2)));
  const marginY = Math.min(WINDOW_MARGIN, Math.max(0, Math.floor((workArea.height - 1) / 2)));
  const width = Math.max(1, Math.min(WINDOW_SIZE.width, workArea.width - marginX * 2));
  const height = Math.max(1, Math.min(WINDOW_SIZE.height, workArea.height - marginY * 2));
  return { width, height, marginX, marginY };
}

function positionWindow() {
  const window = getMainWindow();
  if (!window) return;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const { width, height, marginX, marginY } = clampWindowSize(workArea);

  // Linux: center on the active work area. Bottom-right popover positioning is unreliable
  // under XWayland / multi-monitor setups and often places the window off-screen.
  if (process.platform === "linux") {
    const x = workArea.x + Math.max(marginX, Math.floor((workArea.width - width) / 2));
    const y = workArea.y + Math.max(marginY, Math.floor((workArea.height - height) / 2));
    window.setBounds({ width, height, x, y });
    appendRuntimeLog(`[position] linux center bounds=${JSON.stringify(window.getBounds())} workArea=${JSON.stringify(workArea)}`);
    return;
  }

  let x = workArea.x + workArea.width - width - marginX;
  let y = workArea.y + workArea.height - height - marginY;

  // Prefer anchoring near the tray icon when the desktop reports real bounds
  // (common on Windows; often empty/zero under Linux AppIndicator).
  try {
    const trayBounds = tray?.getBounds?.();
    if (trayBounds && trayBounds.width > 0 && trayBounds.height > 0) {
      const trayDisplay = screen.getDisplayNearestPoint({
        x: trayBounds.x + Math.floor(trayBounds.width / 2),
        y: trayBounds.y + Math.floor(trayBounds.height / 2)
      });
      const area = trayDisplay.workArea;
      const sized = clampWindowSize(area);
      const centerX = trayBounds.x + Math.floor(trayBounds.width / 2);
      x = Math.min(
        Math.max(area.x + sized.marginX, centerX - Math.floor(sized.width / 2)),
        area.x + area.width - sized.width - sized.marginX
      );
      const preferBelow = trayBounds.y < area.y + area.height / 2;
      y = preferBelow
        ? Math.min(trayBounds.y + trayBounds.height + 4, area.y + area.height - sized.height - sized.marginY)
        : Math.max(area.y + sized.marginY, trayBounds.y - sized.height - 4);
      window.setBounds({ width: sized.width, height: sized.height, x, y });
      return;
    }
  } catch (error) {
    appendRuntimeLog(`[tray-bounds-error] ${error instanceof Error ? error.message : String(error)}`);
  }

  window.setBounds({ width, height, x, y });
}

function showWindow() {
  if (!app.isReady()) {
    initialShowPending = true;
    return null;
  }
  initialShowPending = false;
  // Tray activation often steals focus briefly; ignore the resulting blur so the popover stays open.
  ignoreBlurUntil = Date.now() + (process.platform === "linux" ? 5000 : 400);
  const window = getMainWindow() || createWindow();
  if (!window || window.isDestroyed()) return;
  positionWindow();
  if (window.isMinimized()) window.restore();
  // On Linux keep the window pinned while opening so blur-to-hide cannot eat the first show.
  if (process.platform === "linux") {
    window.show();
    window.setAlwaysOnTop(true);
    window.focus();
    setTimeout(() => {
      if (!window.isDestroyed() && !isPinned) window.setAlwaysOnTop(false);
    }, 1500);
    appendRuntimeLog(`[show] visible=${window.isVisible()} focused=${window.isFocused()} bounds=${JSON.stringify(window.getBounds())}`);
    return;
  }
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

function setPinnedState(nextPinned) {
  isPinned = Boolean(nextPinned);
  const window = getMainWindow();
  if (window) {
    // "floating" is the most portable always-on-top level across Win/Linux.
    window.setAlwaysOnTop(isPinned, "floating");
  }
  sendPinChange();
  refreshTrayMenu();
  return isPinned;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showWindow },
    {
      label: "Hide Dashboard",
      click: () => getMainWindow()?.hide()
    },
    {
      label: isPinned ? "Unpin Window" : "Pin Window",
      click: () => setPinnedState(!isPinned)
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
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed?.()) return;
  // Linux AppIndicator requires setContextMenu; menu label changes only apply after calling it again.
  if (process.platform === "linux") {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createWindow() {
  const existingWindow = getMainWindow();
  if (existingWindow) return existingWindow;

  const isLinux = process.platform === "linux";
  const window = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: "CLIProxy Quota Tray",
    // Frameless popovers are easy to lose under Wayland/XWayland; use a normal frame on Linux.
    frame: isLinux,
    transparent: false,
    resizable: isLinux,
    maximizable: false,
    minimizable: isLinux,
    skipTaskbar: !isLinux,
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

  window.once("ready-to-show", () => {
    sendPinChange();
    if (initialShowPending || isLinux) showWindow();
  });
  window.webContents.once("did-finish-load", () => {
    sendPinChange();
    // Fallback if ready-to-show never fires on some Linux builds.
    if ((initialShowPending || isLinux) && !window.isVisible()) showWindow();
  });

  window.on("blur", () => {
    // Linux: never auto-hide on blur. Focus events are unreliable with AppIndicator/XWayland
    // and were making the dashboard appear for a blink then vanish permanently.
    if (process.platform === "linux") return;
    if (Date.now() < ignoreBlurUntil) return;
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

  if (process.platform === "linux") {
    // AppIndicator/StatusNotifierItem often ignores click/right-click handlers.
    // setContextMenu is the reliable activation path on GNOME/Zorin/KDE.
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", toggleWindow);
  } else {
    tray.on("click", toggleWindow);
    tray.on("right-click", () => {
      tray.popUpContextMenu(buildTrayMenu());
    });
  }
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
  handleTrusted("window:pin", (_event, nextPinned) => setPinnedState(nextPinned));
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
    // Explicit show after tray exists — did-finish-load alone was racing on Linux.
    if (initialShowPending || process.platform === "linux") {
      setTimeout(() => {
        try {
          showWindow();
          appendRuntimeLog("[startup] forced showWindow after ready");
        } catch (error) {
          appendRuntimeLog(`[startup-show-error] ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 300);
    }

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
