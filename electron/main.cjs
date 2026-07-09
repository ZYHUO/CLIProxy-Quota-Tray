const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createDashboardServer } = require("./server.cjs");

const forceLoadDist = process.env.CLIPROXY_TRAY_LOAD_DIST === "1" || process.argv.includes("--dist");
const isStartupLaunch = process.argv.includes("--startup") || process.argv.includes("--hidden") || process.argv.includes("--autostart");
const isDev = !app.isPackaged && !forceLoadDist;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const WINDOW_SIZE = { width: 860, height: 660 };
const WINDOW_MARGIN = 12;
const MAX_STORED_EVENTS = 20000;
const MAX_RETURNED_EVENTS = 5000;
const FETCH_TIMEOUT_MS = 15000;
const AUTOSTART_NAME = "CLIProxy Quota Tray";
const TRAY_ICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbklEQVR42mNgwAK+/Pj/nxaYAR+glaVEOYbelmM4YlA54NiV1zTFGA5AdxW6ImpibGaPOoDqDhCVN0DBow4Yvg7Q3z8RBY86YNQBw9cB/j3fUfCoA0YdMOqAQVMODJ8m2YA3y0d7RoOiczqQ3XMAipnTBBuakRwAAAAASUVORK5CYII=";

let tray = null;
let mainWindow = null;
let isPinned = false;
let dashboardServer = null;
const shouldShowOnStart = !isStartupLaunch && (process.env.CLIPROXY_TRAY_SHOW === "1" || process.argv.includes("--show"));

app.setName("CLIProxy Quota Tray");

const defaultSettings = {
  baseUrl: "http://127.0.0.1:8317/v0/management",
  managementKey: "",
  pollIntervalSec: 1200,
  usageQueueBatchSize: 200,
  quotas: {
    openai: { fiveHourTokens: 400000000, weeklyTokens: 3000000000, costPerMTok: 7.5, label: "" },
    anthropic: { fiveHourTokens: 320000000, weeklyTokens: 2500000000, costPerMTok: 9.0, label: "" },
    google: { fiveHourTokens: 800000000, weeklyTokens: 5000000000, costPerMTok: 1.5, label: "" },
    xai: { fiveHourTokens: 250000000, weeklyTokens: 1800000000, costPerMTok: 4.0, label: "" },
    misc: { fiveHourTokens: 100000000, weeklyTokens: 700000000, costPerMTok: 3.0, label: "" }
  }
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getStoreDir() {
  const dir = path.join(app.getPath("userData"), "quota-monitor");
  ensureDir(dir);
  return dir;
}

function getSettingsPath() {
  return path.join(getStoreDir(), "settings.json");
}

function getUsagePath() {
  return path.join(getStoreDir(), "usage-events.jsonl");
}

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

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

function ensurePackagedAutoStartRegistry() {
  const command = `"${process.execPath}" --startup`;
  execFileSync("reg.exe", [
    "add",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v",
    AUTOSTART_NAME,
    "/t",
    "REG_SZ",
    "/d",
    command,
    "/f"
  ], { stdio: "ignore", windowsHide: true });
  appendRuntimeLog(`[startup] registry=${command}`);
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quotePwsh(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteVbs(value) {
  return `"""${String(value).replaceAll('"', '""')}"""`;
}

function ensurePackagedStartupShortcut() {
  const startupDir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  ensureDir(startupDir);
  const shortcutPath = path.join(startupDir, "CLIProxy Quota Tray.lnk");
  const workingDir = path.dirname(process.execPath);
  const psCommand = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${quotePwsh(shortcutPath)})`,
    `$shortcut.TargetPath = ${quotePwsh(process.execPath)}`,
    "$shortcut.Arguments = '--startup'",
    `$shortcut.WorkingDirectory = ${quotePwsh(workingDir)}`,
    `$shortcut.IconLocation = ${quotePwsh(`${process.execPath},0`)}`,
    "$shortcut.Save()"
  ].join("; ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encodedCommand
  ], { stdio: "ignore", windowsHide: true });
  appendRuntimeLog(`[startup] shortcut=${shortcutPath}`);
}

function ensureDevAutoStartScript() {
  const startupDir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  ensureDir(startupDir);

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

function ensureAutoStart() {
  if (process.platform !== "win32") return;
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings(autoStartOptions());
      const current = app.getLoginItemSettings(autoStartOptions());
      appendRuntimeLog(`[startup] openAtLogin=${current.openAtLogin}`);
    } catch (error) {
      appendRuntimeLog(`[startup-login-item-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      ensurePackagedAutoStartRegistry();
    } catch (error) {
      appendRuntimeLog(`[startup-registry-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      ensurePackagedStartupShortcut();
    } catch (error) {
      appendRuntimeLog(`[startup-shortcut-error] ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  try {
    ensureDevAutoStartScript();
  } catch (error) {
    appendRuntimeLog(`[startup-error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readSettings() {
  const saved = readJSON(getSettingsPath(), {});
  const merged = {
    ...defaultSettings,
    ...saved,
    quotas: {
      ...defaultSettings.quotas,
      ...(saved.quotas || {})
    }
  };
  const pollIntervalSec = Number(merged.pollIntervalSec);
  if (!Number.isFinite(pollIntervalSec) || pollIntervalSec < 1200) {
    merged.pollIntervalSec = 1200;
  }
  return {
    ...merged,
    baseUrl: normalizeManagementBaseUrl(merged)
  };
}

function writeSettings(settings) {
  const current = readSettings();
  const incoming = { ...settings };
  if (incoming.managementKey === "configured") {
    incoming.managementKey = current.managementKey;
  }
  const merged = {
    ...current,
    ...incoming,
    baseUrl: normalizeManagementBaseUrl({ baseUrl: incoming.baseUrl || current.baseUrl }),
    quotas: {
      ...current.quotas,
      ...(incoming.quotas || {})
    }
  };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function readUsageEvents(limit = MAX_RETURNED_EVENTS) {
  const filePath = getUsagePath();
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function writeUsageEvents(events) {
  const trimmed = events.slice(-MAX_STORED_EVENTS);
  fs.writeFileSync(getUsagePath(), trimmed.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function hashObject(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function normalizeProvider(value = "") {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("openai") || raw.includes("chatgpt") || raw.includes("codex")) return "openai";
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("google") || raw.includes("gemini") || raw.includes("antigravity")) return "google";
  if (raw.includes("grok") || raw.includes("xai") || raw.includes("x.ai")) return "xai";
  return "misc";
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function normalizeUsageRecord(record) {
  const body = record?.body || record?.usage || record?.data || record;
  const provider = normalizeProvider(
    body?.provider || body?.service || body?.platform || body?.auth_provider || body?.model || body?.path
  );
  const model = body?.model || body?.model_name || body?.deployment || "unknown-model";
  const timestamp = body?.timestamp || body?.created_at || body?.time || body?.created || Date.now();
  const createdAt = typeof timestamp === "number"
    ? new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000).toISOString()
    : new Date(timestamp).toISOString();
  const inputTokens = firstNumber(body?.input_tokens, body?.prompt_tokens, body?.promptTokens, body?.usage?.input_tokens, body?.tokens?.input_tokens);
  const outputTokens = firstNumber(body?.output_tokens, body?.completion_tokens, body?.completionTokens, body?.usage?.output_tokens, body?.tokens?.output_tokens);
  const totalTokens = firstNumber(body?.total_tokens, body?.totalTokens, body?.usage?.total_tokens, body?.tokens?.total_tokens, inputTokens + outputTokens);
  const authId = String(body?.auth_id || body?.auth_index || body?.auth_file || body?.authFile || body?.account || body?.email || body?.oauth_id || "default");
  const status = Number(body?.status || body?.status_code || body?.response_status || 200);
  const success = status < 400 && body?.error == null && body?.failed !== true;

  const normalized = {
    id: String(body?.id || body?.request_id || body?.uuid || hashObject({ createdAt, provider, model, authId, totalTokens, status })),
    createdAt,
    provider,
    model: String(model),
    authId,
    inputTokens,
    outputTokens,
    totalTokens,
    status,
    success
  };
  return normalized;
}

function appendUsageRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { added: 0, events: readUsageEvents() };
  }

  const existing = readUsageEvents(MAX_STORED_EVENTS);
  const seen = new Set(existing.map((event) => event.id));
  const incoming = records.map(normalizeUsageRecord).filter((event) => event.totalTokens > 0 || event.model !== "unknown-model");
  const additions = [];

  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    additions.push(event);
  }

  if (additions.length > 0) {
    const next = [...existing, ...additions].slice(-MAX_STORED_EVENTS);
    writeUsageEvents(next);
    return { added: additions.length, events: next.slice(-MAX_RETURNED_EVENTS) };
  }

  return { added: 0, events: existing.slice(-MAX_RETURNED_EVENTS) };
}

function authHeaders(settings) {
  const headers = { "content-type": "application/json" };
  if (settings.managementKey) {
    headers.authorization = `Bearer ${settings.managementKey}`;
    headers["x-management-key"] = settings.managementKey;
    headers["x-api-key"] = settings.managementKey;
  }
  return headers;
}

function normalizeManagementBaseUrl(settings) {
  let input = String(settings.baseUrl || defaultSettings.baseUrl).trim() || defaultSettings.baseUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = `http://${input}`;
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    url = new URL(defaultSettings.baseUrl);
  }

  url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!url.pathname.endsWith("/v0/management") && !url.pathname.endsWith("/management")) {
    url.pathname = `${url.pathname}/v0/management`.replace(/\/+/g, "/");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function managementBaseUrl(settings) {
  return normalizeManagementBaseUrl(settings);
}

async function fetchManagement(pathname, settings, init = {}) {
  const baseUrl = managementBaseUrl(settings);
  const url = `${baseUrl}${pathname}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...authHeaders(settings),
        ...(init.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${pathname}: request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
  }

  if (!response.ok) {
    const message = json?.message || json?.error || text || `HTTP ${response.status}`;
    throw new Error(`${pathname}: ${message}`);
  }

  return json;
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "records", "usage", "auth_files", "authFiles", "auth-files", "files", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function collectSnapshot() {
  const settings = readSettings();
  const startedAt = new Date().toISOString();
  const result = {
    settings: { ...settings, managementKey: settings.managementKey ? "configured" : "" },
    storeDir: getStoreDir(),
    lastUpdated: startedAt,
    connected: false,
    error: null,
    queueAdded: 0,
    authFiles: [],
    usageEvents: readUsageEvents(),
    usageStatisticsEnabled: null
  };

  if (!settings.managementKey) {
    result.error = "Management key is not configured.";
    return result;
  }

  try {
    const [authFilesPayload, enabledPayload, usagePayload] = await Promise.allSettled([
      fetchManagement("/auth-files", settings),
      fetchManagement("/usage-statistics-enabled", settings),
      fetchManagement(`/usage-queue?count=${encodeURIComponent(settings.usageQueueBatchSize || 200)}`, settings)
    ]);

    if (authFilesPayload.status === "fulfilled") {
      result.authFiles = extractArray(authFilesPayload.value);
    }

    if (enabledPayload.status === "fulfilled") {
      result.usageStatisticsEnabled = enabledPayload.value?.["usage-statistics-enabled"] ?? enabledPayload.value?.enabled ?? enabledPayload.value?.value ?? enabledPayload.value;
    }

    if (usagePayload.status === "fulfilled") {
      const usageRecords = extractArray(usagePayload.value);
      const appended = appendUsageRecords(usageRecords);
      result.queueAdded = appended.added;
      result.usageEvents = appended.events;
    } else if (usagePayload.reason) {
      result.error = usagePayload.reason.message;
    }

    if (authFilesPayload.status === "rejected" && usagePayload.status === "rejected") {
      throw authFilesPayload.reason;
    }

    result.connected = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

async function enableUsageStatistics() {
  const settings = readSettings();
  await fetchManagement("/usage-statistics-enabled", settings, {
    method: "PUT",
    body: JSON.stringify({ value: true })
  });
  return collectSnapshot();
}

function createTrayIcon() {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  return image.resize({ width: 16, height: 16 });
}

function positionWindow() {
  if (!mainWindow) return;
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { workArea } = display;
  const width = Math.min(WINDOW_SIZE.width, Math.max(720, workArea.width - WINDOW_MARGIN * 2));
  const height = Math.min(WINDOW_SIZE.height, Math.max(560, workArea.height - WINDOW_MARGIN * 2));
  const minX = workArea.x + WINDOW_MARGIN;
  const minY = workArea.y + WINDOW_MARGIN;
  const maxX = workArea.x + workArea.width - width - WINDOW_MARGIN;
  const maxY = workArea.y + workArea.height - height - WINDOW_MARGIN;
  const x = Math.max(minX, maxX);
  const y = Math.max(minY, maxY);
  mainWindow.setBounds({ width, height, x, y });
}

function showWindow() {
  if (!mainWindow) createWindow();
  positionWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
    return;
  }
  showWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: "CLIProxy Quota Tray",
    frame: false,
    transparent: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    icon: createTrayIcon(),
    backgroundColor: "#0e1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL).catch((error) => console.error("Failed to load dev URL:", error));
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html")).catch((error) => console.error("Failed to load dist:", error));
  }

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) appendRuntimeLog(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendRuntimeLog(`[renderer-gone] ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    appendRuntimeLog(`[load-failed] ${code} ${description} ${url}`);
  });

  mainWindow.webContents.once("did-finish-load", () => {
    if (shouldShowOnStart) showWindow();
  });

  mainWindow.on("blur", () => {
    if (!isPinned) mainWindow.hide();
  });
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
          mainWindow?.setAlwaysOnTop(isPinned, "floating");
          if (mainWindow) mainWindow.webContents.send("pin-change", isPinned);
        }
      },
      { type: "separator" },
      { label: "Open Data Folder", click: () => shell.openPath(dashboardServer?.getStoreDir?.() || getStoreDir()) },
      { label: "Quit", click: () => app.quit() }
    ]));
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
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
    await dashboardServer.start();
    createWindow();
    createTray();

    ipcMain.handle("snapshot", (_event, options = {}) => dashboardServer.collectSnapshot(options));
    ipcMain.handle("settings:read", () => {
      return dashboardServer.getPublicSettings();
    });
    ipcMain.handle("settings:save", (_event, settings) => dashboardServer.writeSettings(settings));
    ipcMain.handle("usage:clear", () => {
      return dashboardServer.clearUsage();
    });
    ipcMain.handle("usage:enable", () => dashboardServer.enableUsageStatistics());
    ipcMain.handle("window:hide", () => mainWindow?.hide());
    ipcMain.handle("window:pin", (_event, nextPinned) => {
      isPinned = Boolean(nextPinned);
      mainWindow?.setAlwaysOnTop(isPinned, "floating");
      mainWindow?.webContents.send("pin-change", isPinned);
      return isPinned;
    });
    ipcMain.handle("external:open", (_event, url) => shell.openExternal(url));
    ipcMain.handle("server:info", () => dashboardServer?.getInfo?.() || null);

    if (shouldShowOnStart) {
      setTimeout(showWindow, 700);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      showWindow();
    });
  });

  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
}
