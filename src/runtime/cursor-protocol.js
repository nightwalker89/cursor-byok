"use strict";

const { extractPayloadBytes, findRequestId } = require("./state");

function decodeBidiClientMessage(record) {
  const requestId = record?.requestId || findRequestId(record?.json ?? record);
  const payload = extractPayloadBytes(record?.json ?? record?.body ?? record);
  if (!payload.length) return { requestId, payloadLength: 0, clientMessage: null };
  return {
    requestId,
    payloadLength: payload.length,
    clientMessage: decodeAgentClientMessage(payload),
  };
}

function decodeAgentClientMessage(buffer) {
  const fields = decodeFields(buffer);
  const runRequest = firstBytes(fields, 1);
  if (runRequest) return oneof("runRequest", decodeAgentRunRequest(runRequest));
  const execClientMessage = firstBytes(fields, 2);
  if (execClientMessage) return oneof("execClientMessage", decodeExecClientMessage(execClientMessage));
  const conversationAction = firstBytes(fields, 4);
  if (conversationAction) return oneof("conversationAction", decodeConversationAction(conversationAction));
  const interactionResponse = firstBytes(fields, 6);
  if (interactionResponse) return oneof("interactionResponse", decodeInteractionResponse(interactionResponse));
  if (firstBytes(fields, 7)) return oneof("clientHeartbeat", {});
  return { message: { case: undefined } };
}

function decodeInteractionResponse(buffer) {
  const fields = decodeFields(buffer);
  const out = cleanUndefined({
    id: firstNumber(fields, 1) || 0,
  });
  const result = decodeOneof(fields, [
    [2, "webSearchRequestResponse", decodeWebSearchRequestResponse],
    [3, "askQuestionInteractionResponse", decodeAskQuestionInteractionResponse],
    [4, "switchModeRequestResponse", decodeSwitchModeRequestResponse],
    [7, "createPlanRequestResponse", decodeCreatePlanRequestResponse],
    [9, "webFetchRequestResponse", decodeWebFetchRequestResponse],
    [11, "mcpAuthRequestResponse", decodeMcpAuthRequestResponse],
    [12, "generateImageRequestResponse", decodeGenerateImageRequestResponse],
  ], "result").result;
  if (result.case) out.result = result;
  return out;
}

function decodeAskQuestionInteractionResponse(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    result: mapBytes(fields, 1, decodeAskQuestionResultUnion),
  });
}

function decodeSwitchModeRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "approved", decodeGenericMessage],
    [2, "rejected", decodeRejectedInteraction],
  ], "result");
}

function decodeWebSearchRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    result: mapBytes(fields, 1, decodeGenericResultUnion),
  });
}

function decodeGenerateImageRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    result: mapBytes(fields, 1, decodeGenericResultUnion),
  });
}

function decodeWebFetchRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    result: mapBytes(fields, 1, decodeGenericResultUnion),
  });
}

function decodeCreatePlanRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    result: mapBytes(fields, 1, decodeGenericResultUnion),
  });
}

function decodeRejectedInteraction(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    reason: firstString(fields, 1) || "",
  });
}

function decodeGenericResultUnion(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "success", decodeGenericMessage],
    [2, "error", decodeGenericMessage],
    [3, "rejected", decodeRejectedInteraction],
    [4, "async", decodeGenericMessage],
  ], "result");
}

function decodeAskQuestionResultUnion(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "success", decodeAskQuestionSuccess],
    [2, "error", decodeAskQuestionError],
    [3, "rejected", decodeRejectedInteraction],
    [4, "async", decodeGenericMessage],
  ], "result");
}

function decodeAskQuestionSuccess(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    answers: allBytes(fields, 1).map(decodeAskQuestionAnswer),
  });
}

function decodeAskQuestionAnswer(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    questionId: firstString(fields, 1) || "",
    selectedOptionIds: allStrings(fields, 2),
    freeformText: firstString(fields, 3) || "",
  });
}

function decodeAskQuestionError(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    errorMessage: firstString(fields, 1) || "",
  });
}

function decodeMcpAuthRequestResponse(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "approved", decodeGenericMessage],
    [2, "rejected", decodeRejectedInteraction],
  ], "result");
}

function decodeAgentRunRequest(buffer) {
  const fields = decodeFields(buffer);
  const known = [1, 2, 3, 4, 5, 8, 9];
  const unknownFields = {};
  for (const f of fields) {
    if (!known.includes(f.no)) {
      const key = `field_${f.no}`;
      if (f.wire === 2) {
        const raw = f.value;
        unknownFields[key] = looksUtf8(raw) ? raw.toString("utf8") : bytesJson(raw);
      } else if (f.wire === 0) {
        unknownFields[key] = numberFromBigInt(f.value);
      } else if (f.wire === 1) {
        unknownFields[key] = f.value.readDoubleLE(0);
      } else if (f.wire === 5) {
        unknownFields[key] = f.value.readUInt32LE(0);
      }
    }
  }
  const field6Raw = firstBytes(fields, 6);
  const field6 = field6Raw ? tryDecodeConversationState(field6Raw) : undefined;
  const field7Raw = firstBytes(fields, 7);
  const field7 = field7Raw ? tryDecodeToolDefinitions(field7Raw) : undefined;

  return cleanUndefined({
    conversationState: firstBytes(fields, 1) ? {} : undefined,
    action: mapBytes(fields, 2, decodeConversationAction),
    modelDetails: mapBytes(fields, 3, decodeModelDetails),
    mcpTools: mapBytes(fields, 4, decodeMcpTools),
    conversationId: firstString(fields, 5),
    field6_conversationState: field6,
    field7_builtinTools: field7,
    customSystemPrompt: firstString(fields, 8),
    requestedModel: mapBytes(fields, 9, decodeRequestedModel),
    _unknownFields: Object.keys(unknownFields).length ? unknownFields : undefined,
  });
}

/**
 * Field 6 hypothesis: contains conversation-state sub-fields
 * (historyBlobIds, historySummaryArchiveIds, historyTokenDetails, mode, etc.)
 * These are what ouCn8OA() extracts from the runRequest.
 */
function tryDecodeConversationState(buffer) {
  try {
    const fields = decodeFields(buffer);
    return cleanUndefined({
      historyBlobIds: allStrings(fields, 1),
      historySummaryArchiveIds: allStrings(fields, 2),
      historyTokenDetails: mapBytes(fields, 3, decodeTokenDetails),
      mode: firstString(fields, 4),
      userText: firstString(fields, 5),
      isResume: firstBool(fields, 6),
      isExecutePlan: firstBool(fields, 7),
      isSummarize: firstBool(fields, 8),
      isBackgroundTaskCompletion: firstBool(fields, 9),
      required: allStrings(fields, 10),
      _raw: decodeGenericMessage(buffer),
    });
  } catch {
    return { _raw: decodeGenericMessage(buffer) };
  }
}

function decodeTokenDetails(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    usedTokens: firstNumber(fields, 1),
    maxTokens: firstNumber(fields, 2),
    _raw: decodeGenericMessage(buffer),
  });
}

/**
 * Field 7 hypothesis: contains builtin tool definitions (the full tool catalog)
 * If so, this would let us eliminate CURSOR_BUILTIN_TOOLS entirely.
 */
function tryDecodeToolDefinitions(buffer) {
  try {
    const fields = decodeFields(buffer);
    const tools = allBytes(fields, 1).map(decodeToolDef);
    if (tools.length > 0) return { tools, _type: "repeated_tool_def" };
    return { _raw: decodeGenericMessage(buffer), _type: "generic" };
  } catch {
    return { _raw: decodeGenericMessage(buffer), _type: "fallback" };
  }
}

function decodeToolDef(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    name: firstString(fields, 1),
    description: firstString(fields, 2),
    inputSchema: mapBytes(fields, 3, decodeStruct),
    providerIdentifier: firstString(fields, 4),
    toolName: firstString(fields, 5),
    _raw: decodeGenericMessage(buffer),
  });
}

function decodeModelDetails(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    modelId: firstString(fields, 1),
    displayModelId: firstString(fields, 3),
    displayName: firstString(fields, 4),
  });
}

function decodeRequestedModel(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ modelId: firstString(fields, 1) });
}

function decodeConversationAction(buffer) {
  const fields = decodeFields(buffer);
  const userMessageAction = firstBytes(fields, 1);
  if (userMessageAction) {
    return { action: { case: "userMessageAction", value: decodeUserMessageAction(userMessageAction) } };
  }
  if (firstBytes(fields, 2)) return { action: { case: "resumeAction", value: {} } };
  if (firstBytes(fields, 3)) return { action: { case: "cancelAction", value: {} } };
  if (firstBytes(fields, 4)) return { action: { case: "summarizeAction", value: {} } };
  const startPlanAction = firstBytes(fields, 6);
  if (startPlanAction) {
    return { action: { case: "startPlanAction", value: decodeStartPlanAction(startPlanAction) } };
  }
  const executePlanAction = firstBytes(fields, 7);
  if (executePlanAction) {
    return { action: { case: "executePlanAction", value: decodeExecutePlanAction(executePlanAction) } };
  }
  return { action: { case: undefined } };
}

function decodeStartPlanAction(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    userMessage: mapBytes(fields, 1, decodeUserMessage),
    isSpec: firstBool(fields, 3),
  });
}

function decodeExecutePlanAction(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    planFileUri: firstString(fields, 3),
    planFileContent: firstString(fields, 4),
    executionMode: firstNumber(fields, 5),
    kickoffMessageId: firstString(fields, 6),
    planId: firstString(fields, 7),
    planFilePath: firstString(fields, 8),
  });
}

function decodeUserMessageAction(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ userMessage: mapBytes(fields, 1, decodeUserMessage) });
}

function decodeUserMessage(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    text: firstString(fields, 1),
    messageId: firstString(fields, 2),
  });
}

function decodeMcpTools(buffer) {
  const fields = decodeFields(buffer);
  return { mcpTools: allBytes(fields, 1).map(decodeMcpToolDefinition) };
}

function decodeMcpToolDefinition(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    name: firstString(fields, 1),
    description: firstString(fields, 2),
    inputSchema: mapBytes(fields, 3, decodeStruct),
    providerIdentifier: firstString(fields, 4),
    toolName: firstString(fields, 5),
  });
}

function decodeExecClientMessage(buffer) {
  const fields = decodeFields(buffer);
  const out = cleanUndefined({
    id: firstNumber(fields, 1) || 0,
    execId: firstString(fields, 15) || "",
    localExecutionTimeMs: firstNumber(fields, 39),
  });
  const cases = [
    [2, "shellResult", decodeGenericMessage],
    [3, "writeResult", decodeGenericMessage],
    [4, "deleteResult", decodeGenericMessage],
    [5, "grepResult", decodeGrepResult],
    // Cursor has shipped readResult under two field numbers; field 7 is the
    // legacy slot and 29 the newer one. The loop below stops at the first field
    // present, so 7 wins when both are set — order here is the precedence.
    [7, "readResult", decodeReadResult],
    [29, "readResult", decodeReadResult],
    [8, "lsResult", decodeGenericMessage],
    [9, "diagnosticsResult", decodeGenericMessage],
    [10, "requestContextResult", decodeGenericMessage],
    [11, "mcpResult", decodeGenericMessage],
    [14, "shellStream", decodeShellStream],
    [20, "fetchResult", decodeGenericMessage],
    [21, "recordScreenResult", decodeGenericMessage],
    [22, "computerUseResult", decodeGenericMessage],
    [23, "writeShellStdinResult", decodeGenericMessage],
    [37, "subagentAwaitResult", decodeGenericMessage],
  ];
  for (const [fieldNo, caseName, decoder] of cases) {
    const value = firstBytes(fields, fieldNo);
    if (value) {
      out.message = { case: caseName, value: decoder(value) };
      break;
    }
  }
  return out;
}

function decodeShellStream(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "stdout", decodeShellStreamOutput],
    [2, "stderr", decodeShellStreamOutput],
    [3, "exit", decodeShellStreamExit],
    [4, "start", decodeShellStreamStart],
    [5, "rejected", decodeShellRejected],
    [6, "permissionDenied", decodeShellPermissionDenied],
    [7, "backgrounded", decodeShellBackgrounded],
  ], "event");
}

function decodeShellStreamOutput(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ data: firstString(fields, 1) || "" });
}

function decodeShellStreamExit(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    code: firstNumber(fields, 1) || 0,
    cwd: firstString(fields, 2) || "",
    outputLocation: mapBytes(fields, 3, decodeGenericMessage),
    aborted: firstBool(fields, 4) || false,
    abortReason: firstNumber(fields, 5),
    localExecutionTimeMs: firstNumber(fields, 6),
  });
}

function decodeShellStreamStart(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ sandboxPolicy: mapBytes(fields, 1, decodeGenericMessage) });
}

function decodeShellRejected(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    command: firstString(fields, 1) || "",
    workingDirectory: firstString(fields, 2) || "",
    reason: firstString(fields, 3) || "",
    isReadonly: firstBool(fields, 4) || false,
  });
}

function decodeShellPermissionDenied(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    command: firstString(fields, 1) || "",
    workingDirectory: firstString(fields, 2) || "",
    error: firstString(fields, 3) || "",
    isReadonly: firstBool(fields, 4) || false,
  });
}

function decodeShellBackgrounded(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    shellId: firstNumber(fields, 1) || 0,
    command: firstString(fields, 2) || "",
    workingDirectory: firstString(fields, 3) || "",
    pid: firstNumber(fields, 4),
    msToWait: firstNumber(fields, 5),
    backgroundReason: firstNumber(fields, 6),
  });
}

function decodeReadResult(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "success", decodeReadSuccess],
    [2, "error", decodeReadError],
    [3, "rejected", decodeReadRejected],
    [4, "fileNotFound", decodeReadFileNotFound],
    [5, "permissionDenied", decodeReadPermissionDenied],
    [6, "invalidFile", decodeReadInvalidFile],
  ], "result");
}

function decodeReadSuccess(buffer) {
  const fields = decodeFields(buffer);
  const output = firstString(fields, 2) !== undefined
    ? { case: "content", value: firstString(fields, 2) }
    : firstBytes(fields, 5)
      ? { case: "data", value: bytesJson(firstBytes(fields, 5)) }
      : undefined;
  return cleanUndefined({
    path: firstString(fields, 1),
    output,
    totalLines: firstNumber(fields, 3) || 0,
    fileSize: firstNumber(fields, 4) || 0,
    truncated: firstBool(fields, 6) || false,
    outputBlobId: bytesJson(firstBytes(fields, 7)),
    rangeApplied: firstBool(fields, 8),
  });
}

function decodeReadError(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ path: firstString(fields, 1), error: firstString(fields, 2) });
}

function decodeReadRejected(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ path: firstString(fields, 1), reason: firstString(fields, 2) });
}

function decodeReadFileNotFound(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ path: firstString(fields, 1) });
}

function decodeReadPermissionDenied(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ path: firstString(fields, 1) });
}

function decodeReadInvalidFile(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ path: firstString(fields, 1), reason: firstString(fields, 2) });
}

function decodeGrepResult(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "success", decodeGrepSuccess],
    [2, "error", decodeGrepError],
  ], "result");
}

function decodeGrepError(buffer) {
  const fields = decodeFields(buffer);
  return { error: firstString(fields, 1) || "" };
}

function decodeGrepSuccess(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    pattern: firstString(fields, 1) || "",
    path: firstString(fields, 2) || "",
    outputMode: firstString(fields, 3) || "",
    workspaceResults: decodeStringMessageMap(fields, 4, decodeGrepUnionResult),
    activeEditorResult: mapBytes(fields, 5, decodeGrepUnionResult),
  });
}

function decodeGrepUnionResult(buffer) {
  const fields = decodeFields(buffer);
  return decodeOneof(fields, [
    [1, "count", decodeGrepCountResult],
    [2, "files", decodeGrepFilesResult],
    [3, "content", decodeGrepContentResult],
  ], "result");
}

function decodeGrepCountResult(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    counts: allBytes(fields, 1).map(decodeGrepFileCount),
    totalFiles: firstNumber(fields, 2) || 0,
    totalMatches: firstNumber(fields, 3) || 0,
    clientTruncated: firstBool(fields, 4) || false,
    ripgrepTruncated: firstBool(fields, 5) || false,
    headLimitApplied: firstNumber(fields, 6),
    offsetApplied: firstNumber(fields, 7),
  });
}

function decodeGrepFileCount(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({ file: firstString(fields, 1) || "", count: firstNumber(fields, 2) || 0 });
}

function decodeGrepFilesResult(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    files: allStrings(fields, 1),
    totalFiles: firstNumber(fields, 2) || 0,
    clientTruncated: firstBool(fields, 3) || false,
    ripgrepTruncated: firstBool(fields, 4) || false,
    headLimitApplied: firstNumber(fields, 5),
    offsetApplied: firstNumber(fields, 6),
  });
}

function decodeGrepContentResult(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    matches: allBytes(fields, 1).map(decodeGrepFileMatch),
    totalLines: firstNumber(fields, 2) || 0,
    totalMatchedLines: firstNumber(fields, 3) || 0,
    clientTruncated: firstBool(fields, 4) || false,
    ripgrepTruncated: firstBool(fields, 5) || false,
    headLimitApplied: firstNumber(fields, 6),
    offsetApplied: firstNumber(fields, 7),
  });
}

function decodeGrepFileMatch(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    file: firstString(fields, 1) || "",
    matches: allBytes(fields, 2).map(decodeGrepContentMatch),
  });
}

function decodeGrepContentMatch(buffer) {
  const fields = decodeFields(buffer);
  return cleanUndefined({
    lineNumber: firstNumber(fields, 1) || 0,
    content: firstString(fields, 2) || "",
    contentTruncated: firstBool(fields, 3) || false,
    isContextLine: firstBool(fields, 4) || false,
  });
}

function decodeStruct(buffer) {
  const fields = decodeFields(buffer);
  const out = {};
  for (const entry of allBytes(fields, 1)) {
    const entryFields = decodeFields(entry);
    const key = firstString(entryFields, 1);
    if (!key) continue;
    out[key] = mapBytes(entryFields, 2, decodeValue);
  }
  return out;
}

function decodeValue(buffer) {
  const fields = decodeFields(buffer);
  if (fields.some((field) => field.no === 1)) return null;
  const number = firstDouble(fields, 2);
  if (number !== undefined) return number;
  const string = firstString(fields, 3);
  if (string !== undefined) return string;
  const bool = firstBool(fields, 4);
  if (bool !== undefined) return bool;
  const struct = firstBytes(fields, 5);
  if (struct) return decodeStruct(struct);
  const list = firstBytes(fields, 6);
  if (list) return decodeListValue(list);
  return undefined;
}

function decodeListValue(buffer) {
  const fields = decodeFields(buffer);
  return allBytes(fields, 1).map(decodeValue);
}

function decodeGenericMessage(buffer) {
  const fields = decodeFields(buffer);
  const out = {};
  for (const field of fields) {
    const key = String(field.no);
    if (field.wire === 2) {
      out[key] = looksUtf8(field.value) ? field.value.toString("utf8") : bytesJson(field.value);
    } else if (field.wire === 0) {
      out[key] = numberFromBigInt(field.value);
    } else if (field.wire === 1) {
      out[key] = field.value.readDoubleLE(0);
    } else if (field.wire === 5) {
      out[key] = field.value.readUInt32LE(0);
    }
  }
  return out;
}

function decodeOneof(fields, cases, key) {
  for (const [fieldNo, caseName, decoder] of cases) {
    const value = firstBytes(fields, fieldNo);
    if (value) return { [key]: { case: caseName, value: decoder(value) } };
  }
  return { [key]: { case: undefined } };
}

function decodeStringMessageMap(fields, fieldNo, valueDecoder) {
  const out = {};
  for (const entry of allBytes(fields, fieldNo)) {
    const entryFields = decodeFields(entry);
    const key = firstString(entryFields, 1);
    const value = firstBytes(entryFields, 2);
    if (key && value) out[key] = valueDecoder(value);
  }
  return out;
}

function decodeFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const no = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      fields.push({ no, wire, value: value.value });
      offset = value.offset;
    } else if (wire === 1) {
      fields.push({ no, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const len = readVarint(buffer, offset);
      offset = len.offset;
      const end = offset + Number(len.value);
      fields.push({ no, wire, value: buffer.subarray(offset, end) });
      offset = end;
    } else if (wire === 5) {
      fields.push({ no, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (offset >= buffer.length) throw new Error("Truncated protobuf varint");
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
    if (shift > 70n) throw new Error("Invalid protobuf varint");
  }
}

function oneof(caseName, value) {
  return { message: { case: caseName, value } };
}

function firstField(fields, no, wire) {
  return fields.find((field) => field.no === no && (wire === undefined || field.wire === wire));
}

function firstBytes(fields, no) {
  return firstField(fields, no, 2)?.value;
}

function allBytes(fields, no) {
  return fields.filter((field) => field.no === no && field.wire === 2).map((field) => field.value);
}

function firstString(fields, no) {
  const bytes = firstBytes(fields, no);
  return bytes ? bytes.toString("utf8") : undefined;
}

function allStrings(fields, no) {
  return allBytes(fields, no).map((bytes) => bytes.toString("utf8"));
}

function firstNumber(fields, no) {
  const field = firstField(fields, no, 0);
  return field ? numberFromBigInt(field.value) : undefined;
}

function firstBool(fields, no) {
  const field = firstField(fields, no, 0);
  return field ? field.value !== 0n : undefined;
}

function firstDouble(fields, no) {
  const field = firstField(fields, no, 1);
  return field ? field.value.readDoubleLE(0) : undefined;
}

function mapBytes(fields, no, mapper) {
  const bytes = firstBytes(fields, no);
  return bytes ? mapper(bytes) : undefined;
}

function numberFromBigInt(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function bytesJson(value) {
  return value && value.length ? Buffer.from(value).toString("base64") : undefined;
}

function looksUtf8(buffer) {
  if (!buffer.length) return true;
  return !buffer.toString("utf8").includes("\uFFFD");
}

function cleanUndefined(value) {
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child;
  }
  return out;
}

module.exports = {
  decodeAgentClientMessage,
  decodeBidiClientMessage,
  decodeInteractionResponse,
  decodeFields,
  decodeStruct,
};
