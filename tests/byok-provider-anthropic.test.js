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
  streamAnthropicEvents,
} = require("../src/server/provider-adapter");
const { mcpAuthProviderTool, quietLog, deferred, tick, asyncIterable, snapshotJson, interceptModule, interceptModules, createProviderAdapter, runConcurrentReadToolWaits } = require("./byok-fixtures");

test("Anthropic provider falls back to required default max_tokens", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-default-max-tokens",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      },
      requestId: "req-anthropic-default-max-tokens",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 8192);
    assert.equal(requests[0].system.startsWith("system"), true);
    assert.match(requests[0].system, /<cursor_byok_prompt_compatibility>/);
    assert.deepEqual(requests[0].messages, [{ role: "user", content: "hello" }]);
  } finally {
    restore();
  }
});

test("Anthropic provider loop sends Cursor exec result back as provider tool_result", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "Grep" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"needle\"" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ",\"offset\":3}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude", maxOutputTokens: 12000 },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "OBJECT", properties: { pattern: { type: "STRING" }, offset: { type: "INTEGER" } } } }],
      },
      requestId: "req-2",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
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
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Grep"), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu-1", name: "Grep", input: { pattern: "needle", offset: 3 } }],
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu-1",
        content: "[/tmp/project] a.js:3 needle here",
      }],
    });
    assert.equal(requests[0].tools[0].input_schema.type, "object");
    assert.equal(requests[0].max_tokens, 12000);
    assert.deepEqual(waitCalls, [{ toolCallId: "toolu-1", options: { toolName: "Grep", toolArguments: { pattern: "needle", offset: 3 } } }]);
  } finally {
    restore();
  }
});

test("Anthropic provider drops trivial current assistant text when the same message also contains tool use", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "text" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I will inspect it first." } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "Read" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-trivial-text-and-tool-use",
        systemPrompt: "system",
        messages: [{ role: "user", content: "inspect then read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-trivial-text-and-tool-use",
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
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-1", name: "Read", input: { path: "/tmp/a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "File: /tmp/a\nLines: 1-1\n     1|ok" }],
      },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider loop sends explicit client tool completions back as tool_result blocks", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "web-1", name: "WebSearch" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"search_term\":\"Cursor BYOK\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "image-1", name: "GenerateImage" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-client-tools",
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
      requestId: "req-anthropic-client-tools",
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
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: { search_term: "Cursor BYOK" } } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: { description: "diagram", filename: "/tmp/out.png" } } },
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "web-1", name: "WebSearch", input: { search_term: "Cursor BYOK" } },
          { type: "tool_use", id: "image-1", name: "GenerateImage", input: { description: "diagram", filename: "/tmp/out.png" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "web-1", content: "Cursor BYOK docs (https://example.com/byok)" },
          { type: "tool_result", tool_use_id: "image-1", content: "Generated image at /tmp/out.png" },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider repairs client tool aliases before Cursor execution and follow-up history", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "web-1", name: "WebSearch" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"searchTerm\":\"Cursor BYOK\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "image-1", name: "GenerateImage" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"description\":\"diagram\",\"filePath\":\"/tmp/out.png\",\"referenceImagePaths\":[\"/tmp/ref.png\"]}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-client-tool-aliases",
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
      requestId: "req-anthropic-client-tool-aliases",
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

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: { search_term: "Cursor BYOK" } } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: { description: "diagram", filename: "/tmp/out.png", reference_image_paths: ["/tmp/ref.png"] } } },
    ]);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "web-1", name: "WebSearch", input: { search_term: "Cursor BYOK" } },
          { type: "tool_use", id: "image-1", name: "GenerateImage", input: { description: "diagram", filename: "/tmp/out.png", reference_image_paths: ["/tmp/ref.png"] } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "web-1", content: "Cursor BYOK docs (https://example.com/byok)" },
          { type: "tool_result", tool_use_id: "image-1", content: "Generated image at /tmp/out.png" },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider returns filtered launch tool errors as tool_result blocks", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "task-1", name: "Task" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"description\":\"launch task\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "subagent-1", name: "Subagent" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"prompt\":\"launch subagent\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-filtered-launch-tool",
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
      requestId: "req-anthropic-filtered-launch-tool",
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
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "task-1", name: "Task", input: { description: "launch task" } },
          { type: "tool_use", id: "subagent-1", name: "Subagent", input: { prompt: "launch subagent" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-1",
            content: requests[1].messages.at(-1).content[0].content,
          },
          {
            type: "tool_result",
            tool_use_id: "subagent-1",
            content: requests[1].messages.at(-1).content[1].content,
          },
        ],
      },
    ]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid Task input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /filtered in BYOK mode/);
    assert.match(requests[1].messages.at(-1).content[0].content, /not available as a BYOK provider tool/);
    assert.match(requests[1].messages.at(-1).content[1].content, /Invalid Subagent input/);
    assert.match(requests[1].messages.at(-1).content[1].content, /filtered in BYOK mode/);
    assert.match(requests[1].messages.at(-1).content[1].content, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("Anthropic provider returns unknown tool errors as tool_result blocks without Cursor wait", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "unknown-1", name: "UnknownTool" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-unknown-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try unknown" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-unknown-tool",
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
        content: [
          { type: "tool_use", id: "unknown-1", name: "UnknownTool", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown-1",
            content: requests[1].messages.at(-1).content[0].content,
          },
        ],
      },
    ]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid UnknownTool input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("Anthropic provider rejects default-catalog ReadFile as tool_result block without Cursor wait", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "readfile-1", name: "ReadFile" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-default-readfile",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try legacy read alias" }],
      },
      requestId: "req-anthropic-default-readfile",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools.some((tool) => tool.name === "ReadFile"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["ReadFile", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "readfile-1", name: "ReadFile", input: { path: "/tmp/a" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "readfile-1",
            content: requests[1].messages.at(-1).content[0].content,
          },
        ],
      },
    ]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid ReadFile input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("Anthropic provider rejects default-catalog client tools as tool_result blocks without Cursor wait", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "web-1", name: "WebSearch" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"search_term\":\"Cursor BYOK\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "image-1", name: "GenerateImage" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"description\":\"diagram\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-default-client-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try client tools" }],
      },
      requestId: "req-anthropic-default-client-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(requestToolNames.includes("WebSearch"), false);
    assert.equal(requestToolNames.includes("GenerateImage"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["WebSearch", "unsupportedToolResult"], ["GenerateImage", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "web-1", name: "WebSearch", input: { search_term: "Cursor BYOK" } },
          { type: "tool_use", id: "image-1", name: "GenerateImage", input: { description: "diagram" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "web-1",
            content: requests[1].messages.at(-1).content[0].content,
          },
          {
            type: "tool_result",
            tool_use_id: "image-1",
            content: requests[1].messages.at(-1).content[1].content,
          },
        ],
      },
    ]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid WebSearch input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /not available as a BYOK provider tool/);
    assert.match(requests[1].messages.at(-1).content[1].content, /Invalid GenerateImage input/);
    assert.match(requests[1].messages.at(-1).content[1].content, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("Anthropic provider rejects default-catalog task todo aliases as tool_result blocks without Cursor wait", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "task-create-1", name: "TaskCreate" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"description\":\"inspect\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "task-update-1", name: "TaskUpdate" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"id\":\"task-1\",\"status\":\"completed\"}" } },
              { type: "content_block_stop", index: 1 },
              { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "task-list-1", name: "TaskList" } },
              { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 2 },
              { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "task-get-1", name: "TaskGet" } },
              { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"id\":\"task-1\"}" } },
              { type: "content_block_stop", index: 3 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "continued" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-default-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try task aliases" }],
      },
      requestId: "req-anthropic-default-task-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.name);
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
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "task-create-1", name: "TaskCreate", input: { description: "inspect" } },
          { type: "tool_use", id: "task-update-1", name: "TaskUpdate", input: { id: "task-1", status: "completed" } },
          { type: "tool_use", id: "task-list-1", name: "TaskList", input: {} },
          { type: "tool_use", id: "task-get-1", name: "TaskGet", input: { id: "task-1" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-create-1",
            content: requests[1].messages.at(-1).content[0].content,
          },
          {
            type: "tool_result",
            tool_use_id: "task-update-1",
            content: requests[1].messages.at(-1).content[1].content,
          },
          {
            type: "tool_result",
            tool_use_id: "task-list-1",
            content: requests[1].messages.at(-1).content[2].content,
          },
          {
            type: "tool_result",
            tool_use_id: "task-get-1",
            content: requests[1].messages.at(-1).content[3].content,
          },
        ],
      },
    ]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid TaskCreate input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /not available as a BYOK provider tool/);
    assert.match(requests[1].messages.at(-1).content[1].content, /Invalid TaskUpdate input/);
    assert.match(requests[1].messages.at(-1).content[1].content, /not available as a BYOK provider tool/);
    assert.match(requests[1].messages.at(-1).content[2].content, /Invalid TaskList input/);
    assert.match(requests[1].messages.at(-1).content[2].content, /not available as a BYOK provider tool/);
    assert.match(requests[1].messages.at(-1).content[3].content, /Invalid TaskGet input/);
    assert.match(requests[1].messages.at(-1).content[3].content, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("Anthropic provider passes TodoWrite dependencies through to native Cursor todo execution", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "todo-1", name: "TodoWrite" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"todos\":[{\"id\":\"t1\",\"content\":\"Do it\",\"status\":\"pending\",\"dependencies\":[\"t0\"]}],\"merge\":true}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-todowrite-dependencies",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-anthropic-todowrite-dependencies",
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

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{
      toolCallId: "todo-1",
      options: {
        toolName: "TodoWrite",
        toolArguments: { todos: [{ id: "t1", content: "Do it", status: "pending", dependencies: ["t0"] }], merge: true },
      },
    }]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "todo-1",
        name: "TodoWrite",
        input: { todos: [{ id: "t1", content: "Do it", status: "pending", dependencies: ["t0"] }], merge: true },
      }],
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "todo-1",
        content: "Todo list updated (1 item):\n- [pending] Do it",
      }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider repairs supported Grep alias keys before Cursor execution", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad-grep", name: "Grep" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"needle\",\"headLimit\":3}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-grep-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-anthropic-grep-alias",
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

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-grep", options: { toolName: "Grep", toolArguments: { pattern: "needle", head_limit: 3 } } }]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "bad-grep", name: "Grep", input: { pattern: "needle", head_limit: 3 } }],
    });
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Invalid Grep input/);
  } finally {
    restore();
  }
});

test("Anthropic provider repairs Glob aliases before Cursor execution", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "glob-1", name: "Glob" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"*.py\",\"path\":\"/tmp/project\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-glob-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "glob it" }],
        tools: [{ name: "Glob", description: "glob", inputSchema: { type: "object", properties: { glob_pattern: { type: "string" }, target_directory: { type: "string" } }, required: ["glob_pattern"], additionalProperties: false } }],
      },
      requestId: "req-anthropic-glob-alias",
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
    assert.deepEqual(waitCalls, [{ toolCallId: "glob-1", options: { toolName: "Glob", toolArguments: { glob_pattern: "*.py", target_directory: "/tmp/project" } } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "glob-1").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "glob-1", name: "Glob", input: { glob_pattern: "*.py", target_directory: "/tmp/project" } }],
    });
    assert.equal(
      requests[1].messages.at(-1).content[0].content,
      "Result of search in '/tmp/project' (total 1 file):\n- a.py",
    );
  } finally {
    restore();
  }
});

test("Anthropic provider strips Cursor-only content block fields but preserves cache_control", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-sanitize",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
            context_management: { edits: [] },
            cursor_only: true,
          }],
        }],
      },
      requestId: "req-anthropic-sanitize",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].messages, [{
      role: "user",
      content: [{
        type: "text",
        text: "hello",
        cache_control: { type: "ephemeral" },
      }],
    }]);
  } finally {
    restore();
  }
});

test("Anthropic provider ignores malformed TodoWrite input before Cursor execution", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "todo-invalid", name: "TodoWrite" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"todos\":\"finish step 1\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-todowrite-invalid",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-anthropic-todowrite-invalid",
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
    assert.deepEqual(waitCalls, [{
      toolCallId: "todo-invalid",
      options: {
        toolName: "TodoWrite",
        toolArguments: { todos: "finish step 1" },
      },
    }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "todo-invalid").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "todo-invalid",
        name: "TodoWrite",
        input: { todos: "finish step 1" },
      }],
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "todo-invalid",
        content: "Todo list is empty.",
      }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider skips schema validation for explicit task todo aliases", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "task-create-explicit", name: "TaskCreate" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"description\":\"inspect\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "task-update-explicit", name: "TaskUpdate" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"task_id\":\"task-1\",\"status\":\"completed\"}" } },
              { type: "content_block_stop", index: 1 },
              { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "task-list-explicit", name: "TaskList" } },
              { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 2 },
              { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "task-get-explicit", name: "TaskGet" } },
              { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 3 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-explicit-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "use explicit task aliases" }],
        tools: [
          { name: "TaskCreate", description: "task create", inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false } },
          { name: "TaskUpdate", description: "task update", inputSchema: { type: "object", properties: { taskId: { type: "string" }, status: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
          { name: "TaskList", description: "task list", inputSchema: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"], additionalProperties: false } },
          { name: "TaskGet", description: "task get", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
        ],
      },
      requestId: "req-anthropic-explicit-task-aliases",
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
      { toolCallId: "task-create-explicit", options: { toolName: "TaskCreate", toolArguments: { description: "inspect" } } },
      { toolCallId: "task-update-explicit", options: { toolName: "TaskUpdate", toolArguments: { task_id: "task-1", status: "completed" } } },
      { toolCallId: "task-list-explicit", options: { toolName: "TaskList", toolArguments: {} } },
      { toolCallId: "task-get-explicit", options: { toolName: "TaskGet", toolArguments: {} } },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), [undefined, undefined, undefined, undefined]);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "task-create-explicit", name: "TaskCreate", input: { description: "inspect" } },
          { type: "tool_use", id: "task-update-explicit", name: "TaskUpdate", input: { task_id: "task-1", status: "completed" } },
          { type: "tool_use", id: "task-list-explicit", name: "TaskList", input: {} },
          { type: "tool_use", id: "task-get-explicit", name: "TaskGet", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "task-create-explicit", content: "Todo list updated (1 item):\n- [completed] TaskCreate" },
          { type: "tool_result", tool_use_id: "task-update-explicit", content: "Todo list updated (1 item):\n- [completed] TaskUpdate" },
          { type: "tool_result", tool_use_id: "task-list-explicit", content: "Todo list updated (1 item):\n- [completed] TaskList" },
          { type: "tool_result", tool_use_id: "task-get-explicit", content: "Todo list updated (1 item):\n- [completed] TaskGet" },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider dispatches direct Cursor MCP tools through CallMcpTool exec", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "mcp-search-call", name: "user-awslabs_aws-documentation-mcp-server-search_documentation" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-mcp-anthropic",
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
      requestId: "req-anthropic-mcp",
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

    assert.equal(requests[0].tools[0].name, "user-awslabs_aws-documentation-mcp-server-search_documentation");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-search-call",
      options: {
        toolName: "CallMcpTool",
        toolArguments: {
          name: "user-awslabs.aws-documentation-mcp-server-search_documentation",
          args: { search_phrase: "AWS Lambda function URLs", limit: 1 },
          providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
          toolName: "search_documentation",
          displayName: "user-awslabs_aws-documentation-mcp-server-search_documentation",
        },
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
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "mcp-search-call",
        name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
        input: { search_phrase: "AWS Lambda function URLs", limit: 1 },
      }],
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "mcp-search-call", content: "AWS Lambda function URLs" }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider dispatches direct MCP auth through Cursor interaction auth", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "mcp-auth-call", name: "plugin-atlassian-atlassian-mcp_auth" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
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
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-mcp-auth-anthropic",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Authenticate Atlassian MCP" }],
        tools: [mcpAuthProviderTool()],
      },
      requestId: "req-anthropic-mcp-auth",
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

    assert.equal(requests[0].tools[0].name, "plugin-atlassian-atlassian-mcp_auth");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-auth-call",
      options: {
        toolName: "mcp_auth",
        toolArguments: {
          serverIdentifier: "plugin-atlassian-atlassian",
        },
      },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-auth-call");
    assert.equal(cursorEvent.name, "mcp_auth");
    assert.deepEqual(JSON.parse(cursorEvent.arguments), {
      serverIdentifier: "plugin-atlassian-atlassian",
    });
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "mcp-auth-call",
        name: "plugin-atlassian-atlassian-mcp_auth",
        input: {},
      }],
    });
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "mcp-auth-call",
        content: "MCP authentication approved for server plugin-atlassian-atlassian.",
      }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider repairs Read alias from a unique explicit user JSON range", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad-read", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-read-retry",
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
    assert.match(requests[0].tools[0].description, /only valid Read input keys are path, offset, and limit/);
    assert.deepEqual(Object.keys(requests[0].tools[0].input_schema.properties), ["path", "offset", "limit"]);
    assert.deepEqual(requests[0].tools[0].input_schema.required, ["path"]);
    assert.equal(requests[0].tools[0].input_schema.additionalProperties, false);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-read", options: { toolName: "Read", toolArguments: { path: "/tmp/a", offset: 2000, limit: 20 } } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "bad-read", name: "Read", input: { path: "/tmp/a", offset: 2000, limit: 20 } }],
    });
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("Anthropic provider repairs equivalent Read path aliases before Cursor execution", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "alias-read", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Read /tmp/a." }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-read-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "content",
              readRange: { startLine: 1 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "alias-read", options: { toolName: "Read", toolArguments: { path: "/tmp/a" } } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "alias-read").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "alias-read", name: "Read", input: { path: "/tmp/a" } }],
    });
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("Anthropic provider rejects ambiguous Read aliases for repeated path ranges", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad-read", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [
            "Make exactly these Read calls:",
            "{\"path\":\"/tmp/a\",\"offset\":100,\"limit\":5}",
            "{\"path\":\"/tmp/a\",\"offset\":200,\"limit\":5}",
          ].join("\n"),
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-read-ambiguous-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "wrong window",
              readRange: { startLine: 200 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid Read input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /multiple explicit Read ranges/);
    assert.match(requests[1].messages.at(-1).content[0].content, /\{"path":"\/tmp\/a","offset":100,"limit":5\}/);
    assert.match(requests[1].messages.at(-1).content[0].content, /\{"path":"\/tmp\/a","offset":200,"limit":5\}/);
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /unsupported keys: filePath/);
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Do not answer until/);
  } finally {
    restore();
  }
});

test("Anthropic provider accepts Read alias when offset and limit disambiguate repeated path ranges", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "good-read", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\",\"offset\":100,\"limit\":5}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [
            "Make exactly these Read calls:",
            "{\"path\":\"/tmp/a\",\"offset\":100,\"limit\":5}",
            "{\"path\":\"/tmp/a\",\"offset\":200,\"limit\":5}",
          ].join("\n"),
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-read-present-range-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "correct window",
              readRange: { startLine: 100 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "good-read", options: { toolName: "Read", toolArguments: { path: "/tmp/a", offset: 100, limit: 5 } } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "good-read").map((event) => event.localResult?.case), [undefined]);
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Invalid Read input/);
  } finally {
    restore();
  }
});

test("Anthropic provider rejects conflicting Read path aliases", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "alias-read", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":\"/tmp/b\",\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 15, output_tokens: 3 } });
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-1",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Read /tmp/a." }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-read-alias-conflict",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "alias-read").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(requests[1].messages.at(-1).content[0].content, /Invalid Read input/);
    assert.match(requests[1].messages.at(-1).content[0].content, /conflicting path aliases/);
    assert.match(requests[1].messages.at(-1).content[0].content, /Retry the Read tool with exactly this JSON: \{"path":"\/tmp\/a"\}/);
    assert.doesNotMatch(requests[1].messages.at(-1).content[0].content, /Do not answer until/);
  } finally {
    restore();
  }
});

test("Anthropic stream parser preserves tool_use input object from content_block_start", async () => {
  const stream = asyncIterable([
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu-start-input",
        name: "Read",
        input: { path: "/tmp/start-input", offset: 2, limit: 3 },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_stop", index: 0 },
  ]);
  stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 } });

  const events = await collectAnthropicEvents(stream);

  assert.deepEqual(events.find((event) => event.type === "tool_use_done"), {
    type: "tool_use_done",
    id: "toolu-start-input",
    name: "Read",
    arguments: { path: "/tmp/start-input", offset: 2, limit: 3 },
  });
});

test("Anthropic stream parser preserves cache usage fields including explicit zero", async () => {
  const withCacheUsage = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
  ]);
  withCacheUsage.finalMessage = async () => ({
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 4,
    },
  });

  const withCacheEvents = await collectAnthropicEvents(withCacheUsage);

  assert.deepEqual(withCacheEvents.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 4,
    },
  });

  const withoutCacheUsage = asyncIterable([]);
  withoutCacheUsage.finalMessage = async () => ({
    stop_reason: "end_turn",
    usage: {
      input_tokens: 3,
      output_tokens: 1,
    },
  });

  const withoutCacheEvents = await collectAnthropicEvents(withoutCacheUsage);

  assert.deepEqual(withoutCacheEvents.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: {
      inputTokens: 3,
      outputTokens: 1,
    },
  });
});

test("Anthropic stream parser forwards text from content block start when deltas are absent", async () => {
  const stream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "full text" } },
    { type: "content_block_stop", index: 0 },
  ]);
  stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });

  const events = await collectAnthropicEvents(stream);

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["full text"]);
});

test("Anthropic stream parser does not duplicate start text after text deltas", async () => {
  const stream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "full text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "full" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " text" } },
    { type: "content_block_stop", index: 0 },
  ]);
  stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });

  const events = await collectAnthropicEvents(stream);

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["full", " text"]);
});

test("Anthropic stream parser forwards thinking from content block start when deltas are absent", async () => {
  const stream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "full thinking", signature: "sig-start" } },
    { type: "content_block_stop", index: 0 },
  ]);
  stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });

  const events = await collectAnthropicEvents(stream);

  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.text), ["full thinking"]);
  assert.deepEqual(events.find((event) => event.type === "thinking_done"), {
    type: "thinking_done",
    signature: "sig-start",
  });
  // The collector hides provider_history_item from the hook, so asserting its
  // absence on collector output is vacuous. The raw stream MUST emit one for
  // the thinking block — that is what preserves thinking history for the next
  // same-provider request.
  const rawStream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "full thinking", signature: "sig-start" } },
    { type: "content_block_stop", index: 0 },
  ]);
  rawStream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });
  const rawEvents = [];
  for await (const event of streamAnthropicEvents(rawStream)) rawEvents.push(event);
  const historyItems = rawEvents.filter((event) => event.type === "provider_history_item");
  assert.equal(historyItems.length, 1);
  assert.equal(historyItems[0].item.type, "thinking");
});

test("Anthropic stream parser does not duplicate start thinking after thinking deltas", async () => {
  const stream = asyncIterable([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "full thinking", signature: "sig-start" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "full" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-delta" } },
    { type: "content_block_stop", index: 0 },
  ]);
  stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });

  const events = await collectAnthropicEvents(stream);

  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.text), ["full", " thinking"]);
  assert.deepEqual(events.find((event) => event.type === "thinking_done"), {
    type: "thinking_done",
    signature: "sig-start-delta",
  });
});

test("Anthropic provider loop preserves thinking blocks in tool follow-up history", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "start should not duplicate", signature: "sig-start" } },
              { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "delta " } },
              { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking" } },
              { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-delta" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "sealed", signature: "sig-redacted" } },
              { type: "content_block_stop", index: 1 },
              { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu-thinking", name: "Read", input: { path: "/tmp/thinking" } } },
              { type: "content_block_stop", index: 2 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    for await (const _event of createProviderAdapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-thinking-history",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read with thinking" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-thinking-history",
      waitForToolResult: async (toolCallId) => normalizeExecClientResult({
        id: 1,
        execId: toolCallId,
        readResult: { success: { path: "/tmp/thinking", content: "ok", readRange: { startLine: 1 } } },
      }),
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "delta thinking", signature: "sig-start-delta" },
        { type: "redacted_thinking", data: "sealed", signature: "sig-redacted" },
        { type: "tool_use", id: "toolu-thinking", name: "Read", input: { path: "/tmp/thinking" } },
      ],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider loop executes tool_use input from content_block_start without deltas", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu-start-input",
                  name: "Read",
                  input: { path: "/tmp/start-input", offset: 2, limit: 3 },
                },
              },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-start-input",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } }],
      },
      requestId: "req-anthropic-start-input",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/start-input",
              content: "line two",
              readRange: { startLine: 2 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "tool_use_done" && event.id === "toolu-start-input"), true);
    assert.deepEqual(waitCalls, [{
      toolCallId: "toolu-start-input",
      options: { toolName: "Read", toolArguments: { path: "/tmp/start-input", offset: 2, limit: 3 } },
    }]);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu-start-input",
        name: "Read",
        input: { path: "/tmp/start-input", offset: 2, limit: 3 },
      }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves prior Chat-format tool history", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-chat-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-prev",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call-prev", content: "File: /tmp/a\nLines: 1-1\n     1|a" },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-chat-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].messages, [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-prev", name: "Read", input: { path: "/tmp/a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-prev", content: "File: /tmp/a\nLines: 1-1\n     1|a" }],
      },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider preserves prior Responses-format tool history", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
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
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-responses-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          { type: "function_call", call_id: "call-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
          { type: "function_call_output", call_id: "call-prev", output: "File: /tmp/a\nLines: 2-2\n     2|a" },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-responses-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].messages, [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-prev", name: "Read", input: { path: "/tmp/a", offset: 2 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-prev", content: "File: /tmp/a\nLines: 2-2\n     2|a" }],
      },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider loop waits for same-turn Cursor tool results concurrently", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-2", name: "Read" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/b\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const adapter = createProviderAdapter();
    await runConcurrentReadToolWaits({
      toolCallIds: ["toolu-1", "toolu-2"],
      waitForToolResultOptions: [
        { toolName: "Read", toolArguments: { path: "/tmp/a" } },
        { toolName: "Read", toolArguments: { path: "/tmp/b" } },
      ],
      afterSecondWait: async () => {
        assert.equal(requests.length, 1);
      },
      runAdapter: (waitForToolResult) => adapter.run({
        provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-claude" },
        request: {
          conversationId: "conv-1",
          systemPrompt: "system",
          messages: [{ role: "user", content: "read both" }],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        },
        requestId: "req-anthropic-concurrent",
        waitForToolResult,
      }),
      assertFollowUp: async () => {
        assert.deepEqual(requests[1].messages.at(-1), {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-1", content: "File: /tmp/a\nLines: 1-1\n     1|a" },
            { type: "tool_result", tool_use_id: "toolu-2", content: "File: /tmp/b\nLines: 1-1\n     1|b" },
          ],
        });
      },
    });
  } finally {
    restore();
  }
});

test("Anthropic provider loop reuses same-turn Cursor results for duplicate read-only tool calls", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "Read" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-2", name: "Read" } },
              { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"/tmp/a\"}" } },
              { type: "content_block_stop", index: 1 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 7 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 13, output_tokens: 5 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-dedupe",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read twice" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-dedupe",
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
      toolCallId: "toolu-1",
      options: { toolName: "Read", toolArguments: { path: "/tmp/a" } },
    }]);
    assert.deepEqual(requests[1].messages.at(-1), {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu-1", content: "File: /tmp/a\nLines: 1-1\n     1|same" },
        { type: "tool_result", tool_use_id: "toolu-2", content: "File: /tmp/a\nLines: 1-1\n     1|same" },
      ],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider loop forwards stream events before upstream stream completes", async () => {
  const requests = [];
  const gate = deferred();
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          const stream = {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } };
              await gate.promise;
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second" } };
              yield { type: "content_block_stop", index: 0 };
            },
            finalMessage: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } }),
          };
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
    const iterator = adapter.run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-streaming",
        systemPrompt: "system",
        messages: [{ role: "user", content: "stream text" }],
      },
      requestId: "req-anthropic-streaming",
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
