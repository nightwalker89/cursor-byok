"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
} = require("../src/server/provider-adapter");
const { mcpAuthProviderTool, quietLog, deferred, tick, asyncIterable, snapshotJson, interceptModule, interceptModules } = require("./byok-fixtures");

test("provider stream collectors preserve tool names for native Cursor exec dispatch", async () => {
  const openAiEvents = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { tool_calls: [{ id: "call-1", index: 0, function: { name: "Read" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"/tmp/a\",\"offset\":1,\"limit\":5}" } }] }, finish_reason: "tool_calls" }] },
  ]));
  const openAiDone = openAiEvents.filter((event) => event.type === "tool_use_done");
  assert.equal(openAiDone.length, 1);
  assert.equal(openAiDone[0].id, "call-1");
  assert.equal(openAiDone[0].name, "Read");
  assert.deepEqual(JSON.parse(openAiDone[0].arguments), { path: "/tmp/a", offset: 1, limit: 5 });

  const anthropicStream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-2", name: "Grep" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"x\"}" } },
    { type: "content_block_stop", index: 0 },
  ]);
  anthropicStream.finalMessage = async () => ({ stop_reason: "tool_use", usage: {} });
  const anthropicEvents = await collectAnthropicEvents(anthropicStream);
  assert.equal(anthropicEvents.find((event) => event.type === "tool_use_done").name, "Grep");
});

test("OpenAI-compatible provider runtime honors api-key auth kind for Chat and Responses", async () => {
  const clientOptions = [];
  class FakeOpenAI {
    constructor(options) {
      clientOptions.push(options);
      this.chat = {
        completions: {
          create: async () => asyncIterable([{ choices: [{ delta: { content: "chat-ok" }, finish_reason: "stop" }] }]),
        },
      };
      this.responses = {
        create: async () => asyncIterable([
          { type: "response.output_text.delta", delta: "responses-ok" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        ]),
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const baseProvider = {
      name: "Provider",
      baseUrl: "http://unused",
      auth: { kind: "api-key", value: "real-key" },
      headers: { authorization: "Bearer stale-lower", Authorization: "Bearer stale", "Api-Key": "mixed-stale-key", "api-key": "stale-key", "x-extra": "1" },
    };
    for (const type of ["openai-chat", "openai-responses"]) {
      for await (const _ of adapter.run({
        provider: { ...baseProvider, type },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: `conv-${type}`,
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
        },
        requestId: `req-${type}`,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain the provider stream.
      }
    }

    assert.equal(clientOptions.length, 2);
    for (const options of clientOptions) {
      assert.equal(options.apiKey, "unused");
      assert.equal(options.baseURL, "http://unused");
      assert.equal(options.defaultHeaders.Authorization, null);
      assert.equal(options.defaultHeaders["api-key"], "real-key");
      assert.equal(options.defaultHeaders["x-extra"], "1");
      assert.equal(options.defaultHeaders.authorization, undefined);
      assert.equal(options.defaultHeaders["Api-Key"], undefined);
    }
  } finally {
    restore();
  }
});

test("OpenAI-compatible provider runtime preserves manual api-key headers without adding Bearer auth", async () => {
  const clientOptions = [];
  class FakeOpenAI {
    constructor(options) {
      clientOptions.push(options);
      this.chat = {
        completions: {
          create: async () => asyncIterable([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _ of adapter.run({
      provider: {
        name: "Provider",
        type: "openai-chat",
        baseUrl: "http://unused",
        headers: { "Api-Key": "manual-key", "api-key": "stale-key", authorization: "Bearer stale", "x-extra": "1" },
      },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-manual-api-key",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
      },
      requestId: "req-manual-api-key",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain the provider stream.
    }

    assert.equal(clientOptions.length, 1);
    assert.equal(clientOptions[0].apiKey, "unused");
    assert.equal(clientOptions[0].defaultHeaders.Authorization, null);
    assert.equal(clientOptions[0].defaultHeaders["api-key"], "manual-key");
    assert.equal(clientOptions[0].defaultHeaders["x-extra"], "1");
    assert.equal(clientOptions[0].defaultHeaders["Api-Key"], undefined);
    assert.equal(clientOptions[0].defaultHeaders.authorization, undefined);
  } finally {
    restore();
  }
});

test("OpenAI-compatible provider runtime lets bearer auth.value override stale auth headers", async () => {
  const clientOptions = [];
  class FakeOpenAI {
    constructor(options) {
      clientOptions.push(options);
      this.chat = {
        completions: {
          create: async () => asyncIterable([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
        },
      };
      this.responses = {
        create: async () => asyncIterable([
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { usage: {} } },
        ]),
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for (const type of ["openai-chat", "openai-responses"]) {
      for await (const _ of adapter.run({
        provider: {
          name: "Provider",
          type,
          baseUrl: "http://unused",
          auth: { kind: "bearer", value: "real-bearer" },
          headers: { authorization: "Bearer stale-lower", Authorization: "Bearer stale", "api-key": "stale-api-key", "x-extra": "1" },
        },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: `conv-bearer-${type}`,
          systemPrompt: "system",
          messages: [{ role: "user", content: "ping" }],
        },
        requestId: `req-bearer-${type}`,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain the provider stream.
      }
    }

    assert.equal(clientOptions.length, 2);
    for (const options of clientOptions) {
      assert.equal(options.apiKey, "real-bearer");
      assert.equal(options.baseURL, "http://unused");
      assert.equal(options.defaultHeaders["x-extra"], "1");
      assert.equal(options.defaultHeaders.authorization, undefined);
      assert.equal(options.defaultHeaders.Authorization, undefined);
      assert.equal(options.defaultHeaders["api-key"], undefined);
    }
  } finally {
    restore();
  }
});

test("OpenAI SDK request sends new bearer auth instead of stale custom auth headers", async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      apiKey: request.headers["api-key"],
      extra: request.headers["x-extra"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _ of adapter.run({
      provider: {
        name: "Provider",
        type: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        auth: { kind: "bearer", value: "real-bearer" },
        headers: { authorization: "Bearer stale-lower", Authorization: "Bearer stale", "api-key": "stale-api-key", "x-extra": "1" },
      },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-real-openai-bearer",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
      },
      requestId: "req-real-openai-bearer",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain the provider stream.
    }

    assert.deepEqual(received, [{
      authorization: "Bearer real-bearer",
      apiKey: undefined,
      extra: "1",
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anthropic provider runtime lets auth.value override stale X-Api-Key headers", async () => {
  const clientOptions = [];
  class FakeAnthropic {
    constructor(options) {
      clientOptions.push(options);
      this.messages = {
        stream: async () => {
          const stream = asyncIterable([]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: {} });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _ of adapter.run({
      provider: {
        name: "Anthropic",
        type: "anthropic",
        baseUrl: "http://unused",
        auth: { kind: "api-key", value: "real-anthropic-key" },
        headers: { Authorization: "Bearer stale", "X-Api-Key": "stale-anthropic-key", "x-extra": "1" },
      },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-auth",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
      },
      requestId: "req-anthropic-auth",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain the provider stream.
    }

    assert.equal(clientOptions.length, 1);
    assert.equal(clientOptions[0].apiKey, null);
    assert.equal(clientOptions[0].baseURL, "http://unused");
    assert.equal(clientOptions[0].defaultHeaders["x-api-key"], "real-anthropic-key");
    assert.equal(clientOptions[0].defaultHeaders["X-Api-Key"], undefined);
    assert.equal(clientOptions[0].defaultHeaders.Authorization, undefined);
    assert.equal(clientOptions[0].defaultHeaders["x-extra"], "1");
  } finally {
    restore();
  }
});

test("Anthropic SDK request sends new x-api-key instead of stale custom auth headers", async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      xApiKey: request.headers["x-api-key"],
      extra: request.headers["x-extra"],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Pin the SDK env fallbacks: the Anthropic SDK silently picks up
  // ANTHROPIC_AUTH_TOKEN and would attach `Authorization: Bearer <env token>` to
  // the user-configured baseUrl (a credential leak). Setting the vars makes this
  // test detect the leak deterministically instead of only on machines that
  // happen to export them.
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "env-leak-token";
  process.env.ANTHROPIC_API_KEY = "env-leak-api-key";
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _ of adapter.run({
      provider: {
        name: "Anthropic",
        type: "anthropic",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        auth: { kind: "api-key", value: "real-anthropic-key" },
        headers: { Authorization: "Bearer stale", "X-Api-Key": "stale-anthropic-key", "x-extra": "1" },
      },
      model: { id: "byok-model", apiModel: "claude-test" },
      request: {
        conversationId: "conv-real-anthropic-auth",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
      },
      requestId: "req-real-anthropic-auth",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain the provider stream.
    }

    assert.deepEqual(received, [{
      authorization: undefined,
      xApiKey: "real-anthropic-key",
      extra: "1",
    }]);
  } finally {
    if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anthropic provider runtime preserves manual X-Api-Key headers without adding a dummy key", async () => {
  const clientOptions = [];
  class FakeAnthropic {
    constructor(options) {
      clientOptions.push(options);
      this.messages = {
        stream: async () => {
          const stream = asyncIterable([]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: {} });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _ of adapter.run({
      provider: {
        name: "Anthropic",
        type: "anthropic",
        baseUrl: "http://unused",
        headers: { "X-Api-Key": "manual-anthropic-key", "x-extra": "1" },
      },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-manual-auth",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
      },
      requestId: "req-anthropic-manual-auth",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain the provider stream.
    }

    assert.equal(clientOptions.length, 1);
    assert.equal(clientOptions[0].apiKey, null);
    assert.equal(clientOptions[0].baseURL, "http://unused");
    assert.equal(clientOptions[0].defaultHeaders["X-Api-Key"], "manual-anthropic-key");
    assert.equal(clientOptions[0].defaultHeaders["x-api-key"], undefined);
    assert.equal(clientOptions[0].defaultHeaders["x-extra"], "1");
  } finally {
    restore();
  }
});

test("provider runtime passes abort signals to streaming SDK calls", async () => {
  const observed = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (_request, options) => {
            observed.push(["chat", options?.signal]);
            return asyncIterable([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
          },
        },
      };
      this.responses = {
        create: async (_request, options) => {
          observed.push(["responses", options?.signal]);
          return asyncIterable([{ type: "response.completed", response: { usage: {} } }]);
        },
      };
    }
  }
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (_request, options) => {
          observed.push(["anthropic", options?.signal]);
          const stream = asyncIterable([]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: {} });
          return stream;
        },
      };
    }
  }
  const restore = interceptModules({
    openai: FakeOpenAI,
    "@anthropic-ai/sdk": FakeAnthropic,
  });
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const controllers = [];
    for (const type of ["openai-chat", "openai-responses", "anthropic"]) {
      const controller = new AbortController();
      controllers.push(controller);
      for await (const _ of adapter.run({
        provider: { name: "Provider", type, baseUrl: "http://unused" },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: { conversationId: `conv-${type}`, systemPrompt: "system", messages: [{ role: "user", content: "ping" }] },
        requestId: `req-${type}`,
        signal: controller.signal,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain the provider stream.
      }
    }
    assert.deepEqual(observed.map((entry) => entry[0]), ["chat", "responses", "anthropic"]);
    assert.equal(observed.every((entry) => entry[1]?.constructor?.name === "AbortSignal"), true);
    // The observed signal must actually be wired to the caller's controller —
    // an unrelated AbortSignal instance would satisfy the constructor check
    // while leaving cancellation broken.
    for (let index = 0; index < controllers.length; index++) {
      assert.equal(observed[index][1].aborted, false);
      controllers[index].abort();
      assert.equal(observed[index][1].aborted, true, `${observed[index][0]} signal not linked to caller controller`);
    }
  } finally {
    restore();
  }
});
