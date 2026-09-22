# Contributing to CLIProxy Quota Tray

A small Electron tray app. It has no backend of its own — **CLIProxyAPI (CPA) is
the server, this is a mirror for it.** That shapes most of the debugging.

## Setup

```bash
npm install
npm run dev        # vite dev
npm test           # node --test tests/*.test.cjs
```

## Reporting bugs

Use the **Bug report** template. The single most useful field is *which stage
it breaks at*, because "quota doesn't show" has very different causes at each:

| stage | almost always |
|---|---|
| can't connect to CPA | CPA's Management API not reachable / token wrong |
| connects, no quota | provider API key missing, or CPA version too old for that provider |
| quota shows but wrong | see the FAQ — some upstreams only expose 2 windows |

Please check [the FAQ](../README.md#常见问题) first; several of these are answered.

## Suggested changes

- Keep it dependency-light — the app currently ships 3 runtime deps on purpose.
- UI copy goes in the same dark-terminal voice as the rest of the README.
- If you touch the provider list, keep the upstream-window reality in the README
  honest (e.g. Grok/xAI only exposes week/month — that's upstream, not a bug).

## Building

```bash
npm run package:win    # win32 x64
npm run package:linux  # linux x64
```

Don't bump `version` in package.json in a feature PR — that's done at release time.

## Pull requests

- One logical change per PR.
- `npm test` should pass.
- Never commit tokens, `.env`, or a real CPA URL.

## Privacy

The app reads from CPA's local Management API and persists usage-queue records
locally. Please keep it that way — no telemetry, no external calls beyond the
provider status endpoints already used.
