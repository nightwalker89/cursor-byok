# Cursor BYOK

[English](README.md)

**把你自己的 API key 接进 Cursor。** `starduster.cursor-byok` 是一个可读的本地适配器。你自有的 provider 模型（OpenAI、OpenAI 兼容、Anthropic）会出现在 Cursor 模型选择器里，走你自己的 key 跑；官方 Cursor 模型继续走原通道，互不干扰。

## 工作原理

- 扩展宿主里跑一个本地 HTTP 服务器（默认 `127.0.0.1:9960`）。
- 在 Cursor workbench 注入一个小 hook，将 Connect transport 包裹起来，对每个请求按需处理——合并模型到 `AvailableModels`、用你的 provider 在本地跑一次 BYOK 对话、或直接放行官方流量。
- 工具在 Cursor 里**原生执行**——适配器把 provider 的工具调用转给 Cursor 自己的工具实现，再把结果送回 provider 循环。无自定义工具卡片；provider 可见的结果仅按工具类型做最小化格式化。

设计细节——架构、路由/Hook、provider/工具、验证——见 [`docs/`](docs/README_CN.md)（中英双语）。

## 安装

```bash
npm install
npm run preflight:cursor
npm run install:cursor
```

`./install.sh` 会执行 `npm ci`/`npm install`，然后只跑 `npm run install:cursor`（不含 `preflight:cursor`）。

`npm run install:cursor` 把扩展复制到 `~/.cursor/extensions`、安装运行时依赖、给 Cursor 的 workbench 打 hook、刷新扩展注册表。之后**重启 Cursor**；Cursor 升级后需要重新跑一次。
`npm run preflight:cursor` 会先检查当前 Cursor 是否还能命中受支持的 hook 点，写文件之前就有结果；`npm run restore:cursor` 把最近一次捕获的原始 workbench 备份从 `~/.cursor-byok/` 恢复回去。

## 配置

运行时配置放在 `~/.cursor-byok/`：

- `providers.json` —— 你的 provider 以及各个 provider 暴露的模型。
- `routes.json` —— BYOK 开关、本地服务器 host/port，以及哪些 Cursor 路由走本地服务器。
- `models-catalog.json` —— 从本仓库复制的 provider/模型目录。
- `workbench-hook-state.json` + `workbench-backups/` —— 最近一次保存的 Cursor 原始 workbench/ext-host 备份，供 `npm run restore:cursor` 回滚使用。

VS Code 设置（`cursorByok.*`）：`server.host`、`server.port`、`server.autoStart`、`log.file`。日常通过**控制面板**（活动栏）或 `Cursor BYOK:` 命令管理一切——切换模式、启停服务器、安装 hook、编辑 providers/routes、打开日志。

## 限制与注意事项

- **它会修改已安装的 Cursor app bundle。** `installWorkbenchHook()` 会 patch `workbench.desktop.main.js` 和 `extensionHostProcess.js`。ext-host 目标会注入完整 hook 运行时、transport-factory 补丁和完整性提示抑制，不只是 integrity 片段。这会破坏 Cursor 自己的 bundle 完整性和代码签名预期；当前实现**不会**保留或重签官方 bundle。
- **`preflight` 只检查兼容性，不保证信任链不变。** `npm run preflight:cursor` 只能告诉你当前 Cursor 版本是否还暴露了支持的 hook 接缝，不能保证 macOS 或 Cursor 会把 patch 后的 app 当作 pristine。
- **只有先捕获过 pristine 备份，restore 才有意义。** 如果这份 app 在当前安装器接手之前就已经被 patch 过，`restore:cursor` 没有原始官方内容可恢复。
- **Cursor 更新后补丁可能失效。** 每次 Cursor 升级后先跑 `preflight:cursor`，确认 hook 接缝还在，再考虑是否重装 hook。
- **有些工具是桥接/模拟的，不会和官方路径字节级完全一致。** BYOK 优先走 Cursor 原生 exec，但下面这些工具需要适配：
  - `Edit`、`ApplyPatch`、`EditNotebook` 走 read-then-write bridge。
  - `Glob` 实际通过 Cursor `grepArgs` 的 `files_with_matches` 模式执行。
  - `WebSearch`、`GenerateImage` 只有在 Cursor 显式暴露时才走 client-tool bridge。
  - `AskQuestion`、`SwitchMode`、`CreatePlan`、MCP 鉴权走 interaction bridge，不是原生 exec 信封。
  - 没有原生映射的工具会直接返回本地错误，而不是强行模拟未知的官方行为。
- **`AwaitShell` 当前必须带真实的 `shell_id` 或 `task_id`。** 运行时没有实现"只 sleep 一下"的兜底。
- **自定义太宽的 redirect 配置会拉高空闲开销。** 默认路由集合刻意缩到最小；再把大量 REST 路径绕进扩展宿主的话，空闲时高 CPU 会卷土重来。

## 验证

```bash
npm run check          # 语法门 + ESLint + node --test
```

覆盖范围：插件标识约束、首次安装配置生成、控制面板命令、workbench hook 标记替换、动态路由更新、官方/BYOK 路由边界、`AvailableModels` 合并、Read/Grep/Glob/AwaitShell 行为、read-then-write edit 桥接、provider 工具结果闭环（OpenAI Chat、OpenAI Responses、Anthropic）、schema 归一化、prompt 规则，以及安装工具的正确性。

## 致谢

本项目基于 **cometix** 的原始 [`@cometix/ccursor`](https://www.npmjs.com/package/@cometix/ccursor) Cursor BYOK 扩展重新实现：借鉴了其核心思路与整体框架，并把运行时的大部分——尤其是工具调用流程（Cursor 原生 exec）与 prompt 注入流程——重写为可读、未混淆的代码。感谢 cometix 的原始工作。
