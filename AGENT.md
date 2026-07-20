# Agent Notes

This project is an Electron tray app (Windows + Linux) for monitoring CLIProxyAPI
(CPA) OAuth quota and usage. Keep this file in sync with durable product and
implementation decisions.

## Product Rules

- Provider badges show OAuth account counts only, for example `3 OAuth`.
- Subscription or plan labels belong only on individual OAuth account rows.
- API key traffic is separate from OAuth accounts because many API keys are
  third-party OpenAI-compatible endpoints, not real OpenAI accounts.
- OAuth accounts without account/email identity are still valid. Display them
  using label/name/path/id fallbacks and fetch quota whenever an OAuth
  `auth_index` is available.
- Grok/xAI quota has week and month windows only. Do not add a fake 5-hour limit.
- Quota polling defaults to 20 minutes. Manual refresh can force quota refresh.
- Usage queue consumption is independent from quota polling. It runs in the
  Electron main process about every 30 seconds, drains all available batches,
  and persists records before any slower quota work.
- Status strips are for official provider endpoints/components, not for every
  OAuth account.
- Quota fetch errors must stay visible: `server.cjs` stores them in
  `quota.error` and the account row renders them (`.quota-error`). Never
  swallow them back into a bare "not loaded".

## Important Files

- `electron/server.cjs`: local data service, usage collector, CPA management
  calls, and provider quota fetchers. It must not expose an unauthenticated
  localhost HTTP API; the renderer communicates only through Electron IPC.
- `electron/main.cjs`: Electron tray/window lifecycle and startup integration
  (Windows Startup folder / login items, Linux XDG autostart `.desktop`).
- `electron/cursor-usage.cjs`: optional Cursor subscription usage reader.
  Uses the local Cursor `state.vscdb` JWT against the unofficial
  `GetCurrentPeriodUsage` dashboard endpoint. Never send the token to the
  renderer; only sanitized USD totals.
- `src/App.jsx`: dashboard data shaping and React UI.
- `src/styles.css`: dark terminal-style UI (JetBrains Mono).
- `tools/preview-stub.js` + `scripts/serve-preview.mjs`: fake-data preview
  harness (`npm run preview:fake`).
- `scripts/installer.nsi`: NSIS per-user installer (Windows).
- `scripts/install-linux.sh`: copy packaged linux-x64 build into `~/.local`.

## Data Flow

1. Electron starts the main-process usage collector and creates the tray UI.
2. Renderer calls the narrow preload IPC bridge for snapshots and settings.
3. The collector drains CPA `/usage-queue?count=...` independently and writes
   records to local history immediately. Snapshot refreshes read
   `/auth-files?all=true`, `/usage-statistics-enabled`, and `/api-key-usage`.
4. Provider-specific OAuth quota is fetched through CPA `POST /api-call`
   with the `$TOKEN$` placeholder (CPA injects and refreshes the OAuth token).
5. Usage queue records are appended to local JSONL history under Electron
   `userData` (`quota-monitor/usage-events.jsonl`).

## Provider Quota Notes

CLIProxyAPI `GET /auth-files` returns `provider`/`type` as the CPA credential key:
`codex`, `claude`, `antigravity`, `xai`, `kimi`, `vertex`, `gemini-cli`, etc.
The tray normalizes those into UI buckets:

- `codex` → ChatGPT (`openai`) — quota via ChatGPT wham/usage
- `claude` → Claude (`anthropic`) — quota via Anthropic oauth/usage
- `antigravity` / `gemini*` / `vertex` → Gemini (`google`) — Antigravity quota only
  for antigravity/gemini; vertex has no proxied quota endpoint yet
- `xai` → Grok — billing credits endpoints
- `kimi` → Kimi (Moonshot) — `GET https://api.kimi.com/coding/v1/usages` (weekly + 5h)
- `cursor` → Cursor — CPA OAuth via `/api-call` to `GetCurrentPeriodUsage`; Overview
  card prefers CPA cursor accounts when present, otherwise local `state.vscdb` JWT

Never treat CPA's `type` field as `account_type`. `type` is the provider key;
`account_type` is `oauth` / `api_key`.

- ChatGPT/Codex uses `https://chatgpt.com/backend-api/wham/usage`
  (plus `Chatgpt-Account-Id` header extracted from the auth file id_token).
- Claude uses `https://api.anthropic.com/api/oauth/usage` and profile for plan.
- Antigravity/Gemini uses Google Cloud Code quota summary endpoints.
- Grok/xAI uses `https://cli-chat-proxy.grok.com/v1/billing(?format=credits)`.
- Kimi uses `https://api.kimi.com/coding/v1/usages`.
- Cursor uses `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`.

Do not infer Google Ultra, SuperGrok Heavy, or similar plan labels from
hardcoded defaults. If a provider returns a plan value directly, show it only
at account-row level.

## Platform Notes

- Windows: packaged builds use `app.setLoginItemSettings`; unpackaged/dev uses
  Startup `.cmd` + `.vbs`. Tray left-click toggles the popover; right-click
  opens the context menu.
- Linux: first launch writes `~/.config/autostart/cliproxy-quota-tray.desktop`.
  AppIndicator often ignores tray `click` / `right-click`, so `setContextMenu`
  is mandatory and **Open Dashboard** must remain a menu item. Document this
  for GNOME/Zorin users. Prefer a ~24px tray icon.
- Ignore blur for a short window after `showWindow()` so tray activation does
  not immediately hide the popover.
- Runtime logs go to `userData/electron-runtime.log` (not the install/repo dir).

## UI Theme

Dark terminal style set in JetBrains Mono (variable woff2 bundled in
`src/fonts/`, no network fetch). Design tokens live at the top of
`src/styles.css` (`--bg-*`, `--accent`, `--good/--warn/--bad`).

Provider accent colors live in `PROVIDER_META` in `src/App.jsx` — one brand
color per provider, do NOT make them all the same hue:

- openai `#19c37d`, anthropic `#e8825e`, google `#6aa9ff`, xai `#d7dce5`,
  kimi `#7dd3fc`, cursor `#94a3b8`, misc `#a78bfa`; low `#fb7185`, warn `#fbbf24` everywhere.

Performance rules (these fixed real scroll jank, keep them):

- The scroll container (`.dashboard-grid`) must NOT be wrapped in an ancestor
  with `border-radius` + `overflow: hidden` (the compositor mask forces
  main-thread scrolling).
- Animations/transitions use `transform` and `opacity` only. No `box-shadow`
  painting over scrolling content, no `backdrop-filter` anywhere.
  Sole documented exception: quota-meter `width` and chart-bar `height`
  transitions (values arrive as JS inline styles) — they run only on data
  refresh (~3×/hour), scoped by `contain: content`. Never add layout
  transitions that can run during scroll.
- Cards use `contain: content`; infinite animations are limited to tiny
  elements (status-dot pulse, spinner) and disabled by
  `prefers-reduced-motion`.
- `BrowserWindow.backgroundColor` is `#0e1117` (matches `--bg-1`) to avoid a
  light flash on open.

## Design Preview Harness

`npm run preview:fake` builds and serves the real bundle with rich fake data
(no Electron needed) at `http://127.0.0.1:5199/preview.html`. Query params
drive UI states: `?click=tab:Claude`, `?click=settings`,
`?click=status:Anthropic`, `?click=expand:ChatGPT`, `?scroll=1400`.
The stub lives in `tools/preview-stub.js`; it must track the snapshot shape
returned by `server.cjs collectSnapshot()`. Do not point it at real CPA.

## Build And Install

```bash
npm install
npm run package:win        # → release/CLIProxy Quota Tray-win32-x64/
npm run package:linux      # → release/CLIProxy Quota Tray-linux-x64/
npm run install:linux      # → ~/.local/share/CLIProxy-Quota-Tray
makensis -DSRC="release/CLIProxy Quota Tray-win32-x64" \
         -DOUTFILE="release/CLIProxy-Quota-Tray-Setup.exe" scripts/installer.nsi
```

Installed app location:
- Windows: `%LOCALAPPDATA%\CLIProxy Quota Tray\`
- Linux (via install script): `~/.local/share/CLIProxy-Quota-Tray/`

## Safety

- Never print management keys, OAuth tokens, private keys, or raw auth files.
- When debugging CPA `/api-call`, redact token-like fields.
- Do not clear local usage history unless the user asks.
- Do not remove startup entries unless explicitly asked.
- Never commit real CPA endpoints, management keys, or account emails to this
  repository — examples use `127.0.0.1` and `*.team.dev` placeholders only.
