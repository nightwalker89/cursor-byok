# Routing and Hook

[中文版](routing-hook_CN.md)

Two layers cooperate: the **workbench hook** (runs in Cursor's renderer, decides
and rewrites transport traffic) and the **local server** (`/byok/*` control plane
+ proxy). This doc covers how a Cursor request is selected, redirected, or left
untouched.

## Hook Installation

`scripts/install-workbench-hook.js` (`prepareWorkbenchInstall` /
`installWorkbenchHook`, running the patch registry in
`scripts/workbench-patch-engine.js`) patches
`/Applications/Cursor.app/.../workbench.desktop.main.js`:

- **Pristine-only patching**: the patch base is always a verified pristine
  source — the on-disk file when unpatched, the recorded pristine backup
  (re-validated: a backup that itself contains BYOK patches is rejected), or
  an explicit pristine workbench (`CURSOR_WORKBENCH_PRISTINE` /
  `pristineWorkbench`; `npm run install:cursor` passes a mounted Cursor
  installer DMG automatically, which also heals a lost or poisoned backup).
  When the target is already patched and no pristine source exists, install
  fails with remediation steps instead of re-patching stale shapes in place;
  dry-run reports `needsPristine` / `pristineSource` instead of throwing.
- **Strip then insert** the hook: removes any current/previous/legacy marked block
  (`stripMarkedBlock`) before prepending the freshly built
  `CURSOR-BYOK-HOOK-V2-START … V2-END` block (`buildWorkbenchHook`). Markers:
  `CLEAN` (`V2`), `PREVIOUS` (prior rewrite marker), `LEGACY` (`HOOK-START`).
- **Patch registry** (`scripts/workbench-patches/`, one module per seam):
  declarative entries `{ name, targets, severity, isActive, apply }` reported
  per patch as `applied` / `active` / `absent` / `skipped-target`. Severity
  drives install policy:
  - *transport* — `connect-promise-client` (the Connect promise-client
    factory) and `context-rpc-agent-client` (wraps agent clients with
    `__cursorByokWrapAgentClient`). At least one must be applied or active on
    the workbench or install fails.
  - *critical* — `router-guard` (`patchAgentProviderRouterGuard`): suppresses
    the `agentBackend ?? "cursor-agent") !== "cursor-agent"` Claude-Code
    backend check when `__cursorByokHasSubmitModelCandidate(selectedModel,
    modelDetails, submitOptions, composerData)` is true; and `local-agent-run`
    (`patchLocalAgentRunForByok`): rewrites the `localMode` branch so BYOK
    candidates skip Cursor's extension-host local-agent path and fall back to
    Connect, guarded by `__cursorByokHasRunOptionsModelCandidate(runOptions,
    selectedModel)`. A missing critical patch fails the install unless
    `--allow-partial` (CLI) / `allowPartial` (API) is passed; the in-editor
    Install Hook command allows partial installs and surfaces the degradation
    as a warning.
  - *optional* — integrity-warning suppression (replaces the
    `…dontShowPrompt…_showNotification()` snippet with `void 0`),
    stall-detector cleanup, and first-token warning thresholds; absence is
    reported as a warning, not an error.
- **Stable anchors + local AST** (`scripts/workbench-patch-ast.js`): the two
  critical patches locate their seams by minification-stable anchors (the
  `async submitChatMaybeAbortCurrent(` method name; the
  `clientSupportsInlineImages:!0` run-options literal, disambiguated to the
  enclosing `async run(` method), extract the enclosing method with
  tokenizer-accurate brace matching, and read every identifier from the parsed
  method AST. Identifier renames and appended run-option properties between
  Cursor builds do not affect them; structural changes surface as `absent` in
  the patch report.
- **Preflight / backup / restore**: `analyzeWorkbenchHookInstall` (`npm run
  preflight:cursor`) prints the full per-patch report without writing files
  and exits `2` when the build cannot be safely patched (no pristine base, no
  transport seam, or missing critical patches). Backups
  (`scripts/workbench-backup-store.js`) are content-addressed under
  `~/.cursor-byok/workbench-backups/` with metadata in
  `~/.cursor-byok/workbench-hook-state.json`, and are captured only from
  content that carries no BYOK patches at all. `restoreWorkbenchHook`
  (`npm run restore:cursor`) copies them back and reports still-patched
  targets it has no backup for.
- **Extension host target** (`extensionHostProcess.js`): receives the full hook
  runtime prepended, plus the transport and integrity patches — not just the
  integrity snippet. Unlike the workbench, a previously patched extHost is
  stripped and re-patched in place (its patches are idempotent), and patched
  extHost content is never captured as a backup.

The hook embeds the `routes.json` host/port, the configured BYOK models
(`byokModels`), every configured BYOK model identifier Cursor may hand back
(`byokModelIds`), and `byokPortSearchCount` (8) at build time. Key globals
include `__cursorByokWrapTransport`, `__cursorByokWrapAgentClient`,
`__cursorByokIsModel`, `__cursorByokHasSubmitModelCandidate`,
`__cursorByokHasRunOptionsModelCandidate`, `__cursorByokModelIds`,
`__cursorByokPickModelId`, and `__cursorByokMarkHookPoint`.

Re-run the install (or the `cursorByok.installWorkbenchHook` command) after Cursor
updates or after changing the port / model set, then restart Cursor. Run
`preflight:cursor` first if you only want to confirm the current Cursor build
still exposes a supported hook seam.

Because this is a pattern-based patcher over private Cursor bundle code, future
Cursor releases can break it in several ways — each now visible in the
preflight report instead of failing silently:

- no supported transport seam is found at all (install fails, preflight exits
  non-zero);
- a critical seam (`router-guard`, `local-agent-run`) stops matching — install
  fails unless `--allow-partial`, and preflight exits non-zero;
- an optional patch shape changes (e.g. the integrity-warning snippet) — the
  patch is skipped and reported as a warning;
- the patch still applies, but Cursor's own integrity/signature behavior changes
  in a way this project does not suppress.

Treat `preflight:cursor` as required before patching an unfamiliar Cursor build.

## Route Selection

`src/constants.js DEFAULT_REDIRECTS` defines the default redirect patterns;
`routes.json.redirect` can override them. `routePatterns(routes)`
(`src/server/http.js`, mirrored in the hook) strips the `REST:` prefix and returns
the active patterns — and returns `[]` when `byokMode === 0`, so **BYOK-off means
no redirects** and Cursor talks to `api2.cursor.sh` directly.

The current default redirect surface is intentionally narrow:
the `/auth/*` membership/payment probes, `REST:/byok/checkpoint`,
`AvailableModels`, `AgentService/RunSSE`, `AgentService/Run`, and
`BidiService/BidiAppend`. `REST:/byok/checkpoint` is proxied upstream unchanged.
The old broad redirect set is preserved only so `normalizeRoutes()` can migrate
legacy configs onto these auth plus transport defaults.

Generic REST redirects preserve method, body, and headers when forwarding through
the local server (`proxyToCursor` + `copyForwardHeaders`; test *"grey-box hook
fetch redirect preserves Request object method body and headers"*). Route updates
propagate to an already-loaded hook over `/byok/events` without reinstall
(`broadcast("routes", …)`; test *"grey-box hook fetch routes update from server
events without reinstall"*).

## Traffic Classes

The wrapped transport handles three classes:

- **`AvailableModels`** — left on Connect; the unary result is merged with
  configured BYOK models (`mergeAvailableModelsResult` in the hook, backed by the
  server's `handleAvailableModels` for the proxy path), and the BYOK model-id
  cache is refreshed (`syncByokModelIds`). Test *"grey-box hook leaves
  AvailableModels fetch on Connect and merges BYOK models in unary"*.
- **`BidiAppend`** — raw client frames are posted to `/byok/bidi`, decoded
  (`decodeBidiClientMessage`), and recorded by request id
  (`ByokSessionStore.recordClientMessage`). The server replies with `handle`
  (whether the session is BYOK), `modelId`, `messageCase`, and queue sizes.
  Upstream is suppressed only for known BYOK sessions.
- **`AgentService/RunSSE` and `AgentService/Run`** — the hook asks
  `/byok/should-handle`; if `handle:false` it calls the original transport
  untouched; if `true` it calls `/byok/run` and translates the local NDJSON back
  into Cursor server messages (`eventToCursorMessages`). For `Run` (bidi) it can
  route from the first `runRequest` frame and peeks the async-iterable input
  before routing. Cursor's own client frames on that stream (exec results,
  `conversationAction`) are forwarded to the session via `drainRunInput` →
  `/byok/local-tool-result` and `/byok/local-client-message`. Tests:
  *"grey-box hook ignores stale local-agent compatibility metadata and routes
  BYOK locally"*, *"routes RunSSE locally from the RunSSE input when Bidi state
  is absent"*, *"routes AgentService Run bidi stream locally from first
  runRequest frame"*, *"peeks Connect RunSSE async iterable input before
  routing"*, *"forwards AgentService Run conversationAction frames to the local
  session"*.

## `/byok/*` control plane (`src/server/http.js`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/byok/health` | GET | `{ ok:true, byokMode, workspaceRoots }`; multi-window installs may also return `windowId` and `windowScoped`. |
| `/byok/workspace-roots` | POST | Register the current window's workspace roots. Unscoped registration replaces the owner roots; scoped registration is keyed by `x-client-wid`/`windowId`. |
| `/byok/events` | GET (SSE) | `routes` / `models` broadcasts to loaded hooks. |
| `/byok/toggle` | POST | Flip `byokMode`, persist, broadcast new routes. |
| `/byok/mode` | POST | Set `byokMode` explicitly with `{ enabled: boolean }`; persist and broadcast. |
| `/byok/debug` | POST | Record a hook debug event from the renderer (`__cursorByokDebug`). |
| `/byok/models` | GET | BYOK models (merged with empty official) when mode on, else `[]`. |
| `/byok/should-handle` | POST | Decide BYOK vs official for a run request. |
| `/byok/run` | POST | Run a BYOK turn; streams `application/x-ndjson`. |
| `/byok/bidi` | POST | Record a raw BidiAppend frame; report `handle`/`modelId`. |
| `/byok/tool-result` | POST | Block until Cursor's exec result for a tool-call id. |
| `/byok/interaction-response` | POST | Block until Cursor returns the response for an interaction query (`AskQuestion`, `SwitchMode`, `CreatePlan`, MCP auth). |
| `/byok/client-tool-completion` | POST | Block until a client-side tool completion arrives (`WebSearch`, `GenerateImage`). |
| `/byok/exec-map` | POST | Register a Cursor native exec id → tool-call id alias. |
| `/byok/local-tool-result` | POST | Record a tool result decoded from a local Run input. |
| `/byok/local-client-message` | POST | Record a non-exec client message (e.g. conversationAction). |
| anything else | any | `proxyToCursor` → `UPSTREAM_ORIGIN` (preserving method/body/headers). |

## Model Identity

Matching is candidate-based. The hook and server inspect selected/requested model
fields — `requestedModel`/`modelDetails` × `modelId`/`modelName`/`name`/`apiModel`/
`displayModelId`, plus top-level `modelId`/`model` (`extractModelCandidates`,
`src/server/http.js`). `pickModelId(candidates, providers)`
(`src/runtime/models.js`) returns the first candidate that is a configured BYOK id,
otherwise the first non-empty candidate. This avoids routing an official model
locally because of mixed metadata, while still catching BYOK public ids that
appear in different request fields. The hook seeds its local cache from embedded
`byokModels` first and falls back to embedded `byokModelIds` when no model objects
were embedded. Tests: *"model picker prefers BYOK candidate
over mixed official display fields"*, *"grey-box hook routes BYOK RunSSE by direct
model even when requestId is absent"*, *"recognizes BYOK modelName from direct
RunSSE requests"*.

## Official Path Boundary

Official models must fall through to Cursor's original transport:

- `/byok/should-handle` returns `handle:false` with `reason:"byok-mode-off"` when
  BYOK mode is off, `reason:"workspace-scope-not-registered"` when a window id is
  present but roots were not registered, `reason:"run-request-not-found"` when
  the run request never arrives, or `reason:"provider-input-not-found"` when
  provider input is still missing. Unknown models return `handle:false` without a
  `reason` field (logged server-side as `model-not-found`).
- `/byok/run` returns HTTP 404 with `{ local:false, reason:"model-not-found" }`
  for unknown models. Missing provider input returns HTTP 400 with
  `{ error:"provider-input-not-found" }`. In both cases the hook falls back to
  the original transport.
- The provider adapter is only reached after the server finds a configured
  provider/model entry **and** the request has provider input
  (`hasProviderInput`).

Tests: *"grey-box hook leaves official transport untouched and handles BYOK
sessions locally"*, *"grey-box BYOK off passes configured models through to
official Cursor"*, *"grey-box server refuses BYOK run when configured providers do
not match"*, *"server rejects BYOK runs without provider input before calling
upstream"*.
