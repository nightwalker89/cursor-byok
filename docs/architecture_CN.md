# 架构

[English](architecture.md)

Cursor BYOK 是一个本地适配器：让你**自己的 provider 模型**出现在 Cursor 里，同时让官方 Cursor 模型继续走原来的传输通道。它以可读扩展 `starduster.cursor-byok`（`extensionKind: ["ui"]`）发布，`src/` 下是纯 Node/CommonJS，没有打包器，`main` 直接指向 `src/extension.js`。

## 两个协作进程

整个系统拆成两个进程，二者只通过本地 HTTP 服务器通信：

```
Cursor 渲染进程 (workbench)                   扩展宿主进程 (src/extension.js)
┌───────────────────────────────┐          ┌──────────────────────────────────┐
│ workbench.desktop.main.js      │  HTTP    │ ByokServer (src/server/http.js)    │
│  + 注入的 CURSOR-BYOK-HOOK-V2  │ ───────▶ │  /byok/* 控制 + 代理 + NDJSON      │
│  (src/workbench-hook.js)       │ :9960+   │  ProviderAdapter → OpenAI/Anthropic│
│  包裹 Connect transport         │ ◀─────── │  请求/工具结果关联状态             │
└───────────────────────────────┘          └──────────────────────────────────┘
```

- **hook** 是唯一跑在 Cursor 渲染进程里的部分。它包裹 Connect transport，对每个请求决定：合并模型、捕获帧、本地处理，还是原样放行。
- **扩展宿主**跑其余一切：控制服务器、provider 循环，以及跨多个传输通道关联一次逻辑运行的内存状态。
- 当同时开多个 Cursor 窗口时，扩展宿主只有在有序 workspace root 集合一致时才挂接已有 server。roots 按 owner/window 隔离，不再全局合并。

## 模块地图

| 模块 | 职责 |
|------|------|
| `src/extension.js` | 入口：配置初始化、自适应启服 / 挂接 shared server、命令、状态栏、控制面板 webview、监听 `providers.json`。导出 `activate`、`deactivate`、`panelState`。 |
| `src/constants.js` | 标识与默认值：`starduster.cursor-byok`、在 `127.0.0.1:9960` 起连续探测 8 个端口、`https://api2.cursor.sh`、`~/.cursor-byok`、`DEFAULT_REDIRECTS`、hook 备份文件名。 |
| `src/config.js` | 读/规范化/写 `providers.json` 与 `routes.json`，暴露 `workbench-hook-state.json` / `workbench-backups/` 路径，复制 `models-catalog.json`。 |
| `src/log.js` | 输出通道 + 可选文件日志（`cursorByok.log.file`）。`LocalLog`。 |
| `src/server/http.js` | 本地服务器：`/byok/*` 路由、代理上游、`AvailableModels` 合并、Bidi 解码、NDJSON 运行。`ByokServer`。 |
| `src/server/provider-adapter.js` | OpenAI Chat / OpenAI Responses / Anthropic 的 provider 循环。`ProviderAdapter`。 |
| `src/runtime/models.js` | 模型识别 + `AvailableModels` 合并。`mergeAvailableModels`、`pickModelId`、`findProviderModel`、`toCursorModel`。 |
| `src/runtime/tools.js` | 默认 Cursor 工具 schema + provider JSON-Schema 规范化。`CURSOR_BUILTIN_TOOLS`、`coerceProviderToolSchema`。 |
| `src/runtime/state.js` | 关联：Bidi 队列、会话仓（运行请求 + 工具结果等待者 + 原生 id 别名）。`ByokSessionStore`。 |
| `src/runtime/prompt.js` | 仅 BYOK 的 prompt 规则 + 清洗 provider 可见的工具名。 |
| `src/runtime/client-tool-bridge.js` | 客户端交互工具（WebSearch、GenerateImage、审批）：构造查询，遍历完成记录提取 tool-call id 与结果信封。 |
| `src/runtime/interaction-bridge.js` | 交互查询桥（AskQuestion、SwitchMode、CreatePlan、MCP 鉴权）：构造查询并把交互响应映射为 provider 工具结果。 |
| `src/runtime/cache.js` | OpenAI `prompt_cache_key` 与 Anthropic cache-control 透传辅助。BYOK 不合成 conversation checkpoint。 |
| `src/runtime/cursor-protocol.js` | 轻量解码 Bidi 客户端消息。`decodeBidiClientMessage`。 |
| `src/workbench-hook.js` | 注入渲染进程的运行时（`buildWorkbenchHook`）。transport 包裹、路由、事件→消息翻译、direct read、桥接和原生 exec。 |
| `src/webview.html` | 控制面板 UI。 |
| `scripts/install-cursor.js` | 把扩展安装进 Cursor + 运行 hook 安装器。 |
| `scripts/install-workbench-hook.js` | 薄门面：pristine 来源解析、安装/分析/恢复、备份编排。补丁工作委托给引擎，备份 I/O 委托给备份仓。 |
| `scripts/workbench-patches/` | 声明式补丁注册表（每个接缝一个模块）。`index.js` 导出有序 `REGISTRY` 和严格度常量。 |
| `scripts/workbench-patch-engine.js` | 在内容上跑注册表，生成逐补丁状态报告。不因接缝缺失而抛错——策略在安装器层。`applyPatchPlan`、`validateWorkbenchSyntax`。 |
| `scripts/workbench-patch-ast.js` | 两个 critical 补丁使用的稳定锚点 + 局部 AST 原语。`findAnchors`、`enclosingMethod`、`matchBracesFrom`（acorn tokenizer）、`parseClassMethod`、`applyEdits`。 |
| `scripts/workbench-backup-store.js` | 按内容寻址的 pristine 备份（`~/.cursor-byok/workbench-backups/`）；hook-state JSON 读写；原子文件写入。 |
| `scripts/check-syntax.js` | 对 `src/`、`scripts/`、`tests/` 下每个 `.js` 文件运行 `node --check` 语法门（`npm run check`）。 |

## 请求流程

1. Cursor 加载扩展（`activate`）和已经装好的 hook。扩展要么在配置端口附近启动自己的本地 server，要么在 workspace roots 一致时挂接到同端口上已经运行的共享 BYOK server。
2. hook 维护一份 BYOK 模型 id / 模型缓存：先用安装时嵌入的模型元数据（`byokModels`，必要时回退到 `byokModelIds`）初始化，再通过 `/byok/models`、`AvailableModels` 和 `models` SSE 事件刷新。
3. `AvailableModels` 被代理并与已配置的 BYOK 模型合并（`mergeAvailableModels`）：官方 + BYOK，去重并移除 `default`，带上 `useModelParameters:true`。
4. 在 Cursor local mode 下，任何已配置的 BYOK 模型 id 都会避开 Cursor 扩展宿主 local-agent，回落到 Connect transport，因为 Cursor 官方 local-agent 仍会按官方模型集合校验公开模型 id。
5. 已配置的 BYOK 模型只有在 BYOK 模式开启且 `/byok/should-handle` 同意时才走 BYOK transport adapter，并在 `/byok/run` 复核。
6. adapter 处理的运行会由服务器调 provider（`ProviderAdapter.run`），以 NDJSON 流式返回归一化事件（`text_delta`、`thinking_delta`、`tool_use_start/delta/done`、`done`）。
7. hook 把这些事件转成 Cursor 原生服务器消息。工具契约能匹配 Cursor 原生信封时走 native exec；`Read` / `ReadFile` 可走 BYOK direct read 快路径；edit、交互、客户端侧工具以及不支持的兜底走本地桥接。
8. 当 hook 发出 native 工具信封时由 Cursor 执行。原生 `execClientMessage` 结果、direct-read 结果和本地 bridge completion 都按 request id + tool-call id 关联、归一化，再交还给暂停中的 provider 循环。

## 一次运行如何跨通道关联

Cursor 把一次逻辑运行拆到多个传输通道上（BidiAppend 帧 + 一个 RunSSE/Run 调用），所以服务器要把它们拼起来（`src/runtime/state.js`）：

- **request id** = 任意 payload 里找到的第一个 UUID（`findRequestId`）。
- `BidiRawQueue` 按 request id 缓存原始 Bidi 记录（FIFO 兜底）。
- `ByokSessionStore` 按 request id 记录运行请求 / 动作 / exec 结果，合并不完整的运行请求，并 resolve `waitForRunRequest` / `waitForExecResult`，让 `/byok/run` 等到输入及各工具结果就绪后再继续。
- **checkpoint 归 Cursor 所有。** Cursor 原生 checkpoint 状态存在
  `conversationState` 里:server / local-agent 路径发出
  `conversationCheckpointUpdate`,客户端把它折叠进 composer(上下文用量计数、
  history blob 与 summary 指针)并持久化。BYOK adapter 不在这条路径上——adapter
  处理的 `Run`/`RunSSE` 只能看到 Cursor 客户端 run request 里已带上的
  `conversationState`(已配置的 BYOK 模型走 adapter / Connect 路径,而不是产生这些
  更新的原生 local-agent 路径;见第 4 步)。BYOK 会把这份状态原样透传给 provider
  作输入,但绝不保存、裁剪、恢复或合成 `conversationState`,也绝不发出
  `conversationCheckpointUpdate`。另外,workbench hook 可能会持久化一份精简的
  BYOK 消息转录(user / assistant turn 与 prompt 字段),这样 reconnect 之后若
  Cursor 没把可见 transcript history 带进来,仍能重建 `messages`。不被本地处理的
  checkpoint 端点仍原样 proxy 到 upstream。(这跟 `ComposerCheckpointStorageService`——文件回滚 / checkout 的
  checkpoint——是两回事:UI 同名,职责不同。)

## 非目标

- 官方模型绝不经过 provider 适配器（边界由 `should-handle` / `run` 把守）。
- 对于没有 native exec 或 bridge 路径的工具，BYOK 不猜测 Cursor 私有行为。不支持或被过滤的工具返回明确的本地错误，确保 UI 和 provider loop 都能收到终态。
- Cursor 暴露兼容原生信封时，BYOK 仍优先走 Cursor 原生执行；但部分面向 provider 的工具会有意走适配器自己的路径：direct `Read` / `ReadFile`、read-then-write edit bridge、interaction-query bridge、client-tool completion，以及本地不支持工具的错误。
- provider 历史不直接使用原始 Cursor JSON。原生和本地工具结果先归一化为统一的 result envelope；对高价值结果类型，还会在进入下一轮模型调用前格式化为 provider 可见文本。

## 测试

端到端测试现在拆分在 `tests/byok-*.test.js`，例如
`tests/byok-hook-transport.test.js`、`tests/byok-server-run.test.js`、
`tests/byok-extension-activation.test.js` 和
`tests/byok-workbench-install.test.js`（安装器 + 补丁注册表）。可选的活体 bundle
冒烟测试（`tests/byok-workbench-preflight-live.test.js`，
`BYOK_LIVE_PREFLIGHT=1`）在不写文件的前提下对已安装 Cursor 验证补丁计划。完整的行为到测试映射见
[verification_CN.md](verification_CN.md)。
