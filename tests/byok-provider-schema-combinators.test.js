"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeExecClientResult } = require("../src/server/http");
const { ProviderAdapter } = require("../src/server/provider-adapter");
const { asyncIterable, interceptModule, quietLog, snapshotJson } = require("./byok-fixtures");

function adapter() {
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLog(),
  });
}

function alternateSchemaTool() {
  return {
    name: "Grep",
    description: "grep by alternate selector",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
          required: ["pattern"],
        },
        {
          type: "object",
          properties: {
            glob: { type: "string" },
          },
          required: ["glob"],
        },
      ],
      additionalProperties: false,
    },
  };
}

function composedSchemaTool() {
  return {
    name: "Grep",
    description: "grep by composed selector",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
      },
      required: ["pattern"],
      allOf: [
        {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      ],
      additionalProperties: false,
    },
  };
}

function exclusiveSchemaTool() {
  return {
    name: "Grep",
    description: "grep by exclusive selector",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            glob: { type: "string" },
          },
          required: ["glob"],
          additionalProperties: false,
        },
      ],
    },
  };
}

function refCombinatorSchemaTool() {
  return {
    name: "Grep",
    description: "grep by referenced composed selector",
    inputSchema: {
      type: "object",
      allOf: [
        { $ref: "#/$defs/patternInput" },
      ],
      oneOf: [
        { $ref: "#/$defs/pathInput" },
        { $ref: "#/$defs/globInput" },
      ],
      $defs: {
        patternInput: {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
          required: ["pattern"],
        },
        pathInput: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        globInput: {
          type: "object",
          properties: {
            glob: { type: "string" },
          },
          required: ["glob"],
        },
      },
    },
  };
}

function grepResult(toolCallId) {
  return normalizeExecClientResult({
    execId: toolCallId,
    grepResult: {
      success: {
        pattern: "needle",
        outputMode: "files_with_matches",
        workspaceResults: {
          "/tmp/project": {
            result: { case: "files", value: { files: ["a.txt"], totalFiles: 1 } },
          },
        },
      },
    },
  });
}

test("OpenAI Chat provider does not turn combinator branch required keys into an impossible union", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-1", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\"}" } }] } }] },
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
    const waitCalls = [];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-combinator-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [alternateSchemaTool()],
      },
      requestId: "req-chat-combinator-schema",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return grepResult(toolCallId);
      },
    })) {
      // Drain stream.
    }

    const parameters = requests[0].tools[0].function.parameters;
    assert.deepEqual(Object.keys(parameters.properties), ["pattern", "glob"]);
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, "required"), false);
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-1",
      options: { toolName: "Grep", toolArguments: "{\"pattern\":\"needle\"}" },
    }]);
    assert.match(requests[1].messages.at(-1).content, /\[\/tmp\/project\] a\.txt/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider accepts one valid combinator branch without requiring every branch", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-grep", type: "function_call", call_id: "grep-1", name: "Grep" } },
              { type: "response.function_call_arguments.done", item_id: "fc-grep", arguments: "{\"glob\":\"*.js\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const waitCalls = [];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-combinator-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [alternateSchemaTool()],
      },
      requestId: "req-responses-combinator-schema",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return grepResult(toolCallId);
      },
    })) {
      // Drain stream.
    }

    const parameters = requests[0].tools[0].parameters;
    assert.deepEqual(Object.keys(parameters.properties), ["pattern", "glob"]);
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, "required"), false);
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-1",
      options: { toolName: "Grep", toolArguments: "{\"glob\":\"*.js\"}" },
    }]);
    assert.match(requests[1].input.at(-1).output, /\[\/tmp\/project\] a\.txt/);
  } finally {
    restore();
  }
});

test("Anthropic provider accepts one valid combinator branch without requiring every branch", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "needle" } } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
            return stream;
          }
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
    const waitCalls = [];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-combinator-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [alternateSchemaTool()],
      },
      requestId: "req-anthropic-combinator-schema",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return grepResult(toolCallId);
      },
    })) {
      // Drain stream.
    }

    const inputSchema = requests[0].tools[0].input_schema;
    assert.deepEqual(Object.keys(inputSchema.properties), ["pattern", "glob"]);
    assert.equal(Object.prototype.hasOwnProperty.call(inputSchema, "required"), false);
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-1",
      options: { toolName: "Grep", toolArguments: { pattern: "needle" } },
    }]);
    assert.match(requests[1].messages.at(-1).content[0].content, /\[\/tmp\/project\] a\.txt/);
  } finally {
    restore();
  }
});

test("provider combinator schema keeps allOf required keys across API formats", async () => {
  const chatRequests = [];
  class FakeOpenAIChat {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            chatRequests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  let restore = interceptModule("openai", FakeOpenAIChat);
  try {
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-allof-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [composedSchemaTool()],
      },
      requestId: "req-chat-allof-schema",
      waitForToolResult: async () => assert.fail("no tool should execute"),
    })) {
      // Drain stream.
    }
    assert.deepEqual(chatRequests[0].tools[0].function.parameters.required, ["pattern", "path"]);
  } finally {
    restore();
  }

  const responsesRequests = [];
  class FakeOpenAIResponses {
    constructor() {
      this.responses = {
        create: async (request) => {
          responsesRequests.push(snapshotJson(request));
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  restore = interceptModule("openai", FakeOpenAIResponses);
  try {
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-allof-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [composedSchemaTool()],
      },
      requestId: "req-responses-allof-schema",
      waitForToolResult: async () => assert.fail("no tool should execute"),
    })) {
      // Drain stream.
    }
    assert.deepEqual(responsesRequests[0].tools[0].parameters.required, ["pattern", "path"]);
  } finally {
    restore();
  }

  const anthropicRequests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          anthropicRequests.push(snapshotJson(request));
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
  restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-allof-schema",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [composedSchemaTool()],
      },
      requestId: "req-anthropic-allof-schema",
      waitForToolResult: async () => assert.fail("no tool should execute"),
    })) {
      // Drain stream.
    }
    assert.deepEqual(anthropicRequests[0].tools[0].input_schema.required, ["pattern", "path"]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider rejects tool input missing an allOf required key before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-missing-path", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\"}" } }] } }] },
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
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-allof-validation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [composedSchemaTool()],
      },
      requestId: "req-chat-allof-validation",
      waitForToolResult: async () => assert.fail("invalid tool input must not execute"),
    })) {
      events.push(event);
    }

    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(requests[1].messages.at(-1).content, /missing required key: path/);
    assert.match(requests[1].messages.at(-1).content, /Retry Grep with only supported keys and valid value types/);
  } finally {
    restore();
  }
});

test("provider validates referenced combinator branches across API formats before Cursor execution", async () => {
  const chatRequests = [];
  class FakeOpenAIChat {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            chatRequests.push(snapshotJson(request));
            if (chatRequests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-chat-ref", index: 0, function: { name: "Grep", arguments: "{\"path\":\"/tmp/a\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  let restore = interceptModule("openai", FakeOpenAIChat);
  try {
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-ref-combinator-validation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [refCombinatorSchemaTool()],
      },
      requestId: "req-chat-ref-combinator-validation",
      waitForToolResult: async () => assert.fail("invalid referenced combinator input must not execute"),
    })) {
      events.push(event);
    }
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(chatRequests[1].messages.at(-1).content, /missing required key: pattern/);
  } finally {
    restore();
  }

  const responsesRequests = [];
  class FakeOpenAIResponses {
    constructor() {
      this.responses = {
        create: async (request) => {
          responsesRequests.push(snapshotJson(request));
          if (responsesRequests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-grep-ref", type: "function_call", call_id: "grep-responses-ref", name: "Grep" } },
              { type: "response.function_call_arguments.done", item_id: "fc-grep-ref", arguments: "{\"pattern\":\"needle\",\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  restore = interceptModule("openai", FakeOpenAIResponses);
  try {
    const waitCalls = [];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-ref-combinator-validation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [refCombinatorSchemaTool()],
      },
      requestId: "req-responses-ref-combinator-validation",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return grepResult(toolCallId);
      },
    })) {
      // Drain stream.
    }
    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-responses-ref",
      options: { toolName: "Grep", toolArguments: "{\"pattern\":\"needle\",\"path\":\"/tmp/a\"}" },
    }]);
    assert.match(responsesRequests[1].input.at(-1).output, /\[\/tmp\/project\] a\.txt/);
  } finally {
    restore();
  }

  const anthropicRequests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          anthropicRequests.push(snapshotJson(request));
          if (anthropicRequests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "grep-anthropic-ref", name: "Grep" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"needle\",\"path\":\"/tmp/a\",\"glob\":\"*.js\"}" } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
            return stream;
          }
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
  restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-ref-combinator-validation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [refCombinatorSchemaTool()],
      },
      requestId: "req-anthropic-ref-combinator-validation",
      waitForToolResult: async () => assert.fail("invalid referenced oneOf input must not execute"),
    })) {
      events.push(event);
    }
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(anthropicRequests[1].messages.at(-1).content[0].content, /input must match exactly one oneOf schema/);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider validates original oneOf branches before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-none", index: 0, function: { name: "Grep", arguments: "{}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 2) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-both", index: 0, function: { name: "Grep", arguments: "{\"pattern\":\"needle\",\"glob\":\"*.js\"}" } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            if (requests.length === 3) {
              return asyncIterable([
                { choices: [{ delta: { tool_calls: [{ id: "grep-one", index: 0, function: { name: "Grep", arguments: "{\"glob\":\"*.js\"}" } }] } }] },
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
    const waitCalls = [];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-oneof-validation",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep" }],
        tools: [exclusiveSchemaTool()],
      },
      requestId: "req-chat-oneof-validation",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return grepResult(toolCallId);
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(waitCalls, [{
      toolCallId: "grep-one",
      options: { toolName: "Grep", toolArguments: "{\"glob\":\"*.js\"}" },
    }]);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "grep-none");
    assert.match(requests[1].messages.at(-1).content, /input must match exactly one oneOf schema/);
    assert.equal(requests[2].messages.at(-1).tool_call_id, "grep-both");
    assert.match(requests[2].messages.at(-1).content, /input must match exactly one oneOf schema/);
    assert.equal(requests[3].messages.at(-1).tool_call_id, "grep-one");
    assert.match(requests[3].messages.at(-1).content, /\[\/tmp\/project\] a\.txt/);
  } finally {
    restore();
  }
});
