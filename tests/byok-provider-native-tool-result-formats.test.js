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

const toolCalls = [
  {
    id: "shell-1",
    name: "Shell",
    argsJson: "{\"command\":\"pwd\",\"working_directory\":\"/tmp/project\"}",
    args: { command: "pwd", working_directory: "/tmp/project" },
    result: {
      id: 0,
      execId: "shell-1",
      shellResult: {
        success: {
          command: "pwd",
          workingDirectory: "/tmp/project",
          stdout: "/tmp/project\n",
          stderr: "",
          exitCode: 0,
        },
      },
    },
    providerText: "Exit code: 0\n\nCommand output:\n\n```\n/tmp/project\n\n```\n\nCommand completed.\n\nShell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project",
  },
  {
    id: "ls-1",
    name: "LS",
    argsJson: "{\"path\":\"/tmp/project\"}",
    args: { path: "/tmp/project" },
    result: {
      id: 1,
      execId: "ls-1",
      lsResult: {
        result: {
          case: "success",
          value: {
            directoryTreeRoot: {
              absPath: "/tmp/project",
              childrenWereProcessed: true,
              childrenFiles: [{ name: "package.json" }],
              childrenDirs: [
                {
                  absPath: "/tmp/project/src",
                  childrenWereProcessed: true,
                  childrenFiles: [{ name: "app.js" }],
                  childrenDirs: [],
                },
              ],
            },
          },
        },
      },
    },
    providerText: "/tmp/project/\n  - package.json\n  - src/\n    - app.js",
  },
  {
    id: "glob-1",
    name: "Glob",
    argsJson: "{\"glob_pattern\":\"*.js\",\"target_directory\":\"/tmp/project\"}",
    args: { glob_pattern: "*.js", target_directory: "/tmp/project" },
    result: {
      id: 2,
      execId: "glob-1",
      grepResult: {
        success: {
          pattern: "",
          path: "/tmp/project",
          outputMode: "files_with_matches",
          workspaceResults: {
            "/tmp/project": {
              result: {
                case: "files",
                value: { files: ["src/app.js"], totalFiles: 1 },
              },
            },
          },
        },
      },
    },
    providerText: "Result of search in '/tmp/project' (total 1 file):\n- src/app.js",
  },
  {
    id: "grep-1",
    name: "Grep",
    argsJson: "{\"pattern\":\"alpha\",\"path\":\"/tmp/project\",\"output_mode\":\"content\"}",
    args: { pattern: "alpha", path: "/tmp/project", output_mode: "content" },
    result: {
      id: 3,
      execId: "grep-1",
      grepResult: {
        success: {
          pattern: "alpha",
          outputMode: "content",
          workspaceResults: {
            "/tmp/project": {
              result: {
                case: "content",
                value: {
                  matches: [{
                    file: "src/app.js",
                    matches: [{ lineNumber: 12, content: "const alpha = 1;" }],
                  }],
                },
              },
            },
          },
        },
      },
    },
    providerText: "[/tmp/project] src/app.js:12 const alpha = 1;",
  },
  {
    id: "await-1",
    name: "AwaitShell",
    argsJson: "{\"shell_id\":\"shell-42\",\"block_until_ms\":1500}",
    args: { shell_id: "shell-42", block_until_ms: 1500 },
    result: {
      id: 4,
      execId: "await-1",
      subagentAwaitResult: {
        success: {
          complete: {
            taskId: "shell-42",
            runtimeMs: 1200,
            exitCode: 0,
            outputFilePath: "/tmp/shell.out",
            outputLength: 31,
          },
        },
      },
    },
    providerText: "Task completed in 1200ms with exit code: 0.\noutput_file_path: /tmp/shell.out\noutput_length: 31",
  },
  {
    id: "read-1",
    name: "Read",
    argsJson: "{\"path\":\"/tmp/project/main.txt\",\"offset\":12,\"limit\":2}",
    args: { path: "/tmp/project/main.txt", offset: 12, limit: 2 },
    result: {
      id: 5,
      execId: "read-1",
      readResult: {
        success: {
          path: "/tmp/project/main.txt",
          output: { case: "content", value: "alpha\nbeta" },
          totalLines: 20,
          readRange: { startLine: 12, endLine: 13 },
        },
      },
    },
    providerText: "File: /tmp/project/main.txt\nLines: 12-13\n    12|alpha\n    13|beta",
  },
  {
    id: "readfile-1",
    name: "ReadFile",
    argsJson: "{\"path\":\"/tmp/project/legacy.txt\",\"offset\":2,\"limit\":1}",
    args: { path: "/tmp/project/legacy.txt", offset: 2, limit: 1 },
    result: {
      id: 5,
      execId: "readfile-1",
      readResult: {
        success: {
          path: "/tmp/project/legacy.txt",
          output: { case: "content", value: "beta" },
          totalLines: 3,
          readRange: { startLine: 2, endLine: 2 },
        },
      },
    },
    providerText: "File: /tmp/project/legacy.txt\nLines: 2-2\n     2|beta",
  },
  {
    id: "lints-1",
    name: "ReadLints",
    argsJson: "{\"paths\":[\"/tmp/project/src/app.js\"]}",
    args: { paths: ["/tmp/project/src/app.js"] },
    result: {
      id: 6,
      execId: "lints-1",
      diagnosticsResult: {
        result: {
          case: "success",
          value: {
            fileDiagnostics: [{
              path: "/tmp/project/src/app.js",
              diagnosticsCount: 1,
              diagnostics: [{
                severity: "ERROR",
                message: "Missing semicolon",
                source: "eslint",
                range: { start: { line: 3, column: 7 }, end: { line: 3, column: 8 } },
              }],
            }],
            totalFiles: 1,
            totalDiagnostics: 1,
          },
        },
      },
    },
    providerText: "Found 1 linter error in 1 file:\n/tmp/project/src/app.js (1 error):\n  [ERROR] L3:7 - Missing semicolon (eslint)",
  },
  {
    id: "fetch-1",
    name: "WebFetch",
    argsJson: "{\"url\":\"https://example.com\"}",
    args: { url: "https://example.com" },
    result: {
      id: 7,
      execId: "fetch-1",
      fetchResult: { result: { case: "success", value: { url: "https://example.com", markdown: "# Example" } } },
    },
    providerText: "# Content from https://example.com\n\n# Example",
  },
  {
    id: "stdin-1",
    name: "WriteShellStdin",
    argsJson: "{\"shell_id\":\"shell-42\",\"chars\":\"y\\n\"}",
    args: { shell_id: "shell-42", chars: "y\n" },
    result: {
      id: 8,
      execId: "stdin-1",
      writeShellStdinResult: { result: { case: "success", value: { shellId: "shell-42" } } },
    },
    providerText: "Successfully wrote to shell shell-42 stdin.",
  },
  {
    id: "todo-1",
    name: "TodoWrite",
    argsJson: "{\"todos\":[{\"id\":\"t1\",\"content\":\"Ship parity\",\"status\":\"completed\"}]}",
    args: { todos: [{ id: "t1", content: "Ship parity", status: "completed" }] },
    result: {
      id: 9,
      execId: "todo-1",
      todoWriteResult: {
        success: { todos: [{ id: "t1", content: "Ship parity", status: "completed" }], merge: false },
      },
    },
    providerText: "Todo list updated (1 item):\n- [completed] Ship parity",
  },
  {
    id: "task-create-1",
    name: "TaskCreate",
    argsJson: "{\"description\":\"inspect fixture\"}",
    args: { description: "inspect fixture" },
    result: {
      id: 10,
      execId: "task-create-1",
      todoWriteResult: {
        success: { todos: [{ id: "task-create-1", content: "inspect fixture", status: "in_progress" }], merge: true },
      },
    },
    providerText: "Todo list updated (1 item):\n- [in_progress] inspect fixture",
  },
  {
    id: "task-update-1",
    name: "TaskUpdate",
    argsJson: "{\"taskId\":\"task-create-1\",\"status\":\"completed\"}",
    args: { taskId: "task-create-1", status: "completed" },
    result: {
      id: 11,
      execId: "task-update-1",
      todoWriteResult: {
        success: { todos: [{ id: "task-create-1", content: "inspect fixture", status: "completed" }], merge: true },
      },
    },
    providerText: "Todo list updated (1 item):\n- [completed] inspect fixture",
  },
  {
    id: "task-list-1",
    name: "TaskList",
    argsJson: "{}",
    args: {},
    result: {
      id: 12,
      execId: "task-list-1",
      todoWriteResult: {
        success: { todos: [{ id: "task-create-1", content: "inspect fixture", status: "completed" }], merge: true },
      },
    },
    providerText: "Todo list updated (1 item):\n- [completed] inspect fixture",
  },
  {
    id: "task-get-1",
    name: "TaskGet",
    argsJson: "{\"id\":\"task-create-1\"}",
    args: { id: "task-create-1" },
    result: {
      id: 13,
      execId: "task-get-1",
      todoWriteResult: {
        success: { todos: [{ id: "task-create-1", content: "inspect fixture", status: "completed" }], merge: true },
      },
    },
    providerText: "Todo list updated (1 item):\n- [completed] inspect fixture",
  },
  {
    id: "write-1",
    name: "Write",
    argsJson: "{\"path\":\"/tmp/a.txt\",\"contents\":\"new\\n\"}",
    args: { path: "/tmp/a.txt", contents: "new\n" },
    result: {
      id: 14,
      execId: "write-1",
      writeResult: { success: { path: "/tmp/a.txt" } },
    },
    providerText: "Wrote contents to /tmp/a.txt",
  },
  {
    id: "delete-1",
    name: "Delete",
    argsJson: "{\"path\":\"/tmp/a.txt\"}",
    args: { path: "/tmp/a.txt" },
    result: {
      id: 15,
      execId: "delete-1",
      deleteResult: { success: { path: "/tmp/a.txt" } },
    },
    providerText: "Successfully deleted file: /tmp/a.txt",
  },
  {
    id: "edit-1",
    name: "Edit",
    argsJson: "{\"path\":\"/tmp/a.txt\",\"old_string\":\"old\",\"new_string\":\"new\"}",
    args: { path: "/tmp/a.txt", old_string: "old", new_string: "new" },
    result: {
      id: 16,
      execId: "edit-1",
      editResult: {
        success: { path: "/tmp/a.txt", message: "The file /tmp/a.txt has been updated." },
      },
    },
    providerText: "The file /tmp/a.txt has been updated.",
  },
  {
    id: "patch-1",
    name: "ApplyPatch",
    argsJson: "{\"patch\":\"*** Begin Patch\\n*** Update File: /tmp/a.txt\\n@@\\n-old\\n+new\\n*** End Patch\\n\"}",
    args: { patch: "*** Begin Patch\n*** Update File: /tmp/a.txt\n@@\n-old\n+new\n*** End Patch\n" },
    result: {
      id: 17,
      execId: "patch-1",
      editResult: { success: { path: "/tmp/a.txt", message: "Patch applied successfully." } },
    },
    providerText: "Patch applied successfully.",
  },
  {
    id: "notebook-1",
    name: "EditNotebook",
    argsJson: "{\"target_notebook\":\"/tmp/byok.ipynb\",\"cell_idx\":2,\"new_string\":\"print(2)\",\"old_string\":\"print(1)\"}",
    args: { target_notebook: "/tmp/byok.ipynb", cell_idx: 2, new_string: "print(2)", old_string: "print(1)" },
    result: {
      id: 18,
      execId: "notebook-1",
      editResult: { success: { path: "/tmp/byok.ipynb", message: "Notebook cell updated." } },
    },
    providerText: "Notebook cell updated.",
  },
  {
    id: "mcp-list-1",
    name: "ListMcpResources",
    argsJson: "{\"server\":\"docs\"}",
    args: { server: "docs" },
    result: {
      id: 19,
      execId: "mcp-list-1",
      listMcpResourcesExecResult: {
        success: { resources: [{ server: "docs", uri: "doc://alpha", name: "Alpha" }] },
      },
    },
    providerText: "docs doc://alpha - Alpha",
  },
  {
    id: "mcp-read-1",
    name: "FetchMcpResource",
    argsJson: "{\"server\":\"docs\",\"uri\":\"doc://alpha\"}",
    args: { server: "docs", uri: "doc://alpha" },
    result: {
      id: 20,
      execId: "mcp-read-1",
      readMcpResourceExecResult: {
        success: { uri: "doc://alpha", content: { case: "text", value: "alpha body" } },
      },
    },
    providerText: "alpha body",
  },
  {
    id: "mcp-call-1",
    name: "CallMcpTool",
    argsJson: "{\"name\":\"docs.search\",\"args\":{\"query\":\"alpha\"},\"providerIdentifier\":\"docs\",\"toolName\":\"search\"}",
    args: { name: "docs.search", args: { query: "alpha" }, providerIdentifier: "docs", toolName: "search" },
    result: {
      id: 21,
      execId: "mcp-call-1",
      mcpResult: {
        success: {
          content: [{ content: { case: "text", value: { text: "first block" } } }],
        },
      },
    },
    providerText: "first block",
  },
];

function nativeTools() {
  return [
    {
      name: "Shell",
      description: "Shell",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, working_directory: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "LS",
      description: "List",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
      name: "Grep",
      description: "Grep",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, output_mode: { type: "string" } },
        required: ["pattern"],
      },
    },
    {
      name: "AwaitShell",
      description: "Await",
      inputSchema: {
        type: "object",
        properties: { shell_id: { type: "string" }, block_until_ms: { type: "integer" } },
        required: ["shell_id"],
      },
    },
    {
      name: "Read",
      description: "Read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
    {
      name: "ReadFile",
      description: "Legacy read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
    {
      name: "ReadLints",
      description: "Lints",
      inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
    },
    {
      name: "WebFetch",
      description: "Fetch",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "WriteShellStdin",
      description: "Stdin",
      inputSchema: {
        type: "object",
        properties: { shell_id: { type: "string" }, chars: { type: "string" } },
        required: ["shell_id", "chars"],
      },
    },
    {
      name: "TodoWrite",
      description: "Todo",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, content: { type: "string" }, status: { type: "string" } },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    {
      name: "TaskCreate",
      description: "Create task",
      inputSchema: {
        type: "object",
        properties: { description: { type: "string" }, subject: { type: "string" } },
      },
    },
    {
      name: "TaskUpdate",
      description: "Update task",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" }, status: { type: "string" } },
      },
    },
    {
      name: "TaskList",
      description: "List tasks",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "TaskGet",
      description: "Get task",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    },
    {
      name: "Write",
      description: "Write",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, contents: { type: "string" } },
        required: ["path", "contents"],
      },
    },
    {
      name: "Delete",
      description: "Delete",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
      name: "Edit",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "ApplyPatch",
      description: "Patch",
      inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
    },
    {
      name: "EditNotebook",
      description: "Notebook",
      inputSchema: {
        type: "object",
        properties: {
          target_notebook: { type: "string" },
          cell_idx: { type: "integer" },
          new_string: { type: "string" },
          old_string: { type: "string" },
        },
        required: ["target_notebook", "cell_idx", "new_string"],
      },
    },
    {
      name: "ListMcpResources",
      description: "List MCP",
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
    },
    {
      name: "FetchMcpResource",
      description: "Fetch MCP",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
    },
    {
      name: "CallMcpTool",
      description: "Call MCP",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: { type: "object" },
          providerIdentifier: { type: "string" },
          toolName: { type: "string" },
        },
        required: ["name", "args", "providerIdentifier", "toolName"],
      },
    },
  ];
}

test("provider loops native Cursor tool results back in native API formats", async () => {
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
                        tool_calls: toolCalls.map((call, index) => ({
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
          conversationId: "conv-chat-native-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: nativeTools(),
        },
        requestId: "req-chat-native-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(toolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, toolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.name, toolArguments: call.argsJson },
      })));
      assert.deepEqual(requests[1].messages.slice(-toolCalls.length), toolCalls.map((call) => ({
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
              for (const call of toolCalls) {
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
          conversationId: "conv-responses-native-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: nativeTools(),
        },
        requestId: "req-responses-native-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(toolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, toolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.name, toolArguments: call.argsJson },
      })));
      assert.deepEqual(requests[1].input.slice(-(toolCalls.length * 2)), toolCalls.flatMap((call) => [
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
              for (let index = 0; index < toolCalls.length; index++) {
                const call = toolCalls[index];
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
          conversationId: "conv-anthropic-native-result-formats",
          systemPrompt: "system",
          messages: [{ role: "user", content: "run native tools" }],
          tools: nativeTools(),
        },
        requestId: "req-anthropic-native-result-formats",
        waitForToolResult: async (toolCallId, options) => {
          waitCalls.push({ toolCallId, options });
          return normalizeExecClientResult(toolCalls.find((call) => call.id === toolCallId).result);
        },
      })) {
        // drain
      }

      assert.deepEqual(waitCalls, toolCalls.map((call) => ({
        toolCallId: call.id,
        options: { toolName: call.name, toolArguments: call.args },
      })));
      assert.deepEqual(requests[1].messages.at(-1), {
        role: "user",
        content: toolCalls.map((call) => ({
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
