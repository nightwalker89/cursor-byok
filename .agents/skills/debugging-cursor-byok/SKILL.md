---
name: debugging-cursor-byok
description: Use when debugging this repository's Cursor BYOK behavior: workbench hook install failures, missing models, BYOK/official misrouting, remote workspace regressions, stalled tool calls, Read offset/limit complaints, MCP completion hangs, reconnect loops, or suspicious extension-host CPU.
---

# Debugging Cursor BYOK

This repository tends to break at five boundaries. Find the first broken boundary before changing code:

1. install seam (`scripts/install-workbench-hook.js`, patched Cursor bundle)
2. route decision (official model vs BYOK model)
3. run/session correlation (`RunSSE`/`Run` + `BidiAppend` + request ids)
4. native Cursor tool completion (exec ids, interaction responses, client-tool completions)
5. provider-visible schema/result text (what the upstream model actually saw)

## Start Here

- Reproduce once in a real Cursor window before editing code. Prefer one official-model control run and one BYOK run for the same task.
- Capture `requestId`, `conversationId`, `toolCallId`, and, when present, `execId` from BYOK logs.
- Use [references/symptom-map.md](references/symptom-map.md) to choose the boundary.
- Use [references/log-signals.md](references/log-signals.md) to interpret specific log lines.

## Evidence Rules

- Trust Cursor logs, BYOK logs, current source, and current tests over model narration. A provider claiming "Read was truncated" is not evidence by itself.
- For tool issues, inspect all three layers: provider tool args, native exec message emitted by the hook, and Cursor exec result returned to the provider.
- For UI hangs, do not stop at `toolCallStarted`; confirm the terminal sequence reaches `toolCallCompleted` and `stepCompleted`.
- For remote-only bugs, verify the same scenario locally first.
- For high CPU, isolate by disabling the extension and restarting Cursor. A window under active accessibility or Computer Use inspection is not a clean CPU signal.

## Fast Paths

- Hook / install / reconnect after Cursor update:
  - run `npm run preflight:cursor`
  - if supported, run `npm run install:cursor`
  - only use `npm run restore:cursor` when a pristine backup was captured earlier
  - read `docs/routing-hook.md` and `docs/install-config.md`
- Model missing or wrong route:
  - inspect `src/runtime/models.js`, `src/server/http.js`, and `src/workbench-hook.js`
  - run the model/routing tests listed in the symptom map
- Tool stalls, empty results, or stuck spinner:
  - inspect `drainRunInput`, `/byok/local-tool-result`, `/byok/interaction-response`, `/byok/client-tool-completion`, and `/byok/exec-map`
  - verify the relevant waiter in `src/runtime/state.js` resolves
- Read / Grep / Glob complaints:
  - verify the schema in `src/runtime/tools.js`
  - verify provider-visible result text in `src/server/provider-adapter.js`
  - verify native exec payloads in `src/workbench-hook.js`
- MCP problems:
  - separate native MCP exec completion from MCP auth and provider-visible sanitized names
  - inspect `tests/byok-hook-mcp.test.js`, `tests/byok-server-mcp-cache.test.js`, and `tests/interaction-bridge.test.js`
- Remote workspace regressions:
  - inspect `tests/byok-extension-activation.test.js` and `/byok/workspace-roots`
  - verify the same path on a remote window, not only locally

## When Comparing With `old`

The `old` branch is a reference for intended behavior, not proof that a direct port is correct. If a fix idea comes from `old`, re-prove it against current `main` source paths and current tests before shipping it.

## Read Next

- `docs/architecture.md`
- `docs/routing-hook.md`
- `docs/provider-tools.md`
- `docs/verification.md`
- [references/symptom-map.md](references/symptom-map.md)
- [references/log-signals.md](references/log-signals.md)
