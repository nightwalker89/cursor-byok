# 安装与配置

[English](install-config.md)

## 安装

```bash
npm install
npm run preflight:cursor
npm run install:cursor
```

`./install.sh` 是更短的路径：执行 `npm ci`/`npm install` 后直接跑 `npm run install:cursor`（不含 `preflight:cursor`）。

`npm run install:cursor` 运行 `scripts/install-cursor.js`，它会：

1. `ensureConfigFiles()` —— 创建 `~/.cursor-byok` 并补齐缺失的配置。
2. 从 `package.json` 算出目标目录 `~/.cursor/extensions/<publisher>.<name>-<version>`（即 `starduster.cursor-byok-1.0.0`）。
3. `removeLegacyExtensions()` + `removeLegacyAppExtensions()` —— 在用户扩展目录和 App 内置扩展目录中，清理匹配 `LEGACY_NAME_RE` 的旧 BYOK 安装。
4. `copyTree(repo → extensionRoot, shouldCopy)` —— 按白名单复制：顶层目录 `src/`、`scripts/`、`docs/`、`resources/`；顶层文件 `package.json`、`package-lock.json`、`README*.md`、`CONTRIBUTING.md`、`byok-system-prompt.md`、`models-catalog.json`、`install.sh`、`reinstall.sh`。其余内容（含 `.git`、`node_modules`、`tests/`、`proposals/` 和 scratch 文件）都会跳过。
5. `installRuntimeDependencies()` —— 在扩展目录里执行 `npm install --omit=dev --ignore-scripts`（安装 `@anthropic-ai/sdk` + `openai`）。
6. `refreshRegistry()` —— 在 `~/.cursor/extensions/extensions.json` 中 upsert `starduster.cursor-byok` 条目并清掉旧条目。
7. `installWorkbenchHook()` —— 给 workbench 打补丁（见 [routing-hook_CN.md](routing-hook_CN.md)），并在可能的情况下先保存当前 workbench/ext-host 的原始备份。若已挂载 Cursor 安装 DMG（`/Volumes/Cursor Installer/...` 或 `/private/tmp/cursor-dmg-*/...`），或设置了 `CURSOR_WORKBENCH_PRISTINE` 指向 pristine workbench 文件，则以其为 patch 基底，而不是已安装的 app bundle。

安装或更新 workbench hook 后**重启 Cursor**。

`npm run preflight:cursor` 以 dry-run 模式运行 hook 安装器。Cursor 更新后先跑它，确认当前 workbench 仍命中支持的 hook 点，再决定是否真正打补丁。`npm run restore:cursor` 恢复安装器记录的最近一次原始备份。

该包依赖 `@anthropic-ai/sdk`、`openai` 和 `acorn`（`package.json`）；没有打包器——`main` 直接指向 `./src/extension.js`。`acorn` 是运行时依赖，因为安装器的 AST 补丁和语法校验在扩展宿主（`--omit=dev` 环境）里运行。

## 运行注意事项

- **打 hook 会直接修改 app bundle。** `installWorkbenchHook()` 会改 `/Applications/Cursor.app` 里的 `workbench.desktop.main.js` 和 `extensionHostProcess.js`。ext-host 目标会注入完整 hook 运行时、transport-factory 补丁和完整性提示抑制，不只是 integrity 片段。这可能破坏 Cursor 或 macOS 的完整性或签名预期；安装器不会保留或重建官方签名。
- **`preflight:cursor` 只检查 hook 接缝，不验证信任链。** 它只能告诉你当前 workbench 是否还能命中支持的 hook 点，不能保证 patch 后的 app 仍会被 macOS 或未来的 Cursor 完整性逻辑当作 pristine。
- **备份是机会性的。** `restore:cursor` 只能恢复"安装器第一次见到时还是 pristine"的文件。如果目标 app 之前已经被 patch 过，状态文件里可能只有 warning，没有原始文件可回滚。
- **共享 server 模式下地址漂移会出问题。** 扩展宿主监听地址优先取 VS Code 设置，但 workbench hook 安装时把 `routes.json.server` 写死进字符串。改端口后要保持两边一致，并重装 hook。
- **大量自定义 redirect 会带来额外开销。** 当前默认值刻意收得很窄，就是为了压住空闲 CPU；如果把很多 REST 路径重新绕进扩展宿主，高空闲占用可能会卷土重来。

## 运行时配置

运行时文件放在 `~/.cursor-byok`（`CONFIG_DIR_NAME`，见 `src/config.js`）。`ensureConfigFiles()` 在激活时创建缺失文件，**保留**已有的 provider 和 routes 文件。

| 文件 | 用途 |
|------|------|
| `providers.json` | provider 定义及各 provider 暴露的 BYOK 模型。 |
| `routes.json` | `byokMode`、本地服务器 `host`/`port`，以及要重定向到本地服务器的 Cursor 路由模式。 |
| `models-catalog.json` | 缺失时从仓库复制（供面板的目录搜索使用）。 |
| `cursor-byok.log` | 当 `cursorByok.log.file` 开启时的文件日志（`src/log.js`）。 |
| `workbench-hook-state.json` | 最近一次捕获到的 Cursor workbench/ext-host 原始备份元数据。 |
| `workbench-backups/` | `restore:cursor` 使用的按内容寻址备份文件。 |

### `providers.json` schema

```jsonc
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "my-openai",                 // slug；缺省由 name 推导（normalizeProviderConfig）
      "name": "My OpenAI",
      "type": "openai-chat",             // openai-chat | openai-responses | anthropic
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "value": "sk-...", "kind": "bearer" },  // kind: bearer | api-key
      "headers": { "x-foo": "bar" },     // 可选默认头
      "models": [
        {
          "id": "gpt-5",                 // Cursor 公开模型 id（publicCursorModelId）
          "apiModel": "gpt-5",           // 发往 provider API 的 id
          "displayName": "GPT-5",
          "contextTokenLimit": 200000,   // 默认 128000（toCursorModel）
          "maxOutputTokens": 16384,      // 默认 8192
          "supportsAgent": true,         // 默认 true
          "supportsImages": false,
          "thinking": false,             // → supportsThinking
          "supportsMaxMode": true,       // 默认 true
          "supportsNonMaxMode": true,    // 默认 true
          "supportsAutoContext": false,
          "supportsPlan": false,
          "supportsCmdK": false,
          "tooltipMarkdown": "…",        // 可选 → tooltipData.markdownContent
          "legacyId": "…", "legacySlugs": ["…"], "idAliases": ["…"]
        }
      ]
    }
  ]
}
```

无论通过 GUI 还是直接编辑 JSON，所有改动都经 `normalizeProvidersConfig`/`normalizeModelConfig`（`src/extension.js`）规范化：provider `id` 由 name 转 slug，`type` 缺省为 `openai-chat`，支持的 `auth.kind`（`bearer` / `api-key`）随非空 `auth.value` 保留，空的 `baseUrl`/`headers` 自动丢弃，model `id` 回退到 `apiModel`/`displayName`，受支持的 Cursor 模型元数据会被规范化，未知的 provider/model 扩展字段保留。

`toCursorModel`（`src/runtime/models.js`）把每个模型映射成完整的 Cursor 模型配置（`id, name, displayName, clientDisplayName, apiModel, serverModelName, providerId/Name/Type, isByok:true, supports*, contextTokenLimit, maxOutputTokens, isUserAdded:true, namedModelSectionIndex:2, …`）。随机旧 id（`model-xxxxxx`）不会被当作公开 id 暴露（`publicCursorModelId`，由测试 *"available models do not expose migrated legacy random model ids"* 保证）。

### `routes.json` schema

```jsonc
{
  "schemaVersion": 1,
  "byokMode": 1,                          // 1 = 开，0 = 关（关 → 无重定向）
  "server": { "host": "127.0.0.1", "port": 9960 },
  "redirect": [ "aiserver.v1.AiService/AvailableModels", "agent.v1.AgentService/RunSSE", … ]
}
```

`loadRoutes` 回退到 `{ byokMode:1, server:{DEFAULT_HOST,DEFAULT_PORT}, redirect: DEFAULT_REDIRECTS }`。`normalizeRoutes` 收敛结构，并保留非空的 `redirect` 或恢复 `DEFAULT_REDIRECTS`。默认重定向集合（`src/constants.js` 中的 `DEFAULT_REDIRECTS`）现在故意收得很窄，只保留 `/auth/*` 会员/支付探测、`REST:/byok/checkpoint`、`AvailableModels`、`AgentService/RunSSE`、`AgentService/Run` 和 `BidiService/BidiAppend`。`REST:/byok/checkpoint` 会原样代理到上游（BYOK 不在本地存储 conversation checkpoint 状态）。目的是让认证检查和 BYOK 需要的传输 hook 留在本地，同时不让旧的 Dashboard/KnowledgeBase 宽路由继续绕进扩展宿主。`REST:` 开头的是 REST 路径，裸条目是 gRPC 服务路径。已有 `routes.json` 如果还等于旧的宽默认集合，会在 `ensureConfigFiles()` 中自动迁移到认证加传输默认值。

## VS Code 设置

`cursorByok.*`（`package.json`）：

- `cursorByok.server.host` —— 默认 `127.0.0.1`。
- `cursorByok.server.port` —— 基准端口，默认 `9960`。扩展会从基准端口起连续探测 8 个端口（`DEFAULT_PORT_SEARCH_COUNT`），直到找到可用的 BYOK 监听端口或已存在的共享 BYOK 服务。
- `cursorByok.server.autoStart` —— 默认 `true`（在 `activate` 中启动服务器）。
- `cursorByok.log.file` —— 默认 `true`。

**地址优先级**：服务器监听地址优先用 VS Code 设置，回退到 `routes.json.server`（`startServer`/`panelState`，`src/extension.js`）。而 **workbench hook** 用 `routes.json` 里的地址，因为安装时把 host/port 写进了 hook 字符串（`installWorkbenchHook` 读 `loadRoutes().server`）。两者要保持一致——改了端口就要重新安装 hook。

## 控制面板

活动栏视图 `cursorByok.panel` 和状态栏项（命令 `cursorByok.openPanel`）打开控制面板（`PanelProvider`，`src/extension.js`；UI 在 `src/webview.html`）。面板 ⇄ 扩展消息协议（`onDidReceiveMessage` / `postMessage`）：

- **webview → 扩展**：`ready`、`toggle`、`setEnabled`、`start`、`stop`、`toggleServer`、`installHook`、`providers`/`editProvidersJson`/`routes`/`log`/`settings`（打开文件）、`toggleFileLog`、`saveProviders`、`refresh`/`refreshProviders`、`fetchRemoteModels`、`searchCatalog`。消息可用 `command` 或 `type`。
- **扩展 → webview**：`state`（`panelState()` 对象：`running, serverOwner, serverStatus, mode, host, port, routes, providers, models, fileLog, providersConfig, providersData`）、`remoteModelsResult`、`searchCatalogResult`。

命令（也在命令面板，`package.json`）：`cursorByok.toggleMode`、`startServer`、`stopServer`、`installWorkbenchHook`、`restoreWorkbenchHook`、`openProviders`、`openRoutes`、`openLog`、`openSettings`、`toggleFileLog`、`openPanel`。

保存 provider JSON（GUI 或直接编辑 `providers.json`，后者由 `watchProvidersFile` 监听）会更新面板状态、状态栏上的模型计数，以及供已加载 hook 使用的服务器 `models` 事件（`notifyProvidersChanged` → `server.broadcast("models", …)`）。

## 测试

`tests/byok-extension-activation.test.js`、
`tests/byok-extension-control-plane.test.js`、
`tests/byok-extension-installer.test.js`：*"fresh install config is created
without overwriting existing providers or routes"*、*"grey-box extension
activates with config"*、*"grey-box extension probes the next BYOK port when the
base port is already in use"*、*"grey-box extension activation attaches to an
existing BYOK server with the same workspace roots"*、*"grey-box extension
activation skips shared BYOK server with different workspace roots"*、*"extension installer copies runtime files but not tests
or git metadata"*、*"extension installer removes legacy extension directories
and registry entries"*、*"extension installer removes legacy builtin app
extension directory"*。
