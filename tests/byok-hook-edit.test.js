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

test("grey-box hook maps BYOK Write and GenerateImage events to Cursor-native tool envelopes", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "write-1",
            name: "Write",
            arguments: { path: "/tmp/byok-write.txt", contents: "hello" },
          },
          {
            type: "tool_use_done",
            id: "image-1",
            name: "GenerateImage",
            arguments: {
              description: "red square",
              filename: "/tmp/byok-image.png",
              reference_image_paths: ["/tmp/ref.png"],
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        return jsonResponse({
          ok: true,
          result: {
            id: JSON.parse(init.body).queryId,
            result: {
              case: "generateImageRequestResponse",
              value: { result: { case: "approved", value: { description: "red square" } } },
            },
          },
        });
      }
      if (String(url).endsWith("/byok/client-tool-completion")) {
        return jsonResponse({
          ok: true,
          completion: {
            case: "success",
            value: { filePath: "/tmp/byok-image.png" },
          },
        });
      }
      return jsonResponse({});
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
      { requestId: "62626262-6262-4626-8626-626262626262" },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    const starts = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallStarted")
      .map((message) => message.message.value.message.value.toolCall.tool);
    assert.equal(starts[0].case, "editToolCall");
    assert.deepEqual(starts[0].value.args, { path: "/tmp/byok-write.txt" });
    assert.equal(starts[1].case, "generateImageToolCall");
    assert.deepEqual(starts[1].value.args, {
      description: "red square",
      filePath: "/tmp/byok-image.png",
      referenceImagePaths: ["/tmp/ref.png"],
    });

    const execs = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value.message);
    assert.equal(execs.length, 1);
    assert.equal(execs[0].case, "writeArgs");
    assert.deepEqual(execs[0].value, {
      path: "/tmp/byok-write.txt",
      fileText: "hello",
      encodingHint: "utf8",
      toolCallId: "write-1",
    });
    const imageCompleted = messages
      .filter((message) => message.message?.value?.message?.case === "toolCallCompleted")
      .map((message) => message.message.value.message.value)
      .find((message) => message.callId === "image-1");
    assert.deepEqual(imageCompleted.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: { filePath: "/tmp/byok-image.png" },
      },
    });
    assert.equal(
      messages.some((message) => message.message?.case === "interactionQuery"),
      true,
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

test("grey-box hook executes ApplyPatch through read-then-write bridge with proto-valid writeArgs", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "63636363-6363-4636-8636-636363636363";
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
            id: "patch-1",
            name: "ApplyPatch",
            arguments: {
              patch: [
                "*** Begin Patch",
                "*** Add File: /tmp/byok-applypatch.txt",
                "+alpha",
                "+beta",
                "*** End Patch",
                "",
              ].join("\n"),
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "patch-1-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "patch-1-read-exec",
              message: {
                case: "readResult",
                value: { result: { case: "fileNotFound", value: { path: "/tmp/byok-applypatch.txt" } } },
              },
            },
          });
        }
        if (body.toolCallId === "patch-1-write") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "patch-1-write-exec",
              message: {
                case: "writeResult",
                value: { result: { case: "success", value: { path: "/tmp/byok-applypatch.txt" } } },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      return jsonResponse({});
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

    const execs = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value);
    assert.deepEqual(execs.map((exec) => exec.execId), ["patch-1-write"]);
    const execMessages = execs.map((exec) => exec.message);
    assert.deepEqual(execMessages.map((exec) => exec.case), ["writeArgs"]);
    assert.deepEqual(execMessages[0].value, {
      path: "/tmp/byok-applypatch.txt",
      fileText: "alpha\nbeta\n",
      toolCallId: "patch-1-write",
    });
    assert.doesNotThrow(() => strictCursorMessageCtor().fromJson({
      message: { case: "execServerMessage", value: { message: execMessages[0] } },
    }));
    const toolResultCalls = calls.filter((call) => call.url.endsWith("/byok/tool-result")).map((call) => call.body);
    assert.deepEqual(toolResultCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolArguments: call.toolArguments,
    })), [
      { toolCallId: "patch-1-read", toolName: "Read", toolArguments: { path: "/tmp/byok-applypatch.txt" } },
      {
        toolCallId: "patch-1-write",
        toolName: "Write",
        toolArguments: {
          path: "/tmp/byok-applypatch.txt",
          fileText: "alpha\nbeta\n",
          toolCallId: "patch-1-write",
        },
      },
    ]);
    assert.equal(toolResultCalls[0].directOnly, true);
    assert.equal(toolResultCalls[0].allowLargeRead, true);

    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResult.body.requestId, requestId);
    assert.equal(localResult.body.toolCallId, "patch-1");
    assert.equal(localResult.body.result.message.case, "editResult");
    assert.equal(localResult.body.result.message.value.result.case, "success");
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

test("grey-box hook aborts ApplyPatch bridge waits on cancel instead of stalling on write result", { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "73737373-7373-4737-8737-737373737373";
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
            id: "patch-cancel",
            name: "ApplyPatch",
            arguments: {
              patch: [
                "*** Begin Patch",
                "*** Add File: /tmp/byok-applypatch-cancel.txt",
                "+alpha",
                "*** End Patch",
                "",
              ].join("\n"),
            },
          },
          { type: "done", stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "patch-cancel-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "patch-cancel-read-exec",
              message: {
                case: "readResult",
                value: { result: { case: "fileNotFound", value: { path: "/tmp/byok-applypatch-cancel.txt" } } },
              },
            },
          });
        }
        if (body.toolCallId === "patch-cancel-write") {
          return await new Promise((resolve, reject) => {
            if (init.signal?.aborted) {
              reject(init.signal.reason || new Error("aborted"));
              return;
            }
            init.signal?.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")), { once: true });
          });
        }
      }
      return jsonResponse({ ok: true });
    };
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({ upstream: true }),
      stream: async () => ({ upstream: true }),
    });

    const abortController = new AbortController();
    const byokStream = await wrapped.stream(
      { typeName: "agent.v1.AgentService" },
      { name: "RunSSE" },
      abortController.signal,
      0,
      {},
      { requestId },
    );
    const abortTimer = setTimeout(() => abortController.abort(new Error("user stop")), 50);
    const startedAt = Date.now();
    const messages = [];
    try {
      for await (const message of byokStream.message) messages.push(message);
    } finally {
      clearTimeout(abortTimer);
    }

    assert(Date.now() - startedAt < 2000);
    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "toolCallStarted",
      "writeArgs",
      "turnEnded",
    ]);
    assert.equal(calls.some((call) => call.url.endsWith("/byok/local-tool-result")), false);
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

test("grey-box hook executes Edit through read-then-write bridge with final fileText", async () => {
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
            id: "edit-1",
            name: "Edit",
            arguments: {
              path: "/tmp/byok-edit.txt",
              old_string: "beta",
              new_string: "BETA",
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "edit-1-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-1-read-exec",
              message: {
                case: "readResult",
                value: {
                  result: {
                    case: "success",
                    value: { output: { case: "content", value: "alpha\nbeta\ngamma\n" } },
                  },
                },
              },
            },
          });
        }
        if (body.toolCallId === "edit-1-write") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-1-write-exec",
              message: {
                case: "writeResult",
                value: { result: { case: "success", value: { path: "/tmp/byok-edit.txt" } } },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      return jsonResponse({});
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

    const execs = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value);
    assert.deepEqual(execs.map((exec) => exec.execId), ["edit-1-write"]);
    const execMessages = execs.map((exec) => exec.message);
    assert.deepEqual(execMessages.map((exec) => exec.case), ["writeArgs"]);
    assert.deepEqual(execMessages[0].value, {
      path: "/tmp/byok-edit.txt",
      fileText: "alpha\nBETA\ngamma\n",
      toolCallId: "edit-1-write",
    });
    assert.doesNotThrow(() => strictCursorMessageCtor().fromJson({
      message: { case: "execServerMessage", value: { message: execMessages[0] } },
    }));
    const toolResultCalls = calls.filter((call) => call.url.endsWith("/byok/tool-result")).map((call) => call.body);
    assert.deepEqual(toolResultCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolArguments: call.toolArguments,
    })), [
      { toolCallId: "edit-1-read", toolName: "Read", toolArguments: { path: "/tmp/byok-edit.txt" } },
      {
        toolCallId: "edit-1-write",
        toolName: "Write",
        toolArguments: {
          path: "/tmp/byok-edit.txt",
          fileText: "alpha\nBETA\ngamma\n",
          toolCallId: "edit-1-write",
        },
      },
    ]);
    assert.equal(toolResultCalls[0].directOnly, true);
    assert.equal(toolResultCalls[0].allowLargeRead, true);

    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResult.body.requestId, requestId);
    assert.equal(localResult.body.toolCallId, "edit-1");
    assert.equal(localResult.body.result.message.case, "editResult");
    assert.equal(localResult.body.result.message.value.result.value.afterFullFileContent, "alpha\nBETA\ngamma\n");
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

test("grey-box hook executes provider Edit aliases through read-then-write bridge", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "65656565-6565-4565-8565-656565656565";
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
            id: "edit-1",
            name: "Edit",
            arguments: {
              filePath: "/tmp/byok-edit.txt",
              old: "beta",
              new: "BETA",
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "edit-1-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-1-read-exec",
              message: {
                case: "readResult",
                value: {
                  result: {
                    case: "success",
                    value: { output: { case: "content", value: "alpha\nbeta\ngamma\n" } },
                  },
                },
              },
            },
          });
        }
        if (body.toolCallId === "edit-1-write") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-1-write-exec",
              message: {
                case: "writeResult",
                value: { result: { case: "success", value: { path: "/tmp/byok-edit.txt" } } },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      return jsonResponse({});
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

    const execMessages = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value.message);
    assert.deepEqual(execMessages.map((exec) => exec.case), ["writeArgs"]);
    assert.deepEqual(execMessages[0].value, {
      path: "/tmp/byok-edit.txt",
      fileText: "alpha\nBETA\ngamma\n",
      toolCallId: "edit-1-write",
    });
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResult.body.toolCallId, "edit-1");
    assert.equal(localResult.body.result.message.value.result.case, "success");
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

test("grey-box hook falls back to native Read bridge when direct Edit read is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "67676767-6767-4676-8676-676767676767";
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
            id: "edit-fallback",
            name: "Edit",
            arguments: {
              path: "/tmp/byok-edit.txt",
              old_string: "beta",
              new_string: "BETA",
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "edit-fallback-read" && body.directOnly) {
          return jsonResponse({ ok: false, direct: false }, 404);
        }
        if (body.toolCallId === "edit-fallback-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-fallback-read-exec",
              message: {
                case: "readResult",
                value: {
                  result: {
                    case: "success",
                    value: { output: { case: "content", value: "alpha\nbeta\ngamma\n" } },
                  },
                },
              },
            },
          });
        }
        if (body.toolCallId === "edit-fallback-write") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-fallback-write-exec",
              message: {
                case: "writeResult",
                value: { result: { case: "success", value: { path: "/tmp/byok-edit.txt" } } },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      return jsonResponse({});
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

    const execMessages = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value.message);
    assert.deepEqual(execMessages.map((exec) => exec.case), ["readArgs", "writeArgs"]);
    assert.deepEqual(execMessages[0].value, { path: "/tmp/byok-edit.txt", toolCallId: "edit-fallback-read" });
    assert.deepEqual(execMessages[1].value, {
      path: "/tmp/byok-edit.txt",
      fileText: "alpha\nBETA\ngamma\n",
      toolCallId: "edit-fallback-write",
    });
    const toolResultCalls = calls.filter((call) => call.url.endsWith("/byok/tool-result")).map((call) => call.body);
    assert.equal(toolResultCalls[0].directOnly, true);
    assert.equal(toolResultCalls[1].directOnly, undefined);
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

test("grey-box hook returns provider-visible Edit error when old string is absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "66666666-6666-4666-8666-666666666666";
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
            id: "edit-miss",
            name: "Edit",
            arguments: {
              filePath: "/tmp/byok-edit.txt",
              oldString: "        if not row or row.startswith(\"#\"):\n            \n        parts = row.split(\",\")",
              newString: "        if not row or row.startswith(\"#\"):\n            continue\n        parts = row.split(\",\")",
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        if (body.toolCallId === "edit-miss-read") {
          return jsonResponse({
            ok: true,
            result: {
              execId: "edit-miss-read-exec",
              message: {
                case: "readResult",
                value: {
                  result: {
                    case: "success",
                    value: {
                      output: {
                        case: "content",
                        value: [
                          "    for row in rows:",
                          "        if not row or row.startswith(\"#\"):",
                          "            continue",
                          "        parts = row.split(\",\")",
                          "        amount = int(parts[1])",
                        ].join("\n"),
                      },
                    },
                  },
                },
              },
            },
          });
        }
      }
      if (String(url).endsWith("/byok/local-tool-result")) return jsonResponse({ ok: true });
      return jsonResponse({});
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

    const execMessages = messages
      .filter((message) => message.message?.case === "execServerMessage")
      .map((message) => message.message.value.message);
    assert.deepEqual(execMessages.map((exec) => exec.case), []);
    const localResult = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResult.body.toolCallId, "edit-miss");
    assert.equal(localResult.body.result.message.case, "editResult");
    assert.equal(localResult.body.result.message.value.result.case, "error");
    assert.match(localResult.body.result.message.value.result.value.error, /String to replace not found in file/);
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
