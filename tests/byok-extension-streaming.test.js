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
const { protoMessage, fieldMessage, fieldString, quietLog, recordingLog, deferred, tick, useHome, pickFields, waitForWebviewPost, runPanelWebviewScript, fakeReadableStream, interceptModule, interceptModules, invokeServerHandle } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("readResponseText bounds non-stream response text fallback", async () => {
  await assert.rejects(
    readResponseText({ text: async () => "é".repeat(4) }, 7),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.receivedBytes, 8);
      assert.equal(error.maxBytes, 7);
      return true;
    },
  );
});

test("HTTP proxy response piping waits for downstream backpressure", async () => {
  const drain = deferred();
  const response = new EventEmitter();
  response.chunks = [];
  response.write = function (chunk) {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    return this.chunks.length !== 1;
  };
  response.off = response.removeListener.bind(response);
  const reader = fakeReadableStream(["first", "second"]);

  const piping = pipeResponseBody(reader.body, response);
  await tick();
  assert.deepEqual(response.chunks, ["first"]);
  response.emit("drain");
  drain.resolve();
  assert.equal(await piping, true);
  assert.deepEqual(response.chunks, ["first", "second"]);
  assert.equal(reader.released, true);
  assert.equal(reader.cancelled, false);
});

test("HTTP proxy response piping cancels upstream when downstream closes", async () => {
  const response = new EventEmitter();
  response.write = () => false;
  response.off = response.removeListener.bind(response);
  const reader = fakeReadableStream(["first", "second"]);

  const piping = pipeResponseBody(reader.body, response);
  await tick();
  response.emit("close");
  assert.equal(await piping, false);
  assert.equal(reader.cancelled, true);
  assert.equal(reader.released, true);
});

test("HTTP proxy response piping returns when downstream closes during write", async () => {
  const response = new EventEmitter();
  response.write = () => {
    response.emit("close");
    return false;
  };
  response.off = response.removeListener.bind(response);
  const reader = fakeReadableStream(["first", "second"]);

  const result = await Promise.race([
    pipeResponseBody(reader.body, response),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);

  assert.equal(result, false);
  assert.equal(reader.cancelled, true);
  assert.equal(reader.released, true);
});

test("grey-box BYOK run stops provider when downstream closes", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-run-close-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "provider-model" }],
    }],
  }));
  const firstEventPulled = deferred();
  const cleanupSeen = deferred();
  let signalSeen;
  const log = recordingLog();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log,
    providerAdapter: {
      run({ signal }) {
        signalSeen = signal;
        return (async function* runProvider() {
          try {
            firstEventPulled.resolve();
            yield { type: "text_delta", text: "first" };
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          } finally {
            cleanupSeen.resolve();
          }
        })();
      },
    },
  });
  try {
    const response = new EventEmitter();
    response.chunks = [];
    response.writeHead = function (status, headers) {
      this.status = status;
      this.headers = headers;
    };
    response.write = function (chunk) {
      this.chunks.push(String(chunk));
      if (this.chunks.length >= 2) {
        process.nextTick(() => this.emit("close"));
        return false;
      }
      return true;
    };
    response.end = function () {
      this.ended = true;
    };
    response.off = response.removeListener.bind(response);

    const running = server.handleLocalRun({
      requestId: "71717171-7171-4717-8717-717171717171",
      request: {
        requestedModel: { modelId: "byok-model" },
        modelDetails: { modelId: "byok-model" },
        conversationId: "conv-close",
        messages: [{ role: "user", content: "hello" }],
      },
    }, response, new URL("http://127.0.0.1/byok/run"));
    await firstEventPulled.promise;
    await cleanupSeen.promise;
    await running;
    assert.equal(response.status, 200);
    assert.equal(response.ended, undefined);
    assert.equal(signalSeen.aborted, true);
    assert.equal(log.entries.some((entry) =>
      entry.level === "info" &&
      entry.message === "BYOK local run response closed" &&
      entry.fields.requestId === "71717171-7171-4717-8717-717171717171" &&
      entry.fields.eventsWritten === 1
    ), true);
  } finally {
    restoreHome();
  }
});

test("grey-box HTTP server rejects oversized request bodies without lowering normal tool-result capacity", async () => {
  assert.equal(DEFAULT_MAX_REQUEST_BODY_BYTES > 70000, true);
  const log = recordingLog();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log,
    providerAdapter: { async *run() {} },
    maxRequestBodyBytes: 256,
  });
  const oversized = await invokeServerHandle(server, {
    method: "POST",
    url: "/byok/local-tool-result",
    headers: { "content-type": "application/json" },
    body: {
      requestId: "62626262-6262-4626-8626-626262626262",
      toolCallId: "read-large",
      result: {
        execId: "read-large",
        message: {
          case: "readResult",
          value: { result: { case: "success", value: { output: { case: "content", value: "x".repeat(256) } } } },
        },
      },
    },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(log.entries.some((entry) =>
    entry.level === "warn" &&
    entry.message === "request failed" &&
    entry.fields.url === "/byok/local-tool-result" &&
    entry.fields.method === "POST" &&
    entry.fields.statusCode === 413 &&
    entry.fields.receivedBytes > 256 &&
    entry.fields.maxBytes === 256
  ), true);

  const ok = await invokeServerHandle(server, {
    method: "POST",
    url: "/byok/local-tool-result",
    headers: { "content-type": "application/json" },
    body: {
      requestId: "62626262-6262-4626-8626-626262626262",
      toolCallId: "read-small",
      result: { execId: "read-small", message: { case: "readResult", value: {} } },
    },
  });
  assert.equal(ok.statusCode, 200);
});

test("BYOK run waits for downstream backpressure before pulling next provider event", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-run-backpressure-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "provider-model" }],
    }],
  }));
  let pulls = 0;
  const response = new EventEmitter();
  response.chunks = [];
  response.writeHead = function (status, headers) {
    this.status = status;
    this.headers = headers;
  };
  response.write = function (chunk) {
    this.chunks.push(String(chunk));
    return this.chunks.length !== 2;
  };
  response.end = function () {
    this.ended = true;
  };
  response.off = response.removeListener.bind(response);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run() {
        pulls++;
        yield { type: "text_delta", text: "first" };
        pulls++;
        yield { type: "text_delta", text: "second" };
      },
    },
  });
  try {
    const running = server.handleLocalRun({
      requestId: "72727272-7272-4727-8727-727272727272",
      request: {
        requestedModel: { modelId: "byok-model" },
        modelDetails: { modelId: "byok-model" },
        conversationId: "conv-backpressure",
        messages: [{ role: "user", content: "hello" }],
      },
    }, response, new URL("http://127.0.0.1/byok/run"));
    await tick();
    assert.equal(response.status, 200);
    assert.equal(response.chunks.length, 2);
    assert.equal(pulls, 1);
    assert.equal(response.ended, undefined);
    response.emit("drain");
    await running;
    assert.equal(pulls, 2);
    assert.equal(response.chunks.length, 3);
    assert.equal(response.ended, true);
  } finally {
    restoreHome();
  }
});

test("BYOK local run writes cancelled done after local cancelAction aborts the provider", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-run-cancelled-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "provider-model" }],
    }],
  }));
  const firstYield = deferred();
  const cleanedUp = deferred();
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      run({ signal }) {
        return (async function* runProvider() {
          try {
            yield { type: "text_delta", text: "editing" };
            firstYield.resolve();
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            throw signal.reason || new Error("cancelled");
          } finally {
            cleanedUp.resolve();
          }
        })();
      },
    },
  });
  try {
    const response = new EventEmitter();
    response.chunks = [];
    response.writeHead = function (status, headers) {
      this.status = status;
      this.headers = headers;
    };
    response.write = function (chunk) {
      this.chunks.push(String(chunk));
      return true;
    };
    response.end = function () {
      this.ended = true;
    };
    response.off = response.removeListener.bind(response);

    const running = server.handleLocalRun({
      requestId: "73737373-7373-4737-8737-737373737373",
      request: {
        requestedModel: { modelId: "byok-model" },
        modelDetails: { modelId: "byok-model" },
        conversationId: "conv-cancelled",
        messages: [{ role: "user", content: "hello" }],
      },
    }, response, new URL("http://127.0.0.1/byok/run"));

    await firstYield.promise;
    const cancelled = invokeServerHandle(server, {
      method: "POST",
      url: "/byok/local-client-message",
      headers: { "content-type": "application/json" },
      body: {
        requestId: "73737373-7373-4737-8737-737373737373",
        message: {
          case: "conversationAction",
          value: {
            action: { case: "cancelAction", value: {} },
          },
        },
      },
    });
    await cleanedUp.promise;
    await running;
    assert.equal((await cancelled).statusCode, 200);
    const events = response.chunks.map((chunk) => JSON.parse(chunk.trim())).filter(Boolean);
    assert.deepEqual(events.map((event) => event.type), ["meta", "text_delta", "done"]);
    assert.equal(events[2].stopReason, "cancelled");
    assert.equal(response.ended, true);
  } finally {
    restoreHome();
  }
});
