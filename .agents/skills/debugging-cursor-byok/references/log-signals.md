# Log Signals

Primary log files:

- BYOK file log: `~/.cursor-byok/cursor-byok.log`
- Cursor UI logs: `~/Library/Application Support/Cursor/logs/<timestamp>/...`
- Cursor output channel: `Cursor BYOK`

When possible, grep by `requestId` first and then correlate `toolCallId`, `execId`, and `conversationId`.

## High-signal BYOK log lines

### Routing and install

- `BYOK server`
  - The extension host started or attached to a server. Check host, port, and whether it probed away from the base port.
- `BYOK server probe failed`
  - Port probing or bind setup failed near the configured port.
- `BYOK hook installed`
  - Install path succeeded. If behavior is still wrong after this, verify Cursor was restarted and the target build still matches `preflight`.
- `BYOK original workbench restored`
  - Restore path ran. Use this only when a pristine backup existed.
- `BYOK request failed: HTTP ...` or `BYOK request failed: ...`
  - The hook could not reach the local server or the server returned an error. Check whether the server is running and whether the embedded host/port still matches runtime config.

### Route decision

- `BYOK run`
  - The provider adapter was reached. An official-model control run should not log this.
- `BYOK local run bypassed`
  - The request stayed on Cursor's official path. Inspect the reported reason before changing provider code.
- `BYOK local run rejected`
  - The hook attempted local routing, but the server refused to proceed. Common causes are `model-not-found` or missing provider input.

### Native tool completion

- `BYOK tool call`
  - The upstream provider emitted a tool call. For Read issues, inspect `argumentKeys`, `readHasPath`, `readHasOffset`, and `readHasLimit`.
- `BYOK waiting for Cursor exec result`
  - The provider loop is blocked on native exec completion.
- `BYOK registered Cursor exec alias`
  - A native `execId` was mapped back to the provider `toolCallId`.
- `BYOK local tool result`
  - A Cursor exec result was decoded from the local Run input path and handed to the session store.
- `BYOK returning Cursor exec result`
  - Native exec correlation worked and the provider loop resumed.
- `BYOK Cursor exec result timed out`
  - The waiter never observed the expected native result. Check `drainRunInput`, alias registration, `waitForExecResult`, and whether the tool really completed in Cursor.

### Interaction and client-side tools

- `BYOK waiting for Cursor interaction response`
  - `AskQuestion`, `SwitchMode`, `CreatePlan`, or MCP auth is waiting on Cursor interaction UI.
- `BYOK returning Cursor interaction response`
  - The interaction waiter resolved normally.
- `BYOK Cursor interaction response timed out`
  - The interaction query never came back. Inspect interaction-query generation and response wiring before touching provider prompts.
- `BYOK waiting for Cursor client tool completion`
  - `WebSearch` or `GenerateImage` is waiting on the client-tool bridge.
- `BYOK Cursor client tool completion timed out`
  - The client-side completion never arrived. Inspect `src/runtime/client-tool-bridge.js` and the hook-side completion path.

### Provider-visible text and result shaping

- `BYOK provider-visible tool result`
  - The runtime reformatted a native Cursor result into model-visible text. If the model describes the wrong output, inspect this before changing schema text.
- `BYOK using direct Read result`
  - A Read result was already available in the current path and was returned directly rather than waiting on a second hop.
- `BYOK NDJSON line exceeds ... bytes`
  - The local provider stream emitted a line larger than the hook accepts. This is a transport-size issue, not a prompt issue.

## What not to infer

- A provider saying "tool output was truncated" does not prove runtime truncation. Compare the actual tool args and actual Cursor exec result first.
- Seeing `toolCallStarted` in the UI does not prove completion wiring works. You still need `toolCallCompleted` and `stepCompleted`.
- A hot extension-host process observed during active Computer Use inspection does not prove the BYOK extension is the root cause. Measure again with the extension disabled after a restart.
