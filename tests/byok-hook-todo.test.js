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
const { strictCursorMessageCtor, jsonResponse, ndjsonResponse, approvedMcpAuthInteractionResponse, approvedSwitchModeInteractionResponse, answeredAskQuestionInteractionResponse, asyncIterable } = require("./byok-fixtures");

const TODO_STATUS = {
  PENDING: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  CANCELLED: 4,
};

test("grey-box hook completes TodoWrite locally instead of sending unsupported tool result", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646464";
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
            id: "todo-1",
            name: "TodoWrite",
            arguments: {
              todos: [{ id: "1", content: "Check read tool", status: "in_progress" }],
              merge: false,
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
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
      "toolCallCompleted",
      "stepCompleted",
    ]);
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    const started = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallStarted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "todo-1");
    assert.equal(started.toolCall.tool.case, "updateTodosToolCall");
    assert.equal(started.toolCall.tool.value.args, undefined);
    assert.doesNotThrow(() => strictCursorMessageCtor().fromJson(messages.find((message) => (
      message.message?.value?.message?.case === "toolCallStarted" &&
      message.message.value.message.value.callId === "todo-1"
    ))));
    const completed = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "todo-1");
    assert.deepEqual(completed.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: {
          todos: [{ id: "1", content: "Check read tool", status: TODO_STATUS.IN_PROGRESS }],
          totalCount: 1,
          wasMerge: false,
        },
      },
    });
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResult.body.toolCallId, "todo-1");
    assert.equal(localResult.body.result.message.case, "todoWriteResult");
    assert.equal(localResult.body.result.message.value.result.case, "success");
    assert.deepEqual(localResult.body.result.message.value.result.value, {
      todos: [{ id: "1", content: "Check read tool", status: "in_progress" }],
      merge: false,
    });
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


test("grey-box hook accepts TodoWrite without merge and uses replace semantics", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646466";
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
            id: "todo-no-merge",
            name: "TodoWrite",
            arguments: {
              todos: [{ id: "1", content: "Check todo schema", status: "in_progress" }],
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
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

    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    const completed = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "todo-no-merge");
    assert.deepEqual(completed.toolCall.tool.value.result.result.value, {
      todos: [{ id: "1", content: "Check todo schema", status: TODO_STATUS.IN_PROGRESS }],
      totalCount: 1,
      wasMerge: false,
    });
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResult.body.result.message.value.result.value, {
      todos: [{ id: "1", content: "Check todo schema", status: "in_progress" }],
      merge: false,
    });
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


test("grey-box hook ignores TodoWrite dependencies copied from CreatePlan", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646467";
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
            id: "todo-with-deps",
            name: "TodoWrite",
            arguments: {
              todos: [{ id: "1", content: "Check todo deps", status: "in_progress", dependencies: ["0"] }],
              merge: true,
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
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

    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    const completed = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "todo-with-deps");
    assert.deepEqual(completed.toolCall.tool.value.result.result.value, {
      todos: [{ id: "1", content: "Check todo deps", status: TODO_STATUS.IN_PROGRESS }],
      totalCount: 1,
      wasMerge: true,
    });
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResult.body.result.message.value.result.value, {
      todos: [{ id: "1", content: "Check todo deps", status: "in_progress" }],
      merge: true,
    });
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


test("grey-box hook derives native TODO UI result while keeping provider todoWriteResult payload", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646465";
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
            id: "todo-merge-1",
            name: "TodoWrite",
            arguments: {
              todos: [{ content: "Check single evaluation", status: "in_progress" }],
              merge: true,
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
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

    const completed = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "todo-merge-1");
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(completed.toolCall.tool.value.result.result.value, {
      todos: [{ content: "Check single evaluation", status: TODO_STATUS.IN_PROGRESS }],
      totalCount: 1,
      wasMerge: true,
    });
    assert.deepEqual(localResult.body.result.message.value.result.value.todos, [{
      content: "Check single evaluation",
      status: "in_progress",
    }]);
    assert.equal(localResult.body.result.message.value.result.value.merge, true);
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


test("grey-box hook completes Cursor task todo aliases locally", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "65656565-6565-4656-8656-656565656565";
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
            id: "task-create-1",
            name: "TaskCreate",
            arguments: { subject: "inspect fixture", description: "inspect fixture" },
          },
          {
            type: "tool_use_done",
            id: "task-update-1",
            name: "TaskUpdate",
            arguments: { taskId: "task-create-1", status: "completed" },
          },
          {
            type: "tool_use_done",
            id: "task-list-1",
            name: "TaskList",
            arguments: {},
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
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

    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    const completed = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value.toolCall.tool.value.result.result.value);
    assert.deepEqual(completed, [
      {
        todos: [{ id: "task-create-1", content: "inspect fixture", status: TODO_STATUS.IN_PROGRESS }],
        totalCount: 1,
        wasMerge: true,
      },
      {
        todos: [{ id: "task-create-1", content: "inspect fixture", status: TODO_STATUS.COMPLETED }],
        totalCount: 1,
        wasMerge: true,
      },
      {
        todos: [{ id: "task-create-1", content: "inspect fixture", status: TODO_STATUS.COMPLETED }],
        totalCount: 1,
        wasMerge: true,
      },
    ]);
    const localResults = calls.filter((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResults.map((call) => call.body.toolCallId), ["task-create-1", "task-update-1", "task-list-1"]);
    assert.equal(localResults[0].body.result.message.case, "todoWriteResult");
    assert.equal(localResults[1].body.result.message.case, "todoWriteResult");
    assert.equal(localResults[2].body.result.message.case, "todoWriteResult");
    assert.deepEqual(localResults[0].body.result.message.value.result.value.todos, [{
      id: "task-create-1",
      content: "inspect fixture",
      status: "in_progress",
    }]);
    assert.deepEqual(localResults[1].body.result.message.value.result.value.todos, [{
      id: "task-create-1",
      content: "inspect fixture",
      status: "completed",
    }]);
    assert.deepEqual(localResults[2].body.result.message.value.result.value.todos, [{
      id: "task-create-1",
      content: "inspect fixture",
      status: "completed",
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


test("grey-box hook keeps Cursor task todo aliases across split RunSSE requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const conversationId = "75757575-7575-4757-8757-757575757575";
  const requestIds = [
    "65656565-6565-4656-8656-656565656566",
    "65656565-6565-4656-8656-656565656567",
  ];
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
        if (body.requestId === requestIds[0]) {
          return ndjsonResponse([
            {
              type: "tool_use_done",
              id: "task-create-split",
              name: "TaskCreate",
              arguments: { subject: "split fixture", description: "split fixture" },
            },
            {
              type: "tool_use_done",
              id: "task-update-split",
              name: "TaskUpdate",
              arguments: { taskId: "task-create-split", status: "completed" },
            },
            { type: "done", stopReason: "tool_use" },
          ]);
        }
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "task-list-split",
            name: "TaskList",
            arguments: {},
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });

    const messagesByRequest = [];
    for (const requestId of requestIds) {
      const byokStream = await wrapped.stream(
        { typeName: "agent.v1.AgentService" },
        { name: "RunSSE" },
        null,
        0,
        {},
        { requestId, conversationState: { conversationId } },
      );
      const requestMessages = [];
      for await (const message of byokStream.message) {
        requestMessages.push(message);
      }
      messagesByRequest.push(requestMessages);
    }

    const localResults = calls.filter((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.deepEqual(localResults.map((call) => call.body.toolCallId), [
      "task-create-split",
      "task-update-split",
      "task-list-split",
    ]);
    assert.deepEqual(localResults[2].body.result.message.value.result.value.todos, [{
      id: "task-create-split",
      content: "split fixture",
      status: "completed",
    }]);
    // The second request's UI stream must also surface the cross-request todo
    // store via a completed updateTodosToolCall, not just the local-tool-result
    // POST body.
    const listCompleted = messagesByRequest[1]
      .map((message) => message.message?.value?.message)
      .find((update) => update?.case === "toolCallCompleted" && update.value.callId === "task-list-split");
    assert.notEqual(listCompleted, undefined, "second request must complete the TaskList tool call in the UI stream");
    assert.equal(listCompleted.value.toolCall.tool.case, "updateTodosToolCall");
    assert.deepEqual(
      listCompleted.value.toolCall.tool.value.result.result.value.todos.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
      })),
      [{ id: "task-create-split", content: "split fixture", status: 3 }],
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
