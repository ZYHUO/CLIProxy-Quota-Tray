import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  ChartColumn,
  ChevronDown,
  CircleCheck,
  CircleDollarSign,
  Gauge,
  Grid2x2,
  KeyRound,
  LoaderCircle,
  Moon,
  MousePointer2,
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sparkles,
  X,
  Zap
} from "lucide-react";

const HOUR_MS = 3600 * 1e3;
const DAY_MS = 24 * HOUR_MS;

const PROVIDER_META = {
  openai: {
    name: "ChatGPT",
    vendor: "Codex",
    service: "OpenAI",
    plan: "",
    icon: Bot,
    accent: "#19c37d",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  anthropic: {
    name: "Claude",
    vendor: "Claude Code",
    service: "Anthropic",
    plan: "",
    icon: Activity,
    accent: "#e8825e",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  google: {
    name: "Gemini",
    vendor: "Antigravity / Vertex",
    service: "Google",
    plan: "",
    icon: Sparkles,
    accent: "#6aa9ff",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  xai: {
    name: "Grok",
    vendor: "Grok Build",
    service: "xAI",
    plan: "",
    icon: Zap,
    accent: "#d7dce5",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  kimi: {
    name: "Kimi",
    vendor: "Moonshot",
    service: "Kimi",
    plan: "",
    icon: Moon,
    accent: "#7dd3fc",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  cursor: {
    name: "Cursor",
    vendor: "Cursor",
    service: "Cursor",
    plan: "",
    icon: MousePointer2,
    accent: "#94a3b8",
    low: "#fb7185",
    warn: "#fbbf24"
  },
  misc: {
    name: "Misc",
    vendor: "Other providers",
    service: "Misc",
    plan: "",
    icon: Grid2x2,
    accent: "#a78bfa",
    low: "#fb7185",
    warn: "#fbbf24"
  }
};

const DEFAULT_QUOTAS = {
  openai: { fiveHourTokens: 4e8, weeklyTokens: 3e9, costPerMTok: 7.5, label: "" },
  anthropic: { fiveHourTokens: 32e7, weeklyTokens: 25e8, costPerMTok: 9, label: "" },
  google: { fiveHourTokens: 8e8, weeklyTokens: 5e9, costPerMTok: 1.5, label: "" },
  xai: { fiveHourTokens: 25e7, weeklyTokens: 18e8, costPerMTok: 4, label: "" },
  kimi: { fiveHourTokens: 2e8, weeklyTokens: 15e8, costPerMTok: 2.5, label: "" },
  cursor: { fiveHourTokens: 1e8, weeklyTokens: 7e8, costPerMTok: 5, label: "" },
  misc: { fiveHourTokens: 1e8, weeklyTokens: 7e8, costPerMTok: 3, label: "" }
};

const PROVIDER_ORDER = ["openai", "anthropic", "google", "xai", "kimi", "cursor", "misc"];

// Plan strings that must never be shown (do not infer premium plans).
const HIDDEN_PLAN_LABELS = new Set(["google ai ultra", "supergrok heavy", "custom"]);

const WINDOW_SYNONYMS = {
  five_hour: ["five_hour", "five-hour", "5h", "5 hours", "five hours", "primary"],
  weekly: ["weekly", "week", "seven_day", "seven-day", "7d", "7 days", "secondary"],
  monthly: ["monthly", "month", "monthly_credits", "monthly credits", "billing month", "30d", "30 days", "included", "period"],
  daily: ["daily", "day", "24h", "24 hours"]
};

const WINDOW_ORDER = ["five_hour", "weekly", "monthly", "daily"];

function sanitizePlan(value) {
  const plan = String(value || "").trim();
  return !plan || HIDDEN_PLAN_LABELS.has(plan.toLowerCase()) ? "" : plan;
}

function providerBadge(provider) {
  return `${provider.auths.length} OAuth`;
}

function normalizeProvider(value = "") {
  const raw = String(value || "").toLowerCase();
  // Match CLIProxyAPI auth-files provider keys: codex, claude, antigravity, xai, kimi, cursor, vertex, gemini(-cli).
  if (raw.includes("openai") || raw.includes("chatgpt") || raw.includes("codex")) return "openai";
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("kimi") || raw.includes("moonshot")) return "kimi";
  if (raw.includes("cursor")) return "cursor";
  if (raw.includes("grok") || raw.includes("xai") || raw.includes("x.ai")) return "xai";
  if (
    raw.includes("google")
    || raw.includes("gemini")
    || raw.includes("antigravity")
    || raw.includes("vertex")
  ) return "google";
  return "misc";
}

function isApiKeyAccountType(value) {
  const raw = String(value || "").toLowerCase().replace(/[_-]/g, "");
  return raw === "apikey";
}

function isInsecureRemoteManagementUrl(value) {
  let input = String(value || "").trim();
  if (!input) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `http://${input}`;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return !(
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "127.0.0.1"
      || hostname.startsWith("127.")
      || hostname === "0.0.0.0"
      || hostname === "[::1]"
      || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function demoUsageEvents() {
  const now = Date.now();
  const providers = ["openai", "anthropic", "google", "xai", "kimi", "openai", "anthropic"];
  const models = {
    openai: ["gpt-5", "gpt-5.3-codex-spark", "gpt-oss-120b"],
    anthropic: ["Claude Sonnet 4.6", "Claude Opus 4.6", "Claude Code"],
    google: ["Gemini 3.5 Flash", "Gemini 3.1 Pro", "AntiGravity"],
    xai: ["Grok", "Grok Code"],
    kimi: ["kimi-k2.5", "kimi-k2"],
    misc: ["router-default"]
  };
  return Array.from({ length: 420 }, (_, index) => {
    const provider = providers[index % providers.length];
    const ageMs = Math.pow(index + 1, 1.05) * 25 * 60 * 1e3;
    const createdAt = new Date(now - ageMs).toISOString();
    const boost = index % 9 === 0 ? 3.2 : index % 13 === 0 ? 1.8 : 1;
    const totalTokens = Math.round((35e5 + (index % 17) * 31e4) * boost);
    return {
      id: `demo-${index}`,
      createdAt,
      provider,
      model: models[provider][index % models[provider].length],
      authId: `${provider}-oauth-${(index % 3) + 1}`,
      inputTokens: Math.round(totalTokens * 0.58),
      outputTokens: Math.round(totalTokens * 0.42),
      totalTokens,
      status: index % 31 === 0 ? 429 : 200,
      success: index % 31 !== 0
    };
  });
}

function demoAuthFiles() {
  return [
    { name: "codex-main.oauth.json", provider: "codex", accountType: "oauth", authIndex: 1, status: "degraded", email: "codex workspace" },
    { name: "claude-code-max.oauth.json", provider: "claude", accountType: "oauth", authIndex: 2, status: "degraded", email: "claude tag account" },
    { name: "antigravity.oauth.json", provider: "antigravity", accountType: "oauth", authIndex: 3, status: "up", email: "antigravity" },
    { name: "grok-main.oauth.json", provider: "xai", accountType: "oauth", authIndex: 4, status: "up", email: "xai build" },
    { name: "kimi-main.oauth.json", provider: "kimi", accountType: "oauth", authIndex: 5, status: "up", label: "Kimi User" },
    { name: "vertex-proj.json", provider: "vertex", accountType: "oauth", authIndex: 6, status: "up", email: "vertex sa" },
    { name: "claude-fable.oauth.json", provider: "claude", accountType: "oauth", authIndex: 7, status: "up", email: "fable" }
  ];
}

function demoSnapshot() {
  const now = Date.now();
  return {
    connected: false,
    demo: true,
    error: "Demo mode. Add your CLIProxyAPI management key to read real OAuth usage.",
    lastUpdated: new Date().toISOString(),
    queueAdded: 0,
    settings: {
      baseUrl: "http://127.0.0.1:8317/v0/management",
      managementKey: "",
      pollIntervalSec: 1200,
      usageQueueBatchSize: 200,
      cursorUsageEnabled: true,
      quotas: DEFAULT_QUOTAS
    },
    authFiles: demoAuthFiles(),
    apiKeyUsage: [],
    usageEvents: demoUsageEvents(),
    usageStatisticsEnabled: true,
    cursorUsage: {
      ok: true,
      membershipType: "pro",
      email: "you@example.com",
      billingCycleStart: new Date(now - 10 * DAY_MS).toISOString(),
      billingCycleEnd: new Date(now + 20 * DAY_MS).toISOString(),
      displayMessage: "Demo Cursor usage",
      autoMessage: "You've used 28% of your included total usage",
      apiMessage: "You've used 65% of your included API usage",
      plan: {
        limitUsd: 20,
        includedSpendUsd: 13,
        bonusSpendUsd: 4.2,
        totalSpendUsd: 17.2,
        remainingUsd: 7,
        remainingPercent: 35,
        usedPercent: 65,
        autoPercentUsed: 22,
        apiPercentUsed: 65,
        remainingBonus: true
      },
      onDemand: { limitType: "user" },
      fetchedAt: new Date().toISOString()
    },
    providerStatus: {
      openai: {
        provider: "openai",
        label: "Partial System Degradation",
        tone: "warn",
        componentCount: 12,
        degradedCount: 2,
        fetchedAt: new Date().toISOString(),
        components: [
          { name: "ChatGPT", status: "operational", tone: "good" },
          { name: "OpenAI API", status: "degraded_performance", tone: "warn" }
        ]
      },
      anthropic: {
        provider: "anthropic",
        label: "All Systems Operational",
        tone: "good",
        componentCount: 6,
        degradedCount: 0,
        fetchedAt: new Date().toISOString(),
        components: [
          { name: "claude.ai", status: "operational", tone: "good" },
          { name: "Claude API", status: "operational", tone: "good" }
        ]
      }
    }
  };
}

function normalizeEvent(event) {
  const provider = normalizeProvider(event.provider || event.model || event.authId);
  return {
    ...event,
    provider,
    createdAtMs: new Date(event.createdAt || Date.now()).getTime(),
    totalTokens: toNumber(
      event.totalTokens ?? event.total_tokens ?? event.usage?.total_tokens ?? event.tokens?.total_tokens
    ),
    inputTokens: toNumber(
      event.inputTokens ?? event.input_tokens ?? event.usage?.input_tokens ?? event.tokens?.input_tokens
    ),
    outputTokens: toNumber(
      event.outputTokens ?? event.output_tokens ?? event.usage?.output_tokens ?? event.tokens?.output_tokens
    ),
    success: event.success !== false && event.failed !== true
  };
}

function authName(auth) {
  return (
    auth.label ||
    auth.email ||
    auth.account ||
    auth.name ||
    auth.file ||
    auth.path ||
    auth.id ||
    auth.authIndex ||
    auth.auth_index ||
    "oauth account"
  );
}

function normalizeAuth(auth) {
  const provider = normalizeProvider(auth.provider || auth.service || auth.platform || authName(auth));
  const statusText = String(auth.status || auth.state || auth.health || "").toLowerCase();
  const degraded = statusText.includes("degrad") || statusText.includes("warn") || statusText.includes("limited");
  const down =
    statusText.includes("down") ||
    statusText.includes("error") ||
    statusText.includes("disabled") ||
    statusText.includes("expired") ||
    auth.enabled === false ||
    auth.available === false;
  const hasAccount =
    auth.hasAccount ??
    !!(auth.account || auth.email || auth.label || auth.raw?.account || auth.raw?.email);
  // CPA puts the provider key in `type`; account_type is the credential kind (oauth / api_key).
  const accountType = auth.accountType || auth.account_type || "oauth";
  return {
    provider,
    name: authName(auth),
    id: String(auth.id || auth.authIndex || auth.auth_index || authName(auth)),
    authIndex: auth.authIndex ?? auth.auth_index ?? auth.index ?? null,
    sourceProvider: auth.sourceProvider || auth.provider || "",
    accountType,
    hasAccount,
    status: down ? "down" : degraded ? "degraded" : "up",
    success: toNumber(auth.success),
    failed: toNumber(auth.failed),
    recentRequests: Array.isArray(auth.recentRequests)
      ? auth.recentRequests
      : Array.isArray(auth.recent_requests)
        ? auth.recent_requests
        : [],
    quota: auth.quota || { windows: [] },
    path: auth.path || "",
    raw: auth
  };
}

function normalizeApiKey(entry) {
  const name = entry.name || entry.baseUrl || entry.url || "compatible endpoint";
  const statusText = String(entry.status || "").toLowerCase();
  return {
    id: String(entry.id || name),
    type: "api-key",
    name,
    provider: "compatible",
    protocol: entry.protocol || entry.provider || "compatible",
    status: statusText.includes("down") || statusText.includes("error")
      ? "down"
      : statusText.includes("degrad")
        ? "degraded"
        : "up",
    success: toNumber(entry.success),
    failed: toNumber(entry.failed),
    label: entry.label || "",
    recentRequests: Array.isArray(entry.recentRequests)
      ? entry.recentRequests
      : Array.isArray(entry.recent_requests)
        ? entry.recent_requests
        : []
  };
}

function eventMatchesAuth(event, auth) {
  return [auth.authIndex, auth.id, auth.name, auth.raw?.email, auth.raw?.account, auth.raw?.id]
    .filter((value) => value != null)
    .map(String)
    .some((value) => String(event.authId || "") === value || String(event.authIndex || "") === value);
}

function usageWindow(events, spanMs, quotas, providerKey) {
  const now = Date.now();
  const inWindow = events.filter((event) => now - event.createdAtMs <= spanMs);
  const tokens = inWindow.reduce((sum, event) => sum + event.totalTokens, 0);
  const cost = inWindow.reduce((sum, event) => sum + eventCost({ ...event, provider: providerKey }, quotas), 0);
  const oldest = inWindow.length ? Math.min(...inWindow.map((event) => event.createdAtMs)) : now;
  const resetAt = oldest + spanMs;
  const elapsed = Math.max(1, now - oldest);
  return { events: inWindow, tokens, cost, resetAt, burnRate: tokens / elapsed };
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function windowMatches(window, names = []) {
  const candidates = [window?.id, window?.label, window?.name, window?.period, window?.type]
    .map(normalizeKey)
    .filter(Boolean);
  return names
    .map(normalizeKey)
    .filter(Boolean)
    .some((name) => candidates.some((candidate) => candidate === name || candidate.includes(name)));
}

function findWindow(windows, names = []) {
  return windows.find((window) => windowMatches(window, names));
}

function authWindow(auth, names = []) {
  const windows = Array.isArray(auth.quota?.windows) ? auth.quota.windows : [];
  return findWindow(windows, names);
}

function windowKind(window) {
  return WINDOW_ORDER.find((kind) => windowMatches(window, WINDOW_SYNONYMS[kind])) || "other";
}

function windowLabel(window) {
  const kind = windowKind(window);
  if (kind === "five_hour") return "5h limit";
  if (kind === "weekly") return "week limit";
  if (kind === "monthly") return "month limit";
  if (kind === "daily") return "day limit";
  const label = String(window?.label || window?.id || "quota").replace(/[_-]+/g, " ").trim();
  return /limit$/i.test(label) ? label : `${label} limit`;
}

function fallbackWindows(providerKey) {
  return (
    providerKey === "xai"
      ? [
          { id: "weekly", label: "week limit" },
          { id: "monthly", label: "month limit" }
        ]
      : providerKey === "cursor"
        ? [
            { id: "monthly", label: "included limit" }
          ]
      : [
          { id: "five_hour", label: "5h limit" },
          { id: "weekly", label: "week limit" }
        ]
  ).map((window) => ({ ...window, remaining: null, resetAt: null }));
}

function normalizeLimitWindows(windows, providerKey, { fallback = false } = {}) {
  const seen = new Set();
  const mapped = (Array.isArray(windows) ? windows : [])
    .map((window, index) => ({
      id: String(window.id || window.key || window.type || window.period || `window-${index}`),
      kind: windowKind(window),
      label: windowLabel(window),
      remaining: window.remainingPercent ?? null,
      resetAt: window.resetAt || null
    }))
    .filter((window) => window.remaining !== null || window.resetAt);
  const deduped = [];
  for (const window of mapped) {
    const key = `${window.kind}:${normalizeKey(window.label)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(window);
    }
  }
  deduped.sort((a, b) => {
    const orderA = WINDOW_ORDER.indexOf(a.kind);
    const orderB = WINDOW_ORDER.indexOf(b.kind);
    return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
  });
  return deduped.length || !fallback ? deduped : fallbackWindows(providerKey);
}

function formatTokens(value) {
  const tokens = Math.max(0, toNumber(value));
  return tokens >= 1e9
    ? `${(tokens / 1e9).toFixed(tokens >= 1e10 ? 1 : 2)}B`
    : tokens >= 1e6
      ? `${(tokens / 1e6).toFixed(tokens >= 1e8 ? 1 : 2)}M`
      : tokens >= 1e3
        ? `${(tokens / 1e3).toFixed(1)}K`
        : `${Math.round(tokens)}`;
}

function formatMoney(value) {
  const amount = toNumber(value);
  return amount >= 1e3 ? `$${Math.round(amount).toLocaleString()}` : `$${amount.toFixed(2)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / (60 * 1e3));
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)}m`;
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function eventCost(event, quotas) {
  const quota = quotas[event.provider] || quotas.misc || DEFAULT_QUOTAS.misc;
  return (event.totalTokens / 1e6) * toNumber(quota.costPerMTok, 3);
}

function providerUsage(events, providerKey, spanMs, quotas) {
  return usageWindow(
    events.filter((event) => event.provider === providerKey),
    spanMs,
    quotas,
    providerKey
  );
}

function localStatus(events, auths) {
  const failures = events.filter((event) => !event.success).length;
  const total = events.length || 1;
  const uptime = Math.max(76, Math.min(100, ((total - failures) / total) * 100));
  const anyDown = auths.some((auth) => auth.status === "down");
  const anyDegraded = auths.some((auth) => auth.status === "degraded") || failures > Math.max(3, total * 0.08);
  return anyDown
    ? { label: "Down", tone: "bad", uptime }
    : anyDegraded
      ? { label: "Degraded", tone: "warn", uptime }
      : { label: "Up", tone: "good", uptime };
}

function applyOfficialStatus(providerKey, status, providerStatus) {
  const official = providerStatus?.[providerKey];
  if (!official) return status;
  const tone = official.tone || status.tone;
  return {
    ...status,
    label: official.label || status.label,
    tone,
    uptime: tone === "good" ? 100 : tone === "warn" ? 99 : 95,
    official: true,
    description:
      official.degradedCount > 0
        ? `${official.degradedCount} statuspage components affected`
        : "All systems operational",
    components: official.components || [],
    componentCount: official.componentCount || official.components?.length || 0,
    degradedCount: official.degradedCount || 0,
    fetchedAt: official.fetchedAt
  };
}

function buildDashboard(snapshot) {
  const settings = snapshot.settings || {};
  const quotas = { ...DEFAULT_QUOTAS, ...(settings.quotas || {}) };
  const providerStatus = snapshot.providerStatus || {};
  const now = Date.now();
  const events = (snapshot.usageEvents || [])
    .map(normalizeEvent)
    .filter((event) => Number.isFinite(event.createdAtMs) && event.createdAtMs <= now);
  const auths = (snapshot.authFiles || [])
    .map(normalizeAuth)
    .filter((auth) => !isApiKeyAccountType(auth.accountType));
  const apiKeys = (snapshot.apiKeyUsage || []).map(normalizeApiKey);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const totalTokens = events.reduce((sum, event) => sum + event.totalTokens, 0);
  const totalCost = events.reduce((sum, event) => sum + eventCost(event, quotas), 0);
  const todayEvents = events.filter(
    (event) => event.createdAtMs >= todayStart.getTime() && event.createdAtMs <= now
  );
  const sevenDayEvents = events.filter((event) => now - event.createdAtMs <= 7 * DAY_MS);
  const thirtyDayEvents = events.filter((event) => now - event.createdAtMs <= 30 * DAY_MS);
  const lastMinuteTokens = events
    .filter((event) => now - event.createdAtMs <= 60 * 1e3)
    .reduce((sum, event) => sum + event.totalTokens, 0);

  const providers = PROVIDER_ORDER.map((providerKey) => {
    const meta = PROVIDER_META[providerKey];
    const quota = quotas[providerKey] || quotas.misc;
    const providerEvents = events.filter((event) => event.provider === providerKey);
    const providerAuths = auths
      .filter((auth) => auth.provider === providerKey)
      .map((auth) => {
        const authEvents = providerEvents.filter((event) => eventMatchesAuth(event, auth));
        const five = usageWindow(authEvents, 5 * HOUR_MS, quotas, providerKey);
        const weekly = usageWindow(authEvents, 7 * DAY_MS, quotas, providerKey);
        const fiveWindow = authWindow(auth, WINDOW_SYNONYMS.five_hour);
        const weeklyWindow = authWindow(auth, WINDOW_SYNONYMS.weekly);
        const monthlyWindow = authWindow(auth, WINDOW_SYNONYMS.monthly);
        const limitWindows = normalizeLimitWindows(auth.quota?.windows, providerKey, { fallback: true });
        const quotaGroups = (Array.isArray(auth.quota?.groups) ? auth.quota.groups : [])
          .map((group) => {
            const groupWindows = Array.isArray(group.windows) ? group.windows : [];
            const limitWindowsForGroup = normalizeLimitWindows(groupWindows, providerKey);
            return {
              id: group.id || group.label,
              label: group.label || group.name || group.id || "model limit",
              limitWindows: limitWindowsForGroup
            };
          })
          .filter((group) => group.limitWindows.length);
        return {
          ...auth,
          five,
          weekly,
          fiveRemaining: fiveWindow?.remainingPercent ?? null,
          weeklyRemaining: weeklyWindow?.remainingPercent ?? null,
          monthlyRemaining: monthlyWindow?.remainingPercent ?? null,
          fiveResetAt: fiveWindow?.resetAt || null,
          weeklyResetAt: weeklyWindow?.resetAt || null,
          monthlyResetAt: monthlyWindow?.resetAt || null,
          limitWindows,
          quotaGroups,
          quotaError: auth.quota?.error || "",
          plan: sanitizePlan(auth.quota?.plan)
        };
      });
    const five = providerUsage(events, providerKey, 5 * HOUR_MS, quotas);
    const weekly = providerUsage(events, providerKey, 7 * DAY_MS, quotas);
    const month = providerUsage(events, providerKey, 30 * DAY_MS, quotas);
    const averageOf = (values) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const fiveRemaining = averageOf(
      providerAuths.map((auth) => auth.fiveRemaining).filter((value) => Number.isFinite(Number(value)))
    );
    const weeklyRemaining = averageOf(
      providerAuths.map((auth) => auth.weeklyRemaining).filter((value) => Number.isFinite(Number(value)))
    );
    const monthlyRemaining = averageOf(
      providerAuths.map((auth) => auth.monthlyRemaining).filter((value) => Number.isFinite(Number(value)))
    );
    const status = applyOfficialStatus(
      providerKey,
      localStatus(providerEvents, providerAuths),
      providerStatus
    );

    const modelTotals = new Map();
    for (const event of providerEvents.filter(
      (candidate) => candidate.createdAtMs <= now && now - candidate.createdAtMs <= 7 * DAY_MS
    )) {
      const model = event.model || "unknown-model";
      const entry = modelTotals.get(model) || { model, tokens: 0, cost: 0 };
      entry.tokens += event.totalTokens;
      entry.cost += eventCost(event, quotas);
      modelTotals.set(model, entry);
    }
    const topModel = [...modelTotals.values()].sort((a, b) => b.cost - a.cost)[0];

    return {
      provider: providerKey,
      meta,
      quota,
      events: providerEvents,
      auths: providerAuths,
      five,
      weekly,
      month,
      fiveRemaining,
      weeklyRemaining,
      monthlyRemaining,
      status,
      topModel
    };
  });

  const costByDay = new Map();
  for (const event of thirtyDayEvents) {
    const key = dayKey(event.createdAtMs);
    costByDay.set(key, (costByDay.get(key) || 0) + eventCost(event, quotas));
  }
  const history = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (29 - index));
    const key = `${date.getMonth() + 1}/${date.getDate()}`;
    return { day: key, value: costByDay.get(key) || 0 };
  });

  const bestProvider = providers
    .flatMap((provider) => (provider.topModel ? [{ ...provider.topModel, provider: provider.provider }] : []))
    .sort((a, b) => b.cost - a.cost)[0];
  const oauthProviders = providers.filter((provider) => provider.auths.length > 0);
  const weeklyRemainings = oauthProviders
    .flatMap((provider) => provider.auths.map((auth) => auth.weeklyRemaining))
    .filter((value) => Number.isFinite(Number(value)));

  return {
    settings,
    quotas,
    events,
    auths,
    providers,
    oauthProviders,
    apiKeys,
    history,
    bestProvider,
    usageStatisticsEnabled: snapshot.usageStatisticsEnabled,
    totals: {
      totalCost,
      totalTokens,
      todayCost: todayEvents.reduce((sum, event) => sum + eventCost(event, quotas), 0),
      todayTokens: todayEvents.reduce((sum, event) => sum + event.totalTokens, 0),
      sevenDayCost: sevenDayEvents.reduce((sum, event) => sum + eventCost(event, quotas), 0),
      sevenDayTokens: sevenDayEvents.reduce((sum, event) => sum + event.totalTokens, 0),
      thirtyDayCost: thirtyDayEvents.reduce((sum, event) => sum + eventCost(event, quotas), 0),
      thirtyDayTokens: thirtyDayEvents.reduce((sum, event) => sum + event.totalTokens, 0),
      lastMinuteTokens,
      fill: weeklyRemainings.length
        ? weeklyRemainings.reduce((sum, value) => sum + (100 - value), 0) / weeklyRemainings.length
        : 0
    }
  };
}

function mergeSnapshot(previous, next) {
  const fallback = demoSnapshot();
  const hasKey = !!next.settings?.managementKey;
  return {
    ...fallback,
    ...next,
    demo: !hasKey && !next.connected,
    settings: {
      ...fallback.settings,
      ...(next.settings || {}),
      quotas: { ...DEFAULT_QUOTAS, ...(next.settings?.quotas || {}) }
    },
    usageEvents: Array.isArray(next.usageEvents) ? next.usageEvents : previous.usageEvents,
    authFiles: Array.isArray(next.authFiles) ? next.authFiles : previous.authFiles,
    apiKeyUsage: Array.isArray(next.apiKeyUsage) ? next.apiKeyUsage : previous.apiKeyUsage,
    usageStatisticsEnabled:
      typeof next.usageStatisticsEnabled == "boolean"
        ? next.usageStatisticsEnabled
        : previous.usageStatisticsEnabled,
    providerStatus: next.providerStatus || previous.providerStatus,
    cursorUsage: next.cursorUsage || previous.cursorUsage || null
  };
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState(demoSnapshot);
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);
  const refreshTail = useRef(Promise.resolve());

  const applySnapshot = useCallback((next) => {
    requestSequence.current += 1;
    setLoading(false);
    setSnapshot((previous) => mergeSnapshot(previous, next));
  }, []);

  const updateSnapshot = useCallback((updater) => {
    requestSequence.current += 1;
    setLoading(false);
    setSnapshot(updater);
  }, []);

  const refresh = useCallback((options = {}) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    const task = refreshTail.current.catch(() => {}).then(async () => {
      try {
        if (window.clipQuota?.getSnapshot) {
          const next = await window.clipQuota.getSnapshot({
            forceQuotaRefresh: options.forceQuotaRefresh === true
          });
          if (requestId === requestSequence.current) {
            setSnapshot((previous) => mergeSnapshot(previous, next));
          }
          return next;
        }
        if (requestId === requestSequence.current) setSnapshot(demoSnapshot());
        return null;
      } catch (error) {
        if (requestId === requestSequence.current) {
          setSnapshot((previous) => ({
            ...previous,
            connected: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
        throw error;
      } finally {
        if (requestId === requestSequence.current) setLoading(false);
      }
    });
    refreshTail.current = task;
    return task;
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  useEffect(() => {
    const pollSeconds = toNumber(snapshot.settings?.pollIntervalSec, 1200);
    const interval = window.setInterval(
      () => refresh({ forceQuotaRefresh: true }).catch(() => {}),
      Math.max(10, pollSeconds) * 1e3
    );
    return () => window.clearInterval(interval);
  }, [refresh, snapshot.settings?.pollIntervalSec]);

  return { snapshot, loading, refresh, applySnapshot, updateSnapshot };
}

function Metric({ label, value, sub }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

function Card({ children, className = "" }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function CardHeader({ icon: Icon, title, subtitle, badge, action }) {
  return (
    <div className="card-header">
      <div className="card-title">
        {Icon ? <Icon size={23} strokeWidth={2.2} /> : null}
        <div>
          <h2>{title}</h2>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
      </div>
      <div className="card-actions">
        {badge ? <span className="pill blue">{badge}</span> : null}
        {action}
      </div>
    </div>
  );
}

function IconButton({ label, children, onClick, active = false, disabled = false }) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {children}
    </button>
  );
}

function MiniLimit({ label, remaining, resetAt, accent }) {
  if (!(remaining != null && Number.isFinite(Number(remaining)))) {
    return (
      <div className="mini-limit unloaded">
        <div>
          <span>{label}</span>
          <b>--</b>
        </div>
        <i>
          <em />
        </i>
        <small>not loaded</small>
      </div>
    );
  }
  const percent = Math.max(0, Math.min(100, toNumber(remaining, 0)));
  const tone = percent <= 25 ? "bad" : percent <= 55 ? "warn" : "good";
  const color = tone === "bad" ? "#fb7185" : tone === "warn" ? "#fbbf24" : accent;
  const resetDelta =
    typeof resetAt === "string" ? new Date(resetAt).getTime() - Date.now() : toNumber(resetAt) - Date.now();
  return (
    <div className="mini-limit">
      <div>
        <span>{label}</span>
        <b style={{ color }}>{Math.round(percent)}%</b>
      </div>
      <i>
        <em style={{ width: `${percent}%`, background: color }} />
      </i>
      <small>{Number.isFinite(resetDelta) ? `reset ${formatDuration(resetDelta)}` : "waiting for quota data"}</small>
    </div>
  );
}

function AccountRow({ auth, accent }) {
  const windowsLoaded = (auth.limitWindows || []).some((window) => window.remaining != null);
  return (
    <div className="account-row">
      <div className={`dot ${auth.status}`} />
      <div className="account-main">
        <div className="account-title">
          <strong>{auth.name}</strong>
          {auth.plan ? <span>{auth.plan}</span> : null}
        </div>
        <div className="account-limits">
          {(auth.limitWindows || []).map((window) => (
            <MiniLimit
              key={`${auth.id}-${window.id}-${window.label}`}
              label={window.label}
              remaining={window.remaining}
              resetAt={window.resetAt}
              accent={accent}
            />
          ))}
        </div>
        {auth.quotaGroups?.length ? (
          <div className="model-limit-list">
            {auth.quotaGroups.map((group) => (
              <div className="model-limit-row" key={`${auth.id}-${group.id}`}>
                <span>{group.label}</span>
                <div className="account-limits">
                  {group.limitWindows.map((window) => (
                    <MiniLimit
                      key={`${auth.id}-${group.id}-${window.id}-${window.label}`}
                      label={window.label}
                      remaining={window.remaining}
                      resetAt={window.resetAt}
                      accent={accent}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {auth.quotaError && !windowsLoaded ? (
          <div className="quota-error" title={auth.quotaError}>
            quota fetch failed: {auth.quotaError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderCard({ provider, expanded, onToggle }) {
  const { meta, auths, status } = provider;
  const Icon = meta.icon;
  return (
    <Card className="provider-card">
      <CardHeader
        icon={Icon}
        title={meta.name}
        subtitle={meta.vendor}
        badge={providerBadge(provider)}
        action={
          <IconButton label="Expand accounts" onClick={onToggle} active={expanded}>
            <ChevronDown size={18} />
          </IconButton>
        }
      />
      <div className="oauth-summary">
        <span>{auths.length} CPA OAuth</span>
        <b>{auths.filter((auth) => auth.status === "up").length} up</b>
        {auths.some((auth) => auth.status !== "up") ? (
          <em>{auths.filter((auth) => auth.status !== "up").length} attention</em>
        ) : (
          <em>healthy</em>
        )}
      </div>
      <div className="account-list">
        {auths.map((auth) => (
          <AccountRow key={auth.id} auth={auth} accent={meta.accent} />
        ))}
      </div>
      {expanded ? <ProviderDetails auths={auths} status={status} provider={provider.provider} /> : null}
    </Card>
  );
}

function averageField(list, key) {
  const values = list.map((item) => Number(item[key])).filter((value) => Number.isFinite(value));
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function ProviderFocus({ provider }) {
  const { meta, auths, status } = provider;
  const Icon = meta.icon;
  const upCount = auths.filter((auth) => auth.status === "up").length;
  const componentCount = status.components?.length || status.componentCount || 0;
  const fiveAvg = averageField(auths, "fiveRemaining");
  const weeklyAvg = averageField(auths, "weeklyRemaining");
  const monthlyAvg = averageField(auths, "monthlyRemaining");
  const primaryLabel = provider.provider === "xai" ? "Month Avg" : "5H Avg";
  const primaryValue = provider.provider === "xai" ? monthlyAvg : fiveAvg;
  return (
    <section className="provider-focus">
      <Card className="focus-hero">
        <div className="focus-brand">
          <span className="focus-icon" style={{ color: meta.accent }}>
            <Icon size={25} strokeWidth={2.25} />
          </span>
          <div>
            <h2>{meta.name}</h2>
            <p>
              {meta.vendor} - {auths.length} OAuth accounts - {status.label}
            </p>
          </div>
        </div>
        <div className="focus-metrics">
          <Metric label="OAuth" value={String(auths.length)} sub={`${upCount} up`} />
          <Metric
            label={primaryLabel}
            value={primaryValue == null ? "--" : `${primaryValue}%`}
            sub="available quota"
          />
          <Metric label="Week Avg" value={weeklyAvg == null ? "--" : `${weeklyAvg}%`} sub="available quota" />
          <Metric
            label="Status"
            value={status.tone === "good" ? "Up" : status.tone === "bad" ? "Down" : "Degraded"}
            sub={`${componentCount} components`}
          />
        </div>
      </Card>
      <Card className="focus-card account-focus-card">
        <CardHeader
          icon={Icon}
          title={`${meta.name} OAuth`}
          subtitle="Every CPA OAuth account with live quota"
          badge={providerBadge(provider)}
        />
        <div className="account-list focus-account-list">
          {auths.length ? (
            auths.map((auth) => <AccountRow key={auth.id} auth={auth} accent={meta.accent} />)
          ) : (
            <div className="empty-note">No OAuth account for this provider.</div>
          )}
        </div>
      </Card>
      <Card className="focus-card detail-focus-card">
        <CardHeader
          title="Status & Activity"
          subtitle="Official status plus CPA health"
          badge={`${componentCount} components`}
        />
        <ProviderDetails auths={auths} status={status} provider={provider.provider} />
      </Card>
    </section>
  );
}

function ProviderDetails({ auths, apiKeys = [], status, provider }) {
  const components = status.components || [];
  const accountRows = auths.length
    ? auths
    : [
        {
          name: `${PROVIDER_META[provider].service} OAuth account`,
          status: status.tone === "good" ? "up" : "degraded"
        }
      ];
  const toneClass = (value) =>
    value === "good" || value === "up" || value === "operational"
      ? "up"
      : value === "bad" || value === "down" || value === "partial_outage" || value === "major_outage"
        ? "down"
        : "degraded";
  return (
    <div className="provider-details">
      <div className="detail-head">
        <span>{status.official ? "Statuspage" : "Local status"}</span>
        <strong>{components.length || status.componentCount || 0} components</strong>
        <small>{status.label}</small>
      </div>
      {components.slice(0, 8).map((component, index) => (
        <div className="detail-row component-row" key={`${component.name}-${index}`}>
          <div className={`dot ${toneClass(component.tone || component.status)}`} />
          <div className="detail-copy">
            <strong>{component.name}</strong>
            <p>{String(component.status || "").replaceAll("_", " ") || "unknown"}</p>
            <div className={`uptime-strip endpoint ${toneClass(component.tone || component.status)}`} />
          </div>
          <b>{component.tone === "good" ? "Up" : component.tone === "bad" ? "Down" : "Degraded"}</b>
        </div>
      ))}
      <div className="detail-head oauth-head">
        <span>CPA OAuth</span>
        <strong>{accountRows.length} accounts</strong>
        <small>{accountRows.filter((auth) => auth.status === "up").length} up</small>
      </div>
      {accountRows.map((auth, index) => (
        <div className="detail-row" key={`${auth.id || auth.name}-${index}`}>
          <div className={`dot ${auth.status}`} />
          <div className="detail-copy">
            <strong>
              {auth.authIndex != null ? `#${auth.authIndex} ` : ""}
              {auth.name}
            </strong>
            <p>
              {auth.success || auth.failed
                ? `${auth.success || 0} success / ${auth.failed || 0} failed`
                : auth.path || "waiting for CPA auth data"}
            </p>
          </div>
          <b>{auth.status === "up" ? "Up" : auth.status === "down" ? "Down" : "Degraded"}</b>
        </div>
      ))}
      {apiKeys.length ? (
        <>
          <div className="detail-head oauth-head">
            <span>CPA API Keys</span>
            <strong>{apiKeys.length} keys</strong>
            <small>{apiKeys.filter((key) => key.status === "up").length} up</small>
          </div>
          {apiKeys.map((key, index) => (
            <div className="detail-row" key={`${key.id || key.name}-${index}`}>
              <div className={`dot ${key.status}`} />
              <div className="detail-copy">
                <strong>{key.name}</strong>
                <p>
                  {key.label ? `${key.label} - ` : ""}
                  {key.success || 0} success / {key.failed || 0} failed
                </p>
                <div className={`uptime-strip ${key.status || "up"}`} />
              </div>
              <b>{key.status === "up" ? "Up" : key.status === "down" ? "Down" : "Degraded"}</b>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function StatusCard({ providers, expandedStatus, setExpandedStatus }) {
  const expanded = expandedStatus ? providers.find((provider) => provider.provider === expandedStatus) : null;
  return (
    <Card className="status-card">
      <CardHeader
        title="Status"
        subtitle="Provider health"
        action={<span className="muted">Updated just now</span>}
      />
      <div className="status-grid">
        {providers.slice(0, 4).map((provider) => {
          const Icon = provider.meta.icon;
          const tone = provider.status.tone;
          return (
            <button
              type="button"
              className={`status-tile ${tone}`}
              key={provider.provider}
              onClick={() =>
                setExpandedStatus(expandedStatus === provider.provider ? null : provider.provider)
              }
            >
              <div>
                {tone === "good" ? <CircleCheck size={18} /> : <ShieldAlert size={18} />}
                <Icon size={18} />
                <strong>{provider.meta.service}</strong>
              </div>
              <b>{provider.status.label}</b>
              <span>
                {provider.status.description ||
                  (tone === "good" ? "All services operational" : "Partial service degradation")}
              </span>
              <em>{provider.auths.length} OAuth</em>
            </button>
          );
        })}
      </div>
      {expanded ? (
        <ProviderDetails
          provider={expanded.provider}
          auths={expanded.auths || []}
          status={expanded.status || { uptime: 100, tone: "good" }}
        />
      ) : null}
    </Card>
  );
}

function ApiKeysCard({ apiKeys }) {
  return (
    <Card className="api-keys-card">
      <CardHeader
        icon={KeyRound}
        title="Compatible API Keys"
        subtitle="CPA api-key-usage"
        badge={`${apiKeys.length} keys`}
      />
      <div className="api-key-list">
        {apiKeys.length ? (
          apiKeys.map((key, index) => (
            <div className="api-key-row" key={`${key.id}-${index}`}>
              <div className={`dot ${key.status}`} />
              <div className="api-key-main">
                <strong>{key.name}</strong>
                <p>
                  {key.label ? `${key.label} - ` : ""}
                  {key.success || 0} success / {key.failed || 0} failed
                </p>
                <div className={`uptime-strip compact ${key.status || "up"}`} />
              </div>
              <b>{key.protocol}</b>
            </div>
          ))
        ) : (
          <div className="empty-note">No compatible API key traffic yet.</div>
        )}
      </div>
    </Card>
  );
}

function CostCard({ dashboard }) {
  const { totals } = dashboard;
  const queueOn = dashboard.usageStatisticsEnabled === true;
  return (
    <Card className="cost-card">
      <CardHeader
        title="Cost"
        subtitle="CPA usage queue + local history"
        action={<span className={`queue-state ${queueOn ? "on" : "off"}`}>{queueOn ? "Queue on" : "Queue off"}</span>}
      />
      {queueOn ? null : (
        <div className="inline-warning">
          CPA usage statistics are disabled. Enable the usage queue in Settings to start collecting cost
          history.
        </div>
      )}
      <div className="metrics-grid">
        <Metric label="Stored Cost" value={formatMoney(totals.totalCost)} />
        <Metric label="Today" value={formatMoney(totals.todayCost)} />
        <Metric label="7-Day" value={formatMoney(totals.sevenDayCost)} />
        <Metric label="30-Day" value={formatMoney(totals.thirtyDayCost)} />
        <Metric label="Stored Tok" value={formatTokens(totals.totalTokens)} />
        <Metric label="Today Tok" value={formatTokens(totals.todayTokens)} />
        <Metric label="TPM" value={formatTokens(totals.lastMinuteTokens)} />
        <Metric label="Fill" value={`${Math.round(totals.fill)}%`} />
      </div>
    </Card>
  );
}

function formatUsd(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return formatMoney(Number(value));
}

function CursorUsageCard({ cursorUsage }) {
  if (!cursorUsage) return null;
  if (cursorUsage.disabled) {
    return (
      <Card className="cursor-card">
        <CardHeader icon={MousePointer2} title="Cursor" subtitle="Subscription usage" />
        <div className="inline-warning">Cursor usage polling is disabled in Settings.</div>
      </Card>
    );
  }
  if (!cursorUsage.ok) {
    return (
      <Card className="cursor-card">
        <CardHeader icon={MousePointer2} title="Cursor" subtitle="Subscription usage" />
        <div className="quota-error" title={cursorUsage.error || "unavailable"}>
          {cursorUsage.error || "Unable to read Cursor usage"}
        </div>
      </Card>
    );
  }

  const plan = cursorUsage.plan || {};
  const remaining = plan.remainingPercent;
  const autoUsed = plan.autoPercentUsed;
  const apiUsed = plan.apiPercentUsed;
  const autoLeft = autoUsed == null ? null : Math.max(0, Math.min(100, 100 - autoUsed));
  const apiLeft = apiUsed == null ? null : Math.max(0, Math.min(100, 100 - apiUsed));
  const tone = remaining == null ? "warn" : remaining <= 10 ? "bad" : remaining <= 25 ? "warn" : "good";
  const cycleStart = cursorUsage.billingCycleStart ? new Date(cursorUsage.billingCycleStart) : null;
  const cycleEnd = cursorUsage.billingCycleEnd ? new Date(cursorUsage.billingCycleEnd) : null;
  const cycleLabel =
    cycleStart && cycleEnd && Number.isFinite(cycleStart.getTime()) && Number.isFinite(cycleEnd.getTime())
      ? `${cycleStart.getMonth() + 1}/${cycleStart.getDate()} → ${cycleEnd.getMonth() + 1}/${cycleEnd.getDate()}`
      : "billing cycle";

  return (
    <Card className={`cursor-card ${tone}`}>
      <CardHeader
        icon={MousePointer2}
        title="Cursor"
        subtitle={`${String(cursorUsage.membershipType || "plan").toUpperCase()} · ${cycleLabel}${
          cursorUsage.source === "cpa" ? " · CPA" : cursorUsage.source === "cursor-local-jwt" || !cursorUsage.source ? " · local" : ""
        }`}
        badge={cursorUsage.email || ""}
      />
      <div className="cursor-remaining">
        <div>
          <span>Included remaining</span>
          <strong>{formatUsd(plan.remainingUsd)}</strong>
          <small>
            of {formatUsd(plan.limitUsd)} included
            {remaining == null ? "" : ` · ${Math.round(remaining)}% left`}
            {plan.bonusSpendUsd > 0 ? ` · bonus ${formatUsd(plan.bonusSpendUsd)}` : ""}
          </small>
        </div>
        <div className="cursor-meter" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(100, remaining == null ? plan.usedPercent || 0 : 100 - remaining))}%` }} />
        </div>
      </div>
      <div className="cursor-pools">
        <CursorPoolBar
          label="Auto / Composer"
          hint="Auto + Composer share this pool"
          usedPercent={autoUsed}
          leftPercent={autoLeft}
          message={cursorUsage.autoMessage}
        />
        <CursorPoolBar
          label="API / named models"
          hint="Explicit model picks"
          usedPercent={apiUsed}
          leftPercent={apiLeft}
          message={cursorUsage.apiMessage}
        />
      </div>
      {cursorUsage.displayMessage ? (
        <div className="cursor-messages">
          <p>{cursorUsage.displayMessage}</p>
        </div>
      ) : null}
    </Card>
  );
}

function CursorPoolBar({ label, hint, usedPercent, leftPercent, message }) {
  const missing = usedPercent == null && leftPercent == null;
  const used = missing ? 0 : Math.max(0, Math.min(100, usedPercent == null ? 100 - leftPercent : usedPercent));
  const left = leftPercent == null ? null : Math.round(leftPercent);
  const tone = left == null ? "" : left <= 10 ? "bad" : left <= 25 ? "warn" : "good";
  return (
    <div className={`cursor-pool ${tone}`}>
      <div className="cursor-pool-head">
        <div>
          <strong>{label}</strong>
          {hint ? <small>{hint}</small> : null}
        </div>
        <span>{missing ? "--" : `${Math.round(used)}% used${left == null ? "" : ` · ${left}% left`}`}</span>
      </div>
      <div className="cursor-meter" aria-hidden="true">
        <i style={{ width: `${used}%` }} />
      </div>
      {message ? <p>{message}</p> : null}
    </div>
  );
}

function HistoryCard({ dashboard }) {
  const max = Math.max(1, ...dashboard.history.map((entry) => entry.value));
  const average = dashboard.history.reduce((sum, entry) => sum + entry.value, 0) / dashboard.history.length;
  const averagePosition = (average / max) * 100;
  return (
    <Card className="history-card">
      <CardHeader
        icon={CircleDollarSign}
        title="Usage Cost"
        subtitle="CPA cost estimate"
      />
      <div className="cost-mini-grid">
        <Metric
          label="Today"
          value={formatMoney(dashboard.totals.todayCost)}
          sub={`${formatTokens(dashboard.totals.todayTokens)} tok`}
        />
        <Metric
          label="7D"
          value={formatMoney(dashboard.totals.sevenDayCost)}
          sub={`${formatTokens(dashboard.totals.sevenDayTokens)} tok`}
        />
        <Metric
          label="30D"
          value={formatMoney(dashboard.totals.thirtyDayCost)}
          sub={`${formatTokens(dashboard.totals.thirtyDayTokens)} tok`}
        />
        <Metric
          label="Stored Total"
          value={formatMoney(dashboard.totals.totalCost)}
          sub={`${formatTokens(dashboard.totals.totalTokens)} tok`}
        />
      </div>
      {dashboard.bestProvider ? (
        <div className="top-model">
          <span>Top model 7d</span>
          <strong>{dashboard.bestProvider.model}</strong>
          <p>
            {formatMoney(dashboard.bestProvider.cost)} - {formatTokens(dashboard.bestProvider.tokens)} tok
          </p>
        </div>
      ) : null}
      <div className="chart-head">
        <strong>Cost History</strong>
        <span className="pill blue">30d</span>
      </div>
      <div className="bar-chart">
        {average > 0 ? (
          <>
            <span className="avg-line" style={{ bottom: `${averagePosition}%` }} />
            <em style={{ bottom: `${averagePosition}%` }}>avg {formatMoney(average)}</em>
          </>
        ) : null}
        {dashboard.history.map((entry, index) => (
          <div className="bar-slot" key={`${entry.day}-${index}`}>
            <span
              className={index > dashboard.history.length - 8 ? "hot" : index % 4 === 0 ? "cool" : ""}
              style={{ height: `${entry.value > 0 ? Math.max(3, (entry.value / max) * 100) : 0}%` }}
              title={`${entry.day}: ${formatMoney(entry.value)}`}
            />
            {index % 5 === 0 ? <small>{entry.day}</small> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

function SettingsModal({ snapshot, onClose, onSaved, onEnabled, onClear }) {
  const settings = snapshot.settings || demoSnapshot().settings;
  const [draft, setDraft] = useState({
    ...settings,
    managementKey: settings.managementKey === "configured" ? "configured" : settings.managementKey || "",
    quotas: { ...DEFAULT_QUOTAS, ...(settings.quotas || {}) }
  });
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const insecureRemoteUrl = isInsecureRemoteManagementUrl(draft.baseUrl);

  const updateQuota = (providerKey, field, value) => {
    setDraft((previous) => ({
      ...previous,
      quotas: {
        ...previous.quotas,
        [providerKey]: {
          ...previous.quotas[providerKey],
          [field]: value
        }
      }
    }));
  };

  const save = async () => {
    setBusy("save");
    setActionError("");
    setActionMessage("");
    try {
      if (!window.clipQuota?.saveSettings) throw new Error("Settings are unavailable in this build.");
      await window.clipQuota.saveSettings(draft);
      await onSaved();
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const enableQueue = async () => {
    setBusy("enable");
    setActionError("");
    setActionMessage("");
    try {
      if (!window.clipQuota?.enableUsage) throw new Error("Usage queue controls are unavailable in this build.");
      const next = await window.clipQuota.enableUsage();
      if (!next || typeof next !== "object") throw new Error("CLIProxyAPI returned an invalid snapshot.");
      onEnabled(next);
      setActionMessage("Usage queue enabled.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const clearUsage = async () => {
    if (!window.confirm("Clear all locally stored usage history? This cannot be undone.")) return;
    setBusy("clear");
    setActionError("");
    setActionMessage("");
    try {
      await onClear();
      setActionMessage("Local usage history cleared.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="settings-panel">
        <div className="modal-head">
          <div>
            <h2>Settings</h2>
            <p>Connect CLIProxyAPI and configure cost estimates.</p>
          </div>
          <IconButton label="Close" onClick={onClose} disabled={Boolean(busy)}>
            <X size={18} />
          </IconButton>
        </div>
        <label className="field">
          <span>CLIProxyAPI Base URL</span>
          <input
            value={draft.baseUrl || ""}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:8317/v0/management"
          />
        </label>
        {insecureRemoteUrl ? (
          <div className="modal-feedback warning" role="note">
            Remote HTTP sends the Management Key without transport encryption. Use HTTPS or an SSH tunnel.
          </div>
        ) : null}
        <label className="field">
          <span>Management Key</span>
          <input
            type="password"
            value={draft.managementKey || ""}
            onChange={(event) => setDraft({ ...draft, managementKey: event.target.value })}
            placeholder="Paste management key"
          />
        </label>
        <div className="two-fields">
          <label className="field">
            <span>Poll seconds</span>
            <input
              type="number"
              min="1200"
              value={draft.pollIntervalSec || 1200}
              onChange={(event) => setDraft({ ...draft, pollIntervalSec: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>Queue batch</span>
            <input
              type="number"
              min="1"
              value={draft.usageQueueBatchSize || 200}
              onChange={(event) => setDraft({ ...draft, usageQueueBatchSize: Number(event.target.value) })}
            />
          </label>
        </div>
        <label className="field checkbox-field">
          <span>Show Cursor subscription usage</span>
          <input
            type="checkbox"
            checked={draft.cursorUsageEnabled !== false}
            onChange={(event) => setDraft({ ...draft, cursorUsageEnabled: event.target.checked })}
          />
        </label>
        <p className="field-hint">
          Reads the local Cursor login token and queries Cursor&apos;s unofficial usage API. Token never leaves this machine except to api2.cursor.sh.
        </p>
        <div className="quota-table">
          <div className="quota-row head">
            <span>Provider</span>
            <span>$/MTok</span>
          </div>
          {PROVIDER_ORDER.map((providerKey) => {
            const quota = draft.quotas[providerKey] || DEFAULT_QUOTAS[providerKey];
            return (
              <div className="quota-row" key={providerKey}>
                <strong>{PROVIDER_META[providerKey].name}</strong>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={quota.costPerMTok || 0}
                  onChange={(event) => updateQuota(providerKey, "costPerMTok", Number(event.target.value))}
                />
              </div>
            );
          })}
        </div>
        {actionError ? <div className="modal-feedback error" role="alert">{actionError}</div> : null}
        {actionMessage ? <div className="modal-feedback success" role="status">{actionMessage}</div> : null}
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={enableQueue} disabled={Boolean(busy)}>
            {busy === "enable" ? <LoaderCircle className="spin" size={17} /> : <Gauge size={17} />} Enable usage queue
          </button>
          <button className="ghost-button danger" type="button" onClick={clearUsage} disabled={Boolean(busy)}>
            {busy === "clear" ? <LoaderCircle className="spin" size={17} /> : null} Clear local history
          </button>
          <button className="primary-button" type="button" onClick={save} disabled={Boolean(busy)}>
            {busy === "save" ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { snapshot, loading, refresh, applySnapshot, updateSnapshot } = useSnapshot();
  const dashboard = useMemo(() => buildDashboard(snapshot), [snapshot]);
  const [tab, setTab] = useState("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState(null);
  const [expandedStatus, setExpandedStatus] = useState(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (window.clipQuota?.onPinChange) return window.clipQuota.onPinChange(setPinned);
  }, []);

  const oauthProviders = dashboard.oauthProviders || [];
  const focused = tab === "overview" ? null : oauthProviders.find((provider) => provider.provider === tab);

  useEffect(() => {
    if (tab !== "overview" && !oauthProviders.some((provider) => provider.provider === tab)) {
      setTab("overview");
    }
  }, [tab, oauthProviders]);

  const statusLine = snapshot.connected
    ? `Updated ${snapshot.queueAdded ? `+${snapshot.queueAdded} events` : "just now"}`
    : snapshot.demo
      ? "Demo data"
      : "CPA offline";

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    await window.clipQuota?.setPinned?.(next);
  };

  const clearUsage = async () => {
    if (!window.clipQuota?.clearUsage) throw new Error("Local history controls are unavailable in this build.");
    await window.clipQuota.clearUsage();
    updateSnapshot((previous) => ({ ...previous, usageEvents: [], queueAdded: 0 }));
  };

  return (
    <main className="tray-popover">
      <header className="app-header">
        <div className="title-block">
          <h1>{focused ? focused.meta.name : "Overview"}</h1>
          <p>
            {focused ? `${focused.auths.length} OAuth accounts` : "All providers - quota & cost"} - {statusLine}
          </p>
        </div>
        <nav className="tabs" aria-label="Provider tabs">
          <button
            className={tab === "overview" ? "active" : ""}
            type="button"
            onClick={() => setTab("overview")}
          >
            <ChartColumn size={17} /> Overview
          </button>
          {oauthProviders.map((provider) => {
            const Icon = provider.meta.icon;
            return (
              <button
                className={tab === provider.provider ? "active" : ""}
                type="button"
                key={provider.provider}
                onClick={() => setTab(provider.provider)}
              >
                <Icon size={16} /> {provider.meta.name}
              </button>
            );
          })}
        </nav>
        <div className="header-actions">
          <IconButton label={pinned ? "Unpin window" : "Pin window"} onClick={togglePin} active={pinned}>
            {pinned ? <PinOff size={18} /> : <Pin size={18} />}
          </IconButton>
          <IconButton
            label="Refresh"
            onClick={() => refresh({ forceQuotaRefresh: true }).catch(() => {})}
            active={loading}
            disabled={loading}
          >
            <RefreshCw className={loading ? "spin" : ""} size={18} />
          </IconButton>
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </IconButton>
        </div>
      </header>
      {snapshot.error && !snapshot.demo ? (
        <div className={`notice ${snapshot.connected ? "warn" : "info"}`}>
          <ShieldAlert size={17} />
          <span>{snapshot.error}</span>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Configure
          </button>
        </div>
      ) : null}
      <div className={`dashboard-grid ${focused ? "focus-mode" : ""}`}>
        {focused ? (
          <ProviderFocus provider={focused} />
        ) : (
          <>
            <CostCard dashboard={dashboard} />
            <CursorUsageCard cursorUsage={snapshot.cursorUsage} />
            <StatusCard
              providers={oauthProviders}
              expandedStatus={expandedStatus}
              setExpandedStatus={setExpandedStatus}
            />
            <div className="provider-grid">
              {oauthProviders.map((provider) => (
                <ProviderCard
                  key={provider.provider}
                  provider={provider}
                  expanded={expandedProvider === provider.provider}
                  onToggle={() =>
                    setExpandedProvider(expandedProvider === provider.provider ? null : provider.provider)
                  }
                />
              ))}
            </div>
            <ApiKeysCard apiKeys={dashboard.apiKeys || []} />
            <HistoryCard dashboard={dashboard} />
          </>
        )}
      </div>
      {settingsOpen ? (
        <SettingsModal
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => refresh({ forceQuotaRefresh: true })}
          onEnabled={applySnapshot}
          onClear={clearUsage}
        />
      ) : null}
    </main>
  );
}
