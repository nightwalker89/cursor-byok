"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderAdapter, normalizeProviderMessage } = require("../src/server/provider-adapter");
const { asyncIterable, interceptModule, quietLog, snapshotJson } = require("./byok-fixtures");

function adapter() {
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLog(),
  });
}

function historyMessages(toolResultContent) {
  return [
    { role: "user", content: "call prior tool" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu-prev", name: "CallMcpTool", input: { name: "read", args: {} } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu-prev", content: toolResultContent }],
    },
    { role: "user", content: "now answer" },
  ];
}

test("OpenAI Chat provider preserves prior assistant name metadata", async () => {
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
    assert.deepEqual(normalizeProviderMessage({ role: "assistant", name: "reviewer", content: "prior note" }), {
      role: "assistant",
      name: "reviewer",
      content: "prior note",
    });

    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: {
        conversationId: "conv-chat-assistant-name",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "remember speaker" },
          { role: "assistant", name: "reviewer", content: "prior note" },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-assistant-name",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[2], {
      role: "assistant",
      name: "reviewer",
      content: "prior note",
    });
  } finally {
    restore();
  }
});

test("OpenAI providers preserve prior system and developer message roles", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    assert.deepEqual(normalizeProviderMessage({ role: "developer", name: "policy", content: "Prefer concise answers." }), {
      role: "developer",
      name: "policy",
      content: "Prefer concise answers.",
    });
    assert.deepEqual(normalizeProviderMessage({ role: "system", content: "Extra system context." }), {
      role: "system",
      content: "Extra system context.",
    });

    const messages = [
      { role: "developer", name: "policy", content: "Prefer concise answers." },
      { role: "system", content: "Extra system context." },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-role-history", systemPrompt: "system", messages, tools },
      requestId: "req-chat-role-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-role-history", systemPrompt: "system", messages, tools },
      requestId: "req-responses-role-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-role-history", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-role-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages.slice(1, 4), [
      { role: "developer", name: "policy", content: "Prefer concise answers." },
      { role: "system", content: "Extra system context." },
      { role: "user", content: "now answer" },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(1, 4), [
      { role: "developer", content: "Prefer concise answers." },
      { role: "system", content: "Extra system context." },
      { role: "user", content: "now answer" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages, [
      { role: "user", content: "Prefer concise answers." },
      { role: "user", content: "Extra system context." },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("OpenAI Chat provider preserves prior tool message name metadata", async () => {
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
    assert.deepEqual(normalizeProviderMessage({
      role: "tool",
      tool_call_id: "call-prev",
      name: "Read",
      content: "File: /tmp/a\nLines: 1-1\n     1|a",
    }), {
      role: "tool",
      tool_call_id: "call-prev",
      name: "Read",
      content: "File: /tmp/a\nLines: 1-1\n     1|a",
    });

    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: {
        conversationId: "conv-chat-tool-name",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "call prior tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-prev",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call-prev",
            name: "Read",
            content: "File: /tmp/a\nLines: 1-1\n     1|a",
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-tool-name",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[3], {
      role: "tool",
      tool_call_id: "call-prev",
      name: "Read",
      content: "File: /tmp/a\nLines: 1-1\n     1|a",
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider preserves prior assistant tool_calls when content is an array", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: {
        conversationId: "conv-chat-array-content-tool-calls",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "call prior tool" },
          {
            role: "assistant",
            content: [{ type: "text", text: "I will inspect it." }],
            tool_calls: [{
              id: "call-prev",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call-prev",
            content: "File: /tmp/a\nLines: 1-1\n     1|a",
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-array-content-tool-calls",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[2], {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [{
        id: "call-prev",
        type: "function",
        function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      }],
    });
    assert.deepEqual(requests[0].messages[3], {
      role: "tool",
      tool_call_id: "call-prev",
      content: "File: /tmp/a\nLines: 1-1\n     1|a",
    });
  } finally {
    restore();
  }
});

test("OpenAI Responses provider textifies prior Chat assistant array content with tool_calls", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-chat-array-content-tool-calls",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "call prior tool" },
          {
            role: "assistant",
            content: [{ type: "text", text: "I will inspect it." }],
            tool_calls: [{
              id: "call-prev",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call-prev",
            content: "File: /tmp/a\nLines: 1-1\n     1|a",
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-chat-array-content-tool-calls",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input.slice(2, 5), [
      { role: "assistant", content: "I will inspect it." },
      { type: "function_call", call_id: "call-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-prev", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider maps prior Chat user content parts to Responses input blocks", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-chat-user-content-parts",
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
              { type: "file", file_id: "file-1", filename: "notes.txt" },
            ],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-chat-user-content-parts",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input[1], {
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "https://example.test/image.png", detail: "low" },
        { type: "input_file", file_id: "file-1", filename: "notes.txt" },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Responses provider maps native image user blocks to Responses input images", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-native-image-user-content",
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
            ],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-native-image-user-content",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input[1], {
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Responses provider normalizes native message content blocks to legal Responses parts", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-native-message-legal-parts",
        systemPrompt: "system",
        messages: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "prior answer" },
              { type: "image_url", image_url: { url: "https://example.test/assistant.png" } },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image_url", image_url: { url: "https://example.test/user.png", detail: "low" } },
              { type: "file", file_id: "file-1", filename: "notes.txt" },
            ],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-native-message-legal-parts",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input[1], {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "prior answer", annotations: [] },
        { type: "output_text", text: "[image https://example.test/assistant.png]", annotations: [] },
      ],
    });
    assert.deepEqual(requests[0].input[2], {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "https://example.test/user.png", detail: "low" },
        { type: "input_file", file_id: "file-1", filename: "notes.txt" },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider maps native image user blocks to chat image_url parts", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: {
        conversationId: "conv-chat-native-image-user-content",
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
            ],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-native-image-user-content",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[1], {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider request log records latest user image block count", async () => {
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async () => asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  const logEntries = [];
  try {
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: { info: (message, fields) => logEntries.push({ message, fields }) },
    });
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: {
        conversationId: "conv-chat-image-log",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
          ],
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-chat-image-log",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const requestLog = logEntries.find((entry) => entry.message === "BYOK provider request");
    assert.equal(requestLog.fields.imageBlockCount, 1);
    assert.equal(requestLog.fields.userImageBlockCount, 1);
    assert.equal(requestLog.fields.assistantImageBlockCount, 0);
    assert.equal(requestLog.fields.latestUserImageBlockCount, 1);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider request log records latest user image block count", async () => {
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async () => asyncIterable([
          { type: "response.output_text.delta", delta: "done" },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        ]),
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  const logEntries = [];
  try {
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: { info: (message, fields) => logEntries.push({ message, fields }) },
    });
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-image-log",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
          ],
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-image-log",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const requestLog = logEntries.find((entry) => entry.message === "BYOK provider request");
    assert.equal(requestLog.fields.imageBlockCount, 1);
    assert.equal(requestLog.fields.userImageBlockCount, 1);
    assert.equal(requestLog.fields.assistantImageBlockCount, 0);
    assert.equal(requestLog.fields.latestUserImageBlockCount, 1);
  } finally {
    restore();
  }
});

test("Anthropic provider maps prior Chat user content parts to Anthropic content blocks", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-chat-user-content-parts",
        systemPrompt: "system",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this", extra: "drop" },
              { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
              { type: "file", file: { file_id: "file-1", filename: "notes.txt" } },
            ],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-anthropic-chat-user-content-parts",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[0], {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
        { type: "text", text: "[file notes.txt]" },
      ],
    });
  } finally {
    restore();
  }
});

test("OpenAI Chat provider flattens structured prior tool_result content to text", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-structured-tool-result",
        systemPrompt: "system",
        messages: historyMessages([
          { type: "text", text: "first block" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ]),
        tools: [{ name: "CallMcpTool", description: "mcp", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-chat-structured-tool-result",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const toolMessage = requests[0].messages.find((message) => message.role === "tool");
    assert.deepEqual(toolMessage, {
      role: "tool",
      tool_call_id: "toolu-prev",
      content: "first block\n\n[image image/png]",
    });
  } finally {
    restore();
  }
});

test("OpenAI Responses provider flattens structured prior tool_result content to function output text", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-structured-tool-result",
        systemPrompt: "system",
        messages: historyMessages([
          { type: "text", text: "first block" },
          { type: "file", filename: "report.pdf" },
        ]),
        tools: [{ name: "CallMcpTool", description: "mcp", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-responses-structured-tool-result",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const output = requests[0].input.find((item) => item.type === "function_call_output");
    assert.deepEqual(output, {
      type: "function_call_output",
      call_id: "toolu-prev",
      output: "first block\n\n[file report.pdf]",
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves Anthropic prior tool_result content blocks", async () => {
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
    const content = [
      { type: "text", text: "first block", cache_control: { type: "ephemeral" }, extra: "drop" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" }, extra: "drop" },
    ];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-structured-tool-result",
        systemPrompt: "system",
        messages: historyMessages(content),
        tools: [{ name: "CallMcpTool", description: "mcp", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-anthropic-structured-tool-result",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const toolResult = requests[0].messages[2].content[0];
    assert.deepEqual(toolResult, {
      type: "tool_result",
      tool_use_id: "toolu-prev",
      content: [
        { type: "text", text: "first block", cache_control: { type: "ephemeral" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider flattens Cursor MCP prior tool_result blocks to text", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-cursor-mcp-tool-result",
        systemPrompt: "system",
        messages: historyMessages([
          { content: { case: "text", value: { text: "mcp text" } } },
          { content: { case: "image", value: { mimeType: "image/png" } } },
        ]),
        tools: [{ name: "CallMcpTool", description: "mcp", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-anthropic-cursor-mcp-tool-result",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const toolResult = requests[0].messages[2].content[0];
    assert.deepEqual(toolResult, {
      type: "tool_result",
      tool_use_id: "toolu-prev",
      content: "mcp text\n\n[image image/png]",
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves valid prior tool_result blocks while textifying Cursor-only blocks", async () => {
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
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-mixed-tool-result",
        systemPrompt: "system",
        messages: historyMessages([
          { type: "text", text: "anthropic text", cache_control: { type: "ephemeral" }, extra: "drop" },
          { content: { case: "text", value: { text: "mcp text" } } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" }, extra: "drop" },
          { content: { case: "image", value: { mimeType: "image/jpeg" } } },
        ]),
        tools: [{ name: "CallMcpTool", description: "mcp", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-anthropic-mixed-tool-result",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    const toolResult = requests[0].messages[2].content[0];
    assert.deepEqual(toolResult, {
      type: "tool_result",
      tool_use_id: "toolu-prev",
      content: [
        { type: "text", text: "anthropic text", cache_control: { type: "ephemeral" } },
        { type: "text", text: "mcp text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        { type: "text", text: "[image image/jpeg]" },
      ],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves standalone prior tool_result metadata", async () => {
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
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-prev", name: "Read", input: { path: "/tmp/a" } }],
      },
      {
        type: "tool_result",
        tool_use_id: "toolu-prev",
        content: "Read error: permission denied",
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "now answer" },
    ];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-standalone-tool-result-metadata",
        systemPrompt: "system",
        messages,
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-anthropic-standalone-tool-result-metadata",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[2], {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu-prev",
        content: "Read error: permission denied",
        is_error: true,
        cache_control: { type: "ephemeral" },
      }],
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves prior tool_use cache control", async () => {
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
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu-prev",
          name: "Read",
          input: { path: "/tmp/a" },
          cache_control: { type: "ephemeral" },
          cursor_only: true,
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-prev", content: "File: /tmp/a\nLines: 1-1\n     1|a" }],
      },
      { role: "user", content: "now answer" },
    ];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-tool-use-cache-control",
        systemPrompt: "system",
        messages,
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: {} } }],
      },
      requestId: "req-anthropic-tool-use-cache-control",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[1].content[0], {
      type: "tool_use",
      id: "toolu-prev",
      name: "Read",
      input: { path: "/tmp/a" },
      cache_control: { type: "ephemeral" },
    });
  } finally {
    restore();
  }
});

test("Anthropic provider preserves prior thinking blocks only for Anthropic format", async () => {
  const anthropicRequests = [];
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
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
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  try {
    const thinkingBlocks = [
      { type: "thinking", thinking: "public thinking summary", signature: "sig-thinking" },
      { type: "redacted_thinking", data: "sealed-private-thinking", signature: "sig-redacted" },
      { type: "tool_use", id: "toolu-prev", name: "Read", input: { path: "/tmp/a" } },
    ];
    const messages = [
      { role: "user", content: "call prior tool" },
      { role: "assistant", content: thinkingBlocks },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu-prev", content: "File: /tmp/a\nLines: 1-1\n     1|a" }],
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: {} } }];
    for (const provider of [
      { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
    ]) {
      for await (const _event of adapter().run({
        provider,
        model: { id: "byok-model", apiModel: "fake-model" },
        request: { conversationId: `conv-${provider.type}-prior-thinking`, systemPrompt: "system", messages, tools },
        requestId: `req-${provider.type}-prior-thinking`,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain stream.
      }
    }

    assert.deepEqual(anthropicRequests[0].messages[1].content.slice(0, 2), thinkingBlocks.slice(0, 2));
    assert.match(openAiChatRequests[0].messages[2].content, /Anthropic thinking block/);
    assert.match(openAiChatRequests[0].messages[2].content, /public thinking summary/);
    assert.match(openAiChatRequests[0].messages[2].content, /Anthropic redacted_thinking block/);
    assert.match(openAiChatRequests[0].messages[2].content, /signature: \[preserved for Anthropic only\]/);
    assert.doesNotMatch(openAiChatRequests[0].messages[2].content, /sealed-private-thinking|sig-thinking|sig-redacted|"data"|"signature"/);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      { role: "assistant", content: openAiChatRequests[0].messages[2].content },
      { type: "function_call", call_id: "toolu-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
    ]);
  } finally {
    restoreOpenAi();
    restoreAnthropic();
  }
});

test("provider history normalizes non-OpenAI assistant tool_calls across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{
          id: "call-prev",
          name: "Read",
          input: { path: "/tmp/a", offset: 2 },
        }],
      },
      { role: "tool", tool_call_id: "call-prev", content: "File: /tmp/a\nLines: 2-2\n     2|a" },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-non-openai-tool-calls", systemPrompt: "system", messages, tools },
      requestId: "req-chat-non-openai-tool-calls",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-non-openai-tool-calls", systemPrompt: "system", messages, tools },
      requestId: "req-responses-non-openai-tool-calls",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-non-openai-tool-calls", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-non-openai-tool-calls",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[2], {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [{
        id: "call-prev",
        type: "function",
        function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
      }],
    });
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      { role: "assistant", content: "I will inspect it." },
      { type: "function_call", call_id: "call-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "call-prev", name: "Read", input: { path: "/tmp/a", offset: 2 } },
      ],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history preserves OpenAI Chat custom tool calls across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior custom tool" },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{
          id: "custom-prev",
          type: "custom",
          custom: { name: "Read", input: "read /tmp/custom with limit 2" },
        }],
      },
      { role: "tool", tool_call_id: "custom-prev", content: "custom output" },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-chat-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-responses-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[2], {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [{
        id: "custom-prev",
        type: "custom",
        custom: { name: "Read", input: "read /tmp/custom with limit 2" },
      }],
    });
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      { role: "assistant", content: "I will inspect it." },
      { type: "custom_tool_call", call_id: "custom-prev", name: "Read", input: "read /tmp/custom with limit 2" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "custom-prev", name: "Read", input: { input: "read /tmp/custom with limit 2" } },
      ],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history preserves OpenAI Responses custom tool calls across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const customCall = {
      type: "custom_tool_call",
      id: "ctc-item-prev",
      call_id: "ctc-prev",
      name: "Read",
      input: "read /tmp/responses-custom with limit 2",
      status: "completed",
    };
    const messages = [
      { role: "user", content: "prior Responses custom call" },
      customCall,
      { type: "custom_tool_call_output", call_id: "ctc-prev", output: "custom output" },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-responses-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-chat-responses-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-responses-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-responses-responses-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-responses-custom-tool-call-history", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-responses-custom-tool-call-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages.slice(2, 4), [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "ctc-prev",
        type: "custom",
        custom: { name: "Read", input: "read /tmp/responses-custom with limit 2" },
      }],
    }, {
      role: "tool",
      tool_call_id: "ctc-prev",
      content: "custom output",
    }]);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      customCall,
      { type: "custom_tool_call_output", call_id: "ctc-prev", output: "custom output" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages.slice(1, 3), [{
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "ctc-prev",
        name: "Read",
        input: { input: "read /tmp/responses-custom with limit 2" },
      }],
    }, {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "ctc-prev",
        content: "custom output",
      }],
    }]);
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("OpenAI Chat provider preserves null content on prior native assistant tool calls", async () => {
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
    const messages = [
      { role: "user", content: "call prior tool" },
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
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-null-tool-call-content", systemPrompt: "system", messages, tools },
      requestId: "req-chat-null-tool-call-content",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-prev",
        type: "function",
        function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2}" },
      }],
    });
  } finally {
    restore();
  }
});

test("provider history normalizes non-string function_call arguments across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      { type: "function_call", id: "fc-prev", toolName: "Read", input: { path: "/tmp/a", limit: 4 } },
      { type: "function_call_output", call_id: "fc-prev", output: "File: /tmp/a\nLines: 1-4\n     1|a" },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-object-function-call", systemPrompt: "system", messages, tools },
      requestId: "req-chat-object-function-call",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-object-function-call", systemPrompt: "system", messages, tools },
      requestId: "req-responses-object-function-call",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-object-function-call", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-object-function-call",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "fc-prev",
        type: "function",
        function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"limit\":4}" },
      }],
    });
    assert.deepEqual(openAiResponsesRequests[0].input[2], {
      type: "function_call",
      call_id: "fc-prev",
      name: "Read",
      arguments: "{\"path\":\"/tmp/a\",\"limit\":4}",
    });
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [{ type: "tool_use", id: "fc-prev", name: "Read", input: { path: "/tmp/a", limit: 4 } }],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("OpenAI Responses provider preserves prior native function item metadata", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    const messages = [
      {
        type: "message",
        id: "msg-user-prev",
        role: "user",
        content: [{ type: "input_text", text: "call prior tool" }],
        status: "completed",
      },
      {
        type: "message",
        id: "msg-assistant-prev",
        role: "assistant",
        content: [{ type: "output_text", text: "planning next move", annotations: [] }],
        status: "completed",
        phase: "commentary",
      },
      {
        type: "function_call",
        id: "fc-item-prev",
        call_id: "call-prev",
        name: "Read",
        arguments: "{\"path\":\"/tmp/a\"}",
        status: "completed",
        created_by: "assistant",
        namespace: "workspace",
      },
      {
        type: "function_call_output",
        id: "fco-item-prev",
        call_id: "call-prev",
        output: [{ type: "input_text", text: "File: /tmp/a\nLines: 1-1\n     1|a" }],
        status: "completed",
        created_by: "tool",
      },
      { role: "user", content: "now answer" },
    ];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-native-function-metadata",
        systemPrompt: "system",
        messages,
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-native-function-metadata",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input.slice(1, 5), [
      {
        type: "message",
        id: "msg-user-prev",
        role: "user",
        content: [{ type: "input_text", text: "call prior tool" }],
        status: "completed",
      },
      {
        type: "message",
        id: "msg-assistant-prev",
        role: "assistant",
        content: [{ type: "output_text", text: "planning next move", annotations: [] }],
        status: "completed",
        phase: "commentary",
      },
      {
        type: "function_call",
        id: "fc-item-prev",
        call_id: "call-prev",
        name: "Read",
        arguments: "{\"path\":\"/tmp/a\"}",
        status: "completed",
        created_by: "assistant",
        namespace: "workspace",
      },
      {
        type: "function_call_output",
        id: "fco-item-prev",
        call_id: "call-prev",
        output: [{ type: "input_text", text: "File: /tmp/a\nLines: 1-1\n     1|a" }],
        status: "completed",
        created_by: "tool",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider preserves prior native non-function items", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
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
    const nativeItems = [
      {
        type: "reasoning",
        id: "rs-prev",
        summary: [{ type: "summary_text", text: "kept summary" }],
        content: [{ type: "reasoning_text", text: "private chain" }],
        encrypted_content: "opaque",
        status: "completed",
      },
      {
        type: "mcp_call",
        id: "mcp-prev",
        call_id: "mcp-call-prev",
        name: "search",
        server_label: "docs",
        arguments: "{\"query\":\"BYOK\"}",
        output: "result",
        status: "completed",
        approval_request_id: "approval-prev",
      },
      {
        type: "file_search_call",
        id: "file-search-prev",
        queries: ["BYOK"],
        status: "completed",
        results: [],
      },
      {
        type: "web_search_call",
        id: "web-search-prev",
        action: { type: "search", query: "BYOK" },
        status: "completed",
      },
      {
        type: "tool_search_output",
        id: "tool-search-output-prev",
        call_id: "tool-search-prev",
        execution: "server",
        status: "completed",
        tools: [],
      },
      { type: "item_reference", id: "rs-prev" },
    ];

    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: {
        conversationId: "conv-responses-native-non-function-items",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "prior native items" },
          ...nativeItems,
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-native-non-function-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[0].input.slice(2, 8), nativeItems);
  } finally {
    restore();
  }
});

test("non-Responses providers textify prior native Responses items", async () => {
  const openAiChatRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            openAiChatRequests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          anthropicRequests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
          return stream;
        },
      };
    }
  }
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const nativeItem = {
      type: "reasoning",
      id: "rs-prev",
      summary: [{ type: "summary_text", text: "kept summary" }],
      content: [{ type: "reasoning_text", text: "private chain" }],
      encrypted_content: "opaque",
      status: "completed",
    };
    for (const provider of [
      { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
    ]) {
      for await (const _event of adapter().run({
        provider,
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: `conv-${provider.type}-native-responses-item`,
          systemPrompt: "system",
          messages: [
            { role: "user", content: "prior native item" },
            nativeItem,
            { role: "user", content: "now answer" },
          ],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        },
        requestId: `req-${provider.type}-native-responses-item`,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain stream.
      }
    }

    assert.equal(openAiChatRequests[0].messages[2].role, "user");
    assert.match(openAiChatRequests[0].messages[2].content, /OpenAI Responses reasoning item/);
    assert.match(openAiChatRequests[0].messages[2].content, /kept summary/);
    assert.doesNotMatch(openAiChatRequests[0].messages[2].content, /encrypted_content|opaque|reasoning_text|private chain/);
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "user",
      content: [{
        type: "text",
        text: openAiChatRequests[0].messages[2].content,
      }],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("non-Responses providers textify Responses message content blocks into legal target API content", async () => {
  const openAiChatRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            openAiChatRequests.push(snapshotJson(request));
            return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          anthropicRequests.push(snapshotJson(request));
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
          return stream;
        },
      };
    }
  }
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const priorAssistantMessage = {
      type: "message",
      id: "msg-prev",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "visible answer", annotations: [] },
        { type: "refusal", refusal: "cannot comply" },
      ],
    };
    const priorUserMessage = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "https://example.test/image.png", detail: "low" },
        { type: "input_file", filename: "notes.txt", file_id: "file-1" },
      ],
    };
    for (const provider of [
      { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
    ]) {
      for await (const _event of adapter().run({
        provider,
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: `conv-${provider.type}-responses-message-blocks`,
          systemPrompt: "system",
          messages: [
            { role: "user", content: "prior message blocks" },
            priorAssistantMessage,
            priorUserMessage,
            { role: "user", content: "now answer" },
          ],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        },
        requestId: `req-${provider.type}-responses-message-blocks`,
        waitForToolResult: async () => {
          throw new Error("unexpected tool call");
        },
      })) {
        // Drain stream.
      }
    }

    assert.equal(openAiChatRequests[0].messages[2].role, "assistant");
    assert.equal(openAiChatRequests[0].messages[2].content, "visible answer\ncannot comply");
    assert.equal(openAiChatRequests[0].messages[3].role, "user");
    assert.deepEqual(openAiChatRequests[0].messages[3].content, [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } },
      { type: "file", file: { file_id: "file-1", filename: "notes.txt" } },
    ]);
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "text", text: "cannot comply" },
      ],
    });
    assert.deepEqual(anthropicRequests[0].messages[2], {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
        { type: "text", text: "[file notes.txt]" },
      ],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history preserves nested Responses function items across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "function_call",
            id: "fc-item-prev",
            call_id: "call-prev",
            name: "Read",
            arguments: "{\"path\":\"/tmp/a\",\"limit\":2}",
            status: "completed",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool returned:" },
          {
            type: "function_call_output",
            id: "fco-item-prev",
            call_id: "call-prev",
            output: "File: /tmp/a\nLines: 1-2\n     1|a\n     2|b",
            status: "completed",
          },
        ],
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-nested-responses-items", systemPrompt: "system", messages, tools },
      requestId: "req-chat-nested-responses-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-nested-responses-items", systemPrompt: "system", messages, tools },
      requestId: "req-responses-nested-responses-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-nested-responses-items", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-nested-responses-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[2], {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [{
        id: "call-prev",
        type: "function",
        function: { name: "Read", arguments: "{\"path\":\"/tmp/a\",\"limit\":2}" },
      }],
    });
    assert.deepEqual(openAiChatRequests[0].messages[3], {
      role: "user",
      content: [{ type: "text", text: "Tool returned:" }],
    });
    assert.deepEqual(openAiChatRequests[0].messages[4], {
      role: "tool",
      tool_call_id: "call-prev",
      content: "File: /tmp/a\nLines: 1-2\n     1|a\n     2|b",
    });
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 5), [
      { role: "assistant", content: "I will inspect it." },
      {
        type: "function_call",
        id: "fc-item-prev",
        call_id: "call-prev",
        name: "Read",
        arguments: "{\"path\":\"/tmp/a\",\"limit\":2}",
        status: "completed",
      },
      { role: "user", content: [{ type: "input_text", text: "Tool returned:" }] },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input[5], {
      type: "function_call_output",
      id: "fco-item-prev",
      call_id: "call-prev",
      output: "File: /tmp/a\nLines: 1-2\n     1|a\n     2|b",
      status: "completed",
    });
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "call-prev", name: "Read", input: { path: "/tmp/a", limit: 2 } },
      ],
    });
    assert.deepEqual(anthropicRequests[0].messages[2], {
      role: "user",
      content: [{ type: "text", text: "Tool returned:" }],
    });
    assert.deepEqual(anthropicRequests[0].messages[3], {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-prev",
        content: "File: /tmp/a\nLines: 1-2\n     1|a\n     2|b",
      }],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history preserves nested Responses custom tool items across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior custom tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "custom_tool_call",
            id: "ctc-item-prev",
            call_id: "custom-prev",
            name: "Read",
            input: "read /tmp/custom with limit 2",
            status: "completed",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Custom tool returned:" },
          {
            type: "custom_tool_call_output",
            id: "ctco-item-prev",
            call_id: "custom-prev",
            output: "custom output",
            status: "completed",
          },
        ],
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-nested-responses-custom-items", systemPrompt: "system", messages, tools },
      requestId: "req-chat-nested-responses-custom-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-nested-responses-custom-items", systemPrompt: "system", messages, tools },
      requestId: "req-responses-nested-responses-custom-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-nested-responses-custom-items", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-nested-responses-custom-items",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[2], {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [{
        id: "custom-prev",
        type: "custom",
        custom: { name: "Read", input: "read /tmp/custom with limit 2" },
      }],
    });
    assert.deepEqual(openAiChatRequests[0].messages[3], {
      role: "user",
      content: [{ type: "text", text: "Custom tool returned:" }],
    });
    assert.deepEqual(openAiChatRequests[0].messages[4], {
      role: "tool",
      tool_call_id: "custom-prev",
      content: "custom output",
    });
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 5), [
      { role: "assistant", content: "I will inspect it." },
      {
        type: "custom_tool_call",
        id: "ctc-item-prev",
        call_id: "custom-prev",
        name: "Read",
        input: "read /tmp/custom with limit 2",
        status: "completed",
      },
      { role: "user", content: [{ type: "input_text", text: "Custom tool returned:" }] },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input[5], {
      type: "custom_tool_call_output",
      id: "ctco-item-prev",
      call_id: "custom-prev",
      output: "custom output",
      status: "completed",
    });
    assert.deepEqual(anthropicRequests[0].messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "custom-prev", name: "Read", input: { input: "read /tmp/custom with limit 2" } },
      ],
    });
    assert.deepEqual(anthropicRequests[0].messages[2], {
      role: "user",
      content: [{ type: "text", text: "Custom tool returned:" }],
    });
    assert.deepEqual(anthropicRequests[0].messages[3], {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "custom-prev",
        content: "custom output",
      }],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history normalizes function_call_output aliases across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      { type: "function_call", callId: "fc-prev", toolName: "Read", args: { path: "/tmp/a" } },
      {
        type: "function_call_output",
        callId: "fc-prev",
        result: [
          { type: "text", text: "File: /tmp/a\nLines: 1-1\n     1|a" },
        ],
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-output-alias", systemPrompt: "system", messages, tools },
      requestId: "req-chat-output-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-output-alias", systemPrompt: "system", messages, tools },
      requestId: "req-responses-output-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-output-alias", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-output-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages[3], {
      role: "tool",
      tool_call_id: "fc-prev",
      content: "File: /tmp/a\nLines: 1-1\n     1|a",
    });
    assert.deepEqual(openAiResponsesRequests[0].input[3], {
      type: "function_call_output",
      call_id: "fc-prev",
      output: "File: /tmp/a\nLines: 1-1\n     1|a",
    });
    assert.deepEqual(anthropicRequests[0].messages[2], {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "fc-prev",
        content: [{ type: "text", text: "File: /tmp/a\nLines: 1-1\n     1|a" }],
      }],
    });
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history normalizes custom_tool_call_output across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "custom output history" },
      {
        type: "custom_tool_call_output",
        id: "custom-output-item",
        call_id: "custom-call-prev",
        output: "custom result",
        status: "completed",
      },
      {
        role: "user",
        content: [{
          type: "custom_tool_call_output",
          id: "nested-custom-output-item",
          call_id: "nested-custom-call-prev",
          output: [{ type: "input_text", text: "nested custom result" }],
          status: "completed",
        }],
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-custom-output-history", systemPrompt: "system", messages, tools },
      requestId: "req-chat-custom-output-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-custom-output-history", systemPrompt: "system", messages, tools },
      requestId: "req-responses-custom-output-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-custom-output-history", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-custom-output-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages.slice(2, 4), [
      { role: "tool", tool_call_id: "custom-call-prev", content: "custom result" },
      { role: "tool", tool_call_id: "nested-custom-call-prev", content: "nested custom result" },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      {
        type: "custom_tool_call_output",
        id: "custom-output-item",
        call_id: "custom-call-prev",
        output: "custom result",
        status: "completed",
      },
      {
        type: "custom_tool_call_output",
        id: "nested-custom-output-item",
        call_id: "nested-custom-call-prev",
        output: [{ type: "input_text", text: "nested custom result" }],
        status: "completed",
      },
    ]);
    assert.deepEqual(anthropicRequests[0].messages.slice(1, 3), [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "custom-call-prev", content: "custom result" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "nested-custom-call-prev", content: "nested custom result" }],
      },
    ]);
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history normalizes tool use and result id aliases across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          tool_call_id: "alias-prev",
          tool_name: "Read",
          args: { path: "/tmp/alias", limit: 2 },
        }],
      },
      { role: "tool", callId: "alias-prev", output: "File: /tmp/alias\nLines: 1-2\n     1|a" },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-tool-alias", systemPrompt: "system", messages, tools },
      requestId: "req-chat-tool-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-tool-alias", systemPrompt: "system", messages, tools },
      requestId: "req-responses-tool-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-tool-alias", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-tool-alias",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages.slice(2, 4), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "alias-prev",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"/tmp/alias\",\"limit\":2}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "alias-prev",
        content: "File: /tmp/alias\nLines: 1-2\n     1|a",
      },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      { type: "function_call", call_id: "alias-prev", name: "Read", arguments: "{\"path\":\"/tmp/alias\",\"limit\":2}" },
      { type: "function_call_output", call_id: "alias-prev", output: "File: /tmp/alias\nLines: 1-2\n     1|a" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages.slice(1, 3), [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "alias-prev", name: "Read", input: { path: "/tmp/alias", limit: 2 } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "alias-prev",
          content: "File: /tmp/alias\nLines: 1-2\n     1|a",
        }],
      },
    ]);
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});

test("provider history normalizes nested function_call fields across API formats", async () => {
  const openAiChatRequests = [];
  const openAiResponsesRequests = [];
  const anthropicRequests = [];
  class FakeOpenAI {
    constructor(options) {
      if (String(options?.baseURL || "").includes("responses")) {
        this.responses = {
          create: async (request) => {
            openAiResponsesRequests.push(snapshotJson(request));
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          },
        };
      } else {
        this.chat = {
          completions: {
            create: async (request) => {
              openAiChatRequests.push(snapshotJson(request));
              return asyncIterable([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            },
          },
        };
      }
    }
  }
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
  const restoreOpenAi = interceptModule("openai", FakeOpenAI);
  const restoreAnthropic = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const messages = [
      { role: "user", content: "call prior tool" },
      {
        type: "function_call",
        call_id: "nested-prev",
        function: {
          name: "Read",
          arguments: { path: "/tmp/nested", offset: 3 },
        },
      },
      {
        type: "function_call_output",
        call_id: "nested-prev",
        output: "File: /tmp/nested\nLines: 3-3\n     3|a",
      },
      { role: "user", content: "now answer" },
    ];
    const tools = [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://chat", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-chat" },
      request: { conversationId: "conv-chat-nested-function", systemPrompt: "system", messages, tools },
      requestId: "req-chat-nested-function",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://responses", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses" },
      request: { conversationId: "conv-responses-nested-function", systemPrompt: "system", messages, tools },
      requestId: "req-responses-nested-function",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }
    for await (const _event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://anthropic", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: { conversationId: "conv-anthropic-nested-function", systemPrompt: "system", messages, tools },
      requestId: "req-anthropic-nested-function",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // Drain stream.
    }

    assert.deepEqual(openAiChatRequests[0].messages.slice(2, 4), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "nested-prev",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"/tmp/nested\",\"offset\":3}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "nested-prev",
        content: "File: /tmp/nested\nLines: 3-3\n     3|a",
      },
    ]);
    assert.deepEqual(openAiResponsesRequests[0].input.slice(2, 4), [
      { type: "function_call", call_id: "nested-prev", name: "Read", arguments: "{\"path\":\"/tmp/nested\",\"offset\":3}" },
      { type: "function_call_output", call_id: "nested-prev", output: "File: /tmp/nested\nLines: 3-3\n     3|a" },
    ]);
    assert.deepEqual(anthropicRequests[0].messages.slice(1, 3), [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "nested-prev", name: "Read", input: { path: "/tmp/nested", offset: 3 } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "nested-prev",
          content: "File: /tmp/nested\nLines: 3-3\n     3|a",
        }],
      },
    ]);
  } finally {
    restoreAnthropic();
    restoreOpenAi();
  }
});
