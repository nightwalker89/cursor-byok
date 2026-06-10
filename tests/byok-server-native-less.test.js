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
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
} = require("../src/server/provider-adapter");
const { protoMessage, fieldMessage, fieldString, structStringValue, jsonResponse, writeMcpCacheTool, approvedSwitchModeInteractionResponse, assertIncludesAll, quietLog, useHome, asyncIterable, interceptModule } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("grey-box AwaitShell without ids returns provider-visible error without native exec", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-await-"));
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

  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const providerRequests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            providerRequests.push(request);
            if (providerRequests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "await-1", index: 0, function: { name: "AwaitShell", arguments: "{\"block_until_ms\":1}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restoreModule = interceptModule("openai", FakeOpenAI);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: null,
  });
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    server.providerAdapter = new ProviderAdapter({
      providersConfigProvider: () => JSON.parse(fs.readFileSync(providersPath(), "utf8")),
      log: quietLog(),
    });
    await server.start();
    const port = server.server.address().port;

    hookRuntime({ byokUrl: `http://127.0.0.1:${port}`, routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
	    const requestId = "12121212-1212-4121-8121-121212121212";
	    const userMessage = protoMessage([fieldString(1, "await shell locally"), fieldString(2, "msg-await")]);
	    const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
	    const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
	    const runRequest = protoMessage([
	      fieldMessage(2, conversationAction),
	      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
	      fieldString(5, "conv-await"),
	      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
      fieldMessage(4, protoMessage([fieldMessage(1, protoMessage([
        fieldString(1, "AwaitShell"),
        fieldString(2, "wait for bounded shell command completion"),
        fieldMessage(3, protoMessage([
          fieldMessage(1, protoMessage([
            fieldString(1, "type"),
            fieldMessage(2, protoMessage([fieldString(3, "object")])),
          ])),
          fieldMessage(1, protoMessage([
            fieldString(1, "properties"),
            fieldMessage(2, protoMessage([fieldMessage(5, protoMessage([
              fieldMessage(1, protoMessage([
                fieldString(1, "block_until_ms"),
                fieldMessage(2, protoMessage([fieldMessage(5, protoMessage([
                  fieldMessage(1, protoMessage([
                    fieldString(1, "type"),
                    fieldMessage(2, protoMessage([fieldString(3, "integer")])),
                  ])),
                ]))])),
              ])),
            ]))])),
          ])),
        ])),
      ]))])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    await wrapped.unary(
      { typeName: "aiserver.v1.BidiService" },
      { name: "BidiAppend", O: { fromJson: (value) => ({ bidiAck: value }) } },
      null,
      0,
      {},
      { requestId: { requestId }, dataBinary: clientMessage.toString("base64") },
    );

    const stream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of stream.message) messages.push(message);

    assert.equal(providerRequests.length, 2);
    assert.deepEqual(providerRequests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "await-1",
      content: "AwaitShell error: AwaitShell requires shell_id or task_id from a previous background shell or subagent result.",
    });
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "toolCallCompleted"), true);
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "textDelta"), true);
  } finally {
    await server.stop();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
    restoreModule();
    restoreHome();
  }
});


test("grey-box unknown provider tool returns local error result instead of stalling provider", { timeout: 120000 }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-unsupported-tool-"));
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

  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const providerRequests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            providerRequests.push(request);
            if (providerRequests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "unknown-1", index: 0, function: { name: "UnknownTool", arguments: "{}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restoreModule = interceptModule("openai", FakeOpenAI);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: null,
  });
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    server.providerAdapter = new ProviderAdapter({
      providersConfigProvider: () => JSON.parse(fs.readFileSync(providersPath(), "utf8")),
      log: quietLog(),
    });
    await server.start();
    const port = server.server.address().port;

    hookRuntime({ byokUrl: `http://127.0.0.1:${port}`, routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
	    const requestId = "34343434-3434-4434-8434-343434343434";
	    const userMessage = protoMessage([fieldString(1, "unsupported web search tool"), fieldString(2, "msg-web")]);
	    const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
	    const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
	    const runRequest = protoMessage([
	      fieldMessage(2, conversationAction),
	      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
	      fieldString(5, "conv-glob"),
	      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    await wrapped.unary(
      { typeName: "aiserver.v1.BidiService" },
      { name: "BidiAppend", O: { fromJson: (value) => ({ bidiAck: value }) } },
      null,
      0,
      {},
      { requestId: { requestId }, dataBinary: clientMessage.toString("base64") },
    );

    const stream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of stream.message) messages.push(message);

    assert.equal(providerRequests.length, 2);
    assert.deepEqual(providerRequests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "unknown-1",
      content: "Invalid UnknownTool input: UnknownTool is not available as a BYOK provider tool.",
    });
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "toolCallStarted"), true);
    const completed = messages.find((message) => message.message?.value?.message?.case === "toolCallCompleted");
    assert.equal(!!completed, true);
    assert.equal(completed.message.value.message.value.toolCall.tool.case, "custom");
    assert.equal(completed.message.value.message.value.toolCall.tool.value.result.result.case, "error");
    assert.match(completed.message.value.message.value.toolCall.tool.value.result.result.value.error, /Invalid UnknownTool input/);
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "textDelta"), true);
  } finally {
    await server.stop();
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
    restoreModule();
    restoreHome();
  }
});

test("grey-box filtered subagent launch tool returns local error without native exec", { timeout: 120000 }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-filtered-task-tool-"));
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

  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const providerRequests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            providerRequests.push(request);
            if (providerRequests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "task-1",
                        index: 0,
                        function: {
                          name: "Task",
                          arguments: JSON.stringify({ prompt: "inspect implementation", subagent_type: "explore" }),
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restoreModule = interceptModule("openai", FakeOpenAI);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: null,
  });
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    server.providerAdapter = new ProviderAdapter({
      providersConfigProvider: () => JSON.parse(fs.readFileSync(providersPath(), "utf8")),
      log: quietLog(),
    });
    await server.start();
    const port = server.server.address().port;

    hookRuntime({ byokUrl: `http://127.0.0.1:${port}`, routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const requestId = "32323232-3232-4232-8232-323232323232";
    const userMessage = protoMessage([fieldString(1, "task launch should be blocked"), fieldString(2, "msg-task")]);
    const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
    const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
    const runRequest = protoMessage([
      fieldMessage(2, conversationAction),
      fieldMessage(3, protoMessage([fieldString(1, "byok-model")])),
      fieldString(5, "conv-task"),
      fieldMessage(9, protoMessage([fieldString(1, "byok-model")])),
    ]);
    const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
    await wrapped.unary(
      { typeName: "aiserver.v1.BidiService" },
      { name: "BidiAppend", O: { fromJson: (value) => ({ bidiAck: value }) } },
      null,
      0,
      {},
      { requestId: { requestId }, dataBinary: clientMessage.toString("base64") },
    );

    const stream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of stream.message) messages.push(message);

    assert.equal(providerRequests.length, 2);
    assert.deepEqual(providerRequests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "task-1",
      content: "Invalid Task input: Task is filtered in BYOK mode and is not available as a BYOK provider tool.",
    });
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "toolCallStarted"), true);
    const completed = messages.find((message) => message.message?.value?.message?.case === "toolCallCompleted");
    assert.equal(!!completed, true);
    assert.equal(completed.message.value.message.value.toolCall.tool.case, "custom");
    assert.equal(completed.message.value.message.value.toolCall.tool.value.result.result.case, "error");
    assert.match(completed.message.value.message.value.toolCall.tool.value.result.result.value.error, /Invalid Task input/);
    assert.equal(messages.some((message) => message.message?.value?.message?.case === "textDelta"), true);
  } finally {
    await server.stop();
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
    restoreModule();
    restoreHome();
  }
});
