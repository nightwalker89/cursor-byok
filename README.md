# Cursor BYOK

[中文版](README_CN.md)

**Bring your own API keys to Cursor.** `starduster.cursor-byok` is a readable, local
adapter that makes your own provider models (OpenAI, OpenAI-compatible, and
Anthropic) appear in Cursor's model picker and run through your own keys — while
official Cursor models keep working untouched on their original transport.

## How it works

- A local HTTP server (default `127.0.0.1:9960`) runs in the extension host.
- A small hook injected into Cursor's workbench wraps the Connect transport and,
  per request, either merges your models into `AvailableModels`, runs a BYOK chat
  locally through your provider, or passes official traffic straight through.
- Tools run **natively** in Cursor: the adapter relays a provider's tool calls to
  Cursor's own tool implementations and feeds the results back to the provider
  loop. No custom tool cards; provider-visible result formatting is kept narrow
  and tool-specific.

Deeper design notes — architecture, routing/hooks, provider/tools, verification —
are in [`docs/`](docs/README.md) (English + 中文).

## Install

```bash
npm install
npm run preflight:cursor
npm run install:cursor
```

`./install.sh` runs `npm ci`/`npm install` and then `npm run install:cursor`
only (skips `preflight:cursor`).

`npm run install:cursor` copies the extension into `~/.cursor/extensions`,
installs its runtime deps, patches Cursor's workbench hook, and refreshes the
extension registry. **Restart Cursor** afterward, and re-run after Cursor updates.
`npm run preflight:cursor` checks whether the installed Cursor bundle still
matches a supported hook point before anything is written. `npm run restore:cursor`
restores the last pristine workbench backup captured under `~/.cursor-byok/`.

## Config

Runtime config lives in `~/.cursor-byok/`:

- `providers.json` — your providers and the models each one exposes.
- `routes.json` — BYOK on/off, local server host/port, and which Cursor routes are
  sent through the local server.
- `models-catalog.json` — provider/model catalog copied from this repo.
- `workbench-hook-state.json` + `workbench-backups/` — the last captured pristine
  Cursor workbench/ext-host backup used by `npm run restore:cursor`.

VS Code settings (`cursorByok.*`): `server.host`, `server.port`,
`server.autoStart`, `log.file`. Day-to-day, manage everything from the
**Control Panel** (Activity Bar) or the `Cursor BYOK:` commands — toggle mode,
start/stop the server, install the hook, edit providers/routes, open the log.

## Caveats

- **This modifies the installed Cursor app bundle.** `installWorkbenchHook()`
  patches `workbench.desktop.main.js` and `extensionHostProcess.js`. The ext-host
  target receives the full hook runtime plus transport-factory patches and
  integrity-warning suppression, not just the integrity snippet. That can break
  Cursor's bundle-integrity / code-signing expectations. The current
  implementation does **not** preserve or re-sign the original bundle.
- **Preflight is compatibility-only, not trust-preserving.**
  `npm run preflight:cursor` tells you whether the current Cursor build still
  exposes a supported hook seam. It does not guarantee macOS / Cursor will treat
  the patched app as pristine.
- **Restore only works when a pristine backup was captured first.** If the target
  app was already patched before this version of the installer started managing
  backups, `restore:cursor` has nothing pristine to restore.
- **App updates can invalidate the patch.** Re-run `preflight:cursor` after every
  Cursor update, then reinstall the hook if the seam still matches.
- **Some tools are bridged, not byte-for-byte identical to Cursor's original
  path.** BYOK uses native Cursor exec whenever available, but several tools are
  adapted in-process:
  - `Edit`, `ApplyPatch`, `EditNotebook` use a read-then-write bridge.
  - `Glob` is executed via Cursor `grepArgs` in `files_with_matches` mode.
  - `WebSearch` and `GenerateImage` use the client-tool bridge when Cursor
    explicitly exposes them.
  - `AskQuestion`, `SwitchMode`, `CreatePlan`, and MCP auth use the interaction
    bridge rather than a native exec envelope.
  - Unsupported native-less tools return explicit local errors instead of trying
    to mimic unknown official behavior.
- **`AwaitShell` currently requires a real `shell_id` or `task_id`.** The runtime
  does not implement a “sleep only” fallback.
- **Custom broad redirect configs can hurt idle behavior.** The default route set
  is intentionally minimal; reintroducing broad REST redirects can bring back
  high extension-host CPU when Cursor is idle.

## Verification

```bash
npm run check          # syntax gate + ESLint + node --test
```

Coverage includes: plugin-identity invariants, fresh-install config creation,
Control Panel commands, workbench hook marker replacement, dynamic route updates,
official/BYOK routing boundaries, `AvailableModels` merging, Read/Grep/Glob/
AwaitShell behavior, the read-then-write edit bridge, provider tool-result loops
(OpenAI Chat, OpenAI Responses, Anthropic), schema normalization, prompt rules,
and installer hygiene.

## Acknowledgements

This project is a reimplementation based on **cometix**'s original
[`@cometix/ccursor`](https://www.npmjs.com/package/@cometix/ccursor) Cursor BYOK
extension. It borrows the core idea and overall framework, while rewriting most of
the runtime — notably the tool-call flow (native Cursor exec) and the
prompt-injection pipeline — into a readable, un-obfuscated codebase. Many thanks to
cometix for the original work.
