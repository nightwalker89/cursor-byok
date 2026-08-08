# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`starduster.cursor-byok` - a local adapter that makes your own provider models
(OpenAI / OpenAI-compatible / Anthropic) appear in Cursor's model picker and run
through your own keys, while official Cursor models stay on their original transport.
Plain Node/CommonJS, no bundler - `main` points straight at `src/extension.js`.
Read `docs/architecture.md` for the full module map before non-trivial work.

## Commands

```bash
npm run check            # node --check syntax gate + eslint + node --test (the CI gate; run before PR)
npm test                 # node --test (all suites)
npm run lint             # eslint .
npm run preflight:cursor # dry-run: does the installed Cursor bundle still expose a supported seam?
npm run install:cursor   # copy extension into ~/.cursor/extensions, patch the workbench hook, refresh registry. Restart Cursor after.
npm run restore:cursor   # restore the last pristine workbench backup from ~/.cursor-byok/
npm run debug:cursor-cdp # CDP helper to inspect a running Cursor window
```

Single test file: `node --test tests/byok-workbench-install.test.js`
Single test by name: `node --test --test-name-pattern "context-rpc" tests/byok-workbench-install.test.js`

`npm run check` is exactly what CI runs; it must pass with the test count
unchanged or higher. The `web-fetch.test.js` Jina suite needs a real API key
and is expected to fail without one - do not "fix" it by weakening assertions.

## Architecture (two processes)

The system splits across two processes that talk only over the local HTTP
server (default `127.0.0.1:9960`, adaptive over 8 consecutive ports):

- **Cursor renderer (workbench)** - the only code running inside Cursor's
  renderer is the hook injected into `workbench.desktop.main.js`, built by
  `src/workbench-hook.js` (`buildWorkbenchHook`). It wraps the Connect
  transport and decides per request: merge models, capture a frame, run
  locally, or pass through. **`src/workbench-hook.js` is built into a string
  and injected into the renderer - it must stay self-contained: no `require`
  of `src/runtime/` or any Node-only API.**
- **Extension host** - everything else: the control server
  (`src/server/http.js`), the provider loop (`src/server/provider-adapter.js`),
  and the in-memory correlation state (`src/runtime/state.js`) that ties one
  logical run across Connect transports, tool-result waiters, and native-id
  aliases.

BYOK handling is double-gated by `/byok/should-handle` and re-checked in
`/byok/run` - official Cursor traffic must never be touched. When multiple
Cursor windows are open, an extension host attaches to an existing shared
server only when the ordered workspace root set matches.

## The workbench patch system (where Cursor updates break things)

This is the part that needs reading several files to understand and is the most
common source of failures after a Cursor update.

- **`scripts/workbench-patches/`** - a declarative patch registry, one module
  per seam, exported as an ordered `REGISTRY` via `index.js`. Order matters:
  in-place behavior patches run before the transport seams.
- **`scripts/workbench-patch-engine.js`** (`applyPatchPlan`) runs the registry
  over content and reports per-patch status. **The engine never throws on a
  missing seam - policy lives in the installer.** Statuses: `applied`
  (changed content this run), `active` (output already present), `not-needed`
  (an `isNotNeeded` probe confirmed the build lacks the behavior),
  `absent` (did not match), `skipped-target` (patch does not apply to target).
- **Severity drives install policy** (`scripts/install-workbench-hook.js`):
  - `transport` - at least one transport patch must be `applied`/`active` on
    the workbench, or install fails (no usable hook seam).
  - `critical` - BYOK routing is degraded without it; install fails unless
    `--allow-partial`.
  - `optional` - quality-of-life; absence is a warning, never blocks.
- **`preflight:cursor` is the dry-run.** It sets `process.exitCode = 2`
  (non-zero) only when `needsPristine`, no transport hook point, or missing
  critical patches. `absent` optional patches and a stale-backup warning do
  NOT fail preflight - they are informational.

Each patch matches against Cursor's **minified** `workbench.desktop.main.js`
with hand-tuned regexes / AST anchors (`scripts/workbench-patch-ast.js`:
`findAnchors`, `enclosingMethod`, `matchBracesFrom`). When Cursor ships a new
build, minified names and surrounding shapes shift and a patch silently goes
`absent`. To fix one: extract the real seam from the live
`/Applications/Cursor.app/.../workbench.desktop.main.js`, relax the matcher to
cover both the old and new shapes (keep existing test fixtures green), and add
a regression test from the real new-build minified slice. Existing fixtures
live in `tests/fixtures/workbench-seams/` and are loaded via the `seamFixture`
helper. Pristine backups are content-addressed under
`~/.cursor-byok/workbench-backups/`; a patched workbench can only be re-patched
from a pristine backup recorded for the same target path.

**Versioned match policy:** match definitions are tagged with the first Cursor
version whose minified shape they support. The installer reads the installed app
version from `Contents/Info.plist` and selects the newest definition at or below
that version. A later Cursor version therefore uses the latest known match until
a captured seam proves a new definition is needed. Captured 3.12.30, 3.13.25,
and 3.14.27 bundles use the 3.12 context-RPC definition; 3.15.6 remains the
latest captured definition. Do not make a broad fallback to older match shapes
on newer builds: add a versioned definition plus regression fixture instead.
Set `CURSOR_VERSION` only to override version detection for a controlled test or
non-standard app layout; the selected match version appears in the patch report.

**Old-build inspection:** `scripts/cursor-pristine-download.js` is a development
tool only. Run it with `--version 3.12.30`, `3.13.25`, or `3.14.27` to download
an official signed DMG into the temporary build cache, inspect its patch report,
and capture any changed seam before adding a versioned matcher and fixture. It
is not imported by `install:cursor` or `preflight:cursor`, cannot patch the
installed app, and must never become an automatic download or downgrade path.

## Debugging

`.agents/skills/debugging-cursor-byok/` is a debugging skill with a symptom map
and log-signal reference. It breaks failures into five boundaries - install
seam, route decision, run/session correlation, native tool completion,
provider-visible schema/result - and tells you which tests pin each. Consult
`references/symptom-map.md` before changing code; reproduce once in a real
Cursor window (one official-model control run + one BYOK run) and capture
`requestId` / `conversationId` / `toolCallId` / `execId` from BYOK logs first.

## Conventions

- CommonJS, `"use strict"`, 2-space indent (`.editorconfig`).
- `src/webview.html` is the Control Panel UI (ignored by eslint).
- Tests are the safety net for reverse-engineered protocol code - add or
  update tests for behavior changes.
