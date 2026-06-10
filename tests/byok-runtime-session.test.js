"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
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
const { decodeAgentClientMessage } = require("../src/runtime/cursor-protocol");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const { protoMessage, fieldMessage, fieldString, fieldVarint, approvedMcpAuthInteractionResponse, webSearchCompletionEnvelope, rejectedMcpAuthInteractionResponse, quietLog, recordingLog, tick } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("session store wakes provider loop when Cursor exec result arrives", async () => {
  const store = new ByokSessionStore();
  const requestId = "55555555-5555-4555-8555-555555555555";
  const wait = store.waitForExecResult(requestId, "call-1", 1000);
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "call-1",
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: { output: { case: "content", value: "ok" } },
            },
          },
        },
      },
    },
  });
  const result = await wait;
  assert.equal(findExecToolCallId(result), "call-1");
  assert.equal(result.message.case, "readResult");
});

test("session store accepts direct exec results and replays them to later waiters", async () => {
  const store = new ByokSessionStore();
  const requestId = "55555555-5555-4555-8555-555555555556";
  const wait = store.waitForExecResult(requestId, "direct-read-1", 1000);
  const directResult = {
    execId: "direct-read-1",
    _byokDirectTool: true,
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/direct.txt",
            output: { case: "content", value: "direct" },
          },
        },
      },
    },
  };

  assert.equal(store.storeExecResult(requestId, "direct-read-1", directResult), directResult);
  assert.equal((await wait).message.value.result.value.output.value, "direct");

  const replayed = await store.waitForExecResult(requestId, "direct-read-1", 1000);
  assert.equal(replayed._byokDirectTool, true);
  assert.equal(findExecToolCallId(replayed), "direct-read-1");
  assert.equal(replayed.message.value.result.value.output.value, "direct");
  assert.equal(store.storeExecResult("", "direct-read-2", directResult), null);
  assert.equal(store.storeExecResult(requestId, "", directResult), null);
  assert.equal(store.storeExecResult(requestId, "direct-read-2", null), null);
});

test("session store bounds retained records while preserving recent client tool completions", async () => {
  const log = recordingLog();
  const store = new ByokSessionStore({ maxRecords: 2, maxCompletedResults: 2, log });
  const requestId = "57575757-5757-4575-8575-575757575757";

  for (const toolCallId of ["web-old", "web-mid", "web-new"]) {
    store.recordClientMessage(requestId, {
      message: { case: "toolCallCompleted", value: { message: { value: webSearchCompletionEnvelope(toolCallId) } } },
    });
  }

  const session = store.get(requestId);
  assert.equal(session.records.length, 2);
  assert.deepEqual(log.entries.find((entry) => entry.message === "BYOK trimmed session cache"), {
    level: "warn",
    message: "BYOK trimmed session cache",
    fields: {
      requestId,
      bucket: "records",
      lengthBeforeTrim: 3,
      maxRecords: 2,
      maxPendingResults: 1024,
      maxCompletedResults: 2,
      droppedMessageCase: "toolCallCompleted",
      droppedToolCallId: "web-old",
    },
  });
  await assert.rejects(
    store.waitForClientToolCompletion(requestId, "web-old", "WebSearch", 1),
    /Timed out waiting for Cursor client tool completion web-old/,
  );
  assert.deepEqual(await store.waitForClientToolCompletion(requestId, "web-new", "WebSearch", 1000), {
    case: "success",
    value: { references: [{ title: "Result web-new", url: "https://example.com/web-new" }] },
  });
});

test("session store wakes MCP auth waiters when Cursor interaction response arrives", async () => {
  const store = new ByokSessionStore();
  const requestId = "54545454-5454-4545-8545-545454545454";
  const wait = store.waitForInteractionResponse(requestId, 123, 1000);
  store.recordClientMessage(requestId, {
    message: {
      case: "interactionResponse",
      value: approvedMcpAuthInteractionResponse(123),
    },
  });
  assert.deepEqual(await wait, approvedMcpAuthInteractionResponse(123));
  assert.deepEqual(
    await store.waitForInteractionResponse(requestId, 123, 1000),
    approvedMcpAuthInteractionResponse(123),
  );
});

test("session store bounds completed and pending result caches without dropping newest results", async () => {
  const log = recordingLog();
  const store = new ByokSessionStore({ maxPendingResults: 2, maxCompletedResults: 2, log });
  const requestId = "59595959-5959-4595-8595-595959595959";

  for (const queryId of [1, 2, 3]) {
    store.recordClientMessage(requestId, {
      message: {
        case: "interactionResponse",
        value: approvedMcpAuthInteractionResponse(queryId),
      },
    });
  }
  assert.equal(store.get(requestId).completedInteractionResponsesById.size, 2);
  assert.equal(log.entries.some((entry) =>
    entry.message === "BYOK trimmed completed result cache" &&
    entry.fields.requestId === requestId &&
    entry.fields.bucket === "completedInteractionResponsesById" &&
    entry.fields.droppedKey === "1"
  ), true);
  assert.deepEqual(await store.waitForInteractionResponse(requestId, 3, 1000), approvedMcpAuthInteractionResponse(3));

  for (const toolCallId of ["call-1", "call-2", "call-3"]) {
    store.recordClientMessage(requestId, {
      message: {
        case: "execClientMessage",
        value: {
          execId: toolCallId,
          message: {
            case: "readResult",
            value: { result: { case: "success", value: { output: { case: "content", value: toolCallId } } } },
          },
        },
      },
    });
  }
  assert.equal(store.get(requestId).completedExecResultsByToolCallId.size, 2);
  assert.equal(log.entries.some((entry) =>
    entry.message === "BYOK trimmed completed result cache" &&
    entry.fields.requestId === requestId &&
    entry.fields.bucket === "completedExecResultsByToolCallId" &&
    entry.fields.droppedKey === "call-1"
  ), true);
  assert.equal((await store.waitForExecResult(requestId, "call-3", 1000)).message.value.result.value.output.value, "call-3");

  for (const id of [1, 2, 3]) {
    store.recordClientMessage(requestId, {
      message: {
        case: "execClientMessage",
        value: {
          id,
          message: {
            case: "readResult",
            value: { result: { case: "success", value: { output: { case: "content", value: `pending-${id}` } } } },
          },
        },
      },
    });
  }
  assert.equal(store.get(requestId).pendingExecResults.length, 2);
  assert.equal(log.entries.some((entry) =>
    entry.message === "BYOK trimmed session cache" &&
    entry.fields.requestId === requestId &&
    entry.fields.bucket === "pendingExecResults" &&
    entry.fields.lengthBeforeTrim === 3
  ), true);
});

test("session store broadcasts one terminal MCP exec result to UI and provider waiters", async () => {
  const store = new ByokSessionStore();
  const requestId = "50505050-5050-4505-8505-505050505050";
  const uiWait = store.waitForExecResult(requestId, "mcp-call-1", 1000);
  const providerWait = store.waitForExecResult(requestId, "mcp-call-1", 1000);

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: normalizeExecClientResult({
        execId: "mcp-call-1",
        mcpResult: {
          success: {
            content: [{ content: { case: "text", value: { text: "file contents" } } }],
          },
        },
      }),
    },
  });

  const [uiResult, providerResult] = await Promise.all([uiWait, providerWait]);
  assert.equal(uiResult.message.case, "mcpResult");
  assert.equal(providerResult.message.case, "mcpResult");
  assert.equal(findExecToolCallId(uiResult), "mcp-call-1");
  assert.equal(findExecToolCallId(providerResult), "mcp-call-1");

  const laterResult = await store.waitForExecResult(requestId, "mcp-call-1", 1000);
  assert.equal(laterResult.message.case, "mcpResult");
  assert.equal(findExecToolCallId(laterResult), "mcp-call-1");
});

test("session store resolves Shell waiters only after terminal shell stream events", async () => {
  const store = new ByokSessionStore();
  const requestId = "51515151-5151-4515-8515-515151515151";
  store.registerExecAlias(requestId, 7, "shell-1", "shell-1");
  const wait = store.waitForExecResult(requestId, "shell-1", 1000);
  let settled = false;
  const observed = wait.then((result) => {
    settled = true;
    return result;
  });

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "shell-1",
        message: {
          case: "shellStream",
          value: {
            event: { case: "stdout", value: { data: "hello\n" } },
          },
        },
      },
    },
  });
  await tick();
  assert.equal(settled, false);

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "shell-1",
        message: {
          case: "shellStream",
          value: {
            event: { case: "stderr", value: { data: "warn\n" } },
          },
        },
      },
    },
  });
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "shell-1",
        message: {
          case: "shellStream",
          value: {
            event: { case: "exit", value: { code: 0, cwd: "/tmp/project", localExecutionTimeMs: 12 } },
          },
        },
      },
    },
  });

  const result = await observed;
  assert.equal(result._byokToolCallId, "shell-1");
  assert.deepEqual(result.message, {
    case: "shellResult",
    value: {
      result: {
        case: "success",
        value: {
          command: "",
          workingDirectory: "/tmp/project",
          exitCode: 0,
          signal: "",
          stdout: "hello\n",
          stderr: "warn\n",
          executionTime: 0,
          interleavedOutput: "hello\nwarn\n",
          localExecutionTimeMs: 12,
        },
      },
    },
  });
});

test("session store bounds Shell stream output and reports provider-visible truncation", async () => {
  assert.equal(DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS >= 1024 * 1024, true);
  const log = recordingLog();
  const store = new ByokSessionStore({ maxShellStreamBufferChars: 12, log });
  const requestId = "51515151-5151-4515-8515-515151515152";
  store.registerExecAlias(requestId, 8, "shell-truncated", "shell-truncated");
  const wait = store.waitForExecResult(requestId, "shell-truncated", 1000);

  for (const data of ["abcdefghij", "klmnop"]) {
    store.recordClientMessage(requestId, {
      message: {
        case: "execClientMessage",
        value: {
          id: 8,
          execId: "shell-truncated",
          message: {
            case: "shellStream",
            value: { event: { case: "stdout", value: { data } } },
          },
        },
      },
    });
  }
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 8,
        execId: "shell-truncated",
        message: {
          case: "shellStream",
          value: { event: { case: "exit", value: { code: 0, cwd: "/tmp/project" } } },
        },
      },
    },
  });

  const result = await wait;
  const value = result.message.value.result.value;
  assert.equal(value.stdout, "[BYOK truncated 4 characters from the beginning of shell stdout output]\nefghijklmnop");
  assert.equal(value.interleavedOutput, "[BYOK truncated 4 characters from the beginning of shell interleaved output]\nefghijklmnop");
  assert.equal(log.entries.some((entry) =>
    entry.message === "BYOK truncated shell stream output" &&
    entry.fields.requestId === requestId &&
    entry.fields.toolCallId === "shell-truncated" &&
    entry.fields.stream === "stdout" &&
    entry.fields.maxChars === 12
  ), true);
});

test("session store resolves flat Cursor Shell stream oneof events from local tool results", async () => {
  const store = new ByokSessionStore();
  const requestId = "53535353-5353-4535-8535-535353535353";
  store.registerExecAlias(requestId, 43, "shell-flat", "");
  const wait = store.waitForExecResult(requestId, "shell-flat", 1000);
  let settled = false;
  const observed = wait.then((result) => {
    settled = true;
    return result;
  });

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 43,
        message: {
          case: "shellStream",
          value: {
            start: { command: "printf shell_ok", cwd: "/tmp/project" },
          },
        },
      },
    },
  });
  await tick();
  assert.equal(settled, false);

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 43,
        message: {
          case: "shellStream",
          value: {
            stdout: { data: "shell_ok" },
          },
        },
      },
    },
  });
  await tick();
  assert.equal(settled, false);

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 43,
        message: {
          case: "shellStream",
          value: {
            exit: { code: 0, cwd: "/tmp/project" },
          },
        },
      },
    },
  });

  const result = await observed;
  assert.equal(result._byokToolCallId, "shell-flat");
  assert.equal(result.message.case, "shellResult");
  assert.equal(result.message.value.result.case, "success");
  assert.equal(result.message.value.result.value.stdout, "shell_ok");
  assert.equal(result.message.value.result.value.stderr, "");
  assert.equal(result.message.value.result.value.interleavedOutput, "shell_ok");
  assert.equal(result.message.value.result.value.workingDirectory, "/tmp/project");
  assert.equal(result.message.value.result.value.exitCode, 0);
});

test("session store aggregates pending Shell streams after native id alias arrives", async () => {
  const store = new ByokSessionStore();
  const requestId = "52525252-5252-4525-8525-525252525252";

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 9,
        message: {
          case: "shellStream",
          value: {
            event: { case: "stdout", value: { data: "pending\n" } },
          },
        },
      },
    },
  });

  const wait = store.waitForExecResult(requestId, "shell-pending", 1000);
  let settled = false;
  const observed = wait.then((result) => {
    settled = true;
    return result;
  });
  store.registerExecAlias(requestId, 9, "shell-pending");
  await tick();
  assert.equal(settled, false);

  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 9,
        message: {
          case: "shellStream",
          value: {
            event: { case: "exit", value: { code: 1, cwd: "/tmp/project" } },
          },
        },
      },
    },
  });

  const result = await observed;
  assert.equal(result._byokToolCallId, "shell-pending");
  assert.equal(result.message.case, "shellResult");
  assert.equal(result.message.value.result.case, "failure");
  assert.equal(result.message.value.result.value.stdout, "pending\n");
  assert.equal(result.message.value.result.value.exitCode, 1);
});

test("session store preserves Shell truncation metadata when pending stream alias is registered", async () => {
  const log = recordingLog();
  const store = new ByokSessionStore({ maxShellStreamBufferChars: 8, log });
  const requestId = "52525252-5252-4525-8525-525252525253";

  for (const data of ["abcdefgh", "ijkl"]) {
    store.recordClientMessage(requestId, {
      message: {
        case: "execClientMessage",
        value: {
          id: 10,
          message: {
            case: "shellStream",
            value: { event: { case: "stdout", value: { data } } },
          },
        },
      },
    });
  }

  const wait = store.waitForExecResult(requestId, "shell-aliased-truncated", 1000);
  store.registerExecAlias(requestId, 10, "shell-aliased-truncated");
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 10,
        message: {
          case: "shellStream",
          value: { event: { case: "exit", value: { code: 0, cwd: "/tmp/project" } } },
        },
      },
    },
  });

  const result = await wait;
  assert.equal(
    result.message.value.result.value.stdout,
    "[BYOK truncated 4 characters from the beginning of shell stdout output]\nefghijkl",
  );
  assert.equal(log.entries.filter((entry) =>
    entry.message === "BYOK truncated shell stream output" &&
    entry.fields.stream === "stdout"
  ).length, 1);
});

test("session store wakes Shell waiters from toolCallCompleted shell result fallback", async () => {
  const store = new ByokSessionStore();
  const requestId = "61616161-6161-4616-8616-616161616161";
  const wait = store.waitForExecResult(requestId, "shell-tool-1", 1000);

  store.recordClientMessage(requestId, {
    message: {
      case: "toolCallCompleted",
      value: {
        message: {
          value: {
            callId: "shell-tool-1",
            toolCall: {
              callId: "shell-tool-1",
              tool: {
                case: "shellToolCall",
                value: {
                  result: {
                    result: {
                      case: "success",
                      value: {
                        shellId: "shell-9",
                        stdout: "done\n",
                        stderr: "",
                        exitCode: 0,
                        cwd: "/tmp",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const result = await wait;
  assert.equal(findExecToolCallId(result), "shell-tool-1");
  assert.equal(result.message.case, "shellResult");
  assert.equal(result.message.value.result.case, "success");
  assert.deepEqual(result.message.value.result.value, {
    shellId: "shell-9",
    stdout: "done\n",
    stderr: "",
    exitCode: 0,
    cwd: "/tmp",
    workingDirectory: "/tmp",
    output: "done\n",
  });
});

test("session store falls back to most recently updated session if requestId is falsy", async () => {
  const store = new ByokSessionStore();
  const requestId = "55555555-5555-4555-8555-555555555555";

  // Create the session and set it as active
  store.getOrCreate(requestId);

  const wait = store.waitForExecResult(requestId, "call-1", 1000);

  // Record client message with falsy/missing requestId
  const session = store.recordClientMessage(null, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "call-1",
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: { output: { case: "content", value: "ok" } },
            },
          },
        },
      },
    },
  });

  assert.notEqual(session, null);
  assert.equal(session.requestId, requestId);
  const result = await wait;
  assert.equal(findExecToolCallId(result), "call-1");
});

test("session store resolves Cursor exec results through registered native id aliases", async () => {
  const store = new ByokSessionStore();
  const requestId = "56565656-5656-4565-8565-565656565656";
  store.registerExecAlias(requestId, 1, "call-1-read");
  const wait = store.waitForExecResult(requestId, "call-1-read", 1000);
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 1,
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: { output: { case: "content", value: "ok" } },
            },
          },
        },
      },
    },
  });
  const result = await wait;
  assert.equal(result._byokToolCallId, "call-1-read");
  assert.equal(findExecToolCallId(result), "call-1-read");
  assert.equal(result.message.case, "readResult");
});
