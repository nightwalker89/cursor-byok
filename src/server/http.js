"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const crypto = require("node:crypto");
const { URL, fileURLToPath } = require("node:url");
const { UPSTREAM_ORIGIN } = require("../constants");
const { loadProviders, loadRoutes, writeRoutes } = require("../config");
const { byokModelIds, findProviderModel, mergeAvailableModels, pickModelId } = require("../runtime/models");
const { appendInteractionBridgeProviderTools, defaultCursorBuiltinTools } = require("../runtime/tools");
const { decodeBidiClientMessage } = require("../runtime/cursor-protocol");
const {
  interactionTimeoutResponse,
  isInteractionBridgeTool,
  isMcpAuthToolName,
  summarizeInteractionResponse,
} = require("../runtime/interaction-bridge");
const { isClientInteractionTool } = require("../runtime/client-tool-bridge");
const {
  isWebSearchExaConfigured,
  normalizeWebSearchConfig,
  searchTermFromToolArguments,
  webSearchCompletionFromExa,
} = require("../runtime/web-search-exa");
const {
  describeWebFetchMisconfiguration,
  mapWebFetchProviderError,
  normalizeWebFetchConfig,
  urlFromToolArguments,
  webFetchCompletion,
} = require("../runtime/web-fetch");
const {
  buildPlanExecutionProviderMessage,
  isCloudPlanExecutionRequest,
} = require("../runtime/prompt");

const { BidiRawQueue, ByokSessionStore, findRequestId, mergeRunRequest } = require("../runtime/state");

const DEFAULT_PROVIDER_TOOL_RESULT_TIMEOUT_MS = 30000;
const LONG_PROVIDER_TOOL_RESULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES = 64;
const DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS = 32;
const DEFAULT_DIRECT_READ_INLINE_MAX_BYTES = 100000;
const DEFAULT_DIRECT_READ_PROVIDER_VISIBLE_MAX_CHARS = 100000;
const DEFAULT_DIRECT_READ_TRUNCATE_CHARS = 8 * 1024 * 1024;
const DEFAULT_RICHER_RUN_REQUEST_WAIT_MS = 750;
const CURSOR_BYOK_FULL_STRIPE_PROFILE = Object.freeze({
  membershipType: "ultra",
  paymentId: "byok_local",
  subscriptionStatus: "active",
  hasValidPaymentMethod: true,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: 4102444800,
});
const CURSOR_BYOK_VALID_PAYMENT_METHOD = Object.freeze({ hasValidPaymentMethod: true });
const CURSOR_BYOK_AUTH_POLL = Object.freeze({ accessToken: "byok-token", authId: "byok-user" });
const CURSOR_BYOK_LOGOUT = Object.freeze({ ok: true });

class ByokServer {
  constructor({ host, port, log, providerAdapter, workspaceRoots, readFile = null, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES, onEventClientConnected = null, onEventClientDisconnected = null }) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.providerAdapter = providerAdapter;
    this.workspaceRoots = normalizeWorkspaceRoots(workspaceRoots);
    this.workspaceRootsByWindowId = new Map();
    this.ownerWindowId = "";
    this.readFile = typeof readFile === "function" ? readFile : null;
    this.maxRequestBodyBytes = normalizePositiveInteger(maxRequestBodyBytes, DEFAULT_MAX_REQUEST_BODY_BYTES);
    this.onEventClientConnected = typeof onEventClientConnected === "function" ? onEventClientConnected : null;
    this.onEventClientDisconnected = typeof onEventClientDisconnected === "function" ? onEventClientDisconnected : null;
    this.directReadResultsInFlight = new Map();
    this.activeRunsByRequestId = new Map();
    this.activeRunsByConversationId = new Map();
    this.server = null;
    this.events = new Set();
    this.eventsByWindowId = new Map();
    this.bidiRawQueue = new BidiRawQueue({ log: this.log });
    this.sessions = new ByokSessionStore({ log: this.log });
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        const level = error.statusCode && error.statusCode < 500 ? "warn" : "error";
        this.log[level]?.("request failed", {
          url: request.url,
          method: request.method,
          error: error.message,
          statusCode: error.statusCode || 500,
          receivedBytes: error.receivedBytes,
          maxBytes: error.maxBytes,
        });
        if (!response.headersSent) {
          response.writeHead(error.statusCode || 500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: error.message }));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.log.info("server started", { host: this.host, port: this.port });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const eventResponse of this.events) eventResponse.end();
    this.events.clear();
    this.eventsByWindowId.clear();
    await new Promise((resolve) => server.close(resolve));
    this.log.info("server stopped");
  }

  async handle(request, response) {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, `http://${this.host}:${this.port}`);
    if (url.pathname === "/auth/full_stripe_profile" && request.method === "GET") {
      sendJson(response, CURSOR_BYOK_FULL_STRIPE_PROFILE);
      return;
    }
    if (url.pathname === "/auth/stripe_profile" && request.method === "GET") {
      sendText(response, "byok_local");
      return;
    }
    if (url.pathname === "/auth/has_valid_payment_method" && request.method === "GET") {
      sendJson(response, CURSOR_BYOK_VALID_PAYMENT_METHOD);
      return;
    }
    if (url.pathname === "/auth/poll" && request.method === "GET") {
      sendJson(response, CURSOR_BYOK_AUTH_POLL);
      return;
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      sendJson(response, CURSOR_BYOK_LOGOUT);
      return;
    }
    if (url.pathname === "/byok/health") {
      const windowId = requestWindowId(request, url);
      sendJson(response, cleanUndefined({
        ok: true,
        byokMode: loadRoutes().byokMode !== 0,
        workspaceRoots: this.workspaceRootsForWindowId(windowId),
        windowId: windowId || undefined,
        windowScoped: windowId ? this.hasWorkspaceScopeForWindowId(windowId) : undefined,
      }));
      return;
    }
    if (url.pathname === "/byok/workspace-roots" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      const roots = Array.isArray(body?.workspaceRoots) ? body.workspaceRoots : [];
      const windowId = requestWindowId(request, url, body);
      const workspaceRoots = this.registerWorkspaceRoots(roots, windowId);
      sendJson(response, { ok: true, windowId, workspaceRoots });
      return;
    }
    if (url.pathname === "/byok/events") {
      this.handleEvents(request, response);
      return;
    }
    if (url.pathname === "/byok/toggle" && request.method === "POST") {
      const routes = loadRoutes();
      routes.byokMode = routes.byokMode === 0 ? 1 : 0;
      writeRoutes(routes);
      this.broadcast("routes", routePatterns(routes));
      sendJson(response, { byokMode: routes.byokMode !== 0 });
      return;
    }
    if (url.pathname === "/byok/mode" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      if (typeof body?.enabled !== "boolean") {
        sendJson(response, { error: "enabled must be a boolean" }, 400);
        return;
      }
      const routes = loadRoutes();
      routes.byokMode = body.enabled ? 1 : 0;
      writeRoutes(routes);
      this.broadcast("routes", routePatterns(routes));
      sendJson(response, { byokMode: routes.byokMode !== 0 });
      return;
    }
    if (url.pathname === "/byok/models") {
      sendJson(response, { models: isByokModeEnabled() ? mergeAvailableModels([], loadProviders()) : [] });
      return;
    }
    if (url.pathname === "/byok/run" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      await this.handleLocalRun(body, response, url, this.requestWorkspaceScope(request, url, body));
      return;
    }
    if (url.pathname === "/byok/should-handle" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      await this.handleShouldHandle(body, response, this.requestWorkspaceScope(request, url, body));
      return;
    }
    if (url.pathname === "/byok/debug" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      this.handleDebugEvent(body, response);
      return;
    }
    if (url.pathname === "/byok/tool-result" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      await this.handleToolResult(body, response, this.requestWorkspaceScope(request, url, body));
      return;
    }
    if (url.pathname === "/byok/interaction-response" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      await this.handleInteractionResponse(body, response);
      return;
    }
    if (url.pathname === "/byok/client-tool-completion" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      await this.handleClientToolCompletion(body, response);
      return;
    }
    if (url.pathname === "/byok/exec-map" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      this.handleExecMap(body, response);
      return;
    }
    if (url.pathname === "/byok/local-tool-result" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      this.handleLocalToolResult(body, response);
      return;
    }
    if (url.pathname === "/byok/local-client-message" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      this.handleLocalClientMessage(body, response);
      return;
    }
    if (url.pathname === "/byok/bidi" && request.method === "POST") {
      const body = await readJson(request, this.maxRequestBodyBytes);
      const record = this.bidiRawQueue.push(body);
      let decoded = null;
      let local = false;
      let modelId = "";
      try {
        decoded = decodeBidiClientMessage(record);
        if (decoded.clientMessage?.message?.case) {
          const session = this.sessions.recordClientMessage(
            decoded.requestId || record.requestId,
            decoded.clientMessage,
            record,
          );
          if (decoded.clientMessage.message.case === "execClientMessage") {
            this.log.info("BYOK Cursor exec result", {
              requestId: decoded.requestId || record.requestId,
              ...summarizeExecResult(decoded.clientMessage.message.value),
              ...summarizeShellStreamShape(decoded.clientMessage.message.value),
            });
          }
          if (decoded.clientMessage.message.case === "runRequest") {
            const providers = loadProviders();
            modelId = pickModelId(extractModelCandidates(decoded.clientMessage.message.value), providers);
            session.isByok = isByokModeEnabled() && !!findProviderModel(modelId, providers);
            session.modelId = modelId;
          }
          local = !!session?.isByok;
          modelId = modelId || session?.modelId || "";
        }
      } catch (error) {
        this.log.warn("failed to decode BidiAppend payload", {
          requestId: record.requestId,
          error: error.message,
        });
      }
      sendJson(response, {
        ok: true,
        requestId: record.requestId,
        kindHint: record.kindHint,
        handle: local,
        modelId,
        messageCase: decoded?.clientMessage?.message?.case,
        pendingForRequest: this.bidiRawQueue.sizeFor(record.requestId),
        fifoPending: this.bidiRawQueue.fifoSize,
      });
      return;
    }
    await this.proxyToCursor(request, response, url);
  }

  handleEvents(requestOrResponse, maybeResponse) {
    const request = maybeResponse ? requestOrResponse : null;
    const response = maybeResponse || requestOrResponse;
    const windowId = eventWindowId(request);
    this.claimOwnerWindowId(windowId);
    if (windowId && !this.workspaceRootsByWindowId.has(windowId) && this.workspaceRoots.length) {
      this.workspaceRootsByWindowId.set(windowId, this.workspaceRoots);
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      response.write("\n");
    } catch {
      return;
    }
    const previous = windowId ? this.eventsByWindowId.get(windowId) : null;
    if (previous && previous !== response) {
      this.events.delete(previous);
      try {
        previous.end();
      } catch {}
    }
    this.events.add(response);
    if (windowId) this.eventsByWindowId.set(windowId, response);
    try {
      this.onEventClientConnected?.({ windowId, eventClientCount: this.events.size });
    } catch (error) {
      this.log.warn("BYOK events client callback failed", { windowId, error: error?.message });
    }
    this.log.info("BYOK events client connected", {
      windowId,
      replacedExistingWindow: !!previous && previous !== response,
      eventClientCount: this.events.size,
    });
    const routes = loadRoutes();
    const providers = loadProviders();
    try {
      response.write(`event: routes\ndata: ${JSON.stringify(routePatterns(routes))}\n\n`);
      response.write(`event: models\ndata: ${JSON.stringify({
        modelIds: [...byokModelIds(providers)],
        models: mergeAvailableModels([], providers),
      })}\n\n`);
    } catch {
      this.events.delete(response);
      if (windowId && this.eventsByWindowId.get(windowId) === response) {
        this.eventsByWindowId.delete(windowId);
      }
      response.end?.();
      return;
    }
    const remove = () => {
      this.events.delete(response);
      if (windowId && this.eventsByWindowId.get(windowId) === response) {
        this.eventsByWindowId.delete(windowId);
      }
      this.log.info("BYOK events client disconnected", {
        windowId,
        eventClientCount: this.events.size,
      });
      try {
        this.onEventClientDisconnected?.({ windowId, eventClientCount: this.events.size });
      } catch (error) {
        this.log.warn("BYOK events client disconnect callback failed", { windowId, error: error?.message });
      }
    };
    response.on("close", remove);
    response.on?.("error", remove);
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of [...this.events]) {
      if (response.destroyed || response.writableEnded) {
        this.events.delete(response);
        deleteEventWindowId(this.eventsByWindowId, response);
        continue;
      }
      try {
        if (!response.write(payload)) {
          this.events.delete(response);
          deleteEventWindowId(this.eventsByWindowId, response);
          response.end?.();
        }
      } catch {
        this.events.delete(response);
        deleteEventWindowId(this.eventsByWindowId, response);
      }
    }
  }

  registerWorkspaceRoots(workspaceRoots, windowId = "") {
    const roots = normalizeWorkspaceRoots(workspaceRoots);
    if (windowId) {
      this.workspaceRootsByWindowId.set(windowId, roots);
      if (!this.ownerWindowId && roots.length) {
        this.ownerWindowId = windowId;
      }
      return roots;
    }
    if (!this.ownerWindowId && this.eventsByWindowId.size === 1) {
      this.ownerWindowId = this.eventsByWindowId.keys().next().value;
    }
    this.workspaceRoots = roots;
    return this.workspaceRoots;
  }

  workspaceRootsForWindowId(windowId = "") {
    if (windowId && this.workspaceRootsByWindowId.has(windowId)) {
      return this.workspaceRootsByWindowId.get(windowId);
    }
    if (windowId && this.ownerWindowId !== windowId) return [];
    return this.workspaceRoots;
  }

  hasWorkspaceScopeForWindowId(windowId = "") {
    if (!windowId) return true;
    return this.workspaceRootsByWindowId.has(windowId) || this.ownerWindowId === windowId;
  }

  claimOwnerWindowId(windowId = "") {
    if (!windowId || this.ownerWindowId || !this.workspaceRoots.length) return;
    this.ownerWindowId = windowId;
  }

  maybeAdoptWindowWorkspaceScope(windowId = "") {
    if (!windowId || this.hasWorkspaceScopeForWindowId(windowId) || !this.workspaceRoots.length) return "";
    if (!this.ownerWindowId && this.eventsByWindowId.size === 0 && this.workspaceRootsByWindowId.size === 0) {
      this.ownerWindowId = windowId;
      return "startup-owner-fallback";
    }
    if (this.eventsByWindowId.has(windowId)) {
      this.workspaceRootsByWindowId.set(windowId, this.workspaceRoots);
      return "event-client-fallback";
    }
    return "";
  }

  requestWorkspaceScope(request, url, body) {
    const windowId = requestWindowId(request, url, body);
    const bodyRoots = Array.isArray(body?.workspaceRoots) ? normalizeWorkspaceRoots(body.workspaceRoots) : [];
    const adoptedScope = bodyRoots.length ? "" : this.maybeAdoptWindowWorkspaceScope(windowId);
    const workspaceRoots = bodyRoots.length ? bodyRoots : this.workspaceRootsForWindowId(windowId);
    const hasWorkspaceScope = bodyRoots.length > 0 || this.hasWorkspaceScopeForWindowId(windowId);
    return { windowId, workspaceRoots, hasWorkspaceScope, adoptedScope };
  }

  sessionWorkspaceRoots(requestId, scope = {}) {
    const scopedRoots = Array.isArray(scope.workspaceRoots) ? scope.workspaceRoots : [];
    if (scopedRoots.length) return scopedRoots;
    const sessionRoots = requestId && typeof this.sessions.get === "function"
      ? this.sessions.get(requestId)?.workspaceRoots
      : null;
    if (Array.isArray(sessionRoots) && sessionRoots.length) return sessionRoots;
    return this.workspaceRootsForWindowId(scope.windowId);
  }

  rememberSessionWorkspaceRoots(requestId, workspaceRoots) {
    if (!requestId || !Array.isArray(workspaceRoots) || !workspaceRoots.length) return;
    this.sessions.getOrCreate(requestId).workspaceRoots = workspaceRoots;
  }

  handleDebugEvent(body, response) {
    this.log.info("BYOK client debug", body);
    sendJson(response, { ok: true });
  }

  async handleShouldHandle(body, response, scope = {}) {
    const providers = loadProviders();
    const requestId = body?.requestId || findRequestId(body);
    const workspaceRoots = this.sessionWorkspaceRoots(requestId, scope);
    let runRequest = body?.request || body?.runRequest || null;
    this.log.info("BYOK should-handle request", {
      requestId,
      windowId: scope.windowId,
      hasWorkspaceScope: scope.hasWorkspaceScope,
      adoptedScope: scope.adoptedScope || undefined,
      workspaceRootCount: workspaceRoots.length,
      candidates: extractModelCandidates(runRequest).filter((candidate) => typeof candidate === "string" && candidate),
      hasMessages: !!(runRequest && Array.isArray(runRequest.messages) && runRequest.messages.length),
      actionCase: actionCaseForDebug(runRequest?.action),
      isPlanExecution: !!runRequest?.isPlanExecution,
      modelOverride: typeof runRequest?.modelOverride === "string" ? runRequest.modelOverride : "",
      requestKeys: runRequest && typeof runRequest === "object" ? Object.keys(runRequest).slice(0, 40) : [],
    });
    if (scope.windowId && !scope.hasWorkspaceScope) {
      sendJson(response, {
        handle: false,
        reason: "workspace-scope-not-registered",
        requestId,
        modelId: pickModelId(extractModelCandidates(runRequest), providers),
      });
      return;
    }
    if (!isByokModeEnabled()) {
      runRequest = runRequest || this.sessions.get(requestId)?.runRequest || null;
      sendJson(response, {
        handle: false,
        reason: "byok-mode-off",
        requestId,
        modelId: pickModelId(extractModelCandidates(runRequest), providers),
      });
      return;
    }
    if (!hasModelCandidate(runRequest) && requestId) {
      runRequest = await this.sessions.waitForRunRequest(requestId) || runRequest;
    }
    if (!runRequest) {
      sendJson(response, { handle: false, reason: "run-request-not-found", requestId });
      return;
    }
    runRequest = await hydrateProviderInputFromRunRequest(runRequest, {
      workspaceRoots,
      readFile: this.readFile,
    });
    if (!hasProviderInput(runRequest) && requestId) {
      const completeRequest = await this.sessions.waitForRunRequest(
        requestId,
        5000,
        (candidate) => hasProviderInputHint(mergeRunRequest(runRequest, candidate)),
      );
      if (completeRequest) runRequest = mergeRunRequest(runRequest, completeRequest);
      runRequest = await hydrateProviderInputFromRunRequest(runRequest, {
        workspaceRoots,
        readFile: this.readFile,
      });
    }
    const modelId = pickModelId(extractModelCandidates(runRequest), providers);
    const entry = findProviderModel(modelId, providers);
    if (!hasProviderInput(runRequest)) {
      sendJson(response, {
        handle: false,
        reason: "provider-input-not-found",
        requestId,
        modelId,
      });
      return;
    }
    if (requestId) {
      const session = this.sessions.getOrCreate(requestId);
      session.isByok = !!entry;
      session.modelId = modelId;
      this.rememberSessionWorkspaceRoots(requestId, workspaceRoots);
      if (runRequest) {
        this.sessions.recordClientMessage(requestId, {
          message: { case: "runRequest", value: runRequest },
        });
      }
    }
    const handle = !!entry;
    if (!handle) {
      this.log.info("BYOK should-handle declined", {
        requestId,
        reason: entry ? "unknown" : (modelId ? "model-not-found" : "model-candidate-missing"),
        modelId,
        candidates: extractModelCandidates(runRequest).filter((candidate) => typeof candidate === "string" && candidate),
      });
    }
    sendJson(response, {
      handle,
      requestId,
      modelId,
      provider: entry?.provider?.name,
      model: entry?.model?.id,
    });
  }

  async handleToolResult(body, response, scope = {}) {
    const requestId = body?.requestId;
    const toolCallId = body?.toolCallId;
    if (!requestId || !toolCallId) {
      sendJson(response, { error: "requestId and toolCallId are required" }, 400);
      return;
    }
    if (body.directOnly) {
      const result = await this.waitForDirectToolResult(requestId, toolCallId, {
        toolName: body.toolName,
        toolArguments: body.toolArguments,
        allowLargeRead: body.allowLargeRead,
        workspaceRoots: this.sessionWorkspaceRoots(requestId, scope),
      });
      if (!result) {
        sendJson(response, { ok: false, direct: false }, 404);
        return;
      }
      sendJson(response, { ok: true, direct: true, result });
      return;
    }
    const result = await this.waitForProviderToolResult(requestId, toolCallId, {
      toolName: body.toolName,
      toolArguments: body.toolArguments,
      timeoutMs: body.timeoutMs,
      allowLargeRead: body.allowLargeRead,
      workspaceRoots: this.sessionWorkspaceRoots(requestId, scope),
    });
    sendJson(response, { ok: true, result });
  }

  async handleClientToolCompletion(body, response) {
    const requestId = body?.requestId;
    const toolCallId = body?.toolCallId;
    const toolName = typeof body?.toolName === "string" ? body.toolName : "";
    if (!requestId || !toolCallId) {
      sendJson(response, { error: "requestId and toolCallId are required" }, 400);
      return;
    }
    if (toolName === "WebSearch") {
      const providers = loadProviders();
      const webSearchConfig = normalizeWebSearchConfig(providers);
      if (isWebSearchExaConfigured(providers)) {
        const searchTerm = searchTermFromToolArguments(body.toolArguments, toolCallId);
        this.log.info("BYOK executing WebSearch with Exa", {
          requestId,
          toolCallId: String(toolCallId),
          searchTerm,
        });
        const completion = await webSearchCompletionFromExa({
          searchTerm,
          config: webSearchConfig,
        });
        sendJson(response, { ok: true, completion });
        return;
      }
    }
    if (toolName === "WebFetch") {
      const providers = loadProviders();
      const webFetchConfig = normalizeWebFetchConfig(providers);
      if (webFetchConfig) {
        const url = urlFromToolArguments(body.toolArguments);
        const timeoutMs = normalizeToolResultTimeout(body.timeoutMs, toolName, body.toolArguments);
        this.log.info("BYOK executing WebFetch with server provider", {
          requestId,
          toolCallId: String(toolCallId),
          url,
          provider: webFetchConfig.provider,
          timeoutMs,
        });
        const completion = await webFetchCompletion({
          url,
          config: webFetchConfig,
          timeoutMs,
        });
        sendJson(response, { ok: true, completion });
        return;
      }
      const misconfiguration = describeWebFetchMisconfiguration(providers);
      if (misconfiguration) {
        this.log.warn("BYOK WebFetch provider misconfigured", {
          requestId,
          toolCallId: String(toolCallId),
          error: misconfiguration,
        });
        sendJson(response, {
          ok: true,
          completion: mapWebFetchProviderError(new Error(misconfiguration)),
        });
        return;
      }
    }
    const timeoutMs = normalizeToolResultTimeout(body.timeoutMs, toolName, body.toolArguments);
    this.log.info("BYOK waiting for Cursor client tool completion", {
      requestId,
      toolCallId: String(toolCallId),
      toolName,
      timeoutMs,
    });
    try {
      const completion = await this.sessions.waitForClientToolCompletion(requestId, toolCallId, toolName, timeoutMs);
      sendJson(response, { ok: true, completion });
    } catch (error) {
      this.log.warn("BYOK Cursor client tool completion timed out", {
        requestId,
        toolCallId: String(toolCallId),
        toolName,
        timeoutMs,
        error: error.message,
      });
      sendJson(response, {
        ok: true,
        completion: {
          case: "error",
          value: { error: error.message },
        },
      });
    }
  }

  async handleInteractionResponse(body, response) {
    const requestId = body?.requestId;
    const queryId = body?.queryId;
    const toolName = typeof body?.toolName === "string" ? body.toolName : "";
    const toolCallId = typeof body?.toolCallId === "string" ? body.toolCallId : undefined;
    if (!requestId || queryId === undefined || queryId === null || queryId === "") {
      sendJson(response, { error: "requestId and queryId are required" }, 400);
      return;
    }
    const timeoutMs = normalizeToolResultTimeout(body.timeoutMs, toolName, body.toolArguments);
    this.log.info("BYOK waiting for Cursor interaction response", {
      requestId,
      queryId: String(queryId),
      toolName,
      toolCallId,
      timeoutMs,
    });
    try {
      const result = await this.sessions.waitForInteractionResponse(requestId, queryId, timeoutMs);
      this.log.info("BYOK returning Cursor interaction response", {
        requestId,
        queryId: String(queryId),
        toolName,
        toolCallId,
        resultCase: result?.result?.case,
        ...summarizeInteractionResponse(toolName, result),
      });
      sendJson(response, { ok: true, result });
    } catch (error) {
      this.log.warn("BYOK Cursor interaction response timed out", {
        requestId,
        queryId: String(queryId),
        toolName,
        toolCallId,
        timeoutMs,
        error: error.message,
      });
      sendJson(response, {
        ok: true,
        result: interactionTimeoutResponse(toolName, queryId, error.message),
      });
    }
  }

  handleExecMap(body, response) {
    const requestId = body?.requestId;
    const toolCallId = body?.toolCallId;
    if (!requestId || !toolCallId) {
      sendJson(response, { error: "requestId and toolCallId are required" }, 400);
      return;
    }
    this.sessions.registerExecAlias(requestId, body.id, toolCallId, body.execId);
    this.log.info("BYOK registered Cursor exec alias", {
      requestId,
      id: body.id,
      execId: body.execId,
      toolCallId,
    });
    sendJson(response, { ok: true });
  }

  handleLocalToolResult(body, response) {
    const requestId = body?.requestId;
    const toolCallId = body?.toolCallId;
    if (!requestId || !toolCallId || !body?.result) {
      sendJson(response, { error: "requestId, toolCallId, and result are required" }, 400);
      return;
    }
    const result = normalizeExecClientResult(body.result);
    this.sessions.recordClientMessage(requestId, {
      message: {
        case: "execClientMessage",
        value: {
          ...result,
          _byokToolCallId: toolCallId,
        },
      },
    });
    this.log.info("BYOK local tool result", {
      requestId,
      toolCallId,
      ...summarizeExecResult(result),
      ...summarizeInteractionLocalToolResult(result),
      ...summarizeShellStreamShape(result),
    });
    sendJson(response, { ok: true });
  }

  handleLocalClientMessage(body, response) {
    const requestId = body?.requestId;
    const message = body?.message;
    if (!requestId || !message?.case) {
      sendJson(response, { error: "requestId and message.case are required" }, 400);
      return;
    }
    this.sessions.recordClientMessage(requestId, { message });
    if (message.case === "conversationAction") {
      const actionCase = actionCaseForDebug(message.value);
      const sessionRunRequest = this.sessions.get(requestId)?.runRequest;
      const conversationId = stringValue(
        sessionRunRequest?.conversationId,
        stringValue(sessionRunRequest?.conversationState?.conversationId),
      );
      const cancelled = actionCase === "cancelAction" || actionCase === "cancelSubagentAction"
        ? this.cancelActiveRun(requestId, conversationId, `conversationAction:${actionCase}`)
        : false;
      this.log.info("BYOK local conversation action", {
        requestId,
        actionCase,
        cancelledRun: cancelled,
      });
    }
    if (message.case === "interactionResponse") {
      this.log.info("BYOK local interaction response", {
        requestId,
        queryId: String(message.value?.id ?? ""),
        resultCase: message.value?.result?.case,
      });
    }
    sendJson(response, { ok: true });
  }

  async handleLocalRun(body, response, url, scope = {}) {
    const providers = loadProviders();
    const requestId = body?.requestId || url.searchParams.get("requestId") || findRequestId(body);
    const workspaceRoots = this.sessionWorkspaceRoots(requestId, scope);
    let request = body?.request || body?.runRequest || null;
    if (scope.windowId && !scope.hasWorkspaceScope) {
      sendJson(response, { local: false, reason: "workspace-scope-not-registered", requestId }, 404);
      return;
    }
    if (!isByokModeEnabled()) {
      request = request || this.sessions.get(requestId)?.runRequest || null;
      this.log.info("BYOK local run bypassed", {
        requestId,
        reason: "byok-mode-off",
        modelId: pickModelId(extractModelCandidates(request), providers),
      });
      sendJson(response, {
        local: false,
        reason: "byok-mode-off",
        modelId: pickModelId(extractModelCandidates(request), providers),
      }, 404);
      return;
    }
    if (!hasModelCandidate(request) && requestId) {
      request = await this.sessions.waitForRunRequest(requestId) || request;
    }
    if (!request) {
      this.log.warn("BYOK local run rejected", {
        requestId,
        reason: "run-request-not-found",
      });
      sendJson(response, { local: false, reason: "run-request-not-found", requestId }, 404);
      return;
    }
    if (requestId) {
      this.rememberSessionWorkspaceRoots(requestId, workspaceRoots);
      this.sessions.recordClientMessage(requestId, {
        message: { case: "runRequest", value: request },
      });
    }
    request = await hydrateProviderInputFromRunRequest(request, {
      workspaceRoots,
      readFile: this.readFile,
    });
    request = await maybeWaitForRicherRunRequest(this.sessions, requestId, request);
    if (!hasProviderInput(request) && requestId) {
      const completeRequest = await this.sessions.waitForRunRequest(
        requestId,
        5000,
        (candidate) => hasProviderInputHint(mergeRunRequest(request, candidate)),
      );
      if (completeRequest) request = mergeRunRequest(request, completeRequest);
      request = await hydrateProviderInputFromRunRequest(request, {
        workspaceRoots,
        readFile: this.readFile,
      });
    }
    request = normalizeRunRequestForProvider(request, { workspaceRoots });
    const modelId = pickModelId(extractModelCandidates(request), providers);
    const entry = findProviderModel(modelId, providers);
    if (!entry) {
      this.log.info("BYOK local run bypassed", {
        requestId,
        reason: "model-not-found",
        modelId,
      });
      sendJson(response, { local: false, reason: "model-not-found", modelId }, 404);
      return;
    }
    if (!hasProviderInput(request)) {
      this.log.warn("BYOK local run rejected", {
        requestId,
        reason: "provider-input-not-found",
        modelId,
        hasMessages: Array.isArray(request.messages) && request.messages.length > 0,
        actionMessageCount: extractUserMessagesFromActions(extractRunActions(request)).length,
      });
      sendJson(response, { error: "provider-input-not-found", requestId }, 400);
      return;
    }
    const streamState = responseStreamState(response);
    let eventsWritten = 0;
    let iterator;
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    const abortController = new AbortController();
    const activeRun = {
      requestId,
      conversationId: stringValue(
        request?.conversationId,
        stringValue(request?.conversationState?.conversationId),
      ),
      abortController,
      cancelled: false,
      cancelReason: "",
    };
    this.registerActiveRun(activeRun);
    const abortRun = () => {
      if (!activeRun.cancelled) {
        activeRun.cancelled = true;
        activeRun.cancelReason = "response-closed";
      }
      try {
        abortController.abort(new Error("response-closed"));
      } catch {
        abortController.abort();
      }
    };
    response.once?.("close", abortRun);
    let endedByClose = false;
    try {
      if (!await writeNdjsonLine(response, { type: "meta", local: true, modelId }, streamState)) return;
      iterator = this.providerAdapter.run({
        provider: entry.provider,
        model: entry.model,
        request,
        requestId,
        signal: abortController.signal,
        waitForToolResult: async (toolCallId, options) => this.waitForProviderToolResult(requestId, toolCallId, {
          ...options,
          workspaceRoots,
        }),
      })[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), streamState.closedPromise]);
        if (next === STREAM_CLOSED || next.done || streamState.closed) break;
        const { value } = next;
        eventsWritten++;
        if (!await writeNdjsonLine(response, value, streamState)) break;
      }
    } catch (error) {
      if (!streamState.closed) {
        if (activeRun.cancelled || isProviderRunAbortError(error)) {
          this.log.info("BYOK local run cancelled", {
            requestId,
            conversationId: activeRun.conversationId || undefined,
            modelId,
            reason: activeRun.cancelReason || error?.message || undefined,
            eventsWritten,
          });
          await writeByokRunCancelled(response, streamState);
        } else {
          this.log.error("BYOK local run failed after stream started", {
            requestId,
            modelId,
            error: error.message,
            eventsWritten,
          });
          await writeByokRunFailure(response, streamState, error);
        }
      }
    } finally {
      this.unregisterActiveRun(activeRun);
      response.off?.("close", abortRun);
      streamState.dispose();
      if (streamState.closed) {
        endedByClose = true;
        abortController.abort();
        try {
          Promise.resolve(iterator?.return?.()).catch(() => {});
        } catch {}
        this.log.info("BYOK local run response closed", {
          requestId,
          modelId,
          eventsWritten,
        });
      }
    }
    if (endedByClose) return;
    response.end();
  }

  registerActiveRun(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.requestId) this.activeRunsByRequestId.set(entry.requestId, entry);
    if (entry.conversationId) this.activeRunsByConversationId.set(entry.conversationId, entry);
  }

  unregisterActiveRun(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.requestId && this.activeRunsByRequestId.get(entry.requestId) === entry) {
      this.activeRunsByRequestId.delete(entry.requestId);
    }
    if (entry.conversationId && this.activeRunsByConversationId.get(entry.conversationId) === entry) {
      this.activeRunsByConversationId.delete(entry.conversationId);
    }
  }

  cancelActiveRun(requestId, conversationId, reason = "") {
    let entry = requestId ? this.activeRunsByRequestId.get(requestId) : null;
    let matchedBy = entry ? "requestId" : "";
    if (!entry && conversationId) {
      entry = this.activeRunsByConversationId.get(conversationId) || null;
      matchedBy = entry ? "conversationId" : "";
    }
    if (!entry) return false;
    if (entry.cancelled) return true;
    entry.cancelled = true;
    entry.cancelReason = reason;
    this.log.info("BYOK local run cancel requested", {
      requestId: entry.requestId,
      conversationId: entry.conversationId || undefined,
      matchedBy,
      reason: reason || undefined,
    });
    try {
      entry.abortController.abort(new Error(reason || "cancelled"));
    } catch {
      try {
        entry.abortController.abort();
      } catch {}
    }
    return true;
  }

  async waitForProviderToolResult(requestId, toolCallId, options = {}) {
    const timeoutMs = normalizeToolResultTimeout(options.timeoutMs, options.toolName, options.toolArguments);
    const toolName = typeof options.toolName === "string" ? options.toolName : "";
    const completed = completedExecResult(this.sessions, requestId, toolCallId);
    if (completed) return completed;
    const directReadResult = await this.cachedDirectReadResult(requestId, toolCallId, toolName, options.toolArguments, {
      allowLargeRead: options.allowLargeRead,
      workspaceRoots: this.sessionWorkspaceRoots(requestId, options),
    });
    if (directReadResult?.result) {
      this.log.info("BYOK using direct Read result", {
        requestId,
        toolCallId,
        toolName,
        path: directReadResult.path,
      });
      return directReadResult.result;
    }
    this.log.info("BYOK waiting for Cursor exec result", { requestId, toolCallId, toolName, timeoutMs });
    try {
      const result = await this.sessions.waitForExecResult(requestId, toolCallId, timeoutMs);
      this.log.info("BYOK returning Cursor exec result", {
        requestId,
        toolCallId,
        toolName,
        ...summarizeExecResult(result),
        ...summarizeInteractionLocalToolResult(result),
      });
      return result;
    } catch (error) {
      const result = toolTimeoutResult(toolCallId, toolName);
      this.log.warn("BYOK Cursor exec result timed out", {
        requestId,
        toolCallId,
        toolName,
        timeoutMs,
        error: error.message,
        ...summarizeExecResult(result),
      });
      return result;
    }
  }

  async waitForDirectToolResult(requestId, toolCallId, options = {}) {
    const toolName = typeof options.toolName === "string" ? options.toolName : "";
    const completed = completedExecResult(this.sessions, requestId, toolCallId);
    if (completed?._byokDirectTool && (toolName === "Read" || toolName === "ReadFile")) return completed;
    const directReadResult = await this.cachedDirectReadResult(requestId, toolCallId, toolName, options.toolArguments, {
      allowLargeRead: options.allowLargeRead,
      workspaceRoots: this.sessionWorkspaceRoots(requestId, options),
    });
    return directReadResult?.result || null;
  }

  async cachedDirectReadResult(requestId, toolCallId, toolName, toolArguments, options = {}) {
    const cacheKey = [
      requestId || "",
      toolCallId || "",
      toolName || "",
      typeof toolArguments === "string" ? toolArguments : JSON.stringify(toolArguments || {}),
      JSON.stringify(options.workspaceRoots || []),
      options.allowLargeRead ? "full" : "inline",
    ].join("\0");
    let inFlight = this.directReadResultsInFlight.get(cacheKey);
    if (!inFlight) {
      inFlight = this.directReadResult(toolCallId, toolName, toolArguments, options).then((directReadResult) => {
        if (directReadResult?.result && typeof this.sessions.storeExecResult === "function") {
          this.sessions.storeExecResult(requestId, toolCallId, directReadResult.result);
        }
        return directReadResult;
      }).finally(() => {
        this.directReadResultsInFlight.delete(cacheKey);
      });
      this.directReadResultsInFlight.set(cacheKey, inFlight);
    }
    return inFlight;
  }

  async directReadResult(toolCallId, toolName, toolArguments, options = {}) {
    if (toolName !== "Read" && toolName !== "ReadFile") return null;
    const args = parseToolArguments(toolArguments);
    const targetPath = stringValue(args.path, stringValue(args.file_path, stringValue(args.filePath)));
    if (!targetPath) return null;
    const workspaceRoots = Array.isArray(options.workspaceRoots) ? options.workspaceRoots : this.workspaceRoots;
    const resolvedPath = resolveToolPathInWorkspace(targetPath, workspaceRoots);
    if (!this.readFile && pathIsWithinWorkspaceRoots(resolvedPath, workspaceRoots)) return null;
    return {
      path: resolvedPath,
      result: await buildDirectReadExecResult(toolCallId, resolvedPath, args, this.readFile, options),
    };
  }

  async proxyToCursor(request, response, url) {
    const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
    const headers = copyForwardHeaders(request.headers);
    const body = await readBuffer(request, this.maxRequestBodyBytes);
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: body.length ? body : undefined,
    });
    if (url.pathname.includes("AvailableModels")) {
      await this.handleAvailableModels(upstreamResponse, response);
      return;
    }
    response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
    if (upstreamResponse.body) {
      if (!await pipeResponseBody(upstreamResponse.body, response)) return;
    }
    response.end();
  }

  async handleAvailableModels(upstreamResponse, response) {
    const text = await readResponseText(upstreamResponse, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
      response.end(text);
      return;
    }
    const officialModels = Array.isArray(json.models) ? json.models : [];
    const merged = mergeAvailableModels(officialModels, loadProviders());
    sendJson(response, { ...json, models: merged });
  }
}

function routePatterns(routes) {
  if (routes?.byokMode === 0) return [];
  const redirect = Array.isArray(routes.redirect) ? routes.redirect : [];
  return redirect.map((route) => route.replace(/^REST:/, ""));
}

function eventWindowId(request) {
  if (!request) return "";
  const queryWid = typeof request.url === "string"
    ? new URL(request.url, "http://127.0.0.1").searchParams.get("wid")
    : "";
  if (queryWid) return queryWid;
  return stringValue(request.headers?.["x-client-wid"], "");
}

function requestWindowId(request, url, body = null) {
  const queryWid = url?.searchParams?.get("wid") || "";
  if (queryWid) return queryWid;
  const headerWid = stringValue(request?.headers?.["x-client-wid"], "");
  if (headerWid) return headerWid;
  return stringValue(body?.windowId, stringValue(body?.wid, ""));
}

function deleteEventWindowId(eventsByWindowId, response) {
  for (const [windowId, current] of eventsByWindowId) {
    if (current === response) {
      eventsByWindowId.delete(windowId);
      return;
    }
  }
}

function isByokModeEnabled() {
  return loadRoutes().byokMode !== 0;
}

function resolvePrimaryModelNameFromConfig(modelConfig) {
  if (!modelConfig || typeof modelConfig !== "object") return "";
  const modelName = typeof modelConfig.modelName === "string" ? modelConfig.modelName : "";
  if (modelName && modelName !== "default") return modelName;
  const selected = modelConfig.selectedModels;
  if (!Array.isArray(selected) || !selected.length) return modelName;
  for (const entry of selected) {
    if (!entry) continue;
    if (typeof entry === "string" && entry && entry !== "default") return entry;
    if (typeof entry.modelId === "string" && entry.modelId && entry.modelId !== "default") return entry.modelId;
    if (typeof entry.modelName === "string" && entry.modelName && entry.modelName !== "default") return entry.modelName;
  }
  return modelName;
}

function appendModelConfigCandidates(candidates, modelConfig) {
  if (!modelConfig || typeof modelConfig !== "object") return;
  candidates.push(modelConfig.modelName, modelConfig.model, modelConfig.modelId);
  const resolved = resolvePrimaryModelNameFromConfig(modelConfig);
  if (resolved) candidates.push(resolved);
  appendSelectedModelCandidates(candidates, modelConfig.selectedModels);
}

function hasMeaningfulModelCandidate(candidates) {
  if (!Array.isArray(candidates)) return false;
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate && candidate !== "default") return true;
  }
  return false;
}

function appendPlanExecutionModelConfigCandidates(candidates, body) {
  if (!body || typeof body !== "object") return;
  appendModelConfigCandidates(candidates, body.planExecutionModelConfig);
  if (!body.modelConfig || typeof body.modelConfig !== "object") return;
  appendModelConfigCandidates(candidates, body.modelConfig["plan-execution"]);
  appendModelConfigCandidates(candidates, body.modelConfig.planExecution);
}

function extractModelCandidates(body) {
  const candidates = [];
  if (typeof body?.modelOverride === "string" && body.modelOverride) candidates.push(body.modelOverride);
  candidates.push(
    body?.requestedModel?.modelId,
    body?.modelDetails?.modelId,
    body?.requestedModel?.modelName,
    body?.modelDetails?.modelName,
    body?.requestedModel?.name,
    body?.modelDetails?.name,
    body?.requestedModel?.apiModel,
    body?.modelDetails?.apiModel,
    body?.requestedModel?.displayModelId,
    body?.modelDetails?.displayModelId,
    body?.requestedModel?.displayName,
    body?.modelDetails?.displayName,
    body?.modelId,
    body?.model,
  );
  appendSelectedModelCandidates(candidates, body?.selectedModels);
  appendModelConfigCandidates(candidates, body?.modelConfig);
  appendModelConfigCandidates(candidates, body?.composerModelConfig);
  if (!hasMeaningfulModelCandidate(candidates)) appendPlanExecutionModelConfigCandidates(candidates, body);
  return candidates;
}

function appendSelectedModelCandidates(candidates, selectedModels) {
  if (!Array.isArray(selectedModels)) return;
  for (const selected of selectedModels) {
    if (!selected) continue;
    if (typeof selected === "string") {
      candidates.push(selected);
      continue;
    }
    candidates.push(
      selected.modelId,
      selected.modelName,
      selected.name,
      selected.apiModel,
      selected.displayModelId,
    );
  }
}

function hasModelCandidate(body) {
  return extractModelCandidates(body).some((candidate) => typeof candidate === "string" && candidate);
}

function hasProviderInput(request) {
  if (!request || typeof request !== "object") return false;
  return extractProviderMessages(request).length > 0;
}

function normalizeRunRequestForProvider(request, options = {}) {
  if (!request || typeof request !== "object") return request;
  const next = { ...request };
  const workspaceRoots = normalizeWorkspaceRoots(options.workspaceRoots);
  const composerMode = runRequestComposerMode(next);
  if (composerMode) next.composerMode = composerMode;
  if (next.systemPrompt === undefined && typeof next.customSystemPrompt === "string") {
    next.systemPrompt = next.customSystemPrompt;
  }
  if (workspaceRoots.length) next.workspaceRoots = workspaceRoots;
  const messages = extractProviderMessages(next);
  if (messages.length && !providerMessageSequenceEqual(next.messages, messages)) {
    next.messages = messages;
  }
  const hasExplicitTools = Array.isArray(next.tools) && next.tools.length > 0;
  const hasDecodedMcpTools = hasMcpTools(next.mcpTools);
  const decodedMcpToolsNeedCache = hasDecodedMcpTools && mcpToolsNeedCacheResolution(next.mcpTools);
  const explicitToolsNeedCache = hasExplicitTools && next.tools.some(toolNeedsMcpCacheResolution);
  const shouldLoadDiskMcpCache = !hasDecodedMcpTools || decodedMcpToolsNeedCache || explicitToolsNeedCache;
  let cachedMcpTools;
  let cachedByVisibleName;
  const getCachedMcpTools = () => {
    if (!shouldLoadDiskMcpCache) return [];
    if (cachedMcpTools === undefined) cachedMcpTools = loadCursorMcpToolsFromCache(options);
    return cachedMcpTools;
  };
  const getCachedByVisibleName = () => {
    if (!shouldLoadDiskMcpCache) return new Map();
    if (!cachedByVisibleName) cachedByVisibleName = cachedMcpToolMap(getCachedMcpTools());
    return cachedByVisibleName;
  };
  const mcpTools = hasDecodedMcpTools ? next.mcpTools : getCachedMcpTools();
  const autoExposedMcpTools = hasExplicitTools
    ? mcpTools
    : limitAutoExposedMcpTools(mcpTools, DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS);
  const cachedForResolution = decodedMcpToolsNeedCache || explicitToolsNeedCache ? getCachedByVisibleName() : new Map();
  const tools = hasExplicitTools
    ? next.tools.map((tool) => resolveCachedMcpDispatchMetadata(tool, cachedForResolution))
    : hasDecodedMcpTools
      ? defaultCursorBuiltinTools()
      : hasMcpTools(mcpTools)
      ? defaultCursorBuiltinTools()
      : [];
  appendMcpTools(tools, autoExposedMcpTools, cachedForResolution);
  if (hasExplicitTools || hasMcpTools(mcpTools)) appendInteractionBridgeProviderTools(tools);
  if (tools.length) next.tools = tools;
  return next;
}

async function maybeWaitForRicherRunRequest(sessions, requestId, request, timeoutMs = DEFAULT_RICHER_RUN_REQUEST_WAIT_MS) {
  if (!requestId || !request || typeof request !== "object" || typeof sessions?.waitForRunRequest !== "function") {
    return request;
  }
  const actionMessages = extractUserMessagesFromActions(extractRunActions(request));
  if (!actionMessages.length) return request;
  const explicitMessages = Array.isArray(request.messages)
    ? request.messages.filter((message) => message && typeof message === "object")
    : [];
  if (explicitMessages.length > actionMessages.length) return request;
  const currentProviderMessageCount = extractProviderMessages(request).length;
  if (currentProviderMessageCount <= 0) return request;
  const richerRequest = await sessions.waitForRunRequest(
    requestId,
    timeoutMs,
    (candidate) => extractProviderMessages(mergeRunRequest(request, candidate)).length > currentProviderMessageCount,
  );
  return richerRequest ? mergeRunRequest(request, richerRequest) : request;
}

function runRequestComposerMode(request) {
  return stringValue(
    request?.composerMode,
    stringValue(
      request?.composer_mode,
      stringValue(
        request?.mode,
        stringValue(
          request?.conversationState?.mode,
          stringValue(request?.field6_conversationState?.mode),
        ),
      ),
    ),
  );
}

function hasMcpTools(mcpToolsField) {
  const groups = Array.isArray(mcpToolsField) ? mcpToolsField : mcpToolsField ? [mcpToolsField] : [];
  return groups.some((group) => Array.isArray(group?.mcpTools) && group.mcpTools.length > 0);
}

function limitAutoExposedMcpTools(mcpToolsField, maxDirectTools) {
  const groups = Array.isArray(mcpToolsField) ? mcpToolsField : mcpToolsField ? [mcpToolsField] : [];
  if (!(Number.isInteger(maxDirectTools) && maxDirectTools >= 0)) return groups;
  let directToolCount = 0;
  for (const group of groups) {
    const mcpTools = Array.isArray(group?.mcpTools) ? group.mcpTools : [];
    for (const tool of mcpTools) {
      if (isMcpAuthToolDefinition(tool)) continue;
      directToolCount += 1;
      if (directToolCount > maxDirectTools) {
        return groups.map((entry) => ({
          ...entry,
          mcpTools: (Array.isArray(entry?.mcpTools) ? entry.mcpTools : []).filter(isMcpAuthToolDefinition),
        })).filter((entry) => entry.mcpTools.length > 0);
      }
    }
  }
  return groups;
}

function isMcpAuthToolDefinition(tool) {
  if (!tool || typeof tool !== "object") return false;
  const toolName = stringValue(tool.toolName, inferMcpToolName(tool.name || tool.canonicalName));
  return toolName === "mcp_auth";
}

function mcpToolsNeedCacheResolution(mcpToolsField) {
  const groups = Array.isArray(mcpToolsField) ? mcpToolsField : mcpToolsField ? [mcpToolsField] : [];
  for (const group of groups) {
    const mcpTools = Array.isArray(group?.mcpTools) ? group.mcpTools : [];
    for (const tool of mcpTools) {
      if (toolNeedsMcpCacheResolution(tool)) return true;
    }
  }
  return false;
}

function toolNeedsMcpCacheResolution(tool) {
  if (!tool || typeof tool !== "object") return false;
  const name = typeof tool.name === "string" ? tool.name : typeof tool.canonicalName === "string" ? tool.canonicalName : "";
  const toolName = typeof tool.toolName === "string" && tool.toolName ? tool.toolName : inferMcpToolName(name);
  const providerIdentifier = inferMcpProviderIdentifier(name, toolName, tool.providerIdentifier);
  if (!providerIdentifier || !toolName) return typeof tool.providerIdentifier === "string" && tool.providerIdentifier.length > 0;
  const executionName = officialMcpExecutionName(providerIdentifier, toolName);
  if (typeof tool.executionName === "string" && tool.executionName && tool.executionName !== executionName) return true;
  const expectedVisibleName = providerToolNameForMcpExecutionName(executionName);
  return !!(name && name !== executionName && name !== expectedVisibleName);
}

function appendMcpTools(tools, mcpToolsField, cachedByVisibleName = new Map()) {
  const seen = new Set(tools.map((tool) => tool?.name || tool?.canonicalName).filter(Boolean));
  const groups = Array.isArray(mcpToolsField) ? mcpToolsField : mcpToolsField ? [mcpToolsField] : [];
  for (const group of groups) {
    const mcpTools = Array.isArray(group?.mcpTools) ? group.mcpTools : [];
    for (const tool of mcpTools) {
      if (!tool?.name) continue;
      const cached = resolveCachedMcpTool(tool, cachedByVisibleName);
      const toolName = stringValue(cached?.toolName, stringValue(tool.toolName, inferMcpToolName(tool.name)));
      const providerIdentifier = stringValue(
        cached?.providerIdentifier,
        inferMcpProviderIdentifier(tool.name, toolName, tool.providerIdentifier),
      );
      const isDirectMcp = !!cached || providerIdentifier.length > 0;
      const executionName = stringValue(cached?.executionName, providerIdentifier && toolName
        ? officialMcpExecutionName(providerIdentifier, toolName)
        : tool.name);
      const visibleName = isDirectMcp
        ? stringValue(cached?.name, providerToolNameForMcpExecutionName(executionName))
        : tool.name;
      if (!visibleName || seen.has(visibleName)) continue;
      seen.add(visibleName);
      const normalized = {
        name: visibleName,
        description: tool.description || "",
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
      };
      if (isDirectMcp) {
        normalized.providerIdentifier = providerIdentifier;
        normalized.toolName = toolName;
        normalized.executionName = executionName;
      }
      tools.push(normalized);
    }
  }
}

function resolveCachedMcpDispatchMetadata(tool, cachedByVisibleName) {
  if (!tool || typeof tool !== "object") return tool;
  const cached = resolveCachedMcpTool(tool, cachedByVisibleName);
  if (!cached) return normalizeMcpDispatchMetadata(tool);
  return {
    ...tool,
    name: cached.name,
    providerIdentifier: cached.providerIdentifier,
    toolName: cached.toolName || tool.toolName,
    executionName: cached.executionName,
  };
}

function normalizeMcpDispatchMetadata(tool) {
  if (typeof tool.providerIdentifier !== "string" || !tool.providerIdentifier) return tool;
  const name = typeof tool.name === "string" ? tool.name : typeof tool.canonicalName === "string" ? tool.canonicalName : "";
  const toolName = stringValue(tool.toolName, inferMcpToolName(name));
  const providerIdentifier = inferMcpProviderIdentifier(name, toolName, tool.providerIdentifier);
  if (!providerIdentifier || !toolName) return tool;
  const executionName = officialMcpExecutionName(providerIdentifier, toolName);
  return {
    ...tool,
    name: providerToolNameForMcpExecutionName(executionName),
    providerIdentifier,
    toolName,
    executionName,
  };
}

function cachedMcpToolMap(mcpToolsField) {
  const out = new Map();
  const groups = Array.isArray(mcpToolsField) ? mcpToolsField : mcpToolsField ? [mcpToolsField] : [];
  for (const group of groups) {
    const mcpTools = Array.isArray(group?.mcpTools) ? group.mcpTools : [];
    for (const tool of mcpTools) {
      for (const alias of mcpToolAliases(tool)) {
        if (alias && !out.has(alias)) out.set(alias, tool);
      }
    }
  }
  return out;
}

function resolveCachedMcpTool(tool, cachedByVisibleName) {
  for (const alias of mcpToolAliases(tool)) {
    const cached = cachedByVisibleName.get(alias);
    if (cached) return cached;
  }
  return undefined;
}

function mcpToolAliases(tool) {
  if (!tool || typeof tool !== "object") return [];
  const aliases = [];
  const name = tool.name || tool.canonicalName;
  if (typeof name === "string" && name) aliases.push(name);
  if (typeof tool.executionName === "string" && tool.executionName) aliases.push(tool.executionName);
  if (typeof tool.legacyName === "string" && tool.legacyName) aliases.push(tool.legacyName);
  const toolName = typeof tool.toolName === "string" && tool.toolName ? tool.toolName : inferMcpToolName(name);
  if (toolName) {
    const providerIdentifier = typeof tool.providerIdentifier === "string" && tool.providerIdentifier
      ? inferMcpProviderIdentifier(name, toolName, tool.providerIdentifier)
      : "";
    if (providerIdentifier) aliases.push(officialMcpExecutionName(providerIdentifier, toolName));
    if (typeof tool.providerName === "string" && tool.providerName) aliases.push(legacyProviderToolNameForMcp(tool.providerName, toolName));
  }
  return aliases;
}

function loadCursorMcpToolsFromCache(options = {}) {
  const config = typeof options === "string" ? { home: options } : options || {};
  const home = config.home || process.env.HOME || os.homedir();
  const root = path.join(home, ".cursor", "projects");
  const projectNames = cursorMcpCacheProjectNames(config.workspaceRoots);
  if (projectNames.length) return loadNamedCursorMcpProjects(root, projectNames);
  return loadMostRecentCursorMcpProject(root);
}

function normalizeWorkspaceRoots(workspaceRoots) {
  if (!Array.isArray(workspaceRoots)) return [];
  const out = [];
  const seen = new Set();
  for (const value of workspaceRoots) {
    if (typeof value !== "string" || !value) continue;
    const root = path.resolve(value);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function cursorMcpCacheProjectNames(workspaceRoots) {
  return normalizeWorkspaceRoots(workspaceRoots).map(cursorProjectNameForWorkspaceRoot);
}

function cursorProjectNameForWorkspaceRoot(workspaceRoot) {
  return path.resolve(workspaceRoot)
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const cursorMcpProjectCache = new Map();

function loadNamedCursorMcpProjects(projectsRoot, projectNames) {
  const groups = [];
  const seen = new Set();
  for (const projectName of projectNames) {
    if (!projectName || seen.has(projectName)) continue;
    seen.add(projectName);
    const mcpTools = loadCachedCursorMcpProjectTools(path.join(projectsRoot, projectName, "mcps"));
    if (mcpTools.length) groups.push({ mcpTools });
  }
  return groups;
}

function loadCachedCursorMcpProjectTools(mcpsDir) {
  const cached = cursorMcpProjectCache.get(mcpsDir);
  const signature = mcpProjectCacheSignature(mcpsDir, cached?.watchFiles);
  if (cached && cached.signature === signature) {
    cursorMcpProjectCache.delete(mcpsDir);
    cursorMcpProjectCache.set(mcpsDir, cached);
    return cached.mcpTools;
  }
  const watchFiles = [];
  const mcpTools = loadCursorMcpProjectTools(mcpsDir, watchFiles);
  cursorMcpProjectCache.set(mcpsDir, {
    signature: mcpProjectCacheSignature(mcpsDir, watchFiles),
    watchFiles,
    mcpTools,
  });
  trimCursorMcpProjectCache();
  return mcpTools;
}

function trimCursorMcpProjectCache() {
  while (cursorMcpProjectCache.size > DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES) {
    cursorMcpProjectCache.delete(cursorMcpProjectCache.keys().next().value);
  }
}

function mcpProjectCacheSignature(mcpsDir, watchFiles = []) {
  const parts = [statMtimeMsSafe(mcpsDir)];
  for (const file of watchFiles) {
    parts.push(file, statMtimeMsSafe(file));
  }
  return parts.join("|");
}

function statMtimeMsSafe(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function loadMostRecentCursorMcpProject(projectsRoot) {
  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projectDirs = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, entry.name);
    try {
      projectDirs.push({ projectDir, mtimeMs: fs.statSync(projectDir).mtimeMs });
    } catch {}
  }
  projectDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { projectDir, mtimeMs } of projectDirs) {
    const mcpTools = loadCachedCursorMcpProjectTools(path.join(projectDir, "mcps"));
    if (mcpTools.length) return [{ mtimeMs, mcpTools }];
  }
  return [];
}

function loadCursorMcpProjectTools(mcpsDir, watchFiles = []) {
  let serverEntries;
  try {
    serverEntries = fs.readdirSync(mcpsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const serverEntry of serverEntries) {
    if (!serverEntry.isDirectory()) continue;
    const serverDir = path.join(mcpsDir, serverEntry.name);
    watchFiles.push(serverDir);
    const metadataFile = path.join(serverDir, "SERVER_METADATA.json");
    const statusFile = path.join(serverDir, "STATUS.md");
    const toolsDir = path.join(serverDir, "tools");
    watchFiles.push(metadataFile, statusFile, toolsDir);
    const metadata = readJsonSafe(metadataFile);
    const providerIdentifier = stringValue(metadata?.serverIdentifier, serverEntry.name);
    const serverName = stringValue(metadata?.serverName, providerIdentifier);
    const seenToolNames = new Set();
    if (serverNeedsMcpAuth(statusFile)) {
      out.push(virtualMcpAuthTool(providerIdentifier, serverName));
      seenToolNames.add("mcp_auth");
    }
    let toolEntries;
    try {
      toolEntries = fs.readdirSync(toolsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const toolEntry of toolEntries) {
      if (!toolEntry.isFile() || !toolEntry.name.endsWith(".json")) continue;
      const toolFile = path.join(toolsDir, toolEntry.name);
      watchFiles.push(toolFile);
      const tool = readJsonSafe(toolFile);
      if (!tool || typeof tool.name !== "string" || !tool.name) continue;
      if (seenToolNames.has(tool.name)) continue;
      seenToolNames.add(tool.name);
      const executionName = officialMcpExecutionName(providerIdentifier, tool.name);
      const visibleName = providerToolNameForMcpExecutionName(executionName);
      out.push({
        name: visibleName,
        executionName,
        legacyName: legacyProviderToolNameForMcp(serverName, tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema || tool.arguments || { type: "object", properties: {} },
        providerIdentifier,
        providerName: serverName,
        toolName: tool.name,
      });
    }
  }
  return out;
}

function serverNeedsMcpAuth(statusFile) {
  const status = readTextSafe(statusFile);
  return /\bneeds authentication\b/i.test(status) && /\bmcp_auth\b/.test(status);
}

function virtualMcpAuthTool(providerIdentifier, serverName) {
  const executionName = officialMcpExecutionName(providerIdentifier, "mcp_auth");
  return {
    name: providerToolNameForMcpExecutionName(executionName),
    executionName,
    legacyName: legacyProviderToolNameForMcp(serverName, "mcp_auth"),
    description: `Authenticate MCP server ${providerIdentifier}. Call this tool with an empty arguments object when the server needs authentication.`,
    inputSchema: {
      type: "object",
      properties: {
        server_identifier: { type: "string", description: "Optional MCP server identifier override." },
        serverIdentifier: { type: "string", description: "Optional MCP server identifier override (camelCase)." },
      },
      additionalProperties: false,
    },
    providerIdentifier,
    providerName: serverName,
    toolName: "mcp_auth",
  };
}

function officialMcpExecutionName(serverIdentifier, toolName) {
  return `${serverIdentifier}-${toolName}`;
}

function providerToolNameForMcpExecutionName(name) {
  const normalized = String(valueOrMcp(name)).replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized.length <= 64) return normalized;
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 7);
  return normalized.slice(0, 57) + hash;
}

function legacyProviderToolNameForMcp(serverName, toolName) {
  const name = `${legacyProviderToolNamePart(serverName)}__${legacyProviderToolNamePart(toolName)}`;
  return name.length <= 128 ? name : name.slice(0, 128);
}

function legacyProviderToolNamePart(value) {
  const normalized = String(value || "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  return normalized.replace(/^_+|_+$/g, "") || "mcp";
}

function inferMcpToolName(name) {
  if (typeof name !== "string") return "";
  const separator = name.lastIndexOf("-");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function inferMcpProviderIdentifier(name, toolName, fallback = "") {
  const fallbackValue = stringValue(fallback);
  if (fallbackValue && typeof name === "string" && typeof toolName === "string" && toolName) {
    const fallbackExecutionName = officialMcpExecutionName(fallbackValue, toolName);
    if (name === fallbackExecutionName || name === providerToolNameForMcpExecutionName(fallbackExecutionName)) {
      return fallbackValue;
    }
  }
  if (typeof name === "string" && typeof toolName === "string" && toolName && name.endsWith(`-${toolName}`)) {
    const inferred = name.slice(0, -toolName.length - 1);
    if (inferred) return inferred;
  }
  return fallbackValue;
}

function valueOrMcp(value) {
  return value || "mcp";
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const KNOWN_CONVERSATION_ACTION_CASES = Object.freeze([
  "userMessageAction",
  "resumeAction",
  "cancelAction",
  "summarizeAction",
  "shellCommandAction",
  "startPlanAction",
  "executePlanAction",
  "asyncAskQuestionCompletionAction",
  "cancelSubagentAction",
  "backgroundTaskCompletionAction",
  "backgroundShellAction",
  "backgroundSubagentAction",
]);

function normalizeActionCase(value) {
  if (typeof value !== "string" || !value) return "";
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function snakeCaseActionCase(value) {
  if (typeof value !== "string" || !value) return "";
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function extractConversationAction(action) {
  if (!action || typeof action !== "object") return null;
  if (Array.isArray(action)) {
    for (const item of action) {
      const extracted = extractConversationAction(item);
      if (extracted) return extracted;
    }
    return null;
  }
  if (typeof action.case === "string" && action.case) {
    return {
      case: normalizeActionCase(action.case),
      value: action.value || null,
    };
  }
  if (action.action && typeof action.action === "object") {
    const nested = extractConversationAction(action.action);
    if (nested) return nested;
  }
  const rawOneofCase = typeof action.oneofKind === "string" && action.oneofKind
    ? action.oneofKind
    : typeof action.$case === "string" && action.$case
      ? action.$case
      : "";
  const normalizedOneofCase = normalizeActionCase(rawOneofCase);
  if (rawOneofCase && Object.prototype.hasOwnProperty.call(action, rawOneofCase)) {
    return {
      case: normalizedOneofCase || rawOneofCase,
      value: action[rawOneofCase] || null,
    };
  }
  if (normalizedOneofCase && Object.prototype.hasOwnProperty.call(action, normalizedOneofCase)) {
    return {
      case: normalizedOneofCase,
      value: action[normalizedOneofCase] || null,
    };
  }
  const snakeOneofCase = snakeCaseActionCase(normalizedOneofCase);
  if (snakeOneofCase && Object.prototype.hasOwnProperty.call(action, snakeOneofCase)) {
    return {
      case: normalizedOneofCase,
      value: action[snakeOneofCase] || null,
    };
  }
  for (const caseName of KNOWN_CONVERSATION_ACTION_CASES) {
    if (Object.prototype.hasOwnProperty.call(action, caseName)) {
      return {
        case: caseName,
        value: action[caseName] || null,
      };
    }
    const snakeCaseName = snakeCaseActionCase(caseName);
    if (snakeCaseName && Object.prototype.hasOwnProperty.call(action, snakeCaseName)) {
      return {
        case: caseName,
        value: action[snakeCaseName] || null,
      };
    }
  }
  return null;
}

function actionCaseForDebug(action) {
  return extractConversationAction(action)?.case || "";
}

function extractUserMessagesFromActions(actionValue) {
  const messages = [];
  const actions = Array.isArray(actionValue) ? actionValue : actionValue ? [actionValue] : [];
  for (const action of actions) {
    const rawUserMessages = extractActionUserMessages(action);
    const userMessages = Array.isArray(rawUserMessages)
      ? rawUserMessages
      : rawUserMessages
        ? [rawUserMessages]
        : [];
    for (const message of userMessages) {
      const content = extractActionUserMessageContent(message);
      if (!content) continue;
      messages.push({ role: "user", content });
    }
  }
  return collapseConsecutiveProviderMessages(messages);
}

function actionMessageHasNonTextContent(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(actionMessageHasNonTextContent);
  if (!value || typeof value !== "object") return false;
  const type = typeof value.type === "string" ? value.type : "";
  const imageUrl = value.image_url && typeof value.image_url === "object" ? value.image_url : {};
  const hasImageUrl = !!(
    (typeof imageUrl.url === "string" && imageUrl.url) ||
    (typeof value.image_url === "string" && value.image_url) ||
    (typeof value.imageUrl === "string" && value.imageUrl) ||
    (typeof value.url === "string" && value.url)
  );
  const source = value.source && typeof value.source === "object" ? value.source : {};
  const sourceType = typeof source.type === "string" ? source.type : "";
  const file = value.file && typeof value.file === "object" ? value.file : {};
  const hasFile = !!(
    (typeof file.file_id === "string" && file.file_id) ||
    (typeof file.filename === "string" && file.filename) ||
    (typeof value.file_id === "string" && value.file_id) ||
    (typeof value.fileId === "string" && value.fileId) ||
    (typeof value.filename === "string" && value.filename) ||
    file.file_data !== undefined ||
    value.file_data !== undefined ||
    value.fileData !== undefined
  );
  if (
    type === "image_url" ||
    type === "input_image" ||
    type === "image" ||
    type === "input_file" ||
    type === "file" ||
    type === "document" ||
    hasImageUrl ||
    hasFile ||
    sourceType
  ) {
    return true;
  }
  if (value.content !== undefined && actionMessageHasNonTextContent(value.content)) return true;
  if (value.value !== undefined && actionMessageHasNonTextContent(value.value)) return true;
  if (value.message !== undefined && actionMessageHasNonTextContent(value.message)) return true;
  return false;
}

function extractActionUserMessageStructuredContent(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return actionMessageHasNonTextContent(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.content) && actionMessageHasNonTextContent(value.content)) return value.content;
  if (Array.isArray(value.value) && actionMessageHasNonTextContent(value.value)) return value.value;
  if (Array.isArray(value.message) && actionMessageHasNonTextContent(value.message)) return value.message;
  return null;
}

function extractActionUserMessageContent(message) {
  const structured = extractActionUserMessageStructuredContent(message);
  if (structured) return structured;
  return extractActionUserMessageText(message);
}

function extractActionUserMessageText(message) {
  if (message === null || message === undefined) return "";
  if (typeof message === "string") return message;
  if (typeof message?.text === "string" && message.text) return message.text;
  const contentText = extractNestedActionText(message?.content);
  if (contentText) return contentText;
  const valueText = extractNestedActionText(message?.value);
  if (valueText) return valueText;
  return extractNestedActionText(message);
}

function extractNestedActionText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(extractNestedActionText).filter(Boolean);
    return parts.join("\n");
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string" && value.text) return extractNestedActionText(value.text);
  if (value.content !== undefined) {
    const contentText = extractNestedActionText(value.content);
    if (contentText) return contentText;
  }
  if (value.value !== undefined) {
    const valueText = extractNestedActionText(value.value);
    if (valueText) return valueText;
  }
  if (value.message !== undefined) {
    const messageText = extractNestedActionText(value.message);
    if (messageText) return messageText;
  }
  return "";
}

function providerMessageKey(message) {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function providerMessageSequenceEqual(left, right) {
  const leftMessages = Array.isArray(left) ? left : [];
  const rightMessages = Array.isArray(right) ? right : [];
  if (leftMessages.length !== rightMessages.length) return false;
  for (let index = 0; index < leftMessages.length; index += 1) {
    if (providerMessageKey(leftMessages[index]) !== providerMessageKey(rightMessages[index])) return false;
  }
  return true;
}

function collapseConsecutiveProviderMessages(messages) {
  const items = Array.isArray(messages) ? messages : [];
  if (items.length <= 1) return items;
  const collapsed = [items[0]];
  let previousKey = providerMessageKey(items[0]);
  for (let index = 1; index < items.length; index += 1) {
    const current = items[index];
    const currentKey = providerMessageKey(current);
    if (currentKey === previousKey) continue;
    collapsed.push(current);
    previousKey = currentKey;
  }
  return collapsed;
}

function arrayEndsWithSequence(values, suffix) {
  if (!Array.isArray(values) || !Array.isArray(suffix)) return false;
  if (!suffix.length) return true;
  if (suffix.length > values.length) return false;
  const start = values.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (values[start + index] !== suffix[index]) return false;
  }
  return true;
}

function largestMessageOverlap(previousKeys, nextKeys) {
  const max = Math.min(previousKeys.length, nextKeys.length);
  for (let size = max; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (previousKeys[previousKeys.length - size + index] !== nextKeys[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function appendProviderActionMessages(baseMessages, actionMessages) {
  const base = Array.isArray(baseMessages) ? baseMessages : [];
  const actions = Array.isArray(actionMessages) ? actionMessages : [];
  if (!actions.length) return base;
  if (!base.length) return actions;
  const baseKeys = base.map(providerMessageKey);
  const actionKeys = actions.map(providerMessageKey);
  if (arrayEndsWithSequence(baseKeys, actionKeys)) return base;
  if (base.length > actions.length) {
    let prefixMatches = true;
    for (let index = 0; index < actionKeys.length; index += 1) {
      if (baseKeys[index] !== actionKeys[index]) {
        prefixMatches = false;
        break;
      }
    }
    if (prefixMatches) return base;
  }
  const overlap = largestMessageOverlap(baseKeys, actionKeys);
  if (overlap > 0) return base.concat(actions.slice(overlap));
  return base.concat(actions);
}

function extractProviderMessages(request) {
  if (!request || typeof request !== "object") return [];
  const baseMessages = Array.isArray(request.messages)
    ? request.messages.filter((message) => message && typeof message === "object")
    : [];
  const runActions = extractRunActions(request);
  const actionMessages = extractUserMessagesFromActions(runActions);
  if (baseMessages.length && actionMessages.length) {
    return appendProviderActionMessages(baseMessages, actionMessages);
  }
  if (baseMessages.length) return baseMessages;
  if (actionMessages.length) return actionMessages;
  return extractPlanExecutionMessages(runActions, { request });
}

async function hydrateProviderInputFromRunRequest(request, options = {}) {
  if (!request || typeof request !== "object") return request;
  if (extractProviderMessages(request).length > 0) return request;
  const message = await extractPlanExecutionMessageFromFiles(extractRunActions(request), {
    ...options,
    request,
  });
  if (!message) return request;
  return {
    ...request,
    messages: [message],
  };
}

function hasProviderInputHint(request) {
  if (!request || typeof request !== "object") return false;
  if (hasProviderInput(request)) return true;
  return hasPlanExecutionInputHint(extractRunActions(request));
}

function hasPlanExecutionInputHint(actionValue) {
  const actions = Array.isArray(actionValue) ? actionValue : actionValue ? [actionValue] : [];
  for (const action of actions) {
    const executePlan = extractExecutePlanAction(action);
    if (!executePlan) continue;
    if (extractPlanExecutionText(executePlan)) return true;
    if (extractPlanExecutionPathHint(executePlan)) return true;
  }
  return false;
}

function extractPlanExecutionMessages(actionValue, options = {}) {
  const messages = [];
  const actions = Array.isArray(actionValue) ? actionValue : actionValue ? [actionValue] : [];
  for (const action of actions) {
    const executePlan = extractExecutePlanAction(action);
    const planFileContent = extractPlanExecutionText(executePlan);
    if (!planFileContent) continue;
    messages.push(planExecutionProviderMessage(planFileContent, options));
  }
  return messages;
}

async function extractPlanExecutionMessageFromFiles(actionValue, options = {}) {
  const actions = Array.isArray(actionValue) ? actionValue : actionValue ? [actionValue] : [];
  for (const action of actions) {
    const executePlan = extractExecutePlanAction(action);
    if (!executePlan) continue;
    const planFileContent = extractPlanExecutionText(executePlan);
    if (planFileContent) return planExecutionProviderMessage(planFileContent, options);
    const resolvedPath = resolvePlanExecutionPath(executePlan, options.workspaceRoots);
    if (!resolvedPath) continue;
    const text = await readTextFileAtPath(resolvedPath, options.readFile);
    if (!text) continue;
    return planExecutionProviderMessage(text, options);
  }
  return null;
}

function planExecutionProviderMessage(planFileContent, options = {}) {
  const request = options.request;
  return buildPlanExecutionProviderMessage(planFileContent, {
    isCloud: isCloudPlanExecutionRequest(request),
    planName: options.planName,
  });
}

function extractPlanExecutionText(executePlan) {
  if (!executePlan || typeof executePlan !== "object") return "";
  const embeddedPlan = executePlan.plan && typeof executePlan.plan === "object"
    ? stringValue(executePlan.plan.content, stringValue(executePlan.plan.text))
    : "";
  return stringValue(
    executePlan.planFileContent,
    stringValue(
      executePlan.plan_file_content,
      stringValue(
        executePlan.plan,
        stringValue(executePlan.content, stringValue(executePlan.text, embeddedPlan)),
      ),
    ),
  );
}

function extractPlanExecutionPathHint(executePlan) {
  if (!executePlan || typeof executePlan !== "object") return "";
  return stringValue(
    executePlan.planFilePath,
    stringValue(
      executePlan.plan_file_path,
      stringValue(executePlan.planFileUri, stringValue(executePlan.plan_file_uri)),
    ),
  );
}

function resolvePlanExecutionPath(executePlan, workspaceRoots) {
  if (!executePlan || typeof executePlan !== "object") return "";
  const explicitPath = stringValue(executePlan.planFilePath, stringValue(executePlan.plan_file_path));
  if (explicitPath) return resolveToolPathInWorkspace(explicitPath, workspaceRoots);
  const explicitUri = stringValue(executePlan.planFileUri, stringValue(executePlan.plan_file_uri));
  if (!explicitUri) return "";
  const uriPath = resolvePlanFileUri(explicitUri);
  if (uriPath) return uriPath;
  return resolveToolPathInWorkspace(explicitUri, workspaceRoots);
}

function resolvePlanFileUri(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return path.resolve(fileURLToPath(url));
  } catch {}
  return "";
}

async function readTextFileAtPath(resolvedPath, readFile) {
  if (typeof resolvedPath !== "string" || !resolvedPath) return "";
  if (typeof readFile === "function") {
    try {
      const read = await readFile(resolvedPath);
      if (typeof read?.text === "string") return normalizeReadTextContent(read.text);
      return normalizeReadTextContent(readFileBuffer(read, resolvedPath).toString("utf8"));
    } catch {}
  }
  try {
    return normalizeReadTextContent(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    return "";
  }
}

function extractActionUserMessages(action) {
  const extracted = extractConversationAction(action);
  if (!extracted || extracted.case !== "userMessageAction") return null;
  return extracted.value?.userMessage || null;
}

function extractExecutePlanAction(action) {
  const extracted = extractConversationAction(action);
  if (!extracted || extracted.case !== "executePlanAction") return null;
  return extracted.value || null;
}

function extractRunActions(request) {
  if (!request || typeof request !== "object") return [];
  const out = [];
  const append = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    out.push(value);
  };
  append(request.action);
  append(request.actions);
  append(request.conversationAction);
  append(request.conversationActions);
  append(request.conversationActionOverride);
  return out;
}

function copyForwardHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function readJson(request, maxBytes) {
  const buffer = await readBuffer(request, maxBytes);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString("utf8"));
}

function readBuffer(request, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    const rejectTooLarge = () => {
      rejected = true;
      reject(httpError(413, `Request body exceeds ${maxBytes} bytes`, { receivedBytes: total, maxBytes }));
    };
    request.on("data", (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejectTooLarge();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

async function readResponseText(response, maxBytes = DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES) {
  if (!response?.body) {
    const text = typeof response?.text === "function" ? await response.text() : "";
    const receivedBytes = Buffer.byteLength(text, "utf8");
    if (receivedBytes > maxBytes) {
      throw httpError(502, `Upstream response exceeds ${maxBytes} bytes`, { receivedBytes, maxBytes });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw httpError(502, `Upstream response exceeds ${maxBytes} bytes`, { receivedBytes: total, maxBytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function pipeResponseBody(body, response) {
  const reader = body.getReader();
  const streamState = responseStreamState(response);
  const onClose = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };
  response.once?.("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || streamState.closed) break;
      if (!await writeResponseChunk(response, Buffer.from(value), streamState)) break;
    }
  } finally {
    response.off?.("close", onClose);
    streamState.dispose();
    try {
      reader.releaseLock?.();
    } catch {}
  }
  return !streamState.closed;
}

function responseStreamState(response) {
  let resolveClosed;
  const state = {
    closed: false,
    closedPromise: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
    onClose() {
      state.closed = true;
      resolveClosed(STREAM_CLOSED);
    },
    dispose() {
      response.off?.("close", state.onClose);
    },
  };
  response.once?.("close", state.onClose);
  return state;
}

async function writeNdjsonLine(response, value, state = responseStreamState(response)) {
  return writeResponseChunk(response, `${JSON.stringify(value)}\n`, state);
}

function isProviderRunAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  const message = typeof error.message === "string" ? error.message : "";
  return message === "aborted" ||
    message === "This operation was aborted" ||
    message === "response-closed";
}

function formatProviderRunFailureMessage(error) {
  const message = error && error.message ? error.message : String(error);
  if (message === "terminated") {
    return "upstream stream closed unexpectedly (provider/proxy dropped the connection; retry the turn)";
  }
  return message;
}

async function writeByokRunFailure(response, state, error) {
  const message = `BYOK provider failed: ${formatProviderRunFailureMessage(error)}`;
  await writeNdjsonLine(response, { type: "text_delta", text: message }, state);
  await writeNdjsonLine(response, {
    type: "done",
    stopReason: "error",
    usage: { inputTokens: 0, outputTokens: 0 },
  }, state);
}

async function writeByokRunCancelled(response, state) {
  await writeNdjsonLine(response, {
    type: "done",
    stopReason: "cancelled",
    usage: { inputTokens: 0, outputTokens: 0 },
  }, state);
}

async function writeResponseChunk(response, chunk, state = responseStreamState(response)) {
  if (state.closed || response.destroyed || response.writableEnded) {
    state.closed = true;
    return false;
  }
  if (response.write(chunk)) return !state.closed;
  if (state.closed || response.destroyed || response.writableEnded) {
    state.closed = true;
    return false;
  }
  await Promise.race([once(response, "drain"), once(response, "close")]);
  return !state.closed && !response.destroyed && !response.writableEnded;
}

const STREAM_CLOSED = Symbol("stream closed");

function httpError(statusCode, message, fields = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, fields);
  return error;
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendText(response, value, status = 200) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(value);
}

function summarizeExecResult(result) {
  const message = result?.message;
  const value = message?.value;
  const execResult = value?.result;
  const resultValue = execResult?.value;
  const output = resultValue?.output;
  const errorText = typeof resultValue?.error === "string"
    ? resultValue.error
    : typeof resultValue?.message === "string"
      ? resultValue.message
      : undefined;
  const shellId = stringValue(resultValue?.shellId, stringValue(resultValue?.shell_id));
  const taskId = stringValue(resultValue?.taskId, stringValue(resultValue?.task_id));
  return {
    id: result?.id,
    execId: result?.execId,
    mappedToolCallId: result?._byokToolCallId,
    messageCase: message?.case,
    resultCase: execResult?.case,
    shellEventCase: message?.case === "shellStream" ? value?.event?.case : undefined,
    outputCase: output?.case,
    stdoutLength: typeof resultValue?.stdout === "string" ? resultValue.stdout.length : undefined,
    stderrLength: typeof resultValue?.stderr === "string" ? resultValue.stderr.length : undefined,
    exitCode: resultValue?.exitCode,
    ...(shellId ? { shellId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(Number.isFinite(resultValue?.msToWait) ? { msToWait: resultValue.msToWait } : {}),
    ...(typeof resultValue?.backgroundReason === "string"
      ? { backgroundReasonPreview: resultValue.backgroundReason.slice(0, 120) }
      : {}),
    contentLength: typeof output?.value === "string"
      ? output.value.length
      : typeof output?.content === "string"
        ? output.content.length
        : typeof resultValue?.content === "string"
          ? resultValue.content.length
        : undefined,
    errorPreview: errorText ? errorText.slice(0, 240) : undefined,
    ...summarizeSearchResult(resultValue),
    ...summarizeMcpResult(message?.case, resultValue),
    ...summarizeRawMcpShape(message?.case, value),
  };
}

function summarizeInteractionLocalToolResult(result) {
  const message = result?.message;
  if (message?.case !== "byokInteractionToolResult") return {};
  const value = message.value || {};
  const toolResult = value.toolResult?.result;
  const resultValue = toolResult?.value || {};
  const answers = arrayValue(resultValue.answers);
  const firstAnswer = answers[0] || {};
  const selected = arrayValue(firstAnswer.selectedOptionIds ?? firstAnswer.selected_option_ids).map(String);
  return {
    interactionToolName: value.toolName,
    interactionToolResultCase: toolResult?.case,
    interactionToolAnswerCount: answers.length || undefined,
    interactionToolFirstQuestionId: typeof firstAnswer.questionId === "string"
      ? firstAnswer.questionId
      : typeof firstAnswer.question_id === "string"
        ? firstAnswer.question_id
        : undefined,
    interactionToolFirstSelectedOptionIds: selected.length ? selected.slice(0, 6) : undefined,
  };
}

function summarizeSearchResult(value) {
  const workspaceResults = value?.workspaceResults;
  if (!workspaceResults || typeof workspaceResults !== "object" || Array.isArray(workspaceResults)) return {};
  let fileCount = 0;
  let matchCount = 0;
  for (const workspaceResult of Object.values(workspaceResults)) {
    const union = unwrapResultUnion(workspaceResult);
    switch (union.case) {
      case "content":
        for (const fileMatch of arrayValue(union.value?.matches)) {
          fileCount++;
          matchCount += arrayValue(fileMatch?.matches).length;
        }
        break;
      case "files":
        fileCount += arrayValue(union.value?.files).length;
        break;
      case "count":
        fileCount += numberValue(union.value?.totalFiles);
        matchCount += numberValue(union.value?.totalMatches);
        break;
      default:
        break;
    }
  }
  return {
    searchWorkspaceCount: Object.keys(workspaceResults).length,
    searchFileCount: fileCount,
    searchMatchCount: matchCount,
  };
}

function summarizeMcpResult(messageCase, value) {
  if (messageCase === "listMcpResourcesExecResult") {
    return { mcpResourceCount: arrayValue(value?.resources).length };
  }
  if (messageCase === "mcpResult") {
    return { mcpContentBlockCount: mcpContentBlocks(value).length };
  }
  if (messageCase === "readMcpResourceExecResult") {
    return { mcpContentCase: value?.content?.case };
  }
  return {};
}

function mcpContentBlocks(value) {
  const direct = arrayValue(value?.content);
  if (direct.length) return direct;
  const nested = arrayValue(value?.result?.value?.content);
  if (nested.length) return nested;
  return arrayValue(value?.result?.content);
}

function summarizeRawMcpShape(messageCase, value) {
  if (messageCase !== "mcpResult") return {};
  const rawKeys = shallowKeys(value);
  const rawNestedKeys = {};
  for (const key of rawKeys || []) {
    const nested = value?.[key];
    if (nested && typeof nested === "object") rawNestedKeys[key] = shallowKeys(nested);
  }
  return {
    mcpRawKeys: rawKeys,
    mcpRawNestedKeys: Object.keys(rawNestedKeys).length ? rawNestedKeys : undefined,
  };
}

function unwrapResultUnion(value) {
  if (value?.result?.case) return { case: value.result.case, value: value.result.value || {} };
  for (const caseName of ["content", "files", "count"]) {
    if (value?.[caseName] !== undefined) return { case: caseName, value: value[caseName] || {} };
  }
  return { case: undefined, value: {} };
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function summarizeShellStreamShape(result) {
  if (result?.message?.case !== "shellStream") return {};
  const value = result.message.value;
  const event = value?.event;
  if (event?.case) return {};
  for (const flatCase of ["start", "stdout", "stderr", "exit", "rejected", "permissionDenied", "backgrounded"]) {
    if (value && Object.prototype.hasOwnProperty.call(value, flatCase)) {
      const flatValue = value[flatCase];
      return {
        shellValueKeys: shallowKeys(value),
        shellFlatEventCase: flatCase,
        shellFlatEventKeys: shallowKeys(flatValue),
        shellFlatShellId: flatValue?.shellId ?? flatValue?.shell_id,
        shellFlatTaskId: flatValue?.taskId ?? flatValue?.task_id,
        shellFlatMsToWait: flatValue?.msToWait,
      };
    }
  }
  return {
    shellValueKeys: shallowKeys(value),
    shellEventKeys: shallowKeys(event),
    shellEventValueKeys: shallowKeys(event?.value),
  };
}

function shallowKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).slice(0, 12) : undefined;
}

function normalizeExecClientResult(result) {
  if (!result || typeof result !== "object") return result;
  if (result.message?.case) {
    const messageCase = normalizeExecResultMessageCase(result.message.case, result.message.value);
    return {
      ...result,
      ...(result._byokDirectTool ? { _byokDirectTool: true } : {}),
      message: {
        case: messageCase,
        value: normalizeExecResultEnvelope(messageCase, result.message.value),
      },
    };
  }
  const cases = [
    "shellResult",
    "shellStream",
    "writeResult",
    "deleteResult",
    "grepResult",
    "readResult",
    "redactedReadResult",
    "lsResult",
    "diagnosticsResult",
    "requestContextResult",
    "mcpResult",
    "listMcpResourcesExecResult",
    "readMcpResourceExecResult",
    "mcpAuthResult",
    "fetchResult",
    "recordScreenResult",
    "computerUseResult",
    "writeShellStdinResult",
    "subagentAwaitResult",
    "awaitResult",
    "todoWriteResult",
    "editResult",
    "unsupportedToolResult",
  ];
  for (const caseName of cases) {
    if (result[caseName] !== undefined) {
      const messageCase = normalizeExecResultMessageCase(caseName, result[caseName]);
      return {
        ...result,
        message: {
          case: messageCase,
          value: normalizeExecResultEnvelope(messageCase, result[caseName]),
        },
      };
    }
  }
  return result;
}

function normalizeExecResultMessageCase(caseName, value) {
  if (caseName === "redactedReadResult") return "readResult";
  if (caseName === "awaitResult") return "subagentAwaitResult";
  if (caseName === "shellStream" && isResultEnvelope(value)) return "shellResult";
  return caseName;
}

function completedExecResult(sessions, requestId, toolCallId) {
  if (typeof sessions?.get !== "function") return null;
  return sessions.get(requestId)?.completedExecResultsByToolCallId?.get(toolCallId) || null;
}

function isResultEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  return value.result !== undefined ||
    value.success !== undefined ||
    value.error !== undefined ||
    value.rejected !== undefined ||
    value.permissionDenied !== undefined ||
    value.failure !== undefined ||
    value.spawnError !== undefined;
}

function normalizeToolResultTimeout(timeoutMs, toolName, toolArguments) {
  if (Number.isInteger(timeoutMs) && timeoutMs >= 0) return timeoutMs;
  if (toolName === "Shell") return shellToolResultTimeout(toolArguments);
  if (isMcpAuthToolName(toolName) || isInteractionBridgeTool(toolName) || isClientInteractionTool(toolName)) {
    return LONG_PROVIDER_TOOL_RESULT_TIMEOUT_MS;
  }
  return DEFAULT_PROVIDER_TOOL_RESULT_TIMEOUT_MS;
}

function shellToolResultTimeout(toolArguments) {
  const args = parseToolArguments(toolArguments);
  const requested = normalizeInteger(args.block_until_ms ?? args.blockUntilMs ?? args.timeout);
  if (requested === undefined) return DEFAULT_PROVIDER_TOOL_RESULT_TIMEOUT_MS;
  if (requested < 0) return DEFAULT_PROVIDER_TOOL_RESULT_TIMEOUT_MS;
  return Math.min(Math.max(requested + 5000, DEFAULT_PROVIDER_TOOL_RESULT_TIMEOUT_MS), LONG_PROVIDER_TOOL_RESULT_TIMEOUT_MS);
}

function parseToolArguments(args) {
  if (!args || typeof args !== "string") return args && typeof args === "object" ? args : {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeInteger(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

async function buildDirectReadExecResult(toolCallId, resolvedPath, args, readFile, options = {}) {
  try {
    const statWindow = await buildDirectLargeWholeFileWindow(resolvedPath, args, options, readFile);
    if (statWindow) return directReadSuccessResult(toolCallId, resolvedPath, statWindow.readWindow, statWindow.fileSize, options);
    const read = readFile ? await readFile(resolvedPath) : null;
    const text = typeof read?.text === "string" ? read.text : null;
    const buffer = text === null ? readFileBuffer(read, resolvedPath) : null;
    const readWindow = text !== null
      ? buildReadTextWindow(text, Number.isInteger(read?.totalLines) ? read.totalLines : undefined, args, options)
      : buildReadBufferWindow(buffer, args, options);
    const fileSize = Number.isFinite(read?.fileSize)
      ? read.fileSize
      : text !== null
        ? Buffer.byteLength(text, "utf8")
        : buffer.byteLength;
    return directReadSuccessResult(toolCallId, resolvedPath, readWindow, fileSize, options);
  } catch (error) {
    return {
      execId: toolCallId,
      _byokToolCallId: toolCallId,
      _byokDirectTool: true,
      message: {
        case: "readResult",
        value: {
          result: directReadErrorResult(resolvedPath, error),
        },
      },
    };
  }
}

function directReadSuccessResult(toolCallId, resolvedPath, readWindow, fileSize, options = {}) {
  const finalizedReadWindow = finalizeDirectReadWindow(readWindow, resolvedPath, options);
  return {
    execId: toolCallId,
    _byokToolCallId: toolCallId,
    _byokDirectTool: true,
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: cleanUndefined({
            path: resolvedPath,
            output: finalizedReadWindow.exceededLimit ? undefined : { case: "content", value: finalizedReadWindow.content },
            exceededLimit: finalizedReadWindow.exceededLimit || undefined,
            exceededLimitReason: finalizedReadWindow.exceededLimitReason,
            providerVisibleChars: finalizedReadWindow.providerVisibleChars,
            totalLines: finalizedReadWindow.totalLines,
            fileSize,
            truncated: finalizedReadWindow.truncated,
            rangeApplied: finalizedReadWindow.rangeApplied,
            readRange: finalizedReadWindow.readRange,
          }),
        },
      },
    },
  };
}

function finalizeDirectReadWindow(readWindow, resolvedPath, options = {}) {
  if (!readWindow || readWindow.exceededLimit || options.allowLargeRead) return readWindow;
  const providerVisibleChars = estimateDirectReadProviderVisibleChars(resolvedPath, readWindow);
  if (providerVisibleChars <= DEFAULT_DIRECT_READ_PROVIDER_VISIBLE_MAX_CHARS) return readWindow;
  return {
    ...readWindow,
    exceededLimit: true,
    exceededLimitReason: "provider_visible_chars",
    providerVisibleChars,
    truncated: true,
  };
}

function estimateDirectReadProviderVisibleChars(resolvedPath, readWindow) {
  const content = typeof readWindow?.content === "string" ? readWindow.content : "";
  const lineRangeText = directReadProviderVisibleLineRange(readWindow, content);
  const headerLength = `File: ${resolvedPath}\nLines: ${lineRangeText}\n`.length;
  if (content.length === 0) return headerLength + "File is empty.".length;
  if (looksLikeCursorLineNumberedContent(content)) return headerLength + content.length;
  const visibleLineCount = directReadVisibleLineCount(readWindow, content);
  return headerLength + content.length + numberedLinePrefixChars(readWindow?.readRange?.startLine, visibleLineCount);
}

function directReadProviderVisibleLineRange(readWindow, content) {
  const startLine = normalizeInteger(readWindow?.readRange?.startLine) || 1;
  const endLine = normalizeInteger(readWindow?.readRange?.endLine);
  if (endLine !== undefined && endLine >= startLine) return `${startLine}-${endLine}`;
  const visibleLineCount = directReadVisibleLineCount(readWindow, content);
  return visibleLineCount > 0 ? `${startLine}-${startLine + visibleLineCount - 1}` : String(startLine);
}

function directReadVisibleLineCount(readWindow, content) {
  if (content.length === 0) return 0;
  const startLine = normalizeInteger(readWindow?.readRange?.startLine);
  const endLine = normalizeInteger(readWindow?.readRange?.endLine);
  if (startLine !== undefined && endLine !== undefined && endLine >= startLine) {
    return endLine - startLine + 1;
  }
  const totalLines = normalizeInteger(readWindow?.totalLines);
  if (readWindow?.rangeApplied === false && totalLines !== undefined && totalLines > 0) return totalLines;
  const lines = content.split("\n");
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function looksLikeCursorLineNumberedContent(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) continue;
    return /^\s*\d+\|/.test(line);
  }
  return false;
}

function numberedLinePrefixChars(startLineValue, lineCount) {
  if (!Number.isInteger(lineCount) || lineCount <= 0) return 0;
  const startLine = normalizeInteger(startLineValue) || 1;
  let total = 0;
  for (let index = 0; index < lineCount; index++) {
    total += Math.max(6, String(startLine + index).length) + 1;
  }
  return total;
}

async function buildDirectLargeWholeFileWindow(resolvedPath, args, options, readFile) {
  if (options.allowLargeRead) return null;
  if (normalizeInteger(args.offset) !== undefined || normalizeInteger(args.limit) !== undefined) return null;
  const stat = await directReadStat(resolvedPath, readFile);
  if (!stat || stat.isFile === false) return null;
  if (!Number.isFinite(stat.fileSize) || stat.fileSize <= DEFAULT_DIRECT_READ_INLINE_MAX_BYTES) return null;
  return {
    fileSize: stat.fileSize,
    readWindow: buildWholeReadTextWindow("", stat.totalLines, options, true),
  };
}

async function directReadStat(resolvedPath, readFile) {
  if (typeof readFile?.stat === "function") return readFile.stat(resolvedPath);
  const stat = fs.statSync(resolvedPath);
  return {
    fileSize: stat.size,
    isFile: stat.isFile(),
  };
}

function readFileBuffer(read, resolvedPath) {
  if (Buffer.isBuffer(read)) return read;
  if (ArrayBuffer.isView(read)) return Buffer.from(read.buffer, read.byteOffset, read.byteLength);
  if (read instanceof ArrayBuffer) return Buffer.from(read);
  const value = read?.buffer;
  if (value === undefined || value === null) return fs.readFileSync(resolvedPath);
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

function buildReadBufferWindow(buffer, args, options = {}) {
  const requestedOffset = normalizeInteger(args.offset);
  const requestedLimit = normalizeInteger(args.limit);
  const hasRange = requestedOffset !== undefined || requestedLimit !== undefined;
  if (hasRange && buffer.length > 0) {
    const startLineArg = requestedOffset ?? 1;
    if (startLineArg >= 0 && (requestedLimit === undefined || requestedLimit >= 0)) {
      const readWindow = collectPositiveReadBufferWindow(buffer, Math.max(0, startLineArg - 1), requestedLimit);
      if (readWindow.totalLines > 0 && readWindow.startIndex < readWindow.totalLines) {
        return buildSelectedReadWindow(readWindow.selectedLines, readWindow.startIndex, readWindow.totalLines, options);
      }
      return buildWholeReadBufferWindow(buffer, readWindow.totalLines, options);
    }
  }

  const totalLines = countReadBufferLines(buffer);
  if (!hasRange || buffer.length === 0 || totalLines === 0) {
    return buildWholeReadBufferWindow(buffer, totalLines, options);
  }

  const readRange = cursorReadRange(totalLines, requestedOffset, requestedLimit);
  if (!readRange) {
    return buildWholeReadBufferWindow(buffer, totalLines, options);
  }

  const selectedLines = collectReadBufferLines(buffer, readRange.startIndex, readRange.endIndex);
  return buildSelectedReadWindow(selectedLines, readRange.startIndex, totalLines, options);
}

function buildReadTextWindow(text, knownTotalLines, args, options = {}) {
  const normalizedText = normalizeReadTextContent(text);
  const totalLines = Number.isInteger(knownTotalLines) && knownTotalLines >= 0
    ? knownTotalLines
    : countReadTextLines(normalizedText);
  const requestedOffset = normalizeInteger(args.offset);
  const requestedLimit = normalizeInteger(args.limit);
  const hasRange = requestedOffset !== undefined || requestedLimit !== undefined;
  if (!hasRange || normalizedText === "" || totalLines === 0) {
    return buildWholeReadTextWindow(normalizedText, totalLines, options);
  }
  const readRange = cursorReadRange(totalLines, requestedOffset, requestedLimit);
  if (!readRange) {
    return buildWholeReadTextWindow(normalizedText, totalLines, options);
  }
  const selectedLines = collectReadTextLines(normalizedText, readRange.startIndex, readRange.endIndex);
  return buildSelectedReadWindow(selectedLines, readRange.startIndex, totalLines, options);
}

function buildSelectedReadWindow(selectedLines, startIndex, totalLines, options) {
  const content = selectedLines.join("\n");
  const truncated = !options.allowLargeRead && content.length > DEFAULT_DIRECT_READ_TRUNCATE_CHARS;
  const returnedContent = truncated ? content.slice(0, DEFAULT_DIRECT_READ_TRUNCATE_CHARS) : content;
  const startLine = startIndex + 1;
  return {
    content: returnedContent,
    exceededLimit: false,
    truncated,
    rangeApplied: true,
    totalLines,
    readRange: selectedLines.length ? { startLine, endLine: startLine + selectedLines.length - 1 } : { startLine },
  };
}

function buildWholeReadBufferWindow(buffer, totalLines, options) {
  const exceededLimit = !options.allowLargeRead && buffer.byteLength > DEFAULT_DIRECT_READ_INLINE_MAX_BYTES;
  const content = exceededLimit ? "" : normalizeReadTextContent(buffer.toString("utf8"));
  return buildWholeReadTextWindow(content, totalLines, options, exceededLimit);
}

function buildWholeReadTextWindow(content, totalLines, options, forcedExceededLimit = false) {
  const exceededLimit = forcedExceededLimit || (!options.allowLargeRead && Buffer.byteLength(content, "utf8") > DEFAULT_DIRECT_READ_INLINE_MAX_BYTES);
  const truncated = exceededLimit || (!options.allowLargeRead && content.length > DEFAULT_DIRECT_READ_TRUNCATE_CHARS);
  const returnedContent = truncated && !exceededLimit ? content.slice(0, DEFAULT_DIRECT_READ_TRUNCATE_CHARS) : content;
  return {
    content: returnedContent,
    exceededLimit,
    truncated,
    rangeApplied: false,
    totalLines,
    readRange: totalLines > 0 ? { startLine: 1, endLine: totalLines } : { startLine: 1 },
  };
}

function cursorReadRange(totalLines, requestedOffset, requestedLimit) {
  const startLineArg = requestedOffset ?? 1;
  const lineCount = requestedLimit ?? (startLineArg < 0 ? Math.abs(startLineArg) : totalLines);
  const startIndex = startLineArg < 0
    ? Math.max(0, totalLines + startLineArg)
    : Math.max(0, startLineArg - 1);
  if (startIndex >= totalLines) return null;
  return {
    startIndex,
    endIndex: normalizeCursorSliceEnd(Math.min(totalLines, startIndex + lineCount), totalLines),
  };
}

function normalizeCursorSliceEnd(endIndex, totalLines) {
  return endIndex < 0 ? Math.max(0, totalLines + endIndex) : Math.min(totalLines, endIndex);
}

function countReadBufferLines(buffer) {
  if (buffer.length === 0) return 1;
  let totalLines = 0;
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index];
    if (byte !== 10 && byte !== 13) continue;
    totalLines++;
    if (byte === 13 && index + 1 < buffer.length && buffer[index + 1] === 10) index++;
  }
  return totalLines + 1;
}

function countReadTextLines(text) {
  if (text.length === 0) return 1;
  let totalLines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) totalLines++;
  }
  return totalLines;
}

function collectPositiveReadBufferWindow(buffer, startIndex, limit) {
  const lines = [];
  let totalLines = 0;
  let lineStart = 0;
  const maxSelectedLines = limit === undefined ? Infinity : limit;
  function emitLine(start, end) {
    if (totalLines >= startIndex && lines.length < maxSelectedLines) {
      lines.push(buffer.toString("utf8", start, end));
    }
    totalLines++;
  }
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index];
    if (byte !== 10 && byte !== 13) continue;
    emitLine(lineStart, index);
    if (byte === 13 && index + 1 < buffer.length && buffer[index + 1] === 10) index++;
    lineStart = index + 1;
  }
  emitLine(lineStart, buffer.length);
  return { startIndex, selectedLines: lines, totalLines };
}

function collectReadBufferLines(buffer, startLineIndex, endLineIndex) {
  if (endLineIndex <= startLineIndex) return [];
  const lines = [];
  let totalLines = 0;
  let lineStart = 0;
  function emitLine(start, end) {
    if (totalLines >= startLineIndex && totalLines < endLineIndex) {
      lines.push(buffer.toString("utf8", start, end));
    }
    totalLines++;
  }
  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index];
    if (byte !== 10 && byte !== 13) continue;
    emitLine(lineStart, index);
    if (totalLines >= endLineIndex) return lines;
    if (byte === 13 && index + 1 < buffer.length && buffer[index + 1] === 10) index++;
    lineStart = index + 1;
  }
  if (buffer.length > 0) emitLine(lineStart, buffer.length);
  return lines;
}

function collectReadTextLines(text, startLineIndex, endLineIndex) {
  if (endLineIndex <= startLineIndex) return [];
  const lines = [];
  let totalLines = 0;
  let lineStart = 0;
  function emitLine(end) {
    if (totalLines >= startLineIndex && totalLines < endLineIndex) {
      lines.push(text.slice(lineStart, end));
    }
    totalLines++;
  }
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    emitLine(index);
    lineStart = index + 1;
    if (totalLines >= endLineIndex) return lines;
  }
  if (text.length > 0) emitLine(text.length);
  return lines;
}

function normalizeReadTextContent(text) {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n|\r/g, "\n");
}

function directReadErrorResult(resolvedPath, error) {
  switch (error?.code) {
    case "ENOENT":
      return { case: "fileNotFound", value: { path: resolvedPath } };
    case "EACCES":
    case "EPERM":
      return { case: "permissionDenied", value: { path: resolvedPath, message: error.message } };
    case "EISDIR":
      return { case: "invalidFile", value: { path: resolvedPath, message: error.message } };
    default:
      return { case: "error", value: { error: error?.message || String(error) } };
  }
}

function pathIsWithinWorkspaceRoots(targetPath, workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  for (const root of roots) {
    const relative = path.relative(root, targetPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
  }
  return false;
}

function resolveToolPathInWorkspace(targetPath, workspaceRoots) {
  if (path.isAbsolute(targetPath)) return path.resolve(targetPath);
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  for (const root of roots) {
    const candidate = path.resolve(root, targetPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (roots.length) return path.resolve(roots[0], targetPath);
  return path.resolve(targetPath);
}

function cleanUndefined(value) {
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function toolTimeoutResult(toolCallId, toolName) {
  const messageCase = resultCaseForToolName(toolName);
  return {
    execId: toolCallId,
    _byokToolCallId: toolCallId,
    message: {
      case: messageCase,
      value: {
        result: {
          case: "error",
          value: { error: `Timed out waiting for Cursor ${toolName || "tool"} result ${toolCallId}` },
        },
      },
    },
  };
}

function resultCaseForToolName(toolName) {
  switch (toolName) {
    case "Shell":
      return "shellResult";
    case "Write":
      return "writeResult";
    case "Edit":
    case "ApplyPatch":
    case "EditNotebook":
      return "editResult";
    case "Delete":
      return "deleteResult";
    case "Grep":
    case "Glob":
      return "grepResult";
    case "Read":
    case "ReadFile":
      return "readResult";
    case "ReadLints":
      return "diagnosticsResult";
    case "CallMcpTool":
      return "mcpResult";
    case "ListMcpResources":
      return "listMcpResourcesExecResult";
    case "FetchMcpResource":
      return "readMcpResourceExecResult";
    case "mcp_auth":
      return "mcpAuthResult";
    case "WebFetch":
      return "fetchResult";
    case "LS":
      return "lsResult";
    case "WriteShellStdin":
      return "writeShellStdinResult";
    case "AwaitShell":
      return "subagentAwaitResult";
    case "RecordScreen":
      return "recordScreenResult";
    case "ComputerUse":
      return "computerUseResult";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "todoWriteResult";
    default:
      return "requestContextResult";
  }
}

function normalizeExecResultEnvelope(messageCase, value) {
  if (!value || typeof value !== "object") return value;
  if (value.result?.case) {
    return {
      ...value,
      result: {
        case: value.result.case,
        value: normalizeExecResultValue(messageCase, value.result.case, value.result.value),
      },
    };
  }
  if (messageCase === "mcpResult") {
    const mcpError = normalizeMcpErrorResult(value);
    if (mcpError) return mcpError;
  }
  const cases = [
    "success",
    "error",
    "rejected",
    "fileNotFound",
    "permissionDenied",
    "invalidFile",
    "failure",
    "spawnError",
    "writePermissionDenied",
  ];
  for (const caseName of cases) {
    if (value[caseName] !== undefined) {
      return {
        result: {
          case: caseName,
          value: normalizeExecResultValue(messageCase, caseName, value[caseName]),
        },
      };
    }
  }
  const implicitSuccess = normalizeImplicitSuccessResult(messageCase, value);
  if (implicitSuccess) return implicitSuccess;
  return value;
}

function normalizeImplicitSuccessResult(messageCase, value) {
  if (!value || typeof value !== "object") return null;
  if (messageCase === "mcpResult") {
    if (!Array.isArray(value.content) && value.structuredContent === undefined) return null;
    return {
      result: {
        case: "success",
        value: normalizeExecResultValue(messageCase, "success", value),
      },
    };
  }
  if (messageCase === "listMcpResourcesExecResult") {
    if (!Array.isArray(value.resources)) return null;
    return {
      result: {
        case: "success",
        value,
      },
    };
  }
  if (messageCase === "readMcpResourceExecResult") {
    if (value.uri === undefined && value.content === undefined) return null;
    return {
      result: {
        case: "success",
        value: normalizeReadMcpResourceResultValue(value),
      },
    };
  }
  return null;
}

function normalizeMcpErrorResult(value) {
  if (!value || typeof value !== "object") return null;
  for (const caseName of [
    "toolNotFound",
    "serverNotFound",
    "invalidArgs",
    "permissionDenied",
    "rejected",
    "failure",
  ]) {
    if (value[caseName] !== undefined) {
      return {
        result: {
          case: "error",
          value: { error: formatMcpError(caseName, value[caseName]) },
        },
      };
    }
  }
  return null;
}

function formatMcpError(caseName, value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    if (typeof value.error === "string" && value.error) return value.error;
    if (typeof value.message === "string" && value.message) return value.message;
    if (caseName === "toolNotFound" && typeof value.name === "string" && value.name) {
      return `MCP tool not found: ${value.name}`;
    }
    return `MCP ${caseName}: ${JSON.stringify(value)}`;
  }
  return `MCP ${caseName}`;
}

function normalizeExecResultValue(messageCase, resultCase, value) {
  if (messageCase === "shellResult" && value && typeof value === "object") {
    return normalizeShellResultValue(resultCase, value);
  }
  if (messageCase === "mcpResult" && value && typeof value === "object") {
    return normalizeMcpResultValue(resultCase, value);
  }
  if (messageCase !== "readResult" || resultCase !== "success" || !value || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key !== "content" && key !== "data") normalized[key] = fieldValue;
  }
  if (value.output !== undefined) return normalized;
  if (value.data !== undefined) {
    normalized.output = { case: "data", value: value.data };
  } else if (value.content !== undefined) {
    normalized.output = { case: "content", value: String(value.content) };
  }
  return normalized;
}

function normalizeMcpResultValue(resultCase, value) {
  if (resultCase !== "success") return value;
  const normalized = { ...value };
  if (Array.isArray(value.content)) {
    normalized.content = value.content.map(normalizeMcpContentBlock);
  }
  return normalized;
}

function normalizeMcpContentBlock(block) {
  if (!block || typeof block !== "object") return block;
  if (block.content?.case) return block;
  if (block.case) return { content: block };
  switch (block.type) {
    case "text":
      return { content: { case: "text", value: { text: stringValue(block.text) } } };
    case "image":
      return {
        content: {
          case: "image",
          value: {
            mimeType: stringValue(block.mimeType),
            data: block.data,
            uri: block.uri,
          },
        },
      };
    case "resource":
      return { content: { case: "resource", value: block.resource || {} } };
    default:
      return block;
  }
}

function normalizeReadMcpResourceResultValue(value) {
  if (!value || typeof value !== "object") return value;
  const normalized = { ...value };
  if (value.content && typeof value.content === "object" && !value.content.case) {
    normalized.content = normalizeMcpResourceContent(value.content);
  }
  return normalized;
}

function normalizeMcpResourceContent(content) {
  switch (content.type) {
    case "text":
      return { case: "text", value: stringValue(content.text) };
    case "blob":
      return { case: "blob", value: content.blob ?? content.data ?? "" };
    default:
      return content;
  }
}

function normalizeShellResultValue(resultCase, value) {
  if (resultCase !== "success" && resultCase !== "failure") return value;
  let output = value;
  if (typeof value.tool_output === "string") {
    try {
      output = JSON.parse(value.tool_output);
    } catch {
      output = { output: value.tool_output };
    }
  }
  if (!output || typeof output !== "object") output = {};
  const input = value.tool_input && typeof value.tool_input === "object" ? value.tool_input : {};
  const stdout = typeof output.stdout === "string"
    ? output.stdout
    : typeof output.output === "string"
      ? output.output
      : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const exitCode = normalizeInteger(output.exitCode) ?? normalizeInteger(output.exit_code) ?? 0;
  return {
    command: stringValue(output.command, stringValue(input.command)),
    workingDirectory: stringValue(
      output.workingDirectory,
      stringValue(output.cwd, stringValue(input.workingDirectory, stringValue(input.cwd))),
    ),
    output: stringValue(output.output, stdout || stderr),
    stdout,
    stderr,
    exitCode,
    ...(stringValue(output.shellId, stringValue(output.shell_id)) ? { shellId: stringValue(output.shellId, stringValue(output.shell_id)) } : {}),
    ...(stringValue(output.taskId, stringValue(output.task_id)) ? { taskId: stringValue(output.taskId, stringValue(output.task_id)) } : {}),
    ...(Number.isFinite(output.msToWait) ? { msToWait: output.msToWait } : {}),
    ...(Number.isFinite(output.pid) ? { pid: output.pid } : {}),
    ...(typeof output.backgroundReason === "string" ? { backgroundReason: output.backgroundReason } : {}),
    ...(output.localExecutionTimeMs !== undefined ? { localExecutionTimeMs: output.localExecutionTimeMs } : {}),
    ...(Number.isFinite(output.executionTime) ? { executionTime: output.executionTime } : {}),
    ...(typeof output.signal === "string" && output.signal ? { signal: output.signal } : {}),
    ...(typeof output.interleavedOutput === "string" ? { interleavedOutput: output.interleavedOutput } : {}),
  };
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "*");
}

module.exports = {
  ByokServer,
  DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS,
  DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES,
  buildDirectReadExecResult,
  extractModelCandidates,
  normalizeExecClientResult,
  normalizeRunRequestForProvider,
  pipeResponseBody,
  readResponseText,
  runRequestComposerMode,
  resultCaseForToolName,
  routePatterns,
  summarizeExecResult,
};
