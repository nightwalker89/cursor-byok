"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  collectOpenAiResponsesEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
  streamOpenAiResponsesEvents,
} = require("../src/server/provider-adapter");
const { mcpAuthProviderTool, quietLog, deferred, tick, asyncIterable, snapshotJson, interceptModule, interceptModules, createProviderAdapter, runConcurrentReadToolWaits } = require("./byok-fixtures");

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function extractRuntimeNativeResponsesInputTypes(source) {
  const match = source.match(/const NATIVE_RESPONSES_INPUT_ITEM_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "NATIVE_RESPONSES_INPUT_ITEM_TYPES set not found");
  return sortedUnique([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function extractOpenAiSdkResponseItemTypes(source, aliasName) {
  const unionMatch = source.match(new RegExp(`export type ${aliasName} = ([\\s\\S]*?);`));
  assert.ok(unionMatch, `${aliasName} union not found`);
  return sortedUnique(unionMatch[1].split("|")
    .map((member) => openAiSdkResponseItemTypeLiteral(source, member.trim()))
    .filter(Boolean));
}

function openAiSdkResponseItemTypeLiteral(source, member) {
  const parts = member.split(".");
  const name = parts.pop();
  const scope = parts.length ? parts.join(".") : "";
  const body = scope
    ? openAiSdkScopedInterfaceBody(source, scope, name)
    : openAiSdkTopLevelInterfaceBody(source, name);
  const typeMatch = body?.match(/type\??:\s*'([^']+)'/);
  return typeMatch?.[1];
}

function openAiSdkScopedInterfaceBody(source, scope, name) {
  const namespaceStart = source.indexOf(`export declare namespace ${scope} {`);
  if (namespaceStart < 0) return "";
  const namespaceEnd = source.indexOf("\n}", namespaceStart);
  const interfaceStart = source.indexOf(`    interface ${name} {`, namespaceStart);
  if (interfaceStart < 0 || interfaceStart > namespaceEnd) return "";
  const interfaceEnd = source.indexOf("\n    }", interfaceStart);
  return interfaceEnd < 0 || interfaceEnd > namespaceEnd ? "" : source.slice(interfaceStart, interfaceEnd);
}

function openAiSdkTopLevelInterfaceBody(source, name) {
  const interfaceStart = source.indexOf(`export interface ${name} {`);
  if (interfaceStart < 0) return "";
  const interfaceEnd = source.indexOf("\n}", interfaceStart);
  return interfaceEnd < 0 ? "" : source.slice(interfaceStart, interfaceEnd);
}

test("OpenAI Responses native item whitelist matches SDK item unions", () => {
  const providerAdapterSource = fs.readFileSync(path.join(__dirname, "..", "src/server/provider-adapter.js"), "utf8");
  const openAiResponsesDts = fs.readFileSync(path.join(__dirname, "..", "node_modules/openai/resources/responses/responses.d.ts"), "utf8");
  const specializedResponseTypes = ["function_call", "function_call_output", "message"];
  const runtimeTypes = extractRuntimeNativeResponsesInputTypes(providerAdapterSource);
  const sdkInputTypes = extractOpenAiSdkResponseItemTypes(openAiResponsesDts, "ResponseInputItem");
  const sdkOutputTypes = extractOpenAiSdkResponseItemTypes(openAiResponsesDts, "ResponseOutputItem");

  assert.deepEqual(
    runtimeTypes,
    sdkInputTypes.filter((type) => !specializedResponseTypes.includes(type)).sort(),
  );
  assert.deepEqual(
    sdkOutputTypes.filter((type) => !specializedResponseTypes.includes(type) && !runtimeTypes.includes(type)),
    [],
  );
});

test("OpenAI Responses provider never sets a completion token limit", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: {
        id: "byok-model",
        apiModel: "fake-responses-model",
        contextTokenLimit: 200000,
        contextTokenLimitForMaxMode: 200000,
        maxOutputTokens: 128000,
      },
      request: {
        conversationId: "conv-responses-no-completion-limit",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      },
      requestId: "req-responses-no-completion-limit",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].parallel_tool_calls, true);
    assert.equal(Object.prototype.hasOwnProperty.call(requests[0], "max_output_tokens"), false);
  } finally {
    restore();
  }
});

test("OpenAI Responses stream collector forwards refusal text deltas", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.refusal.delta", delta: "cannot" },
    { type: "response.refusal.delta", delta: " comply" },
    { type: "response.refusal.done", refusal: "cannot comply" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["cannot", " comply"]);
  assert.deepEqual(events.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 },
  });
});

test("OpenAI Responses stream collector forwards message text from output item done", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "final answer" },
          { type: "refusal", refusal: "cannot comply" },
        ],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "final answer",
    "cannot comply",
  ]);
  assert.deepEqual(events.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

test("OpenAI Responses stream collector does not duplicate output item done after text deltas", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: "final" },
    { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: " answer" },
    {
      type: "response.output_item.done",
      item_id: "msg-1",
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final answer" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["final", " answer"]);
});

test("OpenAI Responses stream collector only suppresses done text for matching content parts", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: "first" },
    {
      type: "response.output_item.done",
      item_id: "msg-1",
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "first" },
          { type: "output_text", text: "second" },
          { type: "refusal", refusal: "third" },
        ],
      },
    },
    {
      type: "response.output_item.done",
      item_id: "msg-2",
      item: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "fourth" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "first",
    "second",
    "third",
    "fourth",
  ]);
});

test("OpenAI Responses stream collector suppresses done fallback for item-scoped deltas without content index", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.delta", item_id: "msg-1", delta: "final answer" },
    {
      type: "response.output_item.done",
      item_id: "msg-1",
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final answer" }],
      },
    },
    {
      type: "response.output_item.done",
      item_id: "msg-2",
      item: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second answer" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "final answer",
    "second answer",
  ]);
});

test("OpenAI Responses stream collector forwards finalized text events when deltas are absent", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.done", item_id: "msg-1", content_index: 0, text: "final answer" },
    { type: "response.refusal.done", item_id: "msg-1", content_index: 1, refusal: "cannot comply" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "final answer",
    "cannot comply",
  ]);
});

test("OpenAI Responses stream collector forwards content part done text when deltas are absent", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.content_part.done",
      item_id: "msg-1",
      content_index: 0,
      part: { type: "output_text", text: "part text" },
    },
    {
      type: "response.content_part.done",
      item_id: "msg-1",
      content_index: 1,
      part: { type: "refusal", refusal: "part refusal" },
    },
    {
      type: "response.content_part.done",
      item_id: "msg-1",
      content_index: 2,
      part: { type: "reasoning_text", text: "hidden reasoning" },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "part text",
    "part refusal",
  ]);
});

test("OpenAI Responses stream collector does not duplicate finalized text after deltas", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: "final" },
    { type: "response.output_text.delta", item_id: "msg-1", content_index: 0, delta: " answer" },
    { type: "response.output_text.done", item_id: "msg-1", content_index: 0, text: "final answer" },
    {
      type: "response.content_part.done",
      item_id: "msg-1",
      content_index: 0,
      part: { type: "output_text", text: "final answer" },
    },
    { type: "response.refusal.delta", item_id: "msg-1", content_index: 1, delta: "cannot" },
    { type: "response.refusal.done", item_id: "msg-1", content_index: 1, refusal: "cannot" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), [
    "final",
    " answer",
    "cannot",
  ]);
});

test("OpenAI Responses stream collector forwards reasoning summary deltas as thinking", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "checked" },
    { type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: " files" },
    { type: "response.reasoning_summary_text.done", item_id: "rs-1", output_index: 0, summary_index: 0, text: "checked files" },
    {
      type: "response.output_item.done",
      item_id: "rs-1",
      item: {
        id: "rs-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checked files" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.text), [
    "checked",
    " files",
  ]);
  assert.equal(events.filter((event) => event.type === "thinking_done").length, 1);
  // The collector hides provider_history_item from the hook, so asserting its
  // absence on collector output is vacuous. The raw stream MUST emit one for
  // the reasoning item — that is what lets follow-up requests preserve
  // reasoning history.
  const rawEvents = [];
  for await (const event of streamOpenAiResponsesEvents(asyncIterable([
    { type: "response.reasoning_summary_text.delta", item_id: "rs-1", output_index: 0, summary_index: 0, delta: "checked" },
    {
      type: "response.output_item.done",
      item_id: "rs-1",
      item: {
        id: "rs-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checked" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]))) {
    rawEvents.push(event);
  }
  const historyItems = rawEvents.filter((event) => event.type === "provider_history_item");
  assert.equal(historyItems.length, 1);
  assert.equal(historyItems[0].item.type, "reasoning");
  assert.deepEqual(events.slice(-2), [
    { type: "thinking_done" },
    { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
});

test("OpenAI Responses stream collector forwards done-only reasoning summaries", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.reasoning_summary_text.done", item_id: "rs-1", output_index: 0, summary_index: 0, text: "first summary" },
    {
      type: "response.reasoning_summary_part.done",
      item_id: "rs-1",
      output_index: 0,
      summary_index: 1,
      part: { type: "summary_text", text: "second summary" },
    },
    {
      type: "response.output_item.done",
      item_id: "rs-1",
      item: {
        id: "rs-1",
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "first summary" },
          { type: "summary_text", text: "second summary" },
          { type: "summary_text", text: "third summary" },
        ],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.text), [
    "first summary",
    "second summary",
    "third summary",
  ]);
  assert.equal(events.filter((event) => event.type === "thinking_done").length, 1);
});

test("OpenAI Responses stream collector forwards reasoning item summaries when summary events are absent", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.output_item.done",
      item: {
        id: "rs-1",
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "inspected contracts" },
          { type: "summary_text", text: "kept raw reasoning hidden" },
        ],
        content: [{ type: "reasoning_text", text: "private chain of thought" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => event.text), [
    "inspected contracts",
    "kept raw reasoning hidden",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "text_delta"), []);
  assert.equal(events.filter((event) => event.type === "thinking_done").length, 1);
});

test("OpenAI Responses stream collector suppresses raw reasoning text events", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.reasoning_text.delta", item_id: "rs-1", output_index: 0, content_index: 0, delta: "private" },
    { type: "response.reasoning_text.done", item_id: "rs-1", output_index: 0, content_index: 0, text: "private reasoning" },
    {
      type: "response.output_item.done",
      item: {
        id: "rs-1",
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "private reasoning" }],
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "text_delta"), []);
  assert.deepEqual(events.filter((event) => event.type === "thinking_delta"), []);
  assert.equal(events.some((event) => event.type === "thinking_done"), false);
  assert.deepEqual(events.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

test("OpenAI Responses stream collector preserves native history items", async () => {
  const { streamOpenAiResponsesEvents } = require("../src/server/provider-adapter");
  const nativeItems = [
    {
      id: "mcp-1",
      type: "mcp_call",
      call_id: "mcp-call-1",
      name: "search",
      server_label: "docs",
      arguments: "{\"query\":\"BYOK\"}",
      output: "result",
      status: "completed",
    },
    {
      id: "file-search-1",
      type: "file_search_call",
      queries: ["BYOK"],
      status: "completed",
      results: [],
    },
    {
      id: "web-search-1",
      type: "web_search_call",
      action: { type: "search", query: "BYOK" },
      status: "completed",
    },
    {
      id: "tool-search-output-1",
      type: "tool_search_output",
      call_id: "tool-search-1",
      execution: "server",
      status: "completed",
      tools: [],
    },
    {
      id: "fco-1",
      type: "function_call_output",
      call_id: "call-1",
      output: "already completed",
      status: "completed",
    },
  ];
  const events = [];
  for await (const event of streamOpenAiResponsesEvents(asyncIterable([
    ...nativeItems.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]))) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === "provider_history_item").map((event) => event.item), nativeItems);
  assert.deepEqual(events.at(-1), {
    type: "done",
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

test("OpenAI Responses stream collector reports terminal error events", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "error", code: "rate_limit_exceeded", message: "slow down", param: "model", sequence_number: 2 },
  ]));

  assert.deepEqual(events.map((event) => event.type), ["text_delta", "text_delta", "done"]);
  assert.equal(events[0].text, "partial");
  assert.equal(events[1].text, "OpenAI Responses error (rate_limit_exceeded, model): slow down");
  assert.deepEqual(events[2], {
    type: "done",
    stopReason: "error",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
});

test("OpenAI Responses stream collector reports failed responses with usage", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.failed",
      response: {
        error: { code: "server_error", message: "upstream exploded" },
        usage: { input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
      },
    },
  ]));

  assert.deepEqual(events, [
    { type: "text_delta", text: "OpenAI Responses failed (server_error): upstream exploded" },
    { type: "done", stopReason: "error", usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 4 } },
  ]);
});

test("OpenAI Responses stream collector reports incomplete responses with usage", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 17, output_tokens: 128, input_tokens_details: { cached_tokens: 9 } },
      },
    },
  ]));

  assert.deepEqual(events, [
    { type: "text_delta", text: "OpenAI Responses incomplete: max_output_tokens" },
    { type: "done", stopReason: "error", usage: { inputTokens: 17, outputTokens: 128, cacheReadTokens: 9 } },
  ]);
});

test("OpenAI Responses stream collector preserves custom tool call input events", async () => {
  const events = await collectOpenAiResponsesEvents(asyncIterable([
    {
      type: "response.output_item.added",
      item: {
        id: "ctc-item",
        type: "custom_tool_call",
        call_id: "custom-1",
        name: "Read",
        input: "initial",
      },
    },
    { type: "response.custom_tool_call_input.delta", item_id: "ctc-item", delta: " streamed" },
    { type: "response.custom_tool_call_input.done", item_id: "ctc-item", input: "final custom input" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));

  assert.deepEqual(events.filter((event) => event.type === "tool_use_start"), [{
    type: "tool_use_start",
    id: "custom-1",
    name: "Read",
    providerToolType: "custom_tool_call",
    itemId: "ctc-item",
  }]);
  assert.deepEqual(events.filter((event) => event.type === "tool_use_delta"), [{
    type: "tool_use_delta",
    id: "custom-1",
    input: " streamed",
  }]);
  assert.deepEqual(events.find((event) => event.type === "tool_use_done"), {
    type: "tool_use_done",
    id: "custom-1",
    name: "Read",
    arguments: "final custom input",
    providerToolType: "custom_tool_call",
    itemId: "ctc-item",
  });
  assert.equal(events.at(-1).stopReason, "tool_use");
});

test("OpenAI Responses provider sends canonical built-in tool names", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-canonical-tools",
        messages: [{ role: "user", content: "read" }],
        tools: [{
          name: "read_alias",
          canonicalName: "Read",
          description: "read alias",
          inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
        }],
      },
      requestId: "req-responses-canonical-tools",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      // drain stream
    }

    assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["Read"]);
    assert.deepEqual(Object.keys(requests[0].tools[0].parameters.properties), ["path", "offset", "limit"]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider loop sends explicit client tool completions back as function outputs", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-web", type: "function_call", call_id: "web-1", name: "WebSearch" } },
              { type: "response.function_call_arguments.done", item_id: "fc-web", arguments: "{\"search_term\":\"Cursor BYOK\"}" },
              { type: "response.output_item.added", item: { id: "fc-image", type: "function_call", call_id: "image-1", name: "GenerateImage" } },
              { type: "response.function_call_arguments.done", item_id: "fc-image", arguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" },
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-client-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "search and draw" }],
        tools: [
          {
            name: "WebSearch",
            description: "Cursor web search",
            inputSchema: { type: "object", properties: { search_term: { type: "string" } }, required: ["search_term"] },
          },
          {
            name: "GenerateImage",
            description: "Cursor image generation",
            inputSchema: { type: "object", properties: { description: { type: "string" }, filename: { type: "string" } }, required: ["description"] },
          },
        ],
      },
      requestId: "req-responses-client-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        if (toolCallId === "web-1") {
          return {
            message: {
              case: "byokInteractionToolResult",
              value: {
                toolName: "WebSearch",
                clientCompletion: {
                  case: "success",
                  value: { references: [{ title: "Cursor BYOK docs", url: "https://example.com/byok" }] },
                },
              },
            },
          };
        }
        return {
          message: {
            case: "byokInteractionToolResult",
            value: {
              toolName: "GenerateImage",
              clientCompletion: {
                case: "success",
                value: { filePath: "/tmp/out.png" },
              },
            },
          },
        };
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "WebSearch"), true);
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "GenerateImage"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: "{\"search_term\":\"Cursor BYOK\"}" } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" } },
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-4), [
      { type: "function_call", id: "fc-web", call_id: "web-1", name: "WebSearch", arguments: "{\"search_term\":\"Cursor BYOK\"}" },
      { type: "function_call_output", call_id: "web-1", output: "Cursor BYOK docs (https://example.com/byok)" },
      { type: "function_call", id: "fc-image", call_id: "image-1", name: "GenerateImage", arguments: "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\"}" },
      { type: "function_call_output", call_id: "image-1", output: "Generated image at /tmp/out.png" },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider repairs client tool aliases before Cursor execution and follow-up history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-web", type: "function_call", call_id: "web-1", name: "WebSearch" } },
              { type: "response.function_call_arguments.done", item_id: "fc-web", arguments: "{\"searchTerm\":\"Cursor BYOK\"}" },
              { type: "response.output_item.added", item: { id: "fc-image", type: "function_call", call_id: "image-1", name: "GenerateImage" } },
              { type: "response.function_call_arguments.done", item_id: "fc-image", arguments: "{\"description\":\"diagram\",\"filePath\":\"/tmp/out.png\",\"referenceImagePaths\":[\"/tmp/ref.png\"]}" },
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-client-tool-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "search and draw" }],
        tools: [
          {
            name: "WebSearch",
            description: "Cursor web search",
            inputSchema: { type: "object", properties: { search_term: { type: "string" } }, required: ["search_term"] },
          },
          {
            name: "GenerateImage",
            description: "Cursor image generation",
            inputSchema: { type: "object", properties: { description: { type: "string" }, filename: { type: "string" }, reference_image_paths: { type: "array", items: { type: "string" } } }, required: ["description"] },
          },
        ],
      },
      requestId: "req-responses-client-tool-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        if (toolCallId === "web-1") {
          return {
            message: {
              case: "byokInteractionToolResult",
              value: {
                toolName: "WebSearch",
                clientCompletion: {
                  case: "success",
                  value: { references: [{ title: "Cursor BYOK docs", url: "https://example.com/byok" }] },
                },
              },
            },
          };
        }
        return {
          message: {
            case: "byokInteractionToolResult",
            value: {
              toolName: "GenerateImage",
              clientCompletion: {
                case: "success",
                value: { filePath: "/tmp/out.png" },
              },
            },
          },
        };
      },
    })) {
      // drain stream
    }

    const webArgs = "{\"search_term\":\"Cursor BYOK\"}";
    const imageArgs = "{\"description\":\"diagram\",\"filename\":\"/tmp/out.png\",\"reference_image_paths\":[\"/tmp/ref.png\"]}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [
      { toolCallId: "web-1", options: { toolName: "WebSearch", toolArguments: webArgs } },
      { toolCallId: "image-1", options: { toolName: "GenerateImage", toolArguments: imageArgs } },
    ]);
    assert.deepEqual(requests[1].input.slice(-4), [
      { type: "function_call", id: "fc-web", call_id: "web-1", name: "WebSearch", arguments: webArgs },
      { type: "function_call_output", call_id: "web-1", output: "Cursor BYOK docs (https://example.com/byok)" },
      { type: "function_call", id: "fc-image", call_id: "image-1", name: "GenerateImage", arguments: imageArgs },
      { type: "function_call_output", call_id: "image-1", output: "Generated image at /tmp/out.png" },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider returns filtered launch tool errors as function outputs", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-task", type: "function_call", call_id: "task-1", name: "Task" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task", arguments: "{\"description\":\"launch task\"}" },
              { type: "response.output_item.added", item: { id: "fc-subagent", type: "function_call", call_id: "subagent-1", name: "Subagent" } },
              { type: "response.function_call_arguments.done", item_id: "fc-subagent", arguments: "{\"prompt\":\"launch subagent\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-filtered-launch-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try launch" }],
        tools: [{
          name: "Task",
          description: "launch task",
          inputSchema: { type: "object", properties: { description: { type: "string" } } },
        }, {
          name: "Subagent",
          description: "launch subagent",
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
        }],
      },
      requestId: "req-responses-filtered-launch-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["Task", "unsupportedToolResult"], ["Subagent", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-4), [{
      type: "function_call",
      id: "fc-task",
      call_id: "task-1",
      name: "Task",
      arguments: "{\"description\":\"launch task\"}",
    }, {
      type: "function_call_output",
      call_id: "task-1",
      output: requests[1].input.at(-3).output,
    }, {
      type: "function_call",
      id: "fc-subagent",
      call_id: "subagent-1",
      name: "Subagent",
      arguments: "{\"prompt\":\"launch subagent\"}",
    }, {
      type: "function_call_output",
      call_id: "subagent-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-3).output, /Invalid Task input/);
    assert.match(requests[1].input.at(-3).output, /filtered in BYOK mode/);
    assert.match(requests[1].input.at(-3).output, /not available as a BYOK provider tool/);
    assert.match(requests[1].input.at(-1).output, /Invalid Subagent input/);
    assert.match(requests[1].input.at(-1).output, /filtered in BYOK mode/);
    assert.match(requests[1].input.at(-1).output, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider returns unknown tool errors as function outputs without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-unknown", type: "function_call", call_id: "unknown-1", name: "UnknownTool" } },
              { type: "response.function_call_arguments.done", item_id: "fc-unknown", arguments: "{}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-unknown-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try unknown" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-unknown-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["UnknownTool", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-unknown",
      call_id: "unknown-1",
      name: "UnknownTool",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "unknown-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-1).output, /Invalid UnknownTool input/);
    assert.match(requests[1].input.at(-1).output, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider returns custom tool errors as custom outputs without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              {
                type: "response.output_item.added",
                item: {
                  id: "ctc-read-item",
                  type: "custom_tool_call",
                  call_id: "custom-read-1",
                  name: "Read",
                },
              },
              { type: "response.custom_tool_call_input.done", item_id: "ctc-read-item", input: "read /tmp/a" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-custom-tool",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try custom Read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-custom-tool",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["Read", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "custom_tool_call",
      call_id: "custom-read-1",
      name: "Read",
      input: "read /tmp/a",
      id: "ctc-read-item",
    }, {
      type: "custom_tool_call_output",
      call_id: "custom-read-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-1).output, /Invalid Read input/);
    assert.match(requests[1].input.at(-1).output, /BYOK exposes Cursor tools to OpenAI Responses as function tools/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider accepts custom tool calls from output_item.done without added", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              {
                type: "response.output_item.done",
                item: {
                  id: "ctc-read-item",
                  type: "custom_tool_call",
                  call_id: "custom-read-1",
                  name: "Read",
                  input: "read /tmp/a",
                },
              },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-custom-tool-done-only",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try custom Read" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-custom-tool-done-only",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(waitCalls, []);
    assert.equal(events.some((event) => event.type === "tool_use_start" && event.name === "Read"), true);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["Read", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "custom_tool_call",
      call_id: "custom-read-1",
      name: "Read",
      input: "read /tmp/a",
      id: "ctc-read-item",
    }, {
      type: "custom_tool_call_output",
      call_id: "custom-read-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-1).output, /Invalid Read input/);
    assert.match(requests[1].input.at(-1).output, /BYOK exposes Cursor tools to OpenAI Responses as function tools/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider rejects default-catalog ReadFile as function output without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-readfile", type: "function_call", call_id: "readfile-1", name: "ReadFile" } },
              { type: "response.function_call_arguments.done", item_id: "fc-readfile", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-default-readfile",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try legacy read alias" }],
      },
      requestId: "req-responses-default-readfile",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools.some((tool) => tool.name === "ReadFile"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["ReadFile", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-readfile",
      call_id: "readfile-1",
      name: "ReadFile",
      arguments: "{\"path\":\"/tmp/a\"}",
    }, {
      type: "function_call_output",
      call_id: "readfile-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-1).output, /Invalid ReadFile input/);
    assert.match(requests[1].input.at(-1).output, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider rejects default-catalog client tools as function outputs without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-web", type: "function_call", call_id: "web-1", name: "WebSearch" } },
              { type: "response.function_call_arguments.done", item_id: "fc-web", arguments: "{\"search_term\":\"Cursor BYOK\"}" },
              { type: "response.output_item.added", item: { id: "fc-image", type: "function_call", call_id: "image-1", name: "GenerateImage" } },
              { type: "response.function_call_arguments.done", item_id: "fc-image", arguments: "{\"description\":\"diagram\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-default-client-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try client tools" }],
      },
      requestId: "req-responses-default-client-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(requestToolNames.includes("WebSearch"), false);
    assert.equal(requestToolNames.includes("GenerateImage"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [["WebSearch", "unsupportedToolResult"], ["GenerateImage", "unsupportedToolResult"]]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-4), [{
      type: "function_call",
      id: "fc-web",
      call_id: "web-1",
      name: "WebSearch",
      arguments: "{\"search_term\":\"Cursor BYOK\"}",
    }, {
      type: "function_call_output",
      call_id: "web-1",
      output: requests[1].input.at(-3).output,
    }, {
      type: "function_call",
      id: "fc-image",
      call_id: "image-1",
      name: "GenerateImage",
      arguments: "{\"description\":\"diagram\"}",
    }, {
      type: "function_call_output",
      call_id: "image-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-3).output, /Invalid WebSearch input/);
    assert.match(requests[1].input.at(-3).output, /not available as a BYOK provider tool/);
    assert.match(requests[1].input.at(-1).output, /Invalid GenerateImage input/);
    assert.match(requests[1].input.at(-1).output, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider rejects default-catalog task todo aliases as function outputs without Cursor wait", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-task-create", type: "function_call", call_id: "task-create-1", name: "TaskCreate" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-create", arguments: "{\"description\":\"inspect\"}" },
              { type: "response.output_item.added", item: { id: "fc-task-update", type: "function_call", call_id: "task-update-1", name: "TaskUpdate" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-update", arguments: "{\"id\":\"task-1\",\"status\":\"completed\"}" },
              { type: "response.output_item.added", item: { id: "fc-task-list", type: "function_call", call_id: "task-list-1", name: "TaskList" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-list", arguments: "{}" },
              { type: "response.output_item.added", item: { id: "fc-task-get", type: "function_call", call_id: "task-get-1", name: "TaskGet" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-get", arguments: "{\"id\":\"task-1\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-default-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "try task aliases" }],
      },
      requestId: "req-responses-default-task-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    const requestToolNames = requests[0].tools.map((tool) => tool.name);
    assert.equal(requestToolNames.includes("TaskCreate"), false);
    assert.equal(requestToolNames.includes("TaskUpdate"), false);
    assert.equal(requestToolNames.includes("TaskList"), false);
    assert.equal(requestToolNames.includes("TaskGet"), false);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => [event.name, event.localResult?.case]), [
      ["TaskCreate", "unsupportedToolResult"],
      ["TaskUpdate", "unsupportedToolResult"],
      ["TaskList", "unsupportedToolResult"],
      ["TaskGet", "unsupportedToolResult"],
    ]);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(-8), [{
      type: "function_call",
      id: "fc-task-create",
      call_id: "task-create-1",
      name: "TaskCreate",
      arguments: "{\"description\":\"inspect\"}",
    }, {
      type: "function_call_output",
      call_id: "task-create-1",
      output: requests[1].input.at(-7).output,
    }, {
      type: "function_call",
      id: "fc-task-update",
      call_id: "task-update-1",
      name: "TaskUpdate",
      arguments: "{\"id\":\"task-1\",\"status\":\"completed\"}",
    }, {
      type: "function_call_output",
      call_id: "task-update-1",
      output: requests[1].input.at(-5).output,
    }, {
      type: "function_call",
      id: "fc-task-list",
      call_id: "task-list-1",
      name: "TaskList",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "task-list-1",
      output: requests[1].input.at(-3).output,
    }, {
      type: "function_call",
      id: "fc-task-get",
      call_id: "task-get-1",
      name: "TaskGet",
      arguments: "{\"id\":\"task-1\"}",
    }, {
      type: "function_call_output",
      call_id: "task-get-1",
      output: requests[1].input.at(-1).output,
    }]);
    assert.match(requests[1].input.at(-7).output, /Invalid TaskCreate input/);
    assert.match(requests[1].input.at(-7).output, /not available as a BYOK provider tool/);
    assert.match(requests[1].input.at(-5).output, /Invalid TaskUpdate input/);
    assert.match(requests[1].input.at(-5).output, /not available as a BYOK provider tool/);
    assert.match(requests[1].input.at(-3).output, /Invalid TaskList input/);
    assert.match(requests[1].input.at(-3).output, /not available as a BYOK provider tool/);
    assert.match(requests[1].input.at(-1).output, /Invalid TaskGet input/);
    assert.match(requests[1].input.at(-1).output, /not available as a BYOK provider tool/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider passes TodoWrite dependencies through to native Cursor todo execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-todo", type: "function_call", call_id: "todo-1", name: "TodoWrite" } },
              { type: "response.function_call_arguments.done", item_id: "fc-todo", arguments: "{\"todos\":[{\"id\":\"t1\",\"content\":\"Do it\",\"status\":\"pending\",\"dependencies\":[\"t0\"]}],\"merge\":true}" },
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
    const adapter = createProviderAdapter();
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-todowrite-dependencies",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-responses-todowrite-dependencies",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [{ id: "t1", content: "Do it", status: "pending" }],
              merge: true,
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const argumentsJson = "{\"todos\":[{\"id\":\"t1\",\"content\":\"Do it\",\"status\":\"pending\",\"dependencies\":[\"t0\"]}],\"merge\":true}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "todo-1", options: { toolName: "TodoWrite", toolArguments: argumentsJson } }]);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-todo",
      call_id: "todo-1",
      name: "TodoWrite",
      arguments: argumentsJson,
    }, {
      type: "function_call_output",
      call_id: "todo-1",
      output: "Todo list updated (1 item):\n- [pending] Do it",
    }]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider ignores malformed TodoWrite input before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-todo-invalid", type: "function_call", call_id: "todo-invalid", name: "TodoWrite" } },
              { type: "response.function_call_arguments.done", item_id: "fc-todo-invalid", arguments: "{\"todos\":\"finish step 1\"}" },
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
    const adapter = createProviderAdapter();
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-todowrite-invalid",
        systemPrompt: "system",
        messages: [{ role: "user", content: "track progress" }],
      },
      requestId: "req-responses-todowrite-invalid",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [],
              merge: false,
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "todo-invalid", options: { toolName: "TodoWrite", toolArguments: "{\"todos\":\"finish step 1\"}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "todo-invalid").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-todo-invalid",
      call_id: "todo-invalid",
      name: "TodoWrite",
      arguments: "{\"todos\":\"finish step 1\"}",
    }, {
      type: "function_call_output",
      call_id: "todo-invalid",
      output: "Todo list is empty.",
    }]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider skips schema validation for explicit task todo aliases", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-task-create-explicit", type: "function_call", call_id: "task-create-explicit", name: "TaskCreate" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-create-explicit", arguments: "{\"description\":\"inspect\"}" },
              { type: "response.output_item.added", item: { id: "fc-task-update-explicit", type: "function_call", call_id: "task-update-explicit", name: "TaskUpdate" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-update-explicit", arguments: "{\"task_id\":\"task-1\",\"status\":\"completed\"}" },
              { type: "response.output_item.added", item: { id: "fc-task-list-explicit", type: "function_call", call_id: "task-list-explicit", name: "TaskList" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-list-explicit", arguments: "{}" },
              { type: "response.output_item.added", item: { id: "fc-task-get-explicit", type: "function_call", call_id: "task-get-explicit", name: "TaskGet" } },
              { type: "response.function_call_arguments.done", item_id: "fc-task-get-explicit", arguments: "{}" },
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
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-explicit-task-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "use explicit task aliases" }],
        tools: [
          { name: "TaskCreate", description: "task create", inputSchema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false } },
          { name: "TaskUpdate", description: "task update", inputSchema: { type: "object", properties: { taskId: { type: "string" }, status: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
          { name: "TaskList", description: "task list", inputSchema: { type: "object", properties: { scope: { type: "string" } }, required: ["scope"], additionalProperties: false } },
          { name: "TaskGet", description: "task get", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
        ],
      },
      requestId: "req-responses-explicit-task-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          todoWriteResult: {
            success: {
              todos: [{ id: toolCallId, content: options.toolName, status: "completed" }],
              merge: true,
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [
      { toolCallId: "task-create-explicit", options: { toolName: "TaskCreate", toolArguments: "{\"description\":\"inspect\"}" } },
      { toolCallId: "task-update-explicit", options: { toolName: "TaskUpdate", toolArguments: "{\"task_id\":\"task-1\",\"status\":\"completed\"}" } },
      { toolCallId: "task-list-explicit", options: { toolName: "TaskList", toolArguments: "{}" } },
      { toolCallId: "task-get-explicit", options: { toolName: "TaskGet", toolArguments: "{}" } },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done").map((event) => event.localResult?.case), [undefined, undefined, undefined, undefined]);
    assert.deepEqual(requests[1].input.slice(-8), [{
      type: "function_call",
      id: "fc-task-create-explicit",
      call_id: "task-create-explicit",
      name: "TaskCreate",
      arguments: "{\"description\":\"inspect\"}",
    }, {
      type: "function_call_output",
      call_id: "task-create-explicit",
      output: "Todo list updated (1 item):\n- [completed] TaskCreate",
    }, {
      type: "function_call",
      id: "fc-task-update-explicit",
      call_id: "task-update-explicit",
      name: "TaskUpdate",
      arguments: "{\"task_id\":\"task-1\",\"status\":\"completed\"}",
    }, {
      type: "function_call_output",
      call_id: "task-update-explicit",
      output: "Todo list updated (1 item):\n- [completed] TaskUpdate",
    }, {
      type: "function_call",
      id: "fc-task-list-explicit",
      call_id: "task-list-explicit",
      name: "TaskList",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "task-list-explicit",
      output: "Todo list updated (1 item):\n- [completed] TaskList",
    }, {
      type: "function_call",
      id: "fc-task-get-explicit",
      call_id: "task-get-explicit",
      name: "TaskGet",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "task-get-explicit",
      output: "Todo list updated (1 item):\n- [completed] TaskGet",
    }]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider rejects malformed Read when explicit user JSON path does not match", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-bad", type: "function_call", call_id: "bad-read", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-bad", arguments: "{\"filePath\":\"/tmp/b\",\"path\":\"/tmp/b\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 21, output_tokens: 2 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-cache",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-responses-read-reject-mismatch",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return {};
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(requests[1].input.at(-1).output, /Invalid Read input/);
    assert.match(requests[1].input.at(-1).output, /Retry the Read tool with exactly this JSON: \{"path":"\/tmp\/a","offset":2000,"limit":20\}/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider repairs supported Grep alias keys before Cursor execution", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-bad", type: "function_call", call_id: "bad-grep", name: "Grep" } },
              { type: "response.function_call_arguments.done", item_id: "fc-bad", arguments: "{\"pattern\":\"needle\",\"headLimit\":3}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 21, output_tokens: 2 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-grep-alias",
        systemPrompt: "system",
        messages: [{ role: "user", content: "grep it" }],
        tools: [{ name: "Grep", description: "grep", inputSchema: { type: "object", properties: { pattern: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false } }],
      },
      requestId: "req-responses-grep-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          grepResult: {
            success: {
              pattern: "needle",
              outputMode: "content",
              workspaceResults: {
                "/tmp/project": {
                  result: {
                    case: "content",
                    value: { matches: [{ file: "a.js", matches: [{ lineNumber: 3, content: "needle here" }] }] },
                  },
                },
              },
            },
          },
        });
      },
    })) {
      // drain stream
    }

    const repairedArguments = "{\"pattern\":\"needle\",\"head_limit\":3}";
    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-grep", options: { toolName: "Grep", toolArguments: repairedArguments } }]);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-bad",
      call_id: "bad-grep",
      name: "Grep",
      arguments: repairedArguments,
    }, {
      type: "function_call_output",
      call_id: "bad-grep",
      output: requests[1].input.at(-1).output,
    }]);
    assert.equal(requests[1].input.at(-1).output, "[/tmp/project] a.js:3 needle here");
  } finally {
    restore();
  }
});


test("OpenAI Responses provider repairs Read aliases from unique prose offset and limit instructions", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-bad", type: "function_call", call_id: "bad-read", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-bad", arguments: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 21, output_tokens: 2 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-cache",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Read /tmp/a with offset 2000 limit 20 exactly.",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-responses-read-repair-prose",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "full file",
              readRange: { startLine: 1 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-read", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), [undefined]);
    assert.equal(requests[1].input.at(-2).type, "function_call");
    assert.equal(requests[1].input.at(-2).call_id, "bad-read");
    assert.equal(requests[1].input.at(-2).arguments, "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}");
    assert.doesNotMatch(requests[1].input.at(-1).output, /Invalid Read input/);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider rejects ambiguous Read aliases for repeated path ranges", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-bad", type: "function_call", call_id: "bad-read", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-bad", arguments: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 21, output_tokens: 2 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-cache",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: [
            "Make exactly these Read calls:",
            "{\"path\":\"/tmp/a\",\"offset\":100,\"limit\":5}",
            "{\"path\":\"/tmp/a\",\"offset\":200,\"limit\":5}",
          ].join("\n"),
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-responses-read-ambiguous-alias",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "wrong window",
              readRange: { startLine: 200 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(waitCalls, []);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), ["unsupportedToolResult"]);
    assert.match(requests[1].input.at(-1).output, /Invalid Read input/);
    assert.match(requests[1].input.at(-1).output, /multiple explicit Read ranges/);
    assert.match(requests[1].input.at(-1).output, /\{"path":"\/tmp\/a","offset":100,"limit":5\}/);
    assert.match(requests[1].input.at(-1).output, /\{"path":"\/tmp\/a","offset":200,"limit":5\}/);
    assert.doesNotMatch(requests[1].input.at(-1).output, /unsupported keys: filePath/);
    assert.doesNotMatch(requests[1].input.at(-1).output, /Do not answer until/);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider records repaired Read arguments in follow-up history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-read", type: "function_call", call_id: "read-1", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-read", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 15, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    for await (const _event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-repaired-read-history",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-repaired-read-history",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "windowed", readRange: { startLine: 2000 } } },
        });
      },
    })) {
      // drain stream
    }

    const expectedArguments = "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}";
    assert.deepEqual(waitCalls, [{ toolCallId: "read-1", options: { toolName: "Read", toolArguments: expectedArguments } }]);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", id: "fc-read", call_id: "read-1", name: "Read", arguments: expectedArguments },
      { type: "function_call_output", call_id: "read-1", output: "File: /tmp/a\nLines: 2000-2000\n  2000|windowed" },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider preserves reasoning items in tool follow-up history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              {
                type: "response.output_item.done",
                item: {
                  id: "rs-1",
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "checked file need" }],
                  content: [{ type: "reasoning_text", text: "private" }],
                  encrypted_content: "opaque",
                },
              },
              { type: "response.output_item.added", item: { id: "fc-read", type: "function_call", call_id: "read-1", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-read", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 7 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 15, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    for await (const _event of createProviderAdapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-reasoning-tool-history",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Use Read." }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-reasoning-tool-history",
      waitForToolResult: async (toolCallId) => normalizeExecClientResult({
        id: 1,
        execId: toolCallId,
        readResult: { success: { path: "/tmp/a", content: "ok", readRange: { startLine: 1 } } },
      }),
    })) {
      // Drain stream.
    }

    assert.deepEqual(requests[1].input.slice(-3), [
      {
        id: "rs-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checked file need" }],
        content: [{ type: "reasoning_text", text: "private" }],
        encrypted_content: "opaque",
      },
      { type: "function_call", id: "fc-read", call_id: "read-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "read-1", output: "File: /tmp/a\nLines: 1-1\n     1|ok" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider loop waits for same-turn Cursor tool results concurrently", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-1", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.output_item.added", item: { id: "fc-2", type: "function_call", call_id: "call-2", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-2", arguments: "{\"path\":\"/tmp/b\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const adapter = createProviderAdapter();
    await runConcurrentReadToolWaits({
      toolCallIds: ["call-1", "call-2"],
      waitForToolResultOptions: [
        { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" },
        { toolName: "Read", toolArguments: "{\"path\":\"/tmp/b\"}" },
      ],
      afterSecondWait: async () => {
        assert.equal(requests.length, 1);
      },
      runAdapter: (waitForToolResult) => adapter.run({
        provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-responses-model" },
        request: {
          conversationId: "conv-cache",
          systemPrompt: "system",
          messages: [{ role: "user", content: "read both" }],
          tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        },
        requestId: "req-responses-concurrent",
        waitForToolResult,
      }),
      assertFollowUp: async () => {
        assert.deepEqual(requests[1].input.slice(-4), [
          { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
          { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
          { type: "function_call", id: "fc-2", call_id: "call-2", name: "Read", arguments: "{\"path\":\"/tmp/b\"}" },
          { type: "function_call_output", call_id: "call-2", output: "File: /tmp/b\nLines: 1-1\n     1|b" },
        ]);
      },
    });
  } finally {
    restore();
  }
});


test("OpenAI Responses provider accepts function call arguments from output_item.done", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read" } },
              { type: "response.output_item.done", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-output-item-done",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-output-item-done",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.deepEqual(waitCalls, [{ toolCallId: "call-1", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider accepts function calls from output_item.done without added", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.done", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-output-item-done-only",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-output-item-done-only",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(events.filter((event) => event.type === "tool_use_start").map((event) => event.name), ["Read"]);
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.deepEqual(waitCalls, [{ toolCallId: "call-1", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider does not duplicate function calls when both done events arrive", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-1", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.output_item.done", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" } },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-output-item-done-dedupe",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-output-item-done-dedupe",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(events.filter((event) => event.type === "tool_use_done" && event.name === "Read").length, 1);
    assert.equal(waitCalls.length, 1);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider accepts function names from function_call_arguments.done", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1" } },
              { type: "response.function_call_arguments.done", item_id: "fc-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-arguments-done-name",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-arguments-done-name",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.deepEqual(waitCalls, [{ toolCallId: "call-1", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider accepts standalone function_call_arguments.done events", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.function_call_arguments.done", item_id: "fc-standalone", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-standalone-arguments-done",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-standalone-arguments-done",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: { success: { path: "/tmp/a", content: "a" } },
        });
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(events.filter((event) => event.type === "tool_use_start").map((event) => [event.id, event.name]), [["fc-standalone", "Read"]]);
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.id === "fc-standalone" && event.name === "Read"), true);
    assert.deepEqual(waitCalls, [{ toolCallId: "fc-standalone", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
    assert.deepEqual(requests[1].input.slice(-2), [
      { type: "function_call", call_id: "fc-standalone", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "fc-standalone", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider dispatches direct Cursor MCP tools through CallMcpTool exec", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-mcp", type: "function_call", call_id: "mcp-search-call", name: "user-awslabs_aws-documentation-mcp-server-search_documentation" } },
              { type: "response.function_call_arguments.done", item_id: "fc-mcp", arguments: "{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-mcp-responses",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Use AWS docs MCP" }],
        tools: [{
          name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
          description: "Search AWS docs",
          inputSchema: {
            type: "object",
            properties: {
              search_phrase: { type: "string" },
              limit: { type: "number" },
            },
          },
          providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
          toolName: "search_documentation",
        }],
      },
      requestId: "req-responses-mcp",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpResult: {
            success: {
              content: [{ content: { case: "text", value: { text: "AWS Lambda function URLs" } } }],
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools[0].name, "user-awslabs_aws-documentation-mcp-server-search_documentation");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-search-call",
      options: {
        toolName: "CallMcpTool",
        toolArguments: "{\"name\":\"user-awslabs.aws-documentation-mcp-server-search_documentation\",\"args\":{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1},\"providerIdentifier\":\"user-awslabs.aws-documentation-mcp-server\",\"toolName\":\"search_documentation\",\"displayName\":\"user-awslabs_aws-documentation-mcp-server-search_documentation\"}",
      },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-search-call");
    assert.equal(cursorEvent.name, "CallMcpTool");
    assert.deepEqual(JSON.parse(cursorEvent.arguments), {
      name: "user-awslabs.aws-documentation-mcp-server-search_documentation",
      args: { search_phrase: "AWS Lambda function URLs", limit: 1 },
      providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
      toolName: "search_documentation",
      displayName: "user-awslabs_aws-documentation-mcp-server-search_documentation",
    });
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-mcp",
      call_id: "mcp-search-call",
      name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
      arguments: "{\"search_phrase\":\"AWS Lambda function URLs\",\"limit\":1}",
    }, {
      type: "function_call_output",
      call_id: "mcp-search-call",
      output: "AWS Lambda function URLs",
    }]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider loop forwards stream events before upstream stream completes", async () => {
  const requests = [];
  const gate = deferred();
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "response.output_text.delta", delta: "first" };
              await gate.promise;
              yield { type: "response.output_text.delta", delta: "second" };
              yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } };
            },
          };
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const iterator = adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-streaming",
        systemPrompt: "system",
        messages: [{ role: "user", content: "stream text" }],
      },
      requestId: "req-responses-streaming",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    });

    const first = await Promise.race([
      iterator.next(),
      tick().then(() => ({ timedOut: true })),
    ]);
    assert.deepEqual(first, { value: { type: "text_delta", text: "first" }, done: false });
    assert.equal(requests.length, 1);
    gate.resolve();
    await iterator.return?.();
  } finally {
    gate.resolve();
    restore();
  }
});


test("OpenAI Responses provider preserves prior Chat-format tool history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-chat-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-prev",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call-prev", content: "File: /tmp/a\nLines: 1-1\n     1|a" },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-chat-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].input.slice(1), [
      { role: "user", content: "read it" },
      { type: "function_call", call_id: "call-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-prev", output: "File: /tmp/a\nLines: 1-1\n     1|a" },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider preserves prior Anthropic-format tool history", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-anthropic-history",
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will inspect it." },
              { type: "tool_use", id: "toolu-prev", name: "Read", input: { path: "/tmp/a", offset: 2, limit: 3 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu-prev", content: "File: /tmp/a\nLines: 2-4\n     2|a" }],
          },
          { role: "user", content: "now answer" },
        ],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-anthropic-history",
      waitForToolResult: async () => {
        throw new Error("unexpected tool call");
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[0].input.slice(1), [
      { role: "user", content: "read it" },
      { role: "assistant", content: "I will inspect it." },
      { type: "function_call", call_id: "toolu-prev", name: "Read", arguments: "{\"path\":\"/tmp/a\",\"offset\":2,\"limit\":3}" },
      { type: "function_call_output", call_id: "toolu-prev", output: "File: /tmp/a\nLines: 2-4\n     2|a" },
      { role: "user", content: "now answer" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider loop uses responses API with conversation prompt cache key", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read" } },
              { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: "{\"path\":\"/tmp/a\"}" },
              { type: "response.function_call_arguments.done", item_id: "fc-1", arguments: "{\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-cache",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "raw cursor content",
            },
          },
        });
      },
    })) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "tool_use_done" && event.name === "Read"), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].prompt_cache_key, "conv-cache");
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].input[0].role, "system");
    assert.equal(requests[0].tools[0].type, "function");
    assert.equal(requests[0].tools[0].name, "Read");
    assert.match(requests[0].tools[0].description, /only valid Read input keys are path, offset, and limit/);
    assert.deepEqual(Object.keys(requests[0].tools[0].parameters.properties), ["path", "offset", "limit"]);
    assert.deepEqual(requests[0].tools[0].parameters.required, ["path"]);
    assert.equal(requests[0].tools[0].parameters.additionalProperties, false);
    assert.deepEqual(requests[1].input.at(-1), {
      type: "function_call_output",
      call_id: "call-1",
      output: "File: /tmp/a\nLines: 1-1\n     1|raw cursor content",
    });
    assert.deepEqual(waitCalls, [{ toolCallId: "call-1", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\"}" } }]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider loop preserves same-turn native history before tool follow-up", async () => {
  const requests = [];
  const assistantMessage = {
    id: "msg-1",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "I will inspect it." }],
    status: "completed",
  };
  const nativeItem = {
    id: "mcp-1",
    type: "mcp_call",
    call_id: "mcp-call-1",
    name: "search",
    server_label: "docs",
    arguments: "{\"query\":\"BYOK\"}",
    output: "result",
    status: "completed",
  };
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.done", item_id: "msg-1", item: assistantMessage },
              { type: "response.output_item.done", item_id: "mcp-1", item: nativeItem },
              { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-1", arguments: "{\"path\":\"/tmp/a\"}", name: "Read" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-same-turn-native-history",
        systemPrompt: "system",
        messages: [{ role: "user", content: "read it" }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      },
      requestId: "req-responses-same-turn-native-history",
      waitForToolResult: async (toolCallId) => normalizeExecClientResult({
        execId: toolCallId,
        readResult: {
          success: {
            path: "/tmp/a",
            content: "raw cursor content",
          },
        },
      }),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "I will inspect it."), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(requests[1].input.slice(-4), [
      assistantMessage,
      nativeItem,
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "Read", arguments: "{\"path\":\"/tmp/a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "File: /tmp/a\nLines: 1-1\n     1|raw cursor content" },
    ]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider dispatches direct MCP auth through Cursor interaction auth", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-auth", type: "function_call", call_id: "mcp-auth-call", name: "plugin-atlassian-atlassian-mcp_auth" } },
              { type: "response.function_call_arguments.done", item_id: "fc-auth", arguments: "{}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 3 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const events = [];
    const waitCalls = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-mcp-auth-responses",
        systemPrompt: "system",
        messages: [{ role: "user", content: "Authenticate Atlassian MCP" }],
        tools: [mcpAuthProviderTool()],
      },
      requestId: "req-responses-mcp-auth",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          execId: toolCallId,
          mcpAuthResult: {
            result: {
              case: "success",
              value: { serverIdentifier: "plugin-atlassian-atlassian" },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests[0].tools[0].name, "plugin-atlassian-atlassian-mcp_auth");
    assert.deepEqual(waitCalls, [{
      toolCallId: "mcp-auth-call",
      options: {
        toolName: "mcp_auth",
        toolArguments: "{\"serverIdentifier\":\"plugin-atlassian-atlassian\"}",
      },
    }]);
    const cursorEvent = events.find((event) => event.type === "tool_use_done" && event.id === "mcp-auth-call");
    assert.equal(cursorEvent.name, "mcp_auth");
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-auth",
      call_id: "mcp-auth-call",
      name: "plugin-atlassian-atlassian-mcp_auth",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "mcp-auth-call",
      output: "MCP authentication approved for server plugin-atlassian-atlassian.",
    }]);
  } finally {
    restore();
  }
});


test("OpenAI Responses provider repairs Read alias from a unique explicit user JSON range", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-bad", type: "function_call", call_id: "bad-read", name: "Read" } },
              { type: "response.function_call_arguments.done", item_id: "fc-bad", arguments: "{\"filePath\":\"/tmp/a\",\"path\":\"/tmp/a\"}" },
              { type: "response.completed", response: { usage: { input_tokens: 17, output_tokens: 5 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "done" },
            { type: "response.completed", response: { usage: { input_tokens: 21, output_tokens: 2 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const { ProviderAdapter } = require("../src/server/provider-adapter");
    const adapter = new ProviderAdapter({
      providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
      log: quietLog(),
    });
    const waitCalls = [];
    const events = [];
    for await (const event of adapter.run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-cache",
        systemPrompt: "system",
        messages: [{
          role: "user",
          content: "Use Read exactly once with this exact JSON: {\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
        }],
        tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" }, path: { type: "string" } } } }],
      },
      requestId: "req-responses-read-retry",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return normalizeExecClientResult({
          id: 1,
          execId: toolCallId,
          readResult: {
            success: {
              path: "/tmp/a",
              content: "windowed",
              readRange: { startLine: 2000 },
            },
          },
        });
      },
    })) {
      events.push(event);
    }

    assert.equal(requests.length, 2);
    assert.match(requests[0].tools[0].description, /only valid Read input keys are path, offset, and limit/);
    assert.deepEqual(Object.keys(requests[0].tools[0].parameters.properties), ["path", "offset", "limit"]);
    assert.deepEqual(waitCalls, [{ toolCallId: "bad-read", options: { toolName: "Read", toolArguments: "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}" } }]);
    assert.deepEqual(events.filter((event) => event.type === "tool_use_done" && event.id === "bad-read").map((event) => event.localResult?.case), [undefined]);
    assert.deepEqual(requests[1].input.slice(-2), [{
      type: "function_call",
      id: "fc-bad",
      call_id: "bad-read",
      name: "Read",
      arguments: "{\"path\":\"/tmp/a\",\"offset\":2000,\"limit\":20}",
    }, {
      type: "function_call_output",
      call_id: "bad-read",
      output: requests[1].input.at(-1).output,
    }]);
    assert.doesNotMatch(requests[1].input.at(-1).output, /Invalid Read input/);
  } finally {
    restore();
  }
});
