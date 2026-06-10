# Architecture

[中文版](architecture_CN.md)

Cursor BYOK is a local adapter that makes your own provider models appear inside
Cursor while leaving official Cursor models on their original transport. It ships
as the readable extension `starduster.cursor-byok` (`extensionKind: ["ui"]`) and
is plain Node/CommonJS under `src/` — no bundler, `main` points straight at
`src/extension.js`.

## Two cooperating processes

The system is split across two processes that talk only over the local HTTP
server:

```
Cursor renderer (workbench)                 extension host (src/extension.js)
┌───────────────────────────────┐          ┌──────────────────────────────────┐
│ workbench.desktop.main.js      │  HTTP    │ ByokServer (src/server/http.js)    │
│  + injected CURSOR-BYOK-HOOK-V2│ ───────▶ │  /byok/* control + proxy + NDJSON  │
│  (src/workbench-hook.js)       │ :9960+   │  ProviderAdapter → OpenAI/Anthropic│
│  wraps the Connect transport   │ ◀─────── │  request/tool-result state         │
└───────────────────────────────┘          └──────────────────────────────────┘
```

- The **hook** is the only piece running inside Cursor's renderer. It wraps the
  Connect transport and decides, per request, whether to merge models, capture a
  frame, run locally, or pass through.
- The **extension host** runs everything else: the control server, the provider
  loop, and the in-memory state that correlates one logical run across transports.
- When multiple Cursor windows are open, an extension host may attach to an
  existing server only when the ordered workspace root set matches. Roots stay
  scoped per owner/window instead of being merged globally.

## Module map

| Module | Role |
|--------|------|
| `src/extension.js` | Entry point: config bootstrap, adaptive server start / shared-server attach, commands, status bar, Control Panel webview, `providers.json` watch. Exports `activate`, `deactivate`, `panelState`. |
| `src/constants.js` | Identity + defaults: `starduster.cursor-byok`, `127.0.0.1:9960` base port with adaptive probing over 8 consecutive ports, `https://api2.cursor.sh`, `~/.cursor-byok`, `DEFAULT_REDIRECTS`, hook-backup filenames. |
| `src/config.js` | Read/normalize/write `providers.json` + `routes.json`, expose `workbench-hook-state.json` / `workbench-backups/` paths, copy `models-catalog.json`. |
| `src/log.js` | Output channel + optional file log (`cursorByok.log.file`). `LocalLog`. |
| `src/server/http.js` | Local server: `/byok/*` routes, proxy to upstream, `AvailableModels` merge, Bidi decode, NDJSON runs. `ByokServer`. |
| `src/server/provider-adapter.js` | Provider loop for OpenAI Chat / OpenAI Responses / Anthropic. `ProviderAdapter`. |
| `src/runtime/models.js` | Model identity + `AvailableModels` merge. `mergeAvailableModels`, `pickModelId`, `findProviderModel`, `toCursorModel`. |
| `src/runtime/tools.js` | Default Cursor tool schemas + provider JSON-Schema normalization. `CURSOR_BUILTIN_TOOLS`, `coerceProviderToolSchema`. |
| `src/runtime/state.js` | Correlation: Bidi queue, session store (run requests + tool-result waiters + native-id aliases). `ByokSessionStore`. |
| `src/runtime/prompt.js` | BYOK-only prompt rules + provider-visible tool-name sanitization. |
| `src/runtime/client-tool-bridge.js` | Client-side interaction tools (WebSearch, GenerateImage, approvals): build queries, walk completion records for tool-call ids + result envelopes. |
| `src/runtime/interaction-bridge.js` | Interaction-query bridge (AskQuestion, SwitchMode, CreatePlan, MCP auth): build queries and map interaction responses into provider tool results. |
| `src/runtime/cache.js` | OpenAI `prompt_cache_key` and Anthropic cache-control pass-through helpers. BYOK does not synthesize conversation checkpoints. |
| `src/runtime/cursor-protocol.js` | Lightweight decode of Bidi client messages. `decodeBidiClientMessage`. |
| `src/workbench-hook.js` | The injected renderer runtime (`buildWorkbenchHook`). Transport wrap, routing, event→message translation, direct reads, bridges, and native exec. |
| `src/webview.html` | Control Panel UI. |
| `scripts/install-cursor.js` | Install the extension into Cursor + run the hook installer. |
| `scripts/install-workbench-hook.js` | Thin facade: pristine-source resolution, install/analyze/restore, backup orchestration. Delegates patching to the engine and backup I/O to the backup store. |
| `scripts/workbench-patches/` | Declarative patch registry (one module per seam). `index.js` exports the ordered `REGISTRY` and severity constants. |
| `scripts/workbench-patch-engine.js` | Runs the registry over content, produces per-patch status reports. Never throws on missing seams — policy lives in the installer. `applyPatchPlan`, `validateWorkbenchSyntax`. |
| `scripts/workbench-patch-ast.js` | Stable-anchor + local-AST primitives for the critical patches. `findAnchors`, `enclosingMethod`, `matchBracesFrom` (acorn tokenizer), `parseClassMethod`, `applyEdits`. |
| `scripts/workbench-backup-store.js` | Content-addressed pristine backups under `~/.cursor-byok/workbench-backups/`; hook-state JSON read/write; atomic file writes. |
| `scripts/check-syntax.js` | `node --check` parse gate over `src/`, `scripts/`, and `tests/` (`npm run check`). |

## Request flow

1. Cursor loads the extension (`activate`) and the installed hook. The extension
   either starts its own local server on the first available configured port or
   attaches to an already-running shared BYOK server on that port when the
   workspace roots match.
2. The hook keeps a BYOK model-id / model cache, seeded from the model metadata
   embedded at install time (`byokModels`, with `byokModelIds` fallback) and then
   refreshed from `/byok/models`, `AvailableModels`, and `models` SSE events.
3. `AvailableModels` is proxied and merged with configured BYOK models
   (`mergeAvailableModels`): official + BYOK, duplicates and `default` removed,
   `useModelParameters:true`.
4. In Cursor local mode, any configured BYOK model id skips Cursor's
   extension-host local-agent path and falls back to Connect transport, because
   Cursor's official local-agent still validates public model ids against
   official models.
5. Configured BYOK models are handled by the BYOK transport adapter **only when**
   BYOK mode is on and `/byok/should-handle` agrees, re-checked in `/byok/run`.
6. For an adapter-handled run the server calls the provider
   (`ProviderAdapter.run`) and streams normalized NDJSON events (`text_delta`,
   `thinking_delta`, `tool_use_start/delta/done`, `done`).
7. The hook turns those events into Cursor-native server messages. It uses Cursor
   native exec envelopes when they match the tool contract, direct BYOK reads for
   fast `Read` / `ReadFile`, and local bridges for edit, interaction, client-side,
   or unsupported fallback paths.
8. Cursor executes native tool envelopes when one was emitted. Native
   `execClientMessage` results, direct-read results, and local bridge completions
   are correlated by request id + tool-call id, normalized, and handed back to the
   paused provider loop.

## How one run is correlated

Cursor splits a logical run across transports (BidiAppend frames + a RunSSE/Run
call), so the server stitches it together (`src/runtime/state.js`):

- **request id** = the first UUID found anywhere in a payload (`findRequestId`).
- `BidiRawQueue` buffers raw Bidi records by request id (FIFO fallback).
- `ByokSessionStore` records run requests / actions / exec results per request id,
  merges partial run requests, and resolves `waitForRunRequest` /
  `waitForExecResult` so `/byok/run` can block until input and each tool result
  arrive.
- **Checkpoints stay Cursor-owned.** Cursor's native checkpoint state lives in
  `conversationState`: the server / local-agent path emits
  `conversationCheckpointUpdate`, and the client folds it into the composer
  (context-usage counters, history blob + summary pointers) and persists it. The
  BYOK adapter is not on that path — an adapter-handled `Run`/`RunSSE` only sees
  the `conversationState` already embedded in Cursor's client-side run request
  (configured BYOK models ride the adapter / Connect path, not the native
  local-agent path that produces these updates; see step 4). BYOK passes that
  state through to the provider as input, never stores / trims / restores /
  synthesizes `conversationState`, and never emits
  `conversationCheckpointUpdate`. Separately, the workbench hook may persist a
  reduced BYOK message transcript (user / assistant turns plus prompt fields) so
  reconnects can rebuild `messages` when Cursor omits visible transcript
  history. Cursor-owned checkpoint endpoints not handled locally are proxied
  upstream unchanged. (This
  is distinct from `ComposerCheckpointStorageService`, the file-rollback /
  checkout checkpoints — same UI word, different job.)

## Non-goals

- Official models never go through the provider adapter (boundary enforced by
  `should-handle` / `run`).
- BYOK does not invent private Cursor behavior for tools that have no native exec
  or bridge path. Unsupported or filtered tools return explicit local errors so
  the UI and provider loop both terminate.
- BYOK keeps native Cursor tool execution where Cursor exposes a compatible
  envelope, but some provider-facing tools intentionally use adapter-owned paths:
  direct `Read` / `ReadFile`, read-then-write edit bridges, interaction-query
  bridges, client-tool completions, and local unsupported-tool errors.
- Provider history is not raw Cursor JSON for every result. Native and local tool
  results are normalized into consistent result envelopes and then formatted into
  provider-visible text for high-value result types before the next model round.

## Tests

End-to-end coverage now lives under `tests/byok-*.test.js`, e.g.
`tests/byok-hook-transport.test.js`, `tests/byok-server-run.test.js`,
`tests/byok-extension-activation.test.js`, and
`tests/byok-workbench-install.test.js` (installer + patch registry). An
opt-in live-bundle smoke test (`tests/byok-workbench-preflight-live.test.js`,
`BYOK_LIVE_PREFLIGHT=1`) validates the patch plan against the installed Cursor
without writing files. Full behavior→test map in [verification.md](verification.md).
