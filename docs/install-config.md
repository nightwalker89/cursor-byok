# Install and Config

[中文版](install-config_CN.md)

## Install

```bash
npm install
npm run preflight:cursor
npm run install:cursor
```

`./install.sh` is a shorter path: it runs `npm ci`/`npm install` and then
`npm run install:cursor` only (no `preflight:cursor`).

`npm run install:cursor` runs `scripts/install-cursor.js`, which:

1. `ensureConfigFiles()` — create `~/.cursor-byok` and seed missing config.
2. Compute the target dir `~/.cursor/extensions/<publisher>.<name>-<version>`
   (i.e. `starduster.cursor-byok-1.0.0`) from `package.json`.
3. `removeLegacyExtensions()` + `removeLegacyAppExtensions()` — delete prior BYOK
   installs matched by `LEGACY_NAME_RE` from both the user extensions dir and the
   app builtin extensions dir.
4. `copyTree(repo → extensionRoot, shouldCopy)` — copy via an allow-list:
   top-level dirs `src/`, `scripts/`, `docs/`, `resources/`; top-level files
   `package.json`, `package-lock.json`, `README*.md`, `CONTRIBUTING.md`,
   `byok-system-prompt.md`, `models-catalog.json`, `install.sh`, `reinstall.sh`.
   Everything else — including `.git`, `node_modules`, `tests/`, `proposals/`,
   and scratch files — is skipped.
5. `installRuntimeDependencies()` — `npm install --omit=dev --ignore-scripts` in
   the extension dir (installs `@anthropic-ai/sdk` + `openai`).
6. `refreshRegistry()` — upsert the `starduster.cursor-byok` entry in
   `~/.cursor/extensions/extensions.json` and drop legacy entries.
7. `installWorkbenchHook()` — patch the workbench file (see `routing-hook.md`),
   but only after capturing a pristine backup of the current workbench/ext-host
   when possible. When a mounted Cursor installer DMG is present
   (`/Volumes/Cursor Installer/...` or `/private/tmp/cursor-dmg-*/...`), or when
   `CURSOR_WORKBENCH_PRISTINE` points at a pristine workbench file, that copy is
   used as the patch base instead of the already-installed app bundle.

**Restart Cursor** after installing or updating the workbench hook.

`npm run preflight:cursor` runs the hook installer in dry-run mode. Use it after
Cursor updates to confirm the current workbench still exposes a supported hook
point before patching. `npm run restore:cursor` restores the last pristine
backup recorded by the installer.

The package depends on `@anthropic-ai/sdk`, `openai`, and `acorn`
(`package.json`); there is no bundler — `main` points at
`./src/extension.js` directly. `acorn` is a runtime dependency because the
installer's AST-based patching and syntax validation run in the extension host
(`--omit=dev` environment).

## Operational Caveats

- **Patching changes the app bundle.** `installWorkbenchHook()` modifies
  `workbench.desktop.main.js` and `extensionHostProcess.js` inside
  `/Applications/Cursor.app`. The ext-host target receives the full hook runtime
  plus transport-factory patches and integrity-warning suppression, not just the
  integrity snippet. That can break Cursor/macOS integrity or signature
  expectations; the installer does not preserve or recreate the original
  signature.
- **`preflight:cursor` is a seam check, not a notarization check.** It tells you
  whether the current workbench still matches a supported hook point before any
  writes happen. It does not guarantee the patched app will be accepted as
  pristine by macOS or future Cursor integrity logic.
- **Backup capture is opportunistic.** `restore:cursor` can only restore files
  that were pristine when this installer first saw them. If the target app had
  already been patched, the state file may contain warnings instead of pristine
  backups.
- **Shared-server mode means address drift matters.** The extension host uses VS
  Code settings first, but the workbench hook embeds `routes.json.server` at
  install time. Keep those aligned or reinstall the hook after changing ports.
- **Broad custom redirect sets are not free.** The shipped defaults are narrow on
  purpose; adding back broad REST redirects can reintroduce high idle
  extension-host CPU.

## Runtime Config

Runtime files live under `~/.cursor-byok` (`CONFIG_DIR_NAME`, `src/config.js`).
`ensureConfigFiles()` creates missing files on activation and **preserves**
existing provider and route files.

| File | Purpose |
|------|---------|
| `providers.json` | Provider definitions and the BYOK models each exposes. |
| `routes.json` | `byokMode`, local server `host`/`port`, and the Cursor route patterns to redirect through the local server. |
| `models-catalog.json` | Catalog copied from the repo when missing (used by the panel's catalog search). |
| `cursor-byok.log` | File log when `cursorByok.log.file` is enabled (`src/log.js`). |
| `workbench-hook-state.json` | Last captured pristine backup metadata for Cursor's workbench/ext-host patch targets. |
| `workbench-backups/` | Content-addressed backup copies used by `restore:cursor`. |

### `providers.json` schema

```jsonc
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "my-openai",                 // slug; defaults from name (normalizeProviderConfig)
      "name": "My OpenAI",
      "type": "openai-chat",             // openai-chat | openai-responses | anthropic
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "value": "sk-...", "kind": "bearer" },  // kind: bearer | api-key
      "headers": { "x-foo": "bar" },     // optional default headers
      "models": [
        {
          "id": "gpt-5",                 // public Cursor model id (publicCursorModelId)
          "apiModel": "gpt-5",           // id sent to the provider API
          "displayName": "GPT-5",
          "contextTokenLimit": 200000,   // default 128000 (toCursorModel)
          "maxOutputTokens": 16384,      // default 8192
          "supportsAgent": true,         // default true
          "supportsImages": false,
          "thinking": false,             // → supportsThinking
          "supportsMaxMode": true,       // default true
          "supportsNonMaxMode": true,    // default true
          "supportsAutoContext": false,
          "supportsPlan": false,
          "supportsCmdK": false,
          "tooltipMarkdown": "…",        // optional → tooltipData.markdownContent
          "legacyId": "…", "legacySlugs": ["…"], "idAliases": ["…"]
        }
      ]
    }
  ]
}
```

GUI and JSON edits are round-tripped through
`normalizeProvidersConfig`/`normalizeModelConfig` (`src/extension.js`): provider
`id` slugifies from name, `type` defaults to `openai-chat` when missing, supported
`auth.kind` (`bearer` / `api-key`) is preserved with non-empty `auth.value`,
empty `baseUrl`/`headers` are dropped, model `id` falls back to
`apiModel`/`displayName`, supported Cursor model metadata is normalized, and
unknown provider/model extension fields are preserved.

`toCursorModel` (`src/runtime/models.js`) maps each model to the full Cursor model
config (`id, name, displayName, clientDisplayName, apiModel, serverModelName,
providerId/Name/Type, isByok:true, supports*, contextTokenLimit,
maxOutputTokens, isUserAdded:true, namedModelSectionIndex:2, …`). Random legacy
ids (`model-xxxxxx`) are not exposed as the public id (`publicCursorModelId`,
proven by test *"available models do not expose migrated legacy random model
ids"*).

### `routes.json` schema

```jsonc
{
  "schemaVersion": 1,
  "byokMode": 1,                          // 1 = on, 0 = off (off → no redirects)
  "server": { "host": "127.0.0.1", "port": 9960 },
  "redirect": [ "aiserver.v1.AiService/AvailableModels", "agent.v1.AgentService/RunSSE", … ]
}
```

`loadRoutes` falls back to `{ byokMode:1, server:{DEFAULT_HOST,DEFAULT_PORT},
redirect: DEFAULT_REDIRECTS }`. `normalizeRoutes` clamps shape and keeps a
non-empty `redirect` or restores `DEFAULT_REDIRECTS`. The default redirect set
(`src/constants.js DEFAULT_REDIRECTS`) is intentionally narrow:
the `/auth/*` membership/payment probes, `REST:/byok/checkpoint`,
`AvailableModels`, `AgentService/RunSSE`, `AgentService/Run`, and
`BidiService/BidiAppend`. `REST:/byok/checkpoint` is proxied upstream unchanged
(BYOK does not store conversation checkpoint state locally). The goal is to keep
the auth checks and BYOK-specific transport hooks local without proxying the old
broad Dashboard/KnowledgeBase surface through the extension host. `REST:` entries
are REST paths; bare entries are gRPC service paths.
Existing `routes.json` files that still match the old broad default set are
migrated automatically to the auth plus transport defaults during
`ensureConfigFiles()`.

## VS Code Settings

Contributed under `cursorByok.*` (`package.json`):

- `cursorByok.server.host` — default `127.0.0.1`.
- `cursorByok.server.port` — default base port `9960`. The extension probes 8
  consecutive ports starting at the base port (`DEFAULT_PORT_SEARCH_COUNT`) until
  it finds a free BYOK listener or an existing shared BYOK server.
- `cursorByok.server.autoStart` — default `true` (start server in `activate`).
- `cursorByok.log.file` — default `true`.

**Address precedence**: the server listen address uses VS Code settings first and
falls back to `routes.json.server` (`startServer`/`panelState` in
`src/extension.js`). The **workbench hook** uses the `routes.json` address,
because that host/port is embedded into the hook string at install time
(`installWorkbenchHook` reads `loadRoutes().server`). Keep them consistent, or
re-run the hook install after changing the port.

## Control Panel

The Activity Bar view `cursorByok.panel` and the status bar item (command
`cursorByok.openPanel`) open the Control Panel (`PanelProvider`,
`src/extension.js`; UI in `src/webview.html`). The panel ⇄ extension message
protocol (`onDidReceiveMessage` / `postMessage`):

- **webview → extension**: `ready`, `toggle`, `setEnabled`, `start`, `stop`,
  `toggleServer`, `installHook`, `providers`/`editProvidersJson`/`routes`/`log`/
  `settings` (open file), `toggleFileLog`, `saveProviders`,
  `refresh`/`refreshProviders`, `fetchRemoteModels`, `searchCatalog`. Messages
  may use either `command` or `type`.
- **extension → webview**: `state` (the `panelState()` object: `running,
  serverOwner, serverStatus, mode, host, port, routes, providers, models,
  fileLog, providersConfig, providersData`), `remoteModelsResult`,
  `searchCatalogResult`.

Commands (also in the command palette, `package.json`): `cursorByok.toggleMode`,
`startServer`, `stopServer`, `installWorkbenchHook`, `restoreWorkbenchHook`, `openProviders`,
`openRoutes`, `openLog`, `openSettings`, `toggleFileLog`, `openPanel`.

Saving provider JSON (GUI or editing `providers.json`, watched by
`watchProvidersFile`) updates panel state, the status bar model count, and the
server's `models` event used by an already-loaded hook
(`notifyProvidersChanged` → `server.broadcast("models", …)`).

## Evidence / Tests

`tests/byok-extension-activation.test.js`,
`tests/byok-extension-control-plane.test.js`, and
`tests/byok-extension-installer.test.js`: *"fresh install config is created
without overwriting existing providers or routes"*, *"grey-box extension
activates with config"*, *"grey-box extension probes the next BYOK port when the
base port is already in use"*, *"grey-box extension activation attaches to an
existing BYOK server with the same workspace roots"*, *"grey-box extension
activation skips shared BYOK server with different workspace roots"*, *"extension installer copies runtime files but not tests
or git metadata"*, *"extension installer removes legacy extension directories
and registry entries"*, *"extension installer removes legacy builtin app
extension directory"*.
