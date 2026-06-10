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
const { ByokServer, DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
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

test("server normalizes Cursor Run action.userMessageAction into provider input", () => {
  const request = normalizeRunRequestForProvider({
    conversationId: "conv-real-action",
    modelDetails: { modelId: "byok-model" },
    requestedModel: { modelId: "byok-model" },
    action: {
      userMessageAction: {
        userMessage: {
          text: "BYOK regression smoke",
          messageId: "msg-1",
        },
      },
    },
  });

  assert.deepEqual(request.messages, [{ role: "user", content: "BYOK regression smoke" }]);
});

test("server merges Cursor MCP tools into explicit provider tools without losing dispatch metadata", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-no-cache-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-tools",
      messages: [{ role: "user", content: "read file" }],
      tools: [{
        name: "TaskCreate",
        description: "Create task",
        inputSchema: { type: "object", properties: { subject: { type: "string" } } },
      }],
      mcpTools: [{
        mcpTools: [{
          name: "user-filesystem-read_file",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          providerIdentifier: "user-filesystem",
          toolName: "read_file",
        }],
      }],
    });

    assert.deepEqual(request.tools[0], {
      name: "TaskCreate",
      description: "Create task",
      inputSchema: { type: "object", properties: { subject: { type: "string" } } },
    });
    assert.deepEqual(request.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    const names = request.tools.map((tool) => tool.name || tool.canonicalName);
    assert.equal(names.includes("AskQuestion"), true);
    assert.equal(names.includes("SwitchMode"), true);
    assert.equal(names.includes("CreatePlan"), true);
    assert.equal(names.includes("WebSearch"), false);
    assert.equal(names.includes("GenerateImage"), false);
  } finally {
    restoreHome();
  }
});

test("server exposes BYOK interaction bridge tools alongside explicit Cursor tools", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-explicit-interaction-tools-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const request = normalizeRunRequestForProvider({
      conversationId: "conv-explicit-interaction-tools",
      messages: [{ role: "user", content: "ask before editing" }],
      tools: [{
        name: "Read",
        description: "explicit read",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }, {
        name: "SwitchMode",
        description: "Cursor supplied switch mode",
        inputSchema: { type: "object", properties: { target_mode_id: { type: "string" } }, required: ["target_mode_id"] },
      }],
    });

    const names = request.tools.map((tool) => tool.name || tool.canonicalName);
    assert.deepEqual(names, ["Read", "SwitchMode", "AskQuestion", "CreatePlan"]);
    assert.equal(names.includes("WebSearch"), false);
    assert.equal(names.includes("GenerateImage"), false);
    assert.equal(request.tools.find((tool) => tool.name === "SwitchMode").description, "Cursor supplied switch mode");
  } finally {
    restoreHome();
  }
});

test("server skips Cursor MCP cache when decoded Run mcpTools identify execution metadata", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-decoded-no-cache-"));
  const restoreHome = useHome(tmpRoot);
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;
  const originalStatSync = fs.statSync;
  let cacheReadAttempts = 0;
  const cursorProjectsRoot = path.join(tmpRoot, ".cursor", "projects");
  const denyCursorProjectsRead = (file) => {
    if (String(file).startsWith(cursorProjectsRoot)) {
      cacheReadAttempts += 1;
      throw new Error(`unexpected Cursor MCP cache read: ${file}`);
    }
  };
  try {
    writeMcpCacheTool(tmpRoot, "workspace-a", "user-cache-only", {
      name: "must_not_be_loaded",
      description: "Cache-only tool",
      arguments: { type: "object", properties: {} },
    });
    fs.readdirSync = function (...args) {
      denyCursorProjectsRead(args[0]);
      return originalReaddirSync.apply(this, args);
    };
    fs.readFileSync = function (...args) {
      denyCursorProjectsRead(args[0]);
      return originalReadFileSync.apply(this, args);
    };
    fs.statSync = function (...args) {
      denyCursorProjectsRead(args[0]);
      return originalStatSync.apply(this, args);
    };

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-decoded-no-cache",
      messages: [{ role: "user", content: "read file" }],
      tools: [{
        name: "TaskCreate",
        description: "Create task",
        inputSchema: { type: "object", properties: { subject: { type: "string" } } },
      }],
      mcpTools: [{
        mcpTools: [{
          name: "user-filesystem-read_file",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          providerIdentifier: "filesystem",
          toolName: "read_file",
        }],
      }],
    }, { workspaceRoots: ["/workspace/a"] });

    const names = request.tools.map((tool) => tool.name);
    assert.equal(cacheReadAttempts, 0);
    assert.equal(names.includes("TaskCreate"), true);
    assert.equal(names.includes("user-filesystem-read_file"), true);
    assertIncludesAll(names, ["AskQuestion", "SwitchMode", "CreatePlan"]);
    const mcpTool = request.tools.find((tool) => tool.name === "user-filesystem-read_file");
    assert.equal(mcpTool.providerIdentifier, "user-filesystem");
    assert.equal(mcpTool.executionName, "user-filesystem-read_file");
    assert.equal(request.tools.some((tool) => tool.name === "user-cache-only-must_not_be_loaded"), false);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
    fs.statSync = originalStatSync;
    restoreHome();
  }
});

test("server resolves decoded Cursor MCP legacy aliases to cached execution server identifiers", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-resolve-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-filesystem");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-filesystem",
      serverName: "filesystem",
    }));
    fs.writeFileSync(path.join(toolsDir, "read_file.json"), JSON.stringify({
      name: "read_file",
      description: "Cached file read",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    }));

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-resolve",
      messages: [{ role: "user", content: "read file" }],
      mcpTools: [{
        mcpTools: [{
          name: "filesystem__read_file",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          providerIdentifier: "filesystem",
          toolName: "read_file",
        }],
      }],
    });

    assert.deepEqual(request.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    assertIncludesAll(request.tools.map((tool) => tool.name), ["AskQuestion", "SwitchMode", "CreatePlan"]);
  } finally {
    restoreHome();
  }
});

test("server resolves explicit MCP provider tools to cached execution server identifiers", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-explicit-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-filesystem");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-filesystem",
      serverName: "filesystem",
    }));
    fs.writeFileSync(path.join(toolsDir, "read_file.json"), JSON.stringify({
      name: "read_file",
      description: "Cached file read",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    }));

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-explicit",
      messages: [{ role: "user", content: "read file" }],
      tools: [{
        name: "user-filesystem-read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        providerIdentifier: "filesystem",
        toolName: "read_file",
      }],
    });

    assert.deepEqual(request.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    assertIncludesAll(request.tools.map((tool) => tool.name), ["AskQuestion", "SwitchMode", "CreatePlan"]);
  } finally {
    restoreHome();
  }
});

test("server resolves legacy MCP provider-visible aliases to Cursor execution names", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-legacy-alias-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-filesystem");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-filesystem",
      serverName: "filesystem",
    }));
    fs.writeFileSync(path.join(toolsDir, "read_file.json"), JSON.stringify({
      name: "read_file",
      description: "Cached file read",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    }));

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-legacy-alias",
      messages: [{ role: "user", content: "read file" }],
      tools: [{
        name: "filesystem__read_file",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        providerIdentifier: "filesystem",
        toolName: "read_file",
      }],
    });

    assert.deepEqual(request.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    assertIncludesAll(request.tools.map((tool) => tool.name), ["AskQuestion", "SwitchMode", "CreatePlan"]);
  } finally {
    restoreHome();
  }
});

test("server falls back to Cursor MCP cache when decoded Run request omits mcpTools", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-"));
  const restoreHome = useHome(tmpRoot);
  try {
    writeMcpCacheTool(tmpRoot, "workspace-a", "user-filesystem", {
      serverName: "filesystem",
      name: "read_file",
      description: "Read file",
      arguments: { type: "object", properties: { path: { type: "string" } } },
      outputSchema: { type: "object" },
    });

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache",
      messages: [{ role: "user", content: "read file" }],
      tools: [{
        name: "TaskCreate",
        description: "Create task",
        inputSchema: { type: "object", properties: { subject: { type: "string" } } },
      }],
    }, { workspaceRoots: ["/workspace/a"] });

    assert.deepEqual(request.tools[0], {
      name: "TaskCreate",
      description: "Create task",
      inputSchema: { type: "object", properties: { subject: { type: "string" } } },
    });
    assert.deepEqual(request.tools.find((tool) => tool.name === "user-filesystem-read_file"), {
      name: "user-filesystem-read_file",
      description: "Read file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      providerIdentifier: "user-filesystem",
      toolName: "read_file",
      executionName: "user-filesystem-read_file",
    });
    assertIncludesAll(request.tools.map((tool) => tool.name), ["AskQuestion", "SwitchMode", "CreatePlan"]);
  } finally {
    restoreHome();
  }
});

test("server adds virtual MCP auth tool from Cursor MCP cache status and refreshes when status changes", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-auth-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "plugin-atlassian-atlassian");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "plugin-atlassian-atlassian",
      serverName: "atlassian",
    }));
    fs.writeFileSync(path.join(serverDir, "STATUS.md"), "Server needs authentication. Use mcp_auth to continue.");

    const first = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-auth-cache",
      messages: [{ role: "user", content: "auth MCP" }],
      tools: [],
    }, { workspaceRoots: ["/workspace/a"] });
    const authTool = first.tools.find((tool) => tool.toolName === "mcp_auth");
    assert.deepEqual(authTool, {
      name: "plugin-atlassian-atlassian-mcp_auth",
      executionName: "plugin-atlassian-atlassian-mcp_auth",
      description: "Authenticate MCP server plugin-atlassian-atlassian. Call this tool with an empty arguments object when the server needs authentication.",
      inputSchema: {
        type: "object",
        properties: {
          server_identifier: { type: "string", description: "Optional MCP server identifier override." },
          serverIdentifier: { type: "string", description: "Optional MCP server identifier override (camelCase)." },
        },
        additionalProperties: false,
      },
      providerIdentifier: "plugin-atlassian-atlassian",
      toolName: "mcp_auth",
    });

    fs.writeFileSync(path.join(serverDir, "STATUS.md"), "Server is ready.");
    const changedStatusTime = new Date(Date.now() + 1000);
    fs.utimesSync(path.join(serverDir, "STATUS.md"), changedStatusTime, changedStatusTime);
    const second = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-auth-cache-ready",
      messages: [{ role: "user", content: "auth MCP again" }],
      tools: [],
    }, { workspaceRoots: ["/workspace/a"] });
    assert.equal(second.tools.some((tool) => tool.toolName === "mcp_auth"), false);
  } finally {
    restoreHome();
  }
});

test("server MCP cache fallback reads only the current workspace project when workspace root is known", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-current-workspace-"));
  const restoreHome = useHome(tmpRoot);
  try {
    writeMcpCacheTool(tmpRoot, "Users-jun-c-liu-source-current", "user-filesystem", {
      serverName: "filesystem",
      name: "read_file",
      description: "Current file read",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    });
    writeMcpCacheTool(tmpRoot, "Users-jun-c-liu-source-other", "user-other", {
      serverName: "other",
      name: "other_tool",
      description: "Other workspace tool",
      arguments: { type: "object", properties: {} },
    });

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-current",
      messages: [{ role: "user", content: "read file" }],
      tools: [],
    }, { workspaceRoots: ["/Users/jun.c.liu/source/current"] });
    const names = request.tools.map((tool) => tool.name);
    assert.equal(names.includes("user-filesystem-read_file"), true);
    assert.equal(names.includes("user-other-other_tool"), false);
  } finally {
    restoreHome();
  }
});

test("server MCP cache workspace slug matches Cursor for non-alphanumeric workspace paths", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-official-slug-"));
  const restoreHome = useHome(tmpRoot);
  try {
    writeMcpCacheTool(tmpRoot, "private-tmp-byok-workspace-slug", "user-filesystem", {
      serverName: "filesystem",
      name: "read_file",
      description: "Official slug file read",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    });
    writeMcpCacheTool(tmpRoot, "private-tmp-byok_workspace__slug", "user-stale", {
      serverName: "stale",
      name: "stale_tool",
      description: "Old BYOK slug tool",
      arguments: { type: "object", properties: {} },
    });

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-official-slug",
      messages: [{ role: "user", content: "read file" }],
      tools: [],
    }, { workspaceRoots: ["/private/tmp/byok_workspace__slug"] });

    const toolNames = request.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("user-filesystem-read_file"), true);
    assert.equal(toolNames.includes("user-stale-stale_tool"), false);
  } finally {
    restoreHome();
  }
});

test("server reuses workspace MCP cache until the project mcps directory changes", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-reuse-"));
  const restoreHome = useHome(tmpRoot);
  const originalReaddirSync = fs.readdirSync;
  let toolDirectoryReads = 0;
  const mcpsDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps");
  try {
    writeMcpCacheTool(tmpRoot, "workspace-a", "user-filesystem", {
      serverName: "filesystem",
      name: "read_file",
      description: "Read file",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    });
    fs.readdirSync = function (...args) {
      if (String(args[0]).startsWith(mcpsDir)) toolDirectoryReads += 1;
      return originalReaddirSync.apply(this, args);
    };

    const first = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-reuse-1",
      messages: [{ role: "user", content: "read file" }],
    }, { workspaceRoots: ["/workspace/a"] });
    const second = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-reuse-2",
      messages: [{ role: "user", content: "read file again" }],
    }, { workspaceRoots: ["/workspace/a"] });

    assert.equal(first.tools.some((tool) => tool.name === "user-filesystem-read_file"), true);
    assert.equal(second.tools.some((tool) => tool.name === "user-filesystem-read_file"), true);
    assert.equal(toolDirectoryReads, 2);

    writeMcpCacheTool(tmpRoot, "workspace-a", "user-grafana", {
      serverName: "grafana",
      name: "list_dashboards",
      description: "List dashboards",
      arguments: { type: "object", properties: {} },
    });
    const changedMtime = new Date(Date.now() + 1000);
    fs.utimesSync(mcpsDir, changedMtime, changedMtime);

    const third = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-reuse-3",
      messages: [{ role: "user", content: "check Grafana" }],
    }, { workspaceRoots: ["/workspace/a"] });

    assert.equal(third.tools.some((tool) => tool.name === "user-grafana-list_dashboards"), true);
    assert.equal(toolDirectoryReads, 5);
  } finally {
    fs.readdirSync = originalReaddirSync;
    restoreHome();
  }
});

test("server refreshes workspace MCP cache when a cached tool descriptor changes", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-tool-update-"));
  const restoreHome = useHome(tmpRoot);
  const projectName = "workspace-a";
  const serverIdentifier = "user-filesystem";
  const toolFile = path.join(
    tmpRoot,
    ".cursor",
    "projects",
    projectName,
    "mcps",
    serverIdentifier,
    "tools",
    "read_file.json",
  );
  try {
    writeMcpCacheTool(tmpRoot, projectName, serverIdentifier, {
      serverName: "filesystem",
      name: "read_file",
      description: "Read file v1",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    });

    const first = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-tool-update-1",
      messages: [{ role: "user", content: "read file" }],
      tools: [],
    }, { workspaceRoots: ["/workspace/a"] });
    assert.equal(first.tools.find((tool) => tool.name === "user-filesystem-read_file").description, "Read file v1");

    fs.writeFileSync(toolFile, JSON.stringify({
      name: "read_file",
      description: "Read file v2",
      arguments: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } } },
    }));
    const changedMtime = new Date(Date.now() + 2000);
    fs.utimesSync(toolFile, changedMtime, changedMtime);

    const second = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-tool-update-2",
      messages: [{ role: "user", content: "read file again" }],
      tools: [],
    }, { workspaceRoots: ["/workspace/a"] });
    const tool = second.tools.find((item) => item.name === "user-filesystem-read_file");
    assert.equal(tool.description, "Read file v2");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["offset", "path"]);
  } finally {
    restoreHome();
  }
});

test("server bounds workspace MCP cache entries without disabling cache reuse", () => {
  assert.equal(DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES >= 16, true);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-lru-"));
  const restoreHome = useHome(tmpRoot);
  const originalReaddirSync = fs.readdirSync;
  const readCounts = new Map();
  try {
    for (let i = 0; i <= DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES; i++) {
      writeMcpCacheTool(tmpRoot, `workspace-${i}`, `user-server-${i}`, {
        serverName: `server-${i}`,
        name: "ping",
        description: `Ping ${i}`,
        arguments: { type: "object", properties: {} },
      });
    }
    fs.readdirSync = function (...args) {
      const value = String(args[0]);
      const match = value.match(/workspace-(\d+)\/mcps/);
      if (match) readCounts.set(match[1], (readCounts.get(match[1]) || 0) + 1);
      return originalReaddirSync.apply(this, args);
    };

    const runForWorkspace = (index) => normalizeRunRequestForProvider({
      conversationId: `conv-mcp-cache-lru-${index}`,
      messages: [{ role: "user", content: "ping" }],
      tools: [],
    }, { workspaceRoots: [`/workspace/${index}`] });
    for (let i = 0; i <= DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES; i++) {
      assert.equal(runForWorkspace(i).tools.some((tool) => tool.name === `user-server-${i}-ping`), true);
    }
    const newestReadsAfterInitialLoad = readCounts.get(String(DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES));
    assert.equal(runForWorkspace(DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES).tools.some((tool) => tool.name === `user-server-${DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES}-ping`), true);
    assert.equal(readCounts.get(String(DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES)), newestReadsAfterInitialLoad, "newest cached workspace should be reused");
    const oldestReadsAfterEviction = readCounts.get("0");
    assert.equal(runForWorkspace(0).tools.some((tool) => tool.name === "user-server-0-ping"), true);
    assert.equal(readCounts.get("0") > oldestReadsAfterEviction, true, "oldest workspace should be evicted and reread");
  } finally {
    fs.readdirSync = originalReaddirSync;
    restoreHome();
  }
});

test("server sanitizes Cursor MCP cache tool names for provider tool-name rules", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-sanitize-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-awslabs.aws-documentation-mcp-server");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-awslabs.aws-documentation-mcp-server",
      serverName: "awslabs.aws-documentation-mcp-server",
    }));
    fs.writeFileSync(path.join(toolsDir, "read_documentation.json"), JSON.stringify({
      name: "read.documentation",
      description: "Read docs",
      arguments: { type: "object", properties: { url: { type: "string" } } },
    }));

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-sanitize",
      messages: [{ role: "user", content: "read docs" }],
      tools: [],
    });
    const tool = request.tools.find((item) => item.toolName === "read.documentation");
    assert.equal(tool.name, "user-awslabs_aws-documentation-mcp-server-read_documentation");
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,128}$/);
    assert.equal(tool.providerIdentifier, "user-awslabs.aws-documentation-mcp-server");
    assert.equal(tool.toolName, "read.documentation");
    assert.equal(tool.executionName, "user-awslabs.aws-documentation-mcp-server-read.documentation");
  } finally {
    restoreHome();
  }
});

test("server preserves dotted MCP provider identifiers behind sanitized provider tool names", () => {
  const request = normalizeRunRequestForProvider({
    conversationId: "conv-mcp-dotted-provider-id",
    messages: [{ role: "user", content: "search AWS docs" }],
    tools: [{
      name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
      description: "Search docs",
      inputSchema: { type: "object", properties: { search_phrase: { type: "string" } } },
      providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
      toolName: "search_documentation",
    }],
  });

  assert.deepEqual(request.tools.find((tool) => tool.name === "user-awslabs_aws-documentation-mcp-server-search_documentation"), {
    name: "user-awslabs_aws-documentation-mcp-server-search_documentation",
    description: "Search docs",
    inputSchema: { type: "object", properties: { search_phrase: { type: "string" } } },
    providerIdentifier: "user-awslabs.aws-documentation-mcp-server",
    toolName: "search_documentation",
    executionName: "user-awslabs.aws-documentation-mcp-server-search_documentation",
  });
});

test("server keeps Cursor built-in tools when only MCP cache supplies extra tools", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-default-tools-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-filesystem");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-filesystem",
      serverName: "filesystem",
    }));
    fs.writeFileSync(path.join(toolsDir, "read_file.json"), JSON.stringify({
      name: "read_file",
      description: "Read file",
      arguments: { type: "object", properties: { path: { type: "string" } } },
    }));

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-default-tools",
      messages: [{ role: "user", content: "read file and read file" }],
    });
    const names = request.tools.map((tool) => tool.name || tool.canonicalName);
    assert.equal(names.includes("Read"), true);
    assert.equal(names.includes("Write"), true);
    assert.equal(names.includes("CallMcpTool"), true);
    assert.equal(names.includes("user-filesystem-read_file"), true);
  } finally {
    restoreHome();
  }
});

test("server suppresses bulk auto-exposed MCP tools when cached tool count exceeds the provider threshold", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-mcp-cache-threshold-"));
  const restoreHome = useHome(tmpRoot);
  try {
    const serverDir = path.join(tmpRoot, ".cursor", "projects", "workspace-a", "mcps", "user-huge");
    const toolsDir = path.join(serverDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "SERVER_METADATA.json"), JSON.stringify({
      serverIdentifier: "user-huge",
      serverName: "huge",
    }));
    fs.writeFileSync(path.join(serverDir, "STATUS.md"), "needs authentication via mcp_auth");
    // Guard against a silently-undefined import: `i <= undefined` would write
    // zero tool files and make every assertion below vacuous.
    assert.equal(Number.isInteger(DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS), true);
    for (let i = 0; i <= DEFAULT_MAX_AUTO_EXPOSED_MCP_PROVIDER_TOOLS; i++) {
      fs.writeFileSync(path.join(toolsDir, `tool_${i}.json`), JSON.stringify({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        arguments: { type: "object", properties: { value: { type: "string" } } },
      }));
    }

    const request = normalizeRunRequestForProvider({
      conversationId: "conv-mcp-cache-threshold",
      messages: [{ role: "user", content: "use huge MCP set" }],
    });
    const names = request.tools.map((tool) => tool.name || tool.canonicalName);
    assert.equal(names.includes("CallMcpTool"), true);
    assert.equal(names.includes("ListMcpResources"), true);
    assert.equal(names.some((name) => name === "user-huge-tool_0"), false);
    assert.equal(names.some((name) => name.includes("mcp_auth")), true);
  } finally {
    restoreHome();
  }
});
