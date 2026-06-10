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
const { protoMessage, fieldMessage, fieldString, structStringValue, jsonResponse, writeMcpCacheTool, approvedSwitchModeInteractionResponse, assertIncludesAll, quietLog, useHome, asyncIterable, interceptModule, tick } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

function lastNonDebugFetch(fetches) {
  for (let index = fetches.length - 1; index >= 0; index -= 1) {
    const entry = fetches[index];
    if (!String(entry?.url || "").endsWith("/byok/debug")) return entry;
  }
  return null;
}

test("grey-box hook fetch routes update from server events without reinstall", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const eventHandlers = new Map();
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.EventSource = function EventSource(url) {
      this.url = url;
      this.addEventListener = (event, handler) => eventHandlers.set(event, handler);
    };
    globalThis.fetch = async (url, init = {}) => {
      fetches.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    await globalThis.fetch("https://api2.cursor.sh/auth/poll", { headers: { "x-test": "before" } });
    assert.equal(lastNonDebugFetch(fetches)?.url, "https://api2.cursor.sh/auth/poll");

    eventHandlers.get("routes")({ data: JSON.stringify(["/auth/poll", "aiserver.v1.AiService/AvailableModels"]) });
    await globalThis.fetch("https://api2.cursor.sh/auth/poll", { headers: { "x-test": "after" } });
    assert.equal(lastNonDebugFetch(fetches)?.url, "http://127.0.0.1:9960/auth/poll");
    assert.equal(lastNonDebugFetch(fetches)?.init?.headers?.["x-test"], "after");

    eventHandlers.get("routes")({ data: JSON.stringify([]) });
    await globalThis.fetch("https://api2.cursor.sh/auth/poll", { headers: { "x-test": "disabled" } });
    assert.equal(lastNonDebugFetch(fetches)?.url, "https://api2.cursor.sh/auth/poll");

    assert.equal(globalThis.__cursorByokIsModel("json-model"), false);
    eventHandlers.get("models")({ data: JSON.stringify({ modelIds: ["json-model"] }) });
    assert.equal(globalThis.__cursorByokIsModel("json-model"), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
  }
});

test("workbench hook closes stale route EventSource before reconnecting", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalEvents = globalThis.__cursorByokEvents;
  const created = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokEvents;
    globalThis.fetch = async () => jsonResponse({ ok: true });
    globalThis.EventSource = function EventSource(url) {
      this.url = url;
      this.closed = false;
      this.addEventListener = () => {};
      this.close = () => {
        this.closed = true;
      };
      created.push(this);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    assert.equal(created.length, 1);
    delete globalThis.__cursorByokReady;
    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    assert.equal(created.length, 2);
    assert.equal(created[0].closed, true);
    assert.equal(globalThis.__cursorByokEvents, created[1]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalEvents === undefined) delete globalThis.__cursorByokEvents;
    else globalThis.__cursorByokEvents = originalEvents;
  }
});

test("workbench hook includes vscode window id on BYOK events stream", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWindow = globalThis.window;
  const created = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.fetch = async () => jsonResponse({ ok: true });
    globalThis.window = { vscodeWindowId: 42, addEventListener() {} };
    globalThis.EventSource = function EventSource(url) {
      this.url = url;
      this.addEventListener = () => {};
      this.close = () => {};
      created.push(this);
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: [] });
    assert.equal(created.length, 1);
    assert.equal(created[0].url, "http://127.0.0.1:9960/byok/events?wid=42");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("workbench hook retries redirected routes against the next adaptive BYOK port", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.EventSource = function EventSource(url) {
      this.url = url;
      this.addEventListener = () => {};
      this.close = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      fetches.push({ url: href, init });
      if (href === "http://127.0.0.1:9960/auth/poll") throw new Error("connection refused");
      if (href === "http://127.0.0.1:9960/byok/health") throw new Error("connection refused");
      if (href === "http://127.0.0.1:9961/byok/health") return jsonResponse({ ok: true });
      if (href === "http://127.0.0.1:9961/auth/poll") return jsonResponse({ ok: true, adaptive: true });
      return jsonResponse({ ok: true });
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      byokHost: "127.0.0.1",
      byokPort: 9960,
      byokPortSearchCount: 2,
      routes: ["/auth/poll"],
    });

    const response = await globalThis.fetch("https://api2.cursor.sh/auth/poll", { headers: { "x-test": "adaptive" } });
    assert.equal((await response.json()).adaptive, true);
    assert.deepEqual(
      fetches.map((entry) => entry.url),
      [
        "http://127.0.0.1:9960/auth/poll",
        "http://127.0.0.1:9960/byok/health",
        "http://127.0.0.1:9961/byok/health",
        "http://127.0.0.1:9961/auth/poll",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
  }
});

test("workbench hook reconnects the BYOK event stream after adaptive port probe", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const created = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "http://127.0.0.1:9960/byok/health") throw new Error("connection refused");
      if (href === "http://127.0.0.1:9961/byok/health") return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    };
    globalThis.EventSource = function EventSource(url) {
      this.url = url;
      this.handlers = new Map();
      this.addEventListener = (event, handler) => this.handlers.set(event, handler);
      this.close = () => {
        this.closed = true;
      };
      created.push(this);
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      byokHost: "127.0.0.1",
      byokPort: 9960,
      byokPortSearchCount: 2,
      routes: [],
    });

    assert.equal(created[0].url, "http://127.0.0.1:9960/byok/events");
    created[0].handlers.get("error")({});
    await tick();
    await tick();
    assert.equal(created[1].url, "http://127.0.0.1:9961/byok/events");
    assert.equal(created[0].closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
  }
});

test("grey-box hook leaves AvailableModels fetch on Connect and merges BYOK models in unary", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalIsModel = globalThis.__cursorByokIsModel;
  const originalModelIds = globalThis.__cursorByokModelIds;
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    delete globalThis.__cursorByokIsModel;
    delete globalThis.__cursorByokModelIds;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      fetches.push({ url: String(url), init });
      if (String(url).endsWith("/byok/models")) {
        return jsonResponse({
          models: [{
            id: "byok-model",
            name: "byok-model",
            clientDisplayName: "BYOK Model",
            displayName: "BYOK Display",
            apiModel: "provider-api-model",
            serverModelName: "provider-model",
            defaultOn: true,
            supportsAgent: true,
            supportsMaxMode: true,
            supportsNonMaxMode: true,
            parameterDefinitions: [],
            variants: [],
            legacySlugs: ["model-old123"],
            idAliases: [],
          }],
        });
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: ["aiserver.v1.AiService/AvailableModels", "/auth/poll"],
    });

    await globalThis.fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
      method: "POST",
      headers: { "connect-protocol-version": "1" },
    });
    assert.equal(fetches.at(-1).url, "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels");

    const transportCalls = [];
    const transport = {
      unary: async (...args) => {
        transportCalls.push(args);
        return {
          header: new Headers(),
          trailer: new Headers(),
          message: {
            models: [{
              name: "official-model",
              degradation_status: "DEGRADED",
              defaultOn: true,
              parameterDefinitions: [],
              variants: [],
              legacySlugs: [],
              idAliases: [],
            }, {
              id: "provider-model",
              name: "Official Provider Duplicate",
              defaultOn: true,
              parameterDefinitions: [],
              variants: [],
              legacySlugs: [],
              idAliases: [],
            }],
            modelNames: ["official-model", "provider-model"],
            composerModelConfig: {},
            cmdKModelConfig: {},
            backgroundComposerModelConfig: {},
            useModelParameters: false,
          },
        };
      },
      stream: async () => {
        throw new Error("stream should not be called");
      },
    };
    const wrapped = globalThis.__cursorByokWrapTransport(transport);
    const result = await wrapped.unary(
      { typeName: "aiserver.v1.AiService" },
      { name: "AvailableModels", O: { fromJson: (value) => ({ typed: true, ...value }) } },
      null,
      0,
      {},
      {},
    );

    assert.equal(transportCalls.length, 1);
    assert.deepEqual(result.message.models.map((model) => model.name), ["official-model", "byok-model"]);
    assert.equal(result.message.models[0].degradation_status, undefined);
    assert.deepEqual(result.message.modelNames, ["official-model", "byok-model"]);
    assert.equal(result.message.models[1].serverModelName, "provider-model");
    assert.deepEqual(result.message.models[1].legacySlugs, ["model-old123"]);
    assert.equal(result.message.useModelParameters, true);
    assert.equal(globalThis.__cursorByokIsModel("byok-model"), true);
    assert.equal(globalThis.__cursorByokIsModel("BYOK Display"), true);
    assert.equal(globalThis.__cursorByokIsModel("provider-api-model"), true);
    assert.equal(globalThis.__cursorByokIsModel("provider-model"), true);
    assert.equal(globalThis.__cursorByokIsModel("official-model"), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalIsModel === undefined) delete globalThis.__cursorByokIsModel;
    else globalThis.__cursorByokIsModel = originalIsModel;
    if (originalModelIds === undefined) delete globalThis.__cursorByokModelIds;
    else globalThis.__cursorByokModelIds = originalModelIds;
  }
});

test("workbench hook refreshes stale embedded model capabilities before AvailableModels merge", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalIsModel = globalThis.__cursorByokIsModel;
  const originalModelIds = globalThis.__cursorByokModelIds;
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    delete globalThis.__cursorByokIsModel;
    delete globalThis.__cursorByokModelIds;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      fetches.push({ url: String(url), init });
      if (String(url).endsWith("/byok/models")) {
        return jsonResponse({
          models: [{
            id: "gpt55-sub2api",
            name: "gpt55-sub2api",
            displayName: "gpt55-sub2api",
            defaultOn: true,
            supportsAgent: true,
            supportsImages: true,
            supportsAutoContext: true,
            supportsPlanMode: true,
            parameterDefinitions: [],
            variants: [],
            legacySlugs: [],
            idAliases: [],
          }],
        });
      }
      return jsonResponse({ ok: true });
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "gpt55-sub2api",
        name: "gpt55-sub2api",
        displayName: "gpt55-sub2api",
        defaultOn: true,
        supportsAgent: true,
        supportsImages: false,
        supportsAutoContext: false,
        supportsPlanMode: false,
        parameterDefinitions: [],
        variants: [],
        legacySlugs: [],
        idAliases: [],
      }],
    });

    assert.equal(globalThis.__cursorByokIsModel("gpt55-sub2api"), true);

    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({
        header: new Headers(),
        trailer: new Headers(),
        message: { models: [], modelNames: [] },
      }),
      stream: async () => {
        throw new Error("stream should not be called");
      },
    });
    const result = await wrapped.unary(
      { typeName: "aiserver.v1.AiService" },
      { name: "AvailableModels", O: { fromJson: (value) => ({ typed: true, ...value }) } },
      null,
      0,
      {},
      {},
    );

    assert.equal(fetches.some((entry) => entry.url.endsWith("/byok/models")), true);
    assert.equal(result.message.models.length, 1);
    assert.equal(result.message.models[0].supportsPlanMode, true);
    assert.equal(result.message.models[0].supportsAutoContext, true);
    assert.equal(result.message.models[0].supportsImages, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalIsModel === undefined) delete globalThis.__cursorByokIsModel;
    else globalThis.__cursorByokIsModel = originalIsModel;
    if (originalModelIds === undefined) delete globalThis.__cursorByokModelIds;
    else globalThis.__cursorByokModelIds = originalModelIds;
  }
});

test("workbench hook keeps embedded models when server refresh is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const originalWrap = globalThis.__cursorByokWrapTransport;
  const originalIsModel = globalThis.__cursorByokIsModel;
  const originalModelIds = globalThis.__cursorByokModelIds;
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    delete globalThis.__cursorByokWrapTransport;
    delete globalThis.__cursorByokIsModel;
    delete globalThis.__cursorByokModelIds;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/byok/models")) throw new Error("server not ready");
      return jsonResponse({ ok: true });
    };

    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModels: [{
        id: "gpt55-sub2api",
        name: "gpt55-sub2api",
        displayName: "gpt55-sub2api",
        defaultOn: true,
        supportsAgent: true,
        supportsPlanMode: true,
        parameterDefinitions: [],
        variants: [],
        legacySlugs: [],
        idAliases: [],
      }],
    });

    const wrapped = globalThis.__cursorByokWrapTransport({
      unary: async () => ({
        header: new Headers(),
        trailer: new Headers(),
        message: { models: [], modelNames: [] },
      }),
      stream: async () => {
        throw new Error("stream should not be called");
      },
    });
    const result = await wrapped.unary(
      { typeName: "aiserver.v1.AiService" },
      { name: "AvailableModels", O: { fromJson: (value) => ({ typed: true, ...value }) } },
      null,
      0,
      {},
      {},
    );

    assert.deepEqual(result.message.modelNames, ["gpt55-sub2api"]);
    assert.equal(result.message.models[0].supportsPlanMode, true);
    assert.equal(globalThis.__cursorByokIsModel("gpt55-sub2api"), true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
    if (originalWrap === undefined) delete globalThis.__cursorByokWrapTransport;
    else globalThis.__cursorByokWrapTransport = originalWrap;
    if (originalIsModel === undefined) delete globalThis.__cursorByokIsModel;
    else globalThis.__cursorByokIsModel = originalIsModel;
    if (originalModelIds === undefined) delete globalThis.__cursorByokModelIds;
    else globalThis.__cursorByokModelIds = originalModelIds;
  }
});

test("grey-box hook fetch redirect preserves Request object method body and headers", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalReady = globalThis.__cursorByokReady;
  const originalPatch = globalThis.__cursorByokPatchApplied;
  const fetches = [];
  try {
    delete globalThis.__cursorByokReady;
    delete globalThis.__cursorByokPatchApplied;
    globalThis.EventSource = function EventSource() {
      this.addEventListener = () => {};
    };
    globalThis.fetch = async (url, init = {}) => {
      fetches.push({ url, init });
      return jsonResponse({ ok: true });
    };

    hookRuntime({ byokUrl: "http://127.0.0.1:9960", routes: ["/auth/poll"] });
    const request = new Request("https://api2.cursor.sh/auth/poll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cursor": "keep" },
      body: JSON.stringify({ token: "abc" }),
    });
    await globalThis.fetch(request);

    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url.url, "http://127.0.0.1:9960/auth/poll");
    assert.equal(fetches[0].url.method, "POST");
    assert.equal(fetches[0].init.headers.get("x-cursor"), "keep");
    assert.equal(await fetches[0].url.text(), "{\"token\":\"abc\"}");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalPatch === undefined) delete globalThis.__cursorByokPatchApplied;
    else globalThis.__cursorByokPatchApplied = originalPatch;
  }
});
