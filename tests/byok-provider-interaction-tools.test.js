"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderAdapter } = require("../src/server/provider-adapter");
const { asyncIterable, interceptModule, quietLog, snapshotJson } = require("./byok-fixtures");

function adapter() {
  return new ProviderAdapter({
    providersConfigProvider: () => ({ providers: [{ models: [{ id: "byok-model" }] }] }),
    log: quietLog(),
  });
}

function interactionTools() {
  return [
    {
      name: "AskQuestion",
      description: "Ask",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                prompt: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, label: { type: "string" } },
                    required: ["id", "label"],
                  },
                },
              },
              required: ["id", "prompt", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      name: "SwitchMode",
      description: "Switch",
      inputSchema: {
        type: "object",
        properties: { target_mode_id: { type: "string" }, explanation: { type: "string" } },
        required: ["target_mode_id"],
      },
    },
    {
      name: "CreatePlan",
      description: "Plan",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, overview: { type: "string" }, plan: { type: "string" } },
      },
    },
  ];
}

function interactionResult(toolName) {
  if (toolName === "AskQuestion") {
    return {
      message: {
        case: "byokInteractionToolResult",
        value: {
          toolName,
          toolArguments: askArgs(),
          interactionResponse: {
            id: 1,
            result: {
              case: "askQuestionInteractionResponse",
              value: {
                result: {
                  case: "success",
                  value: {
                    answers: [{
                      questionId: "q1",
                      selectedOptionIds: ["yes"],
                      freeformText: "ship it",
                    }],
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  if (toolName === "SwitchMode") {
    return {
      message: {
        case: "byokInteractionToolResult",
        value: {
          toolName,
          toolArguments: switchArgs(),
          interactionResponse: {
            id: 2,
            result: {
              case: "switchModeRequestResponse",
              value: { result: { case: "approved", value: {} } },
            },
          },
        },
      },
    };
  }
  return {
    message: {
      case: "byokInteractionToolResult",
      value: {
        toolName,
        toolArguments: planArgs(),
        interactionResponse: {
          id: 3,
          result: {
            case: "createPlanRequestResponse",
            // Binary decoder shape: the result oneof is wrapped twice.
            value: { result: { result: { case: "success", value: { accepted: true } } } },
          },
        },
      },
    },
  };
}

function interactionErrorResult(toolName) {
  let interactionResponse;
  let toolArguments;
  if (toolName === "AskQuestion") {
    toolArguments = askArgs();
    interactionResponse = {
      id: 1,
      result: {
        case: "askQuestionInteractionResponse",
        value: { result: { case: "error", value: { errorMessage: "Question UI failed" } } },
      },
    };
  } else if (toolName === "SwitchMode") {
    toolArguments = switchArgs();
    interactionResponse = {
      id: 2,
      result: {
        case: "switchModeRequestResponse",
        value: { result: { case: "rejected", value: { reason: "Stay in chat" } } },
      },
    };
  } else {
    toolArguments = planArgs();
    interactionResponse = {
      id: 3,
      result: {
        case: "createPlanRequestResponse",
        // Binary decoder shape: the result oneof is wrapped twice.
        value: { result: { result: { case: "error", value: { error: "Plan dialog failed" } } } },
      },
    };
  }
  return {
    message: {
      case: "byokInteractionToolResult",
      value: {
        toolName,
        toolArguments,
        interactionResponse,
      },
    },
  };
}

function askArgs() {
  return {
    questions: [{
      id: "q1",
      prompt: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
    }],
  };
}

function switchArgs() {
  return { target_mode_id: "debug", explanation: "Need debug mode" };
}

function planArgs() {
  return {
    name: "Fix",
    overview: "Align tools",
    plan: "Patch and test",
    todos: [{ id: "t1", content: "Patch runtime", dependencies: [], status: "pending" }],
    isProject: true,
    phases: [{
      name: "Implementation",
      todos: [{ id: "p1", content: "Stop after plan", dependencies: ["t1"], status: "pending" }],
    }],
  };
}

test("OpenAI Chat provider loops interaction bridge results back as tool messages", async () => {
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
                      tool_calls: [
                        { id: "ask-1", index: 0, function: { name: "AskQuestion", arguments: JSON.stringify(askArgs()) } },
                        { id: "switch-1", index: 1, function: { name: "SwitchMode", arguments: JSON.stringify(switchArgs()) } },
                        { id: "plan-1", index: 2, function: { name: "CreatePlan", arguments: JSON.stringify(planArgs()) } },
                      ],
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
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-interaction-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ask, switch, and plan" }],
        tools: interactionTools(),
      },
      requestId: "req-chat-interaction-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return interactionResult(options.toolName);
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "ask-1", options: { toolName: "AskQuestion", toolArguments: JSON.stringify(askArgs()) } },
      { toolCallId: "switch-1", options: { toolName: "SwitchMode", toolArguments: JSON.stringify(switchArgs()) } },
      { toolCallId: "plan-1", options: { toolName: "CreatePlan", toolArguments: JSON.stringify(planArgs()) } },
    ]);
    assert.deepEqual(requests[1].messages.slice(-4), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "ask-1", type: "function", function: { name: "AskQuestion", arguments: JSON.stringify(askArgs()) } },
          { id: "switch-1", type: "function", function: { name: "SwitchMode", arguments: JSON.stringify(switchArgs()) } },
          { id: "plan-1", type: "function", function: { name: "CreatePlan", arguments: JSON.stringify(planArgs()) } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "ask-1",
        content: "Question q1: selected [yes]; freeform: ship it",
      },
      {
        role: "tool",
        tool_call_id: "switch-1",
        content: "Switched composer mode to debug",
      },
      {
        role: "tool",
        tool_call_id: "plan-1",
        content: "Plan accepted by the user.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider repairs interaction tool aliases before Cursor execution and history", async () => {
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
                      tool_calls: [
                        {
                          id: "ask-1",
                          index: 0,
                          function: {
                            name: "AskQuestion",
                            arguments: JSON.stringify({
                              title: "Confirm",
                              questions: [{
                                id: "q1",
                                prompt: "Proceed?",
                                allowMultiple: true,
                                options: [{ id: "yes", label: "Yes", extra: "drop" }],
                                extra: "drop",
                              }],
                              extra: "drop",
                            }),
                          },
                        },
                        {
                          id: "switch-1",
                          index: 1,
                          function: {
                            name: "SwitchMode",
                            arguments: JSON.stringify({
                              targetModeId: "debug",
                              explanation: "Need debug mode",
                              extra: "drop",
                            }),
                          },
                        },
                        {
                          id: "plan-1",
                          index: 2,
                          function: {
                            name: "CreatePlan",
                            arguments: JSON.stringify({
                              name: "Fix",
                              overview: "Align tools",
                              plan: "Patch and test",
                              is_project: true,
                              todos: [{ id: "t1", content: "Patch runtime", status: 2, dependencies: ["root"], extra: "drop" }],
                              phases: [{
                                name: "Implementation",
                                todos: [{ id: "p1", content: "Verify", status: "pending", dependencies: ["t1"], extra: "drop" }],
                                extra: "drop",
                              }],
                              extra: "drop",
                            }),
                          },
                        },
                      ],
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
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-interaction-tools-aliases",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ask, switch, and plan with aliases" }],
        tools: interactionTools(),
      },
      requestId: "req-chat-interaction-tools-aliases",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return interactionResult(options.toolName);
      },
    })) {
      events.push(event);
    }

    const expectedAskArgs = JSON.stringify({
      title: "Confirm",
      questions: [{
        id: "q1",
        prompt: "Proceed?",
        options: [{ id: "yes", label: "Yes" }],
        allow_multiple: true,
      }],
    });
    const expectedSwitchArgs = JSON.stringify({
      target_mode_id: "debug",
      explanation: "Need debug mode",
    });
    const expectedPlanArgs = JSON.stringify({
      name: "Fix",
      overview: "Align tools",
      plan: "Patch and test",
      todos: [{ id: "t1", content: "Patch runtime", dependencies: ["root"], status: 2 }],
      isProject: true,
      phases: [{
        name: "Implementation",
        todos: [{ id: "p1", content: "Verify", dependencies: ["t1"], status: "pending" }],
      }],
    });

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "ask-1", options: { toolName: "AskQuestion", toolArguments: expectedAskArgs } },
      { toolCallId: "switch-1", options: { toolName: "SwitchMode", toolArguments: expectedSwitchArgs } },
      { toolCallId: "plan-1", options: { toolName: "CreatePlan", toolArguments: expectedPlanArgs } },
    ]);
    assert.deepEqual(requests[1].messages.slice(-4), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "ask-1", type: "function", function: { name: "AskQuestion", arguments: expectedAskArgs } },
          { id: "switch-1", type: "function", function: { name: "SwitchMode", arguments: expectedSwitchArgs } },
          { id: "plan-1", type: "function", function: { name: "CreatePlan", arguments: expectedPlanArgs } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "ask-1",
        content: "Question q1: selected [yes]; freeform: ship it",
      },
      {
        role: "tool",
        tool_call_id: "switch-1",
        content: "Switched composer mode to debug",
      },
      {
        role: "tool",
        tool_call_id: "plan-1",
        content: "Plan accepted by the user.",
      },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Chat provider lets plan mode inspect before CreatePlan", async () => {
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
                      tool_calls: [
                        { id: "plan-1", index: 0, function: { name: "CreatePlan", arguments: JSON.stringify(planArgs()) } },
                      ],
                    },
                  }],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]);
            }
            return asyncIterable([{ choices: [{ delta: { content: "plain fallback" }, finish_reason: "stop" }] }]);
          },
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-model" },
      request: {
        conversationId: "conv-chat-plan-mode",
        systemPrompt: "system",
        composerMode: "plan",
        messages: [{ role: "user", content: "make a plan" }],
        tools: interactionTools(),
      },
      requestId: "req-chat-plan-mode",
      waitForToolResult: async (_toolCallId, options) => interactionResult(options.toolName),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "plain fallback"), false);
    assert.deepEqual(events.at(-1), {
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.equal(requests[0].tool_choice, undefined);
    assert.match(requests[0].messages[0].content, /<cursor_byok_plan_mode>/);
    assert.match(requests[0].messages[0].content, /call CreatePlan once with the complete user-visible plan artifact/);
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider loops interaction bridge results back as function outputs", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-ask", type: "function_call", call_id: "ask-1", name: "AskQuestion" } },
              { type: "response.function_call_arguments.done", item_id: "fc-ask", arguments: JSON.stringify(askArgs()) },
              { type: "response.output_item.added", item: { id: "fc-switch", type: "function_call", call_id: "switch-1", name: "SwitchMode" } },
              { type: "response.function_call_arguments.done", item_id: "fc-switch", arguments: JSON.stringify(switchArgs()) },
              { type: "response.output_item.added", item: { id: "fc-plan", type: "function_call", call_id: "plan-1", name: "CreatePlan" } },
              { type: "response.function_call_arguments.done", item_id: "fc-plan", arguments: JSON.stringify(planArgs()) },
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
    const waitCalls = [];
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-interaction-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ask, switch, and plan" }],
        tools: interactionTools(),
      },
      requestId: "req-responses-interaction-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return interactionResult(options.toolName);
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "ask-1", options: { toolName: "AskQuestion", toolArguments: JSON.stringify(askArgs()) } },
      { toolCallId: "switch-1", options: { toolName: "SwitchMode", toolArguments: JSON.stringify(switchArgs()) } },
      { toolCallId: "plan-1", options: { toolName: "CreatePlan", toolArguments: JSON.stringify(planArgs()) } },
    ]);
    assert.deepEqual(requests[1].input.slice(-6), [
      { type: "function_call", id: "fc-ask", call_id: "ask-1", name: "AskQuestion", arguments: JSON.stringify(askArgs()) },
      { type: "function_call_output", call_id: "ask-1", output: "Question q1: selected [yes]; freeform: ship it" },
      { type: "function_call", id: "fc-switch", call_id: "switch-1", name: "SwitchMode", arguments: JSON.stringify(switchArgs()) },
      { type: "function_call_output", call_id: "switch-1", output: "Switched composer mode to debug" },
      { type: "function_call", id: "fc-plan", call_id: "plan-1", name: "CreatePlan", arguments: JSON.stringify(planArgs()) },
      { type: "function_call_output", call_id: "plan-1", output: "Plan accepted by the user." },
    ]);
  } finally {
    restore();
  }
});

test("OpenAI Responses provider lets plan mode inspect before CreatePlan", async () => {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            return asyncIterable([
              { type: "response.output_item.added", item: { id: "fc-plan", type: "function_call", call_id: "plan-1", name: "CreatePlan" } },
              { type: "response.function_call_arguments.done", item_id: "fc-plan", arguments: JSON.stringify(planArgs()) },
              { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
            ]);
          }
          return asyncIterable([
            { type: "response.output_text.delta", delta: "plain fallback" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ]);
        },
      };
    }
  }
  const restore = interceptModule("openai", FakeOpenAI);
  try {
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-responses-model" },
      request: {
        conversationId: "conv-responses-plan-mode",
        systemPrompt: "system",
        composerMode: "plan",
        messages: [{ role: "user", content: "make a plan" }],
        tools: interactionTools(),
      },
      requestId: "req-responses-plan-mode",
      waitForToolResult: async (_toolCallId, options) => interactionResult(options.toolName),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "plain fallback"), false);
    assert.deepEqual(events.at(-1), {
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.equal(requests[0].tool_choice, undefined);
    assert.match(requests[0].input[0].content, /<cursor_byok_plan_mode>/);
    assert.match(requests[0].input[0].content, /call CreatePlan once with the complete user-visible plan artifact/);
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("Anthropic provider loops interaction bridge results back as tool_result blocks", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "ask-1", name: "AskQuestion", input: askArgs() } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "switch-1", name: "SwitchMode", input: switchArgs() } },
              { type: "content_block_stop", index: 1 },
              { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "plan-1", name: "CreatePlan", input: planArgs() } },
              { type: "content_block_stop", index: 2 },
            ]);
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
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-interaction-tools",
        systemPrompt: "system",
        messages: [{ role: "user", content: "ask, switch, and plan" }],
        tools: interactionTools(),
      },
      requestId: "req-anthropic-interaction-tools",
      waitForToolResult: async (toolCallId, options) => {
        waitCalls.push({ toolCallId, options });
        return interactionResult(options.toolName);
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
    assert.deepEqual(waitCalls, [
      { toolCallId: "ask-1", options: { toolName: "AskQuestion", toolArguments: askArgs() } },
      { toolCallId: "switch-1", options: { toolName: "SwitchMode", toolArguments: switchArgs() } },
      { toolCallId: "plan-1", options: { toolName: "CreatePlan", toolArguments: planArgs() } },
    ]);
    assert.deepEqual(requests[1].messages.slice(-2), [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ask-1", name: "AskQuestion", input: askArgs() },
          { type: "tool_use", id: "switch-1", name: "SwitchMode", input: switchArgs() },
          { type: "tool_use", id: "plan-1", name: "CreatePlan", input: planArgs() },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "ask-1", content: "Question q1: selected [yes]; freeform: ship it" },
          { type: "tool_result", tool_use_id: "switch-1", content: "Switched composer mode to debug" },
          { type: "tool_result", tool_use_id: "plan-1", content: "Plan accepted by the user." },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test("Anthropic provider lets plan mode inspect before CreatePlan", async () => {
  const requests = [];
  class FakeAnthropic {
    constructor() {
      this.messages = {
        stream: async (request) => {
          requests.push(snapshotJson(request));
          if (requests.length === 1) {
            const stream = asyncIterable([
              { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "plan-1", name: "CreatePlan" } },
              { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(planArgs()) } },
              { type: "content_block_stop", index: 0 },
            ]);
            stream.finalMessage = async () => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
            return stream;
          }
          const stream = asyncIterable([
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain fallback" } },
            { type: "content_block_stop", index: 0 },
          ]);
          stream.finalMessage = async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
          return stream;
        },
      };
    }
  }
  const restore = interceptModule("@anthropic-ai/sdk", FakeAnthropic);
  try {
    const events = [];
    for await (const event of adapter().run({
      provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
      model: { id: "byok-model", apiModel: "fake-claude" },
      request: {
        conversationId: "conv-anthropic-plan-mode",
        systemPrompt: "system",
        composerMode: "plan",
        messages: [{ role: "user", content: "make a plan" }],
        tools: interactionTools(),
      },
      requestId: "req-anthropic-plan-mode",
      waitForToolResult: async (_toolCallId, options) => interactionResult(options.toolName),
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "text_delta" && event.text === "plain fallback"), false);
    assert.deepEqual(events.at(-1), {
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.equal(requests[0].tool_choice, undefined);
    assert.match(requests[0].system, /<cursor_byok_plan_mode>/);
    assert.match(requests[0].system, /call CreatePlan once with the complete user-visible plan artifact/);
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test("provider loops interaction bridge failure results back in native API formats", async () => {
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
                        tool_calls: [
                          { id: "ask-1", index: 0, function: { name: "AskQuestion", arguments: JSON.stringify(askArgs()) } },
                          { id: "switch-1", index: 1, function: { name: "SwitchMode", arguments: JSON.stringify(switchArgs()) } },
                          { id: "plan-1", index: 2, function: { name: "CreatePlan", arguments: JSON.stringify(planArgs()) } },
                        ],
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
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-chat", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-model" },
        request: {
          conversationId: "conv-chat-interaction-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ask, switch, and plan" }],
          tools: interactionTools(),
        },
        requestId: "req-chat-interaction-failures",
        waitForToolResult: async (_toolCallId, options) => interactionErrorResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].messages.slice(-3), [
        { role: "tool", tool_call_id: "ask-1", content: "AskQuestion error: Question UI failed" },
        { role: "tool", tool_call_id: "switch-1", content: "Mode switch rejected: Stay in chat" },
        { role: "tool", tool_call_id: "plan-1", content: "CreatePlan error: Plan dialog failed" },
      ]);
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
              return asyncIterable([
                { type: "response.output_item.added", item: { id: "fc-ask", type: "function_call", call_id: "ask-1", name: "AskQuestion" } },
                { type: "response.function_call_arguments.done", item_id: "fc-ask", arguments: JSON.stringify(askArgs()) },
                { type: "response.output_item.added", item: { id: "fc-switch", type: "function_call", call_id: "switch-1", name: "SwitchMode" } },
                { type: "response.function_call_arguments.done", item_id: "fc-switch", arguments: JSON.stringify(switchArgs()) },
                { type: "response.output_item.added", item: { id: "fc-plan", type: "function_call", call_id: "plan-1", name: "CreatePlan" } },
                { type: "response.function_call_arguments.done", item_id: "fc-plan", arguments: JSON.stringify(planArgs()) },
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
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "openai-responses", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-responses-model" },
        request: {
          conversationId: "conv-responses-interaction-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ask, switch, and plan" }],
          tools: interactionTools(),
        },
        requestId: "req-responses-interaction-failures",
        waitForToolResult: async (_toolCallId, options) => interactionErrorResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].input.slice(-6), [
        { type: "function_call", id: "fc-ask", call_id: "ask-1", name: "AskQuestion", arguments: JSON.stringify(askArgs()) },
        { type: "function_call_output", call_id: "ask-1", output: "AskQuestion error: Question UI failed" },
        { type: "function_call", id: "fc-switch", call_id: "switch-1", name: "SwitchMode", arguments: JSON.stringify(switchArgs()) },
        { type: "function_call_output", call_id: "switch-1", output: "Mode switch rejected: Stay in chat" },
        { type: "function_call", id: "fc-plan", call_id: "plan-1", name: "CreatePlan", arguments: JSON.stringify(planArgs()) },
        { type: "function_call_output", call_id: "plan-1", output: "CreatePlan error: Plan dialog failed" },
      ]);
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
              const stream = asyncIterable([
                { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "ask-1", name: "AskQuestion", input: askArgs() } },
                { type: "content_block_stop", index: 0 },
                { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "switch-1", name: "SwitchMode", input: switchArgs() } },
                { type: "content_block_stop", index: 1 },
                { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "plan-1", name: "CreatePlan", input: planArgs() } },
                { type: "content_block_stop", index: 2 },
              ]);
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
      for await (const _event of adapter().run({
        provider: { name: "Provider", type: "anthropic", baseUrl: "http://unused", auth: { value: "key" } },
        model: { id: "byok-model", apiModel: "fake-claude" },
        request: {
          conversationId: "conv-anthropic-interaction-failures",
          systemPrompt: "system",
          messages: [{ role: "user", content: "ask, switch, and plan" }],
          tools: interactionTools(),
        },
        requestId: "req-anthropic-interaction-failures",
        waitForToolResult: async (_toolCallId, options) => interactionErrorResult(options.toolName),
      })) {
        // drain
      }

      assert.deepEqual(requests[1].messages.at(-1), {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "ask-1", content: "AskQuestion error: Question UI failed" },
          { type: "tool_result", tool_use_id: "switch-1", content: "Mode switch rejected: Stay in chat" },
          { type: "tool_result", tool_use_id: "plan-1", content: "CreatePlan error: Plan dialog failed" },
        ],
      });
    } finally {
      restore();
    }
  }
});
