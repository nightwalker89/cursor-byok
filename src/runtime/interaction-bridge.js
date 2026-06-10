"use strict";

const INTERACTION_BRIDGE_TOOL_NAMES = new Set([
  "AskQuestion",
  "SwitchMode",
  "CreatePlan",
]);

function isInteractionBridgeTool(name) {
  return INTERACTION_BRIDGE_TOOL_NAMES.has(name);
}

function isMcpAuthToolName(name) {
  return name === "mcp_auth";
}

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function arrayArg(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeAskQuestionArgs(args) {
  return {
    title: stringArg(args?.title, ""),
    questions: arrayArg(args?.questions).map((question) => ({
      id: stringArg(question?.id),
      prompt: stringArg(question?.prompt),
      allowMultiple: !!(question?.allow_multiple ?? question?.allowMultiple),
      options: arrayArg(question?.options).map((option) => ({
        id: stringArg(option?.id),
        label: stringArg(option?.label),
      })),
    })),
  };
}

function normalizeSwitchModeQueryArgs(args, toolCallId) {
  return {
    targetModeId: stringArg(args?.target_mode_id || args?.targetModeId),
    explanation: stringArg(args?.explanation, ""),
    toolCallId: stringArg(toolCallId),
  };
}

function planTodoStatus(status) {
  switch (stringArg(status).toLowerCase()) {
    case "pending":
      return 1;
    case "in_progress":
    case "in-progress":
    case "inprogress":
      return 2;
    case "completed":
    case "complete":
    case "done":
      return 3;
    case "cancelled":
    case "canceled":
      return 4;
    default:
      return Number.isInteger(status) ? status : undefined;
  }
}

function normalizePlanTodo(todo) {
  const out = {
    id: stringArg(todo?.id),
    content: stringArg(todo?.content),
    dependencies: arrayArg(todo?.dependencies).map(String),
  };
  const status = planTodoStatus(todo?.status);
  if (status !== undefined) out.status = status;
  return out;
}

function normalizeCreatePlanQueryArgs(args) {
  return {
    name: stringArg(args?.name, ""),
    overview: stringArg(args?.overview, ""),
    plan: stringArg(args?.plan, ""),
    todos: arrayArg(args?.todos).map(normalizePlanTodo),
    isProject: !!(args?.isProject ?? args?.is_project),
    phases: arrayArg(args?.phases).map((phase) => ({
      name: stringArg(phase?.name),
      todos: arrayArg(phase?.todos).map(normalizePlanTodo),
    })),
  };
}

function buildInteractionQuery(toolName, toolCallId, args, queryId) {
  const id = Number(queryId) || 0;
  switch (toolName) {
    case "AskQuestion":
      return {
        id,
        query: {
          case: "askQuestionInteractionQuery",
          value: {
            args: normalizeAskQuestionArgs(args),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    case "SwitchMode":
      return {
        id,
        query: {
          case: "switchModeRequestQuery",
          value: {
            args: normalizeSwitchModeQueryArgs(args, toolCallId),
          },
        },
      };
    case "CreatePlan":
      return {
        id,
        query: {
          case: "createPlanRequestQuery",
          value: {
            args: normalizeCreatePlanQueryArgs(args),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    default:
      return { id, query: { case: undefined, value: undefined } };
  }
}

function unwrapInteractionPayload(toolName, interactionResponse) {
  const top = interactionResponse?.result;
  if (!top?.case) return top;
  const topValue = top.value ?? {};
  if (toolName === "SwitchMode" && top.case === "switchModeRequestResponse") {
    return topValue.result || topValue;
  }
  if (toolName === "AskQuestion" && top.case === "askQuestionInteractionResponse") {
    return topValue.result || topValue;
  }
  if (toolName === "CreatePlan" && top.case === "createPlanRequestResponse") {
    return topValue.result || topValue;
  }
  return top;
}

function askQuestionResultError(message) {
  return {
    result: {
      case: "error",
      value: { errorMessage: message },
    },
  };
}

function normalizedAskQuestionAnswers(value) {
  return arrayArg(value?.answers).map((answer) => ({
    questionId: stringArg(answer?.questionId ?? answer?.question_id),
    selectedOptionIds: arrayArg(answer?.selectedOptionIds ?? answer?.selected_option_ids).map(String),
    freeformText: stringArg(answer?.freeformText ?? answer?.freeform_text, ""),
  }));
}

function toolResultFromInteractionResponse(toolName, interactionResponse, toolArgs = {}) {
  const payload = unwrapInteractionPayload(toolName, interactionResponse);
  const outerCase = payload?.case;
  const outerValue = payload?.value ?? payload ?? {};

  switch (toolName) {
    case "AskQuestion": {
      const inner = outerValue?.result || outerValue;
      const innerCase = inner?.case || outerCase;
      const innerValue = inner?.value ?? inner;
      if (innerCase === "success") {
        return { result: { case: "success", value: { answers: normalizedAskQuestionAnswers(innerValue) } } };
      }
      if (innerCase === "error") {
        return {
          result: {
            case: "error",
            value: { errorMessage: stringArg(innerValue?.errorMessage ?? innerValue?.error, "AskQuestion failed") },
          },
        };
      }
      if (innerCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(innerValue?.reason, "User rejected the questionnaire") },
          },
        };
      }
      if (innerCase === "async") {
        return { result: { case: "success", value: { isAsync: true, answers: [] } } };
      }
      return askQuestionResultError("AskQuestion completed without a Cursor result");
    }
    case "SwitchMode": {
      const targetModeId = stringArg(toolArgs?.target_mode_id ?? toolArgs?.targetModeId);
      const switchCase = outerCase || outerValue?.case;
      const switchValue = outerValue?.value ?? outerValue;
      if (switchCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(switchValue?.reason, "User rejected the mode switch") },
          },
        };
      }
      if (switchCase === "approved" || switchCase === "success") {
        return {
          result: {
            case: "success",
            value: { fromModeId: "", toModeId: targetModeId },
          },
        };
      }
      return {
        result: {
          case: "error",
          value: { error: stringArg(outerValue?.error, "SwitchMode failed") },
        },
      };
    }
    case "CreatePlan": {
      const inner = outerValue?.result || outerValue;
      const innerCase = inner?.case || outerCase;
      const innerValue = inner?.value ?? inner;
      if (innerCase === "error") {
        return {
          result: {
            case: "error",
            value: { error: stringArg(innerValue?.error, "CreatePlan failed") },
          },
        };
      }
      if (innerCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(innerValue?.reason, "User rejected the plan") },
          },
        };
      }
      return {
        result: {
          case: "success",
          value: innerValue && typeof innerValue === "object" ? innerValue : {},
        },
      };
    }
    default:
      return {
        result: {
          case: "error",
          value: { error: `Unsupported interaction tool ${toolName}` },
        },
      };
  }
}

function providerTextFromInteractionResponse(toolName, interactionResponse, toolArgs = {}) {
  const toolResult = toolResultFromInteractionResponse(toolName, interactionResponse, toolArgs);
  const result = toolResult?.result;
  if (!result?.case) return `${toolName} failed`;

  switch (toolName) {
    case "AskQuestion": {
      if (result.case === "error") {
        return `AskQuestion error: ${stringArg(result.value?.errorMessage ?? result.value?.error)}`;
      }
      if (result.case === "rejected") {
        return `AskQuestion rejected: ${stringArg(result.value?.reason, "User rejected the questionnaire")}`;
      }
      const answers = arrayArg(result.value?.answers);
      if (!answers.length) return "AskQuestion completed with no answers.";
      return answers.map((answer) => {
        const options = arrayArg(answer.selectedOptionIds).join(", ");
        const freeform = stringArg(answer.freeformText);
        return `Question ${answer.questionId}: selected [${options}]${freeform ? `; freeform: ${freeform}` : ""}`;
      }).join("\n");
    }
    case "SwitchMode": {
      if (result.case === "rejected") {
        return `Mode switch rejected: ${stringArg(result.value?.reason, "User rejected the mode switch")}`;
      }
      if (result.case === "error") {
        return `Mode switch error: ${stringArg(result.value?.error)}`;
      }
      const toModeId = stringArg(result.value?.toModeId ?? toolArgs?.target_mode_id);
      return `Switched composer mode to ${toModeId || "unknown"}`;
    }
    case "CreatePlan": {
      if (result.case === "rejected") {
        return `Plan rejected: ${stringArg(result.value?.reason, "User rejected the plan")}`;
      }
      if (result.case === "error") {
        return `CreatePlan error: ${stringArg(result.value?.error)}`;
      }
      return "Plan accepted by the user.";
    }
    default:
      return JSON.stringify(toolResult);
  }
}

function summarizeInteractionResponse(toolName, interactionResponse) {
  const top = interactionResponse?.result;
  const topValue = top?.value ?? {};
  const nested = topValue?.result;
  const payload = unwrapInteractionPayload(toolName, interactionResponse);
  const outerCase = payload?.case;
  const outerValue = payload?.value ?? payload ?? {};
  const inner = outerValue?.result || outerValue;
  const innerCase = inner?.case || outerCase;
  const innerValue = inner?.value ?? inner ?? {};
  const answers = arrayArg(innerValue?.answers);
  const firstAnswer = answers[0] || {};
  const selected = arrayArg(firstAnswer?.selectedOptionIds ?? firstAnswer?.selected_option_ids).map(String);
  return {
    interactionTopCase: top?.case,
    interactionNestedCase: nested?.case,
    interactionResultCase: innerCase,
    interactionAnswerCount: answers.length || undefined,
    interactionFirstQuestionId: stringArg(firstAnswer?.questionId ?? firstAnswer?.question_id) || undefined,
    interactionFirstSelectedOptionIds: selected.length ? selected.slice(0, 6) : undefined,
    interactionErrorPreview: stringArg(innerValue?.errorMessage ?? innerValue?.error, "").slice(0, 240) || undefined,
    interactionRejectReasonPreview: stringArg(innerValue?.reason, "").slice(0, 240) || undefined,
  };
}

function interactionTimeoutResponse(toolName, queryId, reason) {
  const id = Number(queryId) || 0;
  const message = reason || `Timed out waiting for Cursor interaction response ${queryId}`;
  if (isMcpAuthToolName(toolName)) {
    return {
      id,
      result: {
        case: "mcpAuthRequestResponse",
        value: { result: { case: "rejected", value: { reason: message } } },
      },
    };
  }
  switch (toolName) {
    case "SwitchMode":
      return {
        id,
        result: {
          case: "switchModeRequestResponse",
          value: { result: { case: "rejected", value: { reason: message } } },
        },
      };
    case "CreatePlan":
      return {
        id,
        result: {
          case: "createPlanRequestResponse",
          value: { result: { case: "rejected", value: { reason: message } } },
        },
      };
    case "WebSearch":
      return {
        id,
        result: {
          case: "webSearchRequestResponse",
          value: { result: { case: "rejected", value: { reason: message } } },
        },
      };
    case "WebFetch":
      return {
        id,
        result: {
          case: "webFetchRequestResponse",
          value: { result: { case: "rejected", value: { reason: message } } },
        },
      };
    case "GenerateImage":
      return {
        id,
        result: {
          case: "generateImageRequestResponse",
          value: { result: { case: "rejected", value: { reason: message } } },
        },
      };
    case "AskQuestion":
    default:
      return {
        id,
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: {
              case: "error",
              value: { errorMessage: message },
            },
          },
        },
      };
  }
}

module.exports = {
  INTERACTION_BRIDGE_TOOL_NAMES,
  isInteractionBridgeTool,
  isMcpAuthToolName,
  buildInteractionQuery,
  toolResultFromInteractionResponse,
  providerTextFromInteractionResponse,
  summarizeInteractionResponse,
  interactionTimeoutResponse,
  normalizeAskQuestionArgs,
  normalizeSwitchModeQueryArgs,
  normalizeCreatePlanQueryArgs,
  planTodoStatus,
};
