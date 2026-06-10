"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
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
const { mcpAuthProviderTool, quietLog, deferred, tick, asyncIterable, snapshotJson, interceptModule, interceptModules, createProviderAdapter, runConcurrentReadToolWaits } = require("./byok-fixtures");

test("OpenAI Chat provider omits completion token limit by default", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: {
        id: "byok-model",
        apiModel: "fake-model",
        contextTokenLimit: 200000,
        contextTokenLimitForMaxMode: 200000,
        maxOutputTokens: 128000,
      },
      request: {
        conversationId: "conv-openai-chat-no-completion-limit",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      },
      requestId: "req-openai-chat-no-completion-limit",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].parallel_tool_calls, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(Object.prototype.hasOwnProperty.call(requests[0], "max_tokens"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(requests[0], "max_completion_tokens"), false);
  } finally {
    restore();
  }
});

test("OpenAI provider loop sends Cursor exec result back as provider tool result", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "call-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([
              { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
            ]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-1",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "raw cursor content",
            },
          },
        });
      },
    })) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].prompt_cache_key, "conv-1");
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].messages[0].role, "system");
    assert.equal(requests[0].tools[0].type, "function");
    assert.equal(requests[0].tools[0].function.name, "Read");
    assert.match(requests[0].tools[0].function.description, /only valid Read input keys are path, offset, and limit/);
    assert.deepEqual(Object.keys(requests[0].tools[0].function.parameters.properties), ["path", "offset", "limit"]);
    assert.deepEqual(requests[0].tools[0].function.parameters.required, ["path"]);
    assert.equal(requests[0].tools[0].function.parameters.additionalProperties, false);
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "call-1",
      content: "File: /tmp/a\nLines: 1-1\n     1|raw cursor content",
    });
    assert.deepEqual(waitCalls, [{ toolCallId: "call-1", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider loop sends explicit client tool completions back as tool messages", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "web-1", index: 0, function: { name: "WebSearch", arguments: "{\"search_term\":\"Cursor BYOK\"}" } },
                        { id: "image-1", index: 1, function: { name: "GenerateImage", arguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-client-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "search and draw" }],
        tools: [
          {
            name: "WebSearch",
            description: "Cursor web search",
            inputSchema: { type: "object", properties: { search_term: { type: "string" } }, required: ["search_term"] },
          },
          {
            name: "GenerateImage",
            description: "Cursor image generation",
            inputSchema: { type: "object", properties: { description: { type: "string" }, filename: { type: "string" } }, required: ["description"] },
          },
        ],
      },
      requestId: "req-openai-chat-client-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        if (toolCallId === "web-1") {
          return {
            message: {
              case: "byokInteractionToolResult",
              value: {
                toolName: "WebSearch",
                clientCompletion: {
                  case: "success",
                  value: { references: [{ title: "Cursor BYOK docs", url: "https://example.com/byok" }] },
                },
              },
            },
          };
        }
        return {
          message: {
            case: "byokInteractionToolResult",
            value: {
              toolName: "GenerateImage",
              clientCompletion: {
                case: "success",
                value: { filePath: "/tmp/out.png" },
              },
            },
          },
        };
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "WebSearch"), true);
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "GenerateImage"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: "{\"search_term\":\"Cursor BYOK\"}" } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" } },
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "web-1", type: "function", function: { name: "WebSearch", arguments: "{\"search_term\":\"Cursor BYOK\"}" } },
          { id: "image-1", type: "function", function: { name: "GenerateImage", arguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "web-1",
        content: "Cursor BYOK docs (https://example.com/byok)",
      },
      {
        role: "tool",
        tool_call_id: "image-1",
        content: "Generated image at /tmp/out.png",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider repairs client tool aliases before Cursor execution and follow-up history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "web-1", index: 0, function: { name: "WebSearch", arguments: "{\"searchTerm\":\"Cursor BYOK\"}" } },
                        { id: "image-1", index: 1, function: { name: "GenerateImage", arguments: "{\"description\":\"diagram\",\"filePath\":\"/tmp/out.png\",\"referenceImagePaths\":[\"/tmp/ref.png\"]}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-client-tool-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "search and draw" }],
        tools: [
          {
            name: "WebSearch",
            description: "Cursor web search",
            inputSchema: { type: "object", properties: { search_term: { type: "string" } }, required: ["search_term"] },
          },
          {
            name: "GenerateImage",
            description: "Cursor image generation",
            inputSchema: { type: "object", properties: { description: { type: "string" }, filename: { type: "string" }, reference_image_paths: { type: "array", items: { type: "string" } } }, required: ["description"] },
          },
        ],
      },
      requestId: "req-openai-chat-client-tool-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        if (toolCallId === "web-1") {
          return {
            message: {
              case: "byokInteractionToolResult",
              value: {
                toolName: "WebSearch",
                clientCompletion: {
                  case: "success",
                  value: { references: [{ title: "Cursor BYOK docs", url: "https://example.com/byok" }] },
                },
              },
            },
          };
        }
        return {
          message: {
            case: "byokInteractionToolResult",
            value: {
              toolName: "GenerateImage",
              clientCompletion: {
                case: "success",
                value: { filePath: "/tmp/out.png" },
              },
            },
          },
        };
      },
    })) {
      // drain stream
    }

    const webArgs = "{\"search_term\":\"Cursor BYOK\"}";
    const imageArgs = "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\",\"reference_image_paths\":[\"/tmp/ref.png\"]}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: webArgs } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: imageArgs } },
    ]);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "web-1", type: "function", function: { name: "WebSearch", arguments: webArgs } },
          { id: "image-1", type: "function", function: { name: "GenerateImage", arguments: imageArgs } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "web-1",
        content: "Cursor BYOK docs (https://example.com/byok)",
      },
      {
        role: "tool",
        tool_call_id: "image-1",
        content: "Generated image at /tmp/out.png",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider returns filtered launch tool errors as tool messages", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "task-1", index: 0, function: { name: "Task", arguments: "{\"description\":\"launch task\"}" } },
                        { id: "subagent-1", index: 1, function: { name: "Subagent", arguments: "{\"prompt\":\"launch subagent\"}" } },
                      ],
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
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-filtered-launch-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try launch" }],
        tools: [
          {
            name: "Task",
            description: "launch task",
            inputSchema: { type: "object", properties: { description: { type: "string" } } },
          },
          {
            name: "Subagent",
            description: "launch subagent",
            inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
          },
        ],
      },
      requestId: "req-openai-chat-filtered-launch-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["Task", "unsupportedToolResult"], ["Subagent", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "task-1", type: "function", function: { name: "Task", arguments: "{\"description\":\"launch task\"}" } },
          { id: "subagent-1", type: "function", function: { name: "Subagent", arguments: "{\"prompt\":\"launch subagent\"}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "task-1",
        content: "Invalid Task input: Task is filtered in BYOK mode and is not available as a BYOK provider tool.",
      },
      {
        role: "tool",
        tool_call_id: "subagent-1",
        content: "Invalid Subagent input: Subagent is filtered in BYOK mode and is not available as a BYOK provider tool.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider drops trivial current assistant text when the same message also contains tool calls", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { content: "I will inspect it first." } }] },
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-current-text-and-tool-calls",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-current-text-and-tool-calls",
      waitForToolResult: async () => normalizeExecClientResult({
        readResult: {
          success: {
            path: "/tmp/a",
            content: "ok",
          },
        },
      }),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "I will inspect it first."), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "user",
        content: "inspect then read",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "read-1", type: "function", function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-1",
        content: "File: /tmp/a\nLines: 1-1\n     1|ok",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider preserves substantive assistant text with tool calls", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { content: "Need /tmp/a line 20 before reading." } }] },
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":20,\"limit\":5}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-substantive-text-and-tool-calls",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-openai-chat-substantive-text-and-tool-calls",
      waitForToolResult: async () => normalizeExecClientResult({
        readResult: {
          success: {
            path: "/tmp/a",
            content: "ok",
          },
        },
      }),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "Need /tmp/a line 20 before reading."), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: "Need /tmp/a line 20 before reading.",
      tool_calls: [
        { id: "read-1", type: "function", function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":20,\"limit\":5}" } },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider drops trivial current assistant text with paths or backticks when the same message also contains tool calls", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { content: "I'll inspect `batchtask_controller.go` at /tmp/project/file.go first." } }] },
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":20,\"limit\":5}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-current-trivial-text-with-path",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-openai-chat-current-trivial-text-with-path",
      waitForToolResult: async () => normalizeExecClientResult({
        readResult: {
          success: {
            path: "/tmp/project/file.go",
            content: "ok",
          },
        },
      }),
    })) {
      // drain
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "read-1", type: "function", function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":20,\"limit\":5}" } },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider compacts prior grep tool history after later Read covers the same file", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "grep-1", index: 0, function: { name: "Grep", arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"needle\",\"output_mode\":\"content\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":10,\"limit\":3}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-compact-old-grep",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read then answer" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-openai-chat-compact-old-grep",
      waitForToolResult: async (toolCallId) => {
        if (toolCallId === "grep-1") {
          return normalizeExecClientResult({
            grepResult: {
              success: {
                pattern: "needle",
                outputMode: "content",
                workspaceResults: {
                  "/tmp/project": {
                    result: {
                      case: "content",
                      value: {
                        matches: [{
                          file: "file.go",
                          matches: [{ lineNumber: 12, content: "needle()" }],
                        }],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return normalizeExecClientResult({
          readResult: {
            success: {
              path: "/tmp/project/file.go",
              content: "line-10\nline-11\nline-12",
              readRange: { startLine: 10, endLine: 12 },
            },
          },
        });
      },
    })) {
      // drain
    }

    assert.equal(requests.length, 3);
    assert.equal(requests[2].messages.at(-3).role, "tool");
    assert.equal(requests[2].messages.at(-3).content, "[/tmp/project] file.go summary: resolved path /tmp/project/file.go; callsite at line 12; next Read (prefer these exact windows before any other same-file Read or Grep): path=/tmp/project/file.go offset=1 limit=32");
    assert.equal(requests[2].messages.at(-1).content, "File: /tmp/project/file.go\nLines: 10-12\n    10|line-10\n    11|line-11\n    12|line-12");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider preserves prior callsite read history when a later same-file Read is a different window", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-callsite", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":300,\"limit\":30}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-def", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":2861,\"limit\":120}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-compact-old-callsite-read",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read then answer" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-openai-chat-compact-old-callsite-read",
      waitForToolResult: async (toolCallId) => {
        if (toolCallId === "read-callsite") {
          return normalizeExecClientResult({
            readResult: {
              success: {
                path: "/tmp/project/file.go",
                content: "if err != nil {\n  return err\n}\nif blocked {\n  return nil\n}",
                readRange: { startLine: 300, endLine: 304 },
              },
            },
          });
        }
        return normalizeExecClientResult({
          readResult: {
            success: {
              path: "/tmp/project/file.go",
              content: "func target() {\n  return nil\n}",
              readRange: { startLine: 2861, endLine: 2862 },
            },
          },
        });
      },
    })) {
      // drain
    }

    assert.equal(requests.length, 3);
    assert.equal(
      requests[2].messages.at(-3).content,
      "File: /tmp/project/file.go\nLines: 300-304\nReturn refs in this window: err(line 301), nil(line 304)\nBranch refs in this window: err != nil(line 300), blocked(line 303)\n   300|if err != nil {\n   301|  return err\n   302|}\n   303|if blocked {\n   304|  return nil\n   305|}",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider preserves prior definition read history when a later same-file Read is a different helper window", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-def", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":2861,\"limit\":120}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-helper", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":3021,\"limit\":80}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-compact-old-definition-read",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then helper then answer" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-openai-chat-compact-old-definition-read",
      waitForToolResult: async (toolCallId) => {
        if (toolCallId === "read-def") {
          return normalizeExecClientResult({
            readResult: {
              success: {
                path: "/tmp/project/file.go",
                content: "func target() {\n  helper()\n}\nfunc helper() {\n  return nil\n}",
                readRange: { startLine: 2861, endLine: 2865 },
              },
            },
          });
        }
        return normalizeExecClientResult({
          readResult: {
            success: {
              path: "/tmp/project/file.go",
              content: "func helper() {\n  return nil\n}",
              readRange: { startLine: 3021, endLine: 3022 },
            },
          },
        });
      },
    })) {
      // drain
    }

    assert.equal(requests.length, 3);
    assert.equal(
      requests[2].messages.at(-3).content,
      "File: /tmp/project/file.go\nLines: 2861-2865\nPrimary function body in this window: 2861-2863\nHelper refs in this window: helper(line 2862)\n  2861|func target() {\n  2862|  helper()\n  2863|}\n  2864|func helper() {\n  2865|  return nil\n  2866|}",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider compacts older same-file read history after multiple newer reads", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-a", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":300,\"limit\":30}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-b", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":2861,\"limit\":120}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 3) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-c", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":3021,\"limit\":80}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 4) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "read-d", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/project/file.go\",\"offset\":3300,\"limit\":20}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-compact-older-same-file-read",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then reread then answer" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-openai-chat-compact-older-same-file-read",
      waitForToolResult: async (toolCallId) => {
        if (toolCallId === "read-a") {
          return normalizeExecClientResult({
            readResult: {
              success: {
                path: "/tmp/project/file.go",
                content: "if err != nil {\n  return err\n}\nif blocked {\n  return nil\n}",
                readRange: { startLine: 300, endLine: 304 },
              },
            },
          });
        }
        if (toolCallId === "read-b") {
          return normalizeExecClientResult({
            readResult: {
              success: {
                path: "/tmp/project/file.go",
                content: "func target() {\n  helper()\n}\nfunc helper() {\n  return nil\n}",
                readRange: { startLine: 2861, endLine: 2865 },
              },
            },
          });
        }
        return normalizeExecClientResult({
          readResult: {
            success: {
              path: "/tmp/project/file.go",
              content: "func helper() {\n  return nil\n}",
              readRange: { startLine: 3021, endLine: 3022 },
            },
          },
        });
      },
    })) {
      // drain
    }

    assert.equal(requests.length, 5);
    const toolMessages = requests[4].messages.filter((message) => message.role === "tool");
    assert.equal(
      toolMessages[0].content,
      "File: /tmp/project/file.go\nLines: 300-304\nReturn refs in this window: err(line 301), nil(line 304)\nBranch refs in this window: err != nil(line 300), blocked(line 303)\n[older same-file Read compacted after newer Reads]",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider returns unknown tool errors as tool messages without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
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
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-unknown-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try unknown" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-unknown-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["UnknownTool", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "unknown-1", type: "function", function: { name: "UnknownTool", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "unknown-1",
        content: "Invalid UnknownTool input: UnknownTool is not available as a BYOK provider tool.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider returns custom tool errors as tool messages without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "custom-read-1", index: 0, type: "custom", custom: { name: "Read", input: "read /tmp/a" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-custom-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-custom-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "unexpected" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["Read", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "custom-read-1",
        type: "custom",
        custom: { name: "Read", input: "read /tmp/a" },
      }],
    }, {
      role: "tool",
      tool_call_id: "custom-read-1",
      content: "Invalid Read input: BYOK exposes Cursor tools to OpenAI Chat as function tools, not custom tools.",
    }]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider repairs Bash alias to Shell before execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bash-1", index: 0, function: { name: "Bash", arguments: "{\"command\":\"pwd\",\"description\":\"show cwd\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-bash-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "run pwd" }],
        tools: [{ name: "Shell", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-bash-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          shellResult: {
            success: {
              command: "pwd",
              workingDirectory: "/tmp/project",
              stdout: "/tmp/project\n",
              stderr: "",
              exitCode: 0,
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    const expectedArguments = "{\"command\":\"pwd\",\"description\":\"show cwd\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_start").map((event) => [event.id, event.name]), [["bash-1", "Shell"]]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.id, event.name, event.localResult?.case]), [["bash-1", "Shell", undefined]]);
    assert.deepEqual(waitCalls, [{ toolCallId: "bash-1", options: { toolName: "Shell", toolArguments: expectedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.name, "Shell");
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, expectedArguments);
    assert.equal(
      requests[1].messages.at(-1).content,
      "Exit code: 0\n\nCommand output:\n\n```\n/tmp/project\n\n```\n\nCommand completed.\n\nShell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider rejects default-catalog ReadFile as a tool message without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "readfile-1", index: 0, function: { name: "ReadFile", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-default-readfile",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try legacy read alias" }],
      },
      requestId: "req-openai-chat-default-readfile",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools.some((tool) => tool.function.name === "ReadFile"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["ReadFile", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "readfile-1", type: "function", function: { name: "ReadFile", arguments: "{\"path\":\"/tmp/a\"}" } }],
      },
      {
        role: "tool",
        tool_call_id: "readfile-1",
        content: "Invalid ReadFile input: ReadFile is not available as a BYOK provider tool.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider rejects default-catalog client tools as tool messages without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "web-1", index: 0, function: { name: "WebSearch", arguments: "{\"search_term\":\"Cursor BYOK\"}" } },
                        { id: "image-1", index: 1, function: { name: "GenerateImage", arguments: "{\"description\":\"diagram\"}" } },
                      ],
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
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-default-client-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try client tools" }],
      },
      requestId: "req-openai-chat-default-client-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.function.name);
    assert.equal(requestToolNames.includes("WebSearch"), false);
    assert.equal(requestToolNames.includes("GenerateImage"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["WebSearch", "unsupportedToolResult"], ["GenerateImage", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-3), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "web-1", type: "function", function: { name: "WebSearch", arguments: "{\"search_term\":\"Cursor BYOK\"}" } },
          { id: "image-1", type: "function", function: { name: "GenerateImage", arguments: "{\"description\":\"diagram\"}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "web-1",
        content: "Invalid WebSearch input: WebSearch is not available as a BYOK provider tool.",
      },
      {
        role: "tool",
        tool_call_id: "image-1",
        content: "Invalid GenerateImage input: GenerateImage is not available as a BYOK provider tool.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider rejects default-catalog task todo aliases as tool messages without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "task-create-1", index: 0, function: { name: "TaskCreate", arguments: "{\"description\":\"inspect\"}" } },
                        { id: "task-update-1", index: 1, function: { name: "TaskUpdate", arguments: "{\"id\":\"task-1\",\"status\":\"completed\"}" } },
                        { id: "task-list-1", index: 2, function: { name: "TaskList", arguments: "{}" } },
                        { id: "task-get-1", index: 3, function: { name: "TaskGet", arguments: "{\"id\":\"task-1\"}" } },
                      ],
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
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-default-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try task aliases" }],
      },
      requestId: "req-openai-chat-default-task-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.function.name);
    assert.equal(requestToolNames.includes("TaskCreate"), false);
    assert.equal(requestToolNames.includes("TaskUpdate"), false);
    assert.equal(requestToolNames.includes("TaskList"), false);
    assert.equal(requestToolNames.includes("TaskGet"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [
      ["TaskCreate", "unsupportedToolResult"],
      ["TaskUpdate", "unsupportedToolResult"],
      ["TaskList", "unsupportedToolResult"],
      ["TaskGet", "unsupportedToolResult"],
    ]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-5), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "task-create-1", type: "function", function: { name: "TaskCreate", arguments: "{\"description\":\"inspect\"}" } },
          { id: "task-update-1", type: "function", function: { name: "TaskUpdate", arguments: "{\"id\":\"task-1\",\"status\":\"completed\"}" } },
          { id: "task-list-1", type: "function", function: { name: "TaskList", arguments: "{}" } },
          { id: "task-get-1", type: "function", function: { name: "TaskGet", arguments: "{\"id\":\"task-1\"}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "task-create-1",
        content: requests[1].messages.at(-4).content,
      },
      {
        role: "tool",
        tool_call_id: "task-update-1",
        content: "Invalid TaskUpdate input: TaskUpdate is not available as a BYOK provider tool.",
      },
      {
        role: "tool",
        tool_call_id: "task-list-1",
        content: "Invalid TaskList input: TaskList is not available as a BYOK provider tool.",
      },
      {
        role: "tool",
        tool_call_id: "task-get-1",
        content: "Invalid TaskGet input: TaskGet is not available as a BYOK provider tool.",
      },
    ]);
    assert.equal(
      requests[1].messages.at(-4).content,
      "Invalid TaskCreate input: TaskCreate is not available as a BYOK provider tool.",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop dispatches canonical Read aliases as Read", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "call-alias", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([
              { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
            ]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-canonical-read-alias",
        messages: [{ role: "user", content: "read it" }],
        tools: [{
          name: "read_alias",
          canonicalName: "Read",
          description: "read alias",
          inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
        }],
      },
      requestId: "req-canonical-read-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "raw cursor content",
            },
          },
        });
      },
    })) {
      // drain stream
    }

    assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ["Read"]);
    assert.deepEqual(Object.keys(requests[0].tools[0].function.parameters.properties), ["path", "offset", "limit"]);
    assert.deepEqual(waitCalls, [{ toolCallId: "call-alias", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
  } finally {
    restore();
  }
});


test("OpenAI provider repairs Read alias from a unique explicit user JSON range", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-read", index: 0, function: { name: "Read", arguments: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-read-repair",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "windowed",
              readRange: { startLine: 2000 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-read", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2).tool_calls[0].function.arguments, "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}");
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-read");
    assert.doesNotMatch(requests[1].messages.at(-1).content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("OpenAI provider preserves Read encodingHint before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "read-encoding", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/latin1.txt\",\"encodingHint\":\"latin1\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-encoding-hint",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read with encoding" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-read-encoding-hint",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/latin1.txt",
              content: "olá",
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = JSON.stringify({ path: "/tmp/latin1.txt", encodingHint: "latin1" });
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "read-encoding", options: { toolName: "Read", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.doesNotMatch(requests[1].messages.at(-1).content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("OpenAI provider repairs ReadFile aliases to canonical Read input", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-readfile", index: 0, function: { name: "ReadFile", arguments: "{\"file_path\":\"/tmp/a\",\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([
              { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
            ]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-readfile",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use ReadFile exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{
          name: "ReadFile",
          description: "legacy read file",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              path: { type: "string" },
            },
            required: ["file_path"],
          },
        }],
      },
      requestId: "req-openai-chat-readfile-retry",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({ execId: toolCallId, readResult: { success: { path: "/tmp/a", content: "unused" } } });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.match(requests[0].tools[0].function.description, /only valid Read input keys are path, offset, and limit/);
    assert.deepEqual(Object.keys(requests[0].tools[0].function.parameters.properties), ["path", "offset", "limit"]);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-readfile", options: { toolName: "ReadFile", toolArguments: "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-readfile").map((event) => event.localResult?.case), [undefined]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-readfile");
    assert.doesNotMatch(requests[1].messages.at(-1).content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider records repaired Read arguments in follow-up history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "read-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-repaired-read-history",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-repaired-read-history",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "windowed", readRange: { startLine: 2000 } } },
        });
      },
    })) {
      // drain stream
    }

    const expectedArguments = "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}";
    assert.deepEqual(waitCalls, [{ toolCallId: "read-1", options: { toolName: "Read", toolArguments: expectedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.name, "Read");
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, expectedArguments);
    assert.equal(requests[1].messages.at(-1).content, "File: /tmp/a\nLines: 2000-2000\n  2000|windowed");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider passes TodoWrite dependencies through to native Cursor todo execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "todo-1",
                        index: 0,
                        function: {
                          name: "TodoWrite",
                          arguments: "{\"todos\":[{\"id\":\"t1\",\"content\":\"Do it\",\"status\":\"pending\",\"dependencies\":[\"t0\"]}],\"merge\":true}",
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-todowrite-dependencies",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-openai-chat-todowrite-dependencies",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [{ id: "t1", content: "Do it", status: "pending" }],
              merge: true,
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = "{\"todos\":[{\"id\":\"t1\",\"content\":\"Do it\",\"status\":\"pending\",\"dependencies\":[\"t0\"]}],\"merge\":true}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "todo-1", options: { toolName: "TodoWrite", toolArguments: argumentsJson } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.name, "TodoWrite");
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, argumentsJson);
    assert.equal(requests[1].messages.at(-1).content, "Todo list updated (1 item):\n- [pending] Do it");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider ignores malformed TodoWrite input before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "todo-invalid",
                        index: 0,
                        function: {
                          name: "TodoWrite",
                          arguments: "{\"todos\":\"finish step 1\"}",
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-todowrite-invalid",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-openai-chat-todowrite-invalid",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [],
              merge: false,
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "todo-invalid", options: { toolName: "TodoWrite", toolArguments: "{\"todos\":\"finish step 1\"}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "todo-invalid").map((event) => event.localResult?.case), [undefined]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, "{\"todos\":\"finish step 1\"}");
    assert.equal(requests[1].messages.at(-1).content, "Todo list is empty.");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider skips schema validation for explicit task todo aliases", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "task-create-explicit", index: 0, function: { name: "TaskCreate", arguments: "{\"description\":\"inspect\"}" } },
                        { id: "task-update-explicit", index: 1, function: { name: "TaskUpdate", arguments: "{\"task_id\":\"task-1\",\"status\":\"completed\"}" } },
                        { id: "task-list-explicit", index: 2, function: { name: "TaskList", arguments: "{}" } },
                        { id: "task-get-explicit", index: 3, function: { name: "TaskGet", arguments: "{}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-explicit-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "use explicit task aliases" }],
        tools: [
          { name: "TaskCreate", description: "task create", inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false } },
          { name: "TaskUpdate", description: "task update", inputSchema: { type: "object", properties: { taskId: { type: "string" }, status: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
          { name: "TaskList", description: "task list", inputSchema: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"], additionalProperties: false } },
          { name: "TaskGet", description: "task get", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
        ],
      },
      requestId: "req-openai-chat-explicit-task-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [{ id: toolCallId, content: options.toolName, status: "completed" }],
              merge: true,
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [
      { toolCallId: "task-create-explicit", options: { toolName: "TaskCreate", toolArguments: "{\"description\":\"inspect\"}" } },
      { toolCallId: "task-update-explicit", options: { toolName: "TaskUpdate", toolArguments: "{\"task_id\":\"task-1\",\"status\":\"completed\"}" } },
      { toolCallId: "task-list-explicit", options: { toolName: "TaskList", toolArguments: "{}" } },
      { toolCallId: "task-get-explicit", options: { toolName: "TaskGet", toolArguments: "{}" } },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), [undefined, undefined, undefined, undefined]);
    assert.equal(requests[1].messages.at(-4).content, "Todo list updated (1 item):\n- [completed] TaskCreate");
    assert.equal(requests[1].messages.at(-3).content, "Todo list updated (1 item):\n- [completed] TaskUpdate");
    assert.equal(requests[1].messages.at(-2).content, "Todo list updated (1 item):\n- [completed] TaskList");
    assert.equal(requests[1].messages.at(-1).content, "Todo list updated (1 item):\n- [completed] TaskGet");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider accepts TodoWrite todo items without ids", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "todo-no-id",
                        index: 0,
                        function: {
                          name: "TodoWrite",
                          arguments: "{\"todos\":[{\"content\":\"Do it\",\"status\":\"pending\"}],\"merge\":true}",
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-todowrite-no-id",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-openai-chat-todowrite-no-id",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [{ content: "Do it", status: "pending" }],
              merge: true,
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = "{\"todos\":[{\"content\":\"Do it\",\"status\":\"pending\"}],\"merge\":true}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "todo-no-id", options: { toolName: "TodoWrite", toolArguments: argumentsJson } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, argumentsJson);
    assert.equal(requests[1].messages.at(-1).content, "Todo list updated (1 item):\n- [pending] Do it");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs supported Grep alias keys before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-grep", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\",\"headLimit\":3}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-grep-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "needle",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: { matches: [{ file: "a.js", matches: [{ lineNumber: 3, content: "needle here" }] }] },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const repairedArguments = "{\"pattern\":\"needle\",\"head_limit\":3}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-grep", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "[/tmp/project] a.js:3 needle here");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Grep sort aliases before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-sort", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\",\"sort\":\"path\",\"sortAscending\":true}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-sort-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it in sorted order" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-grep-sort-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "needle",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: { matches: [{ file: "a.js", matches: [{ lineNumber: 3, content: "needle here" }] }] },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = JSON.stringify({ pattern: "needle", sort: "path", sort_ascending: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "grep-sort", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "[/tmp/project] a.js:3 needle here");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Glob aliases before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "glob-1", index: 0, function: { name: "Glob", arguments: "{\"pattern\":\"*.py\",\"path\":\"/tmp/project\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-glob-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "glob it" }],
        tools: [{ name: "Glob", description: "glob", inputSchema: { type: "object", properties: { glob_pattern: { type: "string" }, target_directory: { type: "string" } }, required: ["glob_pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-glob-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "",
              path: "/tmp/project",
              outputMode: "files_with_matches",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "files",
                    value: { files: ["a.py"], totalFiles: 1 },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "glob-1", options: { toolName: "Glob", toolArguments: "{\"glob_pattern\":\"*.py\",\"target_directory\":\"/tmp/project\"}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "glob-1").map((event) => event.localResult?.case), [undefined]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, "{\"glob_pattern\":\"*.py\",\"target_directory\":\"/tmp/project\"}");
    assert.equal(
      requests[1].messages.at(-1).content,
      "Result of search in '/tmp/project' (total 1 file):\n- a.py",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider repairs LS aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "ls-alias", index: 0, function: { name: "LS", arguments: "{\"targetDirectory\":\"/tmp/project\",\"ignoreGlobs\":[\"**/node_modules/**\"]}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-ls-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "list it" }],
        tools: [{ name: "LS", description: "ls", inputSchema: { type: "object", properties: { path: { type: "string" }, target_directory: { type: "string" }, ignore_globs: { type: "array", items: { type: "string" } } } } }],
      },
      requestId: "req-openai-chat-ls-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          lsResult: {
            success: {
              directoryTreeRoot: {
                absPath: "/tmp/project",
                childrenWereProcessed: true,
                childrenFiles: [],
                childrenDirs: [{
                  absPath: "/tmp/project/src",
                  childrenWereProcessed: true,
                  childrenFiles: [{ name: "app.js" }],
                  childrenDirs: [],
                }],
              },
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"path\":\"/tmp/project\",\"ignore_globs\":[\"**/node_modules/**\"]}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "ls-alias", options: { toolName: "LS", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "/tmp/project/\n  - src/\n    - app.js");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs LS timeout aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "ls-timeout", index: 0, function: { name: "LS", arguments: "{\"path\":\"/tmp/project\",\"timeoutMs\":1500}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-ls-timeout-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "list it with timeout" }],
        tools: [{ name: "LS", description: "ls", inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }],
      },
      requestId: "req-openai-chat-ls-timeout-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          lsResult: {
            success: {
              directoryTreeRoot: {
                absPath: "/tmp/project",
                childrenWereProcessed: true,
                childrenFiles: [],
                childrenDirs: [{
                  absPath: "/tmp/project/src",
                  childrenWereProcessed: true,
                  childrenFiles: [{ name: "app.js" }],
                  childrenDirs: [],
                }],
              },
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = JSON.stringify({ path: "/tmp/project", timeout_ms: 1500 });
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "ls-timeout", options: { toolName: "LS", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "/tmp/project/\n  - src/\n    - app.js");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs EditNotebook aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "notebook-alias", index: 0, function: { name: "EditNotebook", arguments: "{\"targetNotebook\":\"/tmp/byok.ipynb\",\"cell_idx\":\"2\",\"newString\":\"print(2)\",\"oldString\":\"print(1)\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-edit-notebook-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "edit notebook" }],
        tools: [{ name: "EditNotebook", description: "edit notebook", inputSchema: { type: "object", properties: { target_notebook: { type: "string" }, cell_idx: { type: "integer" }, new_string: { type: "string" }, old_string: { type: "string" } }, required: ["target_notebook", "cell_idx", "new_string"] } }],
      },
      requestId: "req-openai-chat-edit-notebook-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          editResult: {
            success: {
              path: "/tmp/byok.ipynb",
              message: "The notebook /tmp/byok.ipynb has been updated.",
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"target_notebook\":\"/tmp/byok.ipynb\",\"cell_idx\":2,\"new_string\":\"print(2)\",\"old_string\":\"print(1)\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "notebook-alias", options: { toolName: "EditNotebook", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "The notebook /tmp/byok.ipynb has been updated.");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs ReadLints path alias before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "lints-alias", index: 0, function: { name: "ReadLints", arguments: "{\"path\":\"/tmp/project/src/index.js\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-lints-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "lint it" }],
        tools: [{ name: "ReadLints", description: "read lints", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } } }],
      },
      requestId: "req-openai-chat-read-lints-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        // Native inner-executor shape: per-path diagnostics, unfiltered
        // severities (the BYOK render applies the ERROR/WARNING-only filter).
        return normalizeExecClientResult({
          execId: toolCallId,
          diagnosticsResult: {
            success: {
              path: "/tmp/project/src/index.js",
              diagnostics: [
                { severity: 1, message: "Missing semicolon", range: { start: { line: 12, column: 5 }, end: { line: 12, column: 6 } } },
                { severity: 3, message: "Info should be filtered", range: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } } },
              ],
              totalDiagnostics: 2,
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"paths\":[\"/tmp/project/src/index.js\"]}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "lints-alias", options: { toolName: "ReadLints", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(
      requests[1].messages.at(-1).content,
      "Found 1 linter error in 1 file:\n/tmp/project/src/index.js (1 error):\n  [ERROR] L12:5 - Missing semicolon",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider ignores extra WebFetch keys before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "webfetch-extra", index: 0, function: { name: "WebFetch", arguments: "{\"url\":\"https://example.com\",\"method\":\"POST\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-webfetch-extra",
        systemPrompt: "system",
        messages: [{ role: "user", content: "fetch it" }],
        tools: [{ name: "WebFetch", description: "fetch", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-webfetch-extra",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          fetchResult: {
            success: {
              url: "https://example.com",
              markdown: "# Example",
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"url\":\"https://example.com\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "webfetch-extra", options: { toolName: "WebFetch", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "# Content from https://example.com\n\n# Example");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Delete path aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "delete-alias", index: 0, function: { name: "Delete", arguments: "{\"filePath\":\"/tmp/a.txt\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-delete-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "delete it" }],
        tools: [{ name: "Delete", description: "delete", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      },
      requestId: "req-openai-chat-delete-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          deleteResult: {
            permissionDenied: { path: "/tmp/a.txt" },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"path\":\"/tmp/a.txt\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "delete-alias", options: { toolName: "Delete", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Permission denied: /tmp/a.txt");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Write aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "write-alias", index: 0, function: { name: "Write", arguments: "{\"filePath\":\"/tmp/a.txt\",\"content\":\"hello\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-write-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "write it" }],
        tools: [{ name: "Write", description: "write", inputSchema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"] } }],
      },
      requestId: "req-openai-chat-write-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          writeResult: {
            success: { path: "/tmp/a.txt" },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"path\":\"/tmp/a.txt\",\"contents\":\"hello\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "write-alias", options: { toolName: "Write", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Wrote contents to /tmp/a.txt");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Edit aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "edit-alias", index: 0, function: { name: "Edit", arguments: "{\"filePath\":\"/tmp/a.txt\",\"oldString\":\"a\",\"newString\":\"b\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-edit-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "edit it" }],
        tools: [{ name: "Edit", description: "edit", inputSchema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } }],
      },
      requestId: "req-openai-chat-edit-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          editResult: {
            success: {
              path: "/tmp/a.txt",
              message: "The file /tmp/a.txt has been updated.",
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"path\":\"/tmp/a.txt\",\"old_string\":\"a\",\"new_string\":\"b\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "edit-alias", options: { toolName: "Edit", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "The file /tmp/a.txt has been updated.");
  } finally {
    restore();
  }
});

test("OpenAI provider ignores extra ApplyPatch keys before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "patch-extra", index: 0, function: { name: "ApplyPatch", arguments: "{\"patch\":\"*** Begin Patch\\n*** Update File: /tmp/a.txt\\n@@\\n-old\\n+new\\n*** End Patch\\n\",\"filename\":\"/tmp/a.txt\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-applypatch-extra",
        systemPrompt: "system",
        messages: [{ role: "user", content: "patch it" }],
        tools: [{ name: "ApplyPatch", description: "apply patch", inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-applypatch-extra",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          editResult: {
            success: {
              path: "/tmp/a.txt",
              message: "Patch applied successfully.",
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"patch\":\"*** Begin Patch\\n*** Update File: /tmp/a.txt\\n@@\\n-old\\n+new\\n*** End Patch\\n\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "patch-extra", options: { toolName: "ApplyPatch", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Patch applied successfully.");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs Shell aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "shell-alias", index: 0, function: { name: "Shell", arguments: "{\"command\":\"pwd\",\"cwd\":\"/tmp/project\",\"timeout\":1500}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-shell-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "run shell" }],
        tools: [{ name: "Shell", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" }, working_directory: { type: "string" }, block_until_ms: { type: "integer" } }, required: ["command"] } }],
      },
      requestId: "req-openai-chat-shell-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          shellResult: {
            success: {
              command: "pwd",
              workingDirectory: "/tmp/project",
              stdout: "/tmp/project\n",
              exitCode: 0,
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"command\":\"pwd\",\"working_directory\":\"/tmp/project\",\"block_until_ms\":1500}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "shell-alias", options: { toolName: "Shell", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Exit code: 0\n\nCommand output:\n\n```\n/tmp/project\n\n```\n\nCommand completed.\n\nShell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project");
  } finally {
    restore();
  }
});

test("OpenAI provider preserves Shell hardTimeout before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "shell-hard-timeout", index: 0, function: { name: "Shell", arguments: "{\"command\":\"pwd\",\"hardTimeout\":45000}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-shell-hard-timeout",
        systemPrompt: "system",
        messages: [{ role: "user", content: "run shell with hard timeout" }],
        tools: [{ name: "Shell", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" }, working_directory: { type: "string" }, block_until_ms: { type: "integer" } }, required: ["command"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-shell-hard-timeout",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          shellResult: {
            success: {
              command: "pwd",
              workingDirectory: "/tmp/project",
              stdout: "/tmp/project\n",
              exitCode: 0,
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = JSON.stringify({ command: "pwd", hardTimeout: 45000 });
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "shell-hard-timeout", options: { toolName: "Shell", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Exit code: 0\n\nCommand output:\n\n```\n/tmp/project\n\n```\n\nCommand completed.\n\nShell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project");
  } finally {
    restore();
  }
});

test("OpenAI provider repairs CallMcpTool aliases before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-alias", index: 0, function: { name: "CallMcpTool", arguments: "{\"name\":\"filesystem.read_file\",\"args\":{\"path\":\"/tmp/a\"},\"provider\":\"filesystem\",\"tool_name\":\"read_file\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-call-mcp-tool-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "call mcp" }],
        tools: [{ name: "CallMcpTool", description: "call mcp", inputSchema: { type: "object", properties: { name: { type: "string" }, args: { type: "object", additionalProperties: true }, providerIdentifier: { type: "string" }, toolName: { type: "string" } }, required: ["name", "args", "providerIdentifier", "toolName"] } }],
      },
      requestId: "req-openai-chat-call-mcp-tool-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpResult: {
            success: {
              content: [{ content: { case: "text", value: { text: "alpha body" } } }],
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"name\":\"filesystem.read_file\",\"args\":{\"path\":\"/tmp/a\"},\"providerIdentifier\":\"filesystem\",\"toolName\":\"read_file\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "mcp-alias", options: { toolName: "CallMcpTool", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "alpha body");
  } finally {
    restore();
  }
});

test("OpenAI provider ignores extra ListMcpResources keys before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-list-extra", index: 0, function: { name: "ListMcpResources", arguments: "{\"server\":\"docs\",\"unexpected\":true}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-list-extra",
        systemPrompt: "system",
        messages: [{ role: "user", content: "list resources" }],
        tools: [{ name: "ListMcpResources", description: "list resources", inputSchema: { type: "object", properties: { server: { type: "string" } }, additionalProperties: false } }],
      },
      requestId: "req-openai-chat-mcp-list-extra",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          listMcpResourcesExecResult: {
            success: {
              resources: [{ server: "docs", uri: "doc://alpha", name: "Alpha" }],
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"server\":\"docs\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "mcp-list-extra", options: { toolName: "ListMcpResources", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "docs doc://alpha - Alpha");
  } finally {
    restore();
  }
});

test("OpenAI provider ignores extra FetchMcpResource keys before Cursor execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-read-extra", index: 0, function: { name: "FetchMcpResource", arguments: "{\"server\":\"docs\",\"uri\":\"doc://alpha\",\"downloadPath\":\"/tmp/alpha.txt\",\"unexpected\":true}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-read-extra",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read resource" }],
        tools: [{ name: "FetchMcpResource", description: "read resource", inputSchema: { type: "object", properties: { server: { type: "string" }, uri: { type: "string" }, downloadPath: { type: "string" } }, required: ["server", "uri"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-mcp-read-extra",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readMcpResourceExecResult: {
            success: {
              uri: "doc://alpha",
              content: { case: "text", value: "alpha body" },
            },
          },
        });
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"server\":\"docs\",\"uri\":\"doc://alpha\",\"downloadPath\":\"/tmp/alpha.txt\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "mcp-read-extra", options: { toolName: "FetchMcpResource", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "alpha body");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider strips redundant Grep -n before execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-n", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\",\"path\":\"/tmp/project\",\"-n\":true}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-grep-n",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-grep-n",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "needle",
              outputMode: "count",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "count",
                    value: { totalMatches: 3, totalFiles: 1 },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    const repairedArguments = "{\"pattern\":\"needle\",\"path\":\"/tmp/project\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.id, event.name, event.localResult?.case]), [["grep-n", "Grep", undefined]]);
    assert.deepEqual(waitCalls, [{ toolCallId: "grep-n", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.name, "Grep");
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "[/tmp/project] total_matches=3 total_files=1");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider repairs double-encoded Grep JSON arguments before execution and history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-json", index: 0, function: { name: "Grep", arguments: "\"{\\\"pattern\\\":\\\"needle\\\",\\\"path\\\":\\\"/tmp/project\\\"}\"" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-grep-double-json",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-grep-double-json",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "needle",
              outputMode: "count",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "count",
                    value: { totalMatches: 3, totalFiles: 1 },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const repairedArguments = "{\"pattern\":\"needle\",\"path\":\"/tmp/project\"}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "grep-json", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "[/tmp/project] total_matches=3 total_files=1");
  } finally {
    restore();
  }
});

test("OpenAI Chat provider repairs workspace-root typos in Grep paths before execution and history", async () => {
  const workspaceRoot = "/Users/jun.c.liu/source/ccursor-analysis";
  const typoPath = "/Users/jun.c.liu/source/ccursor-analysi/src/server";
  const repairedPath = "/Users/jun.c.liu/source/ccursor-analysis/src/server";
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "grep-path-typo",
                        index: 0,
                        function: {
                          name: "Grep",
                          arguments: `{"pattern":"evict","path":"${typoPath}"}`,
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-grep-path-typo",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        workspaceRoots: [workspaceRoot],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-openai-chat-grep-path-typo",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evict",
              outputMode: "count",
              workspaceResults: {
                "/Users/jun.c.liu/source/ccursor-analysis": {
                  result: {
                    case: "count",
                    value: { totalMatches: 1, totalFiles: 1 },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const repairedArguments = `{"pattern":"evict","path":"${repairedPath}"}`;
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "grep-path-typo", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(
      requests[1].messages.at(-1).content,
      "[/Users/jun.c.liu/source/ccursor-analysis] total_matches=1 total_files=1",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider does not rewrite AwaitShell identifiers that only resemble workspace paths", async () => {
  const workspaceRoot = "/Users/jun.c.liu/source/ccursor-analysis";
  const shellId = "/Users/jun.c.liu/source/ccursor-analysi/src/server";
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "await-shell-id",
                        index: 0,
                        function: {
                          name: "AwaitShell",
                          arguments: `{"shellId":"${shellId}","blockUntilMs":1500}`,
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-await-shell-id",
        systemPrompt: "system",
        messages: [{ role: "user", content: "wait for it" }],
        workspaceRoots: [workspaceRoot],
      },
      requestId: "req-openai-chat-await-shell-id",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          subagentAwaitResult: {
            success: {
              complete: {
                taskId: shellId,
                runtimeMs: 1200,
                outputFilePath: "/tmp/shell.out",
                outputLength: 31,
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = `{"shell_id":"${shellId}","block_until_ms":1500}`;
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "await-shell-id", options: { toolName: "AwaitShell", toolArguments: argumentsJson } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, argumentsJson);
    assert.equal(
      requests[1].messages.at(-1).content,
      "Task complete.\noutput_file_path: /tmp/shell.out\noutput_length: 31",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider accepts numeric AwaitShell identifiers before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "await-shell-numeric",
                        index: 0,
                        function: {
                          name: "AwaitShell",
                          arguments: "{\"shellId\":42,\"blockUntilMs\":1500}",
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-await-shell-numeric",
        systemPrompt: "system",
        messages: [{ role: "user", content: "wait for shell 42" }],
      },
      requestId: "req-openai-chat-await-shell-numeric",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          subagentAwaitResult: {
            success: {
              complete: {
                taskId: "42",
                runtimeMs: 1200,
                outputFilePath: "/tmp/shell.out",
                outputLength: 3,
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = "{\"shell_id\":\"42\",\"block_until_ms\":1500}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "await-shell-numeric", options: { toolName: "AwaitShell", toolArguments: argumentsJson } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, argumentsJson);
    assert.equal(
      requests[1].messages.at(-1).content,
      "Task complete.\noutput_file_path: /tmp/shell.out\noutput_length: 3",
    );
  } finally {
    restore();
  }
});

test("OpenAI Chat provider does not rewrite WriteShellStdin shell identifiers that resemble workspace paths", async () => {
  const workspaceRoot = "/Users/jun.c.liu/source/ccursor-analysis";
  const shellId = "/Users/jun.c.liu/source/ccursor-analysi/src/server";
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "write-shell-stdin-id",
                        index: 0,
                        function: {
                          name: "WriteShellStdin",
                          arguments: `{"shellId":"${shellId}","chars":"y\\n"}`,
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-write-shell-stdin-id",
        systemPrompt: "system",
        messages: [{ role: "user", content: "send stdin" }],
        workspaceRoots: [workspaceRoot],
      },
      requestId: "req-openai-chat-write-shell-stdin-id",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          writeShellStdinResult: {
            success: { shellId },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = `{"shell_id":"${shellId}","chars":"y\\n"}`;
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "write-shell-stdin-id", options: { toolName: "WriteShellStdin", toolArguments: argumentsJson } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, argumentsJson);
    assert.equal(requests[1].messages.at(-1).content, `Successfully wrote to shell ${shellId} stdin.`);
  } finally {
    restore();
  }
});

test("OpenAI provider repairs AskQuestion aliases and ignores nested unsupported keys before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-ask", index: 0, function: { name: "AskQuestion", arguments: "{\"title\":\"Pick one\",\"questions\":[{\"id\":\"q1\",\"prompt\":\"Pick\",\"allowMultiple\":true,\"options\":[{\"id\":\"a\",\"label\":\"A\",\"extra\":\"bad\"}],\"extra\":\"bad\"}],\"extra\":\"bad\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-ask-nested",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ask" }],
      },
      requestId: "req-openai-chat-ask-nested",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {
          message: {
            case: "byokInteractionToolResult",
            value: {
              toolName: "AskQuestion",
              toolArguments: JSON.parse(options.toolArguments),
              interactionResponse: {
                id: 1,
                result: {
                  case: "askQuestionInteractionResponse",
                  value: {
                    result: {
                      case: "success",
                      value: {
                        answers: [{
                          questionId: "q1",
                          selectedOptionIds: ["a"],
                          freeformText: "",
                        }],
                      },
                    },
                  },
                },
              },
            },
          },
        };
      },
    })) {
      // Drain stream.
    }

    const repairedArguments = "{\"title\":\"Pick one\",\"questions\":[{\"id\":\"q1\",\"prompt\":\"Pick\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],\"allow_multiple\":true}]}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-ask", options: { toolName: "AskQuestion", toolArguments: repairedArguments } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, repairedArguments);
    assert.equal(requests[1].messages.at(-1).content, "Question q1: selected [a]");
  } finally {
    restore();
  }
});

test("OpenAI provider rejects enum and const schema violations before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-mode", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\",\"output_mode\":\"summary\",\"fixed\":\"wrong\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-enum",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{
          name: "Grep",
          description: "grep",
          inputSchema: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
              fixed: { type: "string", const: "exact" },
            },
            required: ["pattern"],
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-grep-enum",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-mode");
    assert.match(requests[1].messages.at(-1).content, /Invalid Grep input/);
    assert.match(requests[1].messages.at(-1).content, /output_mode must be one of "content", "files_with_matches", "count"/);
    // Grep's alias repair strips unknown keys before validation, so a const
    // violation can never fire on Grep; positive const coverage lives in the
    // DynamicTool test below.
    assert.doesNotMatch(requests[1].messages.at(-1).content, /fixed must equal "exact"/);
  } finally {
    restore();
  }
});

test("OpenAI provider rejects const schema violations on non-aliased tools before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "const-bad", index: 0, function: { name: "DynamicTool", arguments: "{\"fixed\":\"wrong\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "const-good", index: 0, function: { name: "DynamicTool", arguments: "{\"fixed\":\"exact\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-const-violation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "call the tool" }],
        tools: [{
          name: "DynamicTool",
          description: "custom tool with a const constraint",
          inputSchema: {
            type: "object",
            properties: {
              fixed: { type: "string", const: "exact" },
            },
            required: ["fixed"],
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-const-violation",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[1].messages.at(-1).tool_call_id, "const-bad");
    assert.match(requests[1].messages.at(-1).content, /Invalid DynamicTool input/);
    assert.match(requests[1].messages.at(-1).content, /fixed must equal "exact"/);
    assert.deepEqual(waitCalls.map((call) => call.toolCallId), ["const-good"]);
  } finally {
    restore();
  }
});

test("OpenAI provider validates additionalProperties schema before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-extra", index: 0, function: { name: "DynamicTool", arguments: "{\"known\":\"ok\",\"extra\":42}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-extra", index: 0, function: { name: "DynamicTool", arguments: "{\"known\":\"ok\",\"extra\":\"fine\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-dynamic-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "dynamic" }],
        tools: [{
          name: "DynamicTool",
          description: "dynamic",
          inputSchema: {
            type: "object",
            properties: {
              known: { type: "string" },
            },
            required: ["known"],
            additionalProperties: { type: "string" },
          },
        }],
      },
      requestId: "req-openai-chat-dynamic-schema",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-extra",
      options: { toolName: "DynamicTool", toolArguments: "{\"known\":\"ok\",\"extra\":\"fine\"}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-extra");
    assert.match(requests[1].messages.at(-1).content, /Invalid DynamicTool input/);
    assert.match(requests[1].messages.at(-1).content, /extra must be string/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-extra");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});

test("OpenAI provider closes nested object schemas before provider calls and validation", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-nested-extra", index: 0, function: { name: "NestedTool", arguments: "{\"payload\":{\"id\":\"ok\",\"extra\":\"bad\"}}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-nested", index: 0, function: { name: "NestedTool", arguments: "{\"payload\":{\"id\":\"ok\"}}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-nested-closed-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "nested" }],
        tools: [{
          name: "NestedTool",
          description: "nested",
          inputSchema: {
            type: "object",
            properties: {
              payload: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
            required: ["payload"],
          },
        }],
      },
      requestId: "req-openai-chat-nested-closed-schema",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    const parameters = requests[0].tools[0].function.parameters;
    assert.equal(parameters.additionalProperties, false);
    assert.equal(parameters.properties.payload.additionalProperties, false);
    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-nested",
      options: { toolName: "NestedTool", toolArguments: "{\"payload\":{\"id\":\"ok\"}}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-nested-extra");
    assert.match(requests[1].messages.at(-1).content, /Invalid NestedTool input/);
    assert.match(requests[1].messages.at(-1).content, /unsupported key: payload\.extra/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-nested");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});

test("OpenAI provider rejects scalar schema constraint violations before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-constraints", index: 0, function: { name: "ConstrainedTool", arguments: "{\"name\":\"ab\",\"count\":11,\"step\":5,\"tags\":[]}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-scalar-constraints",
        systemPrompt: "system",
        messages: [{ role: "user", content: "constrained" }],
        tools: [{
          name: "ConstrainedTool",
          description: "constrained",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 3, maxLength: 5, pattern: "^[A-Z]+$" },
              count: { type: "integer", minimum: 1, maximum: 10 },
              step: { type: "integer", multipleOf: 2 },
              tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
            },
            required: ["name", "count", "step", "tags"],
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-scalar-constraints",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-constraints");
    assert.match(requests[1].messages.at(-1).content, /Invalid ConstrainedTool input/);
    assert.match(requests[1].messages.at(-1).content, /name length must be at least 3/);
    assert.match(requests[1].messages.at(-1).content, /name must match pattern \^\[A-Z\]\+\$/);
    assert.match(requests[1].messages.at(-1).content, /count must be <= 10/);
    assert.match(requests[1].messages.at(-1).content, /step must be a multiple of 2/);
    assert.match(requests[1].messages.at(-1).content, /tags must contain at least 1 item\(s\)/);
  } finally {
    restore();
  }
});

test("OpenAI provider validates object schema constraints before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-object", index: 0, function: { name: "ObjectTool", arguments: "{\"known\":\"ok\",\"x_bad\":3,\"bad-name\":\"no\",\"x_extra\":\"overflow\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-object", index: 0, function: { name: "ObjectTool", arguments: "{\"known\":\"ok\",\"x_good\":\"yes\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-object-constraints",
        systemPrompt: "system",
        messages: [{ role: "user", content: "object" }],
        tools: [{
          name: "ObjectTool",
          description: "object",
          inputSchema: {
            type: "object",
            properties: {
              known: { type: "string" },
            },
            required: ["known"],
            maxProperties: 3,
            propertyNames: { pattern: "^[A-Za-z_]+$" },
            patternProperties: {
              "^x_": { type: "string" },
            },
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-object-constraints",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-object",
      options: { toolName: "ObjectTool", toolArguments: "{\"known\":\"ok\",\"x_good\":\"yes\"}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-object");
    assert.match(requests[1].messages.at(-1).content, /Invalid ObjectTool input/);
    assert.match(requests[1].messages.at(-1).content, /input must contain at most 3 propertie\(s\)/);
    assert.match(requests[1].messages.at(-1).content, /bad-name property name must match pattern \^\[A-Za-z_\]\+\$/);
    assert.match(requests[1].messages.at(-1).content, /unsupported key: bad-name/);
    assert.match(requests[1].messages.at(-1).content, /x_bad must be string/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-object");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});

test("OpenAI provider validates array schema constraints before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-array", index: 0, function: { name: "ArrayTool", arguments: "{\"tuple\":[\"id\",3,\"extra\"],\"unique\":[\"a\",\"a\"],\"contains\":[1,2,3]}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-array", index: 0, function: { name: "ArrayTool", arguments: "{\"tuple\":[\"id\",3],\"unique\":[\"a\",\"b\"],\"contains\":[1,\"ok\",2]}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-array-constraints",
        systemPrompt: "system",
        messages: [{ role: "user", content: "array" }],
        tools: [{
          name: "ArrayTool",
          description: "array",
          inputSchema: {
            type: "object",
            properties: {
              tuple: {
                type: "array",
                prefixItems: [{ type: "string" }, { type: "integer" }],
                additionalItems: false,
              },
              unique: {
                type: "array",
                uniqueItems: true,
                items: { type: "string" },
              },
              contains: {
                type: "array",
                contains: { type: "string" },
                minContains: 1,
                maxContains: 1,
              },
            },
            required: ["tuple", "unique", "contains"],
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-array-constraints",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-array",
      options: { toolName: "ArrayTool", toolArguments: "{\"tuple\":[\"id\",3],\"unique\":[\"a\",\"b\"],\"contains\":[1,\"ok\",2]}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-array");
    assert.match(requests[1].messages.at(-1).content, /Invalid ArrayTool input/);
    assert.match(requests[1].messages.at(-1).content, /tuple must contain at most 2 tuple item\(s\)/);
    assert.match(requests[1].messages.at(-1).content, /unique must contain unique item\(s\)/);
    assert.match(requests[1].messages.at(-1).content, /contains must contain at least 1 matching item\(s\)/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-array");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});

test("OpenAI provider validates conditional schema constraints before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-conditional", index: 0, function: { name: "ConditionalTool", arguments: "{\"mode\":\"advanced\",\"token\":\"x\",\"forbidden\":\"no\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-conditional", index: 0, function: { name: "ConditionalTool", arguments: "{\"mode\":\"advanced\",\"token\":\"x\",\"detail\":\"yes\",\"extra\":\"ok\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-conditional-constraints",
        systemPrompt: "system",
        messages: [{ role: "user", content: "conditional" }],
        tools: [{
          name: "ConditionalTool",
          description: "conditional",
          inputSchema: {
            type: "object",
            properties: {
              mode: { type: "string" },
              detail: { type: "string" },
              token: { type: "string" },
              extra: { type: "string" },
              forbidden: { type: "string" },
            },
            required: ["mode"],
            not: {
              type: "object",
              required: ["forbidden"],
            },
            if: {
              type: "object",
              properties: { mode: { const: "advanced" } },
              required: ["mode"],
            },
            then: {
              type: "object",
              required: ["detail"],
            },
            dependentRequired: {
              token: ["detail"],
            },
            dependentSchemas: {
              extra: {
                type: "object",
                required: ["detail"],
              },
            },
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-conditional-constraints",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-conditional",
      options: { toolName: "ConditionalTool", toolArguments: "{\"mode\":\"advanced\",\"token\":\"x\",\"detail\":\"yes\",\"extra\":\"ok\"}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-conditional");
    assert.match(requests[1].messages.at(-1).content, /Invalid ConditionalTool input/);
    assert.match(requests[1].messages.at(-1).content, /input must not match the not schema/);
    assert.match(requests[1].messages.at(-1).content, /missing required key: detail/);
    assert.match(requests[1].messages.at(-1).content, /missing dependent key: detail required by token/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-conditional");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});

test("OpenAI provider validates local ref schema constraints before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "bad-ref", index: 0, function: { name: "RefTool", arguments: "{\"payload\":{\"id\":\"ok\",\"extra\":\"bad\"}}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "good-ref", index: 0, function: { name: "RefTool", arguments: "{\"payload\":{\"id\":\"ok\"}}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-ref-constraints",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ref" }],
        tools: [{
          name: "RefTool",
          description: "ref",
          inputSchema: {
            type: "object",
            properties: {
              payload: { $ref: "#/$defs/payload" },
            },
            required: ["payload"],
            $defs: {
              payload: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
            additionalProperties: false,
          },
        }],
      },
      requestId: "req-openai-chat-ref-constraints",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return { message: { case: "shellResult", value: { result: { case: "success", value: { stdout: "ok", stderr: "", exitCode: 0 } } } } };
      },
    })) {
      // Drain stream.
    }

    assert.equal(requests.length, 3);
    assert.deepEqual(waitCalls, [{
      toolCallId: "good-ref",
      options: { toolName: "RefTool", toolArguments: "{\"payload\":{\"id\":\"ok\"}}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "bad-ref");
    assert.match(requests[1].messages.at(-1).content, /Invalid RefTool input/);
    assert.match(requests[1].messages.at(-1).content, /unsupported key: payload.extra/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "good-ref");
    assert.match(requests[2].messages.at(-1).content, /Command output:\n\n```\nok\n```/);
  } finally {
    restore();
  }
});


test("OpenAI Chat provider ignores duplicate tool_calls finish chunks", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "call-dup", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-duplicate-finish",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-duplicate-finish",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a", readRange: { startLine: 1 } } },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(events.filter((event) => event.type === "tool_use_done" && event.id === "call-dup").length, 1);
    assert.deepEqual(waitCalls, [{ toolCallId: "call-dup", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
    assert.equal(requests[1].messages.at(-2).tool_calls.length, 1);
    assert.equal(requests[1].messages.filter((message) => message.tool_call_id === "call-dup").length, 1);
  } finally {
    restore();
  }
});

test("OpenAI Chat stream parser accepts legacy function_call deltas", async () => {
  const events = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { function_call: { name: "Read" } } }] },
    { choices: [{ delta: { function_call: { arguments: "{\"path\"" } } }] },
    { choices: [{ delta: { function_call: { arguments: ":\"/tmp/a\"}" } }, finish_reason: "function_call" }] },
  ]));
  assert.deepEqual(events, [
    { type: "tool_use_start", id: "tool-0", name: "Read" },
    { type: "tool_use_delta", id: "tool-0", input: "{\"path\"" },
    { type: "tool_use_delta", id: "tool-0", input: ":\"/tmp/a\"}" },
    { type: "tool_use_done", id: "tool-0", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
    { type: "done", stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
});

test("OpenAI Chat stream parser preserves custom tool call input events", async () => {
  const events = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { tool_calls: [{ id: "custom-1", index: 0, type: "custom", custom: { name: "Read", input: "initial" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, type: "custom", custom: { input: " streamed" } }] }, finish_reason: "tool_calls" }] },
  ]));

  assert.deepEqual(events, [
    { type: "tool_use_start", id: "custom-1", name: "Read" },
    { type: "tool_use_delta", id: "custom-1", input: "initial" },
    { type: "tool_use_delta", id: "custom-1", input: " streamed" },
    { type: "tool_use_done", id: "custom-1", name: "Read", arguments: "initial streamed", providerToolType: "custom" },
    { type: "done", stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
});

test("OpenAI Chat stream parser forwards refusal deltas", async () => {
  const events = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { refusal: "cannot" } }] },
    { choices: [{ delta: { refusal: " comply" }, finish_reason: "stop" }] },
  ]));

  assert.deepEqual(events, [
    { type: "text_delta", text: "cannot" },
    { type: "text_delta", text: " comply" },
    { type: "done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
});

test("OpenAI Chat stream parser preserves non-stop finish reasons", async () => {
  const lengthEvents = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { content: "partial" }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } },
  ]));
  assert.deepEqual(lengthEvents, [
    { type: "text_delta", text: "partial" },
    { type: "done", stopReason: "length", usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 2 } },
  ]);

  const filterEvents = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { refusal: "blocked" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 7, completion_tokens: 0 } },
  ]));
  assert.deepEqual(filterEvents, [
    { type: "text_delta", text: "blocked" },
    { type: "done", stopReason: "content_filter", usage: { inputTokens: 7, outputTokens: 0 } },
  ]);
});

test("OpenAI Chat stream parser preserves final usage chunk without choices", async () => {
  const events = await collectOpenAiEvents(asyncIterable([
    { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } },
  ]));

  assert.deepEqual(events, [
    { type: "text_delta", text: "done" },
    { type: "done", stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 6 } },
  ]);
});


test("OpenAI provider loop waits for same-turn Cursor tool results concurrently", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "call-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
                        { id: "call-2", index: 1, function: { name: "Read", arguments: "{\"path\":\"/tmp/b\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    await runConcurrentReadToolWaits({
      toolCallIds: ["call-1", "call-2"],
      waitForToolResultOptions: [
        { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" },
        { toolName: "Read", toolArguments: "{\"path\":\"/tmp/b\"}" },
      ],
      afterSecondWait: async () => {
        assert.equal(requests.length, 1);
      },
      runAdapter: (waitForToolResult) => adapter.run({
        provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: "conv-1",
          systemPrompt: "system",
          messages: [{ role: "user", content: "read both" }],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        },
        requestId: "req-concurrent",
        waitForToolResult,
      }),
      assertFollowUp: async () => {
        assert.deepEqual(requests[1].messages.slice(-2).map((message) => message.tool_call_id), ["call-1", "call-2"]);
      },
    });
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses same-turn Cursor results for duplicate read-only tool calls", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "call-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
                        { id: "call-2", index: 1, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-dedupe",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read twice" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-dedupe",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "same" } },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "call-1",
      options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" },
    }]);
    assert.deepEqual(requests[1].messages.slice(-2).map((message) => [message.tool_call_id, message.content]), [
      ["call-1", "File: /tmp/a\nLines: 1-1\n     1|same"],
      ["call-2", "File: /tmp/a\nLines: 1-1\n     1|same"],
    ]);
  } finally {
    restore();
  }
});

test("OpenAI provider loop dedupes duplicate read-only tool calls by normalized execution input", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-1",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/a\",\"pattern\":\"foo\",\"output_mode\":\"content\"}",
                          },
                        },
                        {
                          id: "grep-2",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: "{\"output_mode\":\"content\",\"pattern\":\"foo\",\"path\":\"/tmp/a\",\"-n\":true}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-dedupe-normalized-execution-input",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep twice" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-dedupe-normalized-execution-input",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "foo",
              outputMode: "content",
              workspaceResults: {
                "/tmp/a": {
                  result: {
                    case: "content",
                    value: { matches: [{ file: "b.js", matches: [{ lineNumber: 4, content: "foo()" }] }] },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-1",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/a\",\"pattern\":\"foo\",\"output_mode\":\"content\"}",
      },
    }]);
    assert.deepEqual(requests[1].messages.slice(-2).map((message) => message.tool_call_id), ["grep-1", "grep-2"]);
    // Primary grep render (BYOK's reuse-guidance summary precedes the match line).
    assert.match(requests[1].messages.at(-1).content, /\[\/tmp\/a\] b\.js:4 foo\(\)$/);
    assert.equal(requests[1].messages.at(-2).content, requests[1].messages.at(-1).content);
  } finally {
    restore();
  }
});

test("OpenAI provider loop derives narrower same-batch Grep results from a broader symbol Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-func",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"func.*evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                        {
                          id: "grep-symbol",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-derived",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep symbol and definition" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-derived",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    assert.deepEqual(requests[1].messages.slice(-2).map((message) => message.tool_call_id), ["grep-func", "grep-symbol"]);
    assert.equal(
      requests[1].messages.at(-2).content,
      "[/tmp/project] batchtask_controller.go summary: resolved path /tmp/project/batchtask_controller.go; definition at line 2867; next Read (prefer these exact windows before any other same-file Read or Grep): path=/tmp/project/batchtask_controller.go offset=2861 limit=177\n" +
        "[/tmp/project] batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
    assert.match(requests[1].messages.at(-1).content, /callsite at line 317/);
  } finally {
    restore();
  }
});

test("OpenAI provider loop derives narrower same-batch Grep results from a broader alternation content Grep", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-alt-derived-"));
  const filePath = path.join(tmpRoot, "controller.go");
  fs.writeFileSync(filePath, [
    "func reconcile() {",
    "  evictLevel0ExternalPodsForHighPriority()",
    "  UpdateEvictedLevel0GPUMetric(1)",
    "}",
    "",
  ].join("\n"));
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-broad",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"UpdateEvictedLevel0GPUMetric|evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                        {
                          id: "grep-metric",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"UpdateEvictedLevel0GPUMetric","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-alt-derived",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep broad then exact metric symbol" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-alt-derived",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "UpdateEvictedLevel0GPUMetric|evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "controller.go",
                        matches: [
                          { lineNumber: 2, content: "  evictLevel0ExternalPodsForHighPriority()" },
                          { lineNumber: 3, content: "  UpdateEvictedLevel0GPUMetric(1)" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }

    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-broad",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${filePath}","pattern":"UpdateEvictedLevel0GPUMetric|evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    const metricMessage = toolMessages.find((message) => message.tool_call_id === "grep-metric");
    assert.ok(metricMessage);
    assert.match(metricMessage.content, /callsite at line 3 inside reconcile \(line 1\)/);
    assert.doesNotMatch(metricMessage.content, /evictLevel0ExternalPodsForHighPriority/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop derives narrower file-scoped enclosing-function Grep from a broader symbol Grep", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-enclosing-derived-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                        {
                          id: "grep-reconcile",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"func.*Reconcile","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-enclosing-derived",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep symbol and reconcile" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-enclosing-derived",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    const reconcileMessage = toolMessages.find((message) => message.tool_call_id === "grep-reconcile");
    assert.ok(reconcileMessage);
    assert.equal(
      reconcileMessage.content,
      `[${tmpRoot}] batchtask_controller.go summary: resolved path ${filePath}; definition at line 3; next Read (prefer these exact windows before any other same-file Read or Grep): path=${filePath} offset=1 limit=8`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop derives variant enclosing-function Grep from a broader symbol Grep", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-enclosing-variant-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                        {
                          id: "grep-reconcile",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"func \\\\(.*Reconcile|func .*Reconcile","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-enclosing-variant",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep symbol and reconcile variant" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-enclosing-variant",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    const reconcileMessage = toolMessages.find((message) => message.tool_call_id === "grep-reconcile");
    assert.ok(reconcileMessage);
    assert.equal(
      reconcileMessage.content,
      `[${tmpRoot}] batchtask_controller.go summary: resolved path ${filePath}; definition at line 3; next Read (prefer these exact windows before any other same-file Read or Grep): path=${filePath} offset=1 limit=8`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop reuses a prior broader Grep result for a later variant enclosing-function Grep", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-enclosing-variant-reuse-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-reconcile",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"func \\\\(.*Reconcile|func .*Reconcile","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-enclosing-variant-reuse",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep symbol then reconcile variant" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-enclosing-variant-reuse",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const reconcileMessage = toolMessages.find((message) => message.tool_call_id === "grep-reconcile");
    assert.ok(reconcileMessage);
    assert.equal(
      reconcileMessage.content,
      `[${tmpRoot}] batchtask_controller.go summary: resolved path ${filePath}; definition at line 3; next Read (prefer these exact windows before any other same-file Read or Grep): path=${filePath} offset=1 limit=8`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop does not emit an empty tool-use round when all tool calls are locally derived", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "grep-symbol", index: 0, function: { name: "Grep", arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        { id: "grep-func", index: 0, function: { name: "Grep", arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"func.*evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}" } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-no-empty-derived-round",
        systemPrompt: "system",
        messages: [{ role: "user", content: "derive then answer" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-no-empty-derived-round",
      waitForToolResult: async () => normalizeExecClientResult({
        grepResult: {
          success: {
            pattern: "evictLevel0ExternalPodsForHighPriority",
            outputMode: "content",
            workspaceResults: {
              "/tmp/project": {
                result: {
                  case: "content",
                  value: {
                    matches: [{
                      file: "batchtask_controller.go",
                      matches: [{ lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" }],
                    }],
                  },
                },
              },
            },
          },
        },
      }),
    })) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === "tool_use_done").map((event) => [event.id, event.name, event.localResult?.case]),
      [
        ["grep-symbol", "Grep", undefined],
        ["grep-func", "Grep", "byokExecResult"],
      ],
    );
    assert.equal(events.filter((event) => event.type === "done" && event.stopReason === "tool_use").length, 2);
    assert.equal(events.at(-1).stopReason, "end_turn");
  } finally {
    restore();
  }
});

test("OpenAI provider loop derives files-with-matches Grep from same-batch content Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-content",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                        {
                          id: "grep-files",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"files_with_matches\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-files-derived",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep files" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-files-derived",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [{ lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" }],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-content",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    const filesMessage = toolMessages.find((message) => message.tool_call_id === "grep-files");
    assert.ok(filesMessage);
    assert.equal(filesMessage.content, "[/tmp/project] batchtask_controller.go");
  } finally {
    restore();
  }
});

test("OpenAI provider loop derives symbol-variant count Grep from same-batch content Grep", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-count-variant-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "statusutil.PatchStatus(ctx, r.Status(), &bt, func(o *batchplatformv1.BatchTask) {",
    "  o.Status.Phase = batchplatformv1.BatchTaskRunning",
    "})",
    "",
  ].join("\n"));
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-content",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"PatchStatus","output_mode":"content"}`,
                          },
                        },
                        {
                          id: "grep-count",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"statusutil\\\\.PatchStatus","output_mode":"count"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-count-variant",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep PatchStatus and count statusutil.PatchStatus" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-count-variant",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "PatchStatus",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 3, content: "statusutil.PatchStatus(ctx, r.Status(), &bt, func(o *batchplatformv1.BatchTask) {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-content",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"PatchStatus","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    const countMessage = toolMessages.find((message) => message.tool_call_id === "grep-count");
    assert.ok(countMessage);
    assert.equal(countMessage.content, `[${tmpRoot}] total_matches=1 total_files=1`);
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop reuses a prior broader Grep result for a later narrower Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-func",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"func.*evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-reuse-across-batches",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep broader then narrower" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-reuse-across-batches",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-func");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      "[/tmp/project] batchtask_controller.go summary: resolved path /tmp/project/batchtask_controller.go; definition at line 2867; next Read (prefer these exact windows before any other same-file Read or Grep): path=/tmp/project/batchtask_controller.go offset=2861 limit=177\n" +
        "[/tmp/project] batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior exact-symbol Grep for a later same-path function-definition Grep with glob", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-func",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"func \\\\(r \\\\*BatchTaskReconciler\\\\) evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-symbol-to-function-with-glob",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep broad symbol then exact function definition" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-symbol-to-function-with-glob",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "controllers/batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-func");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      "[/tmp/project] controllers/batchtask_controller.go summary: resolved path /tmp/project/controllers/batchtask_controller.go; definition at line 2867; next Read (prefer these exact windows before any other same-file Read or Grep): path=/tmp/project/controllers/batchtask_controller.go offset=2861 limit=177\n" +
        "[/tmp/project] controllers/batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior content Grep result for a later same-pattern file-scoped content Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-broad",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-file",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project/batchtask_controller.go\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-reuse-same-pattern-file-scoped",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep broad then same pattern in one file" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-reuse-same-pattern-file-scoped",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }, {
                        file: "other.go",
                        matches: [
                          { lineNumber: 12, content: "func evictLevel0ExternalPodsForHighPriority() {}" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-broad",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-file");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      "[/tmp/project] batchtask_controller.go summary: resolved path /tmp/project/batchtask_controller.go; definition at line 2867; callsite at line 317; next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: Read path=/tmp/project/batchtask_controller.go offset=305 limit=33; helper window: Read path=/tmp/project/batchtask_controller.go offset=2861 limit=177; answer path: caller reaction in lines 305-337; helper behavior in lines 2861-3037; Do not request only the caller-reaction window; request the helper-behavior window too.; Do not shorten the helper Read; it should run through line 3037.; suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads\n" +
        "[/tmp/project] batchtask_controller.go:317 if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n" +
        "[/tmp/project] batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior function-definition content Grep for a later regex-variant function-definition Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-func-plain",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"func \\\\(r \\\\*BatchTaskReconciler\\\\) evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-func-variant",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"func \\\\(r \\\\*BatchTaskReconciler\\\\) evictLevel0ExternalPodsForHighPriority\\\\(\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-reuse-function-variant",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep function definition twice with regex variants" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-reuse-function-variant",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "func \\(r \\*BatchTaskReconciler\\) evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-func-plain",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"func \\\\(r \\\\*BatchTaskReconciler\\\\) evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-func-variant");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      "[/tmp/project] batchtask_controller.go summary: resolved path /tmp/project/batchtask_controller.go; definition at line 2867; next Read (prefer these exact windows before any other same-file Read or Grep): path=/tmp/project/batchtask_controller.go offset=2861 limit=177\n" +
        "[/tmp/project] batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior exact-symbol Grep for a later symbol-scoped outcome variant Grep", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-variant",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"evictedGPU, err := r\\\\.evictLevel0ExternalPodsForHighPriority|evictLevel0ExternalPodsForHighPriority\\\\(\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-symbol-outcome-variant",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep exact symbol then symbol-scoped outcome variant" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } }],
      },
      requestId: "req-grep-symbol-outcome-variant",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "controllers/batchtask_controller.go",
                        matches: [
                          { lineNumber: 317, content: "if evictedGPU, err := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); err != nil {" },
                          { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: "{\"path\":\"/tmp/project/controllers\",\"glob\":\"batchtask_controller.go\",\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-variant");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      "[/tmp/project] controllers/batchtask_controller.go summary: resolved path /tmp/project/controllers/batchtask_controller.go; definition at line 2867; callsite at line 317; next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: Read path=/tmp/project/controllers/batchtask_controller.go offset=305 limit=33; helper window: Read path=/tmp/project/controllers/batchtask_controller.go offset=2861 limit=177; answer path: caller reaction in lines 305-337; helper behavior in lines 2861-3037; Do not request only the caller-reaction window; request the helper-behavior window too.; Do not shorten the helper Read; it should run through line 3037.; suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads\n" +
        "[/tmp/project] controllers/batchtask_controller.go:317 if evictedGPU, err := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); err != nil {\n" +
        "[/tmp/project] controllers/batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior content Grep for later same-file Read windows that include matched lines", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-to-read-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-caller",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":3,"limit":6}`,
                          },
                        },
                        {
                          id: "read-helper",
                          index: 1,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":10,"limit":4}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-to-read-reuse",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep exact symbol then read caller and helper" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-grep-to-read-reuse",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 10, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods" },
                          { lineNumber: 11, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const callerRead = toolMessages.find((message) => message.tool_call_id === "read-caller");
    const helperRead = toolMessages.find((message) => message.tool_call_id === "read-helper");
    assert.ok(callerRead);
    assert.ok(helperRead);
    assert.match(callerRead.content, new RegExp(`^File: ${filePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\nLines: 3-8\\n`));
    assert.match(helperRead.content, new RegExp(`^File: ${filePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\nLines: 10-13\\n`));
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop reuses a prior root-scoped content Grep for later same-file Read windows", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-grep-root-to-read-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: "{\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-caller",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":3,"limit":6}`,
                          },
                        },
                        {
                          id: "read-helper",
                          index: 1,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":10,"limit":4}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-grep-root-to-read-reuse",
        systemPrompt: "system",
        workspaceRoots: [tmpRoot],
        messages: [{ role: "user", content: "grep exact symbol in repo root then read caller and helper" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-grep-root-to-read-reuse",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 10, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods" },
                          { lineNumber: 11, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: "{\"pattern\":\"evictLevel0ExternalPodsForHighPriority\",\"output_mode\":\"content\"}",
      },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const callerRead = toolMessages.find((message) => message.tool_call_id === "read-caller");
    const helperRead = toolMessages.find((message) => message.tool_call_id === "read-helper");
    assert.ok(callerRead);
    assert.ok(helperRead);
    assert.match(callerRead.content, new RegExp(`^File: ${filePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\nLines: 3-8\\n`));
    assert.match(helperRead.content, new RegExp(`^File: ${filePath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\nLines: 10-13\\n`));
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop injects synthetic Read history after a symbol Grep so the next request can answer directly", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-synthetic-read-history-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-synthetic-read-history",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep exact symbol then answer" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-synthetic-read-history",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "batchtask_controller.go",
                        matches: [
                          { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                          { lineNumber: 10, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods" },
                          { lineNumber: 11, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const assistantMessages = requests[1].messages.filter((message) => message.role === "assistant");
    const syntheticAssistant = assistantMessages.find((message) =>
      Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-read-grep-symbol-")));
    assert.ok(syntheticAssistant);
    assert.ok(syntheticAssistant.tool_calls.filter((call) => String(call.id || "").startsWith("prefetch-read-grep-symbol-")).length >= 1);
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    assert.ok(toolMessages.some((message) => String(message.tool_call_id || "").startsWith("prefetch-read-grep-symbol-")));
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider injects initial synthetic repository history for explicit-file understanding prompts", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-initial-synth-history-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-initial-synth-history",
        systemPrompt: "system",
        workspaceRoots: [tmpRoot],
        messages: [{ role: "user", content: "In ./batchtask_controller.go, explain how evictLevel0ExternalPodsForHighPriority is invoked and what it does." }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-initial-synth-history",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        throw new Error("unexpected tool call");
      },
    })) {
      // drain
    }

    assert.equal(waitCalls.length, 0);
    assert.equal(requests.length, 1);
    const assistantMessages = requests[0].messages.filter((message) => message.role === "assistant");
    const syntheticGrepAssistant = assistantMessages.find((message) =>
      Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-grep-")));
    assert.ok(syntheticGrepAssistant);
    const syntheticReadAssistant = assistantMessages.find((message) =>
      Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-read-prefetch-grep-")));
    assert.ok(syntheticReadAssistant);
    const toolMessages = requests[0].messages.filter((message) => message.role === "tool");
    assert.ok(toolMessages.some((message) => String(message.content || "").includes("definition at line 11")));
    assert.ok(toolMessages.some((message) => String(message.content || "").startsWith(`File: ${filePath}\nLines: 3-13\n`)));
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider emits provider-local tool events for prefetched Read calls", async () => {
  const requests = [];
  const events = [];
  const waitCalls = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-prefetched-read-event-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        id: "prefetched-read",
                        index: 0,
                        function: {
                          name: "Read",
                          arguments: JSON.stringify({ path: filePath, offset: 3, limit: 11 }),
                        },
                      }],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-prefetched-read-event",
        systemPrompt: "system",
        workspaceRoots: [tmpRoot],
        messages: [{ role: "user", content: "In ./batchtask_controller.go, explain how evictLevel0ExternalPodsForHighPriority is invoked and what it does." }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-prefetched-read-event",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]),
      [["Read", "byokExecResult"]],
    );
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[1].messages.at(-1).role, "tool");
    assert.deepEqual(requests[1].messages.at(-1).tool_call_id, "prefetched-read");
    assert.match(requests[1].messages.at(-1).content, new RegExp(`^File: ${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nLines: 3-13\\n`));
    assert.match(requests[1].messages.at(-1).content, /Requested lines are already contained in earlier Read lines 3-13/);
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider injects initial synthetic repository history for symbol-only prompts via workspace-root grep", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-initial-root-grep-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  const childProcess = require("node:child_process");
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = () => {
    const grepRows = [
      {
        type: "match",
        data: {
          path: { text: filePath },
          line_number: 4,
          lines: { text: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\\n" },
        },
      },
      {
        type: "match",
        data: {
          path: { text: filePath },
          line_number: 10,
          lines: { text: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods\\n" },
        },
      },
      {
        type: "match",
        data: {
          path: { text: filePath },
          line_number: 11,
          lines: { text: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\\n" },
        },
      },
    ];
    return grepRows.map((row) => JSON.stringify(row)).join("\n");
  };
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-initial-root-grep",
        systemPrompt: "system",
        workspaceRoots: [tmpRoot],
        messages: [{ role: "user", content: "Explain how evictLevel0ExternalPodsForHighPriority is invoked and what it does." }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-initial-root-grep",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        throw new Error("unexpected tool call");
      },
    })) {
      // drain
    }

    assert.equal(waitCalls.length, 0);
    assert.equal(requests.length, 1);
    const assistantMessages = requests[0].messages.filter((message) => message.role === "assistant");
    const syntheticGrepAssistant = assistantMessages.find((message) =>
      Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-grep-")));
    assert.ok(syntheticGrepAssistant);
    const grepCall = syntheticGrepAssistant.tool_calls.find((call) => String(call.id || "").startsWith("prefetch-grep-"));
    assert.equal(JSON.parse(grepCall.function.arguments).path, filePath);
    const toolMessages = requests[0].messages.filter((message) => message.role === "tool");
    assert.ok(toolMessages.some((message) => String(message.content || "").includes("definition at line 11")));
    assert.ok(toolMessages.some((message) => String(message.content || "").startsWith(`File: ${filePath}\nLines: 3-13\n`)));
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop prioritizes production caller and helper synthetic Reads over lower-value test callsites", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-synthetic-read-priority-"));
  const controllerPath = path.join(tmpRoot, "batchtask_controller.go");
  const testPath = path.join(tmpRoot, "eviction_test.go");
  fs.writeFileSync(controllerPath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  fs.writeFileSync(testPath, [
    "package controllers",
    "",
    "func TestOne(t *testing.T) {",
    "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)",
    "}",
    "",
    "func TestTwo(t *testing.T) {",
    "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)",
    "}",
    "",
    "func TestThree(t *testing.T) {",
    "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)",
    "}",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-symbol",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-synthetic-read-priority",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep exact symbol then answer" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-synthetic-read-priority",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "evictLevel0ExternalPodsForHighPriority",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [
                        {
                          file: "eviction_test.go",
                          matches: [
                            { lineNumber: 4, content: "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)" },
                            { lineNumber: 8, content: "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)" },
                            { lineNumber: 12, content: "  reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)" },
                          ],
                        },
                        {
                          file: "batchtask_controller.go",
                          matches: [
                            { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                            { lineNumber: 10, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods" },
                            { lineNumber: 11, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-symbol",
      options: {
        toolName: "Grep",
        toolArguments: `{"path":"${tmpRoot}","pattern":"evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
      },
    }]);
    const syntheticAssistant = requests[1].messages.find((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-read-grep-symbol-")));
    assert.ok(syntheticAssistant);
    const readCalls = syntheticAssistant.tool_calls.map((call) => JSON.parse(call.function.arguments));
    assert.deepEqual(readCalls, [
      { path: controllerPath, offset: 3, limit: 11 },
    ]);
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop injects synthetic top-level symbol Read history for cross-file metric questions", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-synthetic-metric-history-"));
  const controllerPath = path.join(tmpRoot, "batchtask_controller.go");
  const metricsPath = path.join(tmpRoot, "metrics.go");
  fs.writeFileSync(controllerPath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  UpdateEvictedLevel0GPUMetric(1)",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  fs.writeFileSync(metricsPath, [
    "package controllers",
    "",
    "import \"github.com/prometheus/client_golang/prometheus\"",
    "",
    "var (",
    "\t// Eviction metrics for level-0 external pod eviction",
    "\tevictedLevel0GPU = prometheus.NewGauge(",
    "\t\tprometheus.GaugeOpts{",
    "\t\t\tName: \"level0_gpu_released\",",
    "\t\t\tHelp: \"Total GPU released by evicting level-0 external pods for high-priority tasks\",",
    "\t\t},",
    "\t)",
    ")",
    "",
    "// UpdateEvictedLevel0GPUMetric records GPU released by level-0 pod eviction",
    "func UpdateEvictedLevel0GPUMetric(gpu int64) {",
    "\tevictedLevel0GPU.Set(float64(gpu))",
    "}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-controller",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${controllerPath}","pattern":"UpdateEvictedLevel0GPUMetric|evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                        {
                          id: "grep-metrics",
                          index: 1,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${metricsPath}","pattern":"UpdateEvictedLevel0GPUMetric|EvictedLevel0GPU|evicted_level0","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-synthetic-metric-history",
        systemPrompt: "system",
        messages: [{ role: "user", content: "explain the metric relationship" }],
        tools: [
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
        ],
      },
      requestId: "req-synthetic-metric-history",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        if (toolCallId === "grep-controller") {
          return normalizeExecClientResult({
            execId: toolCallId,
            grepResult: {
              success: {
                pattern: "UpdateEvictedLevel0GPUMetric|evictLevel0ExternalPodsForHighPriority",
                outputMode: "content",
                workspaceResults: {
                  [tmpRoot]: {
                    result: {
                      case: "content",
                      value: {
                        matches: [{
                          file: "batchtask_controller.go",
                          matches: [
                            { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                            { lineNumber: 10, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                            { lineNumber: 11, content: "  UpdateEvictedLevel0GPUMetric(1)" },
                          ],
                        }],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "UpdateEvictedLevel0GPUMetric|EvictedLevel0GPU|evicted_level0",
              outputMode: "content",
              workspaceResults: {
                [tmpRoot]: {
                  result: {
                    case: "content",
                    value: {
                      matches: [{
                        file: "metrics.go",
                        matches: [
                          { lineNumber: 7, content: "\tevictedLevel0GPU = prometheus.NewGauge(" },
                          { lineNumber: 15, content: "// UpdateEvictedLevel0GPUMetric records GPU released by level-0 pod eviction" },
                          { lineNumber: 16, content: "func UpdateEvictedLevel0GPUMetric(gpu int64) {" },
                          { lineNumber: 17, content: "\tevictedLevel0GPU.Set(float64(gpu))" },
                        ],
                      }],
                    },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.equal(requests.length, 2);
    assert.equal(waitCalls.length, 2);
    const syntheticAssistant = requests[1].messages.find((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.some((call) => String(call.id || "").startsWith("prefetch-read-")));
    assert.ok(syntheticAssistant);
    const syntheticReadArgs = syntheticAssistant.tool_calls.map((call) => JSON.parse(call.function.arguments));
    // Synthetic Read windows must target real files and stay within their actual
    // line counts (guards against hallucinated windows like offset 2963 in a
    // dozen-line fixture, which a hardcoded negative check could never catch).
    const syntheticReadLineCounts = new Map([
      [controllerPath, fs.readFileSync(controllerPath, "utf8").split("\n").length],
      [metricsPath, fs.readFileSync(metricsPath, "utf8").split("\n").length],
    ]);
    assert.equal(syntheticReadArgs.length > 0, true);
    for (const args of syntheticReadArgs) {
      assert.equal(syntheticReadLineCounts.has(args.path), true, `synthetic Read for unknown path ${args.path}`);
      if (args.offset !== undefined) {
        const lineCount = syntheticReadLineCounts.get(args.path);
        assert.equal(
          args.offset >= 1 && args.offset <= lineCount,
          true,
          `synthetic Read window out of range for ${args.path} (${lineCount} lines): ${JSON.stringify(args)}`,
        );
      }
    }
    const toolMessages = requests[1].messages.filter((message) => message.role === "tool");
    assert.ok(toolMessages.some((message) => String(message.content || "").startsWith(`File: ${metricsPath}\nLines: 15-18\n`)));
    assert.ok(toolMessages.some((message) => String(message.content || "").includes("evictedLevel0GPU = prometheus.NewGauge")));
  } finally {
    restore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("OpenAI provider loop reuses a broader prior Read window for a later contained Read", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-large",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: "{\"path\":\"/tmp/a\",\"offset\":10,\"limit\":20}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-small",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: "{\"path\":\"/tmp/a\",\"offset\":15,\"limit\":3}",
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-reuse-across-batches",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read larger then smaller" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-read-reuse-across-batches",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              output: { case: "content", value: Array.from({ length: 20 }, (_, index) => `line-${index + 10}`).join("\n") },
              totalLines: 40,
              readRange: { startLine: 10, endLine: 29 },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "read-large",
      options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\",\"offset\":10,\"limit\":20}" },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const smallRead = toolMessages.find((message) => message.tool_call_id === "read-small");
    assert.ok(smallRead);
    assert.equal(
      smallRead.content,
      "File: /tmp/a\nLines: 15-17\nRequested lines are already contained in earlier Read lines 10-29 of the same file. Reuse the earlier Read directly for citation; no new file content is repeated here.",
    );
  } finally {
    restore();
  }
});

test("OpenAI provider loop reuses a prior successful Read for a later same-file non-contained Read", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-extend-"));
  const filePath = path.join(tmpRoot, "a.txt");
  const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-small",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":10,"limit":5}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-extended",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":12,"limit":8}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-reuse-extended",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read a file twice with a later larger overlapping window" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-read-reuse-extended",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: {
            success: {
              path: filePath,
              output: { case: "content", value: lines.slice(9, 14).join("\n") },
              totalLines: lines.length,
              readRange: { startLine: 10, endLine: 14 },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "read-small",
      options: { toolName: "Read", toolArguments: `{"path":"${filePath}","offset":10,"limit":5}` },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const extendedRead = toolMessages.find((message) => message.tool_call_id === "read-extended");
    assert.ok(extendedRead);
    assert.equal(
      extendedRead.content,
      `File: ${filePath}\nLines: 12-19\n    12|line-12\n    13|line-13\n    14|line-14\n    15|line-15\n    16|line-16\n    17|line-17\n    18|line-18\n    19|line-19`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop reuses a prior Read for a later same-file literal content Grep", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-literal-grep-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "// Evicts best-effort level-0 external pods so queued work can proceed.",
    "// Additional context lives nearby.",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority() {}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-helper",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":1,"limit":3}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-comment",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${filePath}","pattern":"Evicts best-effort level-0 external pods so queued work can proceed","output_mode":"content","offset":0}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-to-literal-grep",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read helper then grep exact comment text in the same file" }],
        tools: [
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" }, offset: { type: "integer" } } } },
        ],
      },
      requestId: "req-read-to-literal-grep",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: {
            success: {
              path: filePath,
              output: {
                case: "content",
                value: [
                  "// Evicts best-effort level-0 external pods so queued work can proceed.",
                  "// Additional context lives nearby.",
                  "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority() {}",
                ].join("\n"),
              },
              totalLines: 4,
              readRange: { startLine: 1, endLine: 3 },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "read-helper",
      options: { toolName: "Read", toolArguments: `{"path":"${filePath}","offset":1,"limit":3}` },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-comment");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      `[${tmpRoot}] batchtask_controller.go:1 // Evicts best-effort level-0 external pods so queued work can proceed.`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test("OpenAI provider loop reuses a prior Read for a later directory-scoped literal content Grep with glob", async () => {
  const requests = [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-literal-grep-glob-"));
  const filePath = path.join(tmpRoot, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "// evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority",
    "func (r *BatchTaskReconciler) helper() {}",
    "",
  ].join("\n"));
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "read-helper",
                          index: 0,
                          function: {
                            name: "Read",
                            arguments: `{"path":"${filePath}","offset":1,"limit":2}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                {
                  choices: [{
                    delta: {
                      tool_calls: [
                        {
                          id: "grep-comment",
                          index: 0,
                          function: {
                            name: "Grep",
                            arguments: `{"path":"${tmpRoot}","glob":"batchtask_controller.go","pattern":"evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority","output_mode":"content"}`,
                          },
                        },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-read-to-literal-grep-glob",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read helper then grep exact callsite text through a directory + glob" }],
        tools: [
          { name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } },
          { name: "Grep", description: "grep", inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" }, pattern: { type: "string" }, output_mode: { type: "string" } } } },
        ],
      },
      requestId: "req-read-to-literal-grep-glob",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          readResult: {
            success: {
              path: filePath,
              output: {
                case: "content",
                value: [
                  "// evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority",
                  "func (r *BatchTaskReconciler) helper() {}",
                ].join("\n"),
              },
              totalLines: 2,
              readRange: { startLine: 1, endLine: 2 },
            },
          },
        });
      },
    })) {
      // drain
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "read-helper",
      options: { toolName: "Read", toolArguments: `{"path":"${filePath}","offset":1,"limit":2}` },
    }]);
    const toolMessages = requests[2].messages.filter((message) => message.role === "tool");
    const derivedMessage = toolMessages.find((message) => message.tool_call_id === "grep-comment");
    assert.ok(derivedMessage);
    assert.equal(
      derivedMessage.content,
      `[${tmpRoot}] batchtask_controller.go:1 // evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});


test("OpenAI provider loop forwards stream events before upstream stream completes", async () => {
  const requests = [];
  const gate = deferred();
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: "first" } }] };
                await gate.promise;
                yield { choices: [{ delta: { content: "second" }, finish_reason: "stop" }] };
              },
            };
          },
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
    const iterator = adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-streaming",
        systemPrompt: "system",
        messages: [{ role: "user", content: "stream text" }],
      },
      requestId: "req-streaming",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    });

    const first = await Promise.race([
      iterator.next(),
      tick().then(() => ({ timedOut: true })),
    ]);
    assert.deepEqual(first, { value: { type: "text_delta", text: "first" }, done: false });
    assert.equal(requests.length, 1);
    gate.resolve();
    await iterator.return?.();
  } finally {
    gate.resolve();
    restore();
  }
});


test("OpenAI provider dispatches direct Cursor MCP tools through CallMcpTool exec", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-search-call", index: 0, function: { name: "user-awslabs_aws-documentation-mcp-server-search_documentation", arguments: "{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-openai",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Use AWS docs MCP" }],
        tools: [{
          name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
          description: "Search AWS docs",
          inputSchema: {
            type: "object",
            properties: {
              search_phrase: { type: "string" },
              limit: { type: "number" },
            },
          },
          providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
          toolName: "search_documentation",
        }],
      },
      requestId: "req-openai-mcp",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpResult: {
            success: {
              content: [{ content: { case: "text", value: { text: "AWS Lambda function URLs" } } }],
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools[0].function.name, "user-awslabs_aws-documentation-mcp-server-search_documentation");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-search-call",
      options: {
        toolName: "CallMcpTool",
        toolArguments: "{\"name\":\"user-awslabs.aws-documentation-mcp-server-search_documentation\",\"args\":{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1},\"providerIdentifier\":\"user-awslabs.aws-documentation-mcp-server\",\"toolName\":\"search_documentation\",\"displayName\":\"user-awslabs_aws-documentation-mcp-server-search_documentation\"}",
      },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-search-call");
    assert.equal(cursorEvent.name, "CallMcpTool");
    assert.deepEqual(JSON.parse(cursorEvent.arguments), {
      name: "user-awslabs.aws-documentation-mcp-server-search_documentation",
      args: { search_phrase: "AWS Lambda function URLs", limit: 1 },
      providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
      toolName: "search_documentation",
      displayName: "user-awslabs_aws-documentation-mcp-server-search_documentation",
    });
    assert.deepEqual(requests[1].messages.at(-2).tool_calls[0].function, {
      name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
      arguments: "{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1}",
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "mcp-search-call",
      content: "AWS Lambda function URLs",
    });
  } finally {
    restore();
  }
});


test("OpenAI provider dispatches direct MCP auth through Cursor interaction auth", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-auth-call", index: 0, function: { name: "plugin-atlassian-atlassian-mcp_auth", arguments: "{}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-auth-openai",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Authenticate Atlassian MCP" }],
        tools: [mcpAuthProviderTool()],
      },
      requestId: "req-openai-mcp-auth",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpAuthResult: {
            result: {
              case: "success",
              value: { serverIdentifier: "plugin-atlassian-atlassian" },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools[0].function.name, "plugin-atlassian-atlassian-mcp_auth");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-auth-call",
      options: {
        toolName: "mcp_auth",
        toolArguments: "{\"serverIdentifier\":\"plugin-atlassian-atlassian\"}",
      },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-auth-call");
    assert.equal(cursorEvent.name, "mcp_auth");
    assert.deepEqual(JSON.parse(cursorEvent.arguments), {
      serverIdentifier: "plugin-atlassian-atlassian",
    });
    assert.deepEqual(requests[1].messages.at(-2).tool_calls[0].function, {
      name: "plugin-atlassian-atlassian-mcp_auth",
      arguments: "{}",
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "mcp-auth-call",
      content: "MCP authentication approved for server plugin-atlassian-atlassian.",
    });
  } finally {
    restore();
  }
});

test("OpenAI provider accepts mcp_auth server identifier aliases before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-auth-alias-call", index: 0, function: { name: "plugin-atlassian-atlassian-mcp_auth", arguments: "{\"server_identifier\":\"plugin-atlassian-atlassian\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-auth-openai-alias-args",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Authenticate Atlassian MCP" }],
        tools: [mcpAuthProviderTool()],
      },
      requestId: "req-openai-mcp-auth-alias-args",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-auth-alias-call",
      options: { toolName: "mcp_auth", toolArguments: "{\"serverIdentifier\":\"plugin-atlassian-atlassian\"}" },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-auth-alias-call");
    assert.equal(cursorEvent?.name, "mcp_auth");
    assert.equal(cursorEvent?.localResult?.case, undefined);
  } finally {
    restore();
  }
});

test("OpenAI provider ignores unexpected mcp_auth arguments before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "mcp-auth-bad-call", index: 0, function: { name: "plugin-atlassian-atlassian-mcp_auth", arguments: "{\"unexpected\":\"value\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-mcp-auth-openai-invalid-args",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Authenticate Atlassian MCP" }],
        tools: [mcpAuthProviderTool()],
      },
      requestId: "req-openai-mcp-auth-invalid-args",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpAuthResult: {
            result: {
              case: "success",
              value: { serverIdentifier: "plugin-atlassian-atlassian" },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-auth-bad-call",
      options: { toolName: "mcp_auth", toolArguments: "{\"serverIdentifier\":\"plugin-atlassian-atlassian\"}" },
    }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "mcp-auth-bad-call").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2).tool_calls[0].function, {
      name: "plugin-atlassian-atlassian-mcp_auth",
      arguments: "{\"unexpected\":\"value\"}",
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "tool",
      tool_call_id: "mcp-auth-bad-call",
      content: "MCP authentication approved for server plugin-atlassian-atlassian.",
    });
  } finally {
    restore();
  }
});


test("OpenAI Chat provider preserves prior Anthropic-format tool history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-anthropic-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will inspect it." },
              { type: "tool_use", id: "toolu-prev", name: "Read", input: { path: "/tmp/a", offset: 2, limit: 3 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu-prev", content: "File: /tmp/a\nLines: 2-4\n     2|a" }],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-anthropic-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].messages.slice(1), [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{
          id: "toolu-prev",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2,\"limit\":3}" },
        }],
      },
      { role: "tool", tool_call_id: "toolu-prev", content: "File: /tmp/a\nLines: 2-4\n     2|a" },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider preserves prior Responses-format tool history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-openai-chat-responses-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          { type: "function_call", call_id: "call-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
          { type: "function_call_output", call_id: "call-prev", output: "File: /tmp/a\nLines: 2-2\n     2|a" },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-openai-chat-responses-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].messages.slice(1), [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-prev",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
        }],
      },
      { role: "tool", tool_call_id: "call-prev", content: "File: /tmp/a\nLines: 2-2\n     2|a" },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI provider tool-call logs keep run request id separate from conversation id", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "call-1", index: 0, function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  const logEntries = [];
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: { info: (message, fields) => logEntries.push({ message, fields }) },
    });
    for await (const _ of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-1",
      waitForToolResult: async () => ({ message: { case: "readResult", value: { result: { case: "success", value: {} } } } }),
    })) {
      // Drain the provider stream.
    }

    const toolLog = logEntries.find((entry) => entry.message === "BYOK tool call");
    assert.equal(toolLog.fields.requestId, "req-1");
    assert.equal(toolLog.fields.conversationId, "conv-1");
    const batchLog = logEntries.find((entry) => entry.message === "BYOK provider tool batch resolved");
    assert.equal(batchLog.fields.requestId, "req-1");
    assert.equal(batchLog.fields.conversationId, "conv-1");
    assert.deepEqual(batchLog.fields.tools, ["Read"]);
    assert.equal(batchLog.fields.toolCount, 1);
    assert.equal(batchLog.fields.providerTextChars > 0, true);
    assert.equal(Array.isArray(batchLog.fields.toolSummaries), true);
    assert.equal(batchLog.fields.toolSummaries[0].tool, "Read");
    assert.equal(batchLog.fields.toolSummaries[0].path, "/tmp/a");
  } finally {
    restore();
  }
});
