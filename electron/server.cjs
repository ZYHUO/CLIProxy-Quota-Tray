const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_STORED_EVENTS = 20000;
const MAX_RETURNED_EVENTS = 5000;
const FETCH_TIMEOUT_MS = 15000;
const STATUS_CACHE_MS = 60000;
const QUOTA_CACHE_MS = 20 * 60 * 1000;
const XAI_BILLING_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

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

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function hashObject(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function booleanFromPayload(payload, ...keys) {
  for (const key of keys) {
    if (typeof payload?.[key] === "boolean") return payload[key];
  }
  if (typeof payload === "boolean") return payload;
  return null;
}

function normalizeProvider(value = "") {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("openai") || raw.includes("chatgpt") || raw.includes("codex")) return "openai";
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic";
  if (raw.includes("google") || raw.includes("gemini") || raw.includes("antigravity")) return "google";
  if (raw.includes("grok") || raw.includes("xai") || raw.includes("x.ai")) return "xai";
  return "misc";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function ratioToPercent(value) {
  const numeric = typeof value === "string" && value.trim().endsWith("%")
    ? Number(value.trim().slice(0, -1))
    : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric <= 1 ? numeric * 100 : numeric;
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

function authHeaders(settings) {
  const headers = { "content-type": "application/json" };
  if (settings.managementKey) {
    headers.authorization = `Bearer ${settings.managementKey}`;
    headers["x-management-key"] = settings.managementKey;
    headers["x-api-key"] = settings.managementKey;
  }
  return headers;
}

async function fetchJSON(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
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
      throw new Error(`${response.status} ${message}`);
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "items", "records", "usage", "auth_files", "authFiles", "auth-files", "files", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function maskSecret(value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 10) return `${raw.slice(0, 2)}...${raw.slice(-2)}`;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function normalizeAuthFile(auth, index = 0) {
  const account = firstString(auth.account, auth.email, auth.username, auth.user);
  const label = firstString(auth.label, auth.display_name, auth.email, auth.account);
  const name = account || auth.name || auth.filename || auth.file || auth.path || auth.file_path || `oauth-${index}`;
  const provider = normalizeProvider(auth.provider || auth.service || auth.platform || auth.type || name);
  const sourceProvider = String(auth.provider || auth.service || auth.platform || auth.type || "").toLowerCase();
  const statusRaw = String(auth.status || auth.state || auth.health || auth.availability || "").toLowerCase();
  const disabled = auth.disabled === true || auth.enabled === false;
  const unavailable = auth.unavailable === true || auth.available === false;
  const expired = statusRaw.includes("expired") || statusRaw.includes("invalid");
  const degraded = statusRaw.includes("degrad") || statusRaw.includes("warn") || statusRaw.includes("limited");
  const down = disabled || unavailable || expired || statusRaw.includes("down") || statusRaw.includes("error");
  const success = firstNumber(auth.success, auth.success_count, auth.successes, auth.stats?.success, auth.usage?.success);
  const failed = firstNumber(auth.failed, auth.failure_count, auth.failures, auth.stats?.failed, auth.usage?.failed);
  const recentRequests = Array.isArray(auth.recent_requests) ? auth.recent_requests : Array.isArray(auth.recentRequests) ? auth.recentRequests : [];

  return {
    id: String(auth.auth_index ?? auth.index ?? auth.id ?? auth.auth_id ?? name),
    authIndex: auth.auth_index ?? auth.index ?? null,
    provider,
    sourceProvider,
    accountType: auth.account_type || auth.accountType || auth.type || "oauth",
    account,
    email: firstString(auth.email),
    hasAccount: Boolean(account),
    name: String(name),
    status: down ? "down" : degraded || failed > success * 0.2 && failed > 2 ? "degraded" : "up",
    disabled,
    unavailable,
    success,
    failed,
    recentRequests: recentRequests.slice(-30).map((request) => ({
      time: request.time || request.timestamp || request.created_at || null,
      status: request.status || request.status_code || null,
      model: request.model || null,
      failed: request.failed === true || request.success === false
    })),
    path: auth.path || auth.file_path || auth.file || auth.filename || "",
    label,
    quota: normalizeQuota(auth)
  };
}

function quotaWindow(id, label, source = {}) {
  if (!source || typeof source !== "object") return null;
  const percent = ratioToPercent(firstDefined(
    source.remaining_percent,
    source.remainingPercent,
    source.percent_remaining,
    source.percentRemaining,
    source.available_percent,
    source.availablePercent
  ));
  const usedPercent = ratioToPercent(firstDefined(source.used_percent, source.usedPercent, source.usage_percent, source.usagePercent));
  const used = firstNumber(source.used, source.current, source.consumed, source.input_tokens, source.total_tokens);
  const limit = firstNumber(source.limit, source.total, source.quota, source.max, source.allowed, source.limit_tokens);
  const remaining = firstNumber(source.remaining, source.available, source.left, limit && used ? limit - used : 0);
  const remainingPercent = percent ?? (usedPercent != null ? 100 - usedPercent : limit ? (remaining / limit) * 100 : null);
  const resetAt = firstString(source.reset_at, source.resetAt, source.period_end, source.periodEnd, source.refresh_at, source.refreshAt, source.next_reset, source.nextReset);

  if (remainingPercent == null && !limit && !remaining && !resetAt) return null;
  return {
    id,
    label,
    remainingPercent: remainingPercent == null ? null : Math.max(0, Math.min(100, remainingPercent)),
    used,
    limit,
    remaining,
    resetAt
  };
}

function normalizeQuota(auth) {
  const quota = auth.quota || auth.quotas || auth.usage_limits || auth.usageLimits || auth.usage || {};
  const windows = [];
  const candidates = [
    ["five_hour", "5 Hours", quota.five_hour || quota.fiveHour || quota["five-hour"] || auth.five_hour || auth.fiveHour],
    ["weekly", "Weekly", quota.weekly || quota.week || quota.seven_day || quota.sevenDay || quota["seven-day"] || auth.weekly || auth.seven_day || auth.sevenDay],
    ["monthly", "Monthly", quota.monthly || quota.month || quota.month_limit || quota.monthLimit || quota.monthly_limit || quota.monthlyLimit || quota.monthly_credits || quota.monthlyCredits || auth.monthly],
    ["daily", "Daily", quota.daily || quota.day || auth.daily]
  ];

  for (const [id, label, source] of candidates) {
    const window = quotaWindow(id, label, source);
    if (window) windows.push(window);
  }

  if (Array.isArray(quota.windows)) {
    for (const item of quota.windows) {
      const id = String(item.id || item.key || item.type || item.period || `window-${windows.length}`);
      const label = item.label || item.name || id.replaceAll("_", " ");
      const window = quotaWindow(id, label, item);
      if (window) windows.push(window);
    }
  }

  return {
    plan: firstString(auth.plan, auth.plan_type, auth.planType, quota.plan, quota.plan_type, quota.planType),
    windows
  };
}

function parseJSONBody(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return value;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function decodeBase64Url(value) {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function parseTokenPayload(value) {
  if (!value) return null;
  if (plainObject(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (plainObject(parsed)) return parsed;
  } catch {
    // Try JWT payload below.
  }
  const parts = trimmed.split(".");
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(parts[1]));
    return plainObject(parsed);
  } catch {
    return null;
  }
}

function openAIAuthClaim(value) {
  const payload = parseTokenPayload(value);
  if (!payload) return null;
  return plainObject(payload["https://api.openai.com/auth"]) || payload;
}

function chatGPTAccountId(rawAuth = {}) {
  const metadata = plainObject(rawAuth.metadata);
  const attributes = plainObject(rawAuth.attributes);
  const candidates = [
    rawAuth.chatgpt_account_id,
    rawAuth.chatgptAccountId,
    openAIAuthClaim(rawAuth.id_token)?.chatgpt_account_id,
    openAIAuthClaim(rawAuth.id_token)?.chatgptAccountId,
    openAIAuthClaim(metadata?.id_token)?.chatgpt_account_id,
    openAIAuthClaim(metadata?.id_token)?.chatgptAccountId,
    openAIAuthClaim(attributes?.id_token)?.chatgpt_account_id,
    openAIAuthClaim(attributes?.id_token)?.chatgptAccountId
  ];
  return firstString(...candidates);
}

function numericOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function percentField(value) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    return numericOrNull(value.trim().slice(0, -1));
  }
  return numericOrNull(value);
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function directQuotaWindow(id, label, { usedPercent = null, remainingPercent = null, resetAt = "" } = {}) {
  const remaining = remainingPercent != null
    ? clampPercent(remainingPercent)
    : usedPercent != null
      ? clampPercent(100 - usedPercent)
      : null;
  if (remaining == null && !resetAt) return null;
  return {
    id,
    label,
    remainingPercent: remaining,
    used: 0,
    limit: 0,
    remaining: 0,
    resetAt
  };
}

function isoFromResetWindow(window = {}) {
  const resetAt = numericOrNull(window.reset_at ?? window.resetAt);
  if (resetAt && resetAt > 0) {
    return new Date(resetAt * 1000).toISOString();
  }
  const resetAfter = numericOrNull(window.reset_after_seconds ?? window.resetAfterSeconds);
  if (resetAfter && resetAfter > 0) {
    return new Date(Date.now() + resetAfter * 1000).toISOString();
  }
  return firstString(window.reset_at, window.resetAt, window.resets_at, window.resetsAt, window.reset_time, window.resetTime);
}

function sourceProviderKey(auth = {}) {
  return String(auth.sourceProvider || auth.provider || auth.type || "").toLowerCase().replace(/_/g, "-");
}

function mergeQuota(existing = {}, incoming = {}) {
  if (!incoming || typeof incoming !== "object") return existing;
  return {
    ...existing,
    ...incoming,
    plan: incoming.plan || existing.plan || "",
    windows: Array.isArray(incoming.windows) && incoming.windows.length
      ? incoming.windows
      : Array.isArray(existing.windows)
        ? existing.windows
        : []
  };
}

function apiCallError(response) {
  const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0);
  const body = parseJSONBody(response?.body);
  let message = "";
  if (body && typeof body === "object") {
    if (typeof body.error === "string") message = body.error;
    else if (body.error && typeof body.error.message === "string") message = body.error.message;
    else if (typeof body.message === "string") message = body.message;
  } else if (typeof body === "string") {
    message = body.slice(0, 200);
  }
  return statusCode ? `${statusCode} ${message || "provider request failed"}` : message || "provider request failed";
}

function apiCallBody(response) {
  return parseJSONBody(response?.body);
}

function apiCallStatus(response) {
  return Number(response?.status_code ?? response?.statusCode ?? 0);
}

async function fetchApiCall(fetchManagement, settings, payload) {
  const response = await fetchManagement("/api-call", settings, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const statusCode = apiCallStatus(response);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(apiCallError(response));
  }
  return response;
}

function claudePlanLabel(profile) {
  if (!profile || typeof profile !== "object") return "";
  const account = profile.account && typeof profile.account === "object" ? profile.account : profile;
  if (account.has_claude_max || account.hasClaudeMax) return "Claude Max";
  if (account.has_claude_pro || account.hasClaudePro || account.is_pro || account.isPro) return "Claude Pro";
  return firstString(account.plan, account.plan_type, account.planType, profile.plan, profile.plan_type, profile.planType);
}

async function fetchClaudeQuota(rawAuth, normalizedAuth, settings, fetchManagement) {
  const authIndex = normalizedAuth.authIndex;
  if (authIndex == null) throw new Error("missing auth index");
  const header = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20"
  };
  const [usageResult, profileResult] = await Promise.allSettled([
    fetchApiCall(fetchManagement, settings, {
      authIndex,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header
    }),
    fetchApiCall(fetchManagement, settings, {
      authIndex,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/profile",
      header
    })
  ]);

  if (usageResult.status === "rejected") throw usageResult.reason;
  const usage = apiCallBody(usageResult.value);
  const specs = [
    ["five_hour", "five_hour", "5 Hours"],
    ["seven_day", "weekly", "Weekly"]
  ];
  const windows = [];

  for (const [sourceKey, id, label] of specs) {
    const source = usage?.[sourceKey];
    if (!source || typeof source !== "object") continue;
    const usedPercent = percentField(source.utilization ?? source.used_percent ?? source.usedPercent);
    const resetAt = firstString(source.resets_at, source.resetsAt, source.reset_at, source.resetAt);
    const window = directQuotaWindow(id, label, { usedPercent, resetAt });
    if (window) windows.push(window);
  }

  const profile = profileResult.status === "fulfilled" ? apiCallBody(profileResult.value) : null;
  return {
    provider: "anthropic",
    fetchedAt: new Date().toISOString(),
    plan: claudePlanLabel(profile),
    windows
  };
}

function codexPlanLabel(planType) {
  const raw = String(planType || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("team")) return "ChatGPT Team";
  if (raw.includes("enterprise")) return "ChatGPT Enterprise";
  if (raw.includes("pro")) return "ChatGPT Pro";
  if (raw.includes("plus")) return "ChatGPT Plus";
  if (raw.includes("free")) return "ChatGPT Free";
  return raw.replace(/(^|\s|-|_)\w/g, (match) => match.toUpperCase()).replaceAll("_", " ");
}

function codexQuotaWindow(id, label, source) {
  if (!source || typeof source !== "object") return null;
  const usedPercent = percentField(source.used_percent ?? source.usedPercent);
  const resetAt = isoFromResetWindow(source);
  return directQuotaWindow(id, label, { usedPercent, resetAt });
}

function codexAdditionalGroups(usage = {}) {
  const limits = usage.additional_rate_limits ?? usage.additionalRateLimits;
  if (!Array.isArray(limits)) return [];

  return limits.map((item, index) => {
    const rateLimit = item?.rate_limit ?? item?.rateLimit;
    if (!rateLimit || typeof rateLimit !== "object") return null;
    const name = firstString(item.limit_name, item.limitName, item.metered_feature, item.meteredFeature, `Additional Limit ${index + 1}`);
    const primary = rateLimit.primary_window ?? rateLimit.primaryWindow;
    const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow;
    const windows = [
      codexQuotaWindow("five_hour", "5 Hours", primary),
      codexQuotaWindow("weekly", "Weekly", secondary)
    ].filter(Boolean);
    if (!windows.length) return null;
    return {
      id: slug(name, `additional-${index + 1}`),
      label: name,
      allowed: rateLimit.allowed,
      limitReached: rateLimit.limit_reached ?? rateLimit.limitReached,
      windows
    };
  }).filter(Boolean);
}

async function fetchCodexQuota(rawAuth, normalizedAuth, settings, fetchManagement) {
  const authIndex = normalizedAuth.authIndex;
  if (authIndex == null) throw new Error("missing auth index");
  const header = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal"
  };
  const accountId = chatGPTAccountId(rawAuth);
  if (accountId) {
    header["Chatgpt-Account-Id"] = accountId;
  }
  const response = await fetchApiCall(fetchManagement, settings, {
    authIndex,
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header
  });
  const usage = apiCallBody(response);
  const rateLimit = usage?.rate_limit ?? usage?.rateLimit ?? {};
  const primary = rateLimit.primary_window ?? rateLimit.primaryWindow;
  const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow;
  const windows = [
    codexQuotaWindow("five_hour", "5 Hours", primary),
    codexQuotaWindow("weekly", "Weekly", secondary)
  ].filter(Boolean);

  return {
    provider: "openai",
    fetchedAt: new Date().toISOString(),
    plan: codexPlanLabel(usage?.plan_type ?? usage?.planType),
    limitReached: rateLimit.limit_reached ?? rateLimit.limitReached,
    rateLimitReachedType: usage?.rate_limit_reached_type ?? usage?.rateLimitReachedType,
    groups: codexAdditionalGroups(usage),
    windows
  };
}

function xaiAmount(value) {
  const source = plainObject(value)
    ? firstDefined(value.val, value.value, value.amount, value.cents)
    : value;
  return numericOrNull(source);
}

function xaiUserId(rawAuth = {}) {
  const metadata = plainObject(rawAuth.metadata);
  const attributes = plainObject(rawAuth.attributes);
  const tokenPayloads = [
    parseTokenPayload(rawAuth.id_token),
    parseTokenPayload(rawAuth.idToken),
    parseTokenPayload(rawAuth.access_token),
    parseTokenPayload(rawAuth.accessToken),
    parseTokenPayload(metadata?.id_token),
    parseTokenPayload(metadata?.idToken),
    parseTokenPayload(metadata?.access_token),
    parseTokenPayload(metadata?.accessToken),
    parseTokenPayload(attributes?.id_token),
    parseTokenPayload(attributes?.idToken),
    parseTokenPayload(attributes?.access_token),
    parseTokenPayload(attributes?.accessToken)
  ].filter(Boolean);

  return firstString(
    rawAuth.user_id,
    rawAuth.userId,
    rawAuth.userid,
    rawAuth.x_userid,
    rawAuth.xUserId,
    metadata?.user_id,
    metadata?.userId,
    metadata?.userid,
    attributes?.user_id,
    attributes?.userId,
    attributes?.userid,
    ...tokenPayloads.flatMap((payload) => [payload.sub, payload.user_id, payload.userId, payload.userid])
  );
}

function xaiBillingHeaders(rawAuth = {}) {
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.91",
    accept: "*/*",
    "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)"
  };
  const userId = xaiUserId(rawAuth);
  if (userId) headers["x-userid"] = userId;
  return headers;
}

function xaiBillingConfig(response) {
  const body = apiCallBody(response);
  if (plainObject(body?.config)) return body.config;
  if (plainObject(body)) return body;
  return null;
}

function xaiCurrentPeriodWindow(config = {}) {
  if (!plainObject(config)) return null;
  const currentPeriod = plainObject(config.currentPeriod) || plainObject(config.current_period) || {};
  const periodType = firstString(currentPeriod.type, config.periodType, config.period_type);
  const usedPercent = percentField(firstDefined(
    config.creditUsagePercent,
    config.credit_usage_percent,
    config.usagePercent,
    config.usage_percent,
    config.usedPercent,
    config.used_percent
  ));
  const resetAt = firstString(
    currentPeriod.end,
    currentPeriod.ends_at,
    currentPeriod.endsAt,
    config.currentPeriodEnd,
    config.current_period_end,
    config.billingPeriodEnd,
    config.billing_period_end
  );
  const isMonthly = /month/i.test(periodType);
  const id = isMonthly ? "monthly" : /week/i.test(periodType) ? "weekly" : "current_period";
  const label = isMonthly ? "Monthly" : id === "weekly" ? "Weekly" : "Current Period";
  return directQuotaWindow(id, label, { usedPercent, resetAt });
}

function xaiMonthlyWindow(config = {}) {
  if (!plainObject(config)) return null;
  const limit = xaiAmount(firstDefined(
    config.monthlyLimit,
    config.monthly_limit,
    config.monthlyLimitCents,
    config.monthly_limit_cents
  ));
  const used = xaiAmount(firstDefined(
    config.used,
    config.includedUsed,
    config.included_used,
    config.includedUsedCents,
    config.included_used_cents
  ));
  const usedPercent = limit && used != null
    ? (used / limit) * 100
    : percentField(firstDefined(config.monthlyUsedPercent, config.monthly_used_percent, config.usagePercent, config.usage_percent));
  const resetAt = firstString(config.billingPeriodEnd, config.billing_period_end, config.currentPeriod?.end, config.current_period?.end);
  const window = directQuotaWindow("monthly", "Monthly", { usedPercent, resetAt });
  if (!window) return null;
  if (limit != null) {
    window.limit = limit;
    window.used = used || 0;
    window.remaining = Math.max(0, limit - (used || 0));
  }
  return window;
}

function dedupeQuotaWindows(windows) {
  const byId = new Map();
  for (const window of windows.filter(Boolean)) {
    const id = String(window.id || "");
    if (!id) continue;
    const current = byId.get(id);
    if (!current) {
      byId.set(id, window);
      continue;
    }
    byId.set(id, {
      ...current,
      ...window,
      remainingPercent: window.remainingPercent ?? current.remainingPercent,
      resetAt: window.resetAt || current.resetAt
    });
  }
  return [...byId.values()];
}

async function fetchXaiQuota(rawAuth, normalizedAuth, settings, fetchManagement) {
  const authIndex = normalizedAuth.authIndex;
  if (authIndex == null) throw new Error("missing auth index");
  const header = xaiBillingHeaders(rawAuth);
  const [creditsResult, billingResult] = await Promise.allSettled([
    fetchApiCall(fetchManagement, settings, {
      authIndex,
      method: "GET",
      url: XAI_BILLING_CREDITS_URL,
      header
    }),
    fetchApiCall(fetchManagement, settings, {
      authIndex,
      method: "GET",
      url: XAI_BILLING_URL,
      header
    })
  ]);
  const creditsConfig = creditsResult.status === "fulfilled" ? xaiBillingConfig(creditsResult.value) : null;
  const billingConfig = billingResult.status === "fulfilled" ? xaiBillingConfig(billingResult.value) : null;
  const windows = dedupeQuotaWindows([
    xaiCurrentPeriodWindow(creditsConfig),
    xaiMonthlyWindow(billingConfig)
  ]);

  if (!windows.length) {
    const errors = [creditsResult, billingResult]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    throw new Error(errors.join("; ") || "empty xAI billing quota");
  }

  return {
    provider: "xai",
    fetchedAt: new Date().toISOString(),
    plan: "",
    windows
  };
}

function antigravityProjectId(rawAuth = {}) {
  const metadata = rawAuth.metadata && typeof rawAuth.metadata === "object" ? rawAuth.metadata : null;
  const attributes = rawAuth.attributes && typeof rawAuth.attributes === "object" ? rawAuth.attributes : null;
  return firstString(
    rawAuth.project_id,
    rawAuth.projectId,
    metadata?.project_id,
    metadata?.projectId,
    attributes?.project_id,
    attributes?.projectId,
    attributes?.gemini_virtual_project
  );
}

function slug(value, fallback) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function antigravityWindows(payload) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? ("groups" in payload ? payload : parseJSONBody(payload.body) || payload)
    : null;
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  const windows = [];

  groups.forEach((group, groupIndex) => {
    const groupName = firstString(group.displayName, group.display_name, group.name) || `quota group ${groupIndex + 1}`;
    const groupSlug = slug(groupName, `group-${groupIndex + 1}`);
    const isPrimary = groupIndex === 0 || /gemini/i.test(groupName);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];

    buckets.forEach((bucket, bucketIndex) => {
      const windowName = firstString(bucket.window) || "";
      const label = firstString(bucket.displayName, bucket.display_name, bucket.label) || windowName || `bucket ${bucketIndex + 1}`;
      const remainingFraction = numericOrNull(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (remainingFraction == null) return;
      const percent = ratioToPercent(remainingFraction);
      const id = /5h|five/i.test(windowName) || /5.?hour/i.test(label)
        ? (isPrimary ? "five_hour" : `${groupSlug}-five_hour`)
        : /week/i.test(windowName) || /week/i.test(label)
          ? (isPrimary ? "weekly" : `${groupSlug}-weekly`)
          : `${groupSlug}-${slug(label, `bucket-${bucketIndex + 1}`)}`;
      const window = quotaWindow(id, label, {
        remaining_percent: percent,
        reset_at: firstString(bucket.resetTime, bucket.reset_time)
      });
      if (window) windows.push(window);
    });
  });

  return windows;
}

async function fetchAntigravityQuota(rawAuth, normalizedAuth, settings, fetchManagement) {
  const authIndex = normalizedAuth.authIndex;
  if (authIndex == null) throw new Error("missing auth index");
  const project = antigravityProjectId(rawAuth);
  if (!project) throw new Error("missing project id");
  const endpoints = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
  ];
  const header = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"
  };
  let lastError = null;

  for (const url of endpoints) {
    try {
      const response = await fetchApiCall(fetchManagement, settings, {
        authIndex,
        method: "POST",
        url,
        header,
        data: JSON.stringify({ project })
      });
      const windows = antigravityWindows(apiCallBody(response));
      if (windows.length) {
        return {
          provider: "google",
          fetchedAt: new Date().toISOString(),
          windows
        };
      }
      lastError = new Error("empty quota groups");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("quota unavailable");
}

function normalizeApiKeyUsage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rows = [];

  for (const [providerName, accountMap] of Object.entries(payload)) {
    if (!accountMap || typeof accountMap !== "object" || Array.isArray(accountMap)) continue;
    for (const [compoundKey, stats] of Object.entries(accountMap)) {
      const [baseUrl = providerName, secret = ""] = String(compoundKey).split("|");
      const success = firstNumber(stats?.success, stats?.stats?.success);
      const failed = firstNumber(stats?.failed, stats?.stats?.failed);
      const status = failed > success * 0.2 && failed > 2 ? "degraded" : "up";
      rows.push({
        id: crypto.createHash("sha1").update(`${providerName}:${compoundKey}`).digest("hex"),
        provider: "compatible",
        protocol: String(providerName || "openai-compatible"),
        name: baseUrl || providerName,
        label: maskSecret(secret),
        status,
        success,
        failed,
        recentRequests: Array.isArray(stats?.recent_requests) ? stats.recent_requests : [],
        type: "api-key"
      });
    }
  }

  return rows;
}

function normalizeUsageRecord(record) {
  const body = record?.body || record?.usage || record?.data || record;
  const provider = normalizeProvider(
    body?.provider || body?.service || body?.platform || body?.auth_provider || body?.model || body?.path
  );
  const model = body?.model || body?.model_name || body?.deployment || "unknown-model";
  const timestamp = body?.timestamp || body?.created_at || body?.time || body?.created || Date.now();
  const eventDate = typeof timestamp === "number"
    ? new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000)
    : new Date(timestamp);
  const createdAt = Number.isNaN(eventDate.getTime()) ? new Date().toISOString() : eventDate.toISOString();
  const inputTokens = firstNumber(body?.input_tokens, body?.prompt_tokens, body?.promptTokens, body?.usage?.input_tokens, body?.tokens?.input_tokens);
  const outputTokens = firstNumber(body?.output_tokens, body?.completion_tokens, body?.completionTokens, body?.usage?.output_tokens, body?.tokens?.output_tokens);
  const totalTokens = firstNumber(body?.total_tokens, body?.totalTokens, body?.usage?.total_tokens, body?.tokens?.total_tokens, inputTokens + outputTokens);
  const authId = String(firstDefined(body?.auth_id, body?.auth_index, body?.["auth-index"], body?.auth_file, body?.authFile, body?.account, body?.email, body?.oauth_id, body?.source, "default"));
  const status = Number(body?.status || body?.status_code || body?.response_status || 200);
  const success = status < 400 && body?.error == null && body?.failed !== true;

  return {
    id: String(body?.id || body?.request_id || body?.uuid || hashObject({ createdAt, provider, model, authId, totalTokens, status })),
    createdAt,
    provider,
    model: String(model),
    authId,
    authIndex: firstDefined(body?.auth_index, body?.["auth-index"], null),
    inputTokens,
    outputTokens,
    totalTokens,
    status,
    success
  };
}

function statusToneFromIndicator(indicator) {
  if (indicator === "none") return "good";
  if (indicator === "critical") return "bad";
  if (indicator === "major" || indicator === "minor") return "warn";
  return "warn";
}

function componentTone(status) {
  if (status === "operational") return "good";
  if (status === "major_outage" || status === "partial_outage") return "bad";
  if (status === "degraded_performance" || status === "under_maintenance") return "warn";
  return "warn";
}

function normalizeStatuspage(provider, payload, sourceUrl) {
  const indicator = payload?.status?.indicator || "unknown";
  const components = (payload?.components || []).map((component) => ({
    id: component.id,
    name: component.name,
    status: component.status,
    tone: componentTone(component.status),
    updatedAt: component.updated_at || component.created_at || null
  }));
  const worstTone = components.some((component) => component.tone === "bad")
    ? "bad"
    : components.some((component) => component.tone === "warn")
      ? "warn"
      : statusToneFromIndicator(indicator);
  const statusText = payload?.status?.description || (worstTone === "good" ? "All Systems Operational" : "Service issue reported");
  return {
    provider,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    indicator,
    label: statusText,
    tone: worstTone,
    components,
    componentCount: components.length,
    degradedCount: components.filter((component) => component.tone !== "good").length
  };
}

function createDashboardServer({ userDataPath }) {
  const storeDir = path.join(userDataPath, "quota-monitor");
  const settingsPath = path.join(storeDir, "settings.json");
  const usagePath = path.join(storeDir, "usage-events.jsonl");
  let httpServer = null;
  let port = null;
  let statusCache = { expiresAt: 0, value: null };
  const quotaCache = new Map();

  ensureDir(storeDir);

  function getStoreDir() {
    return storeDir;
  }

  function getPublicSettings() {
    const settings = readSettings();
    return { ...settings, managementKey: settings.managementKey ? "configured" : "" };
  }

  function readSettings() {
    const saved = readJSON(settingsPath, {});
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
    return { ...merged, baseUrl: normalizeManagementBaseUrl(merged) };
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
    writeJSON(settingsPath, merged);
    return merged;
  }

  function readUsageEvents(limit = MAX_RETURNED_EVENTS) {
    if (!fs.existsSync(usagePath)) return [];
    const lines = fs.readFileSync(usagePath, "utf8").split(/\r?\n/).filter(Boolean);
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
    fs.writeFileSync(usagePath, trimmed.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
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

  async function fetchManagement(pathname, settings, init = {}) {
    const baseUrl = normalizeManagementBaseUrl(settings);
    const url = `${baseUrl}${pathname}`;
    try {
      return await fetchJSON(url, {
        ...init,
        headers: {
          ...authHeaders(settings),
          ...(init.headers || {})
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${pathname}: ${message}`);
    }
  }

  async function fetchOAuthQuotaCached(rawAuth, normalizedAuth, settings, forceRefresh = false) {
    const sourceProvider = sourceProviderKey(normalizedAuth);
    const authIndex = normalizedAuth.authIndex;
    if (authIndex == null || String(normalizedAuth.accountType || "").toLowerCase() === "api-key") {
      return null;
    }
    if (normalizedAuth.hasAccount === false) {
      return null;
    }

    const project = antigravityProjectId(rawAuth);
    const cacheKey = `${sourceProvider}:${authIndex}:${project || ""}`;
    const cached = quotaCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let value = null;
    if (sourceProvider.includes("claude") || sourceProvider.includes("anthropic") || normalizedAuth.provider === "anthropic") {
      value = await fetchClaudeQuota(rawAuth, normalizedAuth, settings, fetchManagement);
    } else if (sourceProvider.includes("codex") || sourceProvider.includes("openai") || normalizedAuth.provider === "openai") {
      value = await fetchCodexQuota(rawAuth, normalizedAuth, settings, fetchManagement);
    } else if (sourceProvider.includes("xai") || sourceProvider.includes("grok") || normalizedAuth.provider === "xai") {
      value = await fetchXaiQuota(rawAuth, normalizedAuth, settings, fetchManagement);
    } else if (sourceProvider.includes("antigravity") || sourceProvider.includes("google") || sourceProvider.includes("gemini") || normalizedAuth.provider === "google") {
      value = await fetchAntigravityQuota(rawAuth, normalizedAuth, settings, fetchManagement);
    }

    if (value && Array.isArray(value.windows) && value.windows.length) {
      quotaCache.set(cacheKey, {
        expiresAt: Date.now() + QUOTA_CACHE_MS,
        value
      });
    }
    return value;
  }

  async function enrichAuthFilesWithQuota(rawAuthFiles, settings, forceQuotaRefresh = false) {
    const normalized = rawAuthFiles.map(normalizeAuthFile);
    const settled = [];

    for (let index = 0; index < normalized.length; index += 1) {
      try {
        settled.push({
          status: "fulfilled",
          value: await fetchOAuthQuotaCached(rawAuthFiles[index], normalized[index], settings, forceQuotaRefresh)
        });
      } catch (error) {
        settled.push({
          status: "rejected",
          reason: error
        });
      }
    }

    return normalized.map((auth, index) => {
      const item = settled[index];
      if (item.status === "fulfilled" && item.value) {
        return {
          ...auth,
          quota: mergeQuota(auth.quota, item.value),
          quotaFetchedAt: item.value.fetchedAt || new Date().toISOString()
        };
      }
      if (item.status === "rejected") {
        return {
          ...auth,
          quota: {
            ...auth.quota,
            error: item.reason instanceof Error ? item.reason.message : String(item.reason)
          }
        };
      }
      return auth;
    });
  }

  async function fetchProviderStatus() {
    const now = Date.now();
    if (statusCache.value && statusCache.expiresAt > now) {
      return statusCache.value;
    }

    const endpoints = {
      openai: "https://status.openai.com/api/v2/summary.json",
      anthropic: "https://status.claude.com/api/v2/summary.json"
    };

    const settled = await Promise.allSettled(
      Object.entries(endpoints).map(async ([provider, url]) => [provider, normalizeStatuspage(provider, await fetchJSON(url), url)])
    );
    const statuses = {};
    const errors = {};

    for (const item of settled) {
      if (item.status === "fulfilled") {
        const [provider, value] = item.value;
        statuses[provider] = value;
      } else {
        const provider = Object.keys(endpoints)[settled.indexOf(item)] || "unknown";
        errors[provider] = item.reason instanceof Error ? item.reason.message : String(item.reason);
      }
    }

    statusCache = {
      expiresAt: now + STATUS_CACHE_MS,
      value: { statuses, errors, fetchedAt: new Date().toISOString() }
    };
    return statusCache.value;
  }

  async function collectSnapshot(options = {}) {
    const settings = readSettings();
    const forceQuotaRefresh = options?.forceQuotaRefresh === true || options?.force === true;
    const startedAt = new Date().toISOString();
    const statusSnapshot = await fetchProviderStatus().catch((error) => ({
      statuses: {},
      errors: { status: error instanceof Error ? error.message : String(error) },
      fetchedAt: new Date().toISOString()
    }));
    const result = {
      settings: getPublicSettings(),
      server: { port, storeDir },
      lastUpdated: startedAt,
      connected: false,
      error: null,
      queueAdded: 0,
      authFiles: [],
      usageEvents: readUsageEvents(),
      apiKeyUsage: [],
      usageStatisticsEnabled: null,
      providerStatus: statusSnapshot.statuses,
      providerStatusErrors: statusSnapshot.errors
    };

    if (!settings.managementKey) {
      result.error = "Management key is not configured.";
      return result;
    }

    try {
      const [authFilesPayload, enabledPayload, usagePayload, apiKeyUsagePayload] = await Promise.allSettled([
        fetchManagement("/auth-files?all=true", settings),
        fetchManagement("/usage-statistics-enabled", settings),
        fetchManagement(`/usage-queue?count=${encodeURIComponent(settings.usageQueueBatchSize || 200)}`, settings),
        fetchManagement("/api-key-usage", settings)
      ]);

      if (authFilesPayload.status === "fulfilled") {
        result.authFiles = await enrichAuthFilesWithQuota(extractArray(authFilesPayload.value), settings, forceQuotaRefresh);
      }

      if (enabledPayload.status === "fulfilled") {
        result.usageStatisticsEnabled = booleanFromPayload(enabledPayload.value, "usage-statistics-enabled", "enabled", "value");
      }

      if (usagePayload.status === "fulfilled") {
        const usageRecords = extractArray(usagePayload.value);
        const appended = appendUsageRecords(usageRecords);
        result.queueAdded = appended.added;
        result.usageEvents = appended.events;
      } else if (usagePayload.reason) {
        result.error = usagePayload.reason.message;
      }

      if (apiKeyUsagePayload.status === "fulfilled") {
        result.apiKeyUsage = normalizeApiKeyUsage(apiKeyUsagePayload.value);
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
    return collectSnapshot({ forceQuotaRefresh: true });
  }

  function clearUsage() {
    writeUsageEvents([]);
    return collectSnapshot();
  }

  function sendJSON(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    response.end(JSON.stringify(payload));
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  }

  async function handleRequest(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      if (request.method === "OPTIONS") {
        sendJSON(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        sendJSON(response, 200, await collectSnapshot({ forceQuotaRefresh: url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJSON(response, 200, await fetchProviderStatus());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        sendJSON(response, 200, getPublicSettings());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        sendJSON(response, 200, { settings: { ...writeSettings(await readBody(request)), managementKey: "configured" } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/usage/clear") {
        sendJSON(response, 200, await clearUsage());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/usage/enable") {
        sendJSON(response, 200, await enableUsageStatistics());
        return;
      }
      sendJSON(response, 404, { error: "not found" });
    } catch (error) {
      sendJSON(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function start() {
    if (httpServer) return { port, url: `http://127.0.0.1:${port}` };
    httpServer = http.createServer(handleRequest);
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    port = httpServer.address().port;
    return { port, url: `http://127.0.0.1:${port}` };
  }

  function stop() {
    if (!httpServer) return Promise.resolve();
    return new Promise((resolve) => httpServer.close(resolve));
  }

  return {
    start,
    stop,
    getInfo: () => ({ port, url: port ? `http://127.0.0.1:${port}` : null, storeDir }),
    getStoreDir,
    getPublicSettings,
    writeSettings,
    collectSnapshot,
    clearUsage,
    enableUsageStatistics,
    fetchProviderStatus
  };
}

module.exports = {
  createDashboardServer,
  normalizeProvider,
  normalizeManagementBaseUrl,
  defaultSettings
};
