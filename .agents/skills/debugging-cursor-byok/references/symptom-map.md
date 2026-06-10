# Symptom Map

Use this table to pick the first boundary to inspect. Do not jump to prompt changes or provider rewrites before the earlier boundary is ruled out.

| Symptom | First evidence to collect | Primary code paths | Focused verification |
|---|---|---|---|
| Cursor update, reconnect loop, install no longer works | `npm run preflight:cursor`; whether the target file still exposes a supported seam; whether the app was already patched without a pristine backup | `scripts/install-workbench-hook.js`, `src/workbench-hook.js`, `docs/routing-hook.md`, `docs/install-config.md` | `node --test tests/byok-workbench-install.test.js tests/byok-hook-transport.test.js` |
| BYOK model missing from picker or official models disappear | `AvailableModels` response shape, configured `providers.json`, embedded `byokModels`/`byokModelIds`, route mode | `src/runtime/models.js`, `src/server/http.js`, `src/workbench-hook.js` | `node --test tests/models-merge.test.js tests/byok-server-routing.test.js tests/byok-hook-transport.test.js` |
| Official model incorrectly goes through BYOK, or BYOK model bypasses local handling | `BYOK run`, `BYOK local run bypassed`, `BYOK local run rejected`, chosen model candidate fields | `src/runtime/models.js`, `src/server/http.js`, `src/workbench-hook.js`, `docs/routing-hook.md` | `node --test tests/byok-server-routing.test.js tests/byok-hook-transport.test.js` |
| Tool card starts but never completes, spinner does not end, or provider hangs waiting | `requestId`, `toolCallId`, `execId`; `BYOK waiting for Cursor exec result`; whether `BYOK local tool result` or `BYOK registered Cursor exec alias` appears | `src/workbench-hook.js`, `src/server/http.js`, `src/runtime/state.js` | `node --test tests/byok-hook-client-bridge.test.js tests/byok-runtime-session.test.js tests/byok-server-run.test.js` |
| Model claims Read/Grep/Glob is broken, truncated, or ignored `offset`/`limit` | Actual `BYOK tool call` argument keys; actual native exec payload; actual returned `readResult` / `grepResult` | `src/runtime/tools.js`, `src/server/provider-adapter.js`, `src/workbench-hook.js`, `src/server/http.js` | `node --test tests/byok-provider-tools.test.js tests/byok-provider-anthropic.test.js tests/byok-runtime-http-bridge.test.js tests/byok-hook-runtime.test.js` |
| Edit / ApplyPatch / Write behaves differently from official Cursor | Whether the run used the read-then-write bridge; whether `writeArgs.fileText` is legal and UI-only edit fields stayed out of native args | `src/workbench-hook.js`, `src/server/http.js`, `docs/provider-tools.md` | `node --test tests/byok-hook-edit.test.js tests/byok-provider-tools.test.js` |
| MCP call appears to finish but the animation or step never ends | Whether it was native MCP exec vs MCP auth; whether terminal UI messages reached `toolCallCompleted` and `stepCompleted`; whether provider-visible sanitized names still preserved original dispatch metadata | `src/workbench-hook.js`, `src/server/http.js`, `src/runtime/interaction-bridge.js`, `src/runtime/tools.js` | `node --test tests/byok-hook-mcp.test.js tests/byok-server-mcp-cache.test.js tests/interaction-bridge.test.js tests/byok-hook-todo.test.js` |
| Works locally but fails on remote workspace | Whether the shared server merged workspace roots; whether remote file access went through the workspace fs scheme; whether the same repro passes locally | `src/extension.js`, `src/server/http.js`, `docs/architecture.md` | `node --test tests/byok-extension-activation.test.js tests/byok-extension-control-plane.test.js` |
| High idle extension-host CPU | Whether the extension is still enabled after restart; whether `routes.json` reverted to broad redirects; whether the measurement came from Cursor Process Explorer under active automation | `src/constants.js`, `src/extension.js`, `docs/install-config.md` | No unit test proves this. Use real Cursor isolation: disable extension, restart Cursor, re-measure in Process Explorer, then re-enable. |

## Real UI Regression Loop

When the bug only appears in the real app:

1. Run one official-model control prompt and one BYOK prompt that do the same work.
2. Keep the prompt single-message and explicit.
3. Stop the run once the failure is clear; do not let a stalled model burn tokens.
4. Preserve the failing `requestId` and grep all BYOK logs for it before editing code.

The minimum useful BYOK tool regression is:

1. write a temp file
2. read it with explicit `offset` and `limit`
3. edit or patch it
4. read again with explicit `offset` and `limit`
5. grep for the edited content
6. glob for the file
7. delete it

If the bug is remote-only, run that sequence in both a local workspace and a remote workspace.
