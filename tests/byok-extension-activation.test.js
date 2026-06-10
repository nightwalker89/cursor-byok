"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CATALOG_FILE, DEFAULT_REDIRECTS } = require("../src/constants");
const { copyTree, refreshRegistry, removeLegacyAppExtensions, removeLegacyExtensions, shouldCopy } = require("../scripts/install-cursor");
const {
  configDir,
  ensureConfigFiles,
  loadRoutes,
  providersPath,
  routesPath,
  writeRoutes,
  writeJsonFile,
  logPath,
} = require("../src/config");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const { protoMessage, fieldMessage, fieldString, quietLog, recordingLog, deferred, tick, useHome, pickFields, waitForWebviewPost, runPanelWebviewScript, fakeReadableStream, interceptModule, interceptModules } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");
const DEFAULT_PANEL_WEB_TOOLS = {
  webSearch: { provider: "exa", type: "auto", numResults: 10 },
  webFetch: { provider: "builtin" },
};

test("grey-box extension activates with config, commands, server controls, and panel state", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 0 }, redirect: DEFAULT_REDIRECTS });
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model" }, { id: "second-model" }],
    }],
  });
  const registeredCommands = new Map();
  const opened = [];
  const messages = [];
  const configValues = new Map([
    ["server.host", "127.0.0.1"],
    ["server.port", 0],
    ["server.autoStart", true],
    ["log.file", false],
  ]);
  let registeredViewProvider = null;
  let webviewMessageHandler = null;
  const webviewPosts = [];
  let webviewHtml = "";
  const waiters = [];
  const statusBarItems = [];
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand(command, callback) {
        registeredCommands.set(command, callback);
        return { dispose() {} };
      },
      executeCommand(command, ...args) {
        const callback = registeredCommands.get(command);
        if (callback) return callback(...args);
        opened.push({ command, args });
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          text: "",
          tooltip: "",
          command: undefined,
          shown: false,
          disposed: false,
          show() {
            this.shown = true;
          },
          hide() {
            this.shown = false;
          },
          dispose() {
            this.disposed = true;
          },
        };
        statusBarItems.push(item);
        return item;
      },
      registerWebviewViewProvider(id, provider, options) {
        registeredViewProvider = { id, provider, options };
        return { dispose() {} };
      },
      showInformationMessage(message) {
        messages.push(message);
        return Promise.resolve();
      },
      showWarningMessage(message) {
        messages.push(message);
        return Promise.resolve();
      },
      showTextDocument(document) {
        opened.push(document.fileName);
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "cursorByok");
        return {
          get(key, fallback) {
            return configValues.has(key) ? configValues.get(key) : fallback;
          },
          update(key, value) {
            configValues.set(key, value);
            return Promise.resolve();
          },
        };
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const installerPath = require.resolve("../scripts/install-workbench-hook");
  const serverModulePath = require.resolve("../src/server/http");
  const fakeServers = [];
  class FakeByokServer {
    constructor({ host, port, onEventClientConnected }) {
      this.host = host;
      this.port = port || 43123;
      this.onEventClientConnected = onEventClientConnected;
      this.broadcasts = [];
      this.server = {
        address: () => ({ port: this.port }),
      };
      fakeServers.push(this);
    }
    async start() {
      this.onEventClientConnected?.({ windowId: "1", eventClientCount: 1 });
    }
    async stop() {}
    broadcast(event, data) {
      this.broadcasts.push({ event, data });
    }
  }
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeByokServer,
    },
    [installerPath]: {
      installWorkbenchHook: () => ({
        routes: DEFAULT_REDIRECTS.length,
        transportHookPoints: ["connect-promise-client"],
        patchedHookPoints: [],
        backupsCreated: 2,
        backupWarnings: [],
      }),
      restoreWorkbenchHook: () => ({
        restoredFiles: ["/tmp/workbench.js", "/tmp/extensionHostProcess.js"],
        missingBackups: [],
      }),
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);

    assert.equal(fs.existsSync(providersPath()), true);
    assert.equal(fs.existsSync(routesPath()), true);
    assert.equal(fs.existsSync(path.join(configDir(), CATALOG_FILE)), true);
    assert.equal(statusBarItems.length, 1);
    assert.equal(statusBarItems[0].alignment, fakeVscode.StatusBarAlignment.Right);
    assert.equal(statusBarItems[0].command, "cursorByok.openPanel");
    assert.equal(statusBarItems[0].shown, true);
    assert.match(statusBarItems[0].text, /BYOK/);
    assert.match(statusBarItems[0].text, /STARTING/);
    await waitForStatusBar(statusBarItems[0], (item) => /ON/.test(item.text));
    assert.match(statusBarItems[0].text, /ON/);
    assert.match(statusBarItems[0].tooltip, /Click to open Control Panel/);
    assert.match(statusBarItems[0].tooltip, /127\.0\.0\.1:/);
    assert.equal(registeredViewProvider.id, "cursorByok.panel");
    assert.equal(registeredViewProvider.options.webviewOptions.retainContextWhenHidden, true);
    registeredViewProvider.provider.resolveWebviewView({
      webview: {
        options: {},
        set html(value) {
          this._html = value;
          webviewHtml = value;
        },
        get html() {
          return this._html;
        },
        onDidReceiveMessage(handler) {
          webviewMessageHandler = handler;
        },
        postMessage(message) {
          webviewPosts.push(message);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(message)) {
              waiters.splice(i, 1)[0].resolve(message);
            }
          }
          return Promise.resolve(true);
        },
      },
    });
    assert.equal(typeof webviewMessageHandler, "function");
    assert.match(registeredViewProvider.provider.constructor.name, /PanelProvider/);
    assert.match(webviewHtml, /Fetch Remote Models/);
    assert.match(webviewHtml, /Auth Kind/);
    assert.match(webviewHtml, /Auth Value/);
    assert.match(webviewHtml, /API Model/);
    assert.match(webviewHtml, /Thinking Budget Tokens/);
    assert.match(webviewHtml, /fetchRemoteModels/);
    assert.match(webviewHtml, /saveProviders/);
    assert.match(webviewHtml, /webToolsCard/);
    assert.match(webviewHtml, /webSearchProviderList/);
    assert.match(webviewHtml, /webSearchExaOptionsGroup/);
    assert.match(webviewHtml, /webFetchApiKeyInput/);
    assert.match(webviewHtml, /supermarkdown/);
    const panelRuntime = runPanelWebviewScript(webviewHtml);
    panelRuntime.dispatchState({
      running: true,
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 1,
      models: 2,
      fileLog: false,
      providersConfig: {
        schemaVersion: 1,
        providers: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
      },
      providersData: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
    });
    assert.equal(panelRuntime.elements.server.textContent, "127.0.0.1:12345");
    assert.equal(panelRuntime.elements.serverIndicator.className, "pulse-indicator");
    assert.equal(panelRuntime.buttons.start.disabled, true);
    assert.equal(panelRuntime.buttons.stop.disabled, false);
    assert.match(panelRuntime.elements.mode.innerHTML, /ON/);
    assert.equal(panelRuntime.elements.models.textContent, "2");
    assert.equal(panelRuntime.elements.routes.textContent, "37");
    assert.equal(panelRuntime.elements.fileLogInput.checked, false);
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /Panel Provider/);
    panelRuntime.dispatchState({
      running: true,
      serverOwner: "shared",
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 1,
      models: 2,
      fileLog: false,
      providersConfig: {
        schemaVersion: 1,
        providers: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
      },
      providersData: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
    });
    assert.equal(panelRuntime.elements.server.textContent, "shared 127.0.0.1:12345");
    assert.equal(panelRuntime.elements.byokModeInput.checked, true);
    assert.equal(panelRuntime.buttons.start.disabled, true);
    assert.equal(panelRuntime.buttons.stop.disabled, true);
    const postCountBeforeServerCardClick = panelRuntime.posts.length;
    panelRuntime.elements.serverStatusCard.click();
    assert.equal(panelRuntime.posts.length, postCountBeforeServerCardClick);
    panelRuntime.elements.byokModeSwitchCard.click();
    assert.deepEqual(panelRuntime.posts.at(-1), { command: "setEnabled", enabled: false });
    panelRuntime.elements.byokModeInput.checked = true;
    panelRuntime.elements.byokModeInput.dispatchEvent({ type: "change" });
    assert.deepEqual(panelRuntime.posts.at(-1), { command: "setEnabled", enabled: true });
    panelRuntime.dispatchState({
      running: false,
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 1,
      models: 2,
      fileLog: false,
      providersConfig: {
        schemaVersion: 1,
        providers: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
      },
      providersData: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
    });
    assert.equal(panelRuntime.elements.byokModeInput.checked, false);
    assert.match(panelRuntime.elements.mode.innerHTML, /Server Off/);
    panelRuntime.dispatchState({
      running: true,
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 1,
      models: 1,
      fileLog: false,
      providersConfig: {
        schemaVersion: 1,
        providers: [{ id: "legacy-provider", name: "Legacy Provider", type: "gemini", models: [{ id: "legacy-model" }] }],
      },
      providersData: [{ id: "legacy-provider", name: "Legacy Provider", type: "gemini", models: [{ id: "legacy-model" }] }],
    });
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /<option value="gemini" selected>gemini<\/option>/);
    panelRuntime.context.saveProviders();
    assert.deepEqual(panelRuntime.posts.at(-1), {
      command: "saveProviders",
      providers: {
        schemaVersion: 1,
        ...DEFAULT_PANEL_WEB_TOOLS,
        providers: [{
          id: "legacy-provider",
          name: "Legacy Provider",
          type: "gemini",
          models: [{ id: "legacy-model" }],
        }],
      },
    });
    panelRuntime.dispatchState({
      running: true,
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 1,
      models: 2,
      fileLog: false,
      providersConfig: {
        schemaVersion: 1,
        providers: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
      },
      providersData: [{ id: "panel-provider", name: "Panel Provider", type: "anthropic", models: [{ id: "panel-model" }] }],
    });
    panelRuntime.dispatchMessage({
      command: "remoteModelsResult",
      pid: "panel-provider",
      models: [{ id: "remote-model", ownedBy: "remote-team" }],
    });
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /remote-model/);
    assert.match(
      panelRuntime.elements.providersContainer.innerHTML,
      /onclick="addRemoteModel\(0, 0\)"/,
      "remote model import onclick must use numeric provider index to avoid broken HTML quotes"
    );
    panelRuntime.context.addRemoteModel("panel-provider", 0);
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /remote-model/);
    assert.deepEqual(panelRuntime.posts.at(-1), {
      command: "saveProviders",
      providers: {
        schemaVersion: 1,
        ...DEFAULT_PANEL_WEB_TOOLS,
        providers: [{
          id: "panel-provider",
          name: "Panel Provider",
          type: "anthropic",
          models: [
            { id: "panel-model" },
            {
              id: "remote-model",
              apiModel: "remote-model",
              displayName: "remote-model",
              supportsAgent: true,
            },
          ],
        }],
      },
    });
    panelRuntime.dispatchState({
      running: true,
      mode: true,
      host: "127.0.0.1",
      port: 12345,
      routes: 37,
      providers: 0,
      models: 0,
      fileLog: false,
      providersConfig: { schemaVersion: 1, providers: [] },
      providersData: [],
    });
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /Panel Provider/);
    assert.match(panelRuntime.elements.providersContainer.innerHTML, /remote-model/);
    for (const command of [
      "cursorByok.toggleMode",
      "cursorByok.startServer",
      "cursorByok.stopServer",
      "cursorByok.installWorkbenchHook",
      "cursorByok.restoreWorkbenchHook",
      "cursorByok.openProviders",
      "cursorByok.openRoutes",
      "cursorByok.openLog",
      "cursorByok.openSettings",
      "cursorByok.toggleFileLog",
      "cursorByok.openPanel",
    ]) {
      assert.equal(registeredCommands.has(command), true, command);
    }

    const activatedState = extension.panelState();
    assert.equal(Number.isInteger(activatedState.port) && activatedState.port > 0, true);
    assert.deepEqual(
      pickFields(activatedState, ["running", "mode", "host", "routes", "providers", "models", "fileLog"]),
      {
        running: true,
        mode: true,
        host: "127.0.0.1",
        routes: DEFAULT_REDIRECTS.length,
        providers: 1,
        models: 2,
        fileLog: false,
      },
    );

    const activatedServer = fakeServers.at(-1);
    assert.equal(Array.isArray(activatedServer.broadcasts), true);

    await registeredCommands.get(statusBarItems[0].command)();
    assert.equal(loadRoutes().byokMode, 1);
    assert.deepEqual(opened.at(-1), { command: "workbench.view.extension.cursor-byok", args: [] });

    await registeredCommands.get("cursorByok.toggleMode")();
    assert.equal(loadRoutes().byokMode, 0);
    assert.equal(extension.panelState().mode, false);
    assert.equal(messages.at(-1), "Cursor BYOK OFF");
    assert.match(statusBarItems[0].text, /OFF/);
    assert.deepEqual(activatedServer.broadcasts.at(-1), { event: "routes", data: [] });

    await webviewMessageHandler({ command: "toggle" });
    assert.equal(loadRoutes().byokMode, 1);
    assert.equal(webviewPosts.at(-1).state.mode, true);
    assert.match(statusBarItems[0].text, /ON/);
    assert.equal(activatedServer.broadcasts.at(-1).event, "routes");
    assert.deepEqual(activatedServer.broadcasts.at(-1).data, routePatterns(loadRoutes()));

    await registeredCommands.get("cursorByok.stopServer")();
    assert.equal(extension.panelState().running, false);
    assert.match(statusBarItems[0].text, /BYOK NO SERVER/);
    assert.match(statusBarItems[0].tooltip, /Server: stopped/);
    await webviewMessageHandler({ command: "start" });
    assert.equal(webviewPosts.at(-1).state.running, true);
    assert.match(statusBarItems[0].tooltip, /Server: 127\.0\.0\.1:/);
    await webviewMessageHandler({ command: "stop" });
    assert.equal(webviewPosts.at(-1).state.running, false);
    await webviewMessageHandler({ command: "setEnabled", enabled: true });
    assert.equal(loadRoutes().byokMode, 1);
    assert.deepEqual(
      pickFields(webviewPosts.at(-1).state, ["running", "mode"]),
      { running: true, mode: true },
    );
    await webviewMessageHandler({ command: "setEnabled", enabled: false });
    assert.equal(loadRoutes().byokMode, 0);
    assert.deepEqual(
      pickFields(webviewPosts.at(-1).state, ["running", "mode"]),
      { running: true, mode: false },
    );
    assert.match(statusBarItems[0].tooltip, /Server: 127\.0\.0\.1:/);
    await registeredCommands.get("cursorByok.startServer")();
    assert.equal(extension.panelState().running, true);
    const restartedServer = fakeServers.at(-1);
    await webviewMessageHandler({ command: "installHook" });
    assert.equal(
      messages.at(-1),
      `Cursor BYOK hook installed (${DEFAULT_REDIRECTS.length} routes, hook: connect-promise-client). Restart Cursor.`,
    );
    assert.equal(webviewPosts.at(-1).state.running, true);
    await registeredCommands.get("cursorByok.restoreWorkbenchHook")();
    assert.equal(messages.at(-1), "Cursor BYOK original workbench restored. Restart Cursor.");

    await registeredCommands.get("cursorByok.openProviders")();
    await registeredCommands.get("cursorByok.openRoutes")();
    await registeredCommands.get("cursorByok.openLog")();
    assert.deepEqual(opened.slice(-3), [providersPath(), routesPath(), logPath()]);

    await registeredCommands.get("cursorByok.toggleFileLog")();
    assert.equal(configValues.get("log.file"), true);
    assert.equal(extension.panelState().fileLog, true);
    await webviewMessageHandler({ command: "providers" });
    await webviewMessageHandler({ command: "routes" });
    await webviewMessageHandler({ command: "log" });
    assert.deepEqual(opened.slice(-3), [providersPath(), routesPath(), logPath()]);
    await webviewMessageHandler({ command: "settings" });
    assert.deepEqual(opened.at(-1), { command: "workbench.action.openSettings", args: ["cursorByok"] });
    await webviewMessageHandler({ command: "toggleFileLog" });
    assert.equal(configValues.get("log.file"), false);
    assert.equal(webviewPosts.at(-1).state.fileLog, false);

    await webviewMessageHandler({
      command: "saveProviders",
      providers: {
        schemaVersion: 1,
        providers: [{
          id: "anthropic-main",
          name: "Anthropic Main",
          type: "anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: { value: "secret" },
          headers: { "x-test": "1" },
          customProviderField: "keep-provider-extra",
          models: [{
            id: "sonnet-ui",
            apiModel: "claude-sonnet-4-6",
            displayName: "Sonnet UI",
            clientDisplayName: "Sonnet Client",
            contextTokenLimit: 200000,
            maxOutputTokens: 16000,
            contextTokenLimitForMaxMode: 1000000,
            thinkingBudgetTokens: 12000,
            supportsAgent: true,
            supportsImages: true,
            supportsCmdK: true,
            supportsPlan: true,
            supportsAutoContext: true,
            supportsMaxMode: false,
            supportsNonMaxMode: false,
            defaultOn: false,
            visibleInRoutedModelView: true,
            serverModelName: "claude-server-name",
            inputboxShortModelName: "Sonnet",
            legacyId: "legacy-sonnet-ui",
            legacySlugs: [" legacy-sonnet "],
            idAliases: [" sonnet-alias ", "", 42],
            vendorName: "Anthropic",
            thinking: true,
            thinkingLevel: "high",
            tooltipMarkdown: "tooltip",
            customModelField: "keep-model-extra",
            invalidNumeric: "drop-me",
          }],
        }],
      },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(providersPath(), "utf8")), {
      schemaVersion: 1,
      providers: [{
        id: "anthropic-main",
        name: "Anthropic Main",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        auth: { value: "secret" },
        headers: { "x-test": "1" },
        customProviderField: "keep-provider-extra",
        models: [{
          id: "sonnet-ui",
          apiModel: "claude-sonnet-4-6",
          displayName: "Sonnet UI",
          clientDisplayName: "Sonnet Client",
          contextTokenLimit: 200000,
          maxOutputTokens: 16000,
          contextTokenLimitForMaxMode: 1000000,
          thinkingBudgetTokens: 12000,
          supportsAgent: true,
          supportsImages: true,
          supportsCmdK: true,
          supportsPlan: true,
          supportsAutoContext: true,
          supportsMaxMode: false,
          supportsNonMaxMode: false,
          defaultOn: false,
          visibleInRoutedModelView: true,
          serverModelName: "claude-server-name",
          inputboxShortModelName: "Sonnet",
          legacyId: "legacy-sonnet-ui",
          legacySlugs: ["legacy-sonnet"],
          idAliases: ["sonnet-alias"],
          vendorName: "Anthropic",
          thinking: true,
          thinkingLevel: "high",
          tooltipMarkdown: "tooltip",
          customModelField: "keep-model-extra",
          invalidNumeric: "drop-me",
        }],
      }],
    });
    const savedState = webviewPosts.findLast((message) => message.command === "state");
    assert.equal(savedState.state.providers, 1);
    assert.equal(savedState.state.models, 1);
    const savedModelsEvent = restartedServer.broadcasts.findLast((message) => message.event === "models");
    assert.equal(savedModelsEvent.event, "models");
    assert.match(JSON.stringify(savedModelsEvent.data), /sonnet-ui/);
    assert.match(JSON.stringify(savedModelsEvent.data), /Sonnet UI/);
    assert.match(JSON.stringify(savedModelsEvent.data), /Sonnet Client/);
    assert.match(JSON.stringify(savedModelsEvent.data), /Sonnet/);
    assert.match(JSON.stringify(savedModelsEvent.data), /legacy-sonnet/);
    assert.match(JSON.stringify(savedModelsEvent.data), /sonnet-alias/);
    assert.match(JSON.stringify(savedModelsEvent.data), /claude-sonnet-4-6/);
    assert.match(JSON.stringify(savedModelsEvent.data), /claude-server-name/);

    await webviewMessageHandler({
      command: "saveProviders",
      providers: [{
        id: "array-payload-provider",
        name: "Array Payload Provider",
        type: "openai-chat",
        models: [{ id: "array-payload-model" }],
      }],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(providersPath(), "utf8")), {
      schemaVersion: 1,
      providers: [{
        id: "array-payload-provider",
        name: "Array Payload Provider",
        type: "openai-chat",
        models: [{ id: "array-payload-model" }],
      }],
    });

    const externalUpdate = waitForWebviewPost(
      waiters,
      (message) => message.command === "state" && message.state.providersConfig?.providers?.[0]?.id === "json-provider",
    );
    writeJsonFile(providersPath(), {
      schemaVersion: 1,
      providers: [{
        id: "json-provider",
        name: "JSON Provider",
        type: "openai-responses",
        models: [{ id: "json-model" }, { id: "json-model-2" }],
      }],
    });
    const externalMessage = await externalUpdate;
    assert.equal(externalMessage.state.providers, 1);
    assert.equal(externalMessage.state.models, 2);
    assert.equal(externalMessage.state.providersConfig.providers[0].id, "json-provider");

    const originalFetch = globalThis.fetch;
    const remoteCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      remoteCalls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({
        data: [
          { id: "older", created: 10, owned_by: "team" },
          { id: "newer", created: 20, owned_by: "team" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await webviewMessageHandler({
        type: "fetchRemoteModels",
        pid: "anthropic-remote",
        provider: {
          id: "anthropic-remote",
          type: "anthropic",
          baseUrl: "https://api.anthropic.example/v1/",
          auth: { kind: "api-key", value: "anthropic-key" },
          headers: { Authorization: "Bearer stale", "X-Api-Key": "stale-anthropic-key", "x-extra": "1" },
        },
      });
      assert.equal(remoteCalls[0].url, "https://api.anthropic.example/v1/models");
      assert.equal(remoteCalls[0].headers["x-api-key"], "anthropic-key");
      assert.equal(remoteCalls[0].headers["anthropic-version"], "2023-06-01");
      assert.equal(remoteCalls[0].headers.Authorization, undefined);
      assert.equal(remoteCalls[0].headers["X-Api-Key"], undefined);
      assert.equal(remoteCalls[0].headers["x-extra"], "1");
      assert.deepEqual(webviewPosts.at(-1), {
        command: "remoteModelsResult",
        type: "remoteModelsResult",
        pid: "anthropic-remote",
        models: [
          { id: "newer", created: 20, ownedBy: "team" },
          { id: "older", created: 10, ownedBy: "team" },
        ],
      });
      await webviewMessageHandler({
        type: "fetchRemoteModels",
        pid: "manual-anthropic-remote",
        provider: {
          id: "manual-anthropic-remote",
          type: "anthropic",
          baseUrl: "https://api.manual-anthropic.example/v1/",
          headers: { "X-Api-Key": "manual-anthropic-key" },
        },
      });
      assert.equal(remoteCalls[1].url, "https://api.manual-anthropic.example/v1/models");
      assert.equal(remoteCalls[1].headers["X-Api-Key"], "manual-anthropic-key");
      assert.equal(remoteCalls[1].headers["x-api-key"], undefined);
      assert.equal(remoteCalls[1].headers["anthropic-version"], "2023-06-01");
      await webviewMessageHandler({
        type: "fetchRemoteModels",
        pid: "openai-api-key-remote",
        provider: {
          id: "openai-api-key-remote",
          type: "openai-chat",
          baseUrl: "https://api.openai-compatible.example/v1",
          auth: { kind: "api-key", value: "openai-api-key" },
          headers: { authorization: "Bearer stale", "Api-Key": "stale-api-key" },
        },
      });
      assert.equal(remoteCalls[2].headers["api-key"], "openai-api-key");
      assert.equal(remoteCalls[2].headers.authorization, undefined);
      assert.equal(remoteCalls[2].headers["Api-Key"], undefined);
      await webviewMessageHandler({
        type: "fetchRemoteModels",
        pid: "openai-bearer-remote",
        provider: {
          id: "openai-bearer-remote",
          type: "openai-chat",
          baseUrl: "https://api.openai-compatible.example/v1",
          auth: { kind: "bearer", value: "bearer-key" },
          headers: { Authorization: "Bearer stale", "API-Key": "stale-api-key" },
        },
      });
      assert.equal(remoteCalls[3].headers.Authorization, "Bearer bearer-key");
      assert.equal(remoteCalls[3].headers["API-Key"], undefined);
      globalThis.fetch = async (url, init = {}) => {
        remoteCalls.push({ url: String(url), headers: init.headers });
        return new Response("x".repeat(DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES + 1), { status: 500 });
      };
      await webviewMessageHandler({
        type: "fetchRemoteModels",
        pid: "oversized-remote",
        provider: {
          id: "oversized-remote",
          type: "openai-chat",
          baseUrl: "https://api.oversized.example/v1",
          auth: { kind: "bearer", value: "key" },
        },
      });
      assert.deepEqual(webviewPosts.at(-1), {
        command: "remoteModelsResult",
        type: "remoteModelsResult",
        pid: "oversized-remote",
        error: `Upstream response exceeds ${DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES} bytes`,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension status bar shows BYOK server startup in progress", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-starting-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 9960 }, redirect: DEFAULT_REDIRECTS });
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model" }],
    }],
  });
  const registeredCommands = new Map();
  const statusBarItems = [];
  const startGate = deferred();
  class SlowStartByokServer {
    constructor({ port, onEventClientConnected }) {
      this.port = port;
      this.onEventClientConnected = onEventClientConnected;
      this.server = { address: () => ({ port: this.port }) };
    }
    async start() {
      await startGate.promise;
      this.onEventClientConnected?.({ windowId: "1", eventClientCount: 1 });
    }
    async stop() {}
    broadcast() {}
    registerWorkspaceRoots(roots) {
      return roots;
    }
  }
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand(command, callback) {
        registeredCommands.set(command, callback);
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          text: "",
          tooltip: "",
          shown: false,
          show() {
            this.shown = true;
          },
          dispose() {},
        };
        statusBarItems.push(item);
        return item;
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            if (key === "server.autoStart") return false;
            if (key === "server.host") return "127.0.0.1";
            if (key === "server.port") return 9960;
            if (key === "log.file") return false;
            return fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: SlowStartByokServer,
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);
    const startPromise = registeredCommands.get("cursorByok.startServer")();
    await tick();

    assert.equal(statusBarItems[0].shown, true);
    assert.match(statusBarItems[0].text, /BYOK STARTING/);
    assert.match(statusBarItems[0].tooltip, /Server: starting 127\.0\.0\.1:9960/);
    assert.deepEqual(
      pickFields(extension.panelState(), ["running", "serverOwner", "serverStatus", "host", "port"]),
      {
        running: false,
        serverOwner: "none",
        serverStatus: "starting",
        host: "127.0.0.1",
        port: 9960,
      },
    );

    startGate.resolve();
    await startPromise;
    assert.match(statusBarItems[0].text, /BYOK ON/);
    assert.match(statusBarItems[0].tooltip, /Server: 127\.0\.0\.1:9960/);
    assert.equal(extension.panelState().serverStatus, "local");
  } finally {
    startGate.resolve();
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension status bar shows ON when local server is listening before workbench hook connects", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-status-no-hook-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 9960 }, redirect: DEFAULT_REDIRECTS });
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model" }],
    }],
  });
  const registeredCommands = new Map();
  const statusBarItems = [];
  class ListenOnlyByokServer {
    constructor({ port }) {
      this.port = port;
      this.server = { address: () => ({ address: "127.0.0.1", port: this.port }) };
    }
    async start() {}
    async stop() {}
    broadcast() {}
    registerWorkspaceRoots(roots) {
      return roots;
    }
  }
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand(command, callback) {
        registeredCommands.set(command, callback);
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          text: "",
          tooltip: "",
          shown: false,
          show() {
            this.shown = true;
          },
          dispose() {},
        };
        statusBarItems.push(item);
        return item;
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            if (key === "server.autoStart") return false;
            if (key === "server.host") return "127.0.0.1";
            if (key === "server.port") return 9960;
            if (key === "log.file") return false;
            return fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: ListenOnlyByokServer,
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);
    await registeredCommands.get("cursorByok.startServer")();

    assert.match(statusBarItems[0].text, /BYOK ON/);
    assert.match(statusBarItems[0].tooltip, /Server: 127\.0\.0\.1:9960/);
    assert.deepEqual(
      pickFields(extension.panelState(), ["running", "serverOwner", "serverStatus", "workbenchConnected", "host", "port"]),
      {
        running: true,
        serverOwner: "local",
        serverStatus: "local",
        workbenchConnected: false,
        host: "127.0.0.1",
        port: 9960,
      },
    );
  } finally {
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension probes the next BYOK port when the base port is already in use", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-adaptive-port-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 9960 }, redirect: DEFAULT_REDIRECTS });
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model" }],
    }],
  });
  const startCalls = [];
  const warnings = [];
  const statusBarItems = [];
  const configValues = new Map([
    ["server.host", "127.0.0.1"],
    ["server.port", 9960],
    ["server.autoStart", true],
    ["log.file", false],
  ]);
  class FakeAdaptiveByokServer {
    constructor({ host, port, onEventClientConnected }) {
      this.host = host;
      this.port = port;
      this.onEventClientConnected = onEventClientConnected;
      this.server = {
        address: () => ({ port: this.port }),
      };
    }
    async start() {
      startCalls.push(this.port);
      if (this.port === 9960) {
        const error = new Error("address in use");
        error.code = "EADDRINUSE";
        throw error;
      }
      this.onEventClientConnected?.({ windowId: "1", eventClientCount: 1 });
    }
    async stop() {}
    broadcast() {}
    registerWorkspaceRoots(roots) {
      this.registeredRoots = roots;
      return roots;
    }
  }
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          text: "",
          tooltip: "",
          show() {},
          dispose() {},
        };
        statusBarItems.push(item);
        return item;
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage(message) {
        warnings.push(message);
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return configValues.has(key) ? configValues.get(key) : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeAdaptiveByokServer,
    },
  });
  const originalFetch = globalThis.fetch;
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    extension = require("../src/extension");
    await extension.activate(context);
    await waitForPanelState(extension, (state) => state.running);
    assert.deepEqual(startCalls, [9960, 9961]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      pickFields(extension.panelState(), ["running", "serverOwner", "host", "port"]),
      {
        running: true,
        serverOwner: "local",
        host: "127.0.0.1",
        port: 9961,
      },
    );
    await waitForStatusBar(statusBarItems[0], (item) => /Server: 127\.0\.0\.1:9961/.test(item.tooltip));
    assert.match(statusBarItems[0].tooltip, /Server: 127\.0\.0\.1:9961/);
  } finally {
    globalThis.fetch = originalFetch;
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});


test("grey-box extension activation attaches to an existing BYOK server with the same workspace roots", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-port-"));
  const restoreHome = useHome(tmpRoot);
  const workspaceRoot = "/workspace/shared-window";
  const secondWorkspaceRoot = "/workspace/shared-window-second";
  const port = 43124;
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port }, redirect: DEFAULT_REDIRECTS });
  const warnings = [];
  const fetchCalls = [];
  const configValues = new Map([
    ["server.host", "127.0.0.1"],
    ["server.port", port],
    ["server.autoStart", true],
    ["log.file", false],
  ]);
  class FakeSharedByokServer {
    constructor({ host, port }) {
      this.host = host;
      this.port = port;
      this.server = {
        address: () => ({ port: this.port }),
      };
    }
    async start() {
      const error = new Error("address in use");
      error.code = "EADDRINUSE";
      throw error;
    }
    async stop() {}
    broadcast() {}
  }
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem() {
        return {
          show() {},
          dispose() {},
        };
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage(message) {
        warnings.push(message);
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return configValues.has(key) ? configValues.get(key) : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }, { uri: { fsPath: secondWorkspaceRoot } }],
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeSharedByokServer,
    },
  });
  const originalFetch = globalThis.fetch;
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    globalThis.fetch = async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url) === `http://127.0.0.1:${port}/byok/health`) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, workspaceRoots: [path.resolve(workspaceRoot), path.resolve(secondWorkspaceRoot)] }),
        };
      }
      if (String(url) === `http://127.0.0.1:${port}/byok/workspace-roots`) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ workspaceRoots: [path.resolve(workspaceRoot), path.resolve(secondWorkspaceRoot)] }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    extension = require("../src/extension");
    await extension.activate(context);
    await waitForPanelState(extension, (state) => state.serverOwner === "shared");
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      pickFields(extension.panelState(), ["running", "serverOwner", "host", "port"]),
      {
        running: true,
        serverOwner: "shared",
        host: "127.0.0.1",
        port,
      },
    );
    assert.deepEqual(
      fetchCalls.map((entry) => entry.url),
      [
        `http://127.0.0.1:${port}/byok/health`,
        `http://127.0.0.1:${port}/byok/workspace-roots`,
      ],
    );
    assert.deepEqual(JSON.parse(fetchCalls[1].init.body).workspaceRoots, [workspaceRoot, secondWorkspaceRoot]);
  } finally {
    globalThis.fetch = originalFetch;
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension activation skips shared BYOK server with different workspace roots", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-port-mismatch-"));
  const restoreHome = useHome(tmpRoot);
  const workspaceRoot = "/workspace/current-window";
  const port = 43125;
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port }, redirect: DEFAULT_REDIRECTS });
  const fetchCalls = [];
  const configValues = new Map([
    ["server.host", "127.0.0.1"],
    ["server.port", port],
    ["server.autoStart", true],
    ["log.file", false],
  ]);
  const startedServers = [];
  class FakePortMismatchByokServer {
    constructor({ host, port }) {
      this.host = host;
      this.port = port;
      this.server = {
        address: () => ({ address: this.host, port: this.port }),
      };
      startedServers.push(this);
    }
    async start() {
      if (this.port === port) {
        const error = new Error("address in use");
        error.code = "EADDRINUSE";
        throw error;
      }
    }
    async stop() {}
    broadcast() {}
    registerWorkspaceRoots(roots) {
      this.registeredRoots = roots;
      return roots;
    }
  }
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { show() {}, dispose() {} };
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return configValues.has(key) ? configValues.get(key) : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakePortMismatchByokServer,
    },
  });
  const originalFetch = globalThis.fetch;
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === `http://127.0.0.1:${port}/byok/health`) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, workspaceRoots: ["/workspace/other-window"] }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    extension = require("../src/extension");
    await extension.activate(context);
    await waitForPanelState(extension, (state) => state.serverOwner === "local");
    assert.deepEqual(fetchCalls, [`http://127.0.0.1:${port}/byok/health`]);
    assert.deepEqual(
      pickFields(extension.panelState(), ["running", "serverOwner", "host", "port"]),
      {
        running: true,
        serverOwner: "local",
        host: "127.0.0.1",
        port: port + 1,
      },
    );
    assert.deepEqual(startedServers.at(-1).registeredRoots, [workspaceRoot]);
  } finally {
    globalThis.fetch = originalFetch;
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension wires remote workspace file reads through the workspace fs scheme", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-remote-fs-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 0 }, redirect: DEFAULT_REDIRECTS });
  let capturedReadFile = null;
  const fsCalls = [];
  const remoteUri = {
    scheme: "vscode-remote",
    authority: "ssh-remote+devbox",
    path: "/workspace/project",
    with(update) {
      return {
        ...this,
        ...update,
        with: this.with,
      };
    },
  };
  class FakeRemoteByokServer {
    constructor({ readFile }) {
      capturedReadFile = readFile;
      this.server = {
        address: () => ({ port: 43125 }),
      };
    }
    async start() {}
    async stop() {}
    broadcast() {}
  }
  const configValues = new Map([
    ["server.host", "127.0.0.1"],
    ["server.port", 0],
    ["server.autoStart", true],
    ["log.file", false],
  ]);
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    Uri: {
      file() {
        throw new Error("remote reader should not fall back to vscode.Uri.file");
      },
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { show() {}, dispose() {} };
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return configValues.has(key) ? configValues.get(key) : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      workspaceFolders: [{ uri: remoteUri }],
      fs: {
        async readFile(uri) {
          fsCalls.push({ kind: "readFile", uri });
          return Buffer.from("remote-content", "utf8");
        },
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeRemoteByokServer,
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);
    assert.equal(typeof capturedReadFile, "function");
    const result = await capturedReadFile("/srv/project/notes.txt");
    assert.equal(Buffer.from(result.buffer).toString("utf8"), "remote-content");
    assert.equal(result.fileSize, Buffer.byteLength("remote-content"));
    assert.deepEqual(fsCalls, [
      {
        kind: "readFile",
        uri: {
          scheme: "vscode-remote",
          authority: "ssh-remote+devbox",
          path: "/srv/project/notes.txt",
          with: remoteUri.with,
        },
      },
    ]);
  } finally {
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension direct reader prefers open editor text over workspace fs", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-open-doc-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 0 }, redirect: DEFAULT_REDIRECTS });
  let capturedReadFile = null;
  const diskPath = path.join(tmpRoot, "workspace", "notes.txt");
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, "disk\n");
  const targetUri = {
    scheme: "file",
    fsPath: diskPath,
    toString() {
      return `file://${diskPath}`;
    },
  };
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: {
      file(filePath) {
        return {
          scheme: "file",
          fsPath: filePath,
          toString() {
            return `file://${filePath}`;
          },
        };
      },
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { show() {}, dispose() {} };
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return key === "server.autoStart" ? true : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      workspaceFolders: [{ uri: { fsPath: path.dirname(diskPath) } }],
      textDocuments: [{
        uri: targetUri,
        lineCount: 2,
        getText() {
          return "dirty\nbuffer";
        },
      }],
      fs: {
        async readFile() {
          throw new Error("open editor text should avoid workspace fs");
        },
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  class FakeOpenDocByokServer {
    constructor({ readFile }) {
      capturedReadFile = readFile;
      this.server = {
        address: () => ({ address: "127.0.0.1", port: 0 }),
      };
    }
    async start() {}
    async stop() {}
  }
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeOpenDocByokServer,
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);
    assert.equal(typeof capturedReadFile, "function");
    const result = await capturedReadFile(diskPath);
    assert.equal(result.text, "dirty\nbuffer");
    assert.equal(result.totalLines, 2);
    assert.equal(result.fileSize, Buffer.byteLength("dirty\nbuffer"));
  } finally {
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

test("grey-box extension direct reader stats closed workspace files before reading", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-extension-stat-reader-"));
  const restoreHome = useHome(tmpRoot);
  writeRoutes({ byokMode: 1, server: { host: "127.0.0.1", port: 0 }, redirect: DEFAULT_REDIRECTS });
  let capturedReadFile = null;
  const diskPath = path.join(tmpRoot, "workspace", "large.txt");
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, "disk\n");
  const statCalls = [];
  const fakeVscode = {
    ConfigurationTarget: { Global: "Global" },
    FileType: { File: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: {
      file(filePath) {
        return {
          scheme: "file",
          fsPath: filePath,
          toString() {
            return `file://${filePath}`;
          },
        };
      },
    },
    commands: {
      registerCommand() {
        return { dispose() {} };
      },
      executeCommand() {
        return Promise.resolve();
      },
    },
    window: {
      createOutputChannel() {
        return { appendLine() {}, dispose() {} };
      },
      createStatusBarItem() {
        return { show() {}, dispose() {} };
      },
      registerWebviewViewProvider() {
        return { dispose() {} };
      },
      showInformationMessage() {
        return Promise.resolve();
      },
      showWarningMessage() {
        return Promise.resolve();
      },
      showTextDocument() {
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, fallback) {
            return key === "server.autoStart" ? true : fallback;
          },
          update() {
            return Promise.resolve();
          },
        };
      },
      workspaceFolders: [{ uri: { fsPath: path.dirname(diskPath) } }],
      textDocuments: [],
      fs: {
        async stat(uri) {
          statCalls.push(uri.fsPath);
          return { type: 1, size: 123456 };
        },
        async readFile() {
          throw new Error("stat fast path should avoid workspace fs readFile");
        },
      },
      openTextDocument(file) {
        return Promise.resolve({ fileName: file });
      },
    },
  };
  class FakeStatByokServer {
    constructor({ readFile }) {
      capturedReadFile = readFile;
      this.server = {
        address: () => ({ address: "127.0.0.1", port: 0 }),
      };
    }
    async start() {}
    async stop() {}
  }
  const extensionPath = require.resolve("../src/extension");
  const serverModulePath = require.resolve("../src/server/http");
  const restoreModule = interceptModules({
    vscode: fakeVscode,
    [serverModulePath]: {
      ...require("../src/server/http"),
      ByokServer: FakeStatByokServer,
    },
  });
  delete require.cache[extensionPath];
  let extension;
  const context = { extensionUri: { scheme: "file", path: root }, subscriptions: [] };
  try {
    extension = require("../src/extension");
    await extension.activate(context);
    assert.equal(typeof capturedReadFile?.stat, "function");
    const stat = await capturedReadFile.stat(diskPath);
    assert.deepEqual(stat, { fileSize: 123456, isFile: true });
    assert.deepEqual(statCalls, [diskPath]);
  } finally {
    if (extension) await extension.deactivate();
    for (const subscription of context.subscriptions) {
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
    }
    delete require.cache[extensionPath];
    restoreModule();
    restoreHome();
  }
});

async function waitForPanelState(extension, predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = extension.panelState();
    if (predicate(state)) return state;
    await tick();
  }
  throw new Error("timed out waiting for extension panel state");
}

async function waitForStatusBar(item, predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate(item)) return;
    await tick();
  }
  throw new Error("timed out waiting for status bar update");
}
