"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  INTERACTION_BRIDGE_TOOL_NAMES,
  isInteractionBridgeTool,
  isMcpAuthToolName,
  normalizeAskQuestionArgs,
  normalizeSwitchModeQueryArgs,
  normalizeCreatePlanQueryArgs,
  buildInteractionQuery,
  toolResultFromInteractionResponse,
  providerTextFromInteractionResponse,
  summarizeInteractionResponse,
  interactionTimeoutResponse,
  planTodoStatus,
} = require("../src/runtime/interaction-bridge");

test("isMcpAuthToolName recognizes only mcp_auth", () => {
  assert.equal(isMcpAuthToolName("mcp_auth"), true);
  for (const name of ["CallMcpTool", "mcp-auth", "", undefined]) {
    assert.equal(isMcpAuthToolName(name), false);
  }
});

test("planTodoStatus maps every supported status label and preserves numeric enums", () => {
  const cases = [
    ["pending", 1],
    ["in_progress", 2],
    ["in-progress", 2],
    ["inprogress", 2],
    ["completed", 3],
    ["complete", 3],
    ["done", 3],
    ["cancelled", 4],
    ["canceled", 4],
    [2, 2],
    ["unknown-status", undefined],
    [undefined, undefined],
  ];
  for (const [input, expected] of cases) {
    assert.equal(planTodoStatus(input), expected, `planTodoStatus(${JSON.stringify(input)})`);
  }
});

test("isInteractionBridgeTool recognizes bridge tools and rejects unknown names", () => {
  for (const tool of ["AskQuestion", "SwitchMode", "CreatePlan"]) {
    assert.equal(isInteractionBridgeTool(tool), true);
  }
  for (const tool of ["ReadFile", "askquestion", "", undefined]) {
    assert.equal(isInteractionBridgeTool(tool), false);
  }
  assert.ok(INTERACTION_BRIDGE_TOOL_NAMES instanceof Set);
  assert.equal(INTERACTION_BRIDGE_TOOL_NAMES.size, 3);
});

test("normalizeAskQuestionArgs maps, defaults, and coerces input", () => {
  const full = normalizeAskQuestionArgs({
    title: "Pick a color",
    questions: [{
      id: "q1",
      prompt: "Which color?",
      allow_multiple: true,
      options: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
    }],
  });
  assert.equal(full.title, "Pick a color");
  assert.equal(full.questions[0].allowMultiple, true);
  assert.equal(full.questions[0].options[1].label, "Blue");

  const camel = normalizeAskQuestionArgs({ questions: [{ id: "q1", allowMultiple: true }] });
  assert.equal(camel.questions[0].allowMultiple, true);
  const conflicting = normalizeAskQuestionArgs({
    questions: [{ id: "q1", prompt: "Proceed?", allow_multiple: false, allowMultiple: true, options: [] }],
  });
  assert.equal(conflicting.questions[0].allowMultiple, false);

  const defaults = normalizeAskQuestionArgs(undefined);
  assert.equal(defaults.title, "");
  assert.deepStrictEqual(defaults.questions, []);
  assert.equal(normalizeAskQuestionArgs({ title: 42 }).title, "");
  assert.deepStrictEqual(normalizeAskQuestionArgs({ questions: "not-array" }).questions, []);
});

test("normalizeSwitchModeQueryArgs maps snake_case and camelCase", () => {
  assert.deepEqual(
    normalizeSwitchModeQueryArgs({ target_mode_id: "agent", explanation: "need agent mode" }, "tc-1"),
    { targetModeId: "agent", explanation: "need agent mode", toolCallId: "tc-1" },
  );
  assert.equal(normalizeSwitchModeQueryArgs({ targetModeId: "edit", explanation: "switching" }, "tc-2").targetModeId, "edit");
  assert.equal(normalizeSwitchModeQueryArgs({ target_mode_id: "", targetModeId: "agent" }, "tc-3").targetModeId, "agent");
  assert.deepEqual(
    normalizeSwitchModeQueryArgs(undefined, undefined),
    { targetModeId: "", explanation: "", toolCallId: "" },
  );
});

test("normalizeCreatePlanQueryArgs maps full args and defaults", () => {
  const full = normalizeCreatePlanQueryArgs({
    name: "Refactor plan",
    overview: "Clean up utilities",
    plan: "Step-by-step plan text",
    todos: [
      { id: "t1", content: "Extract helpers", status: "pending", dependencies: [] },
      { id: "t2", content: "Add tests", status: "pending", dependencies: ["t1"] },
    ],
    phases: [
      {
        name: "Implementation",
        todos: [{ id: "p1", content: "Patch runtime", status: "pending", dependencies: ["t1"] }],
      },
    ],
    is_project: true,
  });
  assert.equal(full.name, "Refactor plan");
  assert.equal(full.todos[1].content, "Add tests");
  assert.deepEqual(full.todos[1].dependencies, ["t1"]);
  assert.equal(full.todos[0].status, 1);
  assert.equal(full.phases[0].todos[0].status, 1);
  assert.equal(full.isProject, true);
  assert.equal(normalizeCreatePlanQueryArgs({ isProject: true }).isProject, true);
  assert.equal(normalizeCreatePlanQueryArgs({ isProject: false, is_project: true }).isProject, false);
  assert.equal(normalizeCreatePlanQueryArgs({ todos: [{ id: "t3", content: "Keep numeric", status: 2 }] }).todos[0].status, 2);
  const defaults = normalizeCreatePlanQueryArgs(undefined);
  assert.equal(defaults.name, "");
  assert.deepStrictEqual(defaults.todos, []);
  assert.deepStrictEqual(defaults.phases, []);
  assert.equal(defaults.isProject, false);
});

test("buildInteractionQuery builds known queries and handles unknown tools", () => {
  const cases = [
    ["AskQuestion", "tc-1", { title: "Confirm" }, 42, "askQuestionInteractionQuery", (q) => {
      assert.equal(q.query.value.args.title, "Confirm");
      assert.equal(q.query.value.toolCallId, "tc-1");
    }],
    ["SwitchMode", "tc-2", { target_mode_id: "agent" }, 7, "switchModeRequestQuery", (q) => {
      assert.equal(q.query.value.args.targetModeId, "agent");
    }],
    ["CreatePlan", "tc-3", { name: "Plan A" }, 10, "createPlanRequestQuery", (q) => {
      assert.equal(q.query.value.args.name, "Plan A");
      assert.equal(q.query.value.toolCallId, "tc-3");
    }],
  ];
  for (const [tool, toolCallId, args, queryId, expectedCase, assertArgs] of cases) {
    const q = buildInteractionQuery(tool, toolCallId, args, queryId);
    assert.equal(q.id, queryId);
    assert.equal(q.query.case, expectedCase);
    assertArgs(q);
  }
  const unknown = buildInteractionQuery("Unknown", "tc-x", {}, 0);
  assert.equal(unknown.id, 0);
  assert.equal(unknown.query.case, undefined);
  assert.equal(buildInteractionQuery("AskQuestion", "tc", {}, "not-a-number").id, 0);
});

test("toolResultFromInteractionResponse maps AskQuestion cases", () => {
  const cases = [
    {
      label: "success with answers",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              case: "success",
              value: {
                answers: [{ questionId: "q1", selectedOptionIds: ["opt-a"], freeformText: "hi" }],
              },
            },
          },
        },
      },
      expected: {
        result: {
          case: "success",
          value: {
            answers: [{ questionId: "q1", selectedOptionIds: ["opt-a"], freeformText: "hi" }],
          },
        },
      },
    },
    {
      label: "snake_case answer fields",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              case: "success",
              value: {
                answers: [{ question_id: "q2", selected_option_ids: ["b"], freeform_text: "note" }],
              },
            },
          },
        },
      },
      expected: {
        result: {
          case: "success",
          value: {
            answers: [{ questionId: "q2", selectedOptionIds: ["b"], freeformText: "note" }],
          },
        },
      },
    },
    {
      label: "error",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "error", value: { errorMessage: "Something broke" } } },
        },
      },
      expected: { result: { case: "error", value: { errorMessage: "Something broke" } } },
    },
    {
      label: "rejected",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "rejected", value: { reason: "User said no" } } },
        },
      },
      expected: { result: { case: "rejected", value: { reason: "User said no" } } },
    },
    {
      label: "async",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "async", value: {} } },
        },
      },
      expected: { result: { case: "success", value: { isAsync: true, answers: [] } } },
    },
    {
      label: "no result case",
      response: { result: { case: "askQuestionInteractionResponse", value: {} } },
      assert: (r) => {
        assert.equal(r.result.case, "error");
        assert.ok(r.result.value.errorMessage.includes("AskQuestion"));
      },
    },
  ];
  for (const { response, expected, assert: customAssert } of cases) {
    const r = toolResultFromInteractionResponse("AskQuestion", response);
    if (customAssert) customAssert(r);
    else assert.deepEqual(r, expected);
  }
});

test("toolResultFromInteractionResponse maps SwitchMode cases", () => {
  const approved = toolResultFromInteractionResponse("SwitchMode", {
    result: {
      case: "switchModeRequestResponse",
      value: { result: { case: "approved", value: {} } },
    },
  }, { target_mode_id: "agent" });
  assert.equal(approved.result.case, "success");
  assert.equal(approved.result.value.toModeId, "agent");

  const success = toolResultFromInteractionResponse("SwitchMode", {
    result: {
      case: "switchModeRequestResponse",
      value: { result: { case: "success", value: {} } },
    },
  }, { targetModeId: "edit" });
  assert.equal(success.result.value.toModeId, "edit");

  const rejected = toolResultFromInteractionResponse("SwitchMode", {
    result: {
      case: "switchModeRequestResponse",
      value: { result: { case: "rejected", value: { reason: "Nope" } } },
    },
  });
  assert.equal(rejected.result.case, "rejected");

  const error = toolResultFromInteractionResponse("SwitchMode", {
    result: {
      case: "switchModeRequestResponse",
      value: { result: { case: "unknown_case", value: {} } },
    },
  });
  assert.equal(error.result.case, "error");
  assert.ok(error.result.value.error.includes("SwitchMode"));
});

test("toolResultFromInteractionResponse maps CreatePlan and unknown tools", () => {
  const success = toolResultFromInteractionResponse("CreatePlan", {
    result: {
      case: "createPlanRequestResponse",
      value: { result: { case: "success", value: { planId: "p-1" } } },
    },
  });
  assert.equal(success.result.value.planId, "p-1");

  // Binary decoder shape: the result oneof is wrapped twice (value.result.result).
  const decodedSuccess = toolResultFromInteractionResponse("CreatePlan", {
    result: {
      case: "createPlanRequestResponse",
      value: { result: { result: { case: "success", value: { planId: "p-2" } } } },
    },
  });
  assert.equal(decodedSuccess.result.case, "success");
  assert.equal(decodedSuccess.result.value.planId, "p-2");

  const error = toolResultFromInteractionResponse("CreatePlan", {
    result: {
      case: "createPlanRequestResponse",
      value: { result: { result: { case: "error", value: { error: "Bad plan" } } } },
    },
  });
  assert.equal(error.result.case, "error");
  assert.equal(error.result.value.error, "Bad plan");

  const rejected = toolResultFromInteractionResponse("CreatePlan", {
    result: {
      case: "createPlanRequestResponse",
      value: { result: { result: { case: "rejected", value: { reason: "Not now" } } } },
    },
  });
  assert.equal(rejected.result.case, "rejected");
  assert.equal(rejected.result.value.reason, "Not now");

  const unknown = toolResultFromInteractionResponse("UnknownTool", {});
  assert.equal(unknown.result.case, "error");
  assert.ok(unknown.result.value.error.includes("Unsupported"));
});

test("providerTextFromInteractionResponse formats tool outcomes", () => {
  const cases = [
    {
      tool: "AskQuestion",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              case: "success",
              value: { answers: [{ questionId: "q1", selectedOptionIds: ["a", "b"], freeformText: "notes" }] },
            },
          },
        },
      },
      match: [/q1/, /a, b/, /notes/],
    },
    {
      tool: "AskQuestion",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "success", value: { answers: [] } } },
        },
      },
      match: [/no answers/],
    },
    {
      tool: "AskQuestion",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "error", value: { errorMessage: "Oops" } } },
        },
      },
      match: [/error/, /Oops/],
    },
    {
      tool: "AskQuestion",
      response: {
        result: {
          case: "askQuestionInteractionResponse",
          value: { result: { case: "rejected", value: { reason: "Denied" } } },
        },
      },
      match: [/rejected/, /Denied/],
    },
    {
      tool: "SwitchMode",
      response: {
        result: {
          case: "switchModeRequestResponse",
          value: { result: { case: "approved", value: {} } },
        },
      },
      args: { target_mode_id: "agent" },
      match: [/Switched/, /agent/],
    },
    {
      tool: "SwitchMode",
      response: {
        result: {
          case: "switchModeRequestResponse",
          value: { result: { case: "rejected", value: { reason: "No way" } } },
        },
      },
      match: [/rejected/, /No way/],
    },
    {
      tool: "SwitchMode",
      response: {
        result: {
          case: "switchModeRequestResponse",
          value: { result: { case: "broken", value: { error: "fail" } } },
        },
      },
      match: [/^Mode switch error: fail$/],
    },
    {
      tool: "CreatePlan",
      response: {
        result: {
          case: "createPlanRequestResponse",
          value: { result: { case: "success", value: {} } },
        },
      },
      match: [/accepted/],
    },
    {
      tool: "CreatePlan",
      response: {
        result: {
          case: "createPlanRequestResponse",
          // Binary decoder shape: the result oneof is wrapped twice.
          value: { result: { result: { case: "rejected", value: { reason: "Nah" } } } },
        },
      },
      match: [/rejected/, /Nah/],
    },
    {
      tool: "CreatePlan",
      response: {
        result: {
          case: "createPlanRequestResponse",
          value: { result: { result: { case: "error", value: { error: "boom" } } } },
        },
      },
      match: [/error/, /boom/],
    },
  ];
  for (const { tool, response, args, match } of cases) {
    const text = providerTextFromInteractionResponse(tool, response, args);
    for (const pattern of match) assert.match(text, pattern);
  }
  assert.ok(providerTextFromInteractionResponse("UnknownTool", {}).includes("Unsupported"));
  assert.ok(providerTextFromInteractionResponse("AskQuestion", null).includes("AskQuestion error"));
});

test("summarizeInteractionResponse extracts summary fields", () => {
  const success = summarizeInteractionResponse("AskQuestion", {
    result: {
      case: "askQuestionInteractionResponse",
      value: {
        result: {
          case: "success",
          value: {
            answers: [
              { questionId: "q1", selectedOptionIds: ["a"] },
              { questionId: "q2", selectedOptionIds: ["b", "c"] },
            ],
          },
        },
      },
    },
  });
  assert.equal(success.interactionTopCase, "askQuestionInteractionResponse");
  assert.equal(success.interactionResultCase, "success");
  assert.equal(success.interactionAnswerCount, 2);
  assert.equal(success.interactionFirstQuestionId, "q1");

  const error = summarizeInteractionResponse("AskQuestion", {
    result: {
      case: "askQuestionInteractionResponse",
      value: { result: { case: "error", value: { errorMessage: "Something went wrong" } } },
    },
  });
  assert.equal(error.interactionErrorPreview, "Something went wrong");

  const rejected = summarizeInteractionResponse("SwitchMode", {
    result: {
      case: "switchModeRequestResponse",
      value: { result: { case: "rejected", value: { reason: "User declined" } } },
    },
  });
  assert.equal(rejected.interactionRejectReasonPreview, "User declined");

  const empty = summarizeInteractionResponse("AskQuestion", {});
  assert.equal(empty.interactionTopCase, undefined);
  assert.equal(empty.interactionAnswerCount, undefined);
});

test("interactionTimeoutResponse maps tools to timeout envelopes", () => {
  const cases = [
    ["AskQuestion", 5, "timed out", "askQuestionInteractionResponse", "error", "timed out"],
    ["SwitchMode", 3, "timeout", "switchModeRequestResponse", "rejected", "timeout"],
    ["CreatePlan", 8, "slow", "createPlanRequestResponse", "rejected", "slow"],
    ["mcp_auth", 6, "auth timeout", "mcpAuthRequestResponse", "rejected", "auth timeout"],
    ["WebSearch", 1, "web timeout", "webSearchRequestResponse", "rejected", "web timeout"],
    ["GenerateImage", 2, "image timeout", "generateImageRequestResponse", "rejected", "image timeout"],
  ];
  for (const [tool, queryId, reason, topCase, resultCase, expectedReason] of cases) {
    const r = interactionTimeoutResponse(tool, queryId, reason);
    assert.equal(r.id, queryId);
    assert.equal(r.result.case, topCase);
    assert.equal(r.result.value.result.case, resultCase);
    if (resultCase === "error") assert.equal(r.result.value.result.value.errorMessage, expectedReason);
    else assert.equal(r.result.value.result.value.reason, expectedReason);
  }

  const unknown = interactionTimeoutResponse("UnknownTool", 9);
  assert.equal(unknown.result.case, "askQuestionInteractionResponse");
  assert.ok(unknown.result.value.result.value.errorMessage.includes("Timed out"));

  const defaultReason = interactionTimeoutResponse("AskQuestion", 4, "");
  assert.ok(defaultReason.result.value.result.value.errorMessage.includes("Timed out"));
  assert.ok(defaultReason.result.value.result.value.errorMessage.includes("4"));
  assert.equal(interactionTimeoutResponse("AskQuestion", "abc").id, 0);
});

test("timeout envelopes round-trip through the provider text renderer as failures", () => {
  // The timeout envelope is exactly what reaches providerTextFromInteractionResponse
  // when Cursor never answers an interaction query; a timed-out interaction must
  // never read as a success to the model.
  assert.equal(
    providerTextFromInteractionResponse("AskQuestion", interactionTimeoutResponse("AskQuestion", 7, "ask timed out")),
    "AskQuestion error: ask timed out",
  );
  assert.equal(
    providerTextFromInteractionResponse(
      "SwitchMode",
      interactionTimeoutResponse("SwitchMode", 8, "switch timed out"),
      { target_mode_id: "agent" },
    ),
    "Mode switch rejected: switch timed out",
  );
  assert.equal(
    providerTextFromInteractionResponse("CreatePlan", interactionTimeoutResponse("CreatePlan", 9, "plan timed out")),
    "Plan rejected: plan timed out",
  );
});
