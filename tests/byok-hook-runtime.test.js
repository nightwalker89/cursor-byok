"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
} = require("../src/workbench-hook");
const {
  BidiRawQueue,
  ByokSessionStore,
  ConversationPins,
  DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS,
  classifyBidiPayload,
  extractPayloadBytes,
  findExecToolCallId,
  findRequestId,
} = require("../src/runtime/state");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const { strictCursorMessageCtor, approvedSwitchModeInteractionResponse, answeredAskQuestionInteractionResponse } = require("./byok-fixtures");

test("hook runtime emits native Read tool start and exec messages with offset and limit", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "call-1",
    name: "Read",
    arguments: "{\"path\":\"/tmp/a\",\"offset\":12,\"limit\":4}",
  }, "step");
  const started = messages[0].message.value.message.value;
  const exec = messages[1].message.value;
  assert.equal(started.callId, "call-1");
  assert.equal(started.toolCall.tool.case, "readToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, { path: "/tmp/a", offset: 12, limit: 4 });
  assert.equal(exec.execId, "call-1");
  assert.equal(exec.message.case, "readArgs");
  assert.deepEqual(exec.message.value, { path: "/tmp/a", toolCallId: "call-1", offset: 12, limit: 4 });
});

test("hook runtime normalizes Read aliases before building Cursor tool-call state", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "call-1",
    name: "Read",
    arguments: "{\"filePath\":\"/tmp/a\",\"offset\":\"12\",\"limit\":\"4\"}",
  }, "step");

  const started = messages[0].message.value.message.value;
  const exec = messages[1].message.value;
  assert.deepEqual(started.toolCall.tool.value.args, { path: "/tmp/a", offset: 12, limit: 4 });
  assert.deepEqual(exec.message.value, { path: "/tmp/a", toolCallId: "call-1", offset: 12, limit: 4 });
});

test("hook runtime completes provider-local tool errors without native exec", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "bad-read",
    name: "Read",
    arguments: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}",
    localResult: {
      case: "unsupportedToolResult",
      value: {
        result: {
          case: "error",
          value: { error: "Invalid Read input" },
        },
      },
    },
  }, "step");

  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.value.message.case, "toolCallStarted");
  assert.equal(messages[1].message.value.message.case, "toolCallCompleted");
  assert.equal(messages[1].message.value.message.value.toolCall.tool.case, "readToolCall");
  assert.deepEqual(messages[1].message.value.message.value.toolCall.tool.value.result, {
    result: {
      case: "error",
      value: { error: "Invalid Read input" },
    },
  });
});

test("hook runtime completes provider-local exec results without native exec", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "local-read",
    name: "Read",
    arguments: "{\"path\":\"/tmp/a\",\"offset\":2,\"limit\":1}",
    localResult: {
      case: "byokExecResult",
      value: normalizeExecClientResult({
        execId: "local-read",
        readResult: {
          success: {
            path: "/tmp/a",
            content: "ok",
            rangeApplied: true,
          },
        },
      }),
    },
  }, "step");

  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.value.message.case, "toolCallStarted");
  assert.equal(messages[1].message.value.message.case, "toolCallCompleted");
  assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
  const uiReadSuccess = messages[1].message.value.message.value.toolCall.tool.value.result.result;
  assert.equal(uiReadSuccess.case, "success");
  assert.equal(uiReadSuccess.value.output.value, "ok");
  assert.equal(uiReadSuccess.value.rangeApplied, true);
});

test("hook runtime emits native Grep exec messages and preserves offset aliases", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "grep-1",
    name: "Grep",
    arguments: {
      pattern: "needle",
      path: "/tmp",
      output_mode: "content",
      "-B": "2",
      "-A": 3,
      head_limit: "10",
      offset: "20",
      "-i": true,
    },
  }, "step");
  const exec = messages[1].message.value;
  assert.equal(exec.message.case, "grepArgs");
  assert.deepEqual(exec.message.value, {
    pattern: "needle",
    path: "/tmp",
    outputMode: "content",
    contextBefore: 2,
    contextAfter: 3,
    headLimit: 10,
    offset: 20,
    caseInsensitive: true,
    toolCallId: "grep-1",
  });
});

test("hook runtime maps Glob to Cursor-native grepArgs files search", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "glob-1",
    name: "Glob",
    arguments: { glob_pattern: "*.js", target_directory: "/tmp/project" },
  }, "step");
  assert.equal(messages[0].message.value.message.value.toolCall.tool.case, "globToolCall");
  assert.equal(messages[1].message.case, "execServerMessage");
  assert.equal(messages[1].message.value.message.case, "grepArgs");
  assert.deepEqual(messages[1].message.value.message.value, {
    path: "/tmp/project",
    glob: "*.js",
    outputMode: "files_with_matches",
    toolCallId: "glob-1",
    pattern: "",
  });
});

test("hook runtime maps Delete and ReadLints to Cursor-native exec args", () => {
  const helpers = createHookRuntimeHelpersForTest();

  const del = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "delete-1",
    name: "Delete",
    arguments: { path: "/tmp/remove.txt" },
  }, "step");
  assert.equal(del[0].message.value.message.value.toolCall.tool.case, "deleteToolCall");
  assert.deepEqual(del[0].message.value.message.value.toolCall.tool.value.args, { path: "/tmp/remove.txt" });
  assert.equal(del[1].message.value.message.case, "deleteArgs");
  assert.deepEqual(del[1].message.value.message.value, {
    path: "/tmp/remove.txt",
    toolCallId: "delete-1",
  });

  const lints = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "lints-1",
    name: "ReadLints",
    arguments: { paths: ["/tmp/project/src/index.js"] },
  }, "step");
  assert.equal(lints[0].message.value.message.value.toolCall.tool.case, "readLintsToolCall");
  assert.deepEqual(lints[0].message.value.message.value.toolCall.tool.value.args, {
    paths: ["/tmp/project/src/index.js"],
  });
  assert.equal(lints[1].message.value.message.case, "diagnosticsArgs");
  assert.deepEqual(lints[1].message.value.message.value, {
    path: "/tmp/project/src/index.js",
    toolCallId: "lints-1",
  });

});

test("hook runtime maps ApplyPatch to Cursor-native edit envelope without direct writeArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const patch = [
    "*** Begin Patch",
    "*** Add File: /tmp/byok-applypatch.txt",
    "+alpha",
    "+beta",
    "*** End Patch",
    "",
  ].join("\n");
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "patch-1",
    name: "ApplyPatch",
    arguments: { patch },
  }, "step");

  const started = messages[0].message.value.message.value;
  const completed = messages[1].message.value.message.value;
  assert.equal(started.toolCall.tool.case, "editToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, { path: "/tmp/byok-applypatch.txt" });
  assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
  assert.deepEqual(completed.toolCall.tool.value.result, {
    result: {
      case: "error",
      value: { error: "Cursor BYOK cannot execute this tool through native exec." },
    },
  });
});

test("client interaction bridge builds web search query and formats references", () => {
  const {
    buildClientInteractionQuery,
    interactionApprovalGranted,
    providerTextFromClientCompletion,
  } = require("../src/runtime/client-tool-bridge");

  const query = buildClientInteractionQuery("WebSearch", "web-1", { search_term: "cursor byok" }, 3);
  assert.equal(query.query.case, "webSearchRequestQuery");
  assert.equal(query.query.value.args.searchTerm, "cursor byok");
  assert.equal(query.query.value.args.toolCallId, "web-1");

  const approved = {
    id: 3,
    result: {
      case: "webSearchRequestResponse",
      value: { result: { case: "approved", value: {} } },
    },
  };
  assert.equal(interactionApprovalGranted(approved), true);
  const text = providerTextFromClientCompletion("WebSearch", {
    case: "success",
    value: {
      references: [{ title: "Cursor", url: "https://cursor.com", chunk: "BYOK bridge" }],
    },
  });
  assert.match(text, /Cursor/);
  assert.match(text, /BYOK bridge/);
});

test("normalizeRunRequestForProvider skips disk MCP cache when Run already includes mcpTools", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-skip-"));
  const projectDir = path.join(tmpRoot, ".cursor", "projects", "Users-jun-c-liu-source-ccursor-analysis");
  fs.mkdirSync(path.join(projectDir, "mcps", "slow-server", "tools"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mcps", "slow-server", "tools", "slow_tool.json"), JSON.stringify({
    name: "mcp-slow-server-slow_tool",
    description: "slow",
    inputSchema: { type: "object", properties: {} },
  }));

  const request = {
    conversationId: "conv-cache-skip",
    mcpTools: [{
      mcpTools: [{
        name: "mcp-slow-server-slow_tool",
        description: "from run",
        inputSchema: { type: "object", properties: {} },
        providerIdentifier: "slow-server",
        toolName: "slow_tool",
        executionName: "mcp-slow-server-slow_tool",
      }],
    }],
  };
  const normalized = normalizeRunRequestForProvider(request, { home: tmpRoot, workspaceRoots: [tmpRoot] });
  assert.equal(normalized.tools.some((tool) => tool.name === "mcp-slow-server-slow_tool"), true);
});

test("session waitForInteractionResponse resolves Bidi interaction responses", async () => {
  const { ByokSessionStore } = require("../src/runtime/state");
  const store = new ByokSessionStore();
  const requestId = "11111111-1111-4111-8111-111111111111";
  const waitPromise = store.waitForInteractionResponse(requestId, 9, 2000);
  store.recordClientMessage(requestId, {
    message: {
      case: "interactionResponse",
      value: {
        id: 9,
        result: {
          case: "switchModeRequestResponse",
          value: { result: { case: "approved", value: {} } },
        },
      },
    },
  });
  const result = await waitPromise;
  assert.equal(result.id, 9);
  assert.equal(result.result.case, "switchModeRequestResponse");
});

test("hook runtime normalizes Cursor JSON oneof interaction responses", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const switchMessage = helpers.extractAgentClientMessage({
    interactionResponse: {
      id: 100000,
      switchModeRequestResponse: {
        result: {
          approved: {},
        },
      },
    },
  });
  assert.deepEqual(switchMessage, {
    case: "interactionResponse",
    value: approvedSwitchModeInteractionResponse(100000),
  });

  const askMessage = helpers.extractAgentClientMessage({
    message: {
      case: "interactionResponse",
      value: {
        id: 100001,
        askQuestionInteractionResponse: {
          result: {
            success: {
              answers: [{
                questionId: "fixture",
                selectedOptionIds: ["tmp"],
                freeformText: "",
              }],
            },
          },
        },
      },
    },
  });
  assert.deepEqual(askMessage, {
    case: "interactionResponse",
    value: answeredAskQuestionInteractionResponse(100001),
  });

  const askResultOneofMessage = helpers.extractAgentClientMessage({
    message: {
      case: "interactionResponse",
      value: {
        id: 100002,
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              success: {
                answers: [{
                  questionId: "fixture",
                  selectedOptionIds: ["tmp"],
                  freeformText: "",
                }],
              },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(askResultOneofMessage, {
    case: "interactionResponse",
    value: answeredAskQuestionInteractionResponse(100002),
  });

  const switchResultOneofMessage = helpers.extractAgentClientMessage({
    message: {
      case: "interactionResponse",
      value: {
        id: 100003,
        result: {
          case: "switchModeRequestResponse",
          value: {
            result: { approved: {} },
          },
        },
      },
    },
  });
  assert.deepEqual(switchResultOneofMessage, {
    case: "interactionResponse",
    value: approvedSwitchModeInteractionResponse(100003),
  });

  const askProtoPayloadMessage = helpers.extractAgentClientMessage({
    message: {
      case: "interactionResponse",
      value: {
        id: 100004,
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            toJson() {
              return {
                result: {
                  success: {
                    answers: [{
                      questionId: "fixture",
                      selectedOptionIds: ["tmp"],
                      freeformText: "",
                    }],
                  },
                },
              };
            },
          },
        },
      },
    },
  });
  assert.deepEqual(askProtoPayloadMessage, {
    case: "interactionResponse",
    value: answeredAskQuestionInteractionResponse(100004),
  });
});

test("hook runtime maps interaction tools to native Cursor tool call types", () => {
  const helpers = createHookRuntimeHelpersForTest();
  for (const tool of [
    {
      name: "AskQuestion",
      args: {
        title: "Confirm",
        questions: [{
          id: "confirm",
          prompt: "Proceed?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        }],
      },
      cursorType: "askQuestionToolCall",
      startedArgs: {
        title: "Confirm",
        questions: [{
          id: "confirm",
          prompt: "Proceed?",
          allowMultiple: false,
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        }],
      },
    },
    {
      name: "SwitchMode",
      args: { target_mode_id: "agent", explanation: "Need agent mode" },
      cursorType: "switchModeToolCall",
      startedArgs: { targetModeId: "agent", explanation: "Need agent mode" },
    },
    {
      name: "CreatePlan",
      args: {
        name: "fix",
        overview: "overview",
        plan: "plan",
        todos: [{ id: "t1", content: "do it", status: "pending", dependencies: [] }],
        phases: [{ name: "phase", todos: [{ id: "p1", content: "phase task", status: "in_progress", dependencies: ["t1"] }] }],
      },
      cursorType: "createPlanToolCall",
      startedArgs: {
        name: "fix",
        overview: "overview",
        plan: "plan",
        todos: [{ id: "t1", content: "do it", status: 1, dependencies: [] }],
        isProject: false,
        phases: [{ name: "phase", todos: [{ id: "p1", content: "phase task", status: 2, dependencies: ["t1"] }] }],
      },
    },
  ]) {
    const started = helpers.toolCallStarted({
      type: "tool_use_done",
      id: `${tool.name}-1`,
      name: tool.name,
      arguments: tool.args,
    }, "step");
    assert.equal(started.message.value.message.value.toolCall.tool.case, tool.cursorType, tool.name);
    assert.deepEqual(started.message.value.message.value.toolCall.tool.value.args, tool.startedArgs);
  }
});

test("hook runtime terminates exposed unsupported tools with explicit local errors", () => {
  const helpers = createHookRuntimeHelpersForTest();
  for (const tool of [
    {
      name: "WebSearch",
      args: { search_term: "cursor byok" },
      cursorType: "webSearchToolCall",
      startedArgs: { search_term: "cursor byok" },
    },
    {
      name: "GenerateImage",
      args: { description: "a red circle" },
      cursorType: "generateImageToolCall",
      startedArgs: { description: "a red circle" },
    },
    {
      name: "Task",
      args: {
        prompt: "inspect implementation",
        subagent_type: "explore",
        model: "claude-sonnet-4",
        readonly: true,
        run_in_background: false,
        resume: "agent-1",
      },
      cursorType: "custom",
      startedArgs: undefined,
    },
    {
      name: "Subagent",
      args: { prompt: "inspect implementation" },
      cursorType: "custom",
      startedArgs: undefined,
    },
    {
      name: "RecordScreen",
      args: { duration_ms: 1000 },
      cursorType: "custom",
      startedArgs: { duration_ms: 1000 },
    },
    {
      name: "ComputerUse",
      args: { action: "screenshot" },
      cursorType: "custom",
      startedArgs: { action: "screenshot" },
    },
  ]) {
    const messages = helpers.eventToCursorMessages({
      type: "tool_use_done",
      id: `${tool.name}-1`,
      name: tool.name,
      arguments: tool.args,
    }, "step");
    assert.equal(messages[0].message.value.message.value.toolCall.tool.case, tool.cursorType, tool.name);
    if (tool.startedArgs === undefined) {
      assert.equal(messages[0].message.value.message.value.toolCall.tool.value.args, undefined);
    } else {
      assert.deepEqual(messages[0].message.value.message.value.toolCall.tool.value.args, tool.startedArgs);
    }
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false, tool.name);
    const completed = messages.find((message) => message.message?.value?.message?.case === "toolCallCompleted");
    assert.deepEqual(completed.message.value.message.value.toolCall.tool.value.result, {
      result: {
        case: "error",
        value: { error: "Cursor BYOK cannot execute this tool through native exec." },
      },
    });
  }
});

test("hook runtime maps Write to Cursor-native edit envelope and write args", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "write-1",
    name: "Write",
    arguments: { path: "/tmp/byok-write.txt", contents: "hello" },
  }, "step");

  const started = messages[0].message.value.message.value;
  const exec = messages[1].message.value;
  assert.equal(started.toolCall.tool.case, "editToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, { path: "/tmp/byok-write.txt" });
  assert.equal(exec.message.case, "writeArgs");
  assert.deepEqual(exec.message.value, {
    path: "/tmp/byok-write.txt",
    fileText: "hello",
    encodingHint: "utf8",
    toolCallId: "write-1",
  });
});

test("hook runtime maps provider Write filePath/content aliases without empty fileText", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "write-1",
    name: "Write",
    arguments: {
      filePath: "/tmp/byok-write.txt",
      content: "module.exports = { ok: true };\n",
    },
  }, "step");

  const started = messages[0].message.value.message.value;
  const exec = messages[1].message.value;
  assert.deepEqual(started.toolCall.tool.value.args, { path: "/tmp/byok-write.txt" });
  assert.deepEqual(exec.message.value, {
    path: "/tmp/byok-write.txt",
    fileText: "module.exports = { ok: true };\n",
    encodingHint: "utf8",
    toolCallId: "write-1",
  });
});

test("hook runtime never puts UI-only edit fields into native writeArgs", () => {
  const helpers = createHookRuntimeHelpersForTest(strictCursorMessageCtor());
  const write = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "write-1",
    name: "Write",
    arguments: { path: "/tmp/byok-write.txt", contents: "hello" },
  }, "step");
  assert.equal(write[1].message.value.message.case, "writeArgs");

  const patch = [
    "*** Begin Patch",
    "*** Add File: /tmp/byok-applypatch.txt",
    "+alpha",
    "*** End Patch",
    "",
  ].join("\n");
  assert.doesNotThrow(() => helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "patch-1",
    name: "ApplyPatch",
    arguments: { patch },
  }, "step"));
});

test("hook runtime maps EditNotebook to Cursor-native edit envelope without direct writeArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "notebook-1",
    name: "EditNotebook",
    arguments: {
      target_notebook: "/tmp/byok.ipynb",
      cell_idx: "2",
      new_string: "print(2)",
      old_string: "print(1)",
      is_new_cell: false,
      cell_language: "python",
    },
  }, "step");

  const started = messages[0].message.value.message.value;
  const completed = messages[1].message.value.message.value;
  assert.equal(started.toolCall.tool.case, "editToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, {
    path: "/tmp/byok.ipynb",
    streamContent: "print(2)",
  });
  assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
  assert.deepEqual(completed.toolCall.tool.value.result, {
    result: {
      case: "error",
      value: { error: "Cursor BYOK cannot execute this tool through native exec." },
    },
  });
});

test("hook runtime maps GenerateImage to Cursor-native image envelope without inventing image exec args", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "image-1",
    name: "GenerateImage",
    arguments: {
      description: "red square",
      filename: "/tmp/byok-image.png",
      reference_image_paths: ["/tmp/ref.png"],
    },
  }, "step");

  const started = messages[0].message.value.message.value;
  const completed = messages[1].message.value.message.value;
  assert.equal(started.toolCall.tool.case, "generateImageToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, {
    description: "red square",
    filePath: "/tmp/byok-image.png",
    referenceImagePaths: ["/tmp/ref.png"],
  });
  assert.deepEqual(completed.toolCall.tool.value.result, {
    result: {
      case: "error",
      value: { error: "Cursor BYOK cannot execute this tool through native exec." },
    },
  });
});

test("hook runtime maps MCP helpers to Cursor-native envelopes and exec args", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const list = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "mcp-list-1",
    name: "ListMcpResources",
    arguments: { server: "filesystem" },
  }, "step");
  assert.equal(list[0].message.value.message.value.toolCall.tool.case, "listMcpResourcesToolCall");
  assert.deepEqual(list[0].message.value.message.value.toolCall.tool.value.args, { server: "filesystem" });
  assert.equal(list[1].message.value.message.case, "listMcpResourcesExecArgs");
  assert.deepEqual(list[1].message.value.message.value, {
    server: "filesystem",
    toolCallId: "mcp-list-1",
  });

  const read = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "mcp-read-1",
    name: "FetchMcpResource",
    arguments: { server: "filesystem", uri: "file:///tmp/a", downloadPath: "/tmp/a" },
  }, "step");
  assert.equal(read[0].message.value.message.value.toolCall.tool.case, "readMcpResourceToolCall");
  assert.deepEqual(read[0].message.value.message.value.toolCall.tool.value.args, {
    server: "filesystem",
    uri: "file:///tmp/a",
    downloadPath: "/tmp/a",
  });
  assert.equal(read[1].message.value.message.case, "readMcpResourceExecArgs");
  assert.deepEqual(read[1].message.value.message.value, {
    server: "filesystem",
    uri: "file:///tmp/a",
    downloadPath: "/tmp/a",
    toolCallId: "mcp-read-1",
  });

  const call = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "mcp-call-1",
    name: "CallMcpTool",
    arguments: {
      name: "filesystem.read_file",
      args: { path: "/tmp/a" },
      providerIdentifier: "filesystem",
      toolName: "read_file",
    },
  }, "step");
  assert.equal(call[0].message.value.message.value.toolCall.tool.case, "mcpToolCall");
  assert.deepEqual(call[0].message.value.message.value.toolCall.tool.value.args, {
    name: "filesystem.read_file",
    toolCallId: "mcp-call-1",
    args: { path: { kind: { case: "stringValue", value: "/tmp/a" } } },
    providerIdentifier: "filesystem",
    toolName: "read_file",
  });
  assert.equal(call[1].message.value.message.case, "mcpArgs");
  assert.deepEqual(call[1].message.value.message.value, {
    name: "filesystem.read_file",
    args: { path: { kind: { case: "stringValue", value: "/tmp/a" } } },
    providerIdentifier: "filesystem",
    toolName: "read_file",
    toolCallId: "mcp-call-1",
  });
});

test("hook runtime maps MCP auth to Cursor-native interaction query without exec args", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "auth-1",
    name: "mcp_auth",
    arguments: { server_identifier: "plugin-atlassian-atlassian" },
  }, "step", 77);

  assert.equal(messages.length, 2);
  const started = messages[0].message.value.message.value;
  assert.equal(started.toolCall.tool.case, "mcpAuthToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, {
    serverIdentifier: "plugin-atlassian-atlassian",
    toolCallId: "auth-1",
  });
  assert.equal(messages[1].message.case, "interactionQuery");
  assert.deepEqual(messages[1].message.value, {
    id: 77,
    query: {
      case: "mcpAuthRequestQuery",
      value: {
        args: {
          serverIdentifier: "plugin-atlassian-atlassian",
          toolCallId: "auth-1",
        },
      },
    },
  });
  assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
});

test("hook runtime returns local AwaitShell error without readArgs bridge when ids are missing", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "await-1",
    name: "AwaitShell",
    arguments: { block_until_ms: 1 },
  }, "step");
  assert.equal(messages[0].message.value.message.value.toolCall.tool.case, "awaitToolCall");
  assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
  assert.equal(messages.some((message) => message.message?.value?.message?.case === "toolCallCompleted"), true);
  assert.deepEqual(
    messages.find((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .message.value.message.value.toolCall.tool.value.result,
    {
      result: {
        case: "error",
        value: {
          error: "AwaitShell requires shell_id or task_id from a previous background shell or subagent result.",
        },
      },
    },
  );
});

test("hook runtime maps LS to Cursor-native lsArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "ls-1",
    name: "LS",
    arguments: { path: "/tmp", ignore_globs: ["**/node_modules/**"] },
  }, "step");
  const started = messages[0].message.value.message.value;
  const exec = messages[1].message.value;
  assert.equal(started.toolCall.tool.case, "lsToolCall");
  assert.deepEqual(started.toolCall.tool.value.args, {
    path: "/tmp",
    ignore: ["**/node_modules/**"],
  });
  assert.equal(exec.execId, "ls-1");
  assert.equal(exec.message.case, "lsArgs");
  assert.deepEqual(exec.message.value, {
    path: "/tmp",
    toolCallId: "ls-1",
    ignore: ["**/node_modules/**"],
  });
});

test("hook runtime routes WebSearch through client interaction bridge instead of native exec", () => {
  const helpers = createHookRuntimeHelpersForTest();
  assert.equal(helpers.normalizeToolArgs("WebSearch", { search_term: "cursor byok" }, "web-1"), null);
  const { isClientInteractionTool, buildClientInteractionQuery } = require("../src/runtime/client-tool-bridge");
  assert.equal(isClientInteractionTool("WebSearch"), true);
  const query = buildClientInteractionQuery("WebSearch", "web-1", { search_term: "cursor byok" }, 42);
  assert.equal(query.query.case, "webSearchRequestQuery");
  assert.deepEqual(query.query.value.args, {
    searchTerm: "cursor byok",
    toolCallId: "web-1",
  });
});

test("hook runtime routes WebFetch through client interaction bridge instead of fetchArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  assert.equal(helpers.normalizeToolArgs("WebFetch", { url: "https://example.com" }, "fetch-1"), null);
  const { isClientInteractionTool, buildClientInteractionQuery } = require("../src/runtime/client-tool-bridge");
  assert.equal(isClientInteractionTool("WebFetch"), true);
  const query = buildClientInteractionQuery("WebFetch", "fetch-1", { url: "https://example.com" }, 42);
  assert.equal(query.query.case, "webFetchRequestQuery");
  assert.deepEqual(query.query.value.args, {
    url: "https://example.com",
    toolCallId: "fetch-1",
  });
});

test("hook runtime maps WriteShellStdin to Cursor-native writeShellStdinArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "stdin-1",
    name: "WriteShellStdin",
    arguments: { shell_id: "42", chars: "y\n" },
  }, "step");
  const exec = messages[1].message.value;
  assert.equal(exec.execId, "stdin-1");
  assert.equal(exec.message.case, "writeShellStdinArgs");
  assert.deepEqual(exec.message.value, {
    shellId: 42,
    chars: "y\n",
  });
});

test("hook runtime maps AwaitShell with shell_id to Cursor-native subagentAwaitArgs", () => {
  const helpers = createHookRuntimeHelpersForTest();
  const messages = helpers.eventToCursorMessages({
    type: "tool_use_done",
    id: "await-bg-1",
    name: "AwaitShell",
    arguments: { shell_id: "shell-9", block_until_ms: 1500, pattern: "unused" },
  }, "step");
  assert.deepEqual(messages[0].message.value.message.value.toolCall.tool.value.args, {
    taskId: "shell-9",
    blockUntilMs: 1500,
  });
  const exec = messages[1].message.value;
  assert.equal(messages.some((message) => message.message?.case === "toolCallCompleted"), false);
  assert.equal(exec.execId, "await-bg-1");
  assert.equal(exec.message.case, "subagentAwaitArgs");
  assert.deepEqual(exec.message.value, {
    agentId: "shell-9",
    timeoutMs: 1500,
  });
});
