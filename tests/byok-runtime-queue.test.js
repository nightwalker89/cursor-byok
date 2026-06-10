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

test("Bidi raw queue associates records by requestId before FIFO fallback", () => {
  const queue = new BidiRawQueue();
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  queue.push({ requestId: firstId, json: { data: "616263" } });
  queue.push({ requestId: secondId, json: { data: "646566" } });
  queue.push({ json: { data: "676869" } });
  assert.equal(queue.take(secondId).payloadPrefixHex, "646566");
  assert.equal(queue.take(firstId).payloadPrefixHex, "616263");
  assert.equal(queue.take("missing").payloadPrefixHex, "676869");
  assert.equal(queue.take(firstId), null);
});

test("Bidi raw queue caps stale unmatched records without changing request ordering", () => {
  const log = recordingLog();
  const queue = new BidiRawQueue({ maxRecords: 3, maxRecordsPerRequest: 2, log });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";

  queue.push({ requestId: firstId, json: { data: "6161" } });
  queue.push({ requestId: firstId, json: { data: "6262" } });
  queue.push({ requestId: firstId, json: { data: "6363" } });
  assert.equal(queue.sizeFor(firstId), 2);
  assert.deepEqual(log.entries[0], {
    level: "warn",
    message: "BYOK dropped stale BidiAppend payload",
    fields: {
      reason: "per-request-limit",
      requestId: firstId,
      kindHint: "clientHeartbeat",
      payloadLength: 2,
      queueSize: 3,
      maxRecords: 3,
      maxRecordsPerRequest: 2,
    },
  });
  assert.equal(queue.take(firstId).payloadPrefixHex, "6262");
  assert.equal(queue.take(firstId).payloadPrefixHex, "6363");

  queue.push({ requestId: firstId, json: { data: "6464" } });
  queue.push({ requestId: secondId, json: { data: "6565" } });
  queue.push({ json: { data: "6666" } });
  queue.push({ json: { data: "6767" } });
  assert.equal(queue.sizeFor(firstId), 0);
  assert.equal(log.entries.some((entry) =>
    entry.message === "BYOK dropped stale BidiAppend payload" &&
    entry.fields.reason === "global-limit" &&
    entry.fields.requestId === firstId
  ), true);
  assert.equal(queue.take(secondId).payloadPrefixHex, "6565");
  assert.equal(queue.take("missing").payloadPrefixHex, "6666");
  assert.equal(queue.take("missing").payloadPrefixHex, "6767");
});

test("Bidi payload classification keeps conversation actions and heartbeats distinct", () => {
  assert.equal(classifyBidiPayload(Buffer.from("00", "hex")), "clientHeartbeat");
  assert.equal(classifyBidiPayload(Buffer.concat([Buffer.from("0a4e3232", "hex"), Buffer.alloc(124)])), "conversationAction");
  assert.equal(classifyBidiPayload(Buffer.alloc(32)), "data");
});

test("Bidi payload extraction supports current dataBinary field", () => {
  assert.equal(extractPayloadBytes({ dataBinary: "616263" }).toString("utf8"), "abc");
  assert.equal(extractPayloadBytes({ data_binary: Buffer.from("def") }).toString("utf8"), "def");
});

test("conversation pins expire deterministically", () => {
  let now = 1000;
  const pins = new ConversationPins(10, () => now);
  pins.pin("c1");
  assert.equal(pins.has("c1"), true);
  now = 1011;
  assert.equal(pins.has("c1"), false);
});

test("request id discovery walks Cursor-shaped nested request objects", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  assert.equal(findRequestId({ requestId: { requestId: id } }), id);
  assert.equal(findRequestId({ conversationState: { conversationId: id } }), id);
  assert.equal(findRequestId(`prefix ${id} suffix`), id);
});

test("lightweight Cursor protobuf decoder reads runRequest model and user text", () => {
  const userMessage = protoMessage([
    fieldString(1, "use offset=12"),
    fieldString(2, "msg-1"),
  ]);
  const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
  const action = protoMessage([fieldMessage(1, userMessageAction)]);
  const modelDetails = protoMessage([fieldString(1, "byok-model")]);
  const requestedModel = protoMessage([fieldString(1, "byok-model")]);
  const runRequest = protoMessage([
    fieldMessage(2, action),
    fieldMessage(3, modelDetails),
    fieldString(5, "conv-1"),
    fieldMessage(9, requestedModel),
  ]);
  const clientMessage = protoMessage([fieldMessage(1, runRequest)]);
  assert.deepEqual(decodeAgentClientMessage(clientMessage), {
    message: {
      case: "runRequest",
      value: {
        action: {
          action: {
            case: "userMessageAction",
            value: {
              userMessage: {
                text: "use offset=12",
                messageId: "msg-1",
              },
            },
          },
        },
        modelDetails: { modelId: "byok-model" },
        conversationId: "conv-1",
        requestedModel: { modelId: "byok-model" },
      },
    },
  });
});

test("lightweight Cursor protobuf decoder maps redacted Read results onto readResult", () => {
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/large.txt"),
    fieldString(2, "large content"),
    fieldVarint(3, 2),
    fieldVarint(4, 91549),
    fieldVarint(6, 1),
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execClientMessage = protoMessage([
    fieldVarint(1, 203),
    fieldString(15, "call-large-read"),
    fieldMessage(29, readResult),
  ]);
  const clientMessage = protoMessage([fieldMessage(2, execClientMessage)]);

  assert.deepEqual(decodeAgentClientMessage(clientMessage), {
    message: {
      case: "execClientMessage",
      value: {
        id: 203,
        execId: "call-large-read",
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: {
                path: "/tmp/large.txt",
                output: { case: "content", value: "large content" },
                totalLines: 2,
                fileSize: 91549,
                truncated: true,
              },
            },
          },
        },
      },
    },
  });
});

test("lightweight Cursor protobuf decoder preserves blob-only Read results without fake empty content", () => {
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/large.txt"),
    fieldVarint(3, 1200),
    fieldVarint(4, 250000),
    fieldMessage(7, Buffer.from("blob-ref", "utf8")),
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execClientMessage = protoMessage([
    fieldVarint(1, 204),
    fieldString(15, "call-blob-read"),
    fieldMessage(29, readResult),
  ]);
  const clientMessage = protoMessage([fieldMessage(2, execClientMessage)]);

  assert.deepEqual(decodeAgentClientMessage(clientMessage), {
    message: {
      case: "execClientMessage",
      value: {
        id: 204,
        execId: "call-blob-read",
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: {
                path: "/tmp/large.txt",
                totalLines: 1200,
                fileSize: 250000,
                truncated: false,
                outputBlobId: "YmxvYi1yZWY=",
              },
            },
          },
        },
      },
    },
  });
});

test("lightweight Cursor protobuf decoder reads shell stream events", () => {
  const stdout = protoMessage([fieldString(1, "hello\n")]);
  const shellStream = protoMessage([fieldMessage(1, stdout)]);
  const execClientMessage = protoMessage([
    fieldVarint(1, 7),
    fieldString(15, "shell-call"),
    fieldMessage(14, shellStream),
  ]);
  const clientMessage = protoMessage([fieldMessage(2, execClientMessage)]);

  assert.deepEqual(decodeAgentClientMessage(clientMessage), {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        execId: "shell-call",
        message: {
          case: "shellStream",
          value: {
            event: {
              case: "stdout",
              value: { data: "hello\n" },
            },
          },
        },
      },
    },
  });
});

test("lightweight Cursor protobuf decoder reads MCP auth interaction responses", () => {
  const approvedAuthResponse = protoMessage([fieldMessage(1, protoMessage([]))]);
  const approvedInteractionResponse = protoMessage([
    fieldVarint(1, 123),
    fieldMessage(11, approvedAuthResponse),
  ]);
  assert.deepEqual(decodeAgentClientMessage(protoMessage([fieldMessage(6, approvedInteractionResponse)])), {
    message: {
      case: "interactionResponse",
      value: approvedMcpAuthInteractionResponse(123),
    },
  });

  const rejected = protoMessage([fieldString(1, "denied by user")]);
  const rejectedAuthResponse = protoMessage([fieldMessage(2, rejected)]);
  const rejectedInteractionResponse = protoMessage([
    fieldVarint(1, 124),
    fieldMessage(11, rejectedAuthResponse),
  ]);
  assert.deepEqual(decodeAgentClientMessage(protoMessage([fieldMessage(6, rejectedInteractionResponse)])), {
    message: {
      case: "interactionResponse",
      value: rejectedMcpAuthInteractionResponse(124, "denied by user"),
    },
  });
});

test("lightweight Cursor protobuf decoder preserves non-auth interaction response cases", () => {
  const askAnswer = protoMessage([
    fieldString(1, "fixture"),
    fieldString(2, "tmp"),
    fieldString(3, ""),
  ]);
  const askQuestionSuccess = protoMessage([
    fieldMessage(1, askAnswer),
  ]);
  const askQuestionResult = protoMessage([
    fieldMessage(1, askQuestionSuccess),
  ]);
  const askQuestionInteractionResponse = protoMessage([
    fieldMessage(1, askQuestionResult),
  ]);
  const askInteractionResponse = protoMessage([
    fieldVarint(1, 201),
    fieldMessage(3, askQuestionInteractionResponse),
  ]);
  assert.deepEqual(decodeAgentClientMessage(protoMessage([fieldMessage(6, askInteractionResponse)])), {
    message: {
      case: "interactionResponse",
      value: {
        id: 201,
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              result: {
                case: "success",
                value: {
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
    },
  });

  const askErrorResult = protoMessage([
    fieldMessage(2, protoMessage([fieldString(1, "bad question")])),
  ]);
  const askErrorInteraction = protoMessage([
    fieldMessage(1, askErrorResult),
  ]);
  const askErrorInteractionResponse = protoMessage([
    fieldVarint(1, 204),
    fieldMessage(3, askErrorInteraction),
  ]);
  assert.deepEqual(
    decodeAgentClientMessage(protoMessage([fieldMessage(6, askErrorInteractionResponse)]))
      .message.value.result.value.result.result,
    {
      case: "error",
      value: { errorMessage: "bad question" },
    },
  );

  const webSearchRejected = protoMessage([
    fieldMessage(1, protoMessage([fieldMessage(3, protoMessage([fieldString(1, "no")]))])),
  ]);
  const webSearchInteractionResponse = protoMessage([
    fieldVarint(1, 202),
    fieldMessage(2, webSearchRejected),
  ]);
  assert.equal(
    decodeAgentClientMessage(protoMessage([fieldMessage(6, webSearchInteractionResponse)]))
      .message.value.result.case,
    "webSearchRequestResponse",
  );

  const generateImageApproved = protoMessage([
    fieldMessage(1, protoMessage([fieldMessage(1, protoMessage([]))])),
  ]);
  const generateImageInteractionResponse = protoMessage([
    fieldVarint(1, 203),
    fieldMessage(12, generateImageApproved),
  ]);
  assert.equal(
    decodeAgentClientMessage(protoMessage([fieldMessage(6, generateImageInteractionResponse)]))
      .message.value.result.case,
    "generateImageRequestResponse",
  );

  const webFetchApproved = protoMessage([
    fieldMessage(1, protoMessage([fieldMessage(1, protoMessage([]))])),
  ]);
  const webFetchInteractionResponse = protoMessage([
    fieldVarint(1, 205),
    fieldMessage(9, webFetchApproved),
  ]);
  assert.equal(
    decodeAgentClientMessage(protoMessage([fieldMessage(6, webFetchInteractionResponse)]))
      .message.value.result.case,
    "webFetchRequestResponse",
  );
});
