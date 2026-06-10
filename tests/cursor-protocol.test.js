"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeAgentClientMessage,
  decodeBidiClientMessage,
  decodeFields,
  decodeStruct,
} = require("../src/runtime/cursor-protocol");

// ---------------------------------------------------------------------------
// Proto encoding helpers (minimal standalone helpers for these protocol tests)
// ---------------------------------------------------------------------------

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

/** Encode a length-delimited field (wire type 2). */
function fieldMessage(no, value) {
  return Buffer.concat([varint((no << 3) | 2), varint(value.length), value]);
}

/** Encode a string field (wire type 2). */
function fieldString(no, value) {
  return fieldMessage(no, Buffer.from(value, "utf8"));
}

/** Encode a varint field (wire type 0). */
function fieldVarint(no, value) {
  return Buffer.concat([varint((no << 3) | 0), varint(value)]);
}

/** Encode a fixed64 field (wire type 1). */
function fieldDouble(no, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([varint((no << 3) | 1), buf]);
}

/** Concatenate encoded fields into a single message buffer. */
function protoMessage(fields) {
  return Buffer.concat(fields);
}

/** Build a protobuf Struct entry: key (field 1) + Value wrapper (field 2). */
function structEntry(key, valueFields) {
  const valueMsg = protoMessage(valueFields);
  return protoMessage([fieldString(1, key), fieldMessage(2, valueMsg)]);
}

// =========================================================================
// decodeFields
// =========================================================================

test("decodeFields: empty buffer returns empty array", () => {
  const fields = decodeFields(Buffer.alloc(0));
  assert.deepEqual(fields, []);
});

test("decodeFields: single varint field", () => {
  const buf = protoMessage([fieldVarint(1, 42)]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].no, 1);
  assert.equal(fields[0].wire, 0);
  assert.equal(fields[0].value, 42n);
});

test("decodeFields: single string field", () => {
  const buf = protoMessage([fieldString(2, "hello")]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].no, 2);
  assert.equal(fields[0].wire, 2);
  assert.equal(fields[0].value.toString("utf8"), "hello");
});

test("decodeFields: multiple fields of different types", () => {
  const buf = protoMessage([
    fieldVarint(1, 7),
    fieldString(2, "abc"),
    fieldVarint(3, 0),
  ]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 3);
  assert.equal(fields[0].no, 1);
  assert.equal(fields[0].value, 7n);
  assert.equal(fields[1].no, 2);
  assert.equal(fields[1].value.toString("utf8"), "abc");
  assert.equal(fields[2].no, 3);
  assert.equal(fields[2].value, 0n);
});

test("decodeFields: repeated fields with the same field number", () => {
  const buf = protoMessage([
    fieldString(1, "first"),
    fieldString(1, "second"),
    fieldString(1, "third"),
  ]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 3);
  assert.ok(fields.every((f) => f.no === 1 && f.wire === 2));
  assert.equal(fields[0].value.toString("utf8"), "first");
  assert.equal(fields[1].value.toString("utf8"), "second");
  assert.equal(fields[2].value.toString("utf8"), "third");
});

test("decodeFields: fixed64 (wire type 1) field", () => {
  const buf = protoMessage([fieldDouble(5, 3.14)]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].no, 5);
  assert.equal(fields[0].wire, 1);
  assert.ok(Math.abs(fields[0].value.readDoubleLE(0) - 3.14) < 1e-10);
});

test("decodeFields: high field numbers with multi-byte varint tags", () => {
  const buf = protoMessage([fieldVarint(29, 1), fieldString(39, "hi")]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].no, 29);
  assert.equal(fields[0].value, 1n);
  assert.equal(fields[1].no, 39);
  assert.equal(fields[1].value.toString("utf8"), "hi");
});

test("decodeFields: truncated varint throws", () => {
  // A byte with continuation bit set but no following byte
  const buf = Buffer.from([0x80]);
  assert.throws(() => decodeFields(buf), /Truncated/);
});

test("decodeFields: nested message field", () => {
  const inner = protoMessage([fieldVarint(1, 99)]);
  const buf = protoMessage([fieldMessage(3, inner)]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].no, 3);
  assert.equal(fields[0].wire, 2);
  // Decode the nested message
  const innerFields = decodeFields(fields[0].value);
  assert.equal(innerFields[0].value, 99n);
});

// =========================================================================
// decodeStruct
// =========================================================================

test("decodeStruct: empty buffer returns empty object", () => {
  const result = decodeStruct(Buffer.alloc(0));
  assert.deepEqual(result, {});
});

test("decodeStruct: single string value", () => {
  // Struct has repeated field 1 = entries; each entry has field 1 = key, field 2 = Value
  // Value for string: field 3 = string_value
  const entry = structEntry("name", [fieldString(3, "Alice")]);
  const buf = protoMessage([fieldMessage(1, entry)]);
  const result = decodeStruct(buf);
  assert.deepEqual(result, { name: "Alice" });
});

test("decodeStruct: multiple entries with different value types", () => {
  // string value (field 3 of Value)
  const strEntry = structEntry("label", [fieldString(3, "test")]);
  // number value (field 2 of Value, wire type 1 = double)
  const numEntry = structEntry("count", [fieldDouble(2, 42.5)]);
  // bool value (field 4 of Value, wire type 0 = varint)
  const boolEntry = structEntry("active", [fieldVarint(4, 1)]);
  // null value (field 1 of Value, wire type 0 = varint, value = 0)
  const nullEntry = structEntry("empty", [fieldVarint(1, 0)]);

  const buf = protoMessage([
    fieldMessage(1, strEntry),
    fieldMessage(1, numEntry),
    fieldMessage(1, boolEntry),
    fieldMessage(1, nullEntry),
  ]);
  const result = decodeStruct(buf);
  assert.equal(result.label, "test");
  assert.equal(result.count, 42.5);
  assert.equal(result.active, true);
  assert.equal(result.empty, null);
});

test("decodeStruct: nested struct value", () => {
  // Inner struct: { "x": "y" }
  const innerEntry = structEntry("x", [fieldString(3, "y")]);
  const innerStruct = protoMessage([fieldMessage(1, innerEntry)]);
  // Outer struct entry: field 5 of Value = struct_value
  const outerEntry = structEntry("nested", [fieldMessage(5, innerStruct)]);
  const buf = protoMessage([fieldMessage(1, outerEntry)]);
  const result = decodeStruct(buf);
  assert.deepEqual(result, { nested: { x: "y" } });
});

test("decodeStruct: list value", () => {
  // ListValue: field 1 = repeated Value
  const listValue = protoMessage([
    fieldMessage(1, protoMessage([fieldString(3, "a")])),
    fieldMessage(1, protoMessage([fieldString(3, "b")])),
  ]);
  // Value field 6 = list_value
  const entry = structEntry("items", [fieldMessage(6, listValue)]);
  const buf = protoMessage([fieldMessage(1, entry)]);
  const result = decodeStruct(buf);
  assert.deepEqual(result, { items: ["a", "b"] });
});

test("decodeStruct: entry without key is skipped", () => {
  // An entry with only a value but no key (field 1)
  const badEntry = protoMessage([
    fieldMessage(2, protoMessage([fieldString(3, "orphan")])),
  ]);
  const goodEntry = structEntry("valid", [fieldString(3, "ok")]);
  const buf = protoMessage([
    fieldMessage(1, badEntry),
    fieldMessage(1, goodEntry),
  ]);
  const result = decodeStruct(buf);
  assert.deepEqual(result, { valid: "ok" });
});

// =========================================================================
// decodeAgentClientMessage
// =========================================================================

test("decodeAgentClientMessage: empty buffer returns undefined case", () => {
  const result = decodeAgentClientMessage(Buffer.alloc(0));
  assert.deepEqual(result, { message: { case: undefined } });
});

test("decodeAgentClientMessage: runRequest (field 1)", () => {
  const userMessage = protoMessage([fieldString(1, "hello"), fieldString(2, "msg-1")]);
  const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
  const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
  const runRequest = protoMessage([
    fieldMessage(2, conversationAction),
    fieldMessage(3, protoMessage([fieldString(1, "test-model")])),
    fieldString(5, "conv-id-123"),
    fieldMessage(9, protoMessage([fieldString(1, "test-model")])),
  ]);
  const buf = protoMessage([fieldMessage(1, runRequest)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "runRequest");
  assert.equal(result.message.value.conversationId, "conv-id-123");
  assert.equal(result.message.value.modelDetails?.modelId, "test-model");
  assert.equal(result.message.value.requestedModel?.modelId, "test-model");
});

test("decodeAgentClientMessage: execClientMessage with shellResult (field 2)", () => {
  // shellResult = field 2 inside execClientMessage
  const shellResult = protoMessage([fieldString(1, "output text")]);
  const execMsg = protoMessage([
    fieldVarint(1, 42),             // id
    fieldMessage(2, shellResult),   // shellResult at field 2
    fieldString(15, "exec-shell-1"),// execId
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "execClientMessage");
  assert.equal(result.message.value.id, 42);
  assert.equal(result.message.value.execId, "exec-shell-1");
  assert.equal(result.message.value.message.case, "shellResult");
});

test("decodeAgentClientMessage: execClientMessage with readResult (field 7)", () => {
  // readResult success: field 1 inside readResult
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/test.js"),    // path
    fieldString(2, "file content"),    // content
    fieldVarint(3, 10),                // totalLines
    fieldVarint(4, 256),               // fileSize
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]); // field 1 = success
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),     // readResult at field 7
    fieldString(15, "exec-read-1"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "execClientMessage");
  assert.equal(result.message.value.message.case, "readResult");
  const readValue = result.message.value.message.value;
  assert.equal(readValue.result.case, "success");
  assert.equal(readValue.result.value.path, "/tmp/test.js");
  assert.equal(readValue.result.value.output.case, "content");
  assert.equal(readValue.result.value.output.value, "file content");
  assert.equal(readValue.result.value.totalLines, 10);
  assert.equal(readValue.result.value.fileSize, 256);
});

test("decodeAgentClientMessage: execClientMessage with readResult (field 29)", () => {
  // Same readResult but at field 29 (newer slot)
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/newer.js"),
    fieldString(2, "newer content"),
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 2),
    fieldMessage(29, readResult),    // readResult at field 29
    fieldString(15, "exec-read-29"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "execClientMessage");
  assert.equal(result.message.value.message.case, "readResult");
  assert.equal(result.message.value.message.value.result.value.path, "/tmp/newer.js");
});

test("decodeAgentClientMessage: readResult field 7 takes precedence over field 29", () => {
  const readSuccess7 = protoMessage([fieldString(1, "/from-field-7")]);
  const readResult7 = protoMessage([fieldMessage(1, readSuccess7)]);
  const readSuccess29 = protoMessage([fieldString(1, "/from-field-29")]);
  const readResult29 = protoMessage([fieldMessage(1, readSuccess29)]);

  const execMsg = protoMessage([
    fieldVarint(1, 3),
    fieldMessage(7, readResult7),    // field 7
    fieldMessage(29, readResult29),  // field 29 — should be ignored
    fieldString(15, "exec-precedence"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.case, "readResult");
  assert.equal(result.message.value.message.value.result.value.path, "/from-field-7");
});

test("decodeAgentClientMessage: execClientMessage with grepResult (field 5)", () => {
  // Grep success with a count result
  const fileCount = protoMessage([fieldString(1, "src/main.js"), fieldVarint(2, 3)]);
  const countResult = protoMessage([
    fieldMessage(1, fileCount),   // counts
    fieldVarint(2, 1),            // totalFiles
    fieldVarint(3, 3),            // totalMatches
  ]);
  const grepUnionResult = protoMessage([fieldMessage(1, countResult)]); // field 1 = count
  // Map entry: key = "workspace", value = grepUnionResult
  const mapEntry = protoMessage([fieldString(1, "workspace"), fieldMessage(2, grepUnionResult)]);
  const grepSuccess = protoMessage([
    fieldString(1, "TODO"),        // pattern
    fieldString(2, "src/"),        // path
    fieldMessage(4, mapEntry),     // workspaceResults map entry
  ]);
  const grepResult = protoMessage([fieldMessage(1, grepSuccess)]); // field 1 = success
  const execMsg = protoMessage([
    fieldVarint(1, 10),
    fieldMessage(5, grepResult),   // grepResult at field 5
    fieldString(15, "exec-grep-1"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "execClientMessage");
  assert.equal(result.message.value.message.case, "grepResult");
  const grepValue = result.message.value.message.value;
  assert.equal(grepValue.result.case, "success");
  assert.equal(grepValue.result.value.pattern, "TODO");
  assert.equal(grepValue.result.value.path, "src/");
  assert.ok(grepValue.result.value.workspaceResults.workspace);
  const wsResult = grepValue.result.value.workspaceResults.workspace;
  assert.equal(wsResult.result.case, "count");
  assert.equal(wsResult.result.value.totalFiles, 1);
  assert.equal(wsResult.result.value.totalMatches, 3);
});

test("decodeAgentClientMessage: execClientMessage with grepResult content matches", () => {
  const contentMatch = protoMessage([
    fieldVarint(1, 42),            // lineNumber
    fieldString(2, "// TODO: fix"),// content
  ]);
  const fileMatch = protoMessage([
    fieldString(1, "app.js"),      // file
    fieldMessage(2, contentMatch), // matches (repeated)
  ]);
  const contentResult = protoMessage([
    fieldMessage(1, fileMatch),    // matches
    fieldVarint(2, 100),           // totalLines
    fieldVarint(3, 1),             // totalMatchedLines
  ]);
  const grepUnionResult = protoMessage([fieldMessage(3, contentResult)]); // field 3 = content
  const mapEntry = protoMessage([fieldString(1, "ws"), fieldMessage(2, grepUnionResult)]);
  const grepSuccess = protoMessage([
    fieldString(1, "TODO"),
    fieldMessage(4, mapEntry),
  ]);
  const grepResult = protoMessage([fieldMessage(1, grepSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 11),
    fieldMessage(5, grepResult),
    fieldString(15, "exec-grep-content"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const grepValue = result.message.value.message.value;
  assert.equal(grepValue.result.case, "success");
  const wsResult = grepValue.result.value.workspaceResults.ws;
  assert.equal(wsResult.result.case, "content");
  assert.equal(wsResult.result.value.matches[0].file, "app.js");
  assert.equal(wsResult.result.value.matches[0].matches[0].lineNumber, 42);
  assert.equal(wsResult.result.value.matches[0].matches[0].content, "// TODO: fix");
  assert.equal(wsResult.result.value.totalLines, 100);
});

test("decodeAgentClientMessage: execClientMessage with lsResult (field 8)", () => {
  const lsResult = protoMessage([fieldString(1, "dir listing")]);
  const execMsg = protoMessage([
    fieldVarint(1, 20),
    fieldMessage(8, lsResult),
    fieldString(15, "exec-ls-1"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.case, "lsResult");
});

test("decodeAgentClientMessage: execClientMessage with mcpResult (field 11)", () => {
  const mcpResult = protoMessage([fieldString(1, "mcp output")]);
  const execMsg = protoMessage([
    fieldVarint(1, 30),
    fieldMessage(11, mcpResult),
    fieldString(15, "exec-mcp-1"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.case, "mcpResult");
});

test("decodeAgentClientMessage: conversationAction (field 4)", () => {
  const userMessage = protoMessage([fieldString(1, "test message")]);
  const userMessageAction = protoMessage([fieldMessage(1, userMessage)]);
  const conversationAction = protoMessage([fieldMessage(1, userMessageAction)]);
  const buf = protoMessage([fieldMessage(4, conversationAction)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "conversationAction");
  assert.equal(result.message.value.action.case, "userMessageAction");
  assert.equal(result.message.value.action.value.userMessage.text, "test message");
});

test("decodeAgentClientMessage: conversationAction resumeAction", () => {
  const resumeAction = protoMessage([]);
  const conversationAction = protoMessage([fieldMessage(2, resumeAction)]);
  const buf = protoMessage([fieldMessage(4, conversationAction)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "conversationAction");
  assert.equal(result.message.value.action.case, "resumeAction");
});

test("decodeAgentClientMessage: conversationAction executePlanAction", () => {
  const executePlanAction = protoMessage([
    fieldString(4, "# plan\n- ship it"),
    fieldString(6, "kickoff-1"),
    fieldString(8, "plans/approved.plan.md"),
  ]);
  const conversationAction = protoMessage([fieldMessage(7, executePlanAction)]);
  const buf = protoMessage([fieldMessage(4, conversationAction)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "conversationAction");
  assert.equal(result.message.value.action.case, "executePlanAction");
  assert.equal(result.message.value.action.value.planFileContent, "# plan\n- ship it");
  assert.equal(result.message.value.action.value.kickoffMessageId, "kickoff-1");
  assert.equal(result.message.value.action.value.planFilePath, "plans/approved.plan.md");
});

test("decodeAgentClientMessage: interactionResponse (field 6)", () => {
  // askQuestionInteractionResponse at field 3
  const answer = protoMessage([
    fieldString(1, "q-1"),        // questionId
    fieldString(3, "yes"),        // freeformText
  ]);
  const askSuccess = protoMessage([fieldMessage(1, answer)]); // answers
  const askResult = protoMessage([
    fieldMessage(1, protoMessage([fieldMessage(1, askSuccess)])),  // result -> success
  ]);
  const interactionResponse = protoMessage([
    fieldVarint(1, 5),             // id
    fieldMessage(3, askResult),    // askQuestionInteractionResponse at field 3
  ]);
  const buf = protoMessage([fieldMessage(6, interactionResponse)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "interactionResponse");
  assert.equal(result.message.value.id, 5);
  assert.equal(result.message.value.result.case, "askQuestionInteractionResponse");
});

test("decodeAgentClientMessage: clientHeartbeat (field 7)", () => {
  const heartbeat = protoMessage([]);
  const buf = protoMessage([fieldMessage(7, heartbeat)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "clientHeartbeat");
  assert.deepEqual(result.message.value, {});
});

test("decodeAgentClientMessage: unknown field returns undefined case", () => {
  // Field 99 is not a recognized oneof
  const buf = protoMessage([fieldMessage(99, protoMessage([]))]);
  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, undefined);
});

// =========================================================================
// decodeReadResult (via decodeAgentClientMessage)
// =========================================================================

test("decodeReadResult: success with content output", () => {
  const readSuccess = protoMessage([
    fieldString(1, "/home/user/file.txt"),
    fieldString(2, "line 1\nline 2"),
    fieldVarint(3, 2),
    fieldVarint(4, 14),
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-content"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value.result.value;
  assert.equal(rv.path, "/home/user/file.txt");
  assert.equal(rv.output.case, "content");
  assert.equal(rv.output.value, "line 1\nline 2");
  assert.equal(rv.totalLines, 2);
  assert.equal(rv.fileSize, 14);
});

test("decodeReadResult: success with binary data output", () => {
  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/image.png"),
    fieldMessage(5, binaryData),    // data field
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-data"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value.result.value;
  assert.equal(rv.path, "/tmp/image.png");
  assert.equal(rv.output.case, "data");
  // Data should be base64-encoded
  assert.equal(rv.output.value, binaryData.toString("base64"));
});

test("decodeReadResult: success with truncated flag", () => {
  const readSuccess = protoMessage([
    fieldString(1, "/tmp/big.log"),
    fieldString(2, "partial..."),
    fieldVarint(6, 1),  // truncated = true
  ]);
  const readResult = protoMessage([fieldMessage(1, readSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-truncated"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value.result.value;
  assert.equal(rv.truncated, true);
});

test("decodeReadResult: error case", () => {
  const readError = protoMessage([
    fieldString(1, "/tmp/missing.txt"),
    fieldString(2, "ENOENT"),
  ]);
  const readResult = protoMessage([fieldMessage(2, readError)]); // field 2 = error
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-error"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value;
  assert.equal(rv.result.case, "error");
  assert.equal(rv.result.value.path, "/tmp/missing.txt");
  assert.equal(rv.result.value.error, "ENOENT");
});

test("decodeReadResult: fileNotFound case", () => {
  const fileNotFound = protoMessage([fieldString(1, "/nonexistent")]);
  const readResult = protoMessage([fieldMessage(4, fileNotFound)]); // field 4 = fileNotFound
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-404"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value;
  assert.equal(rv.result.case, "fileNotFound");
  assert.equal(rv.result.value.path, "/nonexistent");
});

test("decodeReadResult: permissionDenied case", () => {
  const permDenied = protoMessage([fieldString(1, "/etc/shadow")]);
  const readResult = protoMessage([fieldMessage(5, permDenied)]); // field 5 = permissionDenied
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-perm"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value;
  assert.equal(rv.result.case, "permissionDenied");
  assert.equal(rv.result.value.path, "/etc/shadow");
});

test("decodeReadResult: invalidFile case", () => {
  const invalidFile = protoMessage([
    fieldString(1, "/tmp/weirdfile"),
    fieldString(2, "binary file"),
  ]);
  const readResult = protoMessage([fieldMessage(6, invalidFile)]); // field 6 = invalidFile
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-invalid"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value;
  assert.equal(rv.result.case, "invalidFile");
  assert.equal(rv.result.value.path, "/tmp/weirdfile");
  assert.equal(rv.result.value.reason, "binary file");
});

test("decodeReadResult: rejected case", () => {
  const rejected = protoMessage([
    fieldString(1, "/sensitive/path"),
    fieldString(2, "access not allowed"),
  ]);
  const readResult = protoMessage([fieldMessage(3, rejected)]); // field 3 = rejected
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(7, readResult),
    fieldString(15, "read-rejected"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.message.value;
  assert.equal(rv.result.case, "rejected");
  assert.equal(rv.result.value.path, "/sensitive/path");
  assert.equal(rv.result.value.reason, "access not allowed");
});

// =========================================================================
// decodeGrepSuccess (via decodeAgentClientMessage)
// =========================================================================

test("decodeGrepSuccess: files result", () => {
  const filesResult = protoMessage([
    fieldString(1, "src/a.js"),
    fieldString(1, "src/b.js"),
    fieldVarint(2, 2),            // totalFiles
  ]);
  const grepUnionResult = protoMessage([fieldMessage(2, filesResult)]); // field 2 = files
  const mapEntry = protoMessage([fieldString(1, "ws"), fieldMessage(2, grepUnionResult)]);
  const grepSuccess = protoMessage([
    fieldString(1, "import"),
    fieldString(2, "src/"),
    fieldMessage(4, mapEntry),
  ]);
  const grepResult = protoMessage([fieldMessage(1, grepSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(5, grepResult),
    fieldString(15, "grep-files"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const gv = result.message.value.message.value.result.value;
  assert.equal(gv.pattern, "import");
  const wsResult = gv.workspaceResults.ws;
  assert.equal(wsResult.result.case, "files");
  assert.deepEqual(wsResult.result.value.files, ["src/a.js", "src/b.js"]);
  assert.equal(wsResult.result.value.totalFiles, 2);
});

test("decodeGrepSuccess: error result", () => {
  const grepError = protoMessage([fieldString(1, "regex syntax error")]);
  const grepResult = protoMessage([fieldMessage(2, grepError)]); // field 2 = error
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(5, grepResult),
    fieldString(15, "grep-error"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const gv = result.message.value.message.value;
  assert.equal(gv.result.case, "error");
  assert.equal(gv.result.value.error, "regex syntax error");
});

test("decodeGrepSuccess: empty success with no workspace results", () => {
  const grepSuccess = protoMessage([
    fieldString(1, "pattern"),
  ]);
  const grepResult = protoMessage([fieldMessage(1, grepSuccess)]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldMessage(5, grepResult),
    fieldString(15, "grep-empty"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  const gv = result.message.value.message.value.result.value;
  assert.equal(gv.pattern, "pattern");
  assert.deepEqual(gv.workspaceResults, {});
});

// =========================================================================
// decodeShellStream (via decodeAgentClientMessage)
// =========================================================================

test("decodeAgentClientMessage: shellStream stdout event", () => {
  const stdout = protoMessage([fieldString(1, "hello world\n")]);
  const shellStream = protoMessage([fieldMessage(1, stdout)]); // field 1 = stdout
  const execMsg = protoMessage([
    fieldVarint(1, 50),
    fieldMessage(14, shellStream),  // shellStream at field 14
    fieldString(15, "exec-stream-1"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.case, "shellStream");
  assert.equal(result.message.value.message.value.event.case, "stdout");
  assert.equal(result.message.value.message.value.event.value.data, "hello world\n");
});

test("decodeAgentClientMessage: shellStream exit event", () => {
  const exit = protoMessage([
    fieldVarint(1, 0),            // code
    fieldString(2, "/home/user"), // cwd
  ]);
  const shellStream = protoMessage([fieldMessage(3, exit)]); // field 3 = exit
  const execMsg = protoMessage([
    fieldVarint(1, 51),
    fieldMessage(14, shellStream),
    fieldString(15, "exec-stream-exit"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.value.event.case, "exit");
  assert.equal(result.message.value.message.value.event.value.code, 0);
  assert.equal(result.message.value.message.value.event.value.cwd, "/home/user");
});

test("decodeAgentClientMessage: shellStream rejected event", () => {
  const rejected = protoMessage([
    fieldString(1, "rm -rf /"),    // command
    fieldString(2, "/"),           // workingDirectory
    fieldString(3, "dangerous"),   // reason
  ]);
  const shellStream = protoMessage([fieldMessage(5, rejected)]); // field 5 = rejected
  const execMsg = protoMessage([
    fieldVarint(1, 52),
    fieldMessage(14, shellStream),
    fieldString(15, "exec-stream-rejected"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.message.value.event.case, "rejected");
  assert.equal(result.message.value.message.value.event.value.command, "rm -rf /");
  assert.equal(result.message.value.message.value.event.value.reason, "dangerous");
});

// =========================================================================
// decodeBidiClientMessage
// =========================================================================

test("decodeBidiClientMessage: null/undefined record returns null clientMessage", () => {
  const result = decodeBidiClientMessage(null);
  assert.equal(result.clientMessage, null);
  assert.equal(result.payloadLength, 0);
});

test("decodeBidiClientMessage: empty object returns null clientMessage", () => {
  const result = decodeBidiClientMessage({});
  assert.equal(result.clientMessage, null);
  assert.equal(result.payloadLength, 0);
});

// =========================================================================
// Edge cases: truncated buffers
// =========================================================================

test("decodeFields: truncated length-delimited field (length exceeds buffer)", () => {
  // Tag for field 1 wire type 2, then length 100 but only 2 bytes of data
  const buf = Buffer.concat([varint((1 << 3) | 2), varint(100), Buffer.from([0x41, 0x42])]);
  // decodeFields should produce a field with a truncated subarray (no crash)
  const fields = decodeFields(buf);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].no, 1);
  // The subarray will be shorter than declared length
  assert.ok(fields[0].value.length < 100);
});

test("decodeAgentClientMessage: truncated inner message does not crash", () => {
  // Create a valid outer structure but the inner bytes are truncated
  const truncatedInner = Buffer.from([0x0a]); // field 1 wire 2 but no length byte...
  // Wrap in field 1 (runRequest)
  const buf = protoMessage([fieldMessage(1, truncatedInner)]);
  // Should throw on the truncated varint inside, but let's verify it's a clean error
  assert.throws(() => decodeAgentClientMessage(buf), /Truncated/);
});

test("decodeStruct: truncated entry is gracefully handled", () => {
  // A struct with a single entry that has a key but the value message is empty
  const entry = protoMessage([fieldString(1, "key")]);
  const buf = protoMessage([fieldMessage(1, entry)]);
  const result = decodeStruct(buf);
  // Key exists but value is undefined (no field 2 in entry)
  assert.equal(result.key, undefined);
});

// =========================================================================
// execClientMessage: localExecutionTimeMs (field 39)
// =========================================================================

test("decodeAgentClientMessage: execClientMessage preserves localExecutionTimeMs", () => {
  const shellResult = protoMessage([fieldString(1, "done")]);
  const execMsg = protoMessage([
    fieldVarint(1, 100),
    fieldMessage(2, shellResult),
    fieldString(15, "exec-timed"),
    fieldVarint(39, 1234),          // localExecutionTimeMs
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.localExecutionTimeMs, 1234);
});

// =========================================================================
// decodeAgentClientMessage: execClientMessage with no recognized inner case
// =========================================================================

test("decodeAgentClientMessage: execClientMessage with no recognized result field", () => {
  // Only id and execId, no tool result field
  const execMsg = protoMessage([
    fieldVarint(1, 999),
    fieldString(15, "exec-no-result"),
  ]);
  const buf = protoMessage([fieldMessage(2, execMsg)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "execClientMessage");
  assert.equal(result.message.value.id, 999);
  assert.equal(result.message.value.execId, "exec-no-result");
  assert.equal(result.message.value.message, undefined);
});

// =========================================================================
// decodeAgentClientMessage: runRequest with MCP tools
// =========================================================================

test("decodeAgentClientMessage: runRequest with mcpTools", () => {
  const inputSchema = protoMessage([
    fieldMessage(1, structEntry("type", [fieldString(3, "object")])),
  ]);
  const toolDef = protoMessage([
    fieldString(1, "my_mcp_tool"),
    fieldString(2, "A test MCP tool"),
    fieldMessage(3, inputSchema),
    fieldString(4, "my-provider"),
    fieldString(5, "my_tool"),
  ]);
  const mcpTools = protoMessage([fieldMessage(1, toolDef)]);
  const runRequest = protoMessage([
    fieldMessage(3, protoMessage([fieldString(1, "model-1")])),
    fieldMessage(4, mcpTools),
    fieldString(5, "conv-mcp"),
    fieldMessage(9, protoMessage([fieldString(1, "model-1")])),
  ]);
  const buf = protoMessage([fieldMessage(1, runRequest)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "runRequest");
  const tools = result.message.value.mcpTools.mcpTools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "my_mcp_tool");
  assert.equal(tools[0].description, "A test MCP tool");
  assert.equal(tools[0].providerIdentifier, "my-provider");
  assert.equal(tools[0].toolName, "my_tool");
  assert.deepEqual(tools[0].inputSchema, { type: "object" });
});

// =========================================================================
// Interaction response sub-types
// =========================================================================

test("decodeAgentClientMessage: interactionResponse switchMode approved", () => {
  const approved = protoMessage([]);
  const switchModeResponse = protoMessage([fieldMessage(1, approved)]); // field 1 = approved
  const interactionResponse = protoMessage([
    fieldVarint(1, 10),
    fieldMessage(4, switchModeResponse), // field 4 = switchModeRequestResponse
  ]);
  const buf = protoMessage([fieldMessage(6, interactionResponse)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "interactionResponse");
  assert.equal(result.message.value.result.case, "switchModeRequestResponse");
  assert.equal(result.message.value.result.value.result.case, "approved");
});

test("decodeAgentClientMessage: interactionResponse switchMode rejected", () => {
  const rejected = protoMessage([fieldString(1, "not now")]);
  const switchModeResponse = protoMessage([fieldMessage(2, rejected)]); // field 2 = rejected
  const interactionResponse = protoMessage([
    fieldVarint(1, 11),
    fieldMessage(4, switchModeResponse),
  ]);
  const buf = protoMessage([fieldMessage(6, interactionResponse)]);

  const result = decodeAgentClientMessage(buf);
  const rv = result.message.value.result.value;
  assert.equal(rv.result.case, "rejected");
  assert.equal(rv.result.value.reason, "not now");
});

test("decodeAgentClientMessage: interactionResponse webSearch", () => {
  // webSearchRequestResponse at field 2
  const successMsg = protoMessage([]);
  const resultUnion = protoMessage([fieldMessage(1, successMsg)]); // success
  const webSearchResponse = protoMessage([fieldMessage(1, resultUnion)]);
  const interactionResponse = protoMessage([
    fieldVarint(1, 20),
    fieldMessage(2, webSearchResponse), // field 2 = webSearchRequestResponse
  ]);
  const buf = protoMessage([fieldMessage(6, interactionResponse)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.value.result.case, "webSearchRequestResponse");
});

// =========================================================================
// Large varint values
// =========================================================================

test("decodeFields: large varint value", () => {
  // Use a value larger than 32 bits
  const buf = protoMessage([fieldVarint(1, 0xFFFFFFFF + 1)]);
  const fields = decodeFields(buf);
  assert.equal(fields[0].value, BigInt(0xFFFFFFFF + 1));
});

// =========================================================================
// decodeAgentClientMessage: oneof priority — first matching field wins
// =========================================================================

test("decodeAgentClientMessage: first oneof field wins (runRequest over execClientMessage)", () => {
  // Both field 1 (runRequest) and field 2 (execClientMessage) are present
  const runRequest = protoMessage([
    fieldString(5, "conv-priority"),
    fieldMessage(3, protoMessage([fieldString(1, "m")])),
  ]);
  const execMsg = protoMessage([
    fieldVarint(1, 1),
    fieldString(15, "exec-ignored"),
  ]);
  const buf = protoMessage([
    fieldMessage(1, runRequest),
    fieldMessage(2, execMsg),
  ]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "runRequest");
});

// =========================================================================
// decodeAgentClientMessage: conversationAction cancel and summarize
// =========================================================================

test("decodeAgentClientMessage: conversationAction cancelAction", () => {
  const cancelAction = protoMessage([]);
  const conversationAction = protoMessage([fieldMessage(3, cancelAction)]);
  const buf = protoMessage([fieldMessage(4, conversationAction)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "conversationAction");
  assert.equal(result.message.value.action.case, "cancelAction");
});

test("decodeAgentClientMessage: conversationAction summarizeAction", () => {
  const summarizeAction = protoMessage([]);
  const conversationAction = protoMessage([fieldMessage(4, summarizeAction)]);
  const buf = protoMessage([fieldMessage(4, conversationAction)]);

  const result = decodeAgentClientMessage(buf);
  assert.equal(result.message.case, "conversationAction");
  assert.equal(result.message.value.action.case, "summarizeAction");
});
