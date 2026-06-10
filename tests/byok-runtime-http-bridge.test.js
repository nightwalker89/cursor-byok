"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BidiRawQueue,
  ByokSessionStore,
  ConversationPins,
  DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS,
  classifyBidiPayload,
  extractPayloadBytes,
  findExecToolCallId,
  findRequestId,
} = require("../src/runtime/state");
const { decodeAgentClientMessage } = require("../src/runtime/cursor-protocol");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const { protoMessage, fieldMessage, fieldString, fieldVarint, approvedMcpAuthInteractionResponse, webSearchCompletionEnvelope, rejectedMcpAuthInteractionResponse, quietLog, recordingLog, tick } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

function createJsonResponseCapture() {
  let resolved = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return {
    response: {
      headersSent: false,
      writeHead(statusCode, headers) {
        this.headersSent = true;
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body = "") {
        if (resolved) return;
        resolved = true;
        resolveDone({
          statusCode: this.statusCode,
          headers: this.headers,
          body: String(body || ""),
          json: body ? JSON.parse(String(body)) : null,
        });
      },
    },
    done,
  };
}

async function invokeJsonHandler(handler, body) {
  const capture = createJsonResponseCapture();
  await handler(body, capture.response);
  return capture.done;
}

async function postJsonToLocal(port, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          text,
          json: text ? JSON.parse(text) : null,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("HTTP checkpoint path is proxied instead of storing BYOK conversation state", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      body: init.body ? Buffer.from(init.body).toString("utf8") : "",
    });
    return new Response(JSON.stringify({ proxied: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const body = {
      conversationId: "33333333-3333-4333-8333-333333333333",
      conversationState: { turns: [{ id: "turn" }] },
    };
    const response = await postJsonToLocal(port, "/byok/checkpoint", body);

    assert.equal(response.status, 202);
    assert.deepEqual(response.json, { proxied: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api2.cursor.sh/byok/checkpoint");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), body);
  } finally {
    await server.stop();
    globalThis.fetch = originalFetch;
  }
});

test("HTTP exec map endpoint lets Bidi results wake BYOK tool waiters by native id", async () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const requestId = "58585858-5858-4585-8585-585858585858";
  const wait = server.sessions.waitForExecResult(requestId, "call-1-read", 1000);
  const mapped = await invokeJsonHandler(server.handleExecMap.bind(server), {
    requestId,
    execId: 1,
    toolCallId: "call-1-read",
  });
  assert.deepEqual(mapped.json, { ok: true });
  server.sessions.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 1,
        message: {
          case: "readResult",
          value: {
            result: {
              case: "success",
              value: { output: { case: "content", value: "ok" } },
            },
          },
        },
      },
    },
  });
  const result = await wait;
  assert.equal(findExecToolCallId(result), "call-1-read");
});

test("HTTP interaction response endpoint returns Cursor MCP auth interaction result", async () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const requestId = "54545454-5454-4545-8545-545454545455";
  const capture = createJsonResponseCapture();
  const responsePromise = server.handleInteractionResponse({
    requestId,
    queryId: 123,
    toolName: "mcp_auth",
    timeoutMs: 1000,
  }, capture.response);

  await tick();
  server.sessions.recordClientMessage(requestId, {
    message: {
      case: "interactionResponse",
      value: approvedMcpAuthInteractionResponse(123),
    },
  });

  await responsePromise;
  const response = await capture.done;
  assert.deepEqual(response.json, {
    ok: true,
    result: approvedMcpAuthInteractionResponse(123),
  });
});

test("HTTP local tool result normalizes flat Cursor exec oneof results before waking waiters", async () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const requestId = "68686868-6868-4686-8686-686868686868";
  const wait = server.sessions.waitForExecResult(requestId, "call-flat-read", 1000);
  const response = await invokeJsonHandler(server.handleLocalToolResult.bind(server), {
    requestId,
    toolCallId: "call-flat-read",
    result: {
      id: 1,
      readResult: {
        success: {
          path: "/tmp/flat",
          content: "flat content",
          totalLines: 1,
          fileSize: 12,
        },
      },
    },
  });
  assert.deepEqual(response.json, { ok: true });
  const result = await wait;
  assert.equal(result.message.case, "readResult");
  assert.equal(result.message.value.result.case, "success");
  assert.equal(result.message.value.result.value.output.case, "content");
  assert.equal(result.message.value.result.value.output.value, "flat content");
});

test("HTTP local tool result normalizes postToolUse Shell output before waking waiters", async () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  const requestId = "69696969-6969-4696-8696-696969696969";
  const wait = server.sessions.waitForExecResult(requestId, "shell-1", 1000);
  const response = await invokeJsonHandler(server.handleLocalToolResult.bind(server), {
    requestId,
    toolCallId: "shell-1",
    result: {
      execId: "shell-1",
      shellStream: {
        success: {
          tool_output: "{\"output\":\"ok\\n\",\"exitCode\":0}",
          tool_input: { command: "echo ok", cwd: "/tmp/project" },
        },
      },
    },
  });
  assert.deepEqual(response.json, { ok: true });
  const result = await wait;
  assert.equal(result.message.case, "shellResult");
  assert.equal(result.message.value.result.case, "success");
  assert.deepEqual(result.message.value.result.value, {
    command: "echo ok",
    workingDirectory: "/tmp/project",
    output: "ok\n",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  });
});

async function createDirectReadServer({ workspaceRoots, readFile, execError = "direct read should not wait for native exec results" }) {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots,
    ...(readFile ? { readFile } : {}),
  });
  server.sessions.waitForExecResult = async () => {
    throw new Error(execError);
  };
  return server;
}

test("BYOK direct file reads handle workspace and Cursor range semantics", async () => {
  const outsideCases = [
    {
      label: "outside workspace roots",
      content: "alpha\nbeta\ngamma\n",
      toolName: "Read",
      toolArguments: (target) => ({ path: target, offset: 2, limit: 1 }),
      execError: "native read should not be awaited for external fallback",
      assert: (result, target) => {
        assert.equal(result.message.value.result.value.path, target);
        assert.equal(result.message.value.result.value.output.value, "beta");
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 2, endLine: 2 });
        assert.equal(result.message.value.result.value.rangeApplied, true);
      },
    },
    {
      label: "CRLF and string offset limit windows",
      content: "alpha\r\nbeta\rgamma\n",
      toolName: "Read",
      toolArguments: (target) => JSON.stringify({ path: target, offset: "2", limit: "2" }),
      assert: (result) => {
        assert.equal(result.message.value.result.value.output.value, "beta\ngamma");
        assert.equal(result.message.value.result.value.totalLines, 4);
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 2, endLine: 3 });
        assert.equal(result.message.value.result.value.rangeApplied, true);
      },
    },
    {
      label: "EOF range fallback",
      content: "alpha\nbeta\n",
      toolName: "ReadFile",
      toolArguments: (target) => ({ path: target, offset: 10, limit: 5 }),
      assert: (result) => {
        assert.equal(result.message.value.result.value.output.value, "alpha\nbeta\n");
        assert.equal(result.message.value.result.value.totalLines, 3);
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 1, endLine: 3 });
        assert.equal(result.message.value.result.value.rangeApplied, false);
      },
    },
    {
      label: "negative offsets",
      content: "alpha\nbeta\ngamma\n",
      toolName: "Read",
      toolArguments: (target) => ({ path: target, offset: -2 }),
      assert: (result) => {
        assert.equal(result.message.value.result.value.output.value, "gamma\n");
        assert.equal(result.message.value.result.value.totalLines, 4);
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 3, endLine: 4 });
        assert.equal(result.message.value.result.value.rangeApplied, true);
      },
    },
    {
      label: "negative limits",
      content: "alpha\nbeta\ngamma\ndelta\n",
      toolName: "Read",
      toolArguments: (target) => ({ path: target, offset: 2, limit: -1 }),
      assert: (result) => {
        assert.equal(result.message.value.result.value.output.value, "");
        assert.equal(result.message.value.result.value.totalLines, 5);
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 2 });
        assert.equal(result.message.value.result.value.rangeApplied, true);
      },
    },
    {
      label: "empty-file line count",
      content: "",
      toolName: "Read",
      toolArguments: (target) => ({ path: target, offset: 1, limit: 1 }),
      assert: (result) => {
        assert.equal(result.message.value.result.value.output.value, "");
        assert.equal(result.message.value.result.value.totalLines, 1);
        assert.deepEqual(result.message.value.result.value.readRange, { startLine: 1, endLine: 1 });
        assert.equal(result.message.value.result.value.rangeApplied, false);
      },
    },
  ];

  for (const testCase of outsideCases) {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-"));
    const target = path.join(outsideRoot, "external.txt");
    fs.writeFileSync(target, testCase.content);
    const server = await createDirectReadServer({
      workspaceRoots: [root],
      execError: testCase.execError,
    });
    const result = await server.waitForProviderToolResult("request-1", "tool-call", {
      toolName: testCase.toolName,
      toolArguments: testCase.toolArguments(target),
    });
    assert.equal(result.message.case, "readResult");
    assert.equal(result.message.value.result.case, "success");
    assert.equal(result.message.value.result.value.output.case, "content");
    assert.equal(result.message.value.result.value.offset, undefined);
    assert.equal(result.message.value.result.value.limit, undefined);
    testCase.assert(result, target);
  }

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-workspace-"));
  const workspaceTarget = path.join(workspaceRoot, "inside.txt");
  fs.writeFileSync(workspaceTarget, "zero\none\ntwo\nthree\n");
  const workspaceServer = await createDirectReadServer({
    workspaceRoots: [workspaceRoot],
    execError: "workspace read should use the direct reader",
    readFile: async (resolvedPath) => {
      assert.equal(resolvedPath, workspaceTarget);
      return new Uint8Array(fs.readFileSync(resolvedPath));
    },
  });
  const workspaceResult = await workspaceServer.waitForProviderToolResult("request-1", "tool-call", {
    toolName: "Read",
    toolArguments: { path: workspaceTarget, offset: 2, limit: 2 },
  });
  assert.equal(workspaceResult.message.value.result.value.output.value, "one\ntwo");
  assert.equal(workspaceResult.message.value.result.value.fileSize, Buffer.byteLength("zero\none\ntwo\nthree\n"));
  assert.deepEqual(workspaceResult.message.value.result.value.readRange, { startLine: 2, endLine: 3 });
  assert.equal(workspaceResult.message.value.result.value.rangeApplied, true);

  let relativeReads = 0;
  const relativeServer = await createDirectReadServer({
    workspaceRoots: [workspaceRoot],
    execError: "relative workspace read should use the direct reader",
    readFile: async (resolvedPath) => {
      relativeReads++;
      assert.equal(resolvedPath, workspaceTarget);
      return fs.readFileSync(resolvedPath, "utf8");
    },
  });
  const relativeResult = await relativeServer.waitForProviderToolResult("request-1", "relative-read", {
    toolName: "Read",
    toolArguments: { path: "inside.txt", offset: 2, limit: 1 },
  });
  assert.equal(relativeReads, 1);
  assert.equal(relativeResult.message.value.result.value.path, workspaceTarget);
  assert.equal(relativeResult.message.value.result.value.output.value, "one");
  assert.deepEqual(relativeResult.message.value.result.value.readRange, { startLine: 2, endLine: 2 });
});

test("BYOK direct-only Read endpoint returns real readResult and caches concurrent waiters", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-direct-only-"));
  const target = path.join(workspaceRoot, "inside.txt");
  fs.writeFileSync(target, "alpha\nbeta\n");
  let reads = 0;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [workspaceRoot],
    readFile: async (resolvedPath) => {
      reads++;
      assert.equal(resolvedPath, target);
      await tick();
      return fs.readFileSync(resolvedPath);
    },
  });
  server.sessions.waitForExecResult = async () => {
    throw new Error("direct Read should not wait for native exec");
  };

  const direct = invokeJsonHandler(server.handleToolResult.bind(server), {
    requestId: "request-1",
    toolCallId: "read-1",
    toolName: "Read",
    toolArguments: { path: target },
    directOnly: true,
  });
  const provider = server.waitForProviderToolResult("request-1", "read-1", {
    toolName: "Read",
    toolArguments: { path: target },
  });
  const [directResponse, providerResult] = await Promise.all([direct, provider]);

  assert.equal(directResponse.statusCode, 200);
  assert.equal(directResponse.json.ok, true);
  assert.equal(directResponse.json.direct, true);
  assert.equal(directResponse.json.result.message.value.result.value.output.value, "alpha\nbeta\n");
  assert.equal(directResponse.json.result.message.value.result.value.rangeApplied, false);
  assert.equal(providerResult.message.value.result.value.output.value, "alpha\nbeta\n");
  assert.equal(reads, 1);
});

test("BYOK direct-only Read preserves Cursor oversize guidance for whole-file reads", async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-oversize-"));
  const target = path.join(outsideRoot, "large.txt");
  fs.writeFileSync(target, `${"x".repeat(100001)}\n`);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [root],
  });

  const response = await invokeJsonHandler(server.handleToolResult.bind(server), {
    requestId: "request-1",
    toolCallId: "read-1",
    toolName: "Read",
    toolArguments: { path: target },
    directOnly: true,
  });

  const value = response.json.result.message.value.result.value;
  assert.equal(response.json.direct, true);
  assert.equal(value.exceededLimit, true);
  assert.equal(value.output, undefined);
  assert.equal(value.fileSize, fs.statSync(target).size);
  assert.equal(value.totalLines, undefined);
  assert.equal(value.truncated, true);
  assert.equal(value.rangeApplied, false);
});

test("BYOK direct-only Read refuses windows that only become oversized after Cursor line formatting", async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-visible-oversize-"));
  const target = path.join(outsideRoot, "many-short-lines.txt");
  fs.writeFileSync(target, "x\n".repeat(12500));
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [root],
  });

  const response = await invokeJsonHandler(server.handleToolResult.bind(server), {
    requestId: "request-1",
    toolCallId: "read-1",
    toolName: "Read",
    toolArguments: { path: target },
    directOnly: true,
  });

  const value = response.json.result.message.value.result.value;
  assert.equal(response.json.direct, true);
  assert.equal(value.exceededLimit, true);
  assert.equal(value.exceededLimitReason, "provider_visible_chars");
  assert.equal(typeof value.providerVisibleChars, "number");
  assert.equal(value.providerVisibleChars > 100000, true);
  assert.equal(value.output, undefined);
  assert.equal(value.fileSize < 100000, true);
  assert.equal(value.totalLines, 12501);
  assert.equal(value.rangeApplied, false);
});

test("BYOK direct-only Read does not load oversized local whole files into memory", async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-oversize-stream-"));
  const target = path.join(outsideRoot, "large.txt");
  fs.writeFileSync(target, `${"x".repeat(100001)}\r\ny\n`);
  const originalReadFileSync = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (path.resolve(String(file)) === target) fullReads++;
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const server = new ByokServer({
      host: "127.0.0.1",
      port: 0,
      log: quietLog(),
      providerAdapter: { async *run() {} },
      workspaceRoots: [root],
    });

    const response = await invokeJsonHandler(server.handleToolResult.bind(server), {
      requestId: "request-1",
      toolCallId: "read-1",
      toolName: "Read",
      toolArguments: { path: target },
      directOnly: true,
    });

    const value = response.json.result.message.value.result.value;
    assert.equal(response.json.direct, true);
    assert.equal(value.exceededLimit, true);
    assert.equal(value.output, undefined);
    assert.equal(value.totalLines, undefined);
    assert.equal(fullReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("BYOK direct-only Read uses workspace stat before reading oversized whole files", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-workspace-stat-"));
  const target = path.join(workspaceRoot, "large.txt");
  const statSize = 100001;
  let stats = 0;
  let reads = 0;
  const readFile = async () => {
    reads++;
    throw new Error("oversized workspace whole-file Read should not load content");
  };
  readFile.stat = async (resolvedPath) => {
    stats++;
    assert.equal(resolvedPath, target);
    return { fileSize: statSize, isFile: true };
  };
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [workspaceRoot],
    readFile,
  });

  const response = await invokeJsonHandler(server.handleToolResult.bind(server), {
    requestId: "request-1",
    toolCallId: "read-1",
    toolName: "Read",
    toolArguments: { path: target },
    directOnly: true,
  });

  const value = response.json.result.message.value.result.value;
  assert.equal(response.json.direct, true);
  assert.equal(value.exceededLimit, true);
  assert.equal(value.output, undefined);
  assert.equal(value.fileSize, statSize);
  assert.equal(value.totalLines, undefined);
  assert.equal(stats, 1);
  assert.equal(reads, 0);
});

test("BYOK direct-only Read can return full content for internal edit reads", async () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-read-full-"));
  const target = path.join(outsideRoot, "large.txt");
  const content = `${"x".repeat(100001)}\n`;
  fs.writeFileSync(target, content);
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [root],
  });

  const response = await invokeJsonHandler(server.handleToolResult.bind(server), {
    requestId: "request-1",
    toolCallId: "read-1",
    toolName: "Read",
    toolArguments: { path: target },
    directOnly: true,
    allowLargeRead: true,
  });

  const value = response.json.result.message.value.result.value;
  assert.equal(value.exceededLimit, undefined);
  assert.equal(value.output.case, "content");
  assert.equal(value.output.value.length, content.length);
  assert.equal(value.totalLines, 2);
});

test("BYOK keeps Cursor-native workspace reads when no direct reader is available", async () => {
  const target = path.join(root, "README.md");
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
    workspaceRoots: [root],
  });
  let waited = false;
  server.sessions.waitForExecResult = async (_requestId, _toolCallId, timeoutMs) => {
    waited = true;
    assert.equal(timeoutMs, 30000);
    return {
      execId: "tool-call",
      _byokToolCallId: "tool-call",
      message: {
        case: "readResult",
        value: {
          result: {
            case: "success",
            value: { output: { case: "content", value: "ok" } },
          },
        },
      },
    };
  };

  const result = await server.waitForProviderToolResult("request-1", "tool-call", {
    toolName: "Read",
    toolArguments: { path: target, offset: 0, limit: 10 },
  });

  assert.equal(waited, true);
  assert.equal(result.message.value.result.value.output.value, "ok");
});

test("exec client result normalizer preserves existing envelopes and repairs flat oneofs", () => {
  assert.deepEqual(
    normalizeExecClientResult({
      id: 1,
      message: {
        case: "readResult",
        value: {
          result: {
            case: "success",
            value: { output: { case: "content", value: "ok" } },
          },
        },
      },
    }).message.value.result.value.output.value,
    "ok",
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 2,
      writeResult: {
        success: { path: "/tmp/a" },
      },
    }).message,
    {
      case: "writeResult",
      value: {
        result: {
          case: "success",
          value: { path: "/tmp/a" },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 3,
      readResult: {
        success: { path: "/tmp/image.png", data: "base64-bytes" },
      },
    }).message,
    {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: { path: "/tmp/image.png", output: { case: "data", value: "base64-bytes" } },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 4,
      redactedReadResult: {
        success: { path: "/tmp/redacted", content: "redacted content" },
      },
    }).message,
    {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: { path: "/tmp/redacted", output: { case: "content", value: "redacted content" } },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 5,
      readResult: {
        success: {
          path: "/tmp/blob",
          outputBlobId: "blob-1",
          totalLines: 1200,
          fileSize: 250000,
          truncated: true,
          rangeApplied: false,
        },
      },
    }).message,
    {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/blob",
            outputBlobId: "blob-1",
            totalLines: 1200,
            fileSize: 250000,
            truncated: true,
            rangeApplied: false,
          },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 6,
      grepResult: {
        success: {
          pattern: "needle",
          path: "/tmp/project",
          outputMode: "files_with_matches",
          workspaceResults: { "/tmp/project": { result: { case: "files", value: { files: ["/tmp/project/a.js"] } } } },
        },
      },
    }).message,
    {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: "needle",
            path: "/tmp/project",
            outputMode: "files_with_matches",
            workspaceResults: { "/tmp/project": { result: { case: "files", value: { files: ["/tmp/project/a.js"] } } } },
          },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 5,
      listMcpResourcesExecResult: {
        success: {
          resources: [{ uri: "file://a", name: "A", server: "fs" }],
        },
      },
    }).message,
    {
      case: "listMcpResourcesExecResult",
      value: {
        result: {
          case: "success",
          value: { resources: [{ uri: "file://a", name: "A", server: "fs" }] },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 6,
      readMcpResourceExecResult: {
        success: {
          uri: "file://a",
          name: "A",
          content: { case: "text", value: "hello" },
        },
      },
    }).message,
    {
      case: "readMcpResourceExecResult",
      value: {
        result: {
          case: "success",
          value: {
            uri: "file://a",
            name: "A",
            content: { case: "text", value: "hello" },
          },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 7,
      mcpResult: {
        success: {
          content: [
            { type: "text", text: "plain MCP text" },
            { content: { case: "text", value: { text: "native MCP text" } } },
          ],
        },
      },
    }).message,
    {
      case: "mcpResult",
      value: {
        result: {
          case: "success",
          value: {
            content: [
              { content: { case: "text", value: { text: "plain MCP text" } } },
              { content: { case: "text", value: { text: "native MCP text" } } },
            ],
          },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 8,
      mcpResult: {
        toolNotFound: {
          name: "user-filesystem-read_file",
          availableTools: ["read_file"],
        },
      },
    }).message,
    {
      case: "mcpResult",
      value: {
        result: {
          case: "error",
          value: { error: "MCP tool not found: user-filesystem-read_file" },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 9,
      mcpResult: {
        content: [{ type: "text", text: "plain MCP text" }],
      },
    }).message,
    {
      case: "mcpResult",
      value: {
        result: {
          case: "success",
          value: {
            content: [{ content: { case: "text", value: { text: "plain MCP text" } } }],
          },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 10,
      listMcpResourcesExecResult: {
        resources: [{ uri: "file://a", name: "A", server: "fs" }],
      },
    }).message,
    {
      case: "listMcpResourcesExecResult",
      value: {
        result: {
          case: "success",
          value: { resources: [{ uri: "file://a", name: "A", server: "fs" }] },
        },
      },
    },
  );
  assert.deepEqual(
    normalizeExecClientResult({
      id: 11,
      readMcpResourceExecResult: {
        uri: "file://a",
        name: "A",
        content: { type: "text", text: "hello" },
      },
    }).message,
    {
      case: "readMcpResourceExecResult",
      value: {
        result: {
          case: "success",
          value: {
            uri: "file://a",
            name: "A",
            content: { case: "text", value: "hello" },
          },
        },
      },
    },
  );
});

test("exec client result normalizer preserves streaming Shell events", () => {
  assert.deepEqual(
    normalizeExecClientResult({
      execId: "shell-1",
      message: {
        case: "shellStream",
        value: {
          event: { case: "stdout", value: { data: "chunk\n" } },
        },
      },
    }).message,
    {
      case: "shellStream",
      value: {
        event: { case: "stdout", value: { data: "chunk\n" } },
      },
    },
  );
});

test("HTTP local tool result logs unrecognized shell stream shapes for real Cursor diagnostics", async () => {
  const logEntries = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: {
      info(message, data) {
        logEntries.push({ level: "info", message, data });
      },
      warn(message, data) {
        logEntries.push({ level: "warn", message, data });
      },
      error(message, data) {
        logEntries.push({ level: "error", message, data });
      },
    },
    providerAdapter: { async *run() {} },
  });
  const response = await invokeJsonHandler(server.handleLocalToolResult.bind(server), {
    requestId: "70707070-7070-4707-8707-707070707070",
    toolCallId: "shell-unknown",
    result: {
      id: 11,
      message: {
        case: "shellStream",
        value: { "8": { stdout: "ok\n" }, rawCase: 8 },
      },
    },
  });
  assert.deepEqual(response.json, { ok: true });
  const entry = logEntries.find((item) => item.message === "BYOK local tool result");
  assert.deepEqual(entry.data.shellValueKeys, ["8", "rawCase"]);
});

test("exec client result normalizer turns postToolUse Shell output JSON into shellResult", () => {
  const result = normalizeExecClientResult({
    execId: "shell-1",
    shellStream: {
      success: {
        tool_output: "{\"output\":\"ok\\n\",\"exitCode\":0}",
        tool_input: { command: "echo ok", cwd: "/tmp/project" },
      },
    },
  });

  assert.deepEqual(result.message, {
    case: "shellResult",
    value: {
      result: {
        case: "success",
        value: {
          command: "echo ok",
          workingDirectory: "/tmp/project",
          output: "ok\n",
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        },
      },
    },
  });
});

test("exec client result normalizer preserves background shell metadata for AwaitShell follow-up", () => {
  const result = normalizeExecClientResult({
    execId: "shell-bg-1",
    shellStream: {
      success: {
        shellId: "shell-42",
        msToWait: 1500,
        pid: 4242,
        backgroundReason: "Shell command is still running in the background.",
        tool_input: { command: "sleep 5", cwd: "/tmp/project" },
      },
    },
  });

  assert.deepEqual(result.message, {
    case: "shellResult",
    value: {
      result: {
        case: "success",
        value: {
          command: "sleep 5",
          workingDirectory: "/tmp/project",
          output: "",
          stdout: "",
          stderr: "",
          exitCode: 0,
          shellId: "shell-42",
          msToWait: 1500,
          pid: 4242,
          backgroundReason: "Shell command is still running in the background.",
        },
      },
    },
  });
});
