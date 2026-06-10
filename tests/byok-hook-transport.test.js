"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hookRuntime } = require("../src/workbench-hook");
const { jsonResponse, ndjsonResponse, asyncIterable } = require("./byok-fixtures");

function mockLocalStorage() {
  const entries = new Map();
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

function mockComposerTranscriptDocument(pairs) {
  function textNode(text) {
    return {
      innerText: text,
      textContent: text,
    };
  }
  function pairNode(pair) {
    const userNodes = [textNode(pair.user)];
    const assistantNodes = (Array.isArray(pair.assistant) ? pair.assistant : []).map(textNode);
    return {
      querySelectorAll(selector) {
        if (selector === ".markdown-root") return assistantNodes;
        if (selector === ".aislash-editor-input-readonly, .composer-human-message-content, .composer-human-message") {
          return userNodes;
        }
        return [];
      },
    };
  }
  return {
    querySelectorAll(selector) {
      if (selector !== ".composer-human-ai-pair-container") return [];
      return (Array.isArray(pairs) ? pairs : []).map(pairNode);
    },
  };
}

test("grey-box hook scopes BYOK HTTP calls with the Cursor window id", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalWindow = globalThis.window;
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.window = { vscodeWindowId: 42 };
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      calls.push({
        url: String(url),
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([{ type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const result = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId: "request-42", requestedModel: { modelId: "byok-model" } },
    );
    for await (const _message of result.message) {
      // drain
    }

    assert.equal(calls.some((call) => call.url.endsWith("/byok/workspace-roots")), false);
    const scopedCalls = calls.filter((entry) => /\/byok\/(should-handle|run)$/.test(entry.url));
    // Both should-handle and run must have fired; an empty filter would make
    // the header loop below pass with BYOK routing entirely broken.
    assert.equal(scopedCalls.length >= 2, true, `expected should-handle and run calls, got ${scopedCalls.length}`);
    for (const call of scopedCalls) {
      assert.equal(call.headers["x-client-wid"], "42");
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook ignores stale local-agent compatibility metadata and routes BYOK locally", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "ok" },
          { type: "done" },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "openai-compatible-model",
        cursorByokLocalAgentCompatible: true,
        apiKey: "key",
        openaiApiBaseUrl: "https://openai-compatible.example/v1",
      }],
    });
    const transportCalls = [];
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async (...args) => {
        transportCalls.push(args);
        return { upstream: true };
      },
    });
    const result = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestedModel: { modelId: "openai-compatible-model" } },
    );
    const messages = [];
    for await (const message of result.message) messages.push(message);
    assert.equal(transportCalls.length, 0);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/should-handle")), true);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), true);
    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook waits for local BYOK server instead of falling through to official transport for BYOK models", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/health")) {
        return jsonResponse({ ok: true });
      }
      if (String(url).endsWith("/byok/should-handle")) {
        if (calls.filter((call) => call.url.endsWith("/byok/should-handle")).length === 1) {
          throw new Error("server still starting");
        }
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "ok" },
          { type: "done" },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      byokRunReadyWaitMs: 50,
      byokRunReadyRetryDelayMs: 0,
      routes: [],
      byokModelIds: ["gpt55-sub2api"],
    });
    const upstreamInputs = [];
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async (...args) => {
        upstreamInputs.push(args[5]);
        return { upstream: true };
      },
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": "70707070-7070-4707-8707-707070707070" },
      asyncIterable([{
        message: {
          case: "runRequest",
          value: {
            requestedModel: { modelId: "gpt55-sub2api" },
            modelDetails: { modelName: "gpt55-sub2api" },
          },
        },
      }]),
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.equal(upstreamInputs.length, 0);
    assert.equal(calls.filter((call) => call.url.endsWith("/byok/should-handle")).length, 2);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), true);
    assert.equal(messages[0].message.value.message.case, "textDelta");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook leaves official transport untouched and handles BYOK sessions locally", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/bidi")) {
        const body = JSON.parse(init.body);
        return jsonResponse({ ok: true, handle: body.requestId === "66666666-6666-4666-8666-666666666666" });
      }
      if (String(url).endsWith("/byok/should-handle")) {
        const body = JSON.parse(init.body);
        return jsonResponse({ handle: body.requestId === "66666666-6666-4666-8666-666666666666" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2,\"limit\":3}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          direct: true,
          result: {
            execId: body.toolCallId,
            _byokDirectTool: true,
            message: {
              case: "readResult",
              value: {
                result: {
                  case: "success",
                    value: {
                      path: body.toolArguments.path,
                      output: { case: "content", value: "ok" },
                      totalLines: 10,
                      fileSize: 30,
                      truncated: false,
                      rangeApplied: true,
                      readRange: { startLine: 3, endLine: 5 },
                    },
                  },
                },
            },
          },
        });
      }
      return jsonResponse({});
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "gpt55-sub2api", displayName: "gpt55-sub2api" }],
    });
    const transportCalls = [];
    const transport = {
      unary: async (...args) => {
        transportCalls.push(["unary", args[0].typeName, args[1].name, args[5]]);
        return { upstream: true };
      },
      stream: async (...args) => {
        transportCalls.push(["stream", args[0].typeName, args[1].name, args[5]]);
        return { upstream: true };
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const bidiService = { typeName: "aiserver.v1.BidiService" };
    const bidiMethod = { name: "BidiAppend", O: { fromJson: (value) => ({ bidiAck: value }) } };
    const runService = { typeName: "agent.v1.AgentService" };
    const runMethod = { name: "RunSSE" };

    assert.deepEqual(
      await wrapped.unary(bidiService, bidiMethod, null, 0, {}, { requestId: { requestId: "official-request" } }),
      { upstream: true },
    );
    assert.deepEqual(
      await wrapped.unary(bidiService, bidiMethod, null, 0, {}, {
        requestId: { requestId: "66666666-6666-4666-8666-666666666666" },
      }),
      { bidiAck: {} },
    );
    assert.equal(transportCalls.filter((call) => call[0] === "unary").length, 1);

    const officialStream = await wrapped.stream(runService, runMethod, null, 0, {}, {
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    assert.deepEqual(officialStream, { upstream: true });

    const byokStream = await wrapped.stream(runService, runMethod, null, 0, {}, {
      requestId: "66666666-6666-4666-8666-666666666666",
    });
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);
    assert.equal(messages[0].message.value.message.case, "toolCallStarted");
    assert.equal(messages[1].message.value.message.case, "toolCallCompleted");
    const uiReadSuccess = messages[1].message.value.message.value.toolCall.tool.value.result.result;
    assert.equal(uiReadSuccess.case, "success");
    assert.equal(uiReadSuccess.value.output.value, "ok");
    assert.equal(uiReadSuccess.value.rangeApplied, true);
    assert.equal(uiReadSuccess.value.totalLines, 10);
    assert.equal(uiReadSuccess.value.readRange, undefined);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/exec-map")), false);
    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localToolResult.body.result.message.value.result.value.readRange, { startLine: 3, endLine: 5 });
    assert.deepEqual(calls.find((call) => call.url.endsWith("/byok/tool-result")).body, {
      requestId: "66666666-6666-4666-8666-666666666666",
      toolCallId: "call-1",
      toolName: "Read",
      toolArguments: { path: "/tmp/a", offset: 2, limit: 3 },
      directOnly: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook turns oversized BYOK NDJSON into a completed Cursor turn", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "62626262-6262-4626-8626-626262626262";
  let runResponse;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const models = [{
      id: "glm-5.1-coding",
      name: "GLM-5.1-Coding",
      contextTokenLimit: 200000,
      contextTokenLimitForMaxMode: 1000000,
    }];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/models")) return jsonResponse({ models });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        runResponse = ndjsonResponse([
          { type: "text_delta", text: "x".repeat(96) },
        ]);
        return runResponse;
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      maxNdjsonLineBytes: 32,
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
    assert.match(
      messages[0].message.value.message.value.text,
      /BYOK request failed: BYOK NDJSON line exceeds 32 bytes/,
    );
    assert.equal(runResponse.cancelled, true);
    assert.equal(runResponse.released, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook turns BYOK run HTTP failure into a completed Cursor turn", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646464";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const models = [{
      id: "glm-5.1-coding",
      name: "GLM-5.1-Coding",
      contextTokenLimit: 200000,
      contextTokenLimitForMaxMode: 1000000,
    }];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/models")) return jsonResponse({ models });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) return ndjsonResponse([], 500);
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "gpt55-sub2api", displayName: "gpt55-sub2api" }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
    assert.match(messages[0].message.value.message.value.text, /BYOK request failed: HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook leaves provider-input-not-found runs without action hints on official transport", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "6a6a6a6a-6a6a-46a6-8a6a-6a6a6a6a6a6a";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({
          handle: false,
          reason: "provider-input-not-found",
          requestId,
          modelId: "gpt55-sub2api",
        });
      }
      if (String(url).endsWith("/byok/run")) {
        throw new Error("byok run should not be called");
      }
      return jsonResponse({});
    };

    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "gpt55-sub2api", displayName: "gpt55-sub2api" }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const result = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId, request: { modelDetails: { modelName: "gpt55-sub2api" } } },
    );

    assert.deepEqual(result, { upstream: true });
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), false);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/should-handle")), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook forces local BYOK run after provider-input-not-found when action hints exist", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "6a6a6a6a-6a6a-46a6-8a6a-6a6a6a6a6a6b";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({
          handle: false,
          reason: "provider-input-not-found",
          requestId,
          modelId: "gpt55-sub2api",
        });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "forced local" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };

    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "gpt55-sub2api", displayName: "gpt55-sub2api" }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const result = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE", O: { fromJson(value) { return value; } } },
      null,
      0,
      {},
      {
        requestId,
        request: {
          modelDetails: { modelName: "gpt55-sub2api" },
          action: { executePlanAction: { planFileContent: "# plan" } },
        },
      },
    );

    const messages = [];
    for await (const message of result.message) messages.push(message);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), true);
    assert.match(messages[0].message.value.message.value.text, /forced local/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook turns BYOK run fetch failure into a completed Cursor turn", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "65656565-6565-4656-8656-656565656565";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) throw new Error("connection refused");
      return jsonResponse({});
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
    assert.match(messages[0].message.value.message.value.text, /BYOK request failed: connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook accepts many valid BYOK NDJSON lines coalesced into one chunk", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "66636363-6363-4636-8636-636363636363";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const models = [{
      id: "glm-5.1-coding",
      name: "GLM-5.1-Coding",
      contextTokenLimit: 200000,
      contextTokenLimitForMaxMode: 1000000,
    }];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/models")) return jsonResponse({ models });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "a" },
          { type: "text_delta", text: "b" },
          { type: "text_delta", text: "c" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 3 } },
        ]);
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      maxNdjsonLineBytes: 96,
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "textDelta",
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
    assert.deepEqual(
      messages.filter((message) => message.message?.value?.message?.case === "textDelta").map((message) => message.message.value.message.value.text),
      ["a", "b", "c"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook reassembles NDJSON lines split across stream chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "66646464-6464-4646-8646-646464646464";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const ndjson = [
      { type: "text_delta", text: "hello split" },
      { type: "text_delta", text: "second line" },
      { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    // Split every 7 bytes so JSON lines straddle chunk boundaries — the hook's
    // partial-line buffering must reassemble them.
    const encoder = new TextEncoder();
    const chunks = [];
    for (let offset = 0; offset < ndjson.length; offset += 7) {
      chunks.push(encoder.encode(ndjson.slice(offset, offset + 7)));
    }
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        let index = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                async read() {
                  if (index >= chunks.length) return { done: true };
                  return { done: false, value: chunks[index++] };
                },
                async cancel() {
                  index = chunks.length;
                },
                releaseLock() {},
              };
            },
          },
        };
      }
      return jsonResponse({});
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(
      messages.filter((message) => message.message?.value?.message?.case === "textDelta").map((message) => message.message.value.message.value.text),
      ["hello split", "second line"],
    );
    assert.equal(messages.at(-1).message.value.message.case, "turnEnded");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook emits token-only conversation checkpoint for context usage indicator", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "76767676-7676-4767-8767-767676767676";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          {
            type: "done",
            stopReason: "end_turn",
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 5,
              cacheWriteTokens: 7,
            },
          },
        ]);
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "glm-5.1-coding",
        name: "GLM-5.1-Coding",
        contextTokenLimit: 200000,
        contextTokenLimitForMaxMode: 1000000,
      }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId, modelDetails: { modelName: "GLM-5.1-Coding" } },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "conversationCheckpointUpdate",
      "turnEnded",
    ]);
    assert.deepEqual(messages[3].message.value.message.value, {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
    assert.deepEqual(messages[2].message.value.tokenDetails, {
      usedTokens: 162,
      maxTokens: 200000,
    });
    assert.equal(calls.some((url) => url.endsWith("/byok/models")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook leaves large provider usage on turnEnded without checkpoint clamping", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "74747474-7474-4747-8747-747474747474";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "done",
            stopReason: "end_turn",
            usage: { inputTokens: 1500000, outputTokens: 1 },
          },
        ]);
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "glm-5.1-coding",
        name: "GLM-5.1-Coding",
        contextTokenLimit: 200000,
        contextTokenLimitForMaxMode: 1000000,
      }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId, modelDetails: { modelName: "GLM-5.1-Coding", maxMode: true } },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "stepCompleted",
      "conversationCheckpointUpdate",
      "turnEnded",
    ]);
    assert.deepEqual(messages[2].message.value.message.value, {
      inputTokens: 1500000,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(messages[1].message.value.tokenDetails, {
      usedTokens: 1000000,
      maxTokens: 1000000,
    });
    assert.equal(calls.some((url) => url.endsWith("/byok/models")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook bounds BYOK NDJSON by UTF-8 bytes, not JavaScript characters", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "63636363-6363-4636-8636-636363636363";
  let runResponse;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        runResponse = ndjsonResponse([
          { type: "text_delta", text: "你好你好" },
        ]);
        return runResponse;
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      maxNdjsonLineBytes: 40,
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "stepCompleted",
      "turnEnded",
    ]);
    assert.match(
      messages[0].message.value.message.value.text,
      /BYOK request failed: BYOK NDJSON line exceeds 40 bytes/,
    );
    assert.equal(runResponse.cancelled, true);
    assert.equal(runResponse.released, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook uses cached model metadata for checkpoint context without refreshing models", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "75757575-7575-4757-8757-757575757575";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "done",
            stopReason: "end_turn",
            usage: { inputTokens: 75000, outputTokens: 500 },
          },
        ]);
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "glm-5.1-coding",
        name: "GLM-5.1-Coding",
        contextTokenLimit: 200000,
        contextTokenLimitForMaxMode: 1000000,
      }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId, modelDetails: { modelName: "GLM-5.1-Coding", maxMode: true } },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "stepCompleted",
      "conversationCheckpointUpdate",
      "turnEnded",
    ]);
    assert.deepEqual(messages[2].message.value.message.value, {
      inputTokens: 75000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(messages[1].message.value.tokenDetails, {
      usedTokens: 75500,
      maxTokens: 1000000,
    });
    assert.equal(calls.some((url) => url.endsWith("/byok/models")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook emits token-only conversation checkpoint after tool_use done", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "78787878-7878-4787-8787-787878787878";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "done",
            stopReason: "tool_use",
            usage: { inputTokens: 42000, outputTokens: 900, cacheReadTokens: 1000 },
          },
        ]);
      }
      return jsonResponse({});
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "gpt55-sub2api",
        name: "gpt55-sub2api",
        contextTokenLimit: 256000,
        contextTokenLimitForMaxMode: 256000,
      }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId, modelDetails: { modelName: "gpt55-sub2api" } },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "stepCompleted",
      "conversationCheckpointUpdate",
    ]);
    assert.deepEqual(messages[1].message.value.tokenDetails, {
      usedTokens: 43900,
      maxTokens: 256000,
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook routes RunSSE locally from the RunSSE input when Bidi state is absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const requestId = "99999999-9999-4999-8999-999999999999";
  const runInput = {
    requestId,
    modelDetails: { modelName: "gpt55-sub2api" },
    messages: [{ role: "user", content: "ping" }],
  };
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({
          handle: body?.requestId === requestId && body?.request?.modelDetails?.modelName === "gpt55-sub2api",
        });
      }
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, requestId);
        assert.equal(body.request.modelDetails.modelName, "gpt55-sub2api");
        assert.equal(body.request.composerMode, "plan");
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    globalThis.__cursorByokRememberComposerMode(requestId, "plan");
    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should have been routed locally");
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      runInput,
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.modelDetails.modelName, "gpt55-sub2api");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.composerMode, "plan");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.modelDetails.modelName, "gpt55-sub2api");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.composerMode, "plan");
    assert.equal(messages[0].message.value.message.case, "textDelta");
    assert.equal(messages.at(-1).message.value.message.case, "turnEnded");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
  }
});

test("grey-box hook preserves plan mode across Cursor retry request ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const retryRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, retryRequestId);
        assert.equal(body.request.composerMode, "plan");
        return ndjsonResponse([
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    globalThis.__cursorByokRememberComposerMode(originalRequestId, "plan");
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("retry should stay local");
      },
    });

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      { "x-request-id": retryRequestId, "x-original-request-id": originalRequestId },
      { requestId: retryRequestId, modelDetails: { modelName: "gpt55-sub2api" } },
    );
    for await (const _message of byokStream.message) {
      // Drain stream.
    }

    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.composerMode, "plan");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.composerMode, "plan");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
  }
});

test("grey-box hook preserves conversation context across model-switch request ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "12121212-1212-4212-8212-121212121212";
  const secondRequestId = "13131313-1313-4313-8313-131313131313";
  const conversationId = "14141414-1414-4414-8414-141414141414";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          assert.deepEqual(body.request.messages, [{ role: "user", content: "first question" }]);
          return ndjsonResponse([
            { type: "text_delta", text: "first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "follow up after model switch" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should stay local");
      },
    });

    const firstRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: firstRequestId,
        conversationId,
        modelDetails: { modelName: "gpt55-sub2api" },
        messages: [{ role: "user", content: "first question" }],
      },
    );
    for await (const _message of firstRun.message) {
      // drain
    }

    const secondRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: secondRequestId,
        conversationId,
        modelDetails: { modelName: "GLM-5.1-Coding" },
        messages: [{ role: "user", content: "follow up after model switch" }],
      },
    );
    for await (const _message of secondRun.message) {
      // drain
    }

    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up after model switch" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rebuilds action-only context before provider switch when visible transcript is partial", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "15151515-1515-4515-8515-151515151515";
  const secondRequestId = "16161616-1616-4616-8616-161616161616";
  const conversationId = "17171717-1717-4717-8717-171717171717";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "sonnet46-dario");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "follow up after model switch" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should stay local");
      },
    });

    const firstRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: firstRequestId,
        conversationId,
        modelDetails: { modelName: "GLM-5.1-Coding" },
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "first question" },
          },
        },
      },
    );
    for await (const _message of firstRun.message) {
      // drain
    }

    const secondRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: secondRequestId,
        conversationId,
        modelDetails: { modelName: "sonnet46-dario" },
        messages: [{ role: "assistant", content: "first answer" }],
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "follow up after model switch" },
          },
        },
      },
    );
    for await (const _message of secondRun.message) {
      // drain
    }

    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up after model switch" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rebuilds action-only context before reverse provider switch when visible transcript is partial", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "24242424-2424-4242-8242-242424242424";
  const secondRequestId = "25252525-2525-4252-8252-252525252525";
  const conversationId = "26262626-2626-4262-8262-262626262626";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "anthropic first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "anthropic first question" },
            { role: "assistant", content: "anthropic first answer" },
            { role: "user", content: "chat follow up after provider switch" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "chat second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should stay local");
      },
    });

    const firstRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: firstRequestId,
        conversationId,
        modelDetails: { modelName: "sonnet46-dario" },
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "anthropic first question" },
          },
        },
      },
    );
    for await (const _message of firstRun.message) {
      // drain
    }

    const secondRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: secondRequestId,
        conversationId,
        modelDetails: { modelName: "GLM-5.1-Coding" },
        messages: [{ role: "assistant", content: "anthropic first answer" }],
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "chat follow up after provider switch" },
          },
        },
      },
    );
    for await (const _message of secondRun.message) {
      // drain
    }

    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "anthropic first question" },
      { role: "assistant", content: "anthropic first answer" },
      { role: "user", content: "chat follow up after provider switch" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rebuilds action-only context across API-format switch request ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "18181818-1818-4818-8818-181818181818";
  const secondRequestId = "19191919-1919-4919-8919-191919191919";
  const conversationId = "20202020-2020-4020-8020-202020202020";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.equal(body.request.action.case, "userMessageAction");
          assert.equal(body.request.action.value.userMessage.text, "chat-format first question");
          return ndjsonResponse([
            { type: "text_delta", text: "chat-format first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "responses-model");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "chat-format first question" },
            { role: "assistant", content: "chat-format first answer" },
            { role: "user", content: "responses follow up after format switch" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "responses answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({});
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModelIds: ["GLM-5.1-Coding", "responses-model"],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should stay local");
      },
    });

    const firstRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: firstRequestId,
        conversationId,
        modelDetails: { modelName: "GLM-5.1-Coding" },
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "chat-format first question" },
          },
        },
      },
    );
    for await (const _message of firstRun.message) {
      // drain
    }

    const secondRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: secondRequestId,
        conversationId,
        modelDetails: { modelName: "responses-model" },
        messages: [{ role: "assistant", content: "chat-format first answer" }],
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "responses follow up after format switch" },
          },
        },
      },
    );
    for await (const _message of secondRun.message) {
      // drain
    }

    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "chat-format first question" },
      { role: "assistant", content: "chat-format first answer" },
      { role: "user", content: "responses follow up after format switch" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rebuilds action-only context across reverse API-format switch request ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "21212121-2121-4212-8212-212121212121";
  const secondRequestId = "22222222-2222-4222-8222-222222222222";
  const conversationId = "23232323-2323-4232-8232-232323232323";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          assert.equal(body.request.modelDetails.modelName, "responses-model");
          assert.equal(body.request.action.case, "userMessageAction");
          assert.equal(body.request.action.value.userMessage.text, "responses first question");
          return ndjsonResponse([
            { type: "text_delta", text: "responses first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "responses first question" },
            { role: "assistant", content: "responses first answer" },
            { role: "user", content: "chat follow up after format switch" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "chat answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({});
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModelIds: ["responses-model", "GLM-5.1-Coding"],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("RunSSE should stay local");
      },
    });

    const firstRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: firstRequestId,
        conversationId,
        modelDetails: { modelName: "responses-model" },
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "responses first question" },
          },
        },
      },
    );
    for await (const _message of firstRun.message) {
      // drain
    }

    const secondRun = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId: secondRequestId,
        conversationId,
        modelDetails: { modelName: "GLM-5.1-Coding" },
        messages: [{ role: "assistant", content: "responses first answer" }],
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "chat follow up after format switch" },
          },
        },
      },
    );
    for await (const _message of secondRun.message) {
      // drain
    }

    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "responses first question" },
      { role: "assistant", content: "responses first answer" },
      { role: "user", content: "chat follow up after format switch" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook ends Cursor turn after plan-mode CreatePlan completes", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const requestId = "abababab-abab-4aba-8aba-abababababab";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.request.composerMode, "plan");
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "plan-1",
            name: "CreatePlan",
            arguments: JSON.stringify({ name: "Plan", overview: "Overview", plan: "Body" }),
          },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        assert.equal(body.toolName, "CreatePlan");
        assert.equal(body.toolCallId, "plan-1");
        return jsonResponse({
          ok: true,
          result: {
            id: body.queryId,
            result: {
              case: "createPlanRequestResponse",
              // Binary decoder shape: the result oneof is wrapped twice.
              value: { result: { result: { case: "success", value: {} } } },
            },
          },
        });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    globalThis.__cursorByokRememberComposerMode(requestId, "plan");
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("plan-mode BYOK request should stay local");
      },
    });

    const stream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      { "x-request-id": requestId },
      { requestId, modelDetails: { modelName: "gpt55-sub2api" } },
    );
    const messages = [];
    for await (const message of stream.message) messages.push(message);

    const interactionQuery = messages.find((message) => message.message?.case === "interactionQuery");
    assert.notEqual(interactionQuery, undefined, "CreatePlan must surface an interactionQuery frame");
    assert.equal(interactionQuery.message.value.query.case, "createPlanRequestQuery");
    const completed = messages
      .map((message) => message.message?.case === "interactionUpdate" ? message.message.value.message : undefined)
      .find((update) => update?.case === "toolCallCompleted");
    assert.notEqual(completed, undefined, "CreatePlan must complete its tool call");
    assert.equal(completed.value.callId, "plan-1");
    assert.equal(completed.value.toolCall.tool.case, "createPlanToolCall");
    assert.equal(completed.value.toolCall.tool.value.result.result.case, "success");
    assert.equal(messages.at(-2).message.value.message.case, "stepCompleted");
    assert.equal(messages.at(-1).message.value.message.case, "turnEnded");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
  }
});

test("grey-box hook preserves last composer mode across reconnects without original request ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalModes = globalThis.__cursorByokComposerModesByRequestId;
  const originalLastMode = globalThis.__cursorByokLastComposerMode;
  const originalRememberMode = globalThis.__cursorByokRememberComposerMode;
  const firstRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const reconnectRequestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const editRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const runModes = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        runModes.push(body.request.composerMode);
        return ndjsonResponse([
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK request should stay local");
      },
    });

    for (const request of [
      { requestId: firstRequestId, composerMode: "plan", modelDetails: { modelName: "gpt55-sub2api" } },
      { requestId: reconnectRequestId, modelDetails: { modelName: "gpt55-sub2api" } },
      { requestId: editRequestId, composerMode: "normal", modelDetails: { modelName: "gpt55-sub2api" } },
    ]) {
      const stream = await wrapped.stream(
        { typeName: "agent.v1.AgentService" },
        { name: "RunSSE" },
        null,
        0,
        { "x-request-id": request.requestId },
        request,
      );
      for await (const _message of stream.message) {
        // Drain stream.
      }
    }

    assert.deepEqual(runModes, ["plan", "plan", "normal"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalModes === undefined) delete globalThis.__cursorByokComposerModesByRequestId;
    else globalThis.__cursorByokComposerModesByRequestId = originalModes;
    if (originalLastMode === undefined) delete globalThis.__cursorByokLastComposerMode;
    else globalThis.__cursorByokLastComposerMode = originalLastMode;
    if (originalRememberMode === undefined) delete globalThis.__cursorByokRememberComposerMode;
    else globalThis.__cursorByokRememberComposerMode = originalRememberMode;
  }
});

test("grey-box hook registers RunSSE native exec ids with the local session", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "59595959-5959-4595-8595-595959595959";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "read-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result") && body?.directOnly) {
        return jsonResponse({ ok: false, direct: false }, 404);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);
    const exec = messages.find((message) => message.message?.case === "execServerMessage").message.value;
    assert.equal(exec.id, 1);
    assert.equal(exec.execId, "read-1");
    assert.deepEqual(
      calls.filter((call) => call.url.endsWith("/byok/exec-map")).map((call) => call.body),
      [{ requestId, id: 1, execId: "read-1", toolCallId: "read-1" }],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook peeks Connect RunSSE async iterable input before routing", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "91919191-9191-4919-8919-919191919191";
  const officialRequestId = "81818181-8181-4818-8818-818181818181";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.modelDetails?.modelName === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const upstreamInputs = [];
    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async (...args) => {
        const input = args[5];
        const seen = [];
        for await (const item of input) seen.push(item);
        upstreamInputs.push(seen);
        return { upstream: true };
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const runService = { typeName: "agent.v1.AgentService" };
    const runMethod = { name: "RunSSE" };

    const byokStream = await wrapped.stream(
      runService,
      runMethod,
      null,
      0,
      {},
      asyncIterable([{ requestId, modelDetails: { modelName: "gpt55-sub2api" } }]),
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);
    assert.equal(messages[0].message.value.message.case, "textDelta");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.modelDetails.modelName, "gpt55-sub2api");
    assert.equal(upstreamInputs.length, 0);

    const officialStream = await wrapped.stream(
      runService,
      runMethod,
      null,
      0,
      {},
      asyncIterable([{ requestId: officialRequestId, modelDetails: { modelName: "gpt-4.1" } }]),
    );
    assert.deepEqual(officialStream, { upstream: true });
    assert.deepEqual(upstreamInputs, [[{ requestId: officialRequestId, modelDetails: { modelName: "gpt-4.1" } }]]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook routes AgentService Run bidi stream locally from first runRequest frame", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "51515151-5151-4515-8515-515151515151";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.requestedModel?.modelId === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, requestId);
        assert.equal(body.request.requestedModel.modelId, "gpt55-sub2api");
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "tool_use_done", id: "read-1", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":4,\"limit\":5}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          direct: true,
          result: {
            execId: body.toolCallId,
            _byokDirectTool: true,
            message: {
              case: "readResult",
              value: {
                result: {
                  case: "success",
                  value: {
                    path: body.toolArguments.path,
                    output: { case: "content", value: "ok" },
                    readRange: { startLine: 5, endLine: 9 },
                  },
                },
              },
            },
          },
        });
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const upstreamInputs = [];
    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async (...args) => {
        const input = args[5];
        const seen = [];
        for await (const item of input) seen.push(item);
        upstreamInputs.push(seen);
        return { upstream: true };
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const runRequest = {
      toJson: () => ({
        conversationId: "conv-run",
        modelDetails: { modelId: "gpt55-sub2api" },
        requestedModel: { modelId: "gpt55-sub2api" },
      }),
    };
    const firstFrame = {
      message: {
        case: "runRequest",
        value: runRequest,
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      asyncIterable([firstFrame]),
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.equal(upstreamInputs.length, 0);
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.requestedModel.modelId, "gpt55-sub2api");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.requestedModel.modelId, "gpt55-sub2api");
    assert.equal(messages[0].message.value.message.case, "textDelta");
    assert.equal(messages[1].message.value.message.case, "toolCallStarted");
    assert.equal(messages[2].message.value.message.case, "toolCallCompleted");
    assert.equal(messages[2].message.value.message.value.toolCall.tool.value.result.result.case, "success");
    assert.equal(calls.some((call) => call.url.endsWith("/byok/exec-map")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook routes AgentService Run locally when heartbeat precedes runRequest", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "54525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.selectedModels?.[0]?.modelId === "GLM-5.1-Coding" });
      }
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, requestId);
        assert.equal(body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "model-n1tgsf", displayName: "GLM-5.1-Coding" }],
    });
    const upstreamInputs = [];
    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async (...args) => {
        const input = args[5];
        const seen = [];
        for await (const item of input) seen.push(item);
        upstreamInputs.push(seen);
        return { upstream: true };
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      asyncIterable([
        { message: { case: "clientHeartbeat", value: {} } },
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }],
              messages: [{ role: "user", content: "implement plan" }],
            },
          },
        },
      ]),
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.equal(upstreamInputs.length, 0);
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
    assert.equal(messages[0].message.value.message.case, "textDelta");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook wraps context-rpc AgentService Run client before upstream stream starts", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const requestId = "56525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.selectedModels?.[0]?.modelId === "GLM-5.1-Coding" });
      }
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, requestId);
        assert.equal(body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "model-n1tgsf", displayName: "GLM-5.1-Coding" }],
    });

    let upstreamRunCount = 0;
    const wrapped = globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("context-rpc BYOK AgentService Run must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });

    const messages = [];
    for await (const message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        { message: { case: "clientHeartbeat", value: {} } },
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }],
              messages: [{ role: "user", content: "implement plan" }],
            },
          },
        },
      ]),
      { headers: { "x-request-id": requestId } },
    )) {
      messages.push(message);
    }

    assert.equal(upstreamRunCount, 0);
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.selectedModels[0].modelId, "GLM-5.1-Coding");
    assert.equal(messages[0].message.value.message.case, "textDelta");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
  }
});

test("grey-box hook preserves action-only context across provider switch in context-rpc AgentService Run client", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "27272727-2727-4272-8272-272727272727";
  const secondRequestId = "28282828-2828-4282-8282-282828282828";
  const conversationId = "29292929-2929-4292-8292-292929292929";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "anthropic first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "anthropic context-rpc first question" },
            { role: "assistant", content: "anthropic first answer" },
            { role: "user", content: "chat context-rpc follow up" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "chat second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    let upstreamRunCount = 0;
    const wrapped = globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("context-rpc provider switch must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "anthropic context-rpc first question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "GLM-5.1-Coding" },
              messages: [{ role: "assistant", content: "anthropic first answer" }],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "chat context-rpc follow up" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "anthropic context-rpc first question" },
      { role: "assistant", content: "anthropic first answer" },
      { role: "user", content: "chat context-rpc follow up" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook restores persisted action-only context after hook reload in context-rpc AgentService Run client", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const originalLocalStorage = globalThis.localStorage;
  const firstRequestId = "2a2a2a2a-2a2a-42a2-82a2-2a2a2a2a2a2a";
  const secondRequestId = "2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b";
  const conversationId = "2c2c2c2c-2c2c-42c2-82c2-2c2c2c2c2c2c";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("reloaded context-rpc request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.localStorage = mockLocalStorage();
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "persisted first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "persisted context-rpc first question" },
            { role: "assistant", content: "persisted first answer" },
            { role: "user", content: "what was my previous question?" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "restored second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    let wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "persisted context-rpc first question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    const persistedEntries = JSON.parse(globalThis.localStorage.getItem("cursorByok.conversationContext.v1"));
    assert.deepEqual(persistedEntries[conversationId].request.messages, [
      { role: "user", content: "persisted context-rpc first question" },
      { role: "assistant", content: "persisted first answer" },
    ]);

    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "GLM-5.1-Coding" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "what was my previous question?" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "persisted context-rpc first question" },
      { role: "assistant", content: "persisted first answer" },
      { role: "user", content: "what was my previous question?" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test("grey-box hook rebuilds missing request history from visible composer transcript DOM", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const originalDocument = globalThis.document;
  const requestId = "3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a";
  const conversationId = "3b3b3b3b-3b3b-43b3-83b3-3b3b3b3b3b3b";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("visible DOM transcript request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.document = mockComposerTranscriptDocument([
      {
        user: "For the code present, we get this error: missing method",
        assistant: ["The method is only referenced in the test file and never defined."],
      },
    ]);
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        assert.deepEqual(body.request.messages, [
          { role: "user", content: "For the code present, we get this error: missing method" },
          { role: "assistant", content: "The method is only referenced in the test file and never defined." },
          { role: "user", content: "我上一个问题是什么" },
        ]);
        return ndjsonResponse([
          { type: "text_delta", text: "你上一个问题是上面的缺失方法问题。" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [{ role: "user", content: "我上一个问题是什么" }],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "我上一个问题是什么" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": requestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const shouldHandle = calls.find((call) => call.url.endsWith("/byok/should-handle"));
    assert.deepEqual(shouldHandle.body.request.messages, [
      { role: "user", content: "For the code present, we get this error: missing method" },
      { role: "assistant", content: "The method is only referenced in the test file and never defined." },
      { role: "user", content: "我上一个问题是什么" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("grey-box hook prefers visible composer transcript DOM over stale persisted BYOK context", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const originalDocument = globalThis.document;
  const requestId = "3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c";
  const conversationId = "3d3d3d3d-3d3d-43d3-83d3-3d3d3d3d3d3d";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("visible DOM transcript must win over stale cache");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.__cursorByokConversationContextById = new Map([
      [conversationId, {
        request: {
          messages: [
            { role: "user", content: "我上一个问题是什么" },
            { role: "assistant", content: "这是我们对话的第一条消息。" },
          ],
        },
        updatedAt: Date.now(),
      }],
    ]);
    globalThis.document = mockComposerTranscriptDocument([
      {
        user: "For the code present, we get this error: missing method",
        assistant: ["The method is only referenced in the test file and never defined."],
      },
    ]);
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        assert.deepEqual(body.request.messages, [
          { role: "user", content: "For the code present, we get this error: missing method" },
          { role: "assistant", content: "The method is only referenced in the test file and never defined." },
          { role: "user", content: "我上一个问题是什么" },
        ]);
        return ndjsonResponse([
          { type: "text_delta", text: "你上一个问题是上面的缺失方法问题。" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [{ role: "user", content: "我上一个问题是什么" }],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "我上一个问题是什么" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": requestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const shouldHandle = calls.find((call) => call.url.endsWith("/byok/should-handle"));
    assert.deepEqual(shouldHandle.body.request.messages, [
      { role: "user", content: "For the code present, we get this error: missing method" },
      { role: "assistant", content: "The method is only referenced in the test file and never defined." },
      { role: "user", content: "我上一个问题是什么" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("grey-box hook resets persisted transcript when visible messages roll back to an earlier checkpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "41414141-4141-4414-8414-414141414141";
  const secondRequestId = "42424242-4242-4424-8424-424242424242";
  const thirdRequestId = "43434343-4343-4434-8434-434343434343";
  const conversationId = "44444444-4444-4444-8444-444444444444";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("rollback transcript request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "first checkpoint answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "abandoned branch answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === thirdRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "first checkpoint question" },
            { role: "assistant", content: "first checkpoint answer" },
            { role: "user", content: "question after rollback" },
          ]);
          assert.equal(body.request.action?.value?.userMessage?.text, "question after rollback");
          return ndjsonResponse([
            { type: "text_delta", text: "answer after rollback" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "first checkpoint question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "abandoned branch question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "first checkpoint question" },
                { role: "assistant", content: "first checkpoint answer" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question after rollback" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": thirdRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const thirdShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(thirdShouldHandle.body.request.messages, [
      { role: "user", content: "first checkpoint question" },
      { role: "assistant", content: "first checkpoint answer" },
      { role: "user", content: "question after rollback" },
    ]);
    assert.equal(thirdShouldHandle.body.request.action?.value?.userMessage?.text, "question after rollback");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook trims hidden rollback branches even when visible messages omit prior action-only user entries", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "45454545-4545-4454-8454-454545454545";
  const secondRequestId = "46464646-4646-4464-8464-464646464646";
  const thirdRequestId = "47474747-4747-4474-8474-474747474747";
  const fourthRequestId = "48484848-4848-4484-8484-484848484848";
  const conversationId = "49494949-4949-4494-8494-494949494949";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("rollback subsequence request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "how should I handle changes?" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "rollback complete" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === thirdRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "rollback task" },
            { role: "assistant", content: "how should I handle changes?" },
            { role: "user", content: "discard changes" },
            { role: "assistant", content: "rollback complete" },
            { role: "user", content: "abandoned branch question" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "abandoned branch answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === fourthRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "rollback task" },
            { role: "assistant", content: "how should I handle changes?" },
            { role: "user", content: "discard changes" },
            { role: "assistant", content: "rollback complete" },
            { role: "user", content: "question after rollback" },
          ]);
          assert.equal(body.request.action?.value?.userMessage?.text, "question after rollback");
          return ndjsonResponse([
            { type: "text_delta", text: "answer after rollback" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "rollback task" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "rollback task" },
                { role: "assistant", content: "how should I handle changes?" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "discard changes" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "rollback task" },
                { role: "assistant", content: "how should I handle changes?" },
                { role: "assistant", content: "rollback complete" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "abandoned branch question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": thirdRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "rollback task" },
                { role: "assistant", content: "how should I handle changes?" },
                { role: "assistant", content: "rollback complete" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question after rollback" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": fourthRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const fourthShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(fourthShouldHandle.body.request.messages, [
      { role: "user", content: "rollback task" },
      { role: "assistant", content: "how should I handle changes?" },
      { role: "user", content: "discard changes" },
      { role: "assistant", content: "rollback complete" },
      { role: "user", content: "question after rollback" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rebuilds inline historical user edits from visible message order", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d";
  const secondRequestId = "4e4e4e4e-4e4e-44e4-84e4-4e4e4e4e4e4e";
  const thirdRequestId = "4f4f4f4f-4f4f-44f4-84f4-4f4f4f4f4f4f";
  const fourthRequestId = "50505050-5050-4050-8050-505050505050";
  const conversationId = "51515151-5151-4151-8151-515151515151";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("inline historical edit request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer one" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer two" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === thirdRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer three" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === fourthRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "question one" },
            { role: "assistant", content: "answer one" },
            { role: "user", content: "question two rewritten" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "rewritten answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question one" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question two" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
                { role: "user", content: "question two" },
                { role: "assistant", content: "answer two" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question three" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": thirdRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
                { role: "user", content: "question two rewritten" },
              ],
            },
          },
        },
      ]),
      { headers: { "x-request-id": fourthRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const fourthShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(fourthShouldHandle.body.request.messages, [
      { role: "user", content: "question one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "question two rewritten" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook rewrites inline latest visible user message without carrying abandoned tail", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "52525252-5252-4252-8252-525252525252";
  const secondRequestId = "53535353-5353-4353-8353-535353535353";
  const thirdRequestId = "54545454-5454-4454-8454-545454545454";
  const conversationId = "55555555-5555-4555-8555-555555555555";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("inline latest edit request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer one" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer two" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === thirdRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "question one" },
            { role: "assistant", content: "answer one" },
            { role: "user", content: "question two rewritten" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "rewritten answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question one" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question two" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
                { role: "user", content: "question two rewritten" },
              ],
            },
          },
        },
      ]),
      { headers: { "x-request-id": thirdRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const thirdShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(thirdShouldHandle.body.request.messages, [
      { role: "user", content: "question one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "question two rewritten" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook preserves rewritten latest user message when the rewrite adds an image block", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "56565656-5656-4656-8656-565656565656";
  const secondRequestId = "57575757-5757-4757-8757-575757575757";
  const thirdRequestId = "58585858-5858-4858-8858-585858585858";
  const conversationId = "59595959-5959-4959-8959-595959595959";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("inline image rewrite request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer one" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "answer two" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === thirdRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "question one" },
            { role: "assistant", content: "answer one" },
            {
              role: "user",
              content: [
                { type: "text", text: "question two" },
                { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
              ],
            },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "answer two with image" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question one" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "question two" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "question one" },
                { role: "assistant", content: "answer one" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: {
                    content: [
                      { type: "text", text: "question two" },
                      { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
                    ],
                  },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": thirdRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const thirdShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(thirdShouldHandle.body.request.messages, [
      { role: "user", content: "question one" },
      { role: "assistant", content: "answer one" },
      {
        role: "user",
        content: [
          { type: "text", text: "question two" },
          { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook extracts current user text from structured action userMessage content", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "4a4a4a4a-4a4a-44a4-84a4-4a4a4a4a4a4a";
  const secondRequestId = "4b4b4b4b-4b4b-44b4-84b4-4b4b4b4b4b4b";
  const conversationId = "4c4c4c4c-4c4c-44c4-84c4-4c4c4c4c4c4c";
  const calls = [];
  let upstreamRunCount = 0;

  function wrappedAgentClient() {
    return globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("structured action userMessage request must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });
  }

  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    delete globalThis.__cursorByokConversationContextById;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "follow up from content blocks" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "second answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = wrappedAgentClient();

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "first question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "sonnet46-dario" },
              messages: [
                { role: "user", content: "first question" },
                { role: "assistant", content: "first answer" },
              ],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: {
                    content: [
                      { type: "text", text: "follow up from content blocks" },
                    ],
                  },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up from content blocks" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook preserves action-only context across API-format switch in context-rpc AgentService Run client", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const originalConversationContext = globalThis.__cursorByokConversationContextById;
  const firstRequestId = "30303030-3030-4030-8030-303030303030";
  const secondRequestId = "31313131-3131-4131-8131-313131313131";
  const conversationId = "32323232-3232-4232-8232-323232323232";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        if (body.requestId === firstRequestId) {
          return ndjsonResponse([
            { type: "text_delta", text: "responses first answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
        if (body.requestId === secondRequestId) {
          assert.equal(body.request.modelDetails.modelName, "GLM-5.1-Coding");
          assert.deepEqual(body.request.messages, [
            { role: "user", content: "responses context-rpc first question" },
            { role: "assistant", content: "responses first answer" },
            { role: "user", content: "chat context-rpc format follow up" },
          ]);
          return ndjsonResponse([
            { type: "text_delta", text: "chat answer" },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          ]);
        }
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModelIds: ["responses-model", "GLM-5.1-Coding"],
    });
    let upstreamRunCount = 0;
    const wrapped = globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("context-rpc API-format switch must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "responses-model" },
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "responses context-rpc first question" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": firstRequestId } },
    )) {
      // drain
    }

    for await (const _message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId,
              modelDetails: { modelName: "GLM-5.1-Coding" },
              messages: [{ role: "assistant", content: "responses first answer" }],
              action: {
                case: "userMessageAction",
                value: {
                  userMessage: { text: "chat context-rpc format follow up" },
                },
              },
            },
          },
        },
      ]),
      { headers: { "x-request-id": secondRequestId } },
    )) {
      // drain
    }

    assert.equal(upstreamRunCount, 0);
    const secondShouldHandle = calls.filter((call) => call.url.endsWith("/byok/should-handle")).at(-1);
    assert.deepEqual(secondShouldHandle.body.request.messages, [
      { role: "user", content: "responses context-rpc first question" },
      { role: "assistant", content: "responses first answer" },
      { role: "user", content: "chat context-rpc format follow up" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
    if (originalConversationContext === undefined) delete globalThis.__cursorByokConversationContextById;
    else globalThis.__cursorByokConversationContextById = originalConversationContext;
  }
});

test("grey-box hook hydrates plan build runRequest from context-rpc run options before BYOK routing", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const requestId = "57525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        assert.equal(body?.request?.isPlanExecution, true);
        assert.equal(body?.request?.modelOverride, "GLM-5.1-Coding");
        assert.equal(body?.request?.action?.case, "executePlanAction");
        assert.equal(body?.request?.action?.value?.planFileContent, "# plan");
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "model-n1tgsf", displayName: "GLM-5.1-Coding" }],
    });

    let upstreamRunCount = 0;
    const wrapped = globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("hydrated plan build must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });

    const messages = [];
    for await (const message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-plan",
            },
          },
        },
      ]),
      {
        headers: { "x-request-id": requestId },
        isPlanExecution: true,
        modelOverride: "GLM-5.1-Coding",
        modelConfig: { modelName: "default" },
        conversationActionOverride: {
          action: {
            case: "executePlanAction",
            value: { planFileContent: "# plan" },
          },
        },
      },
    )) {
      messages.push(message);
    }

    assert.equal(upstreamRunCount, 0);
    assert.equal(
      messages.some((message) => message.message?.value?.message?.case === "textDelta"),
      true,
      "BYOK run must surface text deltas to the UI stream",
    );
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
  }
});

test("grey-box hook hydrates protobuf-json executePlanAction run options before BYOK routing", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapAgentClient;
  const requestId = "57525252-5252-4525-8525-525252525253";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapAgentClient;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        assert.equal(body?.request?.isPlanExecution, true);
        assert.equal(body?.request?.modelOverride, "GLM-5.1-Coding");
        assert.equal(body?.request?.action?.case, "executePlanAction");
        assert.equal(body?.request?.action?.value?.planFileContent, "# protobuf-json plan");
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "model-n1tgsf", displayName: "GLM-5.1-Coding" }],
    });

    let upstreamRunCount = 0;
    const wrapped = globalThis.__cursorByokWrapAgentClient({
      async *run() {
        upstreamRunCount++;
        yield* [];
        throw new Error("hydrated protobuf-json plan build must not reach upstream");
      },
    }, {
      methods: {
        run: {
          O: {
            fromJson(value) {
              return value;
            },
          },
        },
      },
    });

    const messages = [];
    for await (const message of wrapped.run(
      { withName() { return this; } },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-plan-json",
            },
          },
        },
      ]),
      {
        headers: { "x-request-id": requestId },
        isPlanExecution: true,
        modelOverride: "GLM-5.1-Coding",
        modelConfig: { modelName: "default" },
        conversationActionOverride: {
          executePlanAction: {
            planFileContent: "# protobuf-json plan",
          },
        },
      },
    )) {
      messages.push(message);
    }

    assert.equal(upstreamRunCount, 0);
    assert.equal(
      messages.some((message) => message.message?.value?.message?.case === "textDelta"),
      true,
      "BYOK run must surface text deltas to the UI stream",
    );
    assert.equal(calls.some((call) => call.url.endsWith("/byok/run")), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapAgentClient;
    else globalThis.__cursorByokWrapAgentClient = originalWrap;
  }
});

test("grey-box hook routes plan-execution selectedModels when modelName stays default", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "57525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.modelConfig?.selectedModels?.[0]?.modelId === "GLM-5.1-Coding" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "building plan" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{ id: "model-n1tgsf", displayName: "GLM-5.1-Coding" }],
    });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("plan-execution BYOK request should stay local");
      },
    });
    const stream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      { "x-request-id": requestId },
      {
        conversationId: "conv-plan-exec",
        modelConfig: {
          modelName: "default",
          selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }],
        },
        messages: [{ role: "user", content: "build plan" }],
      },
    );
    const messages = [];
    for await (const message of stream.message) messages.push(message);
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.modelConfig.selectedModels[0].modelId, "GLM-5.1-Coding");
    assert.equal(messages[0].message.value.message.case, "textDelta");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook forwards AgentService Run conversationAction frames to the local session", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "52525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        },
        {
          message: {
            case: "conversationAction",
            value: {
              action: {
                case: "userMessageAction",
                value: { userMessage: { text: "delayed user prompt", messageId: "msg-1" } },
              },
            },
          },
        },
      ]),
    );
    for await (const _message of byokStream.message) {
      void _message;
    }
    await new Promise((resolve) => setImmediate(resolve));

    const localClientCall = calls.find((call) =>
      call.url.endsWith("/byok/local-client-message") && call.body?.message?.case === "conversationAction"
    );
    assert.equal(localClientCall?.body?.requestId, requestId);
    assert.equal(localClientCall?.body?.message?.case, "conversationAction");
    assert.equal(localClientCall?.body?.message?.value?.action?.value?.userMessage?.text, "delayed user prompt");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook forwards subsequent AgentService Run runRequest frames to the local session", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "53525252-5252-4525-8525-525252525252";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      asyncIterable([
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        },
        {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              messages: [{ role: "user", content: "delayed user prompt" }],
            },
          },
        },
      ]),
    );
    for await (const _message of byokStream.message) {
      void _message;
    }
    await new Promise((resolve) => setImmediate(resolve));

    const runRequestCall = calls.find((call) =>
      call.url.endsWith("/byok/local-client-message") &&
      call.body?.message?.case === "runRequest" &&
      Array.isArray(call.body?.message?.value?.messages)
    );
    assert.equal(runRequestCall?.body?.requestId, requestId);
    assert.deepEqual(runRequestCall?.body?.message?.value?.messages, [
      { role: "user", content: "delayed user prompt" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook commits a cancelled BYOK turn without emitting a duplicate stepCompleted", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "6c6c6c6c-6c6c-46c6-8c6c-6c6c6c6c6c6c";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "text_delta", text: "editing" },
          { type: "done", stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId,
        requestedModel: { modelId: "gpt55-sub2api" },
        messages: [{ role: "user", content: "cancel me" }],
      },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);
    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "textDelta",
      "turnEnded",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook ends a cancelled BYOK turn without waiting for unresolved native tool completion", { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "7c7c7c7c-7c7c-47c7-8c7c-7c7c7c7c7c7c";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "write-1",
            name: "Write",
            arguments: JSON.stringify({ path: "/tmp/cancelled-write.txt", contents: "alpha\n" }),
          },
          { type: "done", stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });

    const startedAt = Date.now();
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      {
        requestId,
        requestedModel: { modelId: "gpt55-sub2api" },
      },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert(Date.now() - startedAt < 2000);
    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "toolCallStarted",
      "writeArgs",
      "turnEnded",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook routes BYOK RunSSE by direct model even when requestId is absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.modelDetails?.modelName === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        assert.equal(body.requestId, "");
        assert.equal(body.request.modelDetails.modelName, "gpt55-sub2api");
        return ndjsonResponse([
          { type: "text_delta", text: "pong" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const transport = {
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK RunSSE without requestId must not fall through to upstream");
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      asyncIterable([{ modelDetails: { modelName: "gpt55-sub2api" } }]),
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.equal(messages[0].message.value.message.case, "textDelta");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/should-handle")).body.request.modelDetails.modelName, "gpt55-sub2api");
    assert.equal(calls.find((call) => call.url.endsWith("/byok/run")).body.request.modelDetails.modelName, "gpt55-sub2api");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});
