"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SEARCH_COUNT, DISPLAY_NAME } = require("./constants");
const {
  ensureConfigFiles,
  catalogSourcePath,
  loadProviders,
  loadRoutes,
  logPath,
  normalizeProvidersConfig,
  providersPath,
  readJsonFile,
  routesPath,
  writeJsonFile,
  writeRoutes,
} = require("./config");
const { LocalLog } = require("./log");
const { ByokServer, readResponseText, routePatterns } = require("./server/http");
const { ProviderAdapter } = require("./server/provider-adapter");
const { byokModelIds, mergeAvailableModels } = require("./runtime/models");
const { installWorkbenchHook, restoreWorkbenchHook } = require("../scripts/install-workbench-hook");

let server = null;
let sharedServer = null;
let log = null;
let statusBarItem = null;
let serverStarting = false;
let workbenchConnected = false;
let panelProvider = null;
const STARTING_STATUS_MIN_TICKS = 2;

async function activate(context) {
  ensureConfigFiles();
  const channel = vscode.window.createOutputChannel(DISPLAY_NAME);
  log = new LocalLog(channel, {
    fileEnabledProvider: () => vscode.workspace.getConfiguration("cursorByok").get("log.file", true),
  });
  log.info("extension activated", { statusBarReadyState: "starting-until-server-listen-completes" });
  panelProvider = new PanelProvider(context.extensionUri);
  context.subscriptions.push(panelProvider);
  context.subscriptions.push(channel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorByok.panel", panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(registerCommand("cursorByok.toggleMode", toggleMode));
  context.subscriptions.push(registerCommand("cursorByok.startServer", startServer));
  context.subscriptions.push(registerCommand("cursorByok.stopServer", stopServer));
  context.subscriptions.push(registerCommand("cursorByok.installWorkbenchHook", installHookCommand));
  context.subscriptions.push(registerCommand("cursorByok.restoreWorkbenchHook", restoreHookCommand));
  context.subscriptions.push(registerCommand("cursorByok.openProviders", () => openFile(providersPath())));
  context.subscriptions.push(registerCommand("cursorByok.openRoutes", () => openFile(routesPath())));
  context.subscriptions.push(registerCommand("cursorByok.openLog", () => openFile(logPath())));
  context.subscriptions.push(registerCommand("cursorByok.openSettings", openSettings));
  context.subscriptions.push(registerCommand("cursorByok.toggleFileLog", toggleFileLog));
  context.subscriptions.push(registerCommand("cursorByok.openPanel", openPanel));
  context.subscriptions.push(watchProvidersFile(panelProvider));
  createStatusBarItem(context);
  updateStatusBarItem();
  if (vscode.workspace.getConfiguration("cursorByok").get("server.autoStart", true)) {
    startServer().catch((error) => {
      log?.error("server auto-start failed", { error: error?.message });
    });
  }
  updateStatusBarItem();
  if (typeof vscode.workspace.onDidChangeWorkspaceFolders === "function") {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registerCurrentWorkspaceRoots().catch((error) => {
        log?.warn("workspace root registration failed", { error: error?.message });
      });
    }));
  }
}

async function deactivate() {
  await stopServer();
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
  panelProvider = null;
}

function registerCommand(command, callback) {
  return vscode.commands.registerCommand(command, callback);
}

async function startServer() {
  if (server) {
    updateStatusBarItem();
    return;
  }
  if (serverStarting) {
    updateStatusBarItem();
    return;
  }
  serverStarting = true;
  workbenchConnected = false;
  updateStatusBarItem();
  sharedServer = null;
  const config = vscode.workspace.getConfiguration("cursorByok");
  const routes = loadRoutes();
  const { host, port } = resolveServerAddress(config, routes);
  const adapter = new ProviderAdapter({
    providersConfigProvider: loadProviders,
    log,
  });
  const attemptedPorts = [];
  try {
    const result = await startAdaptiveServer({
      host,
      basePort: port,
      log,
      providerAdapter: adapter,
      workspaceRoots: workspaceRoots(),
      readFile: createWorkspaceFileReader(),
      onEventClientConnected() {
        workbenchConnected = true;
        updateStatusBarItem();
        panelProvider?.postStateToAll?.();
      },
      onEventClientDisconnected() {
        workbenchConnected = false;
        updateStatusBarItem();
        panelProvider?.postStateToAll?.();
      },
      onAttempt(portCandidate) {
        attemptedPorts.push(portCandidate);
      },
    });
    if (result.server) {
      server = result.server;
      await registerCurrentWorkspaceRoots();
      panelProvider?.postStateToAll?.();
      return;
    }
    if (result.shared) {
      sharedServer = result.shared;
      workbenchConnected = true;
      log.info("using shared BYOK server", {
        host,
        port: result.shared.port,
        workspaceRoots: result.shared.workspaceRoots?.length || 0,
      });
      updateStatusBarItem();
      return;
    }
  } catch (error) {
    log.error("server start failed", {
      host,
      port,
      attemptedPorts,
      error: error.message,
    });
    vscode.window.showWarningMessage(`Cursor BYOK server failed to start near ${host}:${port}: ${error.message}`);
  } finally {
    await keepStartingStatusVisible();
    serverStarting = false;
    updateStatusBarItem();
  }
}

async function keepStartingStatusVisible() {
  for (let index = 0; index < STARTING_STATUS_MIN_TICKS; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function stopServer() {
  workbenchConnected = false;
  if (!server) {
    sharedServer = null;
    updateStatusBarItem();
    return;
  }
  const current = server;
  server = null;
  await current.stop();
  updateStatusBarItem();
}

async function toggleMode() {
  if (sharedServer && !server) {
    const result = await postSharedServer(sharedServer, "/byok/toggle", {});
    updateStatusBarItem();
    vscode.window.showInformationMessage(`Cursor BYOK ${result.byokMode ? "ON" : "OFF"}`);
    return;
  }
  const routes = loadRoutes();
  routes.byokMode = routes.byokMode === 0 ? 1 : 0;
  writeRoutes(routes);
  if (server) server.broadcast("routes", routePatterns(routes));
  updateStatusBarItem();
  vscode.window.showInformationMessage(`Cursor BYOK ${routes.byokMode === 0 ? "OFF" : "ON"}`);
}

async function setByokEnabled(enabled) {
  if (enabled) await startServer();
  if (sharedServer && !server) {
    const result = await postSharedServer(sharedServer, "/byok/mode", { enabled });
    updateStatusBarItem();
    vscode.window.showInformationMessage(`Cursor BYOK ${result.byokMode ? "ON" : "OFF"}`);
    return;
  }
  const routes = loadRoutes();
  const nextMode = enabled ? 1 : 0;
  if (routes.byokMode !== nextMode) {
    routes.byokMode = nextMode;
    writeRoutes(routes);
    if (server) server.broadcast("routes", routePatterns(routes));
  }
  updateStatusBarItem();
  vscode.window.showInformationMessage(`Cursor BYOK ${routes.byokMode === 0 ? "OFF" : "ON"}`);
}

async function connectSharedServer(host, port, startError) {
  if (!isAddressInUse(startError)) return null;
  const baseUrl = `http://${host}:${port}`;
  try {
    const health = await readServerJson(`${baseUrl}/byok/health`);
    if (!health?.ok) return null;
    if (!workspaceRootsEqual(workspaceRoots(), health.workspaceRoots)) return null;
    const workspaceResponse = await postSharedServer({ baseUrl }, "/byok/workspace-roots", {
      workspaceRoots: workspaceRoots(),
    });
    return {
      baseUrl,
      host,
      port,
      workspaceRoots: Array.isArray(workspaceResponse?.workspaceRoots)
        ? workspaceResponse.workspaceRoots
        : Array.isArray(health.workspaceRoots)
          ? health.workspaceRoots
          : [],
    };
  } catch (error) {
    log.warn("shared BYOK server probe failed", { host, port, error: error.message });
    return null;
  }
}

async function startAdaptiveServer({ host, basePort, log, providerAdapter, workspaceRoots, readFile, onEventClientConnected, onEventClientDisconnected, onAttempt }) {
  const candidates = candidatePorts(basePort);
  let lastError = null;
  for (const port of candidates) {
    onAttempt?.(port);
    const candidate = new ByokServer({
      host,
      port,
      log,
      providerAdapter,
      workspaceRoots,
      readFile,
      onEventClientConnected,
      onEventClientDisconnected,
    });
    try {
      await candidate.start();
      return { server: candidate, shared: null };
    } catch (error) {
      lastError = error;
      const shared = await connectSharedServer(host, port, error);
      if (shared) return { server: null, shared };
      if (!shouldRetryPort(error, basePort)) break;
    }
  }
  throw lastError || new Error(`No available BYOK server port near ${host}:${basePort}`);
}

function candidatePorts(basePort) {
  if (basePort === 0) return [0];
  const port = normalizeConfiguredPort(basePort);
  const out = [];
  for (let offset = 0; offset < DEFAULT_PORT_SEARCH_COUNT; offset++) out.push(port + offset);
  return out;
}

function normalizeConfiguredPort(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT;
}

function shouldRetryPort(error, basePort) {
  return basePort !== 0 && isAddressInUse(error);
}

function isAddressInUse(error) {
  return error?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(error?.message || "");
}

async function readServerJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await readResponseText(response));
}

async function postSharedServer(shared, pathName, body) {
  const response = await fetch(`${shared.baseUrl}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await readResponseText(response));
}

async function registerCurrentWorkspaceRoots() {
  const roots = workspaceRoots();
  if (server) {
    return { workspaceRoots: server.registerWorkspaceRoots(roots) };
  }
  if (sharedServer) {
    return postSharedServer(sharedServer, "/byok/workspace-roots", { workspaceRoots: roots });
  }
  return { workspaceRoots: roots };
}

async function installHookCommand() {
  let result;
  try {
    // The in-editor command installs with allowPartial so a Cursor build that
    // drifted on a critical seam still gets a working transport hook; the
    // degradation is surfaced as a warning instead of a hard failure.
    result = installWorkbenchHook({ allowPartial: true });
  } catch (error) {
    log?.warn("workbench hook install failed", { error: error.message });
    vscode.window.showWarningMessage(error.message);
    return;
  }
  log?.info("workbench hook installed", {
    routes: result.routes,
    transportHookPoints: result.transportHookPoints,
    patchedHookPoints: result.patchedHookPoints,
    missingCriticalPatches: result.missingCriticalPatches,
    backupsCreated: result.backupsCreated,
    backupWarnings: result.backupWarnings,
  });
  if (result.missingCriticalPatches?.length) {
    vscode.window.showWarningMessage(
      `Cursor BYOK: critical workbench patches did not apply: ${result.missingCriticalPatches.join(", ")}. BYOK routing may be degraded on this Cursor build.`,
    );
  }
  const hookPoints = Array.isArray(result.transportHookPoints) && result.transportHookPoints.length
    ? `, hook: ${result.transportHookPoints.join(",")}`
    : "";
  vscode.window.showInformationMessage(`Cursor BYOK hook installed (${result.routes} routes${hookPoints}). Restart Cursor.`);
}

async function restoreHookCommand() {
  try {
    const result = restoreWorkbenchHook();
    log?.info("workbench hook restored", {
      restoredFiles: result.restoredFiles,
      missingBackups: result.missingBackups,
      unrestoredPatchedTargets: result.unrestoredPatchedTargets,
    });
    const missingSuffix = result.missingBackups.length
      ? ` Missing backups: ${result.missingBackups.join(", ")}.`
      : "";
    const unrestoredSuffix = result.unrestoredPatchedTargets?.length
      ? ` Still patched (no backup): ${result.unrestoredPatchedTargets.map((file) => path.basename(file)).join(", ")}.`
      : "";
    vscode.window.showInformationMessage(`Cursor BYOK original workbench restored. Restart Cursor.${missingSuffix}${unrestoredSuffix}`);
  } catch (error) {
    log?.warn("workbench hook restore failed", { error: error.message });
    vscode.window.showWarningMessage(error.message);
  }
}

async function openFile(file) {
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);
}

async function openSettings() {
  await vscode.commands.executeCommand("workbench.action.openSettings", "cursorByok");
}

async function openPanel() {
  await vscode.commands.executeCommand("workbench.view.extension.cursor-byok");
}

async function toggleFileLog() {
  const config = vscode.workspace.getConfiguration("cursorByok");
  const current = config.get("log.file", true);
  await config.update("log.file", !current, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Cursor BYOK file logging ${current ? "OFF" : "ON"}`);
}

function createStatusBarItem(context) {
  if (statusBarItem || !vscode.window.createStatusBarItem) return;
  const alignment = vscode.StatusBarAlignment?.Right ?? 2;
  statusBarItem = vscode.window.createStatusBarItem(alignment, 100);
  statusBarItem.command = "cursorByok.openPanel";
  context.subscriptions.push(statusBarItem);
}

function updateStatusBarItem() {
  if (!statusBarItem) return;
  const state = panelState();
  const mode = statusBarModeText(state);
  statusBarItem.text = `$(plug) BYOK ${mode}`;
  statusBarItem.tooltip = [
    DISPLAY_NAME,
    "Click to open Control Panel",
    `Mode: ${state.mode ? "BYOK" : "Official"}`,
    `Server: ${serverStatusText(state)}`,
    `Workbench hook: ${state.workbenchConnected ? "connected" : "not connected"}`,
    `Models: ${state.models}`,
    `Routes: ${state.routes}`,
  ].join("\n");
  statusBarItem.show();
}

function statusBarModeText(state) {
  if (!state.mode) return "OFF";
  if (state.serverStatus === "starting") return "STARTING";
  if (!state.running) return "NO SERVER";
  if (state.serverStatus === "shared") return "SHARED";
  return "ON";
}

function serverStatusText(state) {
  if (state.serverStatus === "starting") return `starting ${state.host}:${state.port}`;
  if (state.running) return `${state.host}:${state.port}`;
  return "stopped";
}

class PanelProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.views = new Set();
  }

  resolveWebviewView(view) {
    this.views.add(view);
    if (typeof view.onDidDispose === "function") {
      view.onDidDispose(() => this.views.delete(view));
    }
    view.webview.options = { enableScripts: true };
    view.webview.html = renderPanelHtml();
    view.webview.onDidReceiveMessage(async (message) => {
      const command = message.command || message.type;
      switch (command) {
        case "ready":
          this.postState(view);
          break;
        case "toggle":
          await toggleMode();
          this.postState(view);
          break;
        case "setEnabled":
          await setByokEnabled(!!message.enabled);
          this.postState(view);
          break;
        case "start":
          await startServer();
          this.postState(view);
          break;
        case "stop":
          await stopServer();
          this.postState(view);
          break;
        case "toggleServer":
          if (server) {
            await stopServer();
          } else {
            await startServer();
          }
          this.postState(view);
          break;
        case "installHook":
          await installHookCommand();
          this.postState(view);
          break;
        case "editProvidersJson":
        case "providers":
          await openFile(providersPath());
          break;
        case "routes":
          await openFile(routesPath());
          break;
        case "log":
          await openFile(logPath());
          break;
        case "settings":
          await openSettings();
          break;
        case "toggleFileLog":
          await toggleFileLog();
          this.postState(view);
          break;
        case "saveProviders":
          saveProvidersConfig(message.providers);
          notifyProvidersChanged(this);
          break;
        case "refresh":
        case "refreshProviders":
          this.postState(view);
          break;
        case "fetchRemoteModels":
          try {
            const pid = message.pid || message.provider?.id || "";
            const models = await fetchRemoteModels(message.provider);
            view.webview.postMessage({
              command: "remoteModelsResult",
              type: "remoteModelsResult",
              pid,
              models,
            });
          } catch (error) {
            const pid = message.pid || message.provider?.id || "";
            view.webview.postMessage({
              command: "remoteModelsResult",
              type: "remoteModelsResult",
              pid,
              error: error.message,
            });
          }
          break;
        case "searchCatalog":
          try {
            const results = searchCatalog(message.query, message.limit);
            view.webview.postMessage({
              command: "searchCatalogResult",
              query: message.query,
              models: results,
            });
          } catch (e) {
            log?.warn("searchCatalog failed", { query: message.query, error: e?.message });
          }
          break;
      }
    });
    setTimeout(() => this.postState(view), 0);
  }

  postState(view) {
    view.webview.postMessage({ command: "state", state: panelState() });
  }

  postStateToAll() {
    for (const view of this.views) {
      this.postState(view);
    }
  }

  dispose() {
    this.views.clear();
  }
}

function watchProvidersFile(provider) {
  const file = providersPath();
  let timer = null;
  const listener = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      notifyProvidersChanged(provider);
    }, 50);
  };
  let watcher = null;
  try {
    watcher = fs.watch(file, listener);
  } catch {
    return { dispose() {} };
  }
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

function notifyProvidersChanged(provider) {
  updateStatusBarItem();
  provider.postStateToAll();
  if (server) {
    const providers = loadProviders();
    server.broadcast("models", {
      modelIds: [...byokModelIds(providers)],
      models: mergeAvailableModels([], providers),
    });
  }
}

function saveProvidersConfig(providersConfig) {
  const existing = loadProviders();
  const normalized = normalizeProvidersConfig(providersConfig);
  const incomingWebSearch = providersConfig?.webSearch;
  const normalizedWebSearch = normalized.webSearch;
  if (normalizedWebSearch && existing.webSearch && incomingWebSearch) {
    for (const field of ["apiKey", "baseUrl", "type", "numResults"]) {
      if (normalizedWebSearch[field] === undefined && existing.webSearch[field] !== undefined) {
        normalizedWebSearch[field] = existing.webSearch[field];
      }
    }
  }
  writeJsonFile(providersPath(), normalized);
}

function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder?.uri?.fsPath)
    .filter((fsPath) => typeof fsPath === "string" && fsPath);
}

function workspaceRootsEqual(left, right) {
  const normalizedLeft = normalizeWorkspaceRootsForCompare(left);
  const normalizedRight = normalizeWorkspaceRootsForCompare(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  for (let index = 0; index < normalizedLeft.length; index++) {
    if (normalizedLeft[index] !== normalizedRight[index]) return false;
  }
  return true;
}

function normalizeWorkspaceRootsForCompare(roots) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function createWorkspaceFileReader() {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const folderForPath = (resolvedPath) => {
    const target = path.resolve(resolvedPath);
    for (const folder of workspaceFolders) {
      const fsPath = folder?.uri?.fsPath;
      if (typeof fsPath !== "string" || !fsPath) continue;
      const relative = path.relative(path.resolve(fsPath), target);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return folder;
    }
    return workspaceFolders[0];
  };
  const uriForPath = (resolvedPath) => {
    const folder = folderForPath(resolvedPath);
    const baseUri = folder?.uri;
    if (baseUri?.scheme && baseUri.scheme !== "file") return baseUri.with({ path: resolvedPath });
    return vscode.Uri.file(resolvedPath);
  };
  const reader = async (resolvedPath) => {
    const targetUri = uriForPath(resolvedPath);
    const openDocument = vscode.workspace.textDocuments?.find((document) => document?.uri?.toString?.() === targetUri.toString?.());
    if (openDocument) {
      const text = openDocument.getText();
      return {
        text,
        totalLines: openDocument.lineCount,
        fileSize: Buffer.byteLength(text, "utf8"),
      };
    }
    const buffer = await vscode.workspace.fs.readFile(targetUri);
    return {
      buffer,
      fileSize: typeof buffer.byteLength === "number" ? buffer.byteLength : Buffer.from(buffer).length,
    };
  };
  reader.stat = async (resolvedPath) => {
    const targetUri = uriForPath(resolvedPath);
    const openDocument = vscode.workspace.textDocuments?.find((document) => document?.uri?.toString?.() === targetUri.toString?.());
    if (openDocument) return null;
    const stat = await vscode.workspace.fs.stat(targetUri);
    const fileType = vscode.FileType?.File ?? 1;
    return {
      fileSize: stat.size,
      isFile: typeof stat.type !== "number" || (stat.type & fileType) === fileType,
    };
  };
  return reader;
}

// Configured listen address: VS Code settings win, then routes.json, then defaults.
function resolveServerAddress(config, routes) {
  return {
    host: config.get("server.host", routes.server?.host || DEFAULT_HOST),
    port: normalizeConfiguredPort(config.get("server.port", routes.server?.port || DEFAULT_PORT)),
  };
}

function panelState() {
  const routes = loadRoutes();
  const providers = loadProviders();
  const config = vscode.workspace.getConfiguration("cursorByok");
  const serverAddress = server?.server?.address?.();
  const runningHost = serverAddress && typeof serverAddress === "object" ? serverAddress.address : null;
  const runningPort = serverAddress && typeof serverAddress === "object" ? serverAddress.port : null;
  const configured = resolveServerAddress(config, routes);
  const running = !!server || !!sharedServer;
  const providerCount = Array.isArray(providers.providers) ? providers.providers.length : 0;
  const modelCount = Array.isArray(providers.providers)
    ? providers.providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0)
    : 0;
  return {
    running,
    serverOwner: server ? "local" : sharedServer ? "shared" : "none",
    serverStatus: serverStarting ? "starting" : server ? "local" : sharedServer ? "shared" : "stopped",
    workbenchConnected,
    mode: routes.byokMode !== 0,
    host: runningHost || sharedServer?.host || configured.host,
    port: runningPort ?? sharedServer?.port ?? configured.port,
    routes: Array.isArray(routes.redirect) ? routes.redirect.length : 0,
    providers: providerCount,
    models: modelCount,
    fileLog: config.get("log.file", true),
    providersConfig: providers,
    providersData: providers.providers || [],
    webToolsEnv: {
      exaApiKey: typeof process.env.EXA_API_KEY === "string" && !!process.env.EXA_API_KEY.trim(),
      jinaApiKey: typeof process.env.JINA_API_KEY === "string" && !!process.env.JINA_API_KEY.trim(),
      firecrawlApiKey: typeof process.env.FIRECRAWL_API_KEY === "string" && !!process.env.FIRECRAWL_API_KEY.trim(),
    },
  };
}

function renderPanelHtml() {
  const htmlPath = path.join(__dirname, "webview.html");
  return fs.readFileSync(htmlPath, "utf8");
}

async function fetchRemoteModels(provider) {
  if (!provider) throw new Error("No provider provided");
  let baseUrl = provider.baseUrl || "";
  baseUrl = baseUrl.trim().replace(/\/+$/, "");

  let url = baseUrl;
  if (!url.endsWith("/models")) {
    url += "/models";
  }

  const headers = {};
  if (provider.headers && typeof provider.headers === "object") {
    Object.assign(headers, provider.headers);
  }

  const type = provider.type || "openai-chat";
  const authValue = provider.auth?.value || "";
  const authKind = provider.auth?.kind || "bearer";

  if (type === "anthropic") {
    if (authValue) {
      deleteHeader(headers, "authorization");
      deleteHeader(headers, "x-api-key");
      headers["x-api-key"] = authValue;
    }
    headers["anthropic-version"] = "2023-06-01";
  } else {
    if (authValue) {
      if (authKind === "api-key") {
        deleteHeader(headers, "authorization");
        deleteHeader(headers, "api-key");
        headers["api-key"] = authValue;
      } else {
        deleteHeader(headers, "authorization");
        deleteHeader(headers, "api-key");
        headers["Authorization"] = `Bearer ${authValue}`;
      }
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${await readResponseText(response)}`);
  }

  const resJson = JSON.parse(await readResponseText(response));
  const dataList = Array.isArray(resJson.data) ? resJson.data : (Array.isArray(resJson) ? resJson : []);

  const models = dataList.map(m => {
    if (typeof m === "string") return { id: m };
    return {
      id: m.id,
      created: m.created,
      ownedBy: m.owned_by || m.ownedBy,
    };
  });

  models.sort((a, b) => {
    const aVal = typeof a.created === "number" ? a.created : 0;
    const bVal = typeof b.created === "number" ? b.created : 0;
    return bVal - aVal;
  });

  return models;
}

function deleteHeader(headers, name) {
  if (!headers || typeof headers !== "object") return;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) delete headers[key];
  }
}

function searchCatalog(query, limit = 10) {
  try {
    const catalog = readJsonFile(catalogSourcePath());
    if (catalog && Array.isArray(catalog.models)) {
      const q = (query || "").toLowerCase();
      return catalog.models.filter(m =>
        (m.id || "").toLowerCase().includes(q) ||
        (m.displayName || "").toLowerCase().includes(q)
      ).slice(0, limit);
    }
  } catch (error) {
    log?.warn("searchCatalog read failed", { error: error?.message });
  }
  return [];
}

module.exports = {
  activate,
  deactivate,
  panelState,
};
