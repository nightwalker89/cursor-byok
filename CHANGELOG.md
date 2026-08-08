# Changelog

All notable changes to **Cursor BYOK** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] — 2026-08-08

### Fixed

- **Cursor 3.15.6 context-RPC transport matching.** The `headerInjector`
  callback changed from a zero-argument arrow to a named single-argument
  arrow, causing the context-RPC agent-client seam to be missed.
  - Match definitions are now version-aware: the installer reads Cursor's
    version from the app bundle and selects the newest known match at or below
    that version. Later Cursor releases use the latest known match until a new
    captured seam requires an update.
  - Patch reports and saved install state include the detected Cursor version
    and selected matcher version for diagnosability.

## [1.0.1] — 2026-08-03

### Fixed

- **`router-guard` critical patch absent on the new Cursor build.** The new
  build refactored `submitChatMaybeAbortCurrent` into a thin wrapper delegating
  to a private `_submitChatMaybeAbortCurrent` method that carries the
  router-guard seam, and split the `agentBackend` guard declaration into two
  declarators (`const Bd=…?"cursor-agent",Rf=Bd!=="cursor-agent"`). The
  previous single-anchor, single-declarator detection matched neither change,
  leaving `npm run preflight:cursor` reporting `router-guard` as `absent` and
  `missingCriticalPatches: ["router-guard"]`.
  - Added `_submitChatMaybeAbortCurrent` to the multi-anchor search so the
    seam-bearing method is found regardless of naming.
  - Added support for the split-declarator guard form; it rewrites only the
    flag declarator's init, preserving the backend binding referenced later in
    the method body (e.g. `setAttribute("composer.agentBackend", Bd)`).
  - Backward compatible: the old single-declarator form on
    `submitChatMaybeAbortCurrent` still patches unchanged.

## [1.0.0] — 2026-06-11

### Added

- **Initial public release.** `starduster.cursor-byok` — a readable, local
  adapter that brings your own API keys to Cursor.
- **Bring-your-own-key providers.** Configure OpenAI, OpenAI-compatible, and
  Anthropic providers in `~/.cursor-byok/providers.json`; your models appear in
  Cursor's model picker and run through your own keys, while official Cursor
  models keep working untouched on their original transport.
- **Local HTTP server** (default `127.0.0.1:9960`) running in the extension
  host, with per-request routing: merge BYOK models into `AvailableModels`,
  run a BYOK chat locally through your provider, or pass official traffic
  straight through.
- **Native tool execution.** Provider tool calls are relayed to Cursor's own
  tool implementations and results fed back to the provider loop — no custom
  tool cards; provider-visible result formatting kept narrow and tool-specific.
- **Workbench hook installer** (`npm run install:cursor`) — copies the extension
  into `~/.cursor/extensions`, installs runtime deps, patches Cursor's
  workbench hook, and refreshes the extension registry.
- **Declarative patch registry** (`scripts/workbench-patches/`) — one module per
  seam, with per-patch `applied`/`active`/`not-needed`/`absent`/`skipped-target`
  status reporting and severity-driven install policy
  (`critical` / `optional` / `transport`).
- **Critical patches**: `router-guard` (block non-BYOK `cursor-agent`
  routing when a BYOK model candidate is eligible) and `local-agent-run`
  (intercept local-mode agent runs through the hook transport).
- **Optional patches**: `integrity-warning`, `stall-detector`,
  `first-token-thresholds`, `model-picker-unlock`.
- **Transport patches**: `connect-promise-client`, `context-rpc-agent-client`.
- **Pristine-first patching.** Patches are always applied to a validated
  pristine source — the unpatched target, a recorded pristine backup
  (re-validated), or an explicit pristine workbench from a mounted Cursor
  installer DMG. Never re-patches on top of a stale patched state.
- **Preflight & restore.** `npm run preflight:cursor` dry-runs the patch plan
  against the installed Cursor bundle without writing anything;
  `npm run restore:cursor` restores the last pristine workbench backup.
- **Control Panel UI** (Activity Bar) and `Cursor BYOK:` commands to toggle
  mode, start/stop the server, install the hook, and edit providers/routes.
- **Model picker unlock** — unblocks the free-tier model picker when BYOK
  models are configured.
- **Config & state** under `~/.cursor-byok/`: `providers.json`, `routes.json`,
  `models-catalog.json`, `workbench-hook-state.json`, `workbench-backups/`.
- **Bilingual docs** (English + 中文): architecture, routing/hooks,
  provider/tools, install/config, and verification maps.
- **Test suite** covering provider adapters (OpenAI chat/responses, Anthropic),
  hook runtime/transport, workbench install/preflight, server routing, MCP
  cache, and tool result formats.

[Unreleased]: https://github.com/nightwalker89/cursor-byok/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/nightwalker89/cursor-byok/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/nightwalker89/cursor-byok/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nightwalker89/cursor-byok/releases/tag/v1.0.0
