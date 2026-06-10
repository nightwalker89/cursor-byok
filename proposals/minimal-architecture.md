# Minimal Hook Architecture (~600 lines)

> **Status: unimplemented proposal.** This is an exploratory design that does not
> match the current codebase — line counts and layering here are aspirational, not
> descriptive. See [`docs/architecture.md`](../docs/architecture.md) for how the
> system is actually built. Kept under `proposals/` for reference only; not shipped
> with the extension.

## Goal

Eliminate the HTTP server, session store, MCP cache, and builtin tool catalog.
Route provider calls entirely through the workbench hook using Cursor's native
Bidi channel for tool execution.

## Current vs Proposed

| Layer | Current (~3200 lines) | Proposed (~600 lines) |
|---|---|---|
| HTTP server (`http.js`) | 1219 lines | **ELIMINATED** |
| Session store (`state.js`) | 640 lines | **ELIMINATED** |
| Builtin tools (`tools.js`) | 485 lines | **CONDITIONAL** (0 if field 7 = tools) |
| Workbench hook (`hook.js`) | 2617 lines | ~400 lines |
| Provider adapter (`provider-adapter.js`) | 340 lines | ~200 lines (simplified) |
| Protobuf decoder (`cursor-protocol.js`) | 531 lines | ~200 lines (trimmed) |
| Config + constants | ~150 lines | ~100 lines |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Cursor Renderer                 │
│                                                 │
│  workbench.desktop.main.js (hook injected)      │
│  ┌───────────────────────────────────────────┐  │
│  │           wrapTransport()                 │  │
│  │                                           │  │
│  │  RunSSE/Run ──► BYOK? ──┐                │  │
│  │                         │ YES             │  │
│  │                         ▼                 │  │
│  │  ┌─────────────────────────────┐          │  │
│  │  │  Provider Call (in-hook)    │          │  │
│  │  │  • fetch() to provider API  │          │  │
│  │  │  • stream → Cursor frames   │          │  │
│  │  │  • tool_use → execServer    │          │  │
│  │  └─────────┬───────────────────┘          │  │
│  │            │ execServerMessage             │  │
│  │            ▼                               │  │
│  │  ┌─────────────────────────────┐          │  │
│  │  │  Native Cursor Execution    │          │  │
│  │  │  (read, edit, shell, mcp…)  │          │  │
│  │  └─────────┬───────────────────┘          │  │
│  │            │ execClientMessage             │  │
│  │            ▼                               │  │
│  │  ┌─────────────────────────────┐          │  │
│  │  │  Result → Provider Loop     │          │  │
│  │  │  (match by execId)          │          │  │
│  │  └─────────────────────────────┘          │  │
│  │                                           │  │
│  │  BidiAppend ──► passthrough (not BYOK)    │  │
│  │  AvailableModels ──► merge BYOK models    │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. In-Hook Provider Calls (NO HTTP Server)

The current architecture routes BYOK requests through:
```
hook → fetch(byokUrl + "/byok/run") → http.js → provider-adapter → fetch(provider API)
```

The minimal architecture calls the provider API **directly from the hook**:
```
hook → fetch(provider API) → stream → Cursor frames
```

This eliminates:
- `ByokServer` class (1219 lines)
- `ByokSessionStore` (640 lines)
- `BidiRawQueue`
- SSE event stream
- All `/byok/*` HTTP endpoints

The hook already runs in the Cursor renderer — it has full `fetch()` access.

### 2. Bidi Drain for Tool Results (ALREADY VALIDATED)

The current `drainRunInput()` function (hook.js:613) already implements Bidi drain:
- When `agent.v1.AgentService/Run` is intercepted, it reads the input async iterator
- When `execClientMessage` arrives (Cursor's native tool result), it posts to `/byok/local-tool-result`
- The server matches it with pending tool calls in `ByokSessionStore`

In the minimal architecture, the tool result matching happens **in-hook** via a `Map<toolCallId, Promise>`:

```js
const pendingToolResults = new Map(); // toolCallId → { resolve, reject }

// When provider emits tool_use:
const toolCallId = event.id;
const resultPromise = new Promise((resolve, reject) => {
  pendingToolResults.set(toolCallId, { resolve, reject });
});

// When Cursor returns execClientMessage via Bidi:
const result = pendingToolResults.get(toolCallId);
if (result) {
  result.resolve(execClientMessage);
  pendingToolResults.delete(toolCallId);
}
```

This is simpler because the provider loop can `await resultPromise` directly —
no HTTP round-trip, no session store, no exec alias mapping.

### 3. Edit Bridge (UNAVOIDABLE, ~80 lines)

The `old_string`/`new_string` → full-file-write conversion is protocol-level and
cannot be eliminated. However, the current ~300-line edit bridge can be simplified
to ~80 lines since we no longer need:
- HTTP server coordination
- Session store exec aliases
- `postLocalToolResult` round-trips

The edit bridge becomes a simple:
```
1. Intercept Edit/Write/ApplyPatch tool_use
2. If Edit: Read the file first (emit readArgs execServer), await readResult
3. Compute new file content from old_string/new_string
4. Emit writeArgs execServer with full file content
5. Await writeResult from Bidi stream
6. Return result to provider loop
```

### 4. MCP Tools (CONDITIONAL on Field 7)

**If `runRequest` field 7 = builtin tool catalog:**
- Eliminate `CURSOR_BUILTIN_TOOLS` (485 lines) entirely
- Read tool definitions from the protobuf runRequest
- MCP tool schemas come from field 4 (`mcpTools`) — already decoded

**If field 7 ≠ tool catalog:**
- Keep a minimal `CURSOR_BUILTIN_TOOLS` with only the tools the provider needs
- MCP cache loading is still needed but can be done in-hook (read `~/.cursor/projects/` directly)
- ~200 lines instead of 485 (strip descriptions to 1-liners)

### 5. Config Loading (SIMPLIFIED)

Currently: HTTP server reads `providers.json`/`routes.json` from `~/.cursor-byok/`.
Minimal: Hook reads them directly via `fs` (the hook has access to `require('fs')`
in the Electron renderer via `__webpack_require__` or Cursor's module system).

Alternative: Use `localStorage` or a VS Code setting for provider config,
since the hook runs in the renderer where VS Code settings are accessible.

## Module Structure (~600 lines)

### `workbench-hook.js` (~400 lines)

```
hookRuntime(config)
├── wrapTransport()                    // ~30 lines
│   ├── AvailableModels merge          //   (keep as-is)
│   ├── RunSSE/Run intercept           //   (simplified — no HTTP fetch)
│   └── BidiAppend passthrough         //   (keep as-is)
├── byokProviderLoop(requestId, req)   // ~150 lines (NEW — replaces http.js)
│   ├── fetch(provider API)            //   direct provider call
│   ├── stream → Cursor frames         //   SSE/NDJSON → protobuf
│   ├── tool_use → execServerMessage   //   emit to Cursor
│   ├── await toolResult from Bidi     //   drain pattern
│   └── loop until done                //   multi-turn
├── editBridge()                       // ~80 lines (simplified)
├── mcpBridge()                        // ~40 lines (simplified)
├── execServerMessage helpers          // ~60 lines (keep)
├── frame builders                     // ~40 lines (keep)
└── config/bootstrap                   // ~30 lines (simplified)
```

### `provider-adapter.js` (~200 lines)

```
ProviderAdapter
├── callProvider(messages, tools)       // ~80 lines
│   ├── Anthropic Messages stream
│   ├── OpenAI Chat/Responses stream
│   └── Return async iterable of events
├── toAnthropicTools() / toOpenAiTools()  // ~40 lines
└── Schema normalization             // ~80 lines
```

### `cursor-protocol.js` (~200 lines)

Keep only the decoders needed for in-hook use:
```
decodeAgentRunRequest()                // ~60 lines (with field 6/7)
decodeExecClientMessage()              // ~30 lines
decodeFields / readVarint              // ~40 lines
Helpers (firstBytes, firstString…)     // ~70 lines
```

Eliminate: `decodeBidiClientMessage` (no longer needed — we read from the
Bidi stream directly), `decodeGrepResult`, `decodeShellStream` (these are
Cursor-internal details we don't need to parse in the minimal arch).

## Validation: Bidi Drain Approach

### Confirmed Feasible ✅

The Bidi drain approach is **already implemented and working** in the current
codebase (`drainRunInput`, line 613 of workbench-hook.js). The key insight:

1. `agent.v1.AgentService/Run` is a **bidirectional streaming** gRPC call
2. The Cursor renderer sends `execClientMessage` on this stream
3. The hook intercepts this stream via `wrapTransport().stream()`
4. `drainRunInput()` reads `execClientMessage` from the input async iterator
5. Results are matched to tool calls by `execId` / `toolCallId`

### What Changes in Minimal Architecture

| Aspect | Current | Minimal |
|---|---|---|
| Result matching | HTTP server + `ByokSessionStore` | In-hook `Map<toolCallId, Promise>` |
| Result routing | `postJson("/byok/local-tool-result")` | Direct `promise.resolve()` |
| Exec alias mapping | Server-side `registerExecAlias` | In-hook `state.execIdToToolCallId` |
| Session state | `ByokSessionStore` (640 lines) | Local `Map` + closure (~20 lines) |
| Provider loop | Server-side `handleLocalRun` | In-hook `byokProviderLoop` |

### Risk: RunSSE vs Run

Currently, `RunSSE` doesn't use `drainRunInput` — only `Run` does. The
`RunSSE` path sends tool calls to the HTTP server, which executes them and
returns results. In the minimal architecture, we need to handle both:

- **Run**: Already works with Bidi drain. The input stream is available.
- **RunSSE**: The input is NOT a stream — it's a single request. Tool results
  must come via a separate mechanism. Options:
  1. Convert RunSSE to use the same Bidi drain pattern (add a `BidiAppend`
     listener for the requestId)
  2. Only support `Run` and force Cursor to use it (via the hook)
  3. Use the `BidiAppend` interception that already exists — the hook
     intercepts `BidiAppend` at line 1832 and can read `execClientMessage`
     from there

Option 3 is the simplest: the `BidiAppend` interception already captures
`execClientMessage` results and posts them to the server. In the minimal
architecture, we post them to the in-hook `pendingToolResults` Map instead.

## Elimination Summary

| Component | Lines | Eliminated? | Notes |
|---|---|---|---|
| `ByokServer` | 1219 | ✅ YES | Provider calls move in-hook |
| `ByokSessionStore` | 640 | ✅ YES | Replaced by `Map<toolCallId, Promise>` |
| `BidiRawQueue` | 50 | ✅ YES | No HTTP server to queue for |
| `CheckpointStore` | 30 | ✅ YES | Not needed — Cursor handles checkpoints natively |
| `CURSOR_BUILTIN_TOOLS` | 485 | ⚠️ CONDITIONAL | Eliminated if field 7 = tools |
| `loadCursorMcpToolsFromCache` | 80 | ⚠️ CONDITIONAL | Eliminated if field 4 has MCP tools at request time |
| `appendMcpTools` | 50 | ⚠️ CONDITIONAL | Same as above |
| HTTP endpoints | 200 | ✅ YES | All `/byok/*` endpoints eliminated |
| SSE event stream | 40 | ✅ YES | No server to broadcast from |
| `normalizeToolArgs` | 200 | 🔶 SIMPLIFIED | Still needed but can be trimmed |
| `editBridge` | 300 | 🔶 SIMPLIFIED | Trimmed to ~80 lines |
| `eventToCursorMessages` | 400 | 🔶 TRIMMED | Keep only tool_use/frame logic |

## Open Questions

1. **Field 7 content**: Does `runRequest` protobuf field 7 contain the builtin
   tool catalog? If yes, `CURSOR_BUILTIN_TOOLS` (485 lines) is eliminated.
   **Requires runtime validation.**

2. **Provider API in renderer**: Can the hook call `fetch()` to external APIs
   (api.anthropic.com, api.openai.com) from the Cursor renderer? Likely yes —
   Electron renderers have full network access. But CORS may be an issue.
   **Needs testing.**

3. **Config access in hook**: How does the hook read `providers.json`? Options:
   - Read from `~/.cursor-byok/providers.json` via Node.js `fs` (if available)
   - Use a VS Code extension to expose config to the renderer
   - Embed config in the hook string itself (regenerated on install)

4. **RunSSE tool result flow**: Does the BidiAppend interception reliably
   deliver `execClientMessage` results for RunSSE-based runs? The current
   implementation uses it for `Run` but RunSSE uses a different path.
   **Needs testing.**
