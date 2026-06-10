# Provider 与工具

[English](provider-tools.md)

## Provider API

`src/server/provider-adapter.js`（`ProviderAdapter.run`）按 `provider.type` 分派：

- `openai-chat`（默认）→ `client.chat.completions.create({ stream:true, … })`（`runOpenAi`）。
- `openai-responses` → `client.responses.create({ stream:true, … })`（`runOpenAiResponses`）。
- `anthropic` → `client.messages.stream({ … })`（`runAnthropic`）。

各 client 由 provider 条目惰性构造。OpenAI-compatible provider 默认使用 `Authorization: Bearer <auth.value>`（或环境变量 `OPENAI_API_KEY`，均不可用时回退到 `"unused"`）；当 `auth.kind === "api-key"` 时，Chat 和 Responses 请求都会发送 `api-key: <auth.value>`，并显式关闭 OpenAI SDK 自动添加的 Bearer 头。Anthropic provider 使用 `provider.auth.value`（或环境变量 `ANTHROPIC_API_KEY`，均不可用时回退到 `"unused"`）。所有 provider 都使用 `baseURL` = `provider.baseUrl`，并把 `provider.headers` 合并进 SDK 默认请求头。发往 API 的模型是 `model.apiModel || model.id`。OpenAI-compatible Chat 和 Responses 请求设置 `parallel_tool_calls:true`，默认不设置 completion token 上限，由 provider 自行决定；OpenAI Chat 还会发送 `stream_options:{include_usage:true}`，使最终无 choices 的 usage chunk 能填充 Cursor 的 `turnEnded` usage；Anthropic 请求发送 `max_tokens = model.maxOutputTokens || 8192`，因为该 API 要求显式指定生成上限。

适配器从解码后的运行请求构建 provider 消息（`buildPrompt` → `normalizeProviderMessage`），前置 system prompt，为已配置的 BYOK 模型追加**仅 BYOK** 的 prompt 规则（`appendByokPromptRules`，由 `isByokModel` 把关，靠 `<cursor_byok_prompt_compatibility>` 标记保持幂等；规则内容来自 `byok-system-prompt.md`），规范化工具 schema，然后进入循环：流式事件 → 遇到 `tool_use_done` 暂停，调用 `waitForToolResult(toolCallId)` → 把结果塞回 provider 历史 → 继续，直到没有工具调用为止。

- **OpenAI prompt 缓存**：`withOpenAiPromptCacheKey` 在有 conversation id 时设 `prompt_cache_key = conversationId`（`src/runtime/cache.js`；由 *"OpenAI provider loop sends Cursor exec result back as provider tool result"* 里的 OpenAI Chat request-shape 断言，以及 *"OpenAI Responses provider loop uses responses API with conversation prompt cache key"* 覆盖）。
- **Anthropic**：assistant 的 tool-use 回合重建为 `tool_use` content 块，结果以 `tool_result` user content 返回；消息 cache-control 对象透传（`preserveAnthropicCacheControl`）。
- 每次调用 provider API 前，历史工具消息都会按各 API 的原生格式转换：OpenAI Chat 用 `assistant.tool_calls` + `role:"tool"`，OpenAI Responses 用 `function_call` + `function_call_output` item，Anthropic 用 `tool_use` + `tool_result` content 块。OpenAI Chat 的 `tool_calls[].type:"custom"` 历史按 Chat `custom` call 保留；转到 Responses 时变成 `custom_tool_call` item；转到 Anthropic 时变成 `tool_use` block，若 custom input 不是对象则包装成 `{input:<text>}`。原生 Responses `custom_tool_call` 历史转到 Chat/Anthropic 时做同样转换，转到 Responses 时仍保持原生 item（包括出现在 assistant message content 数组里的情况）。结构化历史 tool-result content 会转成目标 API 允许的形状：OpenAI Chat tool message 和 Responses function output 收到文本；Anthropic 保留合法的 text/image/document content block，把 Cursor/MCP 专用 block 打平为文本。原生 Responses input/output item 只在下一次调用仍是 Responses 时保留；但原生 Responses `message` content 发送前仍会按 role 归一化为合法的 `input_*` 或 `output_text` / `refusal` block。原生 Responses `reasoning` 转成 Chat 或 Anthropic 时只将公开的 `summary_text` 转为文本，不会转发原始 `reasoning_text` / `encrypted_content`。原生 Anthropic `thinking` / `redacted_thinking` block 只在下一次调用仍是 Anthropic 时保留；转成 OpenAI Chat 或 Responses 时不会转发 `redacted_thinking.data` 和 thinking signature。
- 工具循环中，provider 私有 history item 不会作为归一化 UI 事件暴露；但同 provider 的下一轮请求会保留必要私有上下文：同一轮里的原生 Responses item 会插回下一次 Responses `input`，Anthropic `thinking` / `redacted_thinking` block 会插回下一次 Anthropic assistant message，再接对应工具结果。
- provider 工具结果在内部仍保持 Cursor 形状，但进入下一轮 provider 历史前，会由 `stringifyToolResultForProvider` 把若干高价值原生结果转成 provider 可见文本（见*工具结果*一节）。

### 归一化流事件

各 provider 的收集器发出供 hook 消费的统一事件词汇：`text_delta`、`thinking_delta`、`thinking_done`、`tool_use_start`、`tool_use_delta`、`tool_use_done`（携带**累积**的 `arguments` 字符串），以及终止事件 `done`（`stopReason` + token `usage`）。
OpenAI Chat 的 `prompt_tokens_details.cached_tokens` 和 Responses 的 `input_tokens_details.cached_tokens` 都会映射到统一的 `usage.cacheReadTokens`；Anthropic 的 cache read/write usage 来自 `cache_read_input_tokens` / `cache_creation_input_tokens`。

- `streamOpenAiEvents` —— 按 index/id 累积现代 `choices[].delta.tool_calls[].function.arguments`、Chat custom `choices[].delta.tool_calls[].custom.input`，也累积 legacy `choices[].delta.function_call.arguments`；在 `finish_reason==="tool_calls"` 或 `finish_reason==="function_call"` 时发 `tool_use_done`。BYOK 只把 Cursor 工具作为 OpenAI Chat `function` tool 暴露，所以运行时 Chat `custom` tool call 会以 provider 可见工具错误返回，不会派发到 Cursor 原生 exec。自然结束的 `finish_reason:"stop"` 会归一成 `stopReason:"end_turn"`；`length`、`content_filter` 这类非工具终态原因会保留为终止 `done.stopReason`。
- `streamOpenAiResponsesEvents` —— 映射 `response.output_text.delta`、`response.function_call_arguments.delta/.done`、`response.output_item.added`、`response.output_item.done`，包括只出现在 done 事件或独立参数完成事件里的 function call。它也识别 Responses 的 `custom_tool_call` / `response.custom_tool_call_input.*` 事件；但 BYOK 只把 Cursor 工具作为 `function` tool 暴露给 Responses，所以 custom-tool call 会以 `custom_tool_call_output` 错误回给 provider，不会派发到 Cursor 原生 exec。公开的 Responses reasoning summary（`response.reasoning_summary_text.*`、`response.reasoning_summary_part.done`，以及 `response.output_item.done` 上 reasoning `summary[]`）会转成 `thinking_delta`，最后跟一个 `thinking_done`；原始 `response.reasoning_text.*` 和 `reasoning_text` content 不会作为 text 或 thinking 透出。能作为后续 input 的原生 Responses output item 会作为同 provider 工具循环的 provider 私有 history 保留，包括 `file_search_call`、`web_search_call`、`tool_search_output` 与 `function_call_output`。Responses 终态失败（`error`、`response.failed`、`response.incomplete`）会变成 provider 可见的 `text_delta` 和 `stopReason:"error"` 的 `done`，不会被报告成正常 end turn。
- `streamAnthropicEvents` —— 映射 `content_block_start/delta/stop`；如果 Anthropic 在 `content_block_start` 上直接给出 `tool_use.input` 对象则保留它，否则累积 `input_json_delta.partial_json`，使 `tool_use_done` 携带最终 JSON；并透出 `thinking` 块。

每个 `tool_use_done` 都带 `argumentKeys` 以及（对 `Read`）`readHasPath`/`readHasOffset`/`readHasLimit` 记入日志（`this.log.info("BYOK tool call", …)`），UI 回归检查依赖这些。测试 *"provider stream collectors preserve tool names for native Cursor exec dispatch"*。

## 工具目录

解码后的运行请求不含工具时，适配器默认只暴露 BYOK 能通过 Cursor 执行或在本地完成的 schema（`defaultCursorBuiltinTools` → `CURSOR_BUILTIN_TOOLS`，`src/runtime/tools.js`，真值来源 `DEFAULT_PROVIDER_TOOL_NAMES`）：Shell、Glob、Grep、LS、AwaitShell、Read、Delete、Edit、ApplyPatch、Write、EditNotebook、TodoWrite、ReadLints、WebFetch、WriteShellStdin、ListMcpResources、FetchMcpResource、AskQuestion、SwitchMode、CallMcpTool、CreatePlan。BYOK 模式不会向 provider 暴露 `Task` / `Subagent` 启动工具和 `RecordScreen` / `ComputerUse`，即使 Cursor 在请求中显式给出也会过滤掉。请求中显式给出的 Cursor 工具 schema 会被保留，而不是追加完整默认值；但如果 Cursor 显式列表缺少 BYOK 自己能桥接的交互工具，会补 `AskQuestion`、`SwitchMode`、`CreatePlan`。仍然 provider 可见的显式客户端侧工具（`WebSearch`、`GenerateImage`）通过 client-tool bridge 完成；被过滤或未知的工具返回本地终态错误，而不是卡住 provider loop（测试 *"provider prompt uses Cursor built-in tool schemas when Run request has no tools"*、*"…preserves explicit Cursor tool schemas instead of appending defaults"*、*"…preserves explicit client-bridge Cursor tool schemas"*、*"server exposes BYOK interaction bridge tools alongside explicit Cursor tools"*）。Cursor `mcpTools` 仍会合并进显式工具列表，并保留 `providerIdentifier`/`toolName` 元数据，使 provider 可见的直接 MCP 工具调用能通过 Cursor 原生 MCP 桥执行。provider 可见工具名可以为了 API 命名规则被 sanitize，但当显式或缓存 metadata 存在时，执行 metadata 不从 sanitized 名反推（测试 *"server merges Cursor MCP tools into explicit provider tools without losing dispatch metadata"* 与 *"server preserves dotted MCP provider identifiers behind sanitized provider tool names"*）。

`WebSearch` 与 `GenerateImage` **不在**默认 provider 工具目录（`DEFAULT_PROVIDER_TOOL_NAMES`）里。只有当 Cursor 在运行请求里显式给出它们时，BYOK 才会透传，并通过 client-tool bridge 完成，而不是走原生 exec 信封。

各 schema 的键是模型必须严格遵守的契约：Shell = `{command, description?, working_directory?, block_until_ms?}`；Glob = `{glob_pattern, target_directory?}`；LS = `{path?, target_directory?, ignore?, ignore_globs?}`；Grep = `{pattern, path?, glob?, type?, output_mode?, -i?, -A?, -B?, -C?, multiline?, head_limit?, offset?}`；AwaitShell = `{shell_id?, task_id?, block_until_ms?}`；Read = `{path, offset?, limit?}`；Delete = `{path}`；Edit = `{path, old_string, new_string, replace_all?}`；ApplyPatch = `{patch}`；Write = `{path, contents}`；EditNotebook = `{target_notebook, cell_idx, new_string, old_string?, is_new_cell?, cell_language?}`；TodoWrite = `{todos, merge?}`；ReadLints = `{paths?}`；WebFetch = `{url}`；WriteShellStdin = `{shell_id, chars}`；AskQuestion = `{questions, title?}`；ListMcpResources = `{server?}`；FetchMcpResource = `{server, uri, downloadPath?}`；SwitchMode = `{target_mode_id, explanation?}`；CallMcpTool = `{name, args, providerIdentifier, toolName}`；CreatePlan = `{name?, overview?, plan?, todos?, isProject?, phases?}`。

`TodoWrite` 只是内部进度清单；其中 todo 项只接受 `id`、`content`、`status`，不接受 `dependencies`。`CreatePlan` 才是给用户看的计划产物，它的 todo 可以带 `dependencies`，所以模型不能把 `CreatePlan` 的 todo 对象原样复制进 `TodoWrite`。

发往 provider 前，`normalizeTools` 会让每个 schema 经 `coerceProviderToolSchema`（`normalizeProviderJsonSchema` + 闭合对象：枚举类型 token `OBJECT/STRING/…` → JSON 类型，闭合对象上加 `additionalProperties:false`，递归处理 `properties`/`items`/`anyOf` 等；顶层 combinator 的 properties 会为 provider 兼容性合并，`allOf` 分支内的 `required` 做并集，`oneOf`/`anyOf` 分支内的 `required` 不做并集）。description 经 `sanitizeProviderVisiblePromptText`（仅 Anthropic：`ReadFile`→`Read`、`read_file`→`Read`、`filePath`→"an unsupported alternate key"）。provider request builder 直接复用这些已规范化的 schema 和 description，不会在每轮循环中再次递归 coercion 或 sanitize。Read 的 schema 文本明确说明了 `path`/`offset`/`limit`（`READ_TOOL_DESCRIPTION`），并额外提示模型在大文件里做 symbol / definition / callsite 定位时优先 `Grep`、不要先整文件 `Read`——这是 prompt 兼容性引导，**不**替代 Cursor 原生 Read。测试：*"Read schema tells model exact offset and limit contract"*、*"provider request builders reuse normalized tool metadata without per-call recoercion"*、*"provider JSON schemas normalize recursively and close object schemas"*。

## 原生工具执行

hook 把 `tool_use_done` 事件转成 Cursor 原生消息（`eventToCursorMessages` / `execServerMessage`，`src/workbench-hook.js`）：一条 `toolCallStarted` UI 消息（类型由 `cursorToolTypeForName` 决定：Read→`readToolCall`、Edit/ApplyPatch/EditNotebook/Write→`editToolCall`、Delete→`deleteToolCall`、Grep→`grepToolCall`、Glob→`globToolCall`、Shell→`shellToolCall`、GenerateImage→`generateImageToolCall`、AwaitShell→`awaitToolCall`…），以及在受支持时一条原生 `execServerMessage`，其 `message.case` 为原生 exec 参数：

| 工具 | 原生 exec |
|------|-----------|
| `Read` / `ReadFile` | 优先走 BYOK 直接 workspace 读取（`directToolResultForEvent` 且 `directOnly: true` → `/byok/tool-result`）；无法直接服务时再回落到原生 `readArgs`（`path`、`toolCallId`、可选 `offset`、`limit`、`encodingHint`）。 |
| `Grep` | `grepArgs`，保留 output mode、上下文（`-A/-B/-C`）、type、glob、head limit、sort、multiline、offset。 |
| `Glob` | UI `globToolCall`，原生 `grepArgs` 带 `outputMode:"files_with_matches"`。 |
| `Shell` | `shellStreamArgs`。 |
| `Delete` | `deleteArgs`。 |
| `Write` | UI `editToolCall`，原生 `writeArgs` 带完整 `fileText`。 |
| `Edit` / `ApplyPatch` / `EditNotebook` | read-then-write **桥接**（见下）。 |
| `ReadLints`、MCP 资源/工具调用 | 当 Cursor 暴露时映射到其原生 exec 参数。provider 可见的直接 MCP 工具会在执行时重写为 `CallMcpTool`，原始工具输入放在 `args` 下。 |
| `AskQuestion`、`SwitchMode`、`CreatePlan` | Cursor interaction-query 桥接；无原生 exec。 |
| `AwaitShell` | 只有带 `shell_id`/`task_id` 时才走原生 await；否则返回本地错误。 |
| 未知或被过滤的工具 | UI 完成 + 一条本地**错误**结果。 |

`AwaitShell` 只有在模型提供 `shell_id` 或 `task_id` 时才发原生 `subagentAwaitArgs`。虽然旧工具描述里曾暗示过“只 sleep”的模式，但当前实现把缺少 id 视为错误：`awaitShellLocalResult` 会返回 `AwaitShell requires shell_id or task_id from a previous background shell or subagent result.`，而不是伪造一个本地成功结果。存在 id 时，`block_until_ms`/`blockUntilMs` 限制到 `[0,300000]`（默认 `30000`），本地完成 payload 会回显该 task id。未知、被过滤或 schema 校验失败的 provider 工具调用仍会发带 `localResult.case:"unsupportedToolResult"` 的 `tool_use_done`；hook 把它转成 `toolCallCompleted`，通过 `/byok/local-tool-result` 回填给 provider，不发原生 exec。这样 Cursor UI 和 provider 循环都会收到终态，不会卡住。测试：*"hook runtime emits native Read tool start and exec messages with offset and limit"*、*"maps Glob to Cursor-native grepArgs files search"*、*"hook runtime returns local AwaitShell error without readArgs bridge when ids are missing"*、*"hook runtime terminates exposed unsupported tools with explicit local errors"*、*"hook runtime completes provider-local tool errors without native exec"*、*"grey-box unknown provider tool returns local error result instead of stalling provider"*。

原生 exec id 通过 `/byok/exec-map` 别名关联回 provider 的 tool-call id（`ByokSessionStore.registerExecAlias`；测试 *"HTTP exec map endpoint lets Bidi results wake BYOK tool waiters by native id"*）。

## 与官方路径的行为差异

这个适配器的原则是“尽量贴近 Cursor”，而不是“硬猜一套私有实现的完美模拟”。实际效果就是：

- Cursor 暴露了原生 exec 信封的工具，就优先走原生。
- Cursor **没有**暴露与 provider-facing 工具形状完全一致的原生参数时，BYOK 仅做维持流程正常运行所需的 bridge / rewrite。

目前最关键的差异有：

- `Edit`、`ApplyPatch`、`EditNotebook` 不是原样转发成 native write，而是拆成 read → 本地变换 → write。
- `Glob` 通过原生 grep 的 `files_with_matches` 模式实现。
- 交互工具和客户端侧工具（`AskQuestion`、`SwitchMode`、`CreatePlan`、`WebSearch`、`GenerateImage`、MCP 鉴权）会跨 BYOK 自己的桥接端点，所以其时序和结果文案可能与 Cursor 官方 provider 路径有细微差异。
- 未知或被过滤的工具会明确失败，而不是强行模拟一套猜出来的官方行为。

如果某个内置工具要求和官方路径做到非常接近的效果，应该拿官方模型路径做真实 UI 回归对照，而不是只看单元测试。

## Edit 桥接

`Edit`、`ApplyPatch`、`EditNotebook` 不直接把 provider 参数塞进 Cursor `writeArgs`，而是桥接，因为面向 provider 的参数不是合法的原生 `writeArgs`。桥接流程：

1. 发出原始的 edit 风格 UI 工具调用（`editToolCall`）。
2. 为 `<tool-id>-read` 执行一次内部原生 `readArgs`。
3. 本地算出最终完整文件内容（把 edit/patch 应用到读到的内容；`normalizeTextForEdit`/`restoreLineEnding`）。
4. 为 `<tool-id>-write` 执行原生 `writeArgs.fileText`。
5. 把原始 provider 工具 id 记为 `editResult`。

这样既保留面向 provider 的工具表达力，又让原生 Cursor protobuf 参数合法，且绝不把 UI-only 的 edit 字段泄漏进原生 `writeArgs`（测试 *"executes ApplyPatch through read-then-write bridge with proto-valid writeArgs"*、*"executes Edit through read-then-write bridge with final fileText"*、*"never puts UI-only edit fields into native writeArgs"*）。

## 工具结果

provider 历史**不再**直接拿原始 Cursor JSON。`stringifyToolResultForProvider` 会将若干结果类型转为 provider 可见的文本；没有专门处理的情况才回退到带上限的 JSON：

- `shellResult` —— 按 Cursor 官方 agent-exec 模板渲染。后台：`The command did not complete in <ms>ms and was sent to the background.` + `Shell ID: <id>`、可选 `PID:`、background reason，以及 `Call AwaitShell with {"shell_id":"<id>"} ... Don't mention Shell ID to the user.` 跟进提示。前台：`Exit code: <n>`、fenced 合并输出（interleaved/stdout+stderr，20000 字符 middle-out 截断）、`Command completed[ in <ms> ms].` / aborted 变体，以及 shell 状态保持结尾（`Shell state (cwd, env vars) persists for subsequent calls. Current directory: <cwd>`）。
- `readResult` —— success 会返回文件路径、源码行范围、带行号的内容（如果 Cursor 还没编号）、`File is empty.`、超长文件指引，或 blob-only 指引，告诉模型用 `offset`/`limit` 重试。BYOK 不对 Cursor Read 内容再加第二层 inline 上限；模型可见的文件内容量由 Cursor 自己的 `exceededLimit` / blob / range 行为决定。BYOK prompt 使用 Cursor 原生的 “CODE REFERENCES / MARKDOWN CODE BLOCKS” 表达，并要求模型在引用文件中的代码时把 `File:` / `Lines:` 坐标写成 Cursor 源码 fence header（`startLine:endLine:filepath`）。opening fence 必须从行首开始，前面不能有空格，必须是顶层块，而且要换成真实的行号和路径，不能把 `startLine`、`endLine`、`filepath` 这些占位词原样打出来，例如：

```12:18:/absolute/path/file.go
if bt.Spec.Priority == "high" {
  continue
}
```

  不应把 `File:` / `Lines:` 直接原样写成 assistant 正文里的普通 prose。文件代码引用必须包含精确行号，从而让 Cursor 渲染出和官方模型一致的可点击代码卡片。
- `grepResult` —— 返回格式化后的 workspace/content/files/count 摘要，而不是原始 exec 信封。当发起工具是 `Glob` 时，同一份 native 结果改用 Cursor 官方 Glob 模板渲染：`Result of search in '<path>' (total N files):` + `- file` 行（5000 字符预算），截断时带官方 `... N more files ... (Do a more specific search if needed)` 尾行。
- `mcpResult`、`listMcpResourcesExecResult`、`readMcpResourceExecResult`、`mcpAuthResult` —— 返回人类可读的 MCP / resource / auth 摘要。
- `todoWriteResult` —— 模型看到带状态标签的紧凑 todo 列表，而不是本地结果信封 JSON。
- `writeResult` —— `Wrote contents to <path>`（官方模板）；`deleteResult` —— `Successfully deleted file: <path> (<size> bytes)`，外加官方 `fileNotFound`/`notFile`/`permissionDenied`/`fileBusy` 各 arm；`writeShellStdinResult` —— `Successfully wrote to shell <id> stdin.`；`subagentAwaitResult` —— `Task completed in <ms>ms with exit code: <n>.` / `Task complete.` / `Task still running after <ms>ms...`，加 `output_file_path:` / `output_length:` 尾行；`diagnosticsResult` —— Cursor 官方 ReadLints 渲染（`Found N linter error(s) in M file(s):` + `[SEVERITY] L<line>:<col> - message (source)` 条目、stale lint `<system_reminder>`、干净结果 `No linter errors found.`、失败 `Error: <message>`；未过滤的扁平 native 形状会先按 ERROR/WARNING 过滤，对齐 agent-exec wrapper）；`lsResult` —— Cursor 官方目录树（根 `<absPath>/`、`- name/` 条目、折叠子树 `[N files in subtree: 3 *ts, ...]` 扩展名统计、10000 字符预算及官方 depth-0 回退）；`fetchResult` —— `# Content from <url>` + markdown（30000 字符截断，官方 `...[N line(s) truncated]` 尾行）；`editResult`、`recordScreenResult`、`computerUseResult`、`requestContextResult`、`unsupportedToolResult` —— 常见 success/error arm 会转成简短状态或输出文本；未知形态仍回退到 bounded JSON。
- 本地 `awaitResult` alias 会先归一化成 `subagentAwaitResult`，再进入 provider 可见格式化。
- `byokInteractionToolResult` —— 返回纯文本，或来自 `providerTextFromClientCompletion` / `providerTextFromInteractionResponse` 的桥接格式化文本。
- fallback —— `safeJson(result?.message?.value ?? result ?? {}, 12000)`。

在做上述格式化之前，BYOK 会先把扁平 Cursor 结果帧归一化为统一的 `oneof` 信封（`normalizeExecClientResult` / `normalizeExecResultEnvelope` / `normalizeExecResultValue`，`src/server/http.js`，hook 内有镜像），尤其是把 `readResult.success.content`/`data` 映射进 `result.success.value.output`（`{case:"content"|"data", value}`）。测试：*"provider-visible Shell background result surfaces shell id for AwaitShell follow-up"*、*"provider-visible Read result sends line-numbered Cursor content as model-visible text"*、*"provider-visible Read result exposes Cursor source-code fence coordinates"*、*"provider-visible Read result uses official oversize guidance when Cursor reports exceededLimit"*、*"provider-visible MCP results format native Cursor result cases"*、*"HTTP local tool result normalizes flat Cursor exec oneof results before waking waiters"*、*"exec client result normalizer preserves existing envelopes and repairs flat oneofs"*、*"grey-box hook maps raw redacted Cursor Read exec oneof when toJson omits result fields"*。
