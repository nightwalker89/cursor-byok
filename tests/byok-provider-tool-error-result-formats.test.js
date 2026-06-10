"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderAdapter } = require("../src/server/provider-adapter");
const { normalizeExecClientResult } = require("../src/server/http");
const { asyncIterable, interceptModule, quietLog, snapshotJson } = require("./byok-fixtures");

function adapter() {
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLog(),
  });
}

const errorToolCalls = [
  {
    id: "grep-timeout-1",
    name: "Grep",
    argsJson: "{\"pattern\":\"needle\",\"path\":\"/tmp/project\"}",
    args: { pattern: "needle", path: "/tmp/project" },
    result: {
      execId: "grep-timeout-1",
      message: {
        case: "grepResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor Grep result grep-timeout-1" } } },
      },
    },
    providerText: "Grep error: Timed out waiting for Cursor Grep result grep-timeout-1",
  },
  {
    id: "glob-timeout-1",
    name: "Glob",
    argsJson: "{\"glob_pattern\":\"*.js\",\"target_directory\":\"/tmp/project\"}",
    args: { glob_pattern: "*.js", target_directory: "/tmp/project" },
    result: {
      execId: "glob-timeout-1",
      message: {
        case: "grepResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor Glob result glob-timeout-1" } } },
      },
    },
    providerText: "Glob error: Timed out waiting for Cursor Glob result glob-timeout-1",
  },
  {
    id: "read-error-1",
    name: "Read",
    argsJson: "{\"path\":\"/tmp/project/missing.txt\"}",
    args: { path: "/tmp/project/missing.txt" },
    result: {
      execId: "read-error-1",
      message: {
        case: "readResult",
        value: { result: { case: "fileNotFound", value: { path: "/tmp/project/missing.txt" } } },
      },
    },
    providerText: "File not found",
  },
  {
    id: "delete-timeout-1",
    name: "Delete",
    argsJson: "{\"path\":\"/tmp/project/stale.txt\"}",
    args: { path: "/tmp/project/stale.txt" },
    result: {
      execId: "delete-timeout-1",
      message: {
        case: "deleteResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor Delete result delete-timeout-1" } } },
      },
    },
    providerText: "Delete error: Timed out waiting for Cursor Delete result delete-timeout-1",
  },
  {
    id: "unknown-timeout-1",
    name: "PrivateTool",
    argsJson: "{\"payload\":true}",
    args: { payload: true },
    result: {
      execId: "unknown-timeout-1",
      message: {
        case: "requestContextResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor PrivateTool result unknown-timeout-1" } } },
      },
    },
    providerText: "Tool error: Timed out waiting for Cursor PrivateTool result unknown-timeout-1",
  },
  {
    id: "mcp-timeout-1",
    name: "plugin-atlassian-atlassian-read_ticket",
    executionName: "CallMcpTool",
    argsJson: "{\"key\":\"OPS-123\"}",
    executionArgsJson: "{\"name\":\"plugin-atlassian-atlassian-read_ticket\",\"args\":{\"key\":\"OPS-123\"},\"providerIdentifier\":\"plugin-atlassian-atlassian\",\"toolName\":\"read_ticket\",\"displayName\":\"plugin-atlassian-atlassian-read_ticket\"}",
    args: { key: "OPS-123" },
    executionArgs: {
      name: "plugin-atlassian-atlassian-read_ticket",
      args: { key: "OPS-123" },
      providerIdentifier: "plugin-atlassian-atlassian",
      toolName: "read_ticket",
      displayName: "plugin-atlassian-atlassian-read_ticket",
    },
    result: {
      execId: "mcp-timeout-1",
      message: {
        case: "mcpResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor MCP result mcp-timeout-1" } } },
      },
    },
    providerText: "MCP error: Timed out waiting for Cursor MCP result mcp-timeout-1",
  },
  {
    id: "list-mcp-timeout-1",
    name: "ListMcpResources",
    argsJson: "{\"server\":\"plugin-atlassian-atlassian\"}",
    args: { server: "plugin-atlassian-atlassian" },
    result: {
      execId: "list-mcp-timeout-1",
      message: {
        case: "listMcpResourcesExecResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor ListMcpResources result list-mcp-timeout-1" } } },
      },
    },
    providerText: "List MCP resources error: Timed out waiting for Cursor ListMcpResources result list-mcp-timeout-1",
  },
  {
    id: "fetch-mcp-timeout-1",
    name: "FetchMcpResource",
    argsJson: "{\"server\":\"plugin-atlassian-atlassian\",\"uri\":\"ticket://OPS-123\"}",
    args: { server: "plugin-atlassian-atlassian", uri: "ticket://OPS-123" },
    result: {
      execId: "fetch-mcp-timeout-1",
      message: {
        case: "readMcpResourceExecResult",
        value: { result: { case: "error", value: { error: "Timed out waiting for Cursor FetchMcpResource result fetch-mcp-timeout-1" } } },
      },
    },
    providerText: "Read MCP resource error: Timed out waiting for Cursor FetchMcpResource result fetch-mcp-timeout-1",
  },
];

function errorTools() {
  return [
    {
      name: "Grep",
      description: "Grep",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
    {
      name: "Glob",
      description: "Glob",
      inputSchema: {
        type: "object",
        properties: { glob_pattern: { type: "string" }, target_directory: { type: "string" } },
        required: ["glob_pattern"],
      },
    },
    {
      name: "Read",
      description: "Read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "Delete",
      description: "Delete",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "PrivateTool",
      description: "Private",
      inputSchema: { type: "object", properties: { payload: { type: "boolean" } } },
    },
    {
      name: "plugin-atlassian-atlassian-read_ticket",
      description: "Read ticket",
      providerIdentifier: "plugin-atlassian-atlassian",
      toolName: "read_ticket",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "ListMcpResources",
      description: "List MCP resources",
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
    },
    {
      name: "FetchMcpResource",
      description: "Fetch MCP resource",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
    },
    {
      name: "RecordScreen",
      description: "Record screen",
      inputSchema: { type: "object", properties: { duration_ms: { type: "integer" } } },
    },
    {
      name: "ComputerUse",
      description: "Computer use",
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    },
  ];
}

const filteredScreenComputerToolCalls = [
  {
    id: "record-screen-1",
    name: "RecordScreen",
    argsJson: "{\"duration_ms\":1000}",
    args: { duration_ms: 1000 },
    providerText: "Invalid RecordScreen input: RecordScreen is filtered in BYOK mode and is not available as a BYOK provider tool.",
  },
  {
    id: "computer-use-1",
    name: "ComputerUse",
    argsJson: "{\"action\":\"screenshot\"}",
    args: { action: "screenshot" },
    providerText: "Invalid ComputerUse input: ComputerUse is filtered in BYOK mode and is not available as a BYOK provider tool.",
  },
];

function filteredScreenComputerTools() {
  return [
    {
      name: "RecordScreen",
      description: "Record screen",
      inputSchema: { type: "object", properties: { duration_ms: { type: "integer" } } },
    },
    {
      name: "ComputerUse",
      description: "Computer use",
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    },
  ];
}

test("provider returns filtered screen and computer tool errors without Cursor wait", async () => {
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
                        tool_calls: filteredScreenComputerToolCalls.map((call, index) => ({
                          id: call.id,
                          index,
                          function: { name: call.name, arguments: call.argsJson },
                        })),
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
      const waitCalls = [];
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: "conv-chat-filtered-screen-computer-tools",
          systemPrompt: "system",
          messages: [{ role: "user", content: "record and inspect screen" }],
          tools: filteredScreenComputerTools(),
        },
        requestId: "req-chat-filtered-screen-computer-tools",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return {};
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, []);
      assert.equal(!Object.prototype.hasOwnProperty.call(requests[0], "tools") || requests[0].tools.length === 0, true);
      assert.deepEqual(requests[1].messages.slice(-filteredScreenComputerToolCalls.length), filteredScreenComputerToolCalls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: call.providerText,
      })));
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
              const events = [];
              for (const call of filteredScreenComputerToolCalls) {
                events.push({ type: "response.output_item.added", item: { id: `fc-${call.id}`, type: "function_call", call_id: call.id, name: call.name } });
                events.push({ type: "response.function_call_arguments.done", item_id: `fc-${call.id}`, arguments: call.argsJson });
              }
              events.push({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } });
              return asyncIterable(events);
            }
            return asyncIterable([
              { type: "response.output_text.delta", delta: "continued" },
              { type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 5 } } },
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
          conversationId: "conv-responses-filtered-screen-computer-tools",
          systemPrompt: "system",
          messages: [{ role: "user", content: "record and inspect screen" }],
          tools: filteredScreenComputerTools(),
        },
        requestId: "req-responses-filtered-screen-computer-tools",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return {};
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, []);
      assert.equal(!Object.prototype.hasOwnProperty.call(requests[0], "tools") || requests[0].tools.length === 0, true);
      assert.deepEqual(requests[1].input.slice(-(filteredScreenComputerToolCalls.length * 2)), filteredScreenComputerToolCalls.flatMap((call) => [
        { type: "function_call", id: `fc-${call.id}`, call_id: call.id, name: call.name, arguments: call.argsJson },
        { type: "function_call_output", call_id: call.id, output: call.providerText },
      ]));
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
              const stream = asyncIterable(filteredScreenComputerToolCalls.flatMap((call, index) => [
                {
                  type: "content_block_start",
                  index,
                  content_block: { type: "tool_use", id: call.id, name: call.name, input: call.args },
                },
                { type: "content_block_stop", index },
              ]));
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
      const waitCalls = [];
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-claude" },
        request: {
          conversationId: "conv-anthropic-filtered-screen-computer-tools",
          systemPrompt: "system",
          messages: [{ role: "user", content: "record and inspect screen" }],
          tools: filteredScreenComputerTools(),
        },
        requestId: "req-anthropic-filtered-screen-computer-tools",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return {};
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, []);
      assert.equal(!Object.prototype.hasOwnProperty.call(requests[0], "tools") || requests[0].tools.length === 0, true);
      assert.deepEqual(requests[1].messages.at(-1), {
        role: "user",
        content: filteredScreenComputerToolCalls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: call.providerText,
        })),
      });
    } finally {
      restore();
    }
  }
});

test("provider loops native Cursor tool error results back in native API formats", async () => {
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
                        tool_calls: errorToolCalls.map((call, index) => ({
                          id: call.id,
                          index,
                          function: { name: call.name, arguments: call.argsJson },
                        })),
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
      const waitCalls = [];
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: "conv-chat-native-error-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: errorTools(),
        },
        requestId: "req-chat-native-error-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(errorToolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, errorToolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.executionName || call.name, toolArguments: call.executionArgsJson || call.argsJson },
      })));
      assert.deepEqual(requests[1].messages.slice(-errorToolCalls.length), errorToolCalls.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: call.providerText,
      })));
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
              const events = [];
              for (const call of errorToolCalls) {
                events.push({ type: "response.output_item.added", item: { id: `fc-${call.id}`, type: "function_call", call_id: call.id, name: call.name } });
                events.push({ type: "response.function_call_arguments.done", item_id: `fc-${call.id}`, arguments: call.argsJson });
              }
              events.push({ type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } });
              return asyncIterable(events);
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
      const waitCalls = [];
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-responses-model" },
        request: {
          conversationId: "conv-responses-native-error-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: errorTools(),
        },
        requestId: "req-responses-native-error-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(errorToolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, errorToolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.executionName || call.name, toolArguments: call.executionArgsJson || call.argsJson },
      })));
      assert.deepEqual(requests[1].input.slice(-(errorToolCalls.length * 2)), errorToolCalls.flatMap((call) => [
        { type: "function_call", id: `fc-${call.id}`, call_id: call.id, name: call.name, arguments: call.argsJson },
        { type: "function_call_output", call_id: call.id, output: call.providerText },
      ]));
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
              const events = [];
              for (let index = 0; index < errorToolCalls.length; index++) {
                const call = errorToolCalls[index];
                events.push({
                  type: "content_block_start",
                  index,
                  content_block: { type: "tool_use", id: call.id, name: call.name, input: call.args },
                });
                events.push({ type: "content_block_stop", index });
              }
              const stream = asyncIterable(events);
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
      const waitCalls = [];
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-claude" },
        request: {
          conversationId: "conv-anthropic-native-error-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: errorTools(),
        },
        requestId: "req-anthropic-native-error-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(errorToolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, errorToolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.executionName || call.name, toolArguments: call.executionArgs || call.args },
      })));
      assert.deepEqual(requests[1].messages.at(-1), {
        role: "user",
        content: errorToolCalls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: call.providerText,
        })),
      });
    } finally {
      restore();
    }
  }
});
