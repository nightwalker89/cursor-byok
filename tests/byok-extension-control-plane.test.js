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
const { protoMessage, fieldMessage, fieldString, quietLog, recordingLog, deferred, tick, useHome, pickFields, waitForWebviewPost, runPanelWebviewScript, fakeReadableStream, interceptModule, interceptModules, createHttpResponseCapture, invokeServerHandle } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("grey-box HTTP control plane toggles mode and merges AvailableModels through the proxy", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-http-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model", apiModel: "provider-model", displayName: "BYOK Model" }],
    }],
  }));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const upstreamCalls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      upstreamCalls.push({ href: String(url), method: init.method, headers: init.headers });
      return new Response(JSON.stringify({
        models: [
          { id: "official-model", name: "Official" },
          { id: "byok-model", name: "Official Duplicate" },
          { id: "enum-model", status: "DEGRADED" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const health = await invokeServerHandle(server, { method: "GET", url: "/byok/health" });
    assert.deepEqual(health.json, { ok: true, byokMode: true, workspaceRoots: [] });

    const directModels = await invokeServerHandle(server, { method: "GET", url: "/byok/models" });
    const directJson = directModels.json;
    assert.equal(directJson.models.length, 1);
    assert.equal(directJson.models[0].id, "byok-model");
    assert.equal(directJson.models[0].isByok, true);

    const proxied = await invokeServerHandle(server, {
      method: "POST",
      url: "/aiserver.v1.AiService/AvailableModels",
      headers: { "content-type": "application/json", host: "local", "x-cursor-client": "keep" },
      body: "{}",
    });
    const proxiedJson = proxied.json;
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].href, "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels");
    assert.equal(upstreamCalls[0].headers.host, undefined);
    assert.equal(upstreamCalls[0].headers["content-type"], "application/json");
    assert.deepEqual(
      proxiedJson.models.map((model) => model.id),
      ["official-model", "enum-model", "byok-model"],
    );
    assert.equal(proxiedJson.models.find((model) => model.id === "enum-model").status, undefined);
    assert.equal(proxiedJson.models.find((model) => model.id === "byok-model").providerName, "Provider");

    const toggle = await invokeServerHandle(server, { method: "POST", url: "/byok/toggle" });
    assert.deepEqual(toggle.json, { byokMode: false });
    assert.equal(loadRoutes().byokMode, 0);

    const enable = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/mode",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.deepEqual(enable.json, { byokMode: true });
    assert.equal(loadRoutes().byokMode, 1);

    const invalid = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/mode",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json, { error: "enabled must be a boolean" });
  } finally {
    globalThis.fetch = originalFetch;
    restoreHome();
  }
});


test("grey-box HTTP proxy bounds oversized AvailableModels upstream responses", async () => {
  assert.equal(DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES >= 1024 * 1024, true);
  const log = recordingLog();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log,
    providerAdapter: { async *run() {} },
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      return new Response("x".repeat(DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const proxied = await invokeServerHandle(server, {
      method: "POST",
      url: "/aiserver.v1.AiService/AvailableModels",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(proxied.statusCode, 502);
    assert.deepEqual(proxied.json, {
      error: `Upstream response exceeds ${DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES} bytes`,
    });
    assert.equal(log.entries.some((entry) =>
      entry.level === "error" &&
      entry.message === "request failed" &&
      entry.fields.url === "/aiserver.v1.AiService/AvailableModels" &&
      entry.fields.statusCode === 502 &&
      entry.fields.receivedBytes > DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES &&
      entry.fields.maxBytes === DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES
    ), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("grey-box BYOK off passes configured models through to official Cursor", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-off-mode-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeRoutes({ byokMode: 0, redirect: DEFAULT_REDIRECTS });
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model", apiModel: "provider-model", displayName: "BYOK Model" }],
    }],
  }));
  let providerCalled = false;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run() {
        providerCalled = true;
        yield { type: "text_delta", text: "should-not-run" };
      },
    },
  });
  try {
    const requestId = "76767676-7676-4767-8767-767676767676";
    const runRequest = {
      requestId,
      requestedModel: { modelId: "byok-model" },
      modelDetails: { modelId: "byok-model" },
      conversationId: "conv-off-mode",
      messages: [{ role: "user", content: "must go official" }],
    };

    assert.deepEqual(routePatterns(loadRoutes()), []);

    const shouldHandle = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/should-handle",
      headers: { "content-type": "application/json" },
      body: { requestId, request: runRequest },
    });
    assert.deepEqual(shouldHandle.json, {
      handle: false,
      reason: "byok-mode-off",
      requestId,
      modelId: "byok-model",
    });

    const run = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/run",
      headers: { "content-type": "application/json" },
      body: { requestId, request: runRequest },
    });
    assert.equal(run.statusCode, 404);
    assert.deepEqual(run.json, {
      local: false,
      reason: "byok-mode-off",
      modelId: "byok-model",
    });
    assert.equal(providerCalled, false);

    const runRequestBinary = protoMessage([
      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
      fieldString(5, "conv-off-mode"),
      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequestBinary)]);
    const bidiResponse = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/bidi",
      headers: { "content-type": "application/json" },
      body: {
        requestId,
        json: {
          requestId: { requestId },
          dataBinary: clientMessage.toString("base64"),
        },
      },
    });
    const bidiJson = bidiResponse.json;
    assert.equal(bidiJson.messageCase, "runRequest");
    assert.equal(bidiJson.modelId, "byok-model");
    assert.equal(bidiJson.handle, false);

    const directModels = await invokeServerHandle(server, { method: "GET", url: "/byok/models" });
    assert.deepEqual(directModels.json.models, []);
  } finally {
    restoreHome();
  }
});


test("grey-box HTTP events stream broadcasts route changes for an already loaded hook", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-events-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  try {
    const capture = createHttpResponseCapture();
    server.handleEvents(capture.response);
    const initialChunkCount = capture.response.chunks.length;

    const toggle = await invokeServerHandle(server, { method: "POST", url: "/byok/toggle" });
    assert.equal(toggle.json.byokMode, false);
    const text = Buffer.concat(capture.response.chunks.slice(initialChunkCount)).toString("utf8");
    assert.match(text, /^event: routes\n/m);
    assert.match(text, /data: \[\]/);

    const chunkCountAfterDisable = capture.response.chunks.length;
    const toggleBack = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/mode",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggleBack.json.byokMode, true);
    const enabledText = Buffer.concat(capture.response.chunks.slice(chunkCountAfterDisable)).toString("utf8");
    assert.match(enabledText, /^event: routes\n/m);
    assert.equal(enabledText, `event: routes\ndata: ${JSON.stringify(routePatterns(loadRoutes()))}\n\n`);
    capture.response.emit("close");
  } finally {
    restoreHome();
  }
});


test("grey-box HTTP workspace-roots endpoint replaces unscoped owner roots", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-workspace-roots-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: ["/workspace/owner"],
  });
  try {
    const response = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/workspace-roots",
      headers: { "content-type": "application/json" },
      body: { workspaceRoots: ["/workspace/attached", "/workspace/owner", "", 42] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json.workspaceRoots, [path.resolve("/workspace/attached"), path.resolve("/workspace/owner")]);
    const health = await invokeServerHandle(server, { method: "GET", url: "/byok/health" });
    assert.deepEqual(health.json.workspaceRoots, [path.resolve("/workspace/attached"), path.resolve("/workspace/owner")]);
  } finally {
    restoreHome();
  }
});

test("grey-box HTTP requests with unknown window id do not use another workspace roots", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-unknown-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model", apiModel: "provider-model", displayName: "BYOK Model" }],
    }],
  }));
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-owner-only-"));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [ownerRoot],
    readFile: async () => {
      throw new Error("unknown window must not read through owner workspace");
    },
  });
  try {
    server.registerWorkspaceRoots([ownerRoot], "7");
    const shouldHandle = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/should-handle",
      headers: { "content-type": "application/json", "x-client-wid": "404" },
      body: { requestId: "request-404", request: { requestedModel: { modelId: "byok-model" } } },
    });
    assert.equal(shouldHandle.statusCode, 200);
    assert.equal(shouldHandle.json.handle, false);
    assert.equal(shouldHandle.json.reason, "workspace-scope-not-registered");

    const health = await invokeServerHandle(server, {
      method: "GET",
      url: "/byok/health",
      headers: { "x-client-wid": "404" },
    });
    assert.deepEqual(health.json.workspaceRoots, []);
    assert.equal(health.json.windowScoped, false);
  } finally {
    restoreHome();
  }
});

test("grey-box first BYOK window request adopts startup workspace scope before events connect", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-startup-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      models: [{ id: "byok-model", apiModel: "provider-model", displayName: "BYOK Model" }],
    }],
  }));
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-owner-startup-"));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [ownerRoot],
  });
  try {
    const shouldHandle = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/should-handle",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: {
        requestId: "request-1",
        request: {
          requestedModel: { modelId: "byok-model" },
          action: {
            case: "userMessageAction",
            value: {
              userMessage: { text: "hello" },
            },
          },
        },
      },
    });
    assert.equal(shouldHandle.statusCode, 200);
    assert.equal(shouldHandle.json.handle, true);
    assert.equal(server.ownerWindowId, "1");

    const health = await invokeServerHandle(server, {
      method: "GET",
      url: "/byok/health",
      headers: { "x-client-wid": "1" },
    });
    assert.deepEqual(health.json.workspaceRoots, [path.resolve(ownerRoot)]);
    assert.equal(health.json.windowScoped, true);
  } finally {
    restoreHome();
  }
});

test("grey-box HTTP workspace-roots endpoint scopes multi-root workspaces by window id", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-roots-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-owner-root-"));
  const firstFolder = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-first-"));
  const secondFolder = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-second-"));
  const target = path.join(secondFolder, "nested.txt");
  fs.writeFileSync(target, "scoped\n");
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [ownerRoot],
    readFile: async (resolvedPath) => {
      assert.equal(resolvedPath, target);
      return fs.readFileSync(resolvedPath);
    },
  });
  try {
    const response = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/workspace-roots",
      headers: { "content-type": "application/json", "x-client-wid": "7" },
      body: { workspaceRoots: [firstFolder, secondFolder] },
    });
    assert.deepEqual(response.json.workspaceRoots, [path.resolve(firstFolder), path.resolve(secondFolder)]);
    const globalHealth = await invokeServerHandle(server, { method: "GET", url: "/byok/health" });
    assert.deepEqual(globalHealth.json.workspaceRoots, [path.resolve(ownerRoot)]);
    const scopedHealth = await invokeServerHandle(server, {
      method: "GET",
      url: "/byok/health",
      headers: { "x-client-wid": "7" },
    });
    assert.deepEqual(scopedHealth.json.workspaceRoots, [path.resolve(firstFolder), path.resolve(secondFolder)]);

    const direct = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/tool-result",
      headers: { "content-type": "application/json", "x-client-wid": "7" },
      body: {
        requestId: "request-7",
        toolCallId: "read-7",
        toolName: "Read",
        toolArguments: { path: "nested.txt" },
        directOnly: true,
      },
    });
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.json.result.message.value.result.value.path, target);
    assert.equal(direct.json.result.message.value.result.value.output.value, "scoped\n");
  } finally {
    restoreHome();
  }
});


test("HTTP events broadcast removes closed or failing clients", () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const good = new EventEmitter();
  const closed = new EventEmitter();
  const failing = new EventEmitter();
  const writes = [];
  for (const response of [good, closed, failing]) {
    response.writeHead = () => {};
    response.write = () => true;
  }
  good.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  closed.destroyed = true;
  let failingWrites = 0;
  failing.write = () => {
    failingWrites++;
    if (failingWrites > 1) throw new Error("socket closed");
    return true;
  };

  server.handleEvents(good);
  server.handleEvents(closed);
  server.handleEvents(failing);
  assert.equal(server.events.size, 2);

  server.broadcast("models", { modelIds: ["byok-model"] });

  assert.equal(server.events.has(good), true);
  assert.equal(server.events.has(closed), false);
  assert.equal(server.events.has(failing), false);
  assert.equal(server.events.size, 1);
  assert.equal(writes.some((line) => line.includes("event: models")), true);
  good.emit("close");
  assert.equal(server.events.size, 0);
});

test("grey-box events connection scopes shared windows to the server workspace roots", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-window-events-shared-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-owner-shared-events-"));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [ownerRoot],
  });
  const response = new EventEmitter();
  response.writeHead = () => {};
  response.write = () => true;
  response.end = () => {};
  try {
    server.ownerWindowId = "1";
    server.handleEvents({ url: "/byok/events?wid=7", headers: {} }, response);
    const health = await invokeServerHandle(server, {
      method: "GET",
      url: "/byok/health",
      headers: { "x-client-wid": "7" },
    });
    assert.deepEqual(health.json.workspaceRoots, [path.resolve(ownerRoot)]);
    assert.equal(health.json.windowScoped, true);
  } finally {
    response.emit("close");
    restoreHome();
  }
});

test("HTTP events keep only the newest client for the same window id", () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const first = new EventEmitter();
  const second = new EventEmitter();
  const writes = [];
  for (const response of [first, second]) {
    response.writeHead = () => {};
    response.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    response.end = () => {
      response.ended = true;
    };
  }

  server.handleEvents({ url: "/byok/events?wid=7", headers: {} }, first);
  assert.equal(server.events.size, 1);
  assert.equal(server.eventsByWindowId.get("7"), first);

  server.handleEvents({ url: "/byok/events?wid=7", headers: {} }, second);
  assert.equal(first.ended, true);
  assert.equal(server.events.size, 1);
  assert.equal(server.events.has(first), false);
  assert.equal(server.events.has(second), true);
  assert.equal(server.eventsByWindowId.get("7"), second);
  assert.equal(writes.some((line) => line.includes("event: routes")), true);

  second.emit("close");
  assert.equal(server.events.size, 0);
  assert.equal(server.eventsByWindowId.size, 0);
});


test("grey-box server refuses BYOK run when configured providers do not match", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-official-boundary-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  let providerCalled = false;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run() {
        providerCalled = true;
        yield { type: "text_delta", text: "should-not-run" };
      },
    },
  });
  try {
    const requestId = "88888888-8888-4888-8888-888888888888";
    const runRequest = protoMessage([
      fieldMessage(3, protoMessage([fieldString(1, "gpt-4.1")])),
      fieldString(5, "conv-official"),
      fieldMessage(9, protoMessage([fieldString(1, "gpt-4.1")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    const bidiResponse = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/bidi",
      headers: { "content-type": "application/json" },
      body: {
        requestId,
        json: {
          requestId: { requestId },
          dataBinary: clientMessage.toString("base64"),
        },
      },
    });
    const bidiJson = bidiResponse.json;
    assert.equal(bidiJson.messageCase, "runRequest");
    assert.equal(bidiJson.handle, false);
    assert.equal(bidiJson.modelId, "gpt-4.1");

    const shouldHandle = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/should-handle",
      headers: { "content-type": "application/json" },
      body: { requestId },
    });
    assert.deepEqual(shouldHandle.json, {
      handle: false,
      reason: "provider-input-not-found",
      requestId,
      modelId: "gpt-4.1",
    });

    const run = await invokeServerHandle(server, {
      method: "POST",
      url: "/byok/run",
      headers: { "content-type": "application/json" },
      body: { requestId },
    });
    assert.equal(run.statusCode, 404);
    assert.deepEqual(run.json, { local: false, reason: "model-not-found", modelId: "gpt-4.1" });
    assert.equal(providerCalled, false);
  } finally {
    restoreHome();
  }
});
