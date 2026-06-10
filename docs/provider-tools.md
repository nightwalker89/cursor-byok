# Provider and Tools

[中文版](provider-tools_CN.md)

## Provider APIs

`src/server/provider-adapter.js` (`ProviderAdapter.run`) dispatches on
`provider.type`:

- `openai-chat` (default) → `client.chat.completions.create({ stream:true, … })`
  (`runOpenAi`).
- `openai-responses` → `client.responses.create({ stream:true, … })`
  (`runOpenAiResponses`).
- `anthropic` → `client.messages.stream({ … })` (`runAnthropic`).

Each client is constructed lazily from the provider entry. OpenAI-compatible
providers use `Authorization: Bearer <auth.value>` by default (or the
`OPENAI_API_KEY` env, else `"unused"`). When `auth.kind === "api-key"`, both
Chat and Responses requests send `api-key: <auth.value>` and explicitly suppress
the OpenAI SDK's automatic Bearer header. Anthropic providers use
`provider.auth.value` (or `ANTHROPIC_API_KEY`, else `"unused"`). All providers
use `baseURL` = `provider.baseUrl` and merge `provider.headers` into the SDK
default headers. The model sent to the API is `model.apiModel || model.id`;
OpenAI-compatible Chat and Responses requests set `parallel_tool_calls:true` and
do not set a completion-token cap by default; the provider decides its normal
output budget. OpenAI Chat also requests streaming usage with
`stream_options:{include_usage:true}` so the final empty-choices usage chunk can
populate Cursor `turnEnded` usage. Anthropic requests send `max_tokens =
model.maxOutputTokens || 8192` because that API requires a generation limit.

The adapter builds provider messages from the decoded run request
(`buildPrompt` → `normalizeProviderMessage`), prepends the system prompt, appends
**BYOK-only** prompt rules for configured BYOK models
(`appendByokPromptRules`, gated by `isByokModel`, idempotent via the
`<cursor_byok_prompt_compatibility>` marker; rules text =
`byok-system-prompt.md`), normalizes tool schemas, then loops: stream events →
on `tool_use_done`, pause and `waitForToolResult(toolCallId)` → push the result
back into provider history → continue until no tool calls remain.

- **OpenAI prompt cache**: `withOpenAiPromptCacheKey` sets
  `prompt_cache_key = conversationId` when a conversation id is present
  (`src/runtime/cache.js`; covered by the OpenAI Chat request-shape assertions
  in *"OpenAI provider loop sends Cursor exec result back as provider tool
  result"* and by *"OpenAI Responses provider loop uses responses API with
  conversation prompt cache key"*).
- **Anthropic**: assistant tool-use turns are rebuilt as `tool_use` content
  blocks and results returned as `tool_result` user content; message
  cache-control objects are passed through (`preserveAnthropicCacheControl`).
- Before each provider API call, prior tool history is converted to that API's
  native shape: OpenAI Chat receives `assistant.tool_calls` + `role:"tool"`,
  OpenAI Responses receives `function_call` + `function_call_output` items, and
  Anthropic receives `tool_use` + `tool_result` content blocks. OpenAI Chat
  `tool_calls[].type:"custom"` history is preserved as Chat `custom` calls,
  converted to Responses `custom_tool_call` items, and converted to Anthropic
  `tool_use` blocks with non-object custom input wrapped as `{input:<text>}`;
  native Responses `custom_tool_call` history follows the same Chat and
  Anthropic conversions while remaining native for Responses, including when
  it appears inside an assistant message content array.
  Structured prior tool-result content is converted to the target API shape:
  OpenAI Chat tool messages and Responses function outputs receive text, while
  Anthropic keeps valid text/image/document content blocks and flattens
  Cursor/MCP-only blocks to text. Native Responses input/output items are
  preserved only when the next call also uses Responses, but native Responses
  `message` content is still normalized to legal role-specific `input_*` or
  `output_text` / `refusal` blocks before sending. When native Responses
  `reasoning` is converted to Chat or Anthropic, only public `summary_text` is
  textified, and raw `reasoning_text` / `encrypted_content` is not forwarded.
  Native Anthropic
  `thinking` / `redacted_thinking` blocks are
  preserved only when the next call also uses Anthropic; when converted to
  OpenAI Chat or Responses, `redacted_thinking.data` and thinking signatures are
  not forwarded.
- During tool loops, provider-private history items are not exposed as normalized
  UI events, but same-provider follow-up requests preserve required private
  context: native Responses items from the same turn are reinserted into the
  next Responses `input`, and Anthropic `thinking` / `redacted_thinking` blocks
  are reinserted into the next Anthropic assistant message before the
  corresponding tool result.
- Provider tool-result history stays Cursor-shaped internally, but before the
  next provider round several high-value native results are converted into
  provider-visible text by `stringifyToolResultForProvider` (see *Tool Results*).

### Normalized stream events

The per-provider collectors emit a single event vocabulary consumed by the hook:
`text_delta`, `thinking_delta`, `thinking_done`, `tool_use_start`,
`tool_use_delta`, `tool_use_done` (carries the **accumulated** `arguments`
string), and a terminal `done` (`stopReason` + token `usage`).
OpenAI Chat `prompt_tokens_details.cached_tokens` and Responses
`input_tokens_details.cached_tokens` are mapped to the shared
`usage.cacheReadTokens` field; Anthropic cache read/write usage is mapped from
`cache_read_input_tokens` / `cache_creation_input_tokens`.

- `streamOpenAiEvents` — accumulates modern
  `choices[].delta.tool_calls[].function.arguments` by index/id, Chat custom
  `choices[].delta.tool_calls[].custom.input`, and legacy
  `choices[].delta.function_call.arguments`; emits `tool_use_done` on
  `finish_reason==="tool_calls"` or `finish_reason==="function_call"`. BYOK
  exposes Cursor tools to OpenAI Chat as `function` tools, so runtime Chat
  `custom` tool calls are returned as provider-visible tool errors and are not
  dispatched to Cursor native exec. Natural
  `finish_reason:"stop"` is normalized to `stopReason:"end_turn"`, while
  non-tool terminal reasons such as `length` and `content_filter` are preserved
  as the terminal `done.stopReason`.
- `streamOpenAiResponsesEvents` — maps `response.output_text.delta`,
  `response.function_call_arguments.delta/.done`, `response.output_item.added`,
  and `response.output_item.done`, including done-only and standalone
  function-call argument events. It also recognizes Responses
  `custom_tool_call` / `response.custom_tool_call_input.*` events, but BYOK only
  advertises Cursor tools to Responses as `function` tools; custom-tool calls are
  returned to the provider as `custom_tool_call_output` errors and are not
  dispatched to Cursor native exec. Public Responses reasoning summaries
  (`response.reasoning_summary_text.*`,
  `response.reasoning_summary_part.done`, and reasoning `summary[]` on
  `response.output_item.done`) are forwarded as `thinking_delta` followed by one
  `thinking_done`; raw `response.reasoning_text.*` and `reasoning_text` content
  are not forwarded as text or thinking. Native Responses output items that are
  valid follow-up input items are preserved as provider-private history for
  same-provider tool loops, including `file_search_call`, `web_search_call`,
  `tool_search_output`, and `function_call_output`. Terminal Responses failures
  (`error`, `response.failed`, and `response.incomplete`) become a provider-visible
  `text_delta` plus `done` with `stopReason:"error"` instead of being reported as
  a normal end turn.
- `streamAnthropicEvents` — maps `content_block_start/delta/stop`, preserving a
  `tool_use.input` object when Anthropic sends one on `content_block_start`, and
  otherwise accumulating `input_json_delta.partial_json` so `tool_use_done`
  carries the final JSON; it also surfaces `thinking` blocks.

Each `tool_use_done` is logged with `argumentKeys` and (for `Read`) `readHasPath`/
`readHasOffset`/`readHasLimit` (`this.log.info("BYOK tool call", …)`), which the
UI-regression checks rely on. Test *"provider stream collectors preserve tool
names for native Cursor exec dispatch"*.

## Tool Catalog

When the decoded run request has no tools, the adapter supplies only the default
schemas that BYOK can execute through Cursor or complete locally
(`defaultCursorBuiltinTools` → `CURSOR_BUILTIN_TOOLS`, `src/runtime/tools.js`,
source of truth `DEFAULT_PROVIDER_TOOL_NAMES`):
Shell, Glob, Grep, LS, AwaitShell, Read, Delete, Edit, ApplyPatch, Write,
EditNotebook, TodoWrite, ReadLints, WebFetch, WriteShellStdin,
ListMcpResources, FetchMcpResource, AskQuestion, SwitchMode, CallMcpTool, and
CreatePlan. `Task` / `Subagent` launch tools and `RecordScreen` / `ComputerUse`
are not exposed to providers in BYOK mode, even if Cursor includes them
explicitly. Explicit Cursor tool schemas in the request are preserved instead of
appending the full default set, but BYOK appends its own interaction bridge tools
(`AskQuestion`, `SwitchMode`, `CreatePlan`) when Cursor's explicit list omits
them. Explicit client-side tools that remain provider-visible (`WebSearch`,
`GenerateImage`) are completed through the client-tool bridge, while filtered or
unknown tools return local terminal errors instead of hanging the provider loop
(tests *"provider prompt uses Cursor built-in tool schemas when Run request has
no tools"*, *"…preserves explicit Cursor tool schemas instead of appending
defaults"*, *"…preserves explicit client-bridge Cursor tool schemas"*, and
*"server exposes BYOK interaction bridge tools alongside explicit Cursor tools"*).
Cursor `mcpTools` are still merged into explicit tool lists, with
`providerIdentifier`/`toolName` metadata kept so provider-visible direct
MCP calls can be executed through Cursor's native MCP bridge. Provider-visible
tool names may be sanitized for API tool-name rules, but execution metadata is
not derived from that sanitized name when explicit/cached metadata exists (tests
*"server merges Cursor MCP tools into explicit provider tools without losing
dispatch metadata"* and *"server preserves dotted MCP provider identifiers
behind sanitized provider tool names"*).

`WebSearch` and `GenerateImage` are **not** part of the default provider tool
catalog (`DEFAULT_PROVIDER_TOOL_NAMES`). BYOK only forwards them when Cursor
explicitly included them in the run request, and then completes them through the
client-tool bridge rather than a native exec envelope.

Each schema's keys are the load-bearing contract the model must obey:
Shell = `{command, description?, working_directory?, block_until_ms?}`; Glob =
`{glob_pattern, target_directory?}`; LS =
`{path?, target_directory?, ignore?, ignore_globs?}`; Grep = `{pattern, path?,
glob?, type?, output_mode?, -i?, -A?, -B?, -C?, multiline?, head_limit?,
offset?}`; AwaitShell = `{shell_id?, task_id?, block_until_ms?}`; Read =
`{path, offset?, limit?}`; Delete = `{path}`; Edit =
`{path, old_string, new_string, replace_all?}`; ApplyPatch = `{patch}`; Write =
`{path, contents}`; EditNotebook =
`{target_notebook, cell_idx, new_string, old_string?, is_new_cell?,
cell_language?}`; TodoWrite = `{todos, merge?}`; ReadLints = `{paths?}`;
WebFetch = `{url}`; WriteShellStdin = `{shell_id, chars}`; AskQuestion =
`{questions, title?}`; ListMcpResources = `{server?}`; FetchMcpResource =
`{server, uri, downloadPath?}`; SwitchMode =
`{target_mode_id, explanation?}`; CallMcpTool =
`{name, args, providerIdentifier, toolName}`; CreatePlan =
`{name?, overview?, plan?, todos?, isProject?, phases?}`.

`TodoWrite` is only the internal progress checklist; its todo items accept
`id`, `content`, and `status`, not `dependencies`. `CreatePlan` is the user-
visible plan artifact and its todos may include `dependencies`, so models must
not copy `CreatePlan` todo objects into `TodoWrite` unchanged.

Before going to a provider, `normalizeTools` runs every schema through
`coerceProviderToolSchema` (`normalizeProviderJsonSchema` + closed objects;
enum type tokens `OBJECT/STRING/…` → JSON types, `additionalProperties:false` on
closed objects, recursion through `properties`/`items`/`anyOf`/etc.; top-level
combinator properties are merged for provider compatibility, `allOf` branch
`required` keys are unioned, and `oneOf`/`anyOf` branch-local `required` keys are
not unioned). Descriptions pass through
`sanitizeProviderVisiblePromptText` (Anthropic-only:
`ReadFile`→`Read`, `read_file`→`Read`, `filePath`→"an unsupported alternate key").
Provider request builders reuse that normalized schema and description instead
of recursively coercing or sanitizing them again on every loop iteration.
Read's schema text is explicit about `path`/`offset`/`limit`
(`READ_TOOL_DESCRIPTION`) and tells the model to prefer `Grep` before `Read`
for symbol / definition / callsite lookup in large files — prompt-compatibility
guidance, **not** a replacement for Cursor's native Read. Tests: *"Read schema
tells model exact offset and limit contract"*, *"provider request builders reuse
normalized tool metadata without per-call recoercion"*, and *"provider JSON
schemas normalize recursively and close object schemas"*.

## Native Tool Execution

The hook turns a `tool_use_done` event into Cursor-native messages
(`eventToCursorMessages` / `execServerMessage` in `src/workbench-hook.js`): a
`toolCallStarted` UI message (typed by `cursorToolTypeForName`: Read→`readToolCall`,
Edit/ApplyPatch/EditNotebook/Write→`editToolCall`, Delete→`deleteToolCall`,
Grep→`grepToolCall`, Glob→`globToolCall`, Shell→`shellToolCall`,
GenerateImage→`generateImageToolCall`, AwaitShell→`awaitToolCall`, …) and, where
supported, a native `execServerMessage` whose `message.case` is the native exec
args:

| Tool | Native exec |
|------|-------------|
| `Read` / `ReadFile` | Direct BYOK workspace read first (`directToolResultForEvent` with `directOnly: true` → `/byok/tool-result`); native `readArgs` with `path`, `toolCallId`, optional `offset`, `limit`, `encodingHint` is the fallback when direct read cannot serve the request. |
| `Grep` | `grepArgs`, preserving output mode, context (`-A/-B/-C`), type, glob, head limit, sort, multiline, offset. |
| `Glob` | UI `globToolCall`, native `grepArgs` with `outputMode:"files_with_matches"`. |
| `Shell` | `shellStreamArgs`. |
| `Delete` | `deleteArgs`. |
| `Write` | UI `editToolCall`, native `writeArgs` with full `fileText`. |
| `Edit` / `ApplyPatch` / `EditNotebook` | read-then-write **bridge** (below). |
| `ReadLints`, MCP resource/tool calls | their native exec args when Cursor exposes one. Provider-visible direct MCP tools are rewritten at execution time to `CallMcpTool` with the original tool input under `args`. |
| `AskQuestion`, `SwitchMode`, `CreatePlan` | Cursor interaction-query bridge; no native exec. |
| `AwaitShell` | Native await only when `shell_id`/`task_id` is present; otherwise a local error result. |
| unknown or filtered tools | UI completion + a local **error** result. |

`AwaitShell` only emits native `subagentAwaitArgs` when the model provides
`shell_id` or `task_id`. Despite older tool descriptions that implied a
sleep-only mode, the current runtime treats missing ids as an error:
`awaitShellLocalResult` returns
`AwaitShell requires shell_id or task_id from a previous background shell or
subagent result.` instead of fabricating a local success. When an id is present,
`block_until_ms`/`blockUntilMs` is clamped to `[0,300000]` (default `30000`) and
the local completion payload echoes that task id. Unsupported unknown, filtered,
or schema-rejected provider tool calls still emit a `tool_use_done` event with
`localResult.case:"unsupportedToolResult"`; the hook converts that into
`toolCallCompleted`, posts it through `/byok/local-tool-result`, and does not
emit native exec. This keeps both the Cursor UI and the provider loop terminal
instead of hanging. Tests: *"hook runtime emits native Read tool start and exec
messages with offset and limit"*, *"maps Glob to Cursor-native grepArgs files
search"*, *"hook runtime returns local AwaitShell error without readArgs bridge
when ids are missing"*, *"hook runtime terminates exposed unsupported tools with
explicit local errors"*, *"hook runtime completes provider-local tool errors
without native exec"*, and *"grey-box unknown provider tool returns local error
result instead of stalling provider"*.

Native exec ids are correlated back to the provider tool-call id via
`/byok/exec-map` aliases (`ByokSessionStore.registerExecAlias`; test *"HTTP exec
map endpoint lets Bidi results wake BYOK tool waiters by native id"*).

## Behavior Differences

This adapter intentionally prefers "close to Cursor" over "perfect simulation of
unknown private behavior." In practice that means:

- When Cursor exposes a native exec envelope, BYOK uses it.
- When Cursor does **not** expose the exact provider-facing tool shape, BYOK
  bridges or rewrites just enough to keep the run moving.

Today the load-bearing differences are:

- `Edit`, `ApplyPatch`, `EditNotebook` are not forwarded as raw native write
  calls; they are decomposed into read → local transform → write.
- `Glob` is implemented through native grep in `files_with_matches` mode.
- Interaction tools and client-side tools (`AskQuestion`, `SwitchMode`,
  `CreatePlan`, `WebSearch`, `GenerateImage`, MCP auth) cross dedicated BYOK
  bridge endpoints, so their timing / result wording can differ slightly from
  Cursor's own first-party provider path.
- Unsupported unknown or filtered tools fail explicitly instead of attempting a guessed
  emulation.

If exact parity for a specific built-in tool matters, verify it against the
official model path with a real UI regression, not only unit tests.

## Edit Bridge

`Edit`, `ApplyPatch`, and `EditNotebook` are bridged rather than sending provider
arguments straight to Cursor `writeArgs`, because their provider-facing args are
not legal native `writeArgs`. The bridge:

1. Emits the original edit-style UI tool call (`editToolCall`).
2. Executes an internal native `readArgs` for `<tool-id>-read`.
3. Computes the final full file content locally (apply the edit/patch to the read
   content; `normalizeTextForEdit`/`restoreLineEnding`).
4. Executes native `writeArgs.fileText` for `<tool-id>-write`.
5. Records the original provider tool id as an `editResult`.

This keeps provider-facing tools expressive while keeping the native Cursor
protobuf arguments legal, and never leaks UI-only edit fields into native
`writeArgs` (tests *"executes ApplyPatch through read-then-write bridge with
proto-valid writeArgs"*, *"executes Edit through read-then-write bridge with final
fileText"*, *"never puts UI-only edit fields into native writeArgs"*).

## Tool Results

Provider history does **not** always receive raw Cursor JSON anymore.
`stringifyToolResultForProvider` converts several result types into
provider-visible text and falls back to bounded JSON only for unhandled cases:

- `shellResult` — rendered with Cursor's official agent-exec templates.
  Background: `The command did not complete in <ms>ms and was sent to the
  background.` plus `Shell ID: <id>`, optional `PID:`, the background reason, and
  the `Call AwaitShell with {"shell_id":"<id>"} ... Don't mention Shell ID to the
  user.` follow-up. Foreground: `Exit code: <n>`, a fenced combined
  (interleaved/stdout+stderr) `Command output` block middle-out truncated at
  20000 chars, a `Command completed[ in <ms> ms].` / `Command aborted...` line,
  and the shell-state persistence epilogue (`Shell state (cwd, env vars)
  persists for subsequent calls. Current directory: <cwd>`).
- `readResult` — success returns the file path, source line range, and numbered
  content (if Cursor did not already number it), `File is empty.`, oversize
  guidance, or blob-only guidance telling the model to retry with
  `offset`/`limit`. BYOK does not apply a second inline-content cap to Cursor
  Read content; Cursor's own `exceededLimit`/blob/range behavior decides how much
  file text is model-visible. The BYOK prompt uses Cursor's own "CODE REFERENCES
  vs MARKDOWN CODE BLOCKS" framing and requires the model to turn these `File:` /
  `Lines:` coordinates into Cursor source-code fence headers
  (`startLine:endLine:filepath`) when quoting file-backed code. The opening fence
  must start at column 1 with no leading spaces, must be a top-level block, and
  must substitute real line numbers and file paths rather than the literal
  placeholder words `startLine`, `endLine`, or `filepath`, for example:

```12:18:/absolute/path/file.go
if bt.Spec.Priority == "high" {
  continue
}
```

  It must not echo `File:` / `Lines:` as plain assistant prose when quoting the
  snippet. File-backed code citations must include exact line information so
  Cursor can render the same clickable code cards as official models.
- `grepResult` — formatted workspace/content/files/count summaries instead of the
  raw exec envelope. When the originating tool is `Glob`, the same native result
  is rendered with Cursor's official Glob template instead: `Result of search in
  '<path>' (total N files):` followed by `- file` lines under a 5000-char budget
  with the official `... N more files ... (Do a more specific search if needed)`
  truncation tail.
- `mcpResult`, `listMcpResourcesExecResult`, `readMcpResourceExecResult`,
  `mcpAuthResult` — human-readable MCP/resource/auth summaries.
- `todoWriteResult` — the model sees a compact todo list with status labels,
  not the raw local result envelope.
- `writeResult` — `Wrote contents to <path>` (official template); `deleteResult`
  — `Successfully deleted file: <path> (<size> bytes)` plus the official
  `fileNotFound`/`notFile`/`permissionDenied`/`fileBusy` arms;
  `writeShellStdinResult` — `Successfully wrote to shell <id> stdin.`;
  `subagentAwaitResult` — `Task completed in <ms>ms with exit code: <n>.` /
  `Task complete.` / `Task still running after <ms>ms...` with
  `output_file_path:` / `output_length:` trailers; `diagnosticsResult` —
  Cursor's official ReadLints render (`Found N linter error(s) in M file(s):`
  with `[SEVERITY] L<line>:<col> - message (source)` entries, the stale-lint
  `<system_reminder>`, `No linter errors found.` for clean results, and
  `Error: <message>` failures; unfiltered flat native shapes are reduced to
  ERROR/WARNING first, matching the agent-exec wrapper); `lsResult` — Cursor's
  official directory tree (`<absPath>/` root, `- name/` entries, collapsed
  subtrees with `[N files in subtree: 3 *ts, ...]` extension counts, 10000-char
  budget with the official depth-0 fallbacks); `fetchResult` — `# Content from
  <url>` plus markdown truncated at 30000 chars with the official
  `...[N line(s) truncated]` tail; `editResult`, `recordScreenResult`,
  `computerUseResult`, `requestContextResult`, and `unsupportedToolResult` —
  common success/error arms become concise status or output text; unknown
  shapes still fall back to bounded JSON.
- local `awaitResult` aliases are normalized to `subagentAwaitResult` before
  provider-visible formatting.
- `byokInteractionToolResult` — plain text or bridge-specific formatted text from
  `providerTextFromClientCompletion` / `providerTextFromInteractionResponse`.
- fallback — `safeJson(result?.message?.value ?? result ?? {}, 12000)`.

Before formatting, BYOK still normalizes flat Cursor result frames into a
consistent `oneof` envelope where needed
(`normalizeExecClientResult` / `normalizeExecResultEnvelope` /
`normalizeExecResultValue` in `src/server/http.js`, mirrored in the hook), most
importantly mapping `readResult.success.content`/`data` into
`result.success.value.output` (`{case:"content"|"data", value}`). Tests:
*"provider-visible Shell background result surfaces shell id for AwaitShell
follow-up"*, *"provider-visible Read result sends line-numbered Cursor content as
model-visible text"*, *"provider-visible Read result exposes Cursor source-code
fence coordinates"*, *"provider-visible Read result uses official oversize
guidance when Cursor reports exceededLimit"*, *"provider-visible MCP results
format native Cursor result cases"*, *"HTTP local tool result normalizes flat
Cursor exec oneof results before waking waiters"*, *"exec client result
normalizer preserves existing envelopes and repairs flat oneofs"*, *"grey-box
hook maps raw redacted Cursor Read exec oneof when toJson omits result fields"*.
