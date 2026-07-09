# Agent Notes

This project is a Windows Electron tray app for monitoring CLIProxyAPI (CPA)
OAuth quota and usage. Keep this file in sync with durable product and
implementation decisions.

## Product Rules

- Provider badges show OAuth account counts only, for example `3 OAuth`.
- Subscription or plan labels belong only on individual OAuth account rows.
- API key traffic is separate from OAuth accounts because many API keys are
  third-party OpenAI-compatible endpoints, not real OpenAI accounts.
- OAuth accounts without account/email identity should not be displayed in
  provider cards.
- Grok/xAI quota has week and month windows only. Do not add a fake 5-hour limit.
- Quota polling defaults to 20 minutes. Manual refresh can force quota refresh.
- Status strips are for official provider endpoints/components, not for every
  OAuth account.
- Quota fetch errors must stay visible: `server.cjs` stores them in
  `quota.error` and the account row renders them (`.quota-error`). Never
  swallow them back into a bare "not loaded".

## Important Files

- `electron/server.cjs`: local dashboard server, CPA management calls,
  provider quota fetchers.
- `electron/main.cjs`: Electron tray/window lifecycle and startup integration.
- `electron/preload.cjs`: renderer bridge (`window.clipQuota`).
- `src/App.jsx`: dashboard data shaping and React UI.
- `src/styles.css`: dark terminal-style UI (JetBrains Mono).
- `tools/preview-stub.js` + `scripts/serve-preview.mjs`: fake-data preview
  harness (`npm run preview:fake`).
- `scripts/installer.nsi`: NSIS per-user installer.

## Data Flow

1. Electron starts a local HTTP server on `127.0.0.1` with a random free port.
2. Renderer calls the preload bridge, then `GET /api/snapshot`.
3. Server reads the CPA Management API: `/auth-files?all=true`,
   `/usage-statistics-enabled`, `/usage-queue?count=...`, `/api-key-usage`.
4. Provider-specific OAuth quota is fetched through CPA `POST /api-call`
   with the `$TOKEN$` placeholder (CPA injects and refreshes the OAuth token).
5. Usage queue records are appended to local JSONL history
   (`%APPDATA%\CLIProxy Quota Tray\quota-monitor\usage-events.jsonl`).

## Provider Quota Notes

- ChatGPT/Codex uses `https://chatgpt.com/backend-api/wham/usage`
  (plus `Chatgpt-Account-Id` header extracted from the auth file id_token).
- Claude uses `https://api.anthropic.com/api/oauth/usage` and profile for plan.
- Antigravity/Gemini uses Google Cloud Code quota summary endpoints.
- Grok/xAI uses `https://cli-chat-proxy.grok.com/v1/billing(?format=credits)`.

Do not infer Google Ultra, SuperGrok Heavy, or similar plan labels from
hardcoded defaults. If a provider returns a plan value directly, show it only
at account-row level.

## UI Theme

Dark terminal style set in JetBrains Mono (variable woff2 bundled in
`src/fonts/`, no network fetch). Design tokens live at the top of
`src/styles.css` (`--bg-*`, `--accent`, `--good/--warn/--bad`).

Provider accent colors live in `PROVIDER_META` in `src/App.jsx` — one brand
color per provider, do NOT make them all the same hue:

- openai `#19c37d`, anthropic `#e8825e`, google `#6aa9ff`, xai `#d7dce5`,
  misc `#a78bfa`; low `#fb7185`, warn `#fbbf24` everywhere.

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
makensis -DSRC="release/CLIProxy Quota Tray-win32-x64" \
         -DOUTFILE="release/CLIProxy-Quota-Tray-Setup.exe" scripts/installer.nsi
```

Installed app location: `%LOCALAPPDATA%\CLIProxy Quota Tray\`.

## Safety

- Never print management keys, OAuth tokens, private keys, or raw auth files.
- When debugging CPA `/api-call`, redact token-like fields.
- Do not clear local usage history unless the user asks.
- Do not remove startup entries unless explicitly asked.
- Never commit real CPA endpoints, management keys, or account emails to this
  repository — examples use `127.0.0.1` and `*.team.dev` placeholders only.
