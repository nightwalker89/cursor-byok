"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderAdapter } = require("../src/server/provider-adapter");
const { asyncIterable, interceptModule, quietLog, snapshotJson } = require("./byok-fixtures");

function adapter() {
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLog(),
  });
}

function clientTools() {
  return [
    {
      name: "WebSearch",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { search_term: { type: "string" } },
        required: ["search_term"],
      },
    },
    {
      name: "GenerateImage",
      description: "Image",
      inputSchema: {
        type: "object",
        properties: { description: { type: "string" }, filename: { type: "string" } },
        required: ["description"],
      },
    },
  ];
}

function webArgsJson() {
  return "{\"search_term\":\"Cursor BYOK\"}";
}

function imageArgsJson() {
  return "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}";
}

function clientFailureResult(toolName) {
  return {
    message: {
      case: "byokInteractionToolResult",
      value: {
        toolName,
        toolArguments: toolName === "WebSearch" ? webArgsJson() : imageArgsJson(),
        clientCompletion: toolName === "WebSearch"
          ? { case: "rejected", value: { reason: "Search disabled" } }
          : { case: "error", value: { errorMessage: "Image service failed" } },
      },
    },
  };
}

test("provider loops client tool failure completions back in native API formats", async () => {
  {
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
                          { id: "web-1", index: 0, function: { name: "WebSearch", arguments: webArgsJson() } },
                          { id: "image-1", index: 1, function: { name: "GenerateImage", arguments: imageArgsJson() } },
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
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: "conv-chat-client-tool-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "search and draw" }],
          tools: clientTools(),
        },
        requestId: "req-chat-client-tool-failures",
        waitForToolResult: async (_toolCallId, options) => clientFailureResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].messages.slice(-2), [
        { role: "tool", tool_call_id: "web-1", content: "WebSearch rejected: Search disabled" },
        { role: "tool", tool_call_id: "image-1", content: "GenerateImage error: Image service failed" },
      ]);
    } finally {
      restore();
    }
  }

  {
    const requests = [];
    class FakeOpenAI {
      constructor() {
        this.responses = {
          create: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              return asyncIterable([
                { type: "response.output_item.added", item: { id: "fc-web", type: "function_call", call_id: "web-1", name: "WebSearch" } },
                { type: "response.function_call_arguments.done", item_id: "fc-web", arguments: webArgsJson() },
                { type: "response.output_item.added", item: { id: "fc-image", type: "function_call", call_id: "image-1", name: "GenerateImage" } },
                { type: "response.function_call_arguments.done", item_id: "fc-image", arguments: imageArgsJson() },
                { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
              ]);
            }
            return asyncIterable([
              { type: "response.output_text.delta", delta: "done" },
              { type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 5 } } },
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
          conversationId: "conv-responses-client-tool-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "search and draw" }],
          tools: clientTools(),
        },
        requestId: "req-responses-client-tool-failures",
        waitForToolResult: async (_toolCallId, options) => clientFailureResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].input.slice(-4), [
        { type: "function_call", id: "fc-web", call_id: "web-1", name: "WebSearch", arguments: webArgsJson() },
        { type: "function_call_output", call_id: "web-1", output: "WebSearch rejected: Search disabled" },
        { type: "function_call", id: "fc-image", call_id: "image-1", name: "GenerateImage", arguments: imageArgsJson() },
        { type: "function_call_output", call_id: "image-1", output: "GenerateImage error: Image service failed" },
      ]);
    } finally {
      restore();
    }
  }

  {
    const requests = [];
    class FakeAnthropic {
      constructor() {
        this.messages = {
          stream: async (request) => {
            requests.push(snapshotJson(request));
            if (requests.length === 1) {
              const stream = asyncIterable([
                { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "web-1", name: "WebSearch", input: { search_term: "Cursor BYOK" } } },
                { type: "content_block_stop", index: 0 },
                { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "image-1", name: "GenerateImage", input: { description: "diagram", filename: "/tmp/out.png" } } },
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
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-claude" },
        request: {
          conversationId: "conv-anthropic-client-tool-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "search and draw" }],
          tools: clientTools(),
        },
        requestId: "req-anthropic-client-tool-failures",
        waitForToolResult: async (_toolCallId, options) => clientFailureResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].messages.at(-1), {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "web-1", content: "WebSearch rejected: Search disabled" },
          { type: "tool_result", tool_use_id: "image-1", content: "GenerateImage error: Image service failed" },
        ],
      });
    } finally {
      restore();
    }
  }
});
