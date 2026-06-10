# 验证

[English](verification.md)

> 以下测试名保留英文原文方便检索；原先集中在单个测试文件里，现在拆分在 `tests/byok-*.test.js`。

## 单元与语法检查

```bash
npm run check          # scripts/check-syntax.js + ESLint + node --test
npm test               # 仅 node --test
```

`scripts/check-syntax.js` 遍历 `src/`、`scripts/`、`tests/`，对每个 `.js` 文件运行 `node --check` 作为解析门控；Node 内置测试用内存假件灰盒测试 hook、服务器、provider 循环、协议辅助函数与安装器。

### 行为 → 测试映射（611 个测试，`tests/byok-*.test.js`）

> 测试名按测试文件分组，保留英文原文方便 grep 检索。完整列表与英文版 [verification.md](verification.md) 一致。

测试名列表与英文版完全相同，请参阅 [verification.md](verification.md#behavior--test-map-611-tests-across-testsbyok-testjs) 的完整清单。以下仅列出分类结构和文件级计数：

- **Identity / hygiene** — `byok-extension-installer.test.js` (3)
- **Workbench hook install** — `byok-workbench-install.test.js` (46), `byok-workbench-preflight-live.test.js` (1)
- **Routing / hook runtime** — `byok-hook-runtime.test.js` (26), `byok-hook-transport.test.js` (50), `byok-server-hook-sync.test.js` (9), `byok-server-routing.test.js` (12), `byok-server-run.test.js` (15)
- **Models** — `byok-server-native-less.test.js` (3)
- **Tools** — `byok-hook-client-bridge.test.js` (10), `byok-hook-edit.test.js` (7), `byok-hook-mcp.test.js` (5), `byok-hook-mirror-conformance.test.js` (2), `byok-hook-todo.test.js` (6), `byok-provider-interaction-tools.test.js` (8), `byok-provider-tools.test.js` (75)
- **Provider loops** — `byok-extension-streaming.test.js` (8), `byok-provider-anthropic.test.js` (36), `byok-provider-auth.test.js` (9), `byok-provider-client-tools-failure.test.js` (1), `byok-provider-history-content.test.js` (35), `byok-provider-native-tool-result-formats.test.js` (1), `byok-provider-openai-chat.test.js` (102), `byok-provider-openai-responses.test.js` (52), `byok-provider-schema-combinators.test.js` (7), `byok-provider-tool-error-result-formats.test.js` (2)
- **State / protocol / server** — `byok-runtime-http-bridge.test.js` (18), `byok-runtime-queue.test.js` (12), `byok-runtime-session.test.js` (14), `byok-server-mcp-cache.test.js` (18)
- **Extension / installer** — `byok-extension-activation.test.js` (8), `byok-extension-control-plane.test.js` (12)

## 安装检查

```bash
npm run preflight:cursor
npm run install:cursor
```

然后重启 Cursor 并确认：

- `preflight:cursor` 会报告至少一个支持的 hook 点，而且不会写目标文件。
- `~/.cursor/extensions/starduster.cursor-byok-1.0.0` 存在。
- Cursor 扩展注册表（`~/.cursor/extensions/extensions.json`）包含 `starduster.cursor-byok`，无遗留 BYOK 条目。
- `workbench.desktop.main.js` 中恰好有一个 `CURSOR-BYOK-HOOK-V2-START` 标记（安装器多次运行幂等——先剥离再插入）。
- 在 **干净** 的 Cursor 目标上安装时，`~/.cursor-byok/workbench-hook-state.json` 与 `~/.cursor-byok/workbench-backups/` 会在安装后存在。
- 服务器运行时，`http://127.0.0.1:<active-port>/byok/health` 返回 `{"ok":true,"byokMode":…,"workspaceRoots":[…]}`。多窗口安装还可能包含 `windowId` 和 `windowScoped`。活动端口可能是配置的基准端口，也可能是向上探测后找到的下一个可用端口。
- 如果要验证回滚，针对一次性或刚重装的 Cursor 目标运行 `npm run restore:cursor`，并确认备份的 workbench 文件哈希回到安装前。

## UI 回归

用一个已配置的 BYOK 模型，在聊天 UI 里跑真实 Cursor 工具。最小回归提示应覆盖：写一个临时文件 → 用显式 `offset` 和 `limit` 读它 → 用 Edit 或 ApplyPatch 改它 → 再用显式 `offset`/`limit` 读一次 → grep 改动内容 → glob 该文件 → 删除它。

从 `Cursor BYOK` 输出通道 / `~/.cursor-byok/cursor-byok.log`（`LocalLog`，日志标签在 `src/server/*`）收集证据：

- `"BYOK run"` —— 运行使用预期的 `provider`/`model`/`toolCount`。
- `"BYOK tool call"` —— Read 调用含 `argumentKeys` 带 `path`/`offset`/`limit`，且 `readHasPath`/`readHasOffset`/`readHasLimit` 为真；`requestId` 与 `conversationId` 不同。
- `"BYOK Cursor exec result"` / `"BYOK returning Cursor exec result"` —— `messageCase:"readResult"`、`resultCase:"success"`，非空文件 `contentLength` 为非零（`summarizeExecResult`）。
- Edit 桥接发出内部 `<id>-read`/`<id>-write` exec id 和最终 `editResult`。
- Grep/Glob/Delete 返回 success；上述文件工具没有超时、畸形结果、意外的自定义工具卡片，或被替换成原生 Shell。

官方模型要单独检查：选官方 Cursor 模型**不应**调用 BYOK provider 适配器（无 `"BYOK run"` 日志；流量落回 `api2.cursor.sh`）。
