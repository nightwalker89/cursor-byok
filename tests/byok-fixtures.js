"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");

function allTextFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "models-catalog.json") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTextFiles(file));
    else if (isTextFile(file)) out.push(file);
  }
  return out;
}

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  return new Set([
    "",
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".jsonc",
    ".md",
    ".sh",
    ".txt",
    ".yml",
    ".yaml",
  ]).has(ext);
}

function strictCursorMessageCtor() {
  const allowedWriteArgs = new Set([
    "path",
    "fileText",
    "toolCallId",
    "returnFileContentAfterWrite",
    "fileBytes",
    "encodingHint",
  ]);
  return {
    fromJson(value) {
      const exec = value?.message?.case === "execServerMessage" ? value.message.value?.message : null;
      if (exec?.case === "writeArgs") assertOnlyKeys(exec.value, allowedWriteArgs, "writeArgs");
      const started = value?.message?.case === "serverMessage" &&
        value.message.value?.message?.case === "toolCallStarted"
        ? value.message.value.message.value?.toolCall?.tool
        : null;
      if (started?.case === "updateTodosToolCall") {
        assert.equal(started.value?.args, undefined, "updateTodosToolCall started args must not use raw provider todo status strings");
      }
      return value;
    },
  };
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value || {}).filter((key) => !allowed.has(key));
  assert.deepEqual(unknown, [], `${label} contains unsupported Cursor proto fields`);
}

function protoMessage(fields) {
  return Buffer.concat(fields);
}

function fieldMessage(no, value) {
  return Buffer.concat([varint((no << 3) | 2), varint(value.length), value]);
}

function fieldString(no, value) {
  return fieldMessage(no, Buffer.from(value, "utf8"));
}

function fieldVarint(no, value) {
  return Buffer.concat([varint((no << 3) | 0), varint(value)]);
}

function structStringValue(key, value) {
  const valueMessage = protoMessage([fieldString(3, value)]);
  return protoMessage([fieldString(1, key), fieldMessage(2, valueMessage)]);
}

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

function ndjsonResponse(events, status = 200) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  let done = false;
  let cancelled = false;
  let released = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    get cancelled() {
      return cancelled;
    },
    get released() {
      return released;
    },
    body: {
      getReader() {
        return {
          async read() {
            if (done) return { done: true };
            done = true;
            return { done: false, value: bytes };
          },
          async cancel() {
            cancelled = true;
            done = true;
          },
          releaseLock() {
            released = true;
          },
        };
      },
    },
  };
}

function writeMcpCacheTool(home, projectName, serverIdentifier, tool) {
  const serverDir = path.join(home, ".cursor", "projects", projectName, "mcps", serverIdentifier);
  const toolsDir = path.join(serverDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
    serverIdentifier,
    serverName: tool.serverName || serverIdentifier,
  }));
  fs.writeFileSync(path.join(toolsDir, `${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), JSON.stringify({
    name: tool.name,
    description: tool.description || "",
    arguments: tool.arguments || { type: "object", properties: {} },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }));
}

function mcpAuthProviderTool() {
  return {
    name: "plugin-atlassian-atlassian-mcp_auth",
    description: "Authenticate Atlassian",
    inputSchema: {
      type: "object",
      properties: {
        server_identifier: { type: "string", description: "Optional MCP server identifier override." },
        serverIdentifier: { type: "string", description: "Optional MCP server identifier override (camelCase)." },
      },
      additionalProperties: false,
    },
    providerIdentifier: "plugin-atlassian-atlassian",
    toolName: "mcp_auth",
    executionName: "plugin-atlassian-atlassian-mcp_auth",
  };
}

function approvedMcpAuthInteractionResponse(id) {
  return {
    id,
    result: {
      case: "mcpAuthRequestResponse",
      value: {
        result: {
          case: "approved",
          value: {},
        },
      },
    },
  };
}

function webSearchCompletionEnvelope(toolCallId) {
  return {
    toolCall: {
      toolCallId,
      tool: {
        case: "webSearchToolCall",
        value: {
          args: { toolCallId },
          result: {
            case: "success",
            value: { references: [{ title: `Result ${toolCallId}`, url: `https://example.com/${toolCallId}` }] },
          },
        },
      },
    },
  };
}

function approvedSwitchModeInteractionResponse(id) {
  return {
    id,
    result: {
      case: "switchModeRequestResponse",
      value: {
        result: {
          case: "approved",
          value: {},
        },
      },
    },
  };
}

// Hook JSON-oneof normalizer shape (single-wrapped result). Note: the binary
// protocol decoder produces a double-wrapped result for AskQuestion/CreatePlan
// (value.result.result.case, see cursor-protocol.js); downstream consumers must
// accept both. Decoder-shaped coverage lives inline in interaction-bridge.test.js
// and byok-provider-interaction-tools.test.js.
function answeredAskQuestionInteractionResponse(id) {
  return {
    id,
    result: {
      case: "askQuestionInteractionResponse",
      value: {
        result: {
          case: "success",
          value: {
            answers: [{
              questionId: "fixture",
              selectedOptionIds: ["tmp"],
              freeformText: "",
            }],
          },
        },
      },
    },
  };
}

function assertIncludesAll(values, expected) {
  for (const value of expected) assert.equal(values.includes(value), true, `${value} missing from ${values.join(", ")}`);
}

function rejectedMcpAuthInteractionResponse(id, reason) {
  return {
    id,
    result: {
      case: "mcpAuthRequestResponse",
      value: {
        result: {
          case: "rejected",
          value: { reason },
        },
      },
    },
  };
}

function quietLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function recordingLog() {
  const entries = [];
  return {
    entries,
    info(message, fields) {
      entries.push({ level: "info", message, fields });
    },
    warn(message, fields) {
      entries.push({ level: "warn", message, fields });
    },
    error(message, fields) {
      entries.push({ level: "error", message, fields });
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function useHome(home) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  return () => {
    process.env.HOME = previous;
  };
}

function pickFields(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function waitForWebviewPost(waiters, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index !== -1) waiters.splice(index, 1);
      reject(new Error("timed out waiting for webview post"));
    }, 3000);
    waiters.push({
      predicate,
      resolve(message) {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

function runPanelWebviewScript(html) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.equal(typeof script, "string");
  const windowListeners = new Map();
  const posts = [];
  const elements = {
    server: createDomElement(),
    serverIndicator: createDomElement({ className: "pulse-indicator stopped" }),
    serverStatusCard: createDomElement(),
    mode: createDomElement(),
    byokModeInput: createDomElement({ checked: false }),
    byokModeSwitchCard: createDomElement(),
    models: createDomElement(),
    routes: createDomElement(),
    fileLogInput: createDomElement({ checked: false }),
    fileLogSwitch: createDomElement(),
    providersContainer: createDomElement(),
    addProviderBtn: createDomElement(),
    saveProvidersBtn: createDomElement(),
    refreshProvidersBtn: createDomElement(),
    editProvidersJsonBtn: createDomElement(),
    toasts: createDomElement(),
    tooltip: createDomElement(),
  };
  const buttons = {
    start: createDomElement({ dataset: { command: "start" } }),
    stop: createDomElement({ dataset: { command: "stop" } }),
    toggle: createDomElement({ dataset: { command: "toggle" } }),
    providers: createDomElement({ dataset: { command: "providers" } }),
  };
  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      if (selector === 'button[data-command="start"]') return buttons.start;
      if (selector === 'button[data-command="stop"]') return buttons.stop;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "button[data-command]") return Object.values(buttons);
      return [];
    },
    createElement() {
      return createDomElement();
    },
  };
  const context = {
    acquireVsCodeApi: () => ({
      postMessage(message) {
        posts.push(JSON.parse(JSON.stringify(message)));
      },
    }),
    document,
    window: {
      innerWidth: 1024,
      innerHeight: 768,
      scrollX: 0,
      scrollY: 0,
      addEventListener(event, handler) {
        windowListeners.set(event, handler);
      },
    },
    setTimeout(callback) {
      callback();
      return 0;
    },
    clearTimeout() {},
    Date,
    Number,
    String,
    Array,
    Object,
    JSON,
    RegExp,
  };
  vm.runInNewContext(script, context);
  return {
    elements,
    buttons,
    context,
    posts,
    dispatchState(state) {
      const handler = windowListeners.get("message");
      assert.equal(typeof handler, "function");
      handler({ data: { command: "state", state } });
    },
    dispatchMessage(message) {
      const handler = windowListeners.get("message");
      assert.equal(typeof handler, "function");
      handler({ data: message });
    },
  };
}

function createDomElement(overrides = {}) {
  const listeners = new Map();
  return {
    textContent: "",
    innerHTML: "",
    className: "",
    checked: false,
    disabled: false,
    value: "",
    dataset: {},
    parentNode: null,
    addEventListener(event, handler) {
      listeners.set(event, handler);
    },
    click() {
      const handler = listeners.get("click");
      if (handler) handler({ target: this, preventDefault() {}, stopPropagation() {} });
    },
    dispatchEvent(event) {
      const handler = listeners.get(event?.type);
      if (handler) handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    },
    focus() {},
    setSelectionRange() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    },
    classList: {
      add() {},
      remove() {},
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
    },
    removeChild(child) {
      this.children = this.children.filter((candidate) => candidate !== child);
      child.parentNode = null;
    },
    querySelectorAll() {
      return [];
    },
    children: [],
    ...overrides,
  };
}

function asyncIterable(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function fakeReadableStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;
  let released = false;
  return {
    get cancelled() {
      return cancelled;
    },
    get released() {
      return released;
    },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || index >= chunks.length) return { done: true };
            return { done: false, value: encoder.encode(chunks[index++]) };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {
            released = true;
          },
        };
      },
    },
  };
}

function createHttpRequest({ method = "POST", url = "/", headers = {}, body = null }) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { ...headers };
  const chunks = Array.isArray(body)
    ? body.map(normalizeHttpBodyChunk)
    : body === null || body === undefined
      ? []
      : [normalizeHttpBodyChunk(body)];
  process.nextTick(() => {
    for (const chunk of chunks) request.emit("data", chunk);
    request.emit("end");
  });
  return request;
}

function createHttpResponseCapture() {
  let resolved = false;
  let resolveDone;
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = {};
  response.chunks = [];
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.setHeader = (name, value) => {
    response.headers[String(name).toLowerCase()] = value;
  };
  response.writeHead = (statusCode, headers = {}) => {
    response.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      response.headers[String(name).toLowerCase()] = value;
    }
    response.headersSent = true;
  };
  response.write = (chunk) => {
    if (response.writableEnded || response.destroyed) return false;
    response.chunks.push(normalizeHttpBodyChunk(chunk));
    return true;
  };
  response.end = (chunk = "") => {
    if (chunk && chunk.length) response.write(chunk);
    response.writableEnded = true;
    if (!resolved) {
      resolved = true;
      const bodyBuffer = Buffer.concat(response.chunks);
      const text = bodyBuffer.toString("utf8");
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      resolveDone({
        statusCode: response.statusCode,
        headers: { ...response.headers },
        bodyBuffer,
        text,
        json,
      });
    }
    response.emit("finish");
  };
  response.off = response.removeListener.bind(response);
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return { response, done };
}

async function invokeServerHandle(server, { method = "POST", url = "/", headers = {}, body = null } = {}) {
  const request = createHttpRequest({ method, url, headers, body });
  const capture = createHttpResponseCapture();
  await server.handle(request, capture.response).catch((error) => {
    const level = error.statusCode && error.statusCode < 500 ? "warn" : "error";
    server.log?.[level]?.("request failed", {
      url: request.url,
      method: request.method,
      error: error.message,
      statusCode: error.statusCode || 500,
      receivedBytes: error.receivedBytes,
      maxBytes: error.maxBytes,
    });
    if (!capture.response.headersSent) {
      capture.response.writeHead(error.statusCode || 500, { "content-type": "application/json" });
    }
    capture.response.end(JSON.stringify({ error: error.message }));
  });
  return capture.done;
}

function normalizeHttpBodyChunk(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.from(JSON.stringify(chunk), "utf8");
}

function snapshotJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function interceptModule(name, value) {
  return interceptModules({ [name]: value });
}

function interceptModules(values) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(values, request)) return values[request];
    let resolved = "";
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      // Fall back to the original loader when the request cannot be resolved.
    }
    if (resolved && Object.prototype.hasOwnProperty.call(values, resolved)) return values[resolved];
    return original.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = original;
  };
}

async function withMockEventSource(fn, factory) {
  const originalEventSource = globalThis.EventSource;
  try {
    globalThis.EventSource = factory || function EventSource() {
      this.addEventListener = () => {};
    };
    return await fn();
  } finally {
    globalThis.EventSource = originalEventSource;
  }
}

async function withGreyBoxHookGlobals(fn, { eventSourceFactory, fetch } = {}) {
  const saved = {
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    __cursorByokReady: globalThis.__cursorByokReady,
    __cursorByokPatchApplied: globalThis.__cursorByokPatchApplied,
    __cursorByokWrapTransport: globalThis.__cursorByokWrapTransport,
  };
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = eventSourceFactory || function EventSource() {
      this.addEventListener = () => {};
    };
    if (fetch) globalThis.fetch = fetch;
    return await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.EventSource = saved.EventSource;
    if (saved.__cursorByokReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = saved.__cursorByokReady;
    if (saved.__cursorByokPatchApplied === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = saved.__cursorByokPatchApplied;
    if (saved.__cursorByokWrapTransport === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = saved.__cursorByokWrapTransport;
  }
}

function createProviderAdapter(quietLogFn = quietLog) {
  const { ProviderAdapter } = require("../src/server/provider-adapter");
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLogFn(),
  });
}

async function runConcurrentReadToolWaits({
  toolCallIds,
  waitForToolResultOptions,
  runAdapter,
  afterSecondWait,
  assertFollowUp,
}) {
  const { normalizeExecClientResult } = require("../src/server/http");
  const waits = Object.fromEntries(toolCallIds.map((id) => [id, deferred()]));
  const waitCalls = [];
  const events = [];
  const run = (async () => {
    for await (const event of runAdapter(async (toolCallId, options) => {
      waitCalls.push({ toolCallId, options });
      return waits[toolCallId].promise;
    })) {
      events.push(event);
    }
  })();

  await tick();
  assert.deepEqual(waitCalls, toolCallIds.map((toolCallId, index) => ({
    toolCallId,
    options: waitForToolResultOptions[index],
  })));
  waits[toolCallIds[1]].resolve(normalizeExecClientResult({
    execId: toolCallIds[1],
    readResult: { success: { path: "/tmp/b", content: "b" } },
  }));
  await tick();
  if (afterSecondWait) await afterSecondWait();
  waits[toolCallIds[0]].resolve(normalizeExecClientResult({
    execId: toolCallIds[0],
    readResult: { success: { path: "/tmp/a", content: "a" } },
  }));
  await run;
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
  await assertFollowUp(events);
}

module.exports = {
  allTextFiles,
  assertIncludesAll,
  answeredAskQuestionInteractionResponse,
  approvedMcpAuthInteractionResponse,
  approvedSwitchModeInteractionResponse,
  asyncIterable,
  createDomElement,
  createHttpRequest,
  createHttpResponseCapture,
  createProviderAdapter,
  deferred,
  fakeReadableStream,
  fieldMessage,
  fieldString,
  fieldVarint,
  interceptModule,
  interceptModules,
  invokeServerHandle,
  jsonResponse,
  mcpAuthProviderTool,
  ndjsonResponse,
  pickFields,
  protoMessage,
  quietLog,
  recordingLog,
  rejectedMcpAuthInteractionResponse,
  runConcurrentReadToolWaits,
  runPanelWebviewScript,
  snapshotJson,
  strictCursorMessageCtor,
  structStringValue,
  tick,
  useHome,
  varint,
  withGreyBoxHookGlobals,
  withMockEventSource,
  waitForWebviewPost,
  webSearchCompletionEnvelope,
  writeMcpCacheTool,
};
