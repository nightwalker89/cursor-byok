"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
} = require("../src/workbench-hook");
const {
  configDir,
  ensureConfigFiles,
  loadRoutes,
  providersPath,
  routesPath,
  writeRoutes,
  writeJsonFile,
  logPath,
} = require("../src/config");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
} = require("../src/server/provider-adapter");
const { protoMessage, fieldMessage, fieldString, structStringValue, jsonResponse, writeMcpCacheTool, approvedSwitchModeInteractionResponse, assertIncludesAll, quietLog, useHome, asyncIterable, interceptModule } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("server serves local Cursor membership auth profile without upstream proxy", async () => {
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const profileResponse = await fetch(`${baseUrl}/auth/full_stripe_profile`);
    assert.equal(profileResponse.status, 200);
    assert.match(profileResponse.headers.get("content-type"), /application\/json/);
    const profile = await profileResponse.json();
    assert.equal(profile.membershipType, "ultra");
    assert.equal(profile.subscriptionStatus, "active");
    assert.equal(profile.paymentId, "byok_local");
    assert.equal(profile.hasValidPaymentMethod, true);

    const stripeProfile = await fetch(`${baseUrl}/auth/stripe_profile`);
    assert.equal(stripeProfile.status, 200);
    assert.match(stripeProfile.headers.get("content-type"), /text\/plain/);
    assert.equal(await stripeProfile.text(), "byok_local");

    assert.deepEqual(
      await (await fetch(`${baseUrl}/auth/has_valid_payment_method`)).json(),
      { hasValidPaymentMethod: true },
    );
    assert.deepEqual(
      await (await fetch(`${baseUrl}/auth/poll`)).json(),
      { accessToken: "byok-token", authId: "byok-user" },
    );
    assert.deepEqual(
      await (await fetch(`${baseUrl}/auth/logout`, { method: "POST" })).json(),
      { ok: true },
    );
  } finally {
    await server.stop();
  }
});

test("server chooses provider tool-result timeout by Cursor tool type and arguments", async () => {
  const calls = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  server.sessions = {
    waitForExecResult: async (requestId, toolCallId, timeoutMs) => {
      calls.push({ requestId, toolCallId, timeoutMs });
      return normalizeExecClientResult({
        execId: toolCallId,
        readResult: { success: { path: "/tmp/a", content: "ok" } },
      });
    },
  };

  await server.waitForProviderToolResult("req-1", "read-1", { toolName: "Read" });
  await server.waitForProviderToolResult("req-1", "shell-1", {
    toolName: "Shell",
    toolArguments: "{\"command\":\"sleep 45\",\"block_until_ms\":45000}",
  });
  await server.waitForProviderToolResult("req-1", "ask-1", { toolName: "AskQuestion" });
  await server.waitForProviderToolResult("req-1", "switch-1", { toolName: "SwitchMode" });
  await server.waitForProviderToolResult("req-1", "mcp-auth-1", { toolName: "mcp_auth" });
  await server.waitForProviderToolResult("req-1", "web-1", { toolName: "WebSearch" });
  await server.waitForProviderToolResult("req-1", "image-1", { toolName: "GenerateImage" });

  assert.deepEqual(calls, [
    { requestId: "req-1", toolCallId: "read-1", timeoutMs: 30000 },
    { requestId: "req-1", toolCallId: "shell-1", timeoutMs: 50000 },
    { requestId: "req-1", toolCallId: "ask-1", timeoutMs: 300000 },
    { requestId: "req-1", toolCallId: "switch-1", timeoutMs: 300000 },
    { requestId: "req-1", toolCallId: "mcp-auth-1", timeoutMs: 300000 },
    { requestId: "req-1", toolCallId: "web-1", timeoutMs: 300000 },
    { requestId: "req-1", toolCallId: "image-1", timeoutMs: 300000 },
  ]);
});


test("server uses long timeout for Cursor interaction bridge responses", async () => {
  const calls = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  server.sessions = {
    waitForInteractionResponse: async (requestId, queryId, timeoutMs) => {
      calls.push({ requestId, queryId, timeoutMs });
      return approvedSwitchModeInteractionResponse(queryId);
    },
  };
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/interaction-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-interaction-timeout",
        queryId: 100001,
        toolName: "AskQuestion",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.deepEqual(calls, [{ requestId: "req-interaction-timeout", queryId: 100001, timeoutMs: 300000 }]);
  } finally {
    await server.stop();
  }
});

test("server returns mcp_auth timeout in MCP auth response shape", async () => {
  const calls = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  server.sessions = {
    waitForInteractionResponse: async (requestId, queryId, timeoutMs) => {
      calls.push({ requestId, queryId, timeoutMs });
      throw new Error("Timed out waiting for Cursor interaction response 100002");
    },
  };
  try {
    await server.start();
    const port = server.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/byok/interaction-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-mcp-auth-timeout",
        queryId: 100002,
        toolName: "mcp_auth",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.result, {
      id: 100002,
      result: {
        case: "mcpAuthRequestResponse",
        value: {
          result: {
            case: "rejected",
            value: { reason: "Timed out waiting for Cursor interaction response 100002" },
          },
        },
      },
    });
    assert.deepEqual(calls, [{ requestId: "req-mcp-auth-timeout", queryId: 100002, timeoutMs: 300000 }]);
  } finally {
    await server.stop();
  }
});


test("grey-box server recognizes BYOK modelName from direct RunSSE requests", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-runsse-model-name-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{ id: "gpt55-sub2api", apiModel: "gpt-5.5" }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ model, request, requestId }) {
        providerRequest = { model, request, requestId };
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runRequest = {
      requestId,
      modelDetails: { modelName: "gpt55-sub2api" },
      messages: [{ role: "user", content: "ping" }],
    };

    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.deepEqual(await shouldHandle.json(), {
      handle: true,
      requestId,
      modelId: "gpt55-sub2api",
      provider: "Provider",
      model: "gpt55-sub2api",
    });

    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 200);
    assert.match(await run.text(), /"text":"ok"/);
    assert.equal(providerRequest.model.apiModel, "gpt-5.5");
    assert.equal(providerRequest.request.modelDetails.modelName, "gpt55-sub2api");
  } finally {
    await server.stop();
    restoreHome();
  }
});


test("grey-box server routes BYOK runs selected by Cursor short name and legacy slug", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-runsse-model-alias-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "sonnet-main",
        apiModel: "claude-sonnet-upstream",
        displayName: "Sonnet Main",
        inputboxShortModelName: "Sonnet",
        legacySlugs: ["model-old123"],
      }],
    }],
  });
  const seenModels = [];
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ model, request }) {
        seenModels.push({ model, requested: request.modelDetails?.modelName || request.requestedModel?.modelId });
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    for (const candidate of ["Sonnet", "model-old123"]) {
      const requestId = crypto.randomUUID();
      const runRequest = {
        requestId,
        modelDetails: { modelName: candidate },
        messages: [{ role: "user", content: "ping" }],
      };
      const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, request: runRequest }),
      });
      assert.equal((await shouldHandle.json()).handle, true);
      const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, request: runRequest }),
      });
      assert.equal(run.status, 200);
      assert.match(await run.text(), /"text":"ok"/);
    }
    assert.deepEqual(seenModels.map((entry) => [entry.model.id, entry.model.apiModel, entry.requested]), [
      ["sonnet-main", "claude-sonnet-upstream", "Sonnet"],
      ["sonnet-main", "claude-sonnet-upstream", "model-old123"],
    ]);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server routes BYOK runs selected by Cursor selectedModels", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-runsse-selected-model-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ model, request }) {
        providerRequest = { model, request };
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }],
      messages: [{ role: "user", content: "implement plan" }],
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.deepEqual(await shouldHandle.json(), {
      handle: true,
      requestId,
      modelId: "GLM-5.1-Coding",
      provider: "Provider",
      model: "model-n1tgsf",
    });

    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 200);
    assert.match(await run.text(), /"text":"ok"/);
    assert.equal(providerRequest.model.apiModel, "glm-upstream");
    assert.equal(providerRequest.request.selectedModels[0].modelId, "GLM-5.1-Coding");
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server ignores nested plan-execution BYOK config when the active request model is official", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-runsse-plan-config-official-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ model, request }) {
        providerRequest = { model, request };
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      requestedModel: { modelId: "gpt-5", modelName: "gpt-5" },
      modelConfig: {
        modelName: "gpt-5",
        "plan-execution": {
          modelName: "default",
          selectedModels: [{ modelId: "GLM-5.1-Coding", parameters: [] }],
        },
      },
      messages: [{ role: "user", content: "implement plan" }],
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.deepEqual(await shouldHandle.json(), {
      handle: false,
      requestId,
      modelId: "gpt-5",
    });

    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 404);
    assert.deepEqual(await run.json(), {
      local: false,
      reason: "model-not-found",
      modelId: "gpt-5",
    });
    assert.equal(providerRequest, null);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server routes plan build requests that only carry modelOverride", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-plan-build-modeloverride-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: {
      async *run({ model, request }) {
        providerRequest = { model, request };
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    // Production hooks send x-client-wid; an unregistered wid is refused with
    // workspace-scope-not-registered, so register the window scope explicitly.
    server.registerWorkspaceRoots([root], "1");
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      isPlanExecution: true,
      modelOverride: "GLM-5.1-Coding",
      modelConfig: { modelName: "default" },
      action: { case: "executePlanAction", value: { planFileContent: "# plan" } },
      messages: [{ role: "user", content: "Implement the plan" }],
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.deepEqual(await shouldHandle.json(), {
      handle: true,
      requestId,
      modelId: "GLM-5.1-Coding",
      provider: "Provider",
      model: "model-n1tgsf",
    });
    assert.equal(providerRequest, null);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server synthesizes provider input for executePlanAction when messages are absent", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-plan-build-no-messages-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    workspaceRoots: [root],
    providerAdapter: {
      async *run({ model, request }) {
        providerRequest = { model, request };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      isPlanExecution: true,
      modelOverride: "GLM-5.1-Coding",
      modelConfig: { modelName: "default" },
      action: { action: { case: "executePlanAction", value: { planFileContent: "# plan\n- do thing" } } },
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.deepEqual(await shouldHandle.json(), {
      handle: true,
      requestId,
      modelId: "GLM-5.1-Coding",
      provider: "Provider",
      model: "model-n1tgsf",
    });
    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 200);
    await readResponseText(run);
    assert.equal(providerRequest?.request?.messages?.length, 1);
    assert.equal(providerRequest.request.messages[0].role, "user");
    assert.match(providerRequest.request.messages[0].content, /Implement the plan as specified, it is attached for your reference/);
    assert.match(providerRequest.request.messages[0].content, /Do NOT edit the plan file itself/);
    assert.match(providerRequest.request.messages[0].content, /Mark them as in_progress as you work/);
    assert.match(providerRequest.request.messages[0].content, /# plan/);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server synthesizes provider input from conversationActionOverride plan execution payload", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-plan-build-conversation-action-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    workspaceRoots: [root],
    providerAdapter: {
      async *run({ request }) {
        providerRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      isPlanExecution: true,
      modelOverride: "GLM-5.1-Coding",
      modelConfig: { modelName: "default" },
      conversationActionOverride: {
        action: {
          case: "executePlanAction",
          value: { plan_file_content: "# plan\n- ship it" },
        },
      },
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal((await shouldHandle.json()).handle, true);
    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-wid": "1" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 200);
    await readResponseText(run);
    assert.equal(providerRequest?.messages?.length, 1);
    assert.match(providerRequest.messages[0].content, /ship it/);
  } finally {
    await server.stop();
    restoreHome();
  }
});

test("grey-box server synthesizes provider input from executePlanAction plan file path", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-plan-build-file-path-"));
  const restoreHome = useHome(tmpRoot);
  ensureConfigFiles();
  writeJsonFile(providersPath(), {
    schemaVersion: 1,
    providers: [{
      id: "p",
      name: "Provider",
      type: "openai-chat",
      baseUrl: "http://unused",
      models: [{
        id: "model-n1tgsf",
        apiModel: "glm-upstream",
        displayName: "GLM-5.1-Coding",
      }],
    }],
  });
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-plan-workspace-"));
  const planDir = path.join(workspaceRoot, "plans");
  const planPath = path.join(planDir, "approved.plan.md");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(planPath, "# approved plan\n- ship via file path\n");
  const readPaths = [];
  const readFile = async (resolvedPath) => {
    readPaths.push(resolvedPath);
    return {
      text: fs.readFileSync(resolvedPath, "utf8"),
      fileSize: fs.statSync(resolvedPath).size,
    };
  };
  let providerRequest = null;
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    workspaceRoots: [workspaceRoot],
    readFile,
    providerAdapter: {
      async *run({ request }) {
        providerRequest = request;
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    await server.start();
    const port = server.server.address().port;
    const requestId = crypto.randomUUID();
    const runRequest = {
      requestId,
      isPlanExecution: true,
      modelOverride: "GLM-5.1-Coding",
      modelConfig: { modelName: "default" },
      action: {
        executePlanAction: {
          planFilePath: path.relative(workspaceRoot, planPath),
        },
      },
    };
    const shouldHandle = await fetch(`http://127.0.0.1:${port}/byok/should-handle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal((await shouldHandle.json()).handle, true);
    const run = await fetch(`http://127.0.0.1:${port}/byok/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, request: runRequest }),
    });
    assert.equal(run.status, 200);
    await readResponseText(run);
    assert.equal(providerRequest?.messages?.length, 1);
    assert.match(providerRequest.messages[0].content, /approved plan/);
    assert.match(providerRequest.messages[0].content, /ship via file path/);
    assert.equal(readPaths.length >= 1, true);
    assert.equal(readPaths.every((entry) => entry === planPath), true);
  } finally {
    await server.stop();
    restoreHome();
  }
});
