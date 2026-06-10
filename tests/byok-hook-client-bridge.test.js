"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
} = require("../src/workbench-hook");
const { buildInteractionQuery } = require("../src/runtime/interaction-bridge");
const { toolResultFromInteractionResponse } = require("../src/runtime/interaction-bridge");
const { buildClientInteractionQuery, toolResultFromClientCompletion } = require("../src/runtime/client-tool-bridge");
const { strictCursorMessageCtor, jsonResponse, ndjsonResponse, approvedMcpAuthInteractionResponse, approvedSwitchModeInteractionResponse, answeredAskQuestionInteractionResponse, asyncIterable } = require("./byok-fixtures");

test("grey-box hook bridges BYOK interaction tools through Cursor interaction queries", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "89898989-8989-4898-8989-898989898989";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "switch-1",
            name: "SwitchMode",
            arguments: { target_mode_id: "plan", explanation: "Need plan mode" },
          },
          {
            type: "tool_use_done",
            id: "ask-1",
            name: "AskQuestion",
            arguments: {
              title: "Fixture",
              questions: [{
                id: "fixture",
                prompt: "Which fixture should I use?",
                options: [{ id: "tmp", label: "tmp" }],
              }],
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        if (body.toolName === "SwitchMode") return jsonResponse({ ok: true, result: approvedSwitchModeInteractionResponse(body.queryId) });
        if (body.toolName === "AskQuestion") return jsonResponse({ ok: true, result: answeredAskQuestionInteractionResponse(body.queryId) });
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "toolCallStarted",
      "interactionQuery",
      "toolCallCompleted",
      "toolCallStarted",
      "interactionQuery",
      "toolCallCompleted",
      "stepCompleted",
    ]);
    assert.equal(messages[0].message.value.message.value.toolCall.tool.case, "switchModeToolCall");
    assert.equal(messages[1].message.value.query.case, "switchModeRequestQuery");
    assert.equal(messages[3].message.value.message.value.toolCall.tool.case, "askQuestionToolCall");
    assert.equal(messages[4].message.value.query.case, "askQuestionInteractionQuery");
    assert.equal(messages[1].message.value.query.value.args.toolCallId, "switch-1");
    assert.equal(messages[4].message.value.query.value.toolCallId, "ask-1");

    const interactionCalls = calls.filter((call) => call.url.endsWith("/byok/interaction-response"));
    assert.deepEqual(interactionCalls.map((call) => ({
      requestId: call.body.requestId,
      queryId: call.body.queryId,
      toolName: call.body.toolName,
      toolCallId: call.body.toolCallId,
    })), [
      { requestId, queryId: 100000, toolName: "SwitchMode", toolCallId: "switch-1" },
      { requestId, queryId: 100001, toolName: "AskQuestion", toolCallId: "ask-1" },
    ]);
    assert.deepEqual(interactionCalls[0].body.toolArguments, {
      target_mode_id: "plan",
      explanation: "Need plan mode",
    });
    assert.deepEqual(interactionCalls[1].body.toolArguments.questions[0].options, [{ id: "tmp", label: "tmp" }]);

    const localResultCalls = calls.filter((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResultCalls.map((call) => call.body.toolCallId), ["switch-1", "ask-1"]);
    assert.deepEqual(localResultCalls.map((call) => call.body.result.message.case), [
      "byokInteractionToolResult",
      "byokInteractionToolResult",
    ]);
    // Literal expectations: the hook inlines its own copy of the bridge
    // normalization, so comparing against toolResultFromInteractionResponse
    // output alone would pass even if a bug were applied to both copies.
    assert.deepEqual(localResultCalls[0].body.result.message.value.toolResult, {
      result: {
        case: "success",
        value: { fromModeId: "", toModeId: "plan" },
      },
    });
    assert.deepEqual(localResultCalls[1].body.result.message.value.toolResult, {
      result: {
        case: "success",
        value: {
          answers: [{ questionId: "fixture", selectedOptionIds: ["tmp"], freeformText: "" }],
        },
      },
    });
    // Parity with the shared bridge module must also hold.
    assert.deepEqual(
      localResultCalls[0].body.result.message.value.toolResult,
      toolResultFromInteractionResponse("SwitchMode", approvedSwitchModeInteractionResponse(100000), {
        target_mode_id: "plan",
        explanation: "Need plan mode",
      }),
    );
    assert.deepEqual(
      localResultCalls[1].body.result.message.value.toolResult,
      toolResultFromInteractionResponse("AskQuestion", answeredAskQuestionInteractionResponse(100001), {
        title: "Fixture",
        questions: [{
          id: "fixture",
          prompt: "Which fixture should I use?",
          options: [{ id: "tmp", label: "tmp" }],
        }],
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook matches shared interaction bridge normalization for conflicting alias inputs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "89898989-8989-4898-8989-898989898990";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "switch-conflict",
            name: "SwitchMode",
            arguments: { target_mode_id: "", targetModeId: "agent", explanation: "" },
          },
          {
            type: "tool_use_done",
            id: "ask-conflict",
            name: "AskQuestion",
            arguments: {
              questions: [{
                id: "q1",
                prompt: "Proceed?",
                allow_multiple: false,
                allowMultiple: true,
                options: [],
              }],
            },
          },
          {
            type: "tool_use_done",
            id: "plan-conflict",
            name: "CreatePlan",
            arguments: {
              name: "n",
              overview: "o",
              plan: "p",
              isProject: false,
              is_project: true,
              todos: [{ id: "t1", content: "c", status: "pending" }],
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        if (body.toolName === "SwitchMode") return jsonResponse({ ok: true, result: approvedSwitchModeInteractionResponse(body.queryId) });
        if (body.toolName === "AskQuestion") return jsonResponse({ ok: true, result: answeredAskQuestionInteractionResponse(body.queryId) });
        if (body.toolName === "CreatePlan") {
          return jsonResponse({
            ok: true,
            result: {
              id: body.queryId,
              result: {
                case: "createPlanRequestResponse",
                value: { result: { case: "success", value: { planId: "p-1" } } },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    const queries = messages
      .filter((message) => message.message?.value?.query)
      .map((message) => message.message.value.query);
    // Literal expectations pin the alias-conflict semantics: camelCase wins for
    // a non-empty value over an empty canonical key (SwitchMode), but explicit
    // canonical values — including falsy ones — win over camelCase aliases
    // (allowMultiple, isProject use ?? coalescing). The hook inlines its own
    // copy of this normalization, so library-parity alone could not catch a bug
    // applied to both copies.
    assert.deepEqual(queries, [
      {
        case: "switchModeRequestQuery",
        value: { args: { targetModeId: "agent", explanation: "", toolCallId: "switch-conflict" } },
      },
      {
        case: "askQuestionInteractionQuery",
        value: {
          args: {
            title: "",
            questions: [{ id: "q1", prompt: "Proceed?", allowMultiple: false, options: [] }],
          },
          toolCallId: "ask-conflict",
        },
      },
      {
        case: "createPlanRequestQuery",
        value: {
          args: {
            name: "n",
            overview: "o",
            plan: "p",
            todos: [{ id: "t1", content: "c", dependencies: [], status: 1 }],
            isProject: false,
            phases: [],
          },
          toolCallId: "plan-conflict",
        },
      },
    ]);
    // Parity with the shared bridge module must also hold.
    assert.deepEqual(queries, [
      buildInteractionQuery("SwitchMode", "switch-conflict", { target_mode_id: "", targetModeId: "agent", explanation: "" }, 100000).query,
      buildInteractionQuery("AskQuestion", "ask-conflict", {
        questions: [{ id: "q1", prompt: "Proceed?", allow_multiple: false, allowMultiple: true, options: [] }],
      }, 100001).query,
      buildInteractionQuery("CreatePlan", "plan-conflict", {
        name: "n",
        overview: "o",
        plan: "p",
        isProject: false,
        is_project: true,
        todos: [{ id: "t1", content: "c", status: "pending" }],
      }, 100002).query,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook bridges BYOK client tools through Cursor client completions", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "70707070-7070-4707-8707-707070707070";
  const calls = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "web-1",
            name: "WebSearch",
            arguments: { search_term: "Cursor BYOK tool semantics" },
          },
          {
            type: "tool_use_done",
            id: "image-1",
            name: "GenerateImage",
            arguments: { description: "tool bridge diagram", filename: "/tmp/byok-client-tool.png" },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        if (body.toolName === "WebSearch") {
          return jsonResponse({
            ok: true,
            result: {
              id: body.queryId,
              result: { case: "webSearchRequestResponse", value: { result: { case: "approved", value: {} } } },
            },
          });
        }
        if (body.toolName === "GenerateImage") {
          return jsonResponse({
            ok: true,
            result: {
              id: body.queryId,
              result: { case: "generateImageRequestResponse", value: { result: { case: "approved", value: {} } } },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/client-tool-completion")) {
        if (body.toolName === "WebSearch") {
          return jsonResponse({
            ok: true,
            completion: {
              case: "success",
              value: { references: [{ title: "Cursor BYOK", url: "https://example.com/byok" }] },
            },
          });
        }
        if (body.toolName === "GenerateImage") {
          return jsonResponse({
            ok: true,
            completion: {
              case: "success",
              value: { filePath: "/tmp/byok-client-tool.png" },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "toolCallStarted",
      "interactionQuery",
      "toolCallCompleted",
      "toolCallStarted",
      "interactionQuery",
      "toolCallCompleted",
      "stepCompleted",
    ]);
    assert.equal(messages[0].message.value.message.value.toolCall.tool.case, "webSearchToolCall");
    assert.equal(messages[1].message.value.query.case, "webSearchRequestQuery");
    assert.equal(messages[3].message.value.message.value.toolCall.tool.case, "generateImageToolCall");
    assert.equal(messages[4].message.value.query.case, "generateImageRequestQuery");
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);

    const approvalCalls = calls.filter((call) => call.url.endsWith("/byok/interaction-response"));
    assert.deepEqual(approvalCalls.map((call) => ({
      requestId: call.body.requestId,
      queryId: call.body.queryId,
      toolName: call.body.toolName,
      toolCallId: call.body.toolCallId,
    })), [
      { requestId, queryId: 100000, toolName: "WebSearch", toolCallId: undefined },
      { requestId, queryId: 100001, toolName: "GenerateImage", toolCallId: undefined },
    ]);
    assert.deepEqual(approvalCalls[0].body.toolArguments, { search_term: "Cursor BYOK tool semantics" });
    assert.deepEqual(approvalCalls[1].body.toolArguments, { description: "tool bridge diagram", filename: "/tmp/byok-client-tool.png" });

    const completionCalls = calls.filter((call) => call.url.endsWith("/byok/client-tool-completion"));
    assert.deepEqual(completionCalls.map((call) => ({
      requestId: call.body.requestId,
      toolCallId: call.body.toolCallId,
      toolName: call.body.toolName,
      toolArguments: call.body.toolArguments,
    })), [
      {
        requestId,
        toolCallId: "web-1",
        toolName: "WebSearch",
        toolArguments: { search_term: "Cursor BYOK tool semantics" },
      },
      {
        requestId,
        toolCallId: "image-1",
        toolName: "GenerateImage",
        toolArguments: { description: "tool bridge diagram", filename: "/tmp/byok-client-tool.png" },
      },
    ]);

    const localResultCalls = calls.filter((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResultCalls.map((call) => call.body.toolCallId), ["web-1", "image-1"]);
    assert.deepEqual(localResultCalls.map((call) => call.body.result.message.case), [
      "byokInteractionToolResult",
      "byokInteractionToolResult",
    ]);
    // Literal expectations first (the hook inlines its own bridge copy), then
    // parity with the shared module.
    assert.deepEqual(localResultCalls[0].body.result.message.value.toolResult, {
      result: {
        case: "success",
        value: { references: [{ title: "Cursor BYOK", url: "https://example.com/byok" }] },
      },
    });
    assert.deepEqual(localResultCalls[1].body.result.message.value.toolResult, {
      result: {
        case: "success",
        value: { filePath: "/tmp/byok-client-tool.png" },
      },
    });
    assert.deepEqual(
      localResultCalls[0].body.result.message.value.toolResult,
      toolResultFromClientCompletion("WebSearch", {
        case: "success",
        value: { references: [{ title: "Cursor BYOK", url: "https://example.com/byok" }] },
      }),
    );
    assert.deepEqual(
      localResultCalls[1].body.result.message.value.toolResult,
      toolResultFromClientCompletion("GenerateImage", {
        case: "success",
        value: { filePath: "/tmp/byok-client-tool.png" },
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook matches shared client bridge normalization for conflicting alias inputs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "70707070-7070-4707-8707-707070707071";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "web-conflict",
            name: "WebSearch",
            arguments: { search_term: "", searchTerm: "world" },
          },
          {
            type: "tool_use_done",
            id: "image-conflict",
            name: "GenerateImage",
            arguments: { description: "tool bridge diagram", filename: "", filePath: "/tmp/byok-client-tool.png" },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        if (body.toolName === "WebSearch") {
          return jsonResponse({
            ok: true,
            result: {
              id: body.queryId,
              result: { case: "webSearchRequestResponse", value: { result: { case: "approved", value: {} } } },
            },
          });
        }
        if (body.toolName === "GenerateImage") {
          return jsonResponse({
            ok: true,
            result: {
              id: body.queryId,
              result: { case: "generateImageRequestResponse", value: { result: { case: "approved", value: {} } } },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/client-tool-completion")) {
        if (body.toolName === "WebSearch") {
          return jsonResponse({ ok: true, completion: { case: "success", value: { references: [] } } });
        }
        if (body.toolName === "GenerateImage") {
          return jsonResponse({ ok: true, completion: { case: "success", value: {} } });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      {},
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    const queries = messages
      .filter((message) => message.message?.value?.query)
      .map((message) => message.message.value.query);
    // Literal alias-conflict expectations: camelCase searchTerm wins over an
    // empty canonical key; filePath wins over an empty filename alias.
    assert.deepEqual(queries, [
      {
        case: "webSearchRequestQuery",
        value: { args: { searchTerm: "world", toolCallId: "web-conflict" } },
      },
      {
        case: "generateImageRequestQuery",
        value: {
          args: {
            description: "tool bridge diagram",
            referenceImagePaths: [],
            toolCallId: "image-conflict",
            filePath: "/tmp/byok-client-tool.png",
          },
          toolCallId: "image-conflict",
        },
      },
    ]);
    // Parity with the shared bridge module must also hold.
    assert.deepEqual(queries, [
      buildClientInteractionQuery("WebSearch", "web-conflict", { search_term: "", searchTerm: "world" }, 100000).query,
      buildClientInteractionQuery("GenerateImage", "image-conflict", { description: "tool bridge diagram", filename: "", filePath: "/tmp/byok-client-tool.png" }, 100001).query,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook bridges Cursor execClientMessage frames back to BYOK tool results", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "57575757-5757-4575-8575-575757575757";
  const calls = [];
  let releaseExecResult;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.requestedModel?.modelId === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "read-1", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":4,\"limit\":5}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result") && body?.directOnly) {
        return jsonResponse({ ok: false, direct: false }, 404);
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseExecResult = resolve;
        });
        yield {
          execClientMessage: {
            id: 1,
            execId: "read-1",
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
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    const messages = [];
    for await (const message of byokStream.message) {
      messages.push(message);
      if (message.message?.case === "execServerMessage") releaseExecResult();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const exec = messages.find((message) => message.message?.case === "execServerMessage").message.value;
    assert.equal(exec.id, 1);
    assert.equal(exec.execId, "read-1");
    const completed = messages.find((message) =>
      message.message?.value?.message?.case === "toolCallCompleted"
    );
    assert.ok(completed);
    assert.equal(
      completed.message.value.message.value.toolCall.tool.value.result.result.case,
      "success",
    );
    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localToolResult?.body?.requestId, requestId);
    assert.equal(localToolResult?.body?.toolCallId, "read-1");
    assert.equal(localToolResult?.body?.result?.id, 1);
    assert.equal(localToolResult?.body?.result?.execId, "read-1");
    assert.equal(localToolResult?.body?.result?.message?.case, "readResult");
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/byok/tool-result")).map((call) => call.body), [{
      requestId,
      toolCallId: "read-1",
      toolName: "Read",
      toolArguments: { path: "/tmp/a", offset: 4, limit: 5 },
      directOnly: true,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook bridges RunSSE execClientMessage frames back to BYOK tool results", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "57575757-5757-4575-8575-575757575758";
  const calls = [];
  let releaseExecResult;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.requestedModel?.modelId === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "read-sse-1", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":4,\"limit\":5}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result") && body?.directOnly) {
        return jsonResponse({ ok: false, direct: false }, 404);
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService RunSSE must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run-sse",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseExecResult = resolve;
        });
        yield {
          execClientMessage: {
            id: 1,
            execId: "read-sse-1",
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
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    const messages = [];
    for await (const message of byokStream.message) {
      messages.push(message);
      if (message.message?.case === "execServerMessage") releaseExecResult();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const exec = messages.find((message) => message.message?.case === "execServerMessage").message.value;
    assert.equal(exec.id, 1);
    assert.equal(exec.execId, "read-sse-1");
    const completed = messages.find((message) =>
      message.message?.value?.message?.case === "toolCallCompleted"
    );
    assert.ok(completed);
    assert.equal(
      completed.message.value.message.value.toolCall.tool.value.result.result.case,
      "success",
    );
    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localToolResult?.body?.requestId, requestId);
    assert.equal(localToolResult?.body?.toolCallId, "read-sse-1");
    assert.equal(localToolResult?.body?.result?.id, 1);
    assert.equal(localToolResult?.body?.result?.execId, "read-sse-1");
    assert.equal(localToolResult?.body?.result?.message?.case, "readResult");
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/byok/tool-result")).map((call) => call.body), [{
      requestId,
      toolCallId: "read-sse-1",
      toolName: "Read",
      toolArguments: { path: "/tmp/a", offset: 4, limit: 5 },
      directOnly: true,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook completes Shell UI from terminal shell stream only after provider done", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "57575757-5757-4575-8575-575757575759";
  const calls = [];
  let releaseShellStream;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.requestedModel?.modelId === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "shell-1", name: "Shell", arguments: "{\"command\":\"pwd\",\"working_directory\":\"/tmp/project\"}" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-shell-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseShellStream = resolve;
        });
        yield {
          execClientMessage: {
            id: 1,
            execId: "shell-1",
            message: {
              case: "shellStream",
              value: { event: { case: "stdout", value: { data: "/tmp/project\n" } } },
            },
          },
        };
        yield {
          execClientMessage: {
            id: 1,
            execId: "shell-1",
            message: {
              case: "shellStream",
              value: { event: { case: "exit", value: { code: 0, cwd: "/tmp/project", localExecutionTimeMs: 12 } } },
            },
          },
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    const messages = [];
    for await (const message of byokStream.message) {
      messages.push(message);
      if (message.message?.case === "execServerMessage") releaseShellStream();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const cases = messages.map((message) => message.message?.case === "execServerMessage"
      ? "execServerMessage"
      : message.message?.value?.message?.case);
    const stepCompletedIndex = cases.indexOf("stepCompleted");
    const completedIndex = cases.indexOf("toolCallCompleted");
    const turnEndedIndex = cases.indexOf("turnEnded");
    assert.equal(cases.indexOf("toolCallCompleted"), cases.lastIndexOf("toolCallCompleted"));
    assert.equal(cases.includes("toolCallCompleted"), true);
    assert.equal(stepCompletedIndex >= 0 && completedIndex > stepCompletedIndex, true);
    assert.equal(turnEndedIndex >= 0 && completedIndex < turnEndedIndex, true);

    const completed = messages[completedIndex].message.value.message.value;
    assert.equal(completed.callId, "shell-1");
    assert.equal(completed.toolCall.tool.case, "shellToolCall");
    assert.deepEqual(completed.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: {
          command: "pwd",
          workingDirectory: "/tmp/project",
          exitCode: 0,
          signal: "",
          stdout: "/tmp/project\n",
          stderr: "",
          executionTime: 0,
          interleavedOutput: "/tmp/project\n",
          localExecutionTimeMs: 12,
        },
      },
    });
    assert.deepEqual(
      calls.filter((call) => call.url.endsWith("/byok/local-tool-result")).map((call) => call.body.result.message.case),
      ["shellStream", "shellStream"],
    );
    assert.equal(calls.some((call) => call.url.endsWith("/byok/tool-result")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});

test("grey-box hook completes AwaitShell UI from native await result", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "57575757-5757-4575-8575-575757575760";
  const calls = [];
  let releaseAwaitResult;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: body?.request?.requestedModel?.modelId === "gpt55-sub2api" });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "await-1", name: "AwaitShell", arguments: "{\"shell_id\":\"shell-9\",\"block_until_ms\":1500}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-await-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseAwaitResult = resolve;
        });
        yield {
          execClientMessage: {
            id: 1,
            execId: "await-1",
            message: {
              case: "subagentAwaitResult",
              value: {
                result: {
                  case: "success",
                  value: {
                    complete: {
                      taskId: "shell-9",
                      runtimeMs: 1500,
                      outputFilePath: "",
                      outputLength: 0,
                    },
                  },
                },
              },
            },
          },
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    const messages = [];
    for await (const message of byokStream.message) {
      messages.push(message);
      if (message.message?.case === "execServerMessage") releaseAwaitResult();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const exec = messages.find((message) => message.message?.case === "execServerMessage")?.message.value;
    assert.equal(exec?.id, 1);
    assert.equal(exec.execId, "await-1");
    assert.equal(exec.message.case, "subagentAwaitArgs");
    assert.deepEqual(exec.message.value, {
      agentId: "shell-9",
      timeoutMs: 1500,
    });

    const completions = messages.filter((message) =>
      message.message?.value?.message?.case === "toolCallCompleted"
    );
    assert.equal(completions.length, 1);
    const completed = completions[0].message.value.message.value;
    assert.equal(completed.callId, "await-1");
    assert.equal(completed.toolCall.tool.case, "awaitToolCall");
    assert.equal(completed.toolCall.tool.value.result.result.case, "success");
    assert.deepEqual(completed.toolCall.tool.value.result.result.value.complete, {
      taskId: "shell-9",
      runtimeMs: 1500,
      outputFilePath: "",
      outputLength: 0,
    });

    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localToolResult?.body?.requestId, requestId);
    assert.equal(localToolResult?.body?.toolCallId, "await-1");
    assert.equal(localToolResult?.body?.result?.id, 1);
    assert.equal(localToolResult?.body?.result?.execId, "await-1");
    assert.equal(localToolResult?.body?.result?.message?.case, "subagentAwaitResult");
    assert.equal(calls.some((call) => call.url.endsWith("/byok/tool-result")), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook posts large Cursor Read exec results without keepalive truncation", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "58585858-5858-4585-8585-585858585858";
  const largeContent = "x".repeat(70000);
  const calls = [];
  let releaseExecResult;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const rawBody = typeof init.body === "string" ? init.body : "";
      if (String(url).endsWith("/byok/local-tool-result") && init.keepalive === true && rawBody.length > 65536) {
        throw new TypeError("keepalive request payload size exceeds limit");
      }
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      calls.push({ url: String(url), init, body, bodyLength: rawBody.length });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "read-large", name: "Read", arguments: "{\"path\":\"/tmp/large.txt\"}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseExecResult = resolve;
        });
        yield {
          execClientMessage: {
            id: 1,
            execId: "read-large",
            message: {
              case: "readResult",
              value: {
                result: {
                  case: "success",
                  value: {
                    path: "/tmp/large.txt",
                    output: { case: "content", value: largeContent },
                    totalLines: 1,
                    fileSize: largeContent.length,
                  },
                },
              },
            },
          },
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    for await (const message of byokStream.message) {
      if (message.message?.case === "execServerMessage") releaseExecResult();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localToolResult?.body?.toolCallId, "read-large");
    assert.equal(localToolResult.init.keepalive, undefined);
    assert.equal(localToolResult.body.result.message.value.result.value.output.value.length, largeContent.length);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook maps raw redacted Cursor Read exec oneof when toJson omits result fields", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "67676767-6767-4676-8676-676767676767";
  const calls = [];
  let releaseExecResult;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          { type: "tool_use_done", id: "read-raw", name: "Read", arguments: "{\"path\":\"/tmp/raw\"}" },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => {
        throw new Error("BYOK AgentService Run must not fall through to upstream");
      },
    });

    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          message: {
            case: "runRequest",
            value: {
              conversationId: "conv-run",
              modelDetails: { modelId: "gpt55-sub2api" },
              requestedModel: { modelId: "gpt55-sub2api" },
            },
          },
        };
        await new Promise((resolve) => {
          releaseExecResult = resolve;
        });
        yield {
          toJson: () => ({ execClientMessage: { id: 1 } }),
          execClientMessage: {
            id: 1,
            redactedReadResult: {
              success: {
                path: "/tmp/raw",
                content: "raw oneof content",
                totalLines: 1,
                fileSize: 17,
              },
            },
          },
        };
      },
    };

    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "Run" },
      null,
      0,
      { "x-request-id": requestId },
      input,
    );
    for await (const message of byokStream.message) {
      if (message.message?.case === "execServerMessage") releaseExecResult();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const localToolResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localToolResult?.body?.toolCallId, "read-raw");
    assert.equal(localToolResult?.body?.result?.message?.case, "readResult");
    assert.equal(localToolResult?.body?.result?.message?.value?.result?.case, "success");
    assert.equal(localToolResult?.body?.result?.message?.value?.result?.value?.output?.value, "raw oneof content");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
  }
});
