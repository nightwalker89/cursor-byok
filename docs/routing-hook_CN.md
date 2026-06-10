# 路由与 Hook

[English](routing-hook.md)

两层协作：**workbench hook**（跑在 Cursor 渲染进程，判定并改写传输流量）和**本地服务器**（`/byok/*` 控制面 + 代理）。本文讲一个 Cursor 请求如何被选中、重定向，或原样放行。

## Hook 安装

`scripts/install-workbench-hook.js`（`prepareWorkbenchInstall` / `installWorkbenchHook`，由 `scripts/workbench-patch-engine.js` 跑补丁注册表）给 `/Applications/Cursor.app/.../workbench.desktop.main.js` 打补丁：

- **只从 pristine 打补丁**：补丁基底始终是经过校验的 pristine 来源——未打补丁的目标文件本身、记录在案的 pristine 备份（会重新校验：备份自身含 BYOK 补丁则拒用），或显式提供的 pristine workbench（`CURSOR_WORKBENCH_PRISTINE` / `pristineWorkbench`；`npm run install:cursor` 在挂载了 Cursor 安装 DMG 时会自动传入，这同时能修复丢失或被污染的备份）。目标已打补丁且没有任何 pristine 来源时，安装直接失败并给出补救步骤，而不是在陈旧补丁形态上原地重打；dry-run 则以 `needsPristine` / `pristineSource` 字段报告而不抛错。
- **先剥离再插入**：先移除所有 current/previous/legacy 标记块（`stripMarkedBlock`），再前置新构建的 `CURSOR-BYOK-HOOK-V2-START … V2-END` 块（`buildWorkbenchHook`）。标记：`CLEAN`（`V2`）、`PREVIOUS`（上一版重写标记）、`LEGACY`（`HOOK-START`）。
- **补丁注册表**（`scripts/workbench-patches/`，每个接缝一个模块）：声明式条目 `{ name, targets, severity, isActive, isNotNeeded?, apply }`，逐补丁报告 `applied` / `active` / `not-needed` / `absent` / `skipped-target`。`not-needed` 由可选的 `isNotNeeded` 探针确认：该构建根本没有这个补丁要中和的行为（例如 3.3.30 之类早于 local-mode 特性的构建之于 `local-agent-run`——run 方法只是把选项直转给 `this.client.run`，所有请求本就走 hook 拦截的 transport 路径），此时缺席不算失败;探针采用严格形状校验,选项声明之后出现任何分支都会继续如实报 `absent`。severity 决定安装策略：
  - *transport* —— `connect-promise-client`（Connect promise-client 工厂）与 `context-rpc-agent-client`（用 `__cursorByokWrapAgentClient` 包裹 agent client）。workbench 上至少一个 applied 或 active，否则安装失败。
  - *critical* —— `router-guard`（`patchAgentProviderRouterGuard`）：在 `__cursorByokHasSubmitModelCandidate(selectedModel, modelDetails, submitOptions, composerData)` 为真时压制 `agentBackend ?? "cursor-agent") !== "cursor-agent"` 的 Claude-Code-backend 检查；`local-agent-run`（`patchLocalAgentRunForByok`）：改写 `localMode` 分支，让 BYOK 候选模型避开 Cursor 扩展宿主 local-agent、回落到 Connect transport 路径，守卫为 `__cursorByokHasRunOptionsModelCandidate(runOptions, selectedModel)`。critical 补丁缺失会让安装失败，除非传 `--allow-partial`（CLI）/ `allowPartial`（API）；编辑器内的 Install Hook 命令允许部分安装并以警告形式提示降级。
  - *optional* —— 完整性告警抑制（把 `…dontShowPrompt…_showNotification()` 片段替换为 `void 0`）、stall-detector 清理、首 token 告警阈值；缺失只报告为警告。
- **稳定锚点 + 局部 AST**（`scripts/workbench-patch-ast.js`）：两个 critical 补丁用压缩后仍稳定的锚点定位接缝（`async submitChatMaybeAbortCurrent(` 方法名；`clientSupportsInlineImages:!0` 选项字面量，并按所在 `async run(` 方法消歧），用 tokenizer 级花括号配平截取所在方法，所有标识符从方法 AST 读取。Cursor 构建之间的标识符改名、选项对象追加属性都不再影响这两个补丁；只有结构性变化会在补丁报告中表现为 `absent`。
- **预检 / 备份 / 恢复**：`analyzeWorkbenchHookInstall`（`npm run preflight:cursor`）打印完整逐补丁报告且不写文件；当该构建无法安全打补丁（无 pristine 基底、无 transport 接缝、或 critical 补丁缺失）时退出码为 `2`。备份（`scripts/workbench-backup-store.js`）按内容哈希存放在 `~/.cursor-byok/workbench-backups/`，元数据写入 `~/.cursor-byok/workbench-hook-state.json`，且只会从完全不含 BYOK 补丁的内容捕获。`restoreWorkbenchHook`（`npm run restore:cursor`）把备份复制回去，并报告那些仍带补丁但没有备份可还原的目标。
- **扩展宿主目标**（`extensionHostProcess.js`）：前置完整 hook 运行时，并打 transport 与完整性补丁——不只是 integrity 片段。与 workbench 不同，已打补丁的 extHost 会被剥离后原地重打（其补丁均幂等），且已打补丁的 extHost 内容永远不会被捕获为备份。

hook 在构建时嵌入 `routes.json` 的 host/port、已配置的 BYOK 模型对象（`byokModels`）、Cursor 可能回传的所有 BYOK 模型标识（`byokModelIds`），以及 `byokPortSearchCount`（8）。关键全局变量包括 `__cursorByokWrapTransport`、`__cursorByokWrapAgentClient`、`__cursorByokIsModel`、`__cursorByokHasSubmitModelCandidate`、`__cursorByokHasRunOptionsModelCandidate`、`__cursorByokModelIds`、`__cursorByokPickModelId`、`__cursorByokMarkHookPoint`。

Cursor 升级后，或者改了端口/模型集合后，重新运行安装（或 `cursorByok.installWorkbenchHook` 命令），然后重启 Cursor。
如果只是想确认当前 Cursor 还能命中支持的 hook 接缝，先跑 `preflight:cursor`。

由于这是一个基于模式匹配、直接操作私有 Cursor bundle 的补丁工具，未来 Cursor 版本可能通过几种方式导致它失效——现在每一种都会出现在预检报告里，而不是静默失败：

- 完全找不到支持的 transport 接缝（安装失败，预检退出码非零）；
- 某个 critical 接缝（`router-guard`、`local-agent-run`）不再命中——安装失败（除非 `--allow-partial`），预检退出码非零；
- 某个 optional 补丁的代码形状变了（如完整性告警片段）——该补丁被跳过并报告为警告；
- 补丁本身还能打上，但 Cursor 自己的完整性 / 签名逻辑变了，而本项目并不会自动处理。

所以面对不熟悉的 Cursor 版本，先跑 `preflight:cursor` 是必需步骤。

## 路由选择

`src/constants.js` 中的 `DEFAULT_REDIRECTS` 定义默认重定向模式；`routes.json.redirect` 可以覆盖。`routePatterns(routes)`（`src/server/http.js`，hook 内有镜像）剥掉 `REST:` 前缀，返回生效模式——当 `byokMode === 0` 时返回 `[]`，所以 **BYOK 关闭就等于没有重定向**，Cursor 直连 `api2.cursor.sh`。

当前默认重定向面刻意收得很窄：只保留 `/auth/*` 会员/支付探测、`REST:/byok/checkpoint`、`AvailableModels`、`AgentService/RunSSE`、`AgentService/Run`、`BidiService/BidiAppend`。`REST:/byok/checkpoint` 会原样代理到上游。旧的宽默认集合只为了让 `normalizeRoutes()` 能把历史配置自动迁移到这组认证加传输默认值。

通用 REST 重定向走本地服务器转发时，保留 method、body、headers（`proxyToCursor` + `copyForwardHeaders`；测试 *"grey-box hook fetch redirect preserves Request object method body and headers"*）。路由更新通过 `/byok/events` 推给已加载的 hook，不需要重装（`broadcast("routes", …)`；测试 *"grey-box hook fetch routes update from server events without reinstall"*）。

## 三类流量

被包裹的 transport 处理三类：

- **`AvailableModels`** —— 留在 Connect；unary 结果与已配置的 BYOK 模型合并（hook 里的 `mergeAvailableModelsResult`，代理路径由服务器 `handleAvailableModels` 支撑），并刷新 BYOK 模型 id 缓存（`syncByokModelIds`）。测试 *"grey-box hook leaves AvailableModels fetch on Connect and merges BYOK models in unary"*。
- **`BidiAppend`** —— 原始客户端帧 POST 到 `/byok/bidi`，解码（`decodeBidiClientMessage`），按 request id 记录（`ByokSessionStore.recordClientMessage`）。服务器回 `handle`（该会话是否 BYOK）、`modelId`、`messageCase` 和队列大小。仅对已知 BYOK 会话抑制上游。
- **`AgentService/RunSSE` 与 `AgentService/Run`** —— hook 会先询问 `/byok/should-handle`；若 `handle:false` 则原样调原 transport；若 `true` 则调 `/byok/run` 并把本地 NDJSON 翻回 Cursor 服务器消息（`eventToCursorMessages`）。对 `Run`（bidi）可以从首个 `runRequest` 帧路由，并在路由前 peek 异步可迭代输入。该流上 Cursor 自己的客户端帧（exec 结果、`conversationAction`）经 `drainRunInput` → `/byok/local-tool-result` 和 `/byok/local-client-message` 转给会话。测试：*"grey-box hook ignores stale local-agent compatibility metadata and routes BYOK locally"*、*"routes RunSSE locally from the RunSSE input when Bidi state is absent"*、*"routes AgentService Run bidi stream locally from first runRequest frame"*、*"peeks Connect RunSSE async iterable input before routing"*、*"forwards AgentService Run conversationAction frames to the local session"*。

## `/byok/*` 控制面（`src/server/http.js`）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/byok/health` | GET | `{ ok:true, byokMode, workspaceRoots }`；多窗口安装还可能返回 `windowId`、`windowScoped`。 |
| `/byok/workspace-roots` | POST | 注册当前窗口的 workspace roots。未带 scope 的注册会替换 owner roots；带 `x-client-wid`/`windowId` 的注册按窗口隔离。 |
| `/byok/events` | GET (SSE) | 向已加载 hook 广播 `routes` / `models`。 |
| `/byok/toggle` | POST | 翻转 `byokMode`、持久化、广播新路由。 |
| `/byok/mode` | POST | 用 `{ enabled: boolean }` 显式设置 `byokMode`；持久化并广播。 |
| `/byok/debug` | POST | 记录渲染进程发来的 hook 调试事件（`__cursorByokDebug`）。 |
| `/byok/models` | GET | 模式开时返回 BYOK 模型（与空官方合并），否则 `[]`。 |
| `/byok/should-handle` | POST | 为一次运行判定 BYOK vs 官方。 |
| `/byok/run` | POST | 跑一次 BYOK 回合；以 `application/x-ndjson` 流式返回。 |
| `/byok/bidi` | POST | 记录一帧原始 BidiAppend；返回 `handle`/`modelId`。 |
| `/byok/tool-result` | POST | 阻塞直到某个 tool-call id 的 Cursor exec 结果。 |
| `/byok/interaction-response` | POST | 阻塞直到 Cursor 返回某个 interaction query 的响应（`AskQuestion`、`SwitchMode`、`CreatePlan`、MCP 鉴权）。 |
| `/byok/client-tool-completion` | POST | 阻塞直到客户端侧工具完成（`WebSearch`、`GenerateImage`）。 |
| `/byok/exec-map` | POST | 注册 Cursor 原生 exec id → tool-call id 别名。 |
| `/byok/local-tool-result` | POST | 记录从本地 Run 输入解码出的工具结果。 |
| `/byok/local-client-message` | POST | 记录非 exec 的客户端消息（如 conversationAction）。 |
| 其它任意 | 任意 | `proxyToCursor` → `UPSTREAM_ORIGIN`（保留 method/body/headers）。 |

## 模型识别

匹配基于候选机制。hook 与服务器检查所选/所请求的模型字段——`requestedModel`/`modelDetails` × `modelId`/`modelName`/`name`/`apiModel`/`displayModelId`，外加顶层 `modelId`/`model`（`extractModelCandidates`，`src/server/http.js`）。`pickModelId(candidates, providers)`（`src/runtime/models.js`）返回第一个已配置的 BYOK id，否则返回第一个非空候选。这样既避免因元数据混杂而把官方模型错误地路由到本地，又能抓住出现在不同请求字段里的 BYOK 公开 id。hook 本地缓存优先从嵌入的 `byokModels` 初始化；如果没有嵌入对象列表，再回退到 `byokModelIds`。测试：*"model picker prefers BYOK candidate over mixed official display fields"*、*"grey-box hook routes BYOK RunSSE by direct model even when requestId is absent"*、*"recognizes BYOK modelName from direct RunSSE requests"*。

## 官方路径边界

官方模型始终走 Cursor 的原 transport，不经过 BYOK：

- `/byok/should-handle`：BYOK 关闭时返回 `handle:false` 且 `reason:"byok-mode-off"`；有 window id 但未注册 roots 时返回 `reason:"workspace-scope-not-registered"`；运行请求始终未到则 `reason:"run-request-not-found"`；仍缺 provider 输入时返回 `reason:"provider-input-not-found"`。未知模型返回 `handle:false` 且不带 `reason` 字段（服务器侧记录为 `model-not-found`）。
- `/byok/run`：未知模型返回 HTTP 404 与 `{ local:false, reason:"model-not-found" }`；缺 provider 输入返回 HTTP 400 与 `{ error:"provider-input-not-found" }`。这两种情况 hook 都会回落到原 transport。
- 只有在服务器找到已配置的 provider/model 条目**且**请求带有 provider 输入（`hasProviderInput`）之后，才会到达 provider 适配器。

测试：*"grey-box hook leaves official transport untouched and handles BYOK sessions locally"*、*"grey-box BYOK off passes configured models through to official Cursor"*、*"grey-box server refuses BYOK run when configured providers do not match"*、*"server rejects BYOK runs without provider input before calling upstream"*。
