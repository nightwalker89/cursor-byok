"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
} = require("../src/workbench-hook");
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
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, runRequestComposerMode, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
} = require("../src/server/provider-adapter");
const { protoMessage, fieldMessage, fieldString, structStringValue, jsonResponse, writeMcpCacheTool, approvedSwitchModeInteractionResponse, assertIncludesAll, quietLog, recordingLog, useHome, asyncIterable, interceptModule } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("normalizeRunRequestForProvider preserves decoded Cursor composer mode", () => {
  assert.equal(runRequestComposerMode({ field6_conversationState: { mode: "plan" } }), "plan");
  assert.equal(runRequestComposerMode({ conversationState: { mode: "agent" } }), "agent");
  assert.equal(runRequestComposerMode({ mode: "edit", field6_conversationState: { mode: "plan" } }), "edit");
  assert.equal(runRequestComposerMode({ composerMode: "plan", mode: "edit" }), "plan");

  const normalized = normalizeRunRequestForProvider({
    field6_conversationState: { mode: "plan" },
    messages: [{ role: "user", content: "design it" }],
  });

  assert.equal(normalized.composerMode, "plan");
});

test("normalizeRunRequestForProvider appends current action user message after assistant-ended history", () => {
  const normalized = normalizeRunRequestForProvider({
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    action: {
      case: "userMessageAction",
      value: {
        userMessage: { text: "follow up question" },
      },
    },
  });

  assert.deepEqual(normalized.messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow up question" },
  ]);
});

test("normalizeRunRequestForProvider does not duplicate visible user messages already present in history", () => {
  const normalized = normalizeRunRequestForProvider({
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up question" },
    ],
    action: {
      case: "userMessageAction",
      value: {
        userMessage: { text: "follow up question" },
      },
    },
  });

  assert.deepEqual(normalized.messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow up question" },
  ]);
});

test("normalizeRunRequestForProvider preserves structured action userMessage content when it includes images", () => {
  const normalized = normalizeRunRequestForProvider({
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    action: {
      case: "userMessageAction",
      value: {
        userMessage: {
          content: [
            { type: "text", text: "follow up question" },
            { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
          ],
        },
      },
    },
  });

  assert.deepEqual(normalized.messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    {
      role: "user",
      content: [
        { type: "text", text: "follow up question" },
        { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
      ],
    },
  ]);
});

test("normalizeRunRequestForProvider preserves native image blocks in structured action userMessage content", () => {
  const normalized = normalizeRunRequestForProvider({
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    action: {
      case: "userMessageAction",
      value: {
        userMessage: {
          content: [
            { type: "text", text: "follow up question" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
          ],
        },
      },
    },
  });

  assert.deepEqual(normalized.messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    {
      role: "user",
      content: [
        { type: "text", text: "follow up question" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
      ],
    },
  ]);
});

test("grey-box server waits for AgentService Run conversationAction before calling provider", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-delayed-run-action-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  let adapterRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ request }) {
        adapterRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = "53535353-5353-4535-8535-535353535353";
    const runResponse = fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        request: {
          conversationId: "conv-delayed",
          modelDetails: { modelId: "byok-model" },
          requestedModel: { modelId: "byok-model" },
        },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await fetch(`http://127.0.0.1:${port}/byok/local-client-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        message: {
          case: "conversationAction",
          value: {
            action: {
              case: "userMessageAction",
              value: { userMessage: { text: "delayed server prompt", messageId: "msg-1" } },
            },
          },
        },
      }),
    });
    const response = await runResponse;
    assert.equal(response.status, 200);
    await response.text();

    assert.deepEqual(adapterRequest.messages, [{ role: "user", content: "delayed server prompt" }]);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server appends current action user message before provider execution when history ends with assistant", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-inline-action-history-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  let adapterRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ request }) {
        adapterRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a",
        request: {
          conversationId: "conv-inline-action-history",
          requestedModel: { modelId: "byok-model" },
          modelDetails: { modelId: "byok-model" },
          messages: [
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
          ],
          action: {
            case: "userMessageAction",
            value: {
              userMessage: { text: "follow up question" },
            },
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(adapterRequest.messages, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up question" },
    ]);
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server returns a provider-visible tool error when native exec result is missing", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-missing-tool-result-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const logs = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: {
      info(message, fields) {
        logs.push({ level: "info", message, fields });
      },
      warn(message, fields) {
        logs.push({ level: "warn", message, fields });
      },
      error(message, fields) {
        logs.push({ level: "error", message, fields });
      },
    },
    providerAdapter: {
      async *run({ waitForToolResult }) {
        yield { type: "tool_use_done", id: "read-missing", name: "Read", arguments: { path: "/tmp/missing" } };
        const result = await waitForToolResult("read-missing", { toolName: "Read", timeoutMs: 1 });
        yield { type: "text_delta", text: stringifyToolResultForProvider(result) };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "57575757-5757-4575-8575-575757575757",
        request: {
          conversationId: "conv-missing-tool",
          requestedModel: { modelId: "byok-model" },
          modelDetails: { modelId: "byok-model" },
          messages: [{ role: "user", content: "read missing" }],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"type":"text_delta"/);
    assert.match(body, /Timed out waiting for Cursor Read result read-missing/);
    assert.equal(logs.some((entry) =>
      entry.level === "warn" &&
      entry.message === "BYOK Cursor exec result timed out" &&
      entry.fields.toolCallId === "read-missing"
    ), true);
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server turns provider exceptions after NDJSON starts into terminal BYOK events", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-provider-throw-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const logs = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: {
      info(message, fields) {
        logs.push({ level: "info", message, fields });
      },
      warn(message, fields) {
        logs.push({ level: "warn", message, fields });
      },
      error(message, fields) {
        logs.push({ level: "error", message, fields });
      },
    },
    providerAdapter: {
      run() {
        throw new Error("upstream 401");
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "58585858-5858-4585-8585-585858585858",
        request: {
          conversationId: "conv-provider-throw",
          requestedModel: { modelId: "byok-model" },
          modelDetails: { modelId: "byok-model" },
          messages: [{ role: "user", content: "trigger upstream error" }],
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["meta", "text_delta", "done"]);
    assert.match(events[1].text, /BYOK provider failed: upstream 401/);
    assert.equal(events[2].stopReason, "error");
    assert.equal(logs.some((entry) =>
      entry.level === "error" &&
      entry.message === "BYOK local run failed after stream started" &&
      entry.fields.requestId === "58585858-5858-4585-8585-585858585858" &&
      entry.fields.eventsWritten === 0
    ), true);
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server formats upstream stream termination as a retryable provider failure", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-provider-terminated-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: recordingLog(),
    providerAdapter: {
      async *run() {
        yield { type: "text_delta", text: "partial" };
        throw new Error("terminated");
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "59595959-5959-4595-9595-595959595959",
        request: {
          conversationId: "conv-provider-terminated",
          requestedModel: { modelId: "byok-model" },
          modelDetails: { modelId: "byok-model" },
          messages: [{ role: "user", content: "trigger upstream termination" }],
        },
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["meta", "text_delta", "text_delta", "done"]);
    assert.match(events[2].text, /upstream stream closed unexpectedly/);
    assert.equal(events[3].stopReason, "error");
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("server rejects BYOK runs without provider input before calling upstream", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-empty-input-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const log = recordingLog();
  let providerCalls = 0;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log,
    providerAdapter: {
      async *run() {
        providerCalls++;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
  });
  try {
    server.sessions.waitForRunRequest = async () => null;
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "56565656-5656-4565-8565-565656565656",
        request: {
          conversationId: "conv-empty",
          modelDetails: { modelId: "byok-model" },
          requestedModel: { modelId: "byok-model" },
        },
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "provider-input-not-found",
      requestId: "56565656-5656-4565-8565-565656565656",
    });
    assert.equal(providerCalls, 0);
    assert.equal(log.entries.some((entry) =>
      entry.level === "warn" &&
      entry.message === "BYOK local run rejected" &&
      entry.fields.requestId === "56565656-5656-4565-8565-565656565656" &&
      entry.fields.reason === "provider-input-not-found" &&
      entry.fields.modelId === "byok-model"
    ), true);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("server should-handle returns false when BYOK model is known but provider input never arrives", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-empty-should-handle-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  try {
    server.sessions.waitForRunRequest = async () => null;
    await server.start();
    const port = server.server.address().port;
    const requestId = "57575757-5757-4575-8575-575757575757";
    const response = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        request: {
          conversationId: "conv-empty",
          modelDetails: { modelId: "byok-model" },
          requestedModel: { modelId: "byok-model" },
        },
      }),
    });

    assert.deepEqual(await response.json(), {
      handle: false,
      reason: "provider-input-not-found",
      requestId,
      modelId: "byok-model",
    });
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server decodes BidiAppend runRequest and streams BYOK provider events", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-server-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  const providerAdapter = {
    async *run({ request, requestId }) {
      assert.equal(requestId, "77777777-7777-4777-8777-777777777777");
      assert.equal(request.requestedModel.modelId, "byok-model");
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter,
  });
  try {
    await server.start();
    const port = server.server.address().port;
	    const requestId = "77777777-7777-4777-8777-777777777777";
	    const userMessage = protoMessage([fieldString(1, "stream provider events"), fieldString(2, "msg-stream")]);
	    const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
	    const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
	    const runRequest = protoMessage([
	      fieldMessage(2, conversationAction),
	      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
	      fieldString(5, "conv-1"),
	      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    const bidiResponse = await fetch(`http://127.0.0.1:${port}/byok/bidi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        json: {
          requestId: { requestId },
          dataBinary: clientMessage.toString("base64"),
        },
      }),
    });
    const bidiJson = await bidiResponse.json();
    assert.equal(bidiJson.messageCase, "runRequest");
    assert.equal(bidiJson.handle, true);

    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    assert.equal((await shouldHandle.json()).handle, true);

    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    const text = await run.text();
    assert.match(text, /"type":"meta"/);
    assert.match(text, /"text":"ok"/);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server merges later Run runRequest frames before local BYOK execution", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-server-delayed-run-request-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  let adapterRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ request }) {
        adapterRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = "78787878-7878-4787-8787-787878787878";
    const runResponse = fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        request: {
          conversationId: "conv-delayed-run-request",
          modelDetails: { modelId: "byok-model" },
          requestedModel: { modelId: "byok-model" },
        },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const localRunRequest = await fetch(`http://127.0.0.1:${port}/byok/local-client-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        message: {
          case: "runRequest",
          value: {
            conversationId: "conv-delayed-run-request",
            messages: [{ role: "user", content: "late user text" }],
          },
        },
      }),
    });
    assert.equal(localRunRequest.status, 200);
    const response = await runResponse;
    assert.equal(response.status, 200);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(adapterRequest?.messages, [{ role: "user", content: "late user text" }]);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server waits briefly for richer later Run runRequest history even when the initial request already has current user input", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-server-richer-run-request-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  let adapterRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ request }) {
        adapterRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = "8a8a8a8a-8a8a-48a8-88a8-8a8a8a8a8a8a";
    const runResponse = fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        request: {
          conversationId: "conv-richer-run-request",
          modelDetails: { modelId: "byok-model" },
          requestedModel: { modelId: "byok-model" },
          messages: [{ role: "user", content: "current user text" }],
          action: {
            case: "userMessageAction",
            value: { userMessage: { text: "current user text" } },
          },
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const localRunRequest = await fetch(`http://127.0.0.1:${port}/byok/local-client-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        message: {
          case: "runRequest",
          value: {
            conversationId: "conv-richer-run-request",
            messages: [
              { role: "user", content: "previous user text" },
              { role: "assistant", content: "previous assistant text" },
              { role: "user", content: "current user text" },
            ],
            action: {
              case: "userMessageAction",
              value: { userMessage: { text: "current user text" } },
            },
          },
        },
      }),
    });
    assert.equal(localRunRequest.status, 200);
    const response = await runResponse;
    assert.equal(response.status, 200);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(adapterRequest?.messages, [
      { role: "user", content: "previous user text" },
      { role: "assistant", content: "previous assistant text" },
      { role: "user", content: "current user text" },
    ]);
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server forwards decoded system prompt user text and tools to provider adapter", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-decoded-prompt-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  fs.writeFileSync(providersPath(), JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "byok-model", apiModel: "byok-api" }],
    }],
  }));
  let adapterRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ request }) {
        adapterRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 0 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = "99999999-9999-4999-8999-999999999999";
    const toolSchema = protoMessage([fieldMessage(1, structStringValue("type", "OBJECT"))]);
    const toolDefinition = protoMessage([
      fieldString(1, "user-filesystem-read_file"),
      fieldString(2, "Read files"),
      fieldMessage(3, toolSchema),
      fieldString(4, "user-filesystem"),
      fieldString(5, "read_file"),
    ]);
    const mcpTools = protoMessage([fieldMessage(1, toolDefinition)]);
    const userMessage = protoMessage([fieldString(1, "hello from user"), fieldString(2, "msg-1")]);
    const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
    const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
    const runRequest = protoMessage([
      fieldMessage(2, conversationAction),
      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
      fieldMessage(4, mcpTools),
      fieldString(5, "conv-decoded"),
      fieldString(8, "custom system"),
      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    await fetch(`http://127.0.0.1:${port}/byok/bidi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        json: {
          requestId: { requestId },
          dataBinary: clientMessage.toString("base64"),
        },
      }),
    });
    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, workspaceRoots: ["/workspace/one", "/workspace/two"] }),
    });
    await run.text();
    assert.equal(adapterRequest.conversationId, "conv-decoded");
    assert.equal(adapterRequest.systemPrompt, "custom system");
    assert.deepEqual(adapterRequest.workspaceRoots, ["/workspace/one", "/workspace/two"]);
    assert.deepEqual(adapterRequest.messages, [{ role: "user", content: "hello from user" }]);
    assert.deepEqual(adapterRequest.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read files",
      inputSchema: { type: "OBJECT" },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    assertIncludesAll(adapterRequest.tools.map((tool) => tool.name), ["AskQuestion", "SwitchMode", "CreatePlan"]);
  } finally {
    await server.stop();
    restoreHome();
  }
});
