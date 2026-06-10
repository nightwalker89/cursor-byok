# Cursor 工具规格

[English](cursor-tool-spec.md)

本文记录 BYOK 暴露给 provider 的 Cursor 工具契约，以及每个工具如何回到
Cursor 执行。权威来源是：`src/runtime/tools.js` 里的 provider 可见 schema，
`src/workbench-hook.js` 里的 UI/native exec 映射，`src/server/http.js` 里的结果
case 归一化，以及 `src/server/provider-adapter.js` 里的 provider 可见结果文本。

## 全局规则

- 默认 BYOK 工具只包含 `DEFAULT_PROVIDER_TOOL_NAMES`。`Task` 和 `Subagent`
  启动工具会被过滤，BYOK 永远不会把它们 native-launch 到 Cursor。
- Run 请求里显式带来的 Cursor 工具会被保留，但 canonical builtin 按
  canonical 名称分发，而不是按 provider alias 分发。
- 发给 provider 前会归一化 schema：object 默认闭合，枚举式 JSON type token
  会被转成 JSON type，递归 schema 节点也会被归一化。
- `Read` / `ReadFile` 的 provider schema 只接受 `path`、`offset`、`limit`。
  `filePath`、`file_path` 等 provider alias 会在执行前拒绝。hook 侧 native
  归一化仍容忍 Cursor 自己产生的旧形状 alias。
- provider 工具结果在内部保持 Cursor-shaped；下一轮 provider 调用前由
  `stringifyToolResultForProvider` 转成 provider 可见文本。
- BYOK 不保存、不恢复、不裁剪、不合成 `conversationState` 或 checkpoint 消息。
  workbench hook 可能会持久化一份精简的 BYOK 消息转录(user / assistant turn 与
  prompt 字段),这样 adapter 处理的回合在 reconnect 后即使 Cursor 没带上可见
  transcript history,也能恢复 `messages`。

## Provider 可见工具目录

默认 provider 目录严格等于 `DEFAULT_PROVIDER_TOOL_NAMES`。`ReadFile` 仍记录在
这里，是因为 Cursor 显式 schema 和 provider 历史可能继续使用它作为 legacy
alias，但它不在默认目录里。

| 工具 | Provider 输入 schema | UI tool call | 执行路径 | 结果 case |
|------|----------------------|--------------|----------|-----------|
| `Shell` | `{command, description?, working_directory?, block_until_ms?}` | `shellToolCall` | Native `shellStreamArgs`。 | `shellResult` / `shellStream` |
| `Glob` | `{glob_pattern, target_directory?}` | `globToolCall` | Native `grepArgs`，`outputMode:"files_with_matches"`，pattern 为空。 | `grepResult` |
| `Grep` | `{pattern, path?, glob?, type?, output_mode?, -i?, -A?, -B?, -C?, multiline?, head_limit?, offset?}` | `grepToolCall` | Native `grepArgs`；保留上下文、type、glob、head limit、sort、multiline、offset。 | `grepResult` |
| `LS` | `{path?, target_directory?, ignore?, ignore_globs?}` | `lsToolCall` | Native `lsArgs`。`target_directory` 是 `path` alias；ignore 列表映射到 `ignore`。 | `lsResult` |
| `AwaitShell` | `{shell_id?, task_id?, block_until_ms?}` | `awaitToolCall` | 只有带 id 时才发 native `subagentAwaitArgs`。缺 id 返回本地错误。 | `subagentAwaitResult` |
| `Read` | `{path, offset?, limit?}` | `readToolCall` | BYOK direct read 快路径可直接满足 provider/UI；否则 native `readArgs`。 | `readResult` |
| `ReadFile` | `{path, offset?, limit?}` | `readToolCall` | `Read` 的旧 alias；schema 和 direct/native `readArgs` 分发相同。 | `readResult` |
| `Delete` | `{path}` | `deleteToolCall` | Native `deleteArgs`。 | `deleteResult` |
| `Edit` | `{path, old_string, new_string, replace_all?}` | `editToolCall` | BYOK read-then-write 桥：native read、本地变换、native write。 | provider-local `editResult` envelope |
| `ApplyPatch` | `{patch}` | `editToolCall` | 解析 patch 后走 BYOK read-then-write 桥。 | provider-local `editResult` envelope |
| `Write` | `{path, contents}` | `editToolCall` | Native `writeArgs`，内容放在 `fileText`。 | `writeResult` |
| `EditNotebook` | `{target_notebook, cell_idx, new_string, old_string?, is_new_cell?, cell_language?}` | `editToolCall` | BYOK edit-style 桥；不会把 UI-only 字段当 raw `writeArgs` 发送。 | provider-local `editResult` envelope |
| `TodoWrite` | `{todos, merge?}` | `updateTodosToolCall` | hook 本地 todo store。 | `todoWriteResult` |
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` | 仅显式 alias | `updateTodosToolCall` | hook/provider 识别的本地 todo alias 语义；它们不是 `CURSOR_BUILTIN_TOOLS` 条目，也不是 subagent launch。 | `todoWriteResult` |
| `ReadLints` | `{paths?}` | `readLintsToolCall` | Native `diagnosticsArgs`，使用 `path` 或 `paths[0]`。 | `diagnosticsResult` |
| `WebSearch` | `{search_term}` | `webSearchToolCall` | 当 `providers.json` 的 `webSearch.provider` 为 `exa` 且配置了 key 时，经 `webSearchRequestQuery` / `/byok/client-tool-completion` 在 BYOK 服务端执行 Exa 搜索；否则等待 Cursor 客户端完成。 | `webSearchToolCall.result` references |
| `WebFetch` | `{url}` | `webFetchToolCall` | 服务端 fetch：`webFetchRequestQuery` / `/byok/client-tool-completion`（`providers.json` 的 `webFetch`：`builtin`、`jina` 或 `firecrawl`）。 | 经 `/byok/client-tool-completion` 返回 `fetchResult` |
| `WriteShellStdin` | `{shell_id, chars}` | `custom` | Native `writeShellStdinArgs`。 | `writeShellStdinResult` |
| `ListMcpResources` | `{server?}` | `listMcpResourcesToolCall` | Native `listMcpResourcesExecArgs`。 | `listMcpResourcesExecResult` |
| `FetchMcpResource` | `{server, uri, downloadPath?}` | `readMcpResourceToolCall` | Native `readMcpResourceExecArgs`。 | `readMcpResourceExecResult` |
| `CallMcpTool` | `{name, args, providerIdentifier, toolName}` | `mcpToolCall` | Native `mcpArgs`；显式 MCP provider tool 会带原始 metadata 重写成该形状。 | `mcpResult` |
| `AskQuestion` | `{questions, title?}` | `askQuestionToolCall` | Cursor interaction-query 桥。 | `byokInteractionToolResult` |
| `SwitchMode` | `{target_mode_id, explanation?}` | `switchModeToolCall` | Cursor interaction-query 桥。 | `byokInteractionToolResult` |
| `CreatePlan` | `{name?, overview?, plan?, todos?, isProject?, phases?}` | `createPlanToolCall` | Cursor interaction-query 桥。 | `byokInteractionToolResult` |

## 仅显式工具

`WebSearch`、`GenerateImage`、`Task` 存在于 `CURSOR_BUILTIN_TOOLS` 中，用于
处理 Cursor 显式请求，但不在默认 provider 工具目录里。

- `WebSearch` 在 Cursor 显式提供且 BYOK 未配置服务端 Exa（`webSearch.provider`
  为 `client`，或 `exa` 但无可用 API key）时走 client interaction bridge；
  配置 Exa 后，BYOK 通过同一 client-tool completion 端点在服务端执行搜索。
- `GenerateImage` 只有 Cursor 显式提供时才通过 client interaction bridge 执行。
- `Task` 会被过滤或以 unsupported 本地错误完成。`Subagent` 作为 provider 可见
  alias 出现时也会被过滤/unsupported，但它不是 `CURSOR_BUILTIN_TOOLS` 条目。
  BYOK 不会发出 native `taskToolCall`、`subagentArgs`、`subagentStartedArgs`。
- `RecordScreen` 和 `ComputerUse` 也会从 provider-visible schema 中过滤，且不是
  `CURSOR_BUILTIN_TOOLS` 条目。BYOK 可以格式化历史或防御性的
  `recordScreenResult` / `computerUseResult` 信封，但不会把它们暴露为工具或
  native-launch。

## Read 语义

Provider 输入必须使用：

```json
{"path":"/absolute/file","offset":1,"limit":20}
```

`offset` 是行号语义。正数从文件开头 1-indexed；负数按 Cursor-compatible 的窗口
语义从文件末尾计数。Provider 可见结果格式：

```text
File: /absolute/file
Lines: 1-20
     1|first line
```

Direct read 结果保留影响 provider 格式化的 BYOK metadata：`rangeApplied`、
`truncated`、`totalLines`、`fileSize`、`readRange`。Direct success 结果不会伪造
native-only 的 `offset` 或 `limit` 字段。

超大的 whole-file read 不会为了 provider 展示而整文件进内存。BYOK 返回
Cursor-style 提示，要求模型用 `offset` 和 `limit` 重试。内部 edit read 可以选择
读完整内容，因为它需要精确文件文本来计算替换结果。

## 结果文本规则

信封/格式类渲染对齐 Cursor 官方 agent-exec 模板（从
`cursor-agent-exec/dist/main.js` 提取）；`Read`/`Grep` 在结构化格式之上保留
BYOK 自有的复用引导增强。

- `Shell` background：`The command did not complete in <ms>ms and was sent to
  the background.`、`Shell ID: <id>`、可选 `PID:`、background reason，以及
  `Call AwaitShell with {"shell_id":"<id>"} to wait for completion. Don't
  mention Shell ID to the user.`。
- `Shell` foreground：`Exit code: <n>`、fenced 合并输出（interleaved 或
  stdout+stderr，20000 字符 middle-out 截断，带 `... (output truncated) ...`）、
  `Command completed[ in <ms> ms].`（或 aborted 变体），以及
  `Shell state (cwd, env vars) persists for subsequent calls. Current
  directory: <cwd>` 结尾。
- `AwaitShell`：`Task completed in <ms>ms with exit code: <n>.` /
  `Task complete.` / `Task still running after <ms>ms...`，加
  `output_file_path:` / `output_length:` 尾行。
- `WriteShellStdin`：`Successfully wrote to shell <id> stdin.`。
- `Write`：`Wrote contents to <path>`。`Delete`：`Successfully deleted file:
  <path> (<size> bytes)`，外加 `File not found:` / `Path is not a file` /
  `Permission denied:` / `File is busy:` 各 arm。
- `Glob`（native grep files 模式按 Glob 模板渲染）：`Result of search in
  '<path>' (total N files):` + `- file` 行，5000 字符预算，截断时输出
  `... N more files ... (Do a more specific search if needed)`；空结果输出
  `Result of search in '<path>': 0 files found`。
- `LS`：从 `directoryTreeRoot` 渲染官方目录树 —— 根 `<absPath>/`、按名称排序
  的缩进 `- name` / `- name/` 条目、折叠子树
  `[N files in subtree: 3 *ts, 2 *js, ...]` 扩展名统计、10000 字符预算（超限
  回退到 depth-0、再回退到无统计模式）；timeout 结果渲染部分目录树。
- `ReadLints`：`Found N linter error(s) in M file(s):` + 按文件分块的
  `  [SEVERITY] L<line>:<col> - message (source)` 条目、stale lint 的
  `<system_reminder>`、无问题时 `No linter errors found.`、失败时
  `Error: <message>`。未过滤的扁平 native 形状会先按 ERROR/WARNING 过滤，对齐
  Cursor agent-exec wrapper 行为。
- `WebFetch`：`# Content from <url>` + markdown（30000 字符截断，尾部
  `...[N line(s) truncated]`）。
- `Read` success 会带行号；如果 Cursor 已经返回带行号内容，则保持原样。
- `Grep` 会格式化 content matches、files-only 输出、count 输出，不直接返回原始
  JSON，并附加 BYOK 自有的 summary/复用引导行。
- MCP 结果会格式化 text blocks 和 resource text；binary/image blocks 会摘要。
- 如果 Cursor 返回了 `recordScreenResult` / `computerUseResult` 信封，BYOK 会格式化
  这些结果；但 BYOK 不会向 provider 暴露或 native-launch `RecordScreen` /
  `ComputerUse` 工具。
- 其它通用 edit/stdin/diagnostic 失败会包含 native result case，
  并从 `error`、`message`、`reason`、`stderr`、`output` 中选择最有用的错误文本。

## 非目标

当没有 native exec 或 interaction bridge 时，BYOK 不猜测并仿真 Cursor 私有行为。
不支持的工具会显式失败，让 provider loop 继续，同时 UI 收到终态 tool completion。
