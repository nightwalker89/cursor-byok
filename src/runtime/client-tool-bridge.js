"use strict";

const CLIENT_INTERACTION_TOOL_NAMES = new Set([
  "WebSearch",
  "WebFetch",
  "GenerateImage",
]);

function isClientInteractionTool(name) {
  return CLIENT_INTERACTION_TOOL_NAMES.has(name);
}

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function arrayArg(value) {
  return Array.isArray(value) ? value : [];
}

function coalesceStringAliases(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  for (const key of keys) {
    const value = stringArg(input[key], "");
    if (value) return value;
  }
  return "";
}

function normalizeWebSearchQueryArgs(args, toolCallId) {
  return {
    searchTerm: coalesceStringAliases(args, ["search_term", "searchTerm"]),
    toolCallId: stringArg(toolCallId),
  };
}

function normalizeWebFetchQueryArgs(args, toolCallId) {
  return {
    url: coalesceStringAliases(args, ["url"]),
    toolCallId: stringArg(toolCallId),
  };
}

function normalizeGenerateImageQueryArgs(args, toolCallId) {
  const referenceImagePaths = arrayArg(args?.reference_image_paths ?? args?.referenceImagePaths);
  const out = {
    description: stringArg(args?.description),
    referenceImagePaths,
    toolCallId: stringArg(toolCallId),
  };
  const filePath = coalesceStringAliases(args, ["filename", "filePath", "file_path"]);
  if (filePath) out.filePath = filePath;
  return out;
}

function buildClientInteractionQuery(toolName, toolCallId, args, queryId) {
  const id = Number(queryId) || 0;
  switch (toolName) {
    case "WebSearch":
      return {
        id,
        query: {
          case: "webSearchRequestQuery",
          value: {
            args: normalizeWebSearchQueryArgs(args, toolCallId),
          },
        },
      };
    case "WebFetch":
      return {
        id,
        query: {
          case: "webFetchRequestQuery",
          value: {
            args: normalizeWebFetchQueryArgs(args, toolCallId),
          },
        },
      };
    case "GenerateImage":
      return {
        id,
        query: {
          case: "generateImageRequestQuery",
          value: {
            args: normalizeGenerateImageQueryArgs(args, toolCallId),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    default:
      return { id, query: { case: undefined, value: undefined } };
  }
}

function interactionApprovalCase(interactionResponse) {
  const top = interactionResponse?.result;
  if (!top?.case) return "";
  const topValue = top.value ?? {};
  const inner = topValue.result || topValue;
  return inner?.case || top.case || "";
}

function interactionApprovalGranted(interactionResponse) {
  const responseCase = interactionApprovalCase(interactionResponse);
  return responseCase === "approved" || responseCase === "success";
}

function interactionApprovalRejected(interactionResponse) {
  return interactionApprovalCase(interactionResponse) === "rejected";
}

function extractToolCallId(node) {
  if (!node || typeof node !== "object") return "";
  const direct = node.toolCallId ?? node.tool_call_id;
  if (typeof direct === "string" && direct) return direct;
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  const toolCall = node.toolCall;
  if (toolCall && typeof toolCall === "object") {
    const nested = toolCall.toolCallId ?? toolCall.tool_call_id;
    if (typeof nested === "string" && nested) return nested;
    if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
  }
  return "";
}

function extractToolResultEnvelope(node, toolName) {
  if (!node || typeof node !== "object") return null;
  const tool = node.toolCall?.tool ?? node.tool?.tool ?? node.tool;
  if (!tool || typeof tool !== "object") return null;
  const toolCase = tool.case;
  if (toolName === "WebSearch" && toolCase && toolCase !== "webSearchToolCall") return null;
  if (toolName === "WebFetch" && toolCase && toolCase !== "webFetchToolCall") return null;
  if (toolName === "GenerateImage" && toolCase && toolCase !== "generateImageToolCall") return null;
  if (tool.value?.result) return tool.value.result;
  if (tool.result) return tool.result;
  return null;
}

function findClientToolCompletion(records, toolCallId, toolName) {
  const wantedId = String(toolCallId || "");
  if (!wantedId) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const hits = [];
    collectClientToolCompletionHits(record?.clientMessage, wantedId, toolName, hits);
    collectClientToolCompletionHits(record?.rawRecord, wantedId, toolName, hits);
    if (hits.length) return hits[hits.length - 1];
  }
  return null;
}

function collectClientToolCompletionHits(node, toolCallId, toolName, hits, depth = 0) {
  if (!node || depth > 24) return;
  if (Array.isArray(node)) {
    for (const item of node) collectClientToolCompletionHits(item, toolCallId, toolName, hits, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const messageCase = node.case ?? node.message?.case;
  if (messageCase === "toolCallCompleted") {
    const envelope = extractToolResultEnvelope(node.value?.message?.value ?? node.value ?? node.message?.value, toolName);
    const id = extractToolCallId(node.value?.message?.value ?? node.value ?? node.message?.value ?? node);
    if (envelope && id === toolCallId) hits.push(envelope);
  }

  if (messageCase === "interactionUpdate") {
    const inner = node.value?.message ?? node.message?.value?.message ?? node.value?.message?.value?.message;
    collectClientToolCompletionHits(inner, toolCallId, toolName, hits, depth + 1);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectClientToolCompletionHits(value, toolCallId, toolName, hits, depth + 1);
  }
}

function toolResultFromClientCompletion(toolName, completion) {
  if (!completion?.case) {
    return {
      result: {
        case: "error",
        value: { error: `${toolName} completed without a Cursor tool result` },
      },
    };
  }
  return { result: completion };
}

function providerTextFromClientCompletion(toolName, completion) {
  const toolResult = toolResultFromClientCompletion(toolName, completion);
  const result = toolResult.result;
  if (!result?.case) return `${toolName} failed`;

  if (result.case === "rejected") {
    return `${toolName} rejected: ${stringArg(result.value?.reason, "User rejected the request")}`;
  }
  if (result.case === "error") {
    return `${toolName} error: ${stringArg(result.value?.error ?? result.value?.errorMessage)}`;
  }

  if (toolName === "WebSearch") {
    const references = arrayArg(result.value?.references);
    if (!references.length) return "Web search completed with no references.";
    return references.map((ref, index) => {
      const title = stringArg(ref?.title, `Result ${index + 1}`);
      const url = stringArg(ref?.url);
      const chunk = stringArg(ref?.chunk);
      return `${title}${url ? ` (${url})` : ""}${chunk ? `\n${chunk}` : ""}`;
    }).join("\n\n");
  }

  if (toolName === "WebFetch") {
    const url = stringArg(result.value?.url);
    const markdown = stringArg(result.value?.markdown ?? result.value?.content ?? result.value?.body);
    if (!markdown) return url ? `WebFetch completed for ${url} with no content.` : "WebFetch completed with no content.";
    return url ? `# Content from ${url}\n\n${markdown}` : markdown;
  }

  if (toolName === "GenerateImage") {
    const path = stringArg(
      result.value?.filePath ?? result.value?.file_path ?? result.value?.path,
      "",
    );
    return path ? `Generated image at ${path}` : "Image generated successfully.";
  }

  return JSON.stringify(result.value ?? {});
}

function clientInteractionTimeoutResponse(toolName, queryId, reason) {
  const id = Number(queryId) || 0;
  const message = reason || `Timed out waiting for Cursor ${toolName} response`;
  switch (toolName) {
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
    default:
      return { id, result: { case: "error", value: { errorMessage: message } } };
  }
}

module.exports = {
  CLIENT_INTERACTION_TOOL_NAMES,
  isClientInteractionTool,
  buildClientInteractionQuery,
  interactionApprovalCase,
  interactionApprovalGranted,
  interactionApprovalRejected,
  findClientToolCompletion,
  toolResultFromClientCompletion,
  providerTextFromClientCompletion,
  clientInteractionTimeoutResponse,
  coalesceStringAliases,
  normalizeWebSearchQueryArgs,
  normalizeWebFetchQueryArgs,
  normalizeGenerateImageQueryArgs,
};
