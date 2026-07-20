const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_USAGE_CACHE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

function defaultCursorStateDbPath() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function readCursorAuth(stateDbPath = defaultCursorStateDbPath()) {
  const dbPath = path.resolve(String(stateDbPath || defaultCursorStateDbPath()));
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor state DB not found: ${dbPath}`);
  }

  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`Unable to open Cursor state DB (is Cursor running with a lock?): ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const read = (key) => {
      const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
      if (!row || row.value == null) return "";
      return typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    };
    const accessToken = read("cursorAuth/accessToken").trim();
    if (!accessToken) throw new Error("cursorAuth/accessToken missing — sign in to Cursor first");
    return {
      accessToken,
      email: read("cursorAuth/cachedEmail").trim(),
      membershipType: read("cursorAuth/stripeMembershipType").trim() || "unknown",
      stateDbPath: dbPath
    };
  } finally {
    try {
      database.close();
    } catch {
      // ignore close errors
    }
  }
}

function centsToUsd(cents) {
  const numeric = Number(cents);
  if (!Number.isFinite(numeric)) return null;
  return numeric / 100;
}

function msToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return new Date(numeric).toISOString();
}

function normalizeCursorUsage(payload = {}, authMeta = {}) {
  const plan = payload.planUsage && typeof payload.planUsage === "object" ? payload.planUsage : {};
  const spend = payload.spendLimitUsage && typeof payload.spendLimitUsage === "object" ? payload.spendLimitUsage : {};
  const limitCents = Number.isFinite(Number(plan.limit)) ? Number(plan.limit) : null;
  const includedSpendCents = Number.isFinite(Number(plan.includedSpend)) ? Number(plan.includedSpend) : null;
  const bonusSpendCents = Number.isFinite(Number(plan.bonusSpend)) ? Number(plan.bonusSpend) : null;
  const totalSpendCents = Number.isFinite(Number(plan.totalSpend)) ? Number(plan.totalSpend) : null;
  const remainingCents = Number.isFinite(Number(plan.remaining))
    ? Number(plan.remaining)
    : limitCents != null && includedSpendCents != null
      ? Math.max(0, limitCents - includedSpendCents)
      : null;
  const remainingPercent = limitCents > 0 && remainingCents != null
    ? Math.max(0, Math.min(100, (remainingCents / limitCents) * 100))
    : null;
  const usedPercent = limitCents > 0 && includedSpendCents != null
    ? Math.max(0, Math.min(100, (includedSpendCents / limitCents) * 100))
    : Number.isFinite(Number(plan.totalPercentUsed))
      ? Number(plan.totalPercentUsed)
      : null;

  return {
    ok: true,
    source: "cursor-local-jwt",
    email: authMeta.email || "",
    membershipType: authMeta.membershipType || payload.membershipType || "unknown",
    billingCycleStart: msToIso(payload.billingCycleStart),
    billingCycleEnd: msToIso(payload.billingCycleEnd),
    displayMessage: String(payload.displayMessage || ""),
    autoMessage: String(payload.autoModelSelectedDisplayMessage || ""),
    apiMessage: String(payload.namedModelSelectedDisplayMessage || ""),
    enabled: payload.enabled !== false,
    plan: {
      limitUsd: centsToUsd(limitCents),
      includedSpendUsd: centsToUsd(includedSpendCents),
      bonusSpendUsd: centsToUsd(bonusSpendCents),
      totalSpendUsd: centsToUsd(totalSpendCents),
      remainingUsd: centsToUsd(remainingCents),
      remainingPercent,
      usedPercent,
      autoPercentUsed: Number.isFinite(Number(plan.autoPercentUsed)) ? Number(plan.autoPercentUsed) : null,
      apiPercentUsed: Number.isFinite(Number(plan.apiPercentUsed)) ? Number(plan.apiPercentUsed) : null,
      remainingBonus: plan.remainingBonus === true
    },
    onDemand: {
      limitType: String(spend.limitType || ""),
      individualLimitUsd: centsToUsd(spend.individualLimit),
      individualUsedUsd: centsToUsd(spend.individualUsed),
      individualRemainingUsd: centsToUsd(spend.individualRemaining),
      pooledLimitUsd: centsToUsd(spend.pooledLimit),
      pooledUsedUsd: centsToUsd(spend.pooledUsed),
      pooledRemainingUsd: centsToUsd(spend.pooledRemaining)
    },
    fetchedAt: new Date().toISOString()
  };
}

async function fetchCursorPeriodUsage(accessToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CURSOR_USAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: "{}",
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { text };
    }
    if (!response.ok) {
      const message = json?.message || json?.error || text || `HTTP ${response.status}`;
      throw new Error(`${response.status} ${message}`);
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Cursor usage request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createCursorUsageCollector({ stateDbPath } = {}) {
  let cache = { expiresAt: 0, value: null };

  async function collect({ force = false } = {}) {
    if (!force && cache.value && cache.expiresAt > Date.now()) {
      return cache.value;
    }

    try {
      const auth = readCursorAuth(stateDbPath);
      const payload = await fetchCursorPeriodUsage(auth.accessToken);
      const value = normalizeCursorUsage(payload, auth);
      cache = { expiresAt: Date.now() + CURSOR_USAGE_CACHE_MS, value };
      return value;
    } catch (error) {
      const value = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: new Date().toISOString()
      };
      // Cache failures briefly so a missing/locked DB does not hammer every snapshot.
      cache = { expiresAt: Date.now() + Math.min(15_000, CURSOR_USAGE_CACHE_MS), value };
      return value;
    }
  }

  return { collect, defaultCursorStateDbPath };
}

module.exports = {
  CURSOR_USAGE_URL,
  CURSOR_USAGE_CACHE_MS,
  createCursorUsageCollector,
  defaultCursorStateDbPath,
  normalizeCursorUsage,
  readCursorAuth,
  __test: {
    centsToUsd,
    msToIso,
    normalizeCursorUsage
  }
};
