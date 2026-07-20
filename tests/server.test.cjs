const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDashboardServer,
  normalizeManagementBaseUrl,
  __test
} = require("../electron/server.cjs");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    }
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quota-tray-test-"));
}

async function withDashboardServer(run) {
  const userDataPath = makeTempDir();
  const server = createDashboardServer({ userDataPath });
  try {
    return await run(server, userDataPath);
  } finally {
    await server.stopUsageCollector();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

test("Cursor usage normalizer converts cents plan remaining correctly", { concurrency: false }, () => {
  const { normalizeCursorUsage } = require("../electron/cursor-usage.cjs");
  const normalized = normalizeCursorUsage({
    billingCycleStart: "1782657380000",
    billingCycleEnd: "1785249380000",
    displayMessage: "hit limit",
    planUsage: {
      totalSpend: 9597,
      includedSpend: 2000,
      bonusSpend: 7597,
      limit: 2000,
      autoPercentUsed: 22,
      apiPercentUsed: 65
    }
  }, { email: "a@b.c", membershipType: "pro" });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.membershipType, "pro");
  assert.equal(normalized.plan.limitUsd, 20);
  assert.equal(normalized.plan.includedSpendUsd, 20);
  assert.equal(normalized.plan.remainingUsd, 0);
  assert.equal(normalized.plan.remainingPercent, 0);
  assert.equal(normalized.plan.bonusSpendUsd, 75.97);
});

test("management base URL normalizes host-only and /v0 inputs without doubling", { concurrency: false }, () => {
  assert.equal(
    normalizeManagementBaseUrl({ baseUrl: "127.0.0.1:8317" }),
    "http://127.0.0.1:8317/v0/management"
  );
  assert.equal(
    normalizeManagementBaseUrl({ baseUrl: "http://127.0.0.1:8317/v0" }),
    "http://127.0.0.1:8317/v0/management"
  );
  assert.equal(
    normalizeManagementBaseUrl({ baseUrl: "http://127.0.0.1:8317/v0/management" }),
    "http://127.0.0.1:8317/v0/management"
  );
  assert.equal(
    normalizeManagementBaseUrl({ baseUrl: "http://127.0.0.1:8317/management" }),
    "http://127.0.0.1:8317/management"
  );
});

test("CPA provider keys map to tray buckets and kimi stays visible", { concurrency: false }, () => {
  assert.equal(__test.normalizeProvider("codex"), "openai");
  assert.equal(__test.normalizeProvider("claude"), "anthropic");
  assert.equal(__test.normalizeProvider("antigravity"), "google");
  assert.equal(__test.normalizeProvider("xai"), "xai");
  assert.equal(__test.normalizeProvider("kimi"), "kimi");
  assert.equal(__test.normalizeProvider("moonshot"), "kimi");
  assert.equal(__test.normalizeProvider("cursor"), "cursor");
  assert.equal(__test.normalizeProvider("cursor-oauth"), "cursor");
  assert.equal(__test.normalizeProvider("vertex"), "google");
  assert.equal(__test.normalizeProvider("gemini-cli"), "google");
});

test("auth-files type is the provider key and must not become accountType", { concurrency: false }, () => {
  const auth = __test.normalizeAuthFile({
    type: "kimi",
    provider: "kimi",
    account_type: "oauth",
    auth_index: 12,
    label: "Kimi User"
  });

  assert.equal(auth.provider, "kimi");
  assert.equal(auth.sourceProvider, "kimi");
  assert.equal(auth.accountType, "oauth");
  assert.equal(auth.hasAccount, true);
  assert.equal(auth.authIndex, 12);

  const cursor = __test.normalizeAuthFile({
    type: "cursor",
    provider: "cursor",
    account_type: "oauth",
    auth_index: "cur-1",
    label: "Cursor Pro"
  });
  assert.equal(cursor.provider, "cursor");
  assert.equal(cursor.sourceProvider, "cursor");
  assert.equal(cursor.accountType, "oauth");
});

test("missing account_type still defaults to oauth instead of copying provider type", { concurrency: false }, () => {
  const auth = __test.normalizeAuthFile({
    type: "kimi",
    provider: "kimi",
    auth_index: 9,
    name: "kimi-123.json"
  });

  assert.equal(auth.accountType, "oauth");
  assert.equal(auth.provider, "kimi");
  assert.equal(__test.isApiKeyAccountType("api_key"), true);
  assert.equal(__test.isApiKeyAccountType("api-key"), true);
  assert.equal(__test.isApiKeyAccountType("oauth"), false);
  assert.equal(__test.isOAuthAccountType("oauth"), true);
});

test("Kimi usages parser maps weekly membership and 5h rate limit", { concurrency: false }, () => {
  const parsed = __test.parseKimiQuotaUsage({
    user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    usage: {
      limit: "100",
      used: "24",
      remaining: "76",
      resetTime: "2026-07-23T13:53:17.077157Z"
    },
    limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        remaining: "100",
        resetTime: "2026-07-20T17:53:17.077157Z"
      }
    }]
  });

  assert.equal(parsed.plan, "Moderato");
  assert.deepEqual(
    parsed.windows.map((window) => [window.id, window.remainingPercent, window.remaining]),
    [
      ["weekly", 76, 76],
      ["five_hour", 100, 100]
    ]
  );
});

test("Cursor CPA quota mapper exposes included remaining window", { concurrency: false }, () => {
  const { normalizeCursorUsage } = require("../electron/cursor-usage.cjs");
  const normalized = normalizeCursorUsage({
    billingCycleEnd: "1785249380000",
    planUsage: {
      includedSpend: 500,
      limit: 2000,
      autoPercentUsed: 10,
      apiPercentUsed: 20
    }
  }, { email: "a@b.c", membershipType: "pro" });
  const quota = __test.cursorQuotaFromUsage(normalized);
  assert.equal(quota.provider, "cursor");
  assert.equal(quota.plan, "pro");
  assert.equal(quota.windows[0].id, "monthly");
  assert.equal(quota.windows[0].remainingPercent, 75);
  assert.equal(quota.groups.length, 2);
  assert.equal(quota.cursorUsage.ok, true);
});

test("Antigravity remainingFraction is converted to percent exactly once", { concurrency: false }, () => {
  const windows = __test.antigravityWindows({
    groups: [{
      displayName: "Gemini",
      buckets: [{
        displayName: "Weekly",
        window: "weekly",
        remainingFraction: 0.005
      }]
    }]
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].remainingPercent, 0.5);
});

test("Claude quota parser exposes overall and model-specific limits", { concurrency: false }, () => {
  const parsed = __test.parseClaudeQuotaUsage({
    five_hour: { utilization: 10, resets_at: "2026-07-15T01:00:00Z" },
    seven_day: { utilization: 20, resets_at: "2026-07-20T01:00:00Z" },
    seven_day_sonnet: { utilization: 30 },
    seven_day_opus: { utilization: 40 },
    seven_day_cowork: { utilization: 50 },
    seven_day_oauth_apps: { utilization: 60 }
  });

  assert.deepEqual(
    parsed.windows.map((window) => [window.id, window.remainingPercent]),
    [["five_hour", 90], ["weekly", 80]]
  );
  assert.deepEqual(
    parsed.groups.map((group) => [group.id, group.windows[0].remainingPercent]),
    [["sonnet", 70], ["opus", 60], ["cowork", 50], ["oauth_apps", 40]]
  );
});

test("indexed OAuth auth files remain valid without an email or account", { concurrency: false }, () => {
  const auth = __test.normalizeAuthFile({
    account_type: "oauth",
    auth_index: 7,
    provider: "anthropic"
  });

  assert.equal(auth.account, "");
  assert.equal(auth.email, "");
  assert.equal(auth.authIndex, 7);
  assert.equal(auth.hasAccount, true);
});

test("usage drain is single-flight, drains through a short batch, persists each batch, and clear stays local", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    server.writeSettings({
      managementKey: "test-management-secret",
      baseUrl: "http://127.0.0.1:8317/v0/management",
      usageQueueBatchSize: 2
    });

    const batches = [
      [
        { id: "request-1", model: "gpt-5", total_tokens: 101, timestamp: 1_750_000_001 },
        { id: "request-2", model: "gpt-5", total_tokens: 102, timestamp: 1_750_000_002 }
      ],
      [
        { id: "request-3", model: "claude-sonnet", total_tokens: 103, timestamp: 1_750_000_003 },
        { id: "request-4", model: "gemini-pro", total_tokens: 104, timestamp: 1_750_000_004 }
      ],
      [{ id: "request-5", model: "grok", total_tokens: 105, timestamp: 1_750_000_005 }]
    ];
    const persistedBeforeFetch = [];
    let fetchCalls = 0;
    let releaseFirstFetch;
    const firstFetchGate = new Promise((resolve) => {
      releaseFirstFetch = resolve;
    });
    const originalFetch = global.fetch;

    global.fetch = async (url) => {
      assert.match(String(url), /\/usage-queue\?count=2$/);
      const usagePath = path.join(server.getStoreDir(), "usage-events.jsonl");
      const persisted = fs.existsSync(usagePath)
        ? fs.readFileSync(usagePath, "utf8").split(/\r?\n/).filter(Boolean).length
        : 0;
      persistedBeforeFetch.push(persisted);
      const batchIndex = fetchCalls;
      fetchCalls += 1;
      if (batchIndex === 0) await firstFetchGate;
      return jsonResponse({ data: batches[batchIndex] || [] });
    };

    try {
      const firstDrain = server.drainUsageQueue();
      const concurrentDrain = server.drainUsageQueue();
      assert.strictEqual(concurrentDrain, firstDrain);
      releaseFirstFetch();

      const result = await firstDrain;
      assert.equal(result.batches, 3);
      assert.equal(result.records, 5);
      assert.equal(result.added, 5);
      assert.equal(result.events.length, 5);
      assert.equal(fetchCalls, 3);
      assert.deepEqual(persistedBeforeFetch, [0, 2, 4]);

      const callsBeforeClear = fetchCalls;
      const cleared = await server.clearUsage();
      assert.equal(cleared.usageEvents.length, 0);
      assert.equal(fetchCalls, callsBeforeClear);
      assert.equal(fs.readFileSync(path.join(server.getStoreDir(), "usage-events.jsonl"), "utf8"), "");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("usage drain stops after the defensive full-batch limit", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    server.writeSettings({
      managementKey: "test-management-secret",
      usageQueueBatchSize: 1
    });
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse([{ id: `request-${fetchCalls}`, model: "gpt-5", total_tokens: 1 }]);
    };

    try {
      const result = await server.drainUsageQueue();
      assert.equal(fetchCalls, __test.MAX_USAGE_DRAIN_BATCHES);
      assert.equal(result.batches, __test.MAX_USAGE_DRAIN_BATCHES);
      assert.equal(result.added, __test.MAX_USAGE_DRAIN_BATCHES);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("public settings mask secrets and clamp numeric settings", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    server.writeSettings({
      managementKey: "never-expose-this-secret",
      baseUrl: "127.0.0.1:9000",
      pollIntervalSec: -1,
      usageQueueBatchSize: 999999
    });

    const publicSettings = server.getPublicSettings();
    assert.equal(publicSettings.managementKey, "configured");
    assert.doesNotMatch(JSON.stringify(publicSettings), /never-expose-this-secret/);
    assert.equal(publicSettings.pollIntervalSec, 1200);
    assert.equal(publicSettings.usageQueueBatchSize, 1000);
    assert.equal(publicSettings.baseUrl, "http://127.0.0.1:9000/v0/management");

    server.writeSettings({
      managementKey: "configured",
      pollIntervalSec: 999999999,
      usageQueueBatchSize: 0
    });
    const clamped = server.getPublicSettings();
    assert.equal(clamped.managementKey, "configured");
    assert.equal(clamped.pollIntervalSec, 86400);
    assert.equal(clamped.usageQueueBatchSize, 1);
  });
});

test("start and getInfo do not expose a local HTTP listener", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    const started = await server.start();
    const info = server.getInfo();

    assert.deepEqual(started, { port: null, url: null });
    assert.equal(info.port, null);
    assert.equal(info.url, null);
    assert.equal(info.storeDir, server.getStoreDir());
  });
});

test("snapshots return the full 20,000-event local history", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    const usagePath = path.join(server.getStoreDir(), "usage-events.jsonl");
    const events = Array.from({ length: 20_000 }, (_, index) => ({
      id: `event-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      provider: "openai",
      model: "gpt-5",
      authId: "default",
      totalTokens: index + 1,
      status: 200,
      success: true
    }));
    fs.writeFileSync(usagePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/status\.(?:openai|claude)\.com\//);
      return jsonResponse({
        status: { indicator: "none", description: "All Systems Operational" },
        components: []
      });
    };

    try {
      const snapshot = await server.collectSnapshot();
      assert.equal(snapshot.connected, false);
      assert.equal(snapshot.usageEvents.length, 20_000);
      assert.equal(snapshot.usageEvents[0].id, "event-0");
      assert.equal(snapshot.usageEvents.at(-1).id, "event-19999");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("partial management failures stay visible without discarding a successful connection", { concurrency: false }, async () => {
  await withDashboardServer(async (server) => {
    server.writeSettings({ managementKey: "test-management-secret" });
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const target = String(url);
      if (target.startsWith("https://status.")) {
        return jsonResponse({
          status: { indicator: "none", description: "All Systems Operational" },
          components: []
        });
      }
      if (target.endsWith("/usage-queue?count=200")) return jsonResponse([]);
      if (target.endsWith("/auth-files?all=true")) return jsonResponse({ error: "unavailable" }, 503);
      if (target.endsWith("/usage-statistics-enabled")) {
        return jsonResponse({ "usage-statistics-enabled": true });
      }
      if (target.endsWith("/api-key-usage")) return jsonResponse([]);
      throw new Error(`Unexpected URL: ${target}`);
    };

    try {
      const snapshot = await server.collectSnapshot();
      assert.equal(snapshot.connected, true);
      assert.match(snapshot.error, /auth files:.*503.*unavailable/i);
      assert.equal(snapshot.usageStatisticsEnabled, true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
