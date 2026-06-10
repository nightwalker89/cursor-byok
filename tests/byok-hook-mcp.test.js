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
const { strictCursorMessageCtor, jsonResponse, ndjsonResponse, approvedMcpAuthInteractionResponse, approvedSwitchModeInteractionResponse, answeredAskQuestionInteractionResponse, asyncIterable, withGreyBoxHookGlobals } = require("./byok-fixtures");

test("grey-box hook completes native MCP tool calls after Cursor exec result returns", async () => {
  const requestId = "77777777-7777-4777-8777-777777777777";
  const calls = [];
  await withGreyBoxHookGlobals(async () => {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/exec-map")) {
        return jsonResponse({ ok: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "mcp-call-1",
            name: "CallMcpTool",
            arguments: JSON.stringify({
              name: "user-filesystem-read_file",
              args: { path: "/tmp/a" },
              providerIdentifier: "user-filesystem",
              toolName: "read_file",
            }),
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          result: {
            execId: "mcp-call-1",
            message: {
              case: "mcpResult",
              value: {
                success: {
                  content: [{ type: "text", text: "file contents" }],
                },
              },
            },
          },
        });
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
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
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    assert.deepEqual(messages.map((message) => message.message?.value?.message?.case || message.message?.case), [
      "toolCallStarted",
      "mcpArgs",
      "toolCallCompleted",
      "stepCompleted",
    ]);
    assert.equal(messages[0].message.value.message.case, "toolCallStarted");
    assert.equal(messages[0].message.value.message.value.toolCall.tool.value.args.toolCallId, "mcp-call-1");
    assert.equal(messages[1].message.case, "execServerMessage");
    assert.equal(messages[1].message.value.message.case, "mcpArgs");
    assert.equal(messages[1].message.value.message.value.toolCallId, "mcp-call-1");
    assert.equal(messages[2].message.value.message.case, "toolCallCompleted");
    assert.equal(messages[2].message.value.message.value.toolCall.tool.value.args.toolCallId, "mcp-call-1");
    assert.deepEqual(messages[2].message.value.message.value.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: {
          content: [{ content: { case: "text", value: { text: "file contents" } } }],
        },
      },
    });
    const toolResultCall = calls.find((call) => call.url.endsWith("/byok/tool-result"));
    assert.deepEqual(toolResultCall.body, {
      requestId,
      toolCallId: "mcp-call-1",
      toolName: "CallMcpTool",
      toolArguments: {
        name: "user-filesystem-read_file",
        args: { path: "/tmp/a" },
        providerIdentifier: "user-filesystem",
        toolName: "read_file",
      },
    });
    const localResultCall = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResultCall.body.toolCallId, "mcp-call-1");
    assert.equal(localResultCall.body.result.message.case, "mcpResult");
    assert.deepEqual(localResultCall.body.result.message.value, {
      result: {
        case: "success",
        value: {
          content: [{ content: { case: "text", value: { text: "file contents" } } }],
        },
      },
    });
    delete require.cache[require.resolve("../src/workbench-hook")];
  });
});


test("grey-box hook bridges MCP auth as Cursor interaction query without native exec", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "78787878-7878-4787-8787-787878787878";
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
            id: "mcp-auth-1",
            name: "mcp_auth",
            arguments: { server_identifier: "user-atlassian" },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/interaction-response")) {
        return jsonResponse({ ok: true, result: approvedMcpAuthInteractionResponse(body.queryId) });
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
      "stepCompleted",
    ]);
    assert.equal(messages.some((message) => message.message?.case === "execServerMessage"), false);
    const started = messages[0].message.value.message.value;
    assert.equal(started.toolCall.tool.case, "mcpAuthToolCall");
    assert.deepEqual(started.toolCall.tool.value.args, {
      serverIdentifier: "user-atlassian",
      toolCallId: "mcp-auth-1",
    });
    assert.deepEqual(messages[1].message.value.query, {
      case: "mcpAuthRequestQuery",
      value: {
        args: {
          serverIdentifier: "user-atlassian",
          toolCallId: "mcp-auth-1",
        },
      },
    });
    const authCall = calls.find((call) => call.url.endsWith("/byok/interaction-response"));
    assert.deepEqual(authCall.body, {
      requestId,
      queryId: 100000,
      toolName: "mcp_auth",
      toolArguments: {
        serverIdentifier: "user-atlassian",
        toolCallId: "mcp-auth-1",
      },
    });
    const localResultCall = calls.find((call) => call.url.endsWith("/byok/local-tool-result"));
    assert.equal(localResultCall.body.toolCallId, "mcp-auth-1");
    assert.equal(localResultCall.body.result.message.case, "mcpAuthResult");
    assert.deepEqual(localResultCall.body.result.message.value, {
      result: {
        case: "success",
        value: { serverIdentifier: "user-atlassian" },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook completes MCP tool-not-found as a terminal error result", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "63636363-6363-4636-8636-636363636363";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "mcp-call-missing",
            name: "CallMcpTool",
            arguments: {
              name: "user-filesystem-read_file",
              args: { path: "/tmp/a" },
              providerIdentifier: "user-filesystem",
              toolName: "read_file",
            },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          result: {
            execId: "mcp-call-missing",
            message: {
              case: "mcpResult",
              value: {
                toolNotFound: {
                  name: "user-filesystem-read_file",
                  availableTools: ["user-filesystem-read_file"],
                },
              },
            },
          },
        });
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

    const completed = messages.find((message) => message.message?.value?.message?.case === "toolCallCompleted");
    assert.deepEqual(completed.message.value.message.value.toolCall.tool.value.result, {
      result: {
        case: "error",
        value: { error: "MCP tool not found: user-filesystem-read_file" },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    globalThis.__cursorByokReady = originalReady;
    globalThis.__cursorByokPatchApplied = originalPatch;
    globalThis.__cursorByokWrapTransport = originalWrap;
  }
});


test("grey-box hook completes MCP resource helper calls after Cursor exec result returns", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const requestId = "64646464-6464-4646-8646-646464646464";
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/should-handle")) return jsonResponse({ handle: true });
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "mcp-list-1",
            name: "ListMcpResources",
            arguments: { server: "docs" },
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          result: {
            execId: "mcp-list-1",
            message: {
              case: "listMcpResourcesExecResult",
              value: {
                success: {
                  resources: [{ server: "docs", uri: "doc://alpha", name: "Alpha" }],
                },
              },
            },
          },
        });
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
      "listMcpResourcesExecArgs",
      "toolCallCompleted",
      "stepCompleted",
    ]);
    assert.equal(messages[1].message.case, "execServerMessage");
    const completed = messages[2].message.value.message.value;
    assert.equal(completed.toolCall.tool.case, "listMcpResourcesToolCall");
    assert.deepEqual(completed.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: {
          resources: [{ server: "docs", uri: "doc://alpha", name: "Alpha" }],
        },
      },
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


test("grey-box hook passes through server-normalized MCP result envelopes unchanged", async () => {
  // Production traffic hits this branch: the BYOK server pre-normalizes exec
  // results into {result:{case,value}} envelopes before responding, so the
  // hook's tolerant flat-oneof fallback must NOT rewrap them.
  const requestId = "78787878-7878-4787-8787-787878787878";
  const calls = [];
  await withGreyBoxHookGlobals(async () => {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("/byok/should-handle")) {
        return jsonResponse({ handle: true });
      }
      if (String(url).endsWith("/byok/exec-map")) {
        return jsonResponse({ ok: true });
      }
      if (String(url).endsWith("/byok/run")) {
        return ndjsonResponse([
          {
            type: "tool_use_done",
            id: "mcp-pass-1",
            name: "CallMcpTool",
            arguments: JSON.stringify({
              name: "user-filesystem-read_file",
              args: { path: "/tmp/a" },
              providerIdentifier: "user-filesystem",
              toolName: "read_file",
            }),
          },
          { type: "done", stopReason: "tool_use" },
        ]);
      }
      if (String(url).endsWith("/byok/tool-result")) {
        return jsonResponse({
          ok: true,
          result: {
            execId: "mcp-pass-1",
            message: {
              case: "mcpResult",
              value: {
                result: {
                  case: "success",
                  value: {
                    content: [{ content: { case: "text", value: { text: "normalized contents" } } }],
                  },
                },
              },
            },
          },
        });
      }
      if (String(url).endsWith("/byok/local-tool-result")) {
        return jsonResponse({ ok: true });
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
      { requestId },
    );
    const messages = [];
    for await (const message of byokStream.message) messages.push(message);

    const completed = messages
      .map((message) => message.message?.value?.message)
      .find((update) => update?.case === "toolCallCompleted");
    assert.notEqual(completed, undefined);
    assert.deepEqual(completed.value.toolCall.tool.value.result, {
      result: {
        case: "success",
        value: {
          content: [{ content: { case: "text", value: { text: "normalized contents" } } }],
        },
      },
    });
  });
});
