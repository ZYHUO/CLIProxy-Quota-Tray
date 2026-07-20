      // ---- Rich fake snapshot so the real bundle renders a fully-populated UI ----
      (function () {
        const now = Date.now();
        const H = 3600e3, D = 24 * H;
        const iso = (ms) => new Date(ms).toISOString();

        function win(id, remaining, hoursToReset) {
          return { id, remainingPercent: remaining, resetAt: iso(now + hoursToReset * H) };
        }

        const authFiles = [
          {
            id: "oa-1", authIndex: 1, name: "codex-main.oauth.json", provider: "codex",
            email: "codex-main@team.dev", status: "up", accountType: "oauth",
            success: 1841, failed: 23, path: "auths/codex-main.oauth.json",
            quota: { plan: "Pro", windows: [win("five_hour", 68, 2.4), win("weekly", 81, 96)] }
          },
          {
            id: "oa-2", authIndex: 2, name: "codex-alt.oauth.json", provider: "codex",
            email: "codex-alt@team.dev", status: "degraded", accountType: "oauth",
            success: 402, failed: 61, path: "auths/codex-alt.oauth.json",
            quota: { plan: "Plus", windows: [win("five_hour", 21, 1.1), win("weekly", 34, 52)] }
          },
          {
            id: "oa-3", authIndex: 7, name: "codex-eu.oauth.json", provider: "codex",
            email: "codex-eu@team.dev", status: "up", accountType: "oauth",
            success: 12, failed: 30, path: "auths/codex-eu.oauth.json",
            quota: { error: "/api-call: request timed out after 15s" }
          },
          {
            id: "an-1", authIndex: 3, name: "claude-max.oauth.json", provider: "claude",
            email: "claude-max@team.dev", status: "up", accountType: "oauth",
            success: 3210, failed: 12, path: "auths/claude-max.oauth.json",
            quota: {
              plan: "Max 20x",
              windows: [win("five_hour", 74, 3.2), win("weekly", 62, 118)],
              groups: [
                { id: "opus", label: "Opus", windows: [win("five_hour", 44, 3.2), win("weekly", 51, 118)] }
              ]
            }
          },
          {
            id: "an-2", authIndex: 4, name: "claude-fable.oauth.json", provider: "claude",
            email: "fable@team.dev", status: "up", accountType: "oauth",
            success: 980, failed: 4, path: "auths/claude-fable.oauth.json",
            quota: { plan: "Pro", windows: [win("five_hour", 92, 4.6), win("weekly", 88, 140)] }
          },
          {
            id: "gg-1", authIndex: 5, name: "antigravity.oauth.json", provider: "antigravity",
            email: "antigravity@team.dev", status: "up", accountType: "oauth",
            success: 5120, failed: 38, path: "auths/antigravity.oauth.json",
            quota: { plan: "AI Pro", windows: [win("five_hour", 57, 1.8), win("weekly", 76, 88)] }
          },
          {
            id: "xa-1", authIndex: 6, name: "grok-build.oauth.json", provider: "xai",
            email: "grok-build@team.dev", status: "up", accountType: "oauth",
            success: 640, failed: 9, path: "auths/grok-build.oauth.json",
            quota: { plan: "SuperGrok", windows: [win("weekly", 91, 70), win("monthly", 76, 430)] }
          },
          {
            id: "km-1", authIndex: 8, name: "kimi-main.oauth.json", provider: "kimi",
            label: "Kimi User", status: "up", accountType: "oauth",
            success: 210, failed: 3, path: "auths/kimi-main.oauth.json",
            quota: { plan: "Moderato", windows: [win("five_hour", 100, 4), win("weekly", 76, 68)] }
          },
          {
            id: "cu-1", authIndex: 10, name: "cursor.json", provider: "cursor",
            label: "Cursor Pro", status: "up", accountType: "oauth",
            success: 120, failed: 1, path: "auths/cursor.json",
            quota: { plan: "pro", windows: [win("monthly", 35, 400)] }
          },
          {
            id: "vx-1", authIndex: 9, name: "vertex-proj.json", provider: "vertex",
            email: "vertex@team.dev", status: "up", accountType: "oauth",
            success: 88, failed: 1, path: "auths/vertex-proj.json",
            quota: { windows: [] }
          }
        ];

        const models = {
          openai: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
          anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-fable-5"],
          google: ["gemini-3.1-pro", "gemini-3-flash"],
          xai: ["grok-4.5", "grok-code"],
          kimi: ["kimi-k2.5", "kimi-k2"],
          cursor: ["cursor-composer", "gpt-5.3-codex"]
        };
        const authsByProvider = {
          openai: ["oa-1", "oa-2"], anthropic: ["an-1", "an-2"],
          google: ["gg-1", "vx-1"], xai: ["xa-1"], kimi: ["km-1"], cursor: ["cu-1"]
        };
        const providers = ["openai", "anthropic", "google", "xai", "kimi"];
        const usageEvents = [];
        let n = 0;
        for (let day = 29; day >= 0; day--) {
          // heavier traffic recently, wave pattern across the month
          const dayWeight = (day < 7 ? 2.6 : 1) * (1 + 0.5 * Math.sin(day * 1.1)) * (1 - day / 90);
          const perDay = Math.max(4, Math.round(16 * dayWeight));
          for (let i = 0; i < perDay; i++) {
            const p = providers[(n + i + day) % providers.length];
            const ml = models[p];
            const tokens = Math.round((2.2e6 + ((n * 7919) % 11) * 8.5e5) * (p === "anthropic" ? 1.35 : 1) * dayWeight);
            usageEvents.push({
              id: "ev-" + n,
              createdAt: iso(now - day * D - (i * 47 % 22) * H / 2 - (n % 55) * 60e3),
              provider: p,
              model: ml[n % ml.length],
              authId: authsByProvider[p][n % authsByProvider[p].length],
              inputTokens: Math.round(tokens * 0.61),
              outputTokens: Math.round(tokens * 0.39),
              totalTokens: tokens,
              status: n % 43 === 0 ? 429 : 200,
              success: n % 43 !== 0
            });
            n++;
          }
        }

        const snapshot = {
          connected: true,
          error: null,
          lastUpdated: iso(now - 4 * 60e3),
          queueAdded: 37,
          settings: {
            baseUrl: "http://127.0.0.1:8317/v0/management",
            managementKey: "configured",
            pollIntervalSec: 1200,
            usageQueueBatchSize: 200,
            quotas: {}
          },
          authFiles,
          apiKeyUsage: [
            { id: "k1", name: "newapi-cery", protocol: "claude", status: "up", success: 4180, failed: 22, label: "aggregate" },
            { id: "k2", name: "sub2api-gpt55", protocol: "openai", status: "up", success: 2907, failed: 148, label: "reply pool" },
            { id: "k3", name: "gemini-local-proxy", protocol: "gemini", status: "degraded", success: 861, failed: 203, label: "search" }
          ],
          usageEvents,
          usageStatisticsEnabled: true,
          providerStatus: {
            openai: {
              provider: "openai", label: "All Systems Operational", tone: "good",
              componentCount: 11, degradedCount: 0, fetchedAt: iso(now - 6 * 60e3),
              components: [
                { name: "ChatGPT", status: "operational", tone: "good" },
                { name: "OpenAI API", status: "operational", tone: "good" },
                { name: "Codex", status: "operational", tone: "good" }
              ]
            },
            anthropic: {
              provider: "anthropic", label: "Partial System Degradation", tone: "warn",
              componentCount: 7, degradedCount: 1, fetchedAt: iso(now - 6 * 60e3),
              components: [
                { name: "claude.ai", status: "operational", tone: "good" },
                { name: "Claude API", status: "degraded_performance", tone: "warn" },
                { name: "Claude Code", status: "operational", tone: "good" }
              ]
            },
            google: {
              provider: "google", label: "All Systems Operational", tone: "good",
              componentCount: 5, degradedCount: 0, fetchedAt: iso(now - 6 * 60e3),
              components: [
                { name: "Gemini API", status: "operational", tone: "good" },
                { name: "AntiGravity", status: "operational", tone: "good" }
              ]
            },
            xai: {
              provider: "xai", label: "All Systems Operational", tone: "good",
              componentCount: 4, degradedCount: 0, fetchedAt: iso(now - 6 * 60e3),
              components: [
                { name: "Grok", status: "operational", tone: "good" },
                { name: "xAI API", status: "operational", tone: "good" }
              ]
            }
          }
        };

        let pinned = false;
        window.clipQuota = {
          getSnapshot: async () => snapshot,
          readSettings: async () => snapshot.settings,
          saveSettings: async (s) => s,
          clearUsage: async () => snapshot,
          enableUsage: async () => snapshot,
          hideWindow: async () => {},
          setPinned: async (p) => (pinned = p),
          onPinChange: () => () => {}
        };

        // ---- auto-drive the UI into a requested state, e.g. ?click=tab:Claude|settings|status:Anthropic|expand:ChatGPT
        const param = new URLSearchParams(location.search).get("click");
        if (param) {
          const t0 = performance.now();
          const tick = () => {
            if (performance.now() - t0 > 6000) return;
            const tabs = document.querySelectorAll(".tabs button");
            if (!tabs.length) return requestAnimationFrame(tick);
            try {
              if (param.startsWith("tab:")) {
                const name = param.slice(4);
                const btn = [...tabs].find((b) => b.textContent.trim().includes(name));
                if (!btn) return requestAnimationFrame(tick);
                btn.click();
              } else if (param === "settings") {
                const btn = document.querySelector('button[aria-label="Settings"]');
                if (!btn) return requestAnimationFrame(tick);
                btn.click();
              } else if (param.startsWith("status:")) {
                const name = param.slice(7);
                const tile = [...document.querySelectorAll(".status-tile")].find((b) => b.textContent.includes(name));
                if (!tile) return requestAnimationFrame(tick);
                tile.click();
              } else if (param.startsWith("expand:")) {
                const name = param.slice(7);
                const card = [...document.querySelectorAll(".provider-card")].find((c) => c.textContent.includes(name));
                const btn = card && card.querySelector('button[aria-label="Expand accounts"]');
                if (!btn) return requestAnimationFrame(tick);
                btn.click();
              }
            } catch (e) { /* keep polling */ }
          };
          requestAnimationFrame(tick);
        }
        // optional scroll, e.g. ?scroll=900
        const sc = Number(new URLSearchParams(location.search).get("scroll") || 0);
        if (sc > 0) {
          const t0 = performance.now();
          const tick = () => {
            if (performance.now() - t0 > 6000) return;
            const el = document.querySelector(".dashboard-grid");
            if (!el) return requestAnimationFrame(tick);
            setTimeout(() => { el.scrollTop = sc; }, 400);
          };
          requestAnimationFrame(tick);
        }
      })();
