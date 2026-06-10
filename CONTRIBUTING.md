# Contributing

Thanks for helping improve **Cursor BYOK** (`starduster.cursor-byok`).

## Layout

Plain Node/CommonJS, no bundler — `main` points straight at `src/extension.js`.

- `src/` — extension host code (entry, config, log, server, runtime).
- `src/workbench-hook.js` — the renderer-injected hook (built as a string; keep it
  self-contained, no `require` of `runtime/` modules).
- `src/webview.html` — Control Panel UI.
- `scripts/` — installers and the syntax-check gate.
- `tests/` — `node --test` suites.
- `docs/` — design docs (English + 中文). `proposals/` holds non-shipping notes.

See [`docs/architecture.md`](docs/architecture.md) for the full module map.

## Develop

```bash
npm install            # or `npm ci`
npm run check          # syntax gate + ESLint + node --test (the CI gate)
npm test               # node --test only
npm run lint           # ESLint only
npm run install:cursor # install into ~/.cursor/extensions and patch the hook
npm run debug:cursor-cdp # optional CDP helper for inspecting a running Cursor window
```

`npm run check` is exactly what CI runs on every push and PR. Run it before
opening a PR; it must pass with the test count unchanged or higher.

## Guidelines

- Match the surrounding style (CommonJS, `"use strict"`, 2-space indent — see
  `.editorconfig`).
- Add or update tests for behavior changes; the suites are the safety net for the
  reverse-engineered protocol code.
- Keep official Cursor traffic untouched — BYOK handling is gated by
  `should-handle`/`run`. Changes to the proxy, the hook, or the correlation state
  (`src/runtime/state.js`) are regression-prone; verify against the targeted tests.
- Don't ship dev-only files into the installed extension; `scripts/install-cursor.js`
  `shouldCopy` is the allow/deny list.
