"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildReadArgs,
  coerceProviderToolSchema,
  CURSOR_BUILTIN_TOOLS,
  normalizeProviderJsonSchema,
  patchProviderToolSchema,
  patchReadToolSchema,
} = require("../src/runtime/tools");
const {
  byokModelIds,
  byokPublicModelIds,
  findProviderModel,
  mergeAvailableModels,
  modelIdCandidates,
  pickModelId,
} = require("../src/runtime/models");
const {
  appendByokPromptRules,
  formatWorkspaceRootsPromptSection,
  loadByokSystemPrompt,
  sanitizeProviderVisiblePromptText,
} = require("../src/runtime/prompt");
const {
  preserveAnthropicCacheControl,
  withOpenAiPromptCacheKey,
} = require("../src/runtime/cache");
const { ByokSessionStore } = require("../src/runtime/state");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, resultCaseForToolName, routePatterns, summarizeExecResult } = require("../src/server/http");
const {
  buildPrompt,
  collectAnthropicEvents,
  collectOpenAiEvents,
  normalizeProviderMessage,
  normalizeTools,
  stringifyToolResultForProvider,
} = require("../src/server/provider-adapter");
const { createHookRuntimeHelpersForTest } = require("../src/workbench-hook");

const root = path.resolve(__dirname, "..");
const providerToolsDoc = fs.readFileSync(path.join(root, "docs/provider-tools.md"), "utf8");
const providerToolsCnDoc = fs.readFileSync(path.join(root, "docs/provider-tools_CN.md"), "utf8");
const cursorToolSpecDoc = fs.readFileSync(path.join(root, "docs/cursor-tool-spec.md"), "utf8");
const cursorToolSpecCnDoc = fs.readFileSync(path.join(root, "docs/cursor-tool-spec_CN.md"), "utf8");
const architectureDoc = fs.readFileSync(path.join(root, "docs/architecture.md"), "utf8");
const architectureCnDoc = fs.readFileSync(path.join(root, "docs/architecture_CN.md"), "utf8");
const providerAdapterSource = fs.readFileSync(path.join(root, "src/server/provider-adapter.js"), "utf8");
const normalizedProviderToolsDoc = providerToolsDoc.replace(/\s+/g, " ");
const normalizedProviderToolsCnDoc = providerToolsCnDoc.replace(/\s+/g, " ");
const normalizedCursorToolSpecDoc = cursorToolSpecDoc.replace(/\s+/g, " ");
const normalizedCursorToolSpecCnDoc = cursorToolSpecCnDoc.replace(/\s+/g, " ");
const normalizedArchitectureDoc = architectureDoc.replace(/\s+/g, " ");
const normalizedArchitectureCnDoc = architectureCnDoc.replace(/\s+/g, " ");

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(filePath));
    else if (entry.isFile()) out.push(filePath);
  }
  return out;
}

function normalizedTestName(value) {
  return value.replace(/\s+/g, " ").trim();
}

function configWith(model) {
  return { schemaVersion: 1, providers: [{ id: "prov", name: "Prov", type: "openai-chat", models: [model] }] };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCursorToolSpecRows(source) {
  const rows = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const columns = [
      parts[1],
      parts[2],
      parts[3],
      parts[4],
      parts.slice(5, -1).join("|"),
    ].map((column) => column.trim());
    const names = [...columns[0].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const name of names) {
      rows.set(name, {
        tool: columns[0],
        schema: columns[1],
        uiToolCall: columns[2],
        executionPath: columns[3],
        resultCase: columns[4],
      });
    }
  }
  return rows;
}

function markdownCodeText(value) {
  const match = value.match(/^`([^`]+)`$/);
  return match ? match[1] : value;
}

function cursorToolArgs(name) {
  switch (name) {
    case "Shell":
      return { command: "pwd", description: "print cwd", working_directory: "/tmp" };
    case "Glob":
      return { glob_pattern: "*.js", target_directory: "/tmp" };
    case "Grep":
      return { pattern: "needle", path: "/tmp", output_mode: "content", head_limit: 5, offset: 2 };
    case "LS":
      return { path: "/tmp", ignore_globs: ["**/node_modules/**"] };
    case "AwaitShell":
      return { shell_id: "shell-1", block_until_ms: 1000 };
    case "Read":
    case "ReadFile":
      return { path: "/tmp/file.txt", offset: 1, limit: 2 };
    case "Delete":
      return { path: "/tmp/file.txt" };
    case "Edit":
      return { path: "/tmp/file.txt", old_string: "old", new_string: "new" };
    case "ApplyPatch":
      return { patch: "*** Begin Patch\n*** Update File: /tmp/file.txt\n@@\n-old\n+new\n*** End Patch\n" };
    case "Write":
      return { path: "/tmp/file.txt", contents: "new\n" };
    case "EditNotebook":
      return { target_notebook: "/tmp/notebook.ipynb", cell_idx: 0, new_string: "print(1)" };
    case "TodoWrite":
      return { todos: [{ id: "todo-1", content: "Check parity", status: "pending" }] };
    case "TaskCreate":
      return { taskId: "task-1", subject: "Check parity" };
    case "TaskUpdate":
      return { taskId: "task-1", status: "completed" };
    case "TaskList":
      return {};
    case "TaskGet":
      return { taskId: "task-1" };
    case "ReadLints":
      return { paths: ["/tmp/file.txt"] };
    case "WebFetch":
      return { url: "https://example.com" };
    case "WebSearch":
      return { search_term: "cursor byok" };
    case "WriteShellStdin":
      return { shell_id: "42", chars: "y\n" };
    case "ListMcpResources":
      return { server: "server-1" };
    case "FetchMcpResource":
      return { server: "server-1", uri: "file:///tmp/resource.txt", downloadPath: "" };
    case "CallMcpTool":
      return { name: "tool", args: { q: "x" }, providerIdentifier: "provider-1", toolName: "tool" };
    case "AskQuestion":
      return {
        title: "Confirm",
        questions: [{ id: "q1", prompt: "Proceed?", options: [{ id: "yes", label: "Yes" }] }],
      };
    case "SwitchMode":
      return { target_mode_id: "agent", explanation: "Need agent mode" };
    case "CreatePlan":
      return {
        name: "Plan",
        overview: "Overview",
        plan: "Step 1",
        todos: [{ id: "t1", content: "Do it", status: "pending", dependencies: [] }],
        isProject: false,
        phases: [{ name: "Phase", todos: [{ id: "p1", content: "Plan it", status: "pending", dependencies: ["t1"] }] }],
      };
    default:
      throw new Error(`missing test args for ${name}`);
  }
}

function toolStartedMessageCase(messages) {
  return messages[0]?.message?.value?.message?.value?.toolCall?.tool?.case;
}

function nativeExecMessageCase(messages) {
  return messages.find((message) => message.message?.case === "execServerMessage")?.message.value.message.case;
}

test("modelIdCandidates returns every identifier a model is reachable by, minus 'default'", () => {
  const candidates = modelIdCandidates({
    id: "id-1",
    apiModel: "api-1",
    name: "name-1",
    displayName: "Display 1",
    clientDisplayName: "Client 1",
    inputboxShortModelName: "Short 1",
    serverModelName: "server-1",
    legacyId: "legacy-1",
    legacySlugs: ["slug-1", "default", "slug-1"],
    idAliases: ["alias-1"],
  });
  assert.deepEqual(candidates.sort(), [
    "Client 1",
    "Display 1",
    "Short 1",
    "alias-1",
    "api-1",
    "id-1",
    "legacy-1",
    "name-1",
    "server-1",
    "slug-1",
  ].sort());
  assert.deepEqual(modelIdCandidates({ id: "default", apiModel: "real" }), ["real"]);
  assert.deepEqual(modelIdCandidates(null), []);
});

test("byokModelIds and findProviderModel agree on the same candidate set", () => {
  const config = configWith({
    id: "id-1",
    serverModelName: "server-1",
    inputboxShortModelName: "Short 1",
    legacyId: "legacy-1",
    legacySlugs: ["slug-1"],
  });
  const ids = byokModelIds(config);
  for (const candidate of ["id-1", "server-1", "Short 1", "legacy-1", "slug-1"]) {
    assert.ok(ids.has(candidate), `expected byokModelIds to contain ${candidate}`);
    assert.ok(findProviderModel(candidate, config), `expected findProviderModel to match ${candidate}`);
  }
  assert.equal(findProviderModel("nope", config), null);
});

test("byokPublicModelIds exposes Cursor UI aliases without upstream-only api model ids", () => {
  const ids = byokPublicModelIds(configWith({
    id: "public-id",
    apiModel: "upstream-model",
    displayName: "Public Display",
    inputboxShortModelName: "Short",
    serverModelName: "upstream-server",
    legacySlugs: ["legacy-slug"],
  }));
  assert.equal(ids.has("public-id"), true);
  assert.equal(ids.has("Public Display"), true);
  assert.equal(ids.has("Short"), true);
  assert.equal(ids.has("legacy-slug"), true);
  assert.equal(ids.has("upstream-model"), false);
  assert.equal(ids.has("upstream-server"), false);
  assert.deepEqual([...byokPublicModelIds(configWith({ id: "byok-model" }))], ["byok-model"]);
});

test("mergeAvailableModels dedupes official models colliding on serverModelName or displayName", () => {
  const serverNameCollision = mergeAvailableModels(
    [{ id: "shared-server", name: "Official Shared" }],
    configWith({ id: "byok-1", apiModel: "byok-api", serverModelName: "shared-server" }),
  );
  assert.equal(serverNameCollision.filter((m) => m.name === "Official Shared").length, 0);
  assert.equal(serverNameCollision.filter((m) => m.isByok).length, 1);

  const displayNameCollision = mergeAvailableModels(
    [{ id: "Shared Display", name: "Off" }],
    configWith({ id: "byok-2", displayName: "Shared Display" }),
  );
  assert.equal(displayNameCollision.filter((m) => !m.isByok).length, 0);

  const kept = mergeAvailableModels(
    [{ id: "totally-different", name: "Keep Me" }],
    configWith({ id: "byok-3", apiModel: "byok-api-3" }),
  );
  assert.ok(kept.some((m) => m.id === "totally-different"));
  assert.ok(kept.some((m) => m.isByok));
});

test("model picker prefers BYOK candidate over mixed official display fields", () => {
  const providers = {
    providers: [
      {
        id: "p",
        name: "Provider",
        type: "openai-chat",
        models: [{ id: "byok-model", apiModel: "real-model", displayName: "BYOK Model" }],
      },
    ],
  };
  assert.deepEqual([...byokModelIds(providers)].sort(), ["BYOK Model", "byok-model", "real-model"]);
  assert.equal(pickModelId(["gpt-4.1", "byok-model", "display"], providers), "byok-model");
  assert.equal(pickModelId(["gpt-4.1", "display"], providers), "gpt-4.1");
});

test("available models merge official and BYOK while removing duplicate official entries", () => {
  const merged = mergeAvailableModels(
    [{ id: "official" }, { id: "byok-model" }, { id: "enum", status: "DEGRADED", degradation_status: "DEGRADED" }],
    {
      providers: [
        {
          id: "p",
          name: "Provider",
          type: "openai-chat",
          models: [{ id: "byok-model", apiModel: "api-model", displayName: "BYOK Model" }],
        },
      ],
    },
  );
  assert.equal(merged.some((model) => model.id === "official"), true);
  assert.equal(merged.filter((model) => model.id === "byok-model").length, 1);
  assert.equal(merged.find((model) => model.id === "enum").status, undefined);
  assert.equal(merged.find((model) => model.id === "enum").degradation_status, undefined);
});

test("available BYOK models expose their public id as a legacy slug for Cursor hook lookup", () => {
  const [model] = mergeAvailableModels([], configWith({
    id: "gpt55-sub2api",
    legacySlugs: ["gpt55-sub2api", "old-hook-slug"],
  }));

  assert.deepEqual(model.legacySlugs, ["gpt55-sub2api", "old-hook-slug"]);
  assert.deepEqual(model.variants, [{
    displayName: "gpt55-sub2api",
    displayNameOutsidePicker: "gpt55-sub2api",
    parameterValues: [],
    isMaxMode: false,
    isDefaultNonMaxConfig: true,
    isDefaultMaxConfig: true,
    variantStringRepresentation: "gpt55-sub2api[]",
    legacySlug: "gpt55-sub2api",
  }]);
});

test("BYOK default variant resolves selectedModels to a Cursor hook legacy slug", () => {
  const [model] = mergeAvailableModels([], configWith({
    id: "gpt55-sub2api",
    legacySlugs: ["old-hook-slug"],
  }));
  const selectedModel = { modelId: "gpt55-sub2api", parameters: [] };

  assert.equal(resolveHookLegacySlugLikeCursor([model], selectedModel, false), "gpt55-sub2api");
  assert.equal(resolveHookLegacySlugLikeCursor([model], selectedModel, true), "gpt55-sub2api");
});

test("available models do not expose provider credentials through Cursor model metadata", () => {
  const merged = mergeAvailableModels([], {
    providers: [
      {
        id: "openai-bearer",
        name: "OpenAI Bearer",
        type: "openai-chat",
        baseUrl: "https://openai-compatible.example/v1",
        auth: { kind: "bearer", value: "bearer-key" },
        models: [{ id: "openai-compatible-model" }],
      },
      {
        id: "openai-api-key",
        name: "OpenAI Api Key",
        type: "openai-chat",
        baseUrl: "https://api-key.example/v1",
        auth: { kind: "api-key", value: "api-key" },
        models: [{ id: "api-key-model" }],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        type: "anthropic",
        baseUrl: "https://anthropic.example/v1",
        auth: { value: "anthropic-key" },
        models: [{ id: "anthropic-model" }],
      },
    ],
  });
  for (const model of merged) {
    assert.equal(model.cursorByokLocalAgentCompatible, undefined);
    assert.equal(model.apiKey, undefined);
    assert.equal(model.openaiApiBaseUrl, undefined);
    assert.equal(model.credentials, undefined);
  }
});

test("available models do not expose migrated legacy random model ids as Cursor ids", () => {
  const providers = {
    providers: [{
      id: "p",
      name: "Provider",
      type: "anthropic",
      models: [{
        id: "sonnet46-dario",
        apiModel: "claude-sonnet-4-6",
        displayName: "sonnet46-dario",
        legacyId: "model-tbrsj6",
        supportsAgent: true,
      }],
    }],
  };
  const merged = mergeAvailableModels([], providers);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "sonnet46-dario");
  assert.equal(merged[0].name, "sonnet46-dario");
  assert.equal(merged[0].displayName, "sonnet46-dario");
  assert.equal(merged[0].apiModel, "claude-sonnet-4-6");
  assert.deepEqual(merged[0].legacySlugs, ["sonnet46-dario", "model-tbrsj6"]);
  assert.equal(merged[0].variants[0].legacySlug, "sonnet46-dario");
  assert.equal(byokModelIds(providers).has("model-tbrsj6"), true);
  assert.equal(findProviderModel("sonnet46-dario", providers).model.id, "sonnet46-dario");
  assert.equal(findProviderModel("model-tbrsj6", providers).model.displayName, "sonnet46-dario");
});

function resolveHookLegacySlugLikeCursor(models, selectedModel, maxMode) {
  const model = models.find((candidate) => candidate.name === selectedModel.modelId);
  if (!model) return "unknown";
  const variant = model.variants.find((candidate) => sameParameterValues(candidate, selectedModel.parameters || []))
    || defaultVariantLikeCursor(model, maxMode);
  const legacySlug = variant?.legacySlug?.trim();
  return legacySlug || "unknown";
}

function defaultVariantLikeCursor(model, maxMode) {
  if (model.variants.length === 0) return undefined;
  const defaultKey = maxMode ? "isDefaultMaxConfig" : "isDefaultNonMaxConfig";
  const modeMatches = (variant) => (maxMode ? variant.isMaxMode === true : variant.isMaxMode !== true);
  return model.variants.find((variant) => variant[defaultKey] === true)
    || model.variants.find(modeMatches)
    || model.variants[0];
}

function sameParameterValues(variant, parameters) {
  return variant.parameterValues.length === parameters.length
    && variant.parameterValues.every((parameter) => {
      const match = parameters.find((candidate) => candidate.id === parameter.id);
      return match?.value === parameter.value;
    });
}

test("Read args preserve path offset and limit without mutating aliases", () => {
  assert.deepEqual(
    buildReadArgs({ path: "/a", file_path: "/wrong", offset: "12", limit: 20 }),
    { path: "/a", offset: 12, limit: 20 },
  );
  assert.deepEqual(
    buildReadArgs({ path: "", filePath: "/camel", file_path: "/legacy" }),
    { path: "/camel" },
  );
  assert.deepEqual(buildReadArgs({ file_path: "/legacy", offset: "bad" }), { path: "/legacy" });
  assert.deepEqual(buildReadArgs({ filePath: "/camel", limit: "3" }), { path: "/camel", limit: 3 });
});

test("Read schema tells model exact offset and limit contract", () => {
  const tool = patchReadToolSchema({
    canonicalName: "Read",
    inputSchema: { type: "object", properties: { path: {}, offset: {}, limit: {} } },
  });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /Prefer Grep to locate symbols, definitions, and callsites before using Read/);
  assert.match(tool.description, /Do not start with a whole-file Read/);
  assert.match(tool.description, /use those exact values before inventing your own smaller same-file Read/);
  assert.match(tool.description, /do not jump to unrelated earlier offsets in that same file/);
  assert.match(tool.description, /do not Grep the same file for that exact prose/);
  assert.match(tool.description, /Cursor code reference fence/);
  assert.match(tool.description, /opening fence line must be exactly three backticks immediately followed by startLine:endLine:filepath/);
  assert.match(tool.description, /Never emit those placeholder words literally in the final answer/);
  assert.match(tool.description, /top-level block, not inside a list item, block quote, or indented block/);
  assert.match(tool.description, /Build that code reference from the Read result's File: and Lines: values/);
  assert.match(tool.description, /only valid Read input keys are path, offset, and limit/);
  assert.match(tool.inputSchema.properties.path.description, /do not use filePath or file_path/);
});

test("provider prompt uses Cursor built-in tool schemas when Run request has no tools", () => {
  const prompt = buildPrompt({
    conversationId: "conv-default-tools",
    systemPrompt: "system",
    messages: [{ role: "user", content: "read and grep" }],
  });

  const names = prompt.tools.map((tool) => tool.name || tool.canonicalName);
  assert.deepEqual(names, [
    "Shell",
    "Glob",
    "LS",
    "Grep",
    "AwaitShell",
    "Read",
    "Delete",
    "Edit",
    "ApplyPatch",
    "Write",
    "EditNotebook",
    "TodoWrite",
    "ReadLints",
    "WebFetch",
    "WriteShellStdin",
    "AskQuestion",
    "ListMcpResources",
    "FetchMcpResource",
    "SwitchMode",
    "CallMcpTool",
    "CreatePlan",
  ]);
  for (const unsupported of ["WebSearch", "GenerateImage", "Task", "Subagent", "RecordScreen", "ComputerUse"]) {
    assert.equal(names.includes(unsupported), false, `${unsupported} must not be exposed by default without native execution support`);
  }
  assert.equal(names.includes("ReadFile"), false, "ReadFile is an explicit legacy alias, not a default provider tool");

  const read = prompt.tools.find((tool) => tool.name === "Read");
  assert.equal(read.inputSchema.additionalProperties, false);
  assert.deepEqual(read.inputSchema.required, ["path"]);
  assert.deepEqual(Object.keys(read.inputSchema.properties), ["path", "offset", "limit"]);
  assert.match(read.description, /Prefer Grep to locate symbols, definitions, and callsites before using Read/);
  assert.match(read.description, /only valid Read input keys are path, offset, and limit/);

  const glob = prompt.tools.find((tool) => tool.name === "Glob");
  assert.deepEqual(glob.inputSchema.required, ["glob_pattern"]);
  assert.deepEqual(Object.keys(glob.inputSchema.properties), ["glob_pattern", "target_directory"]);
  assert.match(loadByokSystemPrompt(), /LS: optional `path`, `target_directory`, `ignore`, `ignore_globs`/);

  const grep = prompt.tools.find((tool) => tool.name === "Grep");
  assert.deepEqual(grep.inputSchema.required, ["pattern"]);
  assert.equal(grep.inputSchema.properties.offset.type, "integer");
  assert.match(grep.description, /Prefer this before Read for exact symbol lookup, definition lookup, and callsite discovery/);

  const awaitShell = prompt.tools.find((tool) => tool.name === "AwaitShell");
  assert.match(awaitShell.description, /shell_id or task_id/);
  assert.doesNotMatch(awaitShell.description, /sleep for block_until_ms only/);
  assert.deepEqual(Object.keys(awaitShell.inputSchema.properties), ["shell_id", "task_id", "block_until_ms"]);
  assert.match(loadByokSystemPrompt(), /Do not call AwaitShell as a standalone sleep/);
  assert.doesNotMatch(loadByokSystemPrompt(), /AwaitShell:[^\n]*pattern/);

  const todoWrite = prompt.tools.find((tool) => tool.name === "TodoWrite");
  assert.deepEqual(todoWrite.inputSchema.required, ["todos"]);
  assert.deepEqual(Object.keys(todoWrite.inputSchema.properties), ["todos", "merge"]);
  assert.equal(todoWrite.inputSchema.properties.todos.items.required, undefined);
  assert.match(todoWrite.description, /only accept id, content, and status/i);
  assert.match(todoWrite.description, /Do not include dependencies/i);
  assert.match(loadByokSystemPrompt(), /TodoWrite: required `todos`; optional `merge`/);
  assert.match(loadByokSystemPrompt(), /TodoWrite is only for the internal progress checklist/);
  assert.match(loadByokSystemPrompt(), /Do not include `dependencies` or copy full `CreatePlan` todo objects into `TodoWrite`/);
  assert.doesNotMatch(loadByokSystemPrompt(), /TodoWrite: required `todos`, `merge`/);

  const callMcpTool = prompt.tools.find((tool) => tool.name === "CallMcpTool");
  assert.deepEqual(callMcpTool.inputSchema.required, ["name", "args", "providerIdentifier", "toolName"]);
  assert.deepEqual(Object.keys(callMcpTool.inputSchema.properties), ["name", "args", "providerIdentifier", "toolName"]);
  const byokPrompt = loadByokSystemPrompt();
  assert.match(byokPrompt, /ReadLints: optional `paths`/);
  assert.match(byokPrompt, /WebFetch: required `url`/);
  assert.match(byokPrompt, /WriteShellStdin: required `shell_id`, `chars`/);
  assert.match(byokPrompt, /AskQuestion: required `questions`; optional `title`/);
  assert.match(byokPrompt, /Do not reuse `CreatePlan` todo objects directly for `TodoWrite`/);
  assert.match(byokPrompt, /For repository-tool work, keep progress narration minimal/);
  assert.match(byokPrompt, /Use at most one short status update before a related tool sequence/);
  assert.match(byokPrompt, /Grep first; do not start with a blind Read/);
  assert.match(byokPrompt, /If the user explicitly names one or more exact files, do not call `LS` on their parent directory/);
  assert.match(byokPrompt, /For questions limited to one or two explicitly named files, prefer exact-symbol Grep or direct narrow Read/);
  assert.match(byokPrompt, /start with one exact-symbol Grep/);
  assert.match(byokPrompt, /Only add a second, more specialized Grep if the first result is ambiguous/);
  assert.match(byokPrompt, /continue promptly with the next needed related tool call or answer directly/);
  assert.match(byokPrompt, /avoid extra narration or long pauses before closely related tool calls/);
  assert.match(byokPrompt, /do not use Shell when Grep, Read, Glob, or LS can answer/);
  assert.match(byokPrompt, /prefer one broader Read window or one multi-pattern Grep/);
  assert.match(byokPrompt, /combine them into one regex alternation pattern/);
  assert.match(byokPrompt, /If a Grep result already shows the exact line numbers for a symbol's definition or caller/);
  assert.match(byokPrompt, /If a Grep result already identifies the matching file path for a symbol/);
  assert.match(byokPrompt, /For a cross-file relation question over a small named file set, use at most one exact-symbol Grep per named file/);
  assert.match(byokPrompt, /Do not run the same exact-symbol Grep again in a broader path scope or a different output mode/);
  assert.match(byokPrompt, /If a Grep result suggests specific Read offset\/limit windows, use those exact windows before requesting any other same-file Read/);
  assert.match(byokPrompt, /Do not batch an exact-symbol Grep with a speculative whole-file or very broad same-file Read/);
  assert.match(byokPrompt, /do not jump to unrelated earlier offsets in that same file before reading those suggested windows/i);
  assert.match(byokPrompt, /Do not invent a smaller same-file window centered on the matched line first/);
  assert.match(byokPrompt, /prefer the suggested Read windows before doing secondary exploratory Greps on generic neighboring terms/);
  assert.match(byokPrompt, /If an exact-symbol Grep summary already gives one same-file caller-reaction window and one helper-behavior window, request those two suggested Read windows in the same response before any other same-file Grep or Read/);
  assert.match(byokPrompt, /do not issue a whole-file Read of that same file; use `offset` and `limit`/);
  assert.match(byokPrompt, /prefer one surrounding Read window around the callsite instead of grepping the enclosing function name separately/);
  assert.match(byokPrompt, /do not Grep the same file for nearby outcome terms such as `err`, `evictedGPU`, `RequeueAfter`, or `return ctrl.Result`/);
  assert.match(byokPrompt, /Do not inspect every helper implementation unless that helper's behavior is necessary/);
  assert.match(byokPrompt, /prefer one callsite Read and one definition Read before considering extra helper or struct lookups/);
  assert.match(byokPrompt, /avoid broad thematic or synonym Greps/);
  assert.match(byokPrompt, /If a Read result already lists helper refs with line numbers, prefer those line hints over grepping the helper names immediately/);
  assert.match(byokPrompt, /If a Read result already lists `Local refs in this window` or `Helper defs in this file`, do not read those helper definitions/);
  assert.match(byokPrompt, /If a callsite Read window already shows the caller's error\/success handling, answer from that callsite window/);
  assert.match(byokPrompt, /If a Read result already lists `Outcome refs in this window`, do not Grep the same file for outcome terms/);
  assert.match(byokPrompt, /If a Read window already includes the helper's leading comment, purpose text, or exact prose you need, do not Grep the same file for that same prose/);
  assert.match(byokPrompt, /If an existing Read window already contains the needed lines, cite the relevant subrange directly from that Read result/);
  assert.match(byokPrompt, /Do not issue a narrower same-file Read merely to restate, quote, or tighten citation/);
  assert.match(byokPrompt, /Do not re-run synonymous Greps on the same file/);
  assert.match(byokPrompt, /After you have enough evidence, answer directly and concisely/);
  assert.match(byokPrompt, /After the final tool result, do not emit another status\/update sentence/);
  assert.match(byokPrompt, /Do not restate your search process, repeat "Let me\.\.\." transitions/);
  assert.match(byokPrompt, /one short intro sentence plus 2-4 short bullets/);
  assert.match(byokPrompt, /stay under about 160 words unless the user explicitly asked for more detail/);
  assert.match(byokPrompt, /target no more than 4 bullets and roughly 120 words/);
  assert.match(byokPrompt, /Avoid headings and code blocks by default/);
  assert.match(byokPrompt, /Do not emit a source-code fence or other code block unless the user explicitly asked to see code/);
  assert.match(byokPrompt, /Prefer brief prose with exact file paths and line numbers/);
  assert.match(byokPrompt, /quote at most one short 1-4 line snippet/i);
  assert.match(byokPrompt, /CODE REFERENCES or MARKDOWN CODE BLOCKS/);
  assert.match(byokPrompt, /METHOD 1: CODE REFERENCES/);
  assert.match(byokPrompt, /Use this exact syntax with three required components/);
  assert.match(byokPrompt, /Required components: `startLine` \(required\), `endLine` \(required\), `filepath` \(required\)/);
  assert.match(byokPrompt, /Never emit the literal placeholder words `startLine`, `endLine`, or `filepath`/);
  assert.match(byokPrompt, /Do not put a source-code fence inside a list item, block quote, or indented container/);
  assert.match(byokPrompt, /METHOD 2: MARKDOWN CODE BLOCKS/);
  assert.match(byokPrompt, /FetchMcpResource: required `server`, `uri`; optional `downloadPath`/);
  assert.match(byokPrompt, /SwitchMode: required `target_mode_id`; optional `explanation`/);
  assert.match(byokPrompt, /CreatePlan: optional `name`, `overview`, `plan`, `todos`, `isProject`, `phases`/);
  assert.match(byokPrompt, /the `plan` field is the markdown body/);
  assert.doesNotMatch(byokPrompt, /CallMcpTool:[^\n]*(?:tool_name|provider`,)/);
});

test("provider tool docs list every default schema contract", () => {
  for (const [name, shape] of [
    ["Shell", "{command, description?, working_directory?, block_until_ms?}"],
    ["Glob", "{glob_pattern, target_directory?}"],
    ["LS", "{path?, target_directory?, ignore?, ignore_globs?}"],
    ["Grep", "{pattern, path?, glob?, type?, output_mode?, -i?, -A?, -B?, -C?, multiline?, head_limit?, offset?}"],
    ["AwaitShell", "{shell_id?, task_id?, block_until_ms?}"],
    ["Read", "{path, offset?, limit?}"],
    ["Delete", "{path}"],
    ["Edit", "{path, old_string, new_string, replace_all?}"],
    ["ApplyPatch", "{patch}"],
    ["Write", "{path, contents}"],
    ["EditNotebook", "{target_notebook, cell_idx, new_string, old_string?, is_new_cell?, cell_language?}"],
    ["TodoWrite", "{todos, merge?}"],
    ["ReadLints", "{paths?}"],
    ["WebFetch", "{url}"],
    ["WriteShellStdin", "{shell_id, chars}"],
    ["AskQuestion", "{questions, title?}"],
    ["ListMcpResources", "{server?}"],
    ["FetchMcpResource", "{server, uri, downloadPath?}"],
    ["SwitchMode", "{target_mode_id, explanation?}"],
    ["CallMcpTool", "{name, args, providerIdentifier, toolName}"],
    ["CreatePlan", "{name?, overview?, plan?, todos?, isProject?, phases?}"],
  ]) {
    const pattern = new RegExp(`${name} = \`${escapeRegExp(shape)}\``);
    assert.match(normalizedProviderToolsDoc, pattern);
    assert.match(normalizedProviderToolsCnDoc, pattern);
    assert.match(normalizedCursorToolSpecDoc, new RegExp(`\\| \`${name}\` \\| \`${escapeRegExp(shape)}\``));
    assert.match(normalizedCursorToolSpecCnDoc, new RegExp(`\\| \`${name}\` \\| \`${escapeRegExp(shape)}\``));
  }
  const cursorBuiltinToolNames = new Set(CURSOR_BUILTIN_TOOLS.map((tool) => tool.name));
  for (const explicitOnly of ["WebSearch", "GenerateImage", "Task"]) {
    assert.equal(cursorBuiltinToolNames.has(explicitOnly), true, `${explicitOnly} remains an internal catalog entry`);
    assert.match(normalizedCursorToolSpecDoc, new RegExp(`\`${explicitOnly}\``));
    assert.match(normalizedCursorToolSpecCnDoc, new RegExp(`\`${explicitOnly}\``));
  }
  assert.equal(cursorBuiltinToolNames.has("Subagent"), false, "Subagent remains a provider-visible blocked alias, not an internal catalog entry");
  assert.match(normalizedCursorToolSpecDoc, /`Subagent` is also filtered\/unsupported.*not a `CURSOR_BUILTIN_TOOLS` entry/);
  assert.match(normalizedCursorToolSpecCnDoc, /`Subagent` 作为 provider 可见 alias 出现时也会被过滤\/unsupported.*不是 `CURSOR_BUILTIN_TOOLS` 条目/);
  for (const filteredTool of ["RecordScreen", "ComputerUse"]) {
    assert.equal(cursorBuiltinToolNames.has(filteredTool), false, `${filteredTool} is filtered, not a catalog entry`);
    assert.match(normalizedCursorToolSpecDoc, new RegExp(`\`${filteredTool}\`.*filtered from provider-visible\\s+schemas.*not \`CURSOR_BUILTIN_TOOLS\` entries`));
    assert.match(normalizedCursorToolSpecCnDoc, new RegExp(`\`${filteredTool}\`.*从 provider-visible schema 中过滤.*不是\\s+\`CURSOR_BUILTIN_TOOLS\` 条目`));
  }
  assert.match(normalizedCursorToolSpecDoc, /`recordScreenResult`.*`computerUseResult`/);
  assert.match(normalizedCursorToolSpecDoc, /BYOK does not expose or native-launch\s+`RecordScreen` \/ `ComputerUse`/);
  assert.match(normalizedCursorToolSpecCnDoc, /`recordScreenResult` \/ `computerUseResult`/);
  assert.match(normalizedCursorToolSpecCnDoc, /不会向 provider 暴露或 native-launch `RecordScreen` \/\s+`ComputerUse`/);
  assert.match(normalizedCursorToolSpecDoc, /BYOK does not save, restore, trim, or synthesize `conversationState`/);
  assert.match(normalizedCursorToolSpecDoc, /persist a reduced BYOK message\s+transcript/);
  assert.match(normalizedCursorToolSpecCnDoc, /BYOK 不保存、不恢复、不裁剪、不合成 `conversationState`/);
  assert.match(normalizedCursorToolSpecCnDoc, /持久化一份精简的 BYOK 消息转录/);
  assert.match(normalizedCursorToolSpecDoc, /`ReadFile`.*legacy alias.*not in the default catalog/);
  assert.match(normalizedCursorToolSpecCnDoc, /`ReadFile`.*legacy alias.*不在默认目录里/);
  assert.match(normalizedProviderToolsDoc, /OpenAI-compatible Chat and Responses requests set `parallel_tool_calls:true`/);
  assert.match(normalizedProviderToolsDoc, /do not set a completion-token cap by default/);
  assert.match(normalizedProviderToolsDoc, /OpenAI Chat also requests streaming usage with\s+`stream_options:\{include_usage:true\}`/);
  assert.match(normalizedProviderToolsDoc, /Anthropic requests send `max_tokens = model\.maxOutputTokens \|\| 8192`/);
  assert.match(normalizedProviderToolsDoc, /`unsupportedToolResult`/);
  assert.match(normalizedProviderToolsDoc, /`localResult\.case:"unsupportedToolResult"`.*`toolCallCompleted`.*`\/byok\/local-tool-result`/);
  assert.match(normalizedProviderToolsCnDoc, /Chat 和 Responses 请求(?:会)?设置 `parallel_tool_calls:true`/);
  assert.match(normalizedProviderToolsCnDoc, /默认不设置 completion token 上限/);
  assert.match(normalizedProviderToolsCnDoc, /OpenAI Chat 还会发送 `stream_options:\{include_usage:true\}`/);
  assert.match(normalizedProviderToolsCnDoc, /Anthropic 请求发送 `max_tokens = model\.maxOutputTokens \|\| 8192`/);
  assert.match(normalizedProviderToolsCnDoc, /`unsupportedToolResult`/);
  assert.match(normalizedProviderToolsCnDoc, /`localResult\.case:"unsupportedToolResult"`.*`toolCallCompleted`.*`\/byok\/local-tool-result`/);
  assert.match(normalizedProviderToolsDoc, /delta\.tool_calls\[\]\.function\.arguments.*delta\.function_call\.arguments/);
  assert.match(normalizedProviderToolsDoc, /`prompt_tokens_details\.cached_tokens`.*`input_tokens_details\.cached_tokens`.*`usage\.cacheReadTokens`/);
  assert.match(normalizedProviderToolsDoc, /`cache_read_input_tokens` \/ `cache_creation_input_tokens`/);
  assert.match(normalizedProviderToolsDoc, /finish_reason==="tool_calls".*finish_reason==="function_call"/);
  assert.match(normalizedProviderToolsDoc, /`finish_reason:"stop"`.*`stopReason:"end_turn"`.*`length` and `content_filter`/);
  assert.match(normalizedProviderToolsDoc, /done-only and standalone function-call argument events/);
  assert.match(normalizedProviderToolsDoc, /`custom_tool_call`.*`response\.custom_tool_call_input\.\*`/);
  assert.match(normalizedProviderToolsDoc, /custom-tool calls are returned to the provider as `custom_tool_call_output` errors/);
  assert.match(normalizedProviderToolsDoc, /reasoning_summary_text\.\*.*reasoning_summary_part\.done.*reasoning `summary\[\]`/);
  assert.match(normalizedProviderToolsDoc, /raw `response\.reasoning_text\.\*` and `reasoning_text` content\s+are not forwarded as text or thinking/);
  assert.match(normalizedProviderToolsDoc, /`error`, `response\.failed`, and `response\.incomplete`.*`stopReason:"error"`/);
  assert.match(normalizedProviderToolsDoc, /Native Responses input\/output items are preserved only when the next\s+call also uses Responses/);
  assert.match(normalizedProviderToolsDoc, /raw `reasoning_text` \/ `encrypted_content` is\s+not forwarded/);
  assert.match(normalizedProviderToolsDoc, /Native Anthropic `thinking` \/ `redacted_thinking` blocks are\s+preserved only when the next call also uses Anthropic/);
  assert.match(normalizedProviderToolsDoc, /`redacted_thinking\.data` and thinking signatures are\s+not forwarded/);
  assert.match(normalizedProviderToolsDoc, /provider-private history items are not exposed as normalized\s+UI events/);
  assert.match(normalizedProviderToolsDoc, /native Responses items from the same turn are reinserted into the\s+next Responses `input`/);
  assert.match(normalizedProviderToolsDoc, /Native Responses output items that are\s+valid follow-up input items are preserved as provider-private history/);
  assert.match(normalizedProviderToolsDoc, /`file_search_call`.*`web_search_call`.*`tool_search_output`.*`function_call_output`/);
  assert.match(normalizedProviderToolsDoc, /Anthropic `thinking` \/ `redacted_thinking` blocks are reinserted\s+into the next Anthropic assistant message/);
  assert.match(normalizedProviderToolsCnDoc, /delta\.tool_calls\[\]\.function\.arguments.*delta\.function_call\.arguments/);
  assert.match(normalizedProviderToolsCnDoc, /`prompt_tokens_details\.cached_tokens`.*`input_tokens_details\.cached_tokens`.*`usage\.cacheReadTokens`/);
  assert.match(normalizedProviderToolsCnDoc, /`cache_read_input_tokens` \/ `cache_creation_input_tokens`/);
  assert.match(normalizedProviderToolsCnDoc, /finish_reason==="tool_calls".*finish_reason==="function_call"/);
  assert.match(normalizedProviderToolsCnDoc, /`finish_reason:"stop"`.*`stopReason:"end_turn"`.*`length`、`content_filter`/);
  assert.match(normalizedProviderToolsCnDoc, /独立参数完成事件/);
  assert.match(normalizedProviderToolsCnDoc, /`custom_tool_call`.*`response\.custom_tool_call_input\.\*`/);
  assert.match(normalizedProviderToolsCnDoc, /以 `custom_tool_call_output` 错误回给 provider/);
  assert.match(normalizedProviderToolsCnDoc, /reasoning_summary_text\.\*.*reasoning_summary_part\.done.*reasoning `summary\[\]`/);
  assert.match(normalizedProviderToolsCnDoc, /原始 `response\.reasoning_text\.\*` 和 `reasoning_text` content 不会作为 text 或 thinking 透出/);
  assert.match(normalizedProviderToolsCnDoc, /`error`、`response\.failed`、`response\.incomplete`.*`stopReason:"error"`/);
  assert.match(normalizedProviderToolsCnDoc, /原生 Responses input\/output item 只在下一次调用仍是 Responses 时保留/);
  assert.match(normalizedProviderToolsCnDoc, /不会转发原始 `reasoning_text` \/ `encrypted_content`/);
  assert.match(normalizedProviderToolsCnDoc, /原生 Anthropic `thinking` \/ `redacted_thinking` block 只在下一次调用仍是 Anthropic 时保留/);
  assert.match(normalizedProviderToolsCnDoc, /不会转发 `redacted_thinking\.data` 和 thinking signature/);
  assert.match(normalizedProviderToolsCnDoc, /provider 私有 history item 不会作为归一化 UI 事件暴露/);
  assert.match(normalizedProviderToolsCnDoc, /同一轮里的原生 Responses item 会插回下一次 Responses `input`/);
  assert.match(normalizedProviderToolsCnDoc, /能作为后续 input 的原生 Responses output item 会作为同 provider 工具循环的 provider 私有 history 保留/);
  assert.match(normalizedProviderToolsCnDoc, /`file_search_call`.*`web_search_call`.*`tool_search_output`.*`function_call_output`/);
  assert.match(normalizedProviderToolsCnDoc, /Anthropic `thinking` \/ `redacted_thinking` block 会插回下一次 Anthropic assistant message/);
  assert.match(normalizedProviderToolsDoc, /hook runtime returns local AwaitShell error without readArgs bridge when ids are missing/);
  assert.match(normalizedProviderToolsCnDoc, /hook runtime returns local AwaitShell error without readArgs bridge when ids are missing/);
  assert.doesNotMatch(normalizedProviderToolsDoc, /hook runtime rejects AwaitShell without shell or task id instead of fake local success/);
  assert.doesNotMatch(normalizedProviderToolsCnDoc, /hook runtime rejects AwaitShell without shell or task id instead of fake local success/);
});

test("architecture docs describe adapter-owned tool paths and provider formatting", () => {
  for (const doc of [normalizedArchitectureDoc, normalizedArchitectureCnDoc]) {
    assert.match(doc, /direct (?:`)?Read(?:`)? \/ (?:`)?ReadFile(?:`)?/);
    assert.match(doc, /read-then-write (?:edit )?bridge/);
    assert.match(doc, /interaction-query bridge/);
    assert.match(doc, /client-tool completion/);
    assert.match(doc, /provider-visible text|provider 可见文本/);
    assert.doesNotMatch(doc, /built-in tool implementations are not replaced.*tools run natively/);
    assert.doesNotMatch(doc, /工具在 Cursor 中原生执行/);
    assert.doesNotMatch(doc, /Tool results are not reformatted into custom text/);
    assert.doesNotMatch(doc, /不把工具结果重排成自定义文本/);
  }
});

test("provider tool docs list every specialized provider result formatter", () => {
  const formatterCases = new Set();
  for (const match of providerAdapterSource.matchAll(/result\?\.message\?\.case === "([^"]+)"/g)) {
    formatterCases.add(match[1]);
  }
  assert.ok(formatterCases.size > 0, "expected provider result formatter cases");
  for (const resultCase of formatterCases) {
    assert.match(normalizedProviderToolsDoc, new RegExp(`\`${escapeRegExp(resultCase)}\``), `${resultCase} missing from provider-tools.md`);
    assert.match(normalizedProviderToolsCnDoc, new RegExp(`\`${escapeRegExp(resultCase)}\``), `${resultCase} missing from provider-tools_CN.md`);
  }
});

test("cursor tool spec table matches hook UI, native exec, and server result cases", () => {
  const rows = parseCursorToolSpecRows(cursorToolSpecDoc);
  const helpers = createHookRuntimeHelpersForTest();
  const defaultPrompt = buildPrompt({
    conversationId: "conv-tool-spec-parity",
    systemPrompt: "system",
    messages: [{ role: "user", content: "use tools" }],
  });
  const defaultToolNames = defaultPrompt.tools.map((tool) => tool.name || tool.canonicalName);
  const tools = [
    "Shell",
    "Glob",
    "Grep",
    "LS",
    "AwaitShell",
    "Read",
    "ReadFile",
    "Delete",
    "Edit",
    "ApplyPatch",
    "Write",
    "EditNotebook",
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "ReadLints",
    "WebFetch",
    "WebSearch",
    "WriteShellStdin",
    "ListMcpResources",
    "FetchMcpResource",
    "CallMcpTool",
    "AskQuestion",
    "SwitchMode",
    "CreatePlan",
  ];
  const expectedExecCases = new Map([
    ["Shell", "shellStreamArgs"],
    ["Glob", "grepArgs"],
    ["Grep", "grepArgs"],
    ["LS", "lsArgs"],
    ["AwaitShell", "subagentAwaitArgs"],
    ["Read", "readArgs"],
    ["ReadFile", "readArgs"],
    ["Delete", "deleteArgs"],
    ["Write", "writeArgs"],
    ["ReadLints", "diagnosticsArgs"],

    ["WriteShellStdin", "writeShellStdinArgs"],
    ["ListMcpResources", "listMcpResourcesExecArgs"],
    ["FetchMcpResource", "readMcpResourceExecArgs"],
    ["CallMcpTool", "mcpArgs"],
  ]);
  const bridgeOrLocalOnly = new Set([
    "Edit",
    "ApplyPatch",
    "EditNotebook",
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "WebFetch",
    "WebSearch",
    "AskQuestion",
    "SwitchMode",
    "CreatePlan",
  ]);

  assert.deepEqual([...rows.keys()].sort(), tools.sort());
  for (const toolName of tools) {
    const row = rows.get(toolName);
    assert.ok(row, `missing cursor-tool-spec row for ${toolName}`);
    const event = {
      type: "tool_use_done",
      id: `${toolName}-call`,
      name: toolName,
      arguments: cursorToolArgs(toolName),
    };
    const messages = helpers.eventToCursorMessages(event, "spec", 7);
    assert.equal(toolStartedMessageCase(messages), markdownCodeText(row.uiToolCall), `${toolName} UI tool call`);

    const execCase = nativeExecMessageCase(messages);
    if (expectedExecCases.has(toolName)) {
      assert.equal(execCase, expectedExecCases.get(toolName), `${toolName} native exec case`);
      assert.match(row.executionPath, new RegExp(`\\b${escapeRegExp(execCase)}\\b`), `${toolName} spec execution path`);
    } else {
      assert.equal(execCase, undefined, `${toolName} must not emit direct native exec args in this hook path`);
      assert.ok(bridgeOrLocalOnly.has(toolName), `${toolName} needs an explicit bridge/local classification`);
      assert.doesNotMatch(row.executionPath, /\bNative `[^`]+Args`/, `${toolName} spec must not claim a direct native args path`);
    }

    if (toolName === "ReadFile") {
      assert.equal(defaultToolNames.includes(toolName), false, "ReadFile remains explicit legacy alias only");
      assert.match(row.executionPath, /Legacy alias of `Read`/);
    } else if (toolName.startsWith("Task")) {
      assert.equal(defaultToolNames.includes(toolName), false, `${toolName} remains explicit-only`);
      assert.equal(CURSOR_BUILTIN_TOOLS.some((tool) => tool.name === toolName), false, `${toolName} is a hook/provider alias, not a catalog entry`);
      assert.match(row.executionPath, /hook\/provider-recognized todo alias/);
      assert.match(row.executionPath, /not subagent launch tools/);
    } else if (toolName === "WebSearch") {
      assert.equal(defaultToolNames.includes(toolName), false, `${toolName} remains explicit-only`);
      assert.equal(CURSOR_BUILTIN_TOOLS.some((tool) => tool.name === toolName), true, `${toolName} is an internal catalog entry`);
    } else {
      assert.equal(defaultToolNames.includes(toolName), true, `${toolName} remains in the default provider catalog`);
    }

    if (toolName === "AskQuestion" || toolName === "SwitchMode" || toolName === "CreatePlan") {
      assert.equal(row.resultCase, "`byokInteractionToolResult`", `${toolName} provider result case`);
    } else if (toolName === "WebSearch") {
      assert.match(row.resultCase, /webSearchToolCall\.result/, `${toolName} provider result case`);
    } else {
      const resultCase = resultCaseForToolName(toolName);
      assert.match(row.resultCase, new RegExp(`\\b${escapeRegExp(resultCase)}\\b`), `${toolName} server result case`);
    }
  }
});

test("documentation test references resolve to real node test names", () => {
  const testNames = [];
  for (const filePath of listFilesRecursive(path.join(root, "tests"))) {
    if (!filePath.endsWith(".test.js")) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/\btest\(\s*"((?:\\.|[^"\\])*)"/g)) {
      testNames.push(normalizedTestName(match[1]));
    }
    for (const match of source.matchAll(/\btest\(\s*'((?:\\.|[^'\\])*)'/g)) {
      testNames.push(normalizedTestName(match[1]));
    }
    for (const match of source.matchAll(/\btest\(\s*`((?:\\.|[^`\\])*)`/g)) {
      testNames.push(normalizedTestName(match[1]));
    }
  }

  const unresolved = [];
  for (const filePath of listFilesRecursive(path.join(root, "docs"))) {
    if (!filePath.endsWith(".md")) continue;
    const relativePath = path.relative(root, filePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/\*"([\s\S]*?)"\*/g)) {
      const reference = normalizedTestName(match[1]);
      if (!reference || reference.includes("…")) continue;
      if (testNames.includes(reference)) continue;
      if (testNames.some((name) => name.includes(reference))) continue;
      unresolved.push(`${relativePath}: ${reference}`);
    }
  }

  assert.deepEqual(unresolved, []);
});

test("provider prompt preserves explicit Cursor tool schemas instead of appending defaults", () => {
  const explicit = [{ name: "Read", description: "explicit", inputSchema: { type: "object", properties: {} } }];
  const prompt = buildPrompt({
    conversationId: "conv-explicit-tools",
    messages: [{ role: "user", content: "read" }],
    tools: explicit,
  });

  assert.equal(prompt.tools, explicit);
});

test("provider prompt preserves explicit client-bridge Cursor tool schemas", () => {
  const explicit = [{
    name: "WebSearch",
    description: "explicit web search",
    inputSchema: { type: "object", properties: { search_term: { type: "string" } }, required: ["search_term"] },
  }];
  const prompt = buildPrompt({
    conversationId: "conv-explicit-client-bridge-tool",
    messages: [{ role: "user", content: "search" }],
    tools: explicit,
  });

  assert.equal(prompt.tools, explicit);
});

test("provider tool normalization does not expose filtered tools in BYOK mode", () => {
  const tools = normalizeTools([
    null,
    {
      name: "Task",
      description: "launch subagent",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    },
    undefined,
    {
      name: "Subagent",
      description: "launch subagent alias",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    },
    {
      name: "launch_alias",
      canonicalName: "Task",
      description: "launch subagent through alias",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    },
    {
      name: "RecordScreen",
      description: "record screen",
      inputSchema: { type: "object", properties: { duration_ms: { type: "integer" } } },
    },
    {
      name: "ComputerUse",
      description: "computer use",
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    },
    {
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ], "openai-chat");

  assert.deepEqual(tools.map((tool) => tool.name), ["Read"]);
});

test("provider tool normalization uses canonical built-in names for dispatch", () => {
  const tools = normalizeTools([
    {
      name: "read_alias",
      canonicalName: "Read",
      description: "read alias",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
    },
    {
      name: "grep_alias",
      canonicalName: "Grep",
      description: "grep alias",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  ], "openai-chat");

  assert.deepEqual(tools.map((tool) => tool.name), ["Read", "Grep"]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ["path", "offset", "limit"]);
});

test("provider tool normalization patches explicit Cursor Read schemas before provider calls", () => {
  const tools = normalizeTools([
    {
      name: "Read",
      description: "legacy cursor schema",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          path: { type: "string" },
        },
        required: ["filePath"],
        additionalProperties: true,
      },
    },
    {
      name: "ReadFile",
      description: "legacy read file schema",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          path: { type: "string" },
        },
        required: ["file_path"],
      },
    },
  ], "anthropic");

  assert.deepEqual(tools.map((tool) => tool.name), ["Read", "ReadFile"]);
  for (const tool of tools) {
    assert.match(tool.description, /only valid Read input keys are path, offset, and limit/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["path"]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ["path", "offset", "limit"]);
    assert.equal(tool.inputSchema.properties.offset.type, "integer");
    assert.equal(tool.inputSchema.properties.limit.type, "integer");
  }
});

test("provider tool normalization patches explicit Cursor CreatePlan schemas before provider calls", () => {
  const [tool] = normalizeTools([{
    name: "CreatePlan",
    description: "old plan schema",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        overview: { type: "string" },
        plan: { type: "string" },
      },
      additionalProperties: false,
    },
  }], "openai-chat");

  assert.equal(tool.description.includes("complete Cursor plan artifact"), true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["name", "overview", "plan", "todos", "isProject", "phases"]);
  assert.equal(tool.validationSchema.properties.todos.items.properties.status.type, "string");
  assert.equal(tool.validationSchema.properties.todos.items.properties.dependencies.type, "array");
  assert.equal(tool.validationSchema.properties.phases.items.properties.todos.items.properties.dependencies.type, "array");
});

test("provider tool normalization keeps CallMcpTool args as a free object", () => {
  const [tool] = normalizeTools([{
    name: "CallMcpTool",
    description: "call mcp",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object" },
        providerIdentifier: { type: "string" },
        toolName: { type: "string" },
      },
      required: ["name", "args", "providerIdentifier", "toolName"],
    },
  }]);

  assert.equal(tool.inputSchema.properties.args.additionalProperties, true);
  assert.equal(tool.validationSchema.properties.args.additionalProperties, true);
  assert.equal(patchProviderToolSchema({
    name: "CallMcpTool",
    inputSchema: { type: "object", properties: { args: { type: "object" } } },
  }).inputSchema.properties.args.additionalProperties, true);
});

test("provider tool normalization strips provider-facing schema descriptions but keeps real description fields", () => {
  const [tool] = normalizeTools([{
    name: "DescribeFile",
    description: "describe a file",
    inputSchema: {
      type: "object",
      description: "top-level schema description",
      properties: {
        description: {
          type: "string",
          description: "actual user-supplied description field",
        },
        payload: {
          type: "object",
          description: "nested schema description",
          properties: {
            note: {
              type: "string",
              description: "nested property description",
            },
          },
        },
      },
    },
  }], "openai-chat");

  assert.equal(tool.description, "describe a file");
  assert.equal(tool.inputSchema.description, undefined);
  assert.equal(tool.inputSchema.properties.description.type, "string");
  assert.equal(tool.inputSchema.properties.description.description, undefined);
  assert.equal(tool.inputSchema.properties.payload.description, undefined);
  assert.equal(tool.inputSchema.properties.payload.properties.note.description, undefined);
  assert.equal(tool.validationSchema.properties.description.description, "actual user-supplied description field");
  assert.equal(tool.validationSchema.properties.payload.description, "nested schema description");
  assert.equal(tool.validationSchema.properties.payload.properties.note.description, "nested property description");
});

test("provider request builders reuse normalized tool metadata without per-call recoercion", () => {
  assert.equal(providerAdapterSource.includes("coerceProviderToolSchema(tool.inputSchema)"), false);
  assert.equal(providerAdapterSource.includes("sanitizeProviderVisiblePromptText(tool.description"), false);
});

test("provider-visible Grep result formats Cursor content matches as model-visible text", () => {
  const result = {
    message: {
      case: "grepResult",
      value: {
        result: {
          case: "success",
          value: {
            pattern: "alpha",
            outputMode: "content",
            workspaceResults: {
              "/tmp/project": {
                result: {
                  case: "content",
                  value: {
                    matches: [{
                      file: "src/a.js",
                      matches: [
                        { lineNumber: 12, content: "const alpha = 1;" },
                        { lineNumber: 13, content: "console.log(alpha);" },
                      ],
                    }],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  assert.equal(
    stringifyToolResultForProvider(result),
    "[/tmp/project] src/a.js:12 const alpha = 1;\n[/tmp/project] src/a.js:13 console.log(alpha);",
  );
});

test("provider-visible Grep result adds definition and callsite summary for exact symbol hits", () => {
  const result = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "evictLevel0ExternalPodsForHighPriority",
        outputMode: "content",
        workspaceResults: {
          "/tmp/project": {
            result: {
              case: "content",
              value: {
                matches: [{
                  file: "controllers/batchtask_controller.go",
                  matches: [
                    { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                    { lineNumber: 2861, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict non-batch-inference" },
                    { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                  ],
                }],
              },
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(result),
    "[/tmp/project] controllers/batchtask_controller.go summary: resolved path /tmp/project/controllers/batchtask_controller.go; definition at line 2867; callsite at line 317; next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: Read path=/tmp/project/controllers/batchtask_controller.go offset=305 limit=33; helper window: Read path=/tmp/project/controllers/batchtask_controller.go offset=2861 limit=177; comment preview line 2861: evictLevel0ExternalPodsForHighPriority attempts to evict non-batch-inference; answer path: caller reaction in lines 305-337; helper behavior in lines 2861-3037; Do not request a same-file helper Read only to restate the helper's purpose from this comment preview.; Do not request only the caller-reaction window; request the helper-behavior window too.; Do not shorten the helper Read; it should run through line 3037.; suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads\n" +
      "[/tmp/project] controllers/batchtask_controller.go:317 if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n" +
      "[/tmp/project] controllers/batchtask_controller.go:2861 // evictLevel0ExternalPodsForHighPriority attempts to evict non-batch-inference\n" +
      "[/tmp/project] controllers/batchtask_controller.go:2867 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(",
  );
});

test("provider-visible Grep result includes enclosing function name for callsites when the file is readable", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-grep-summary-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  const result = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "evictLevel0ExternalPodsForHighPriority",
        outputMode: "content",
        workspaceResults: {
          [tempDir]: {
            result: {
              case: "content",
              value: {
                matches: [{
                  file: "batchtask_controller.go",
                  matches: [
                    { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                    { lineNumber: 10, content: "// evictLevel0ExternalPodsForHighPriority attempts to evict pods" },
                    { lineNumber: 11, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {" },
                  ],
                }],
              },
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(result),
    `[${tempDir}] batchtask_controller.go summary: resolved path ${filePath}; definition at line 11; callsite at line 4 inside Reconcile (line 3); next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: Read path=${filePath} offset=3 limit=6; helper window: Read path=${filePath} offset=10 limit=4; callsite block at lines 3-8; callsite outcomes: evictLevel0ExternalPodsForHighPriority evictErr != nil(line 4-6); comment preview line 10: evictLevel0ExternalPodsForHighPriority attempts to evict pods; answer path: caller reaction in lines 3-8; helper behavior in lines 10-13; Do not request a same-file helper Read only to restate the helper's purpose from this comment preview.; Do not request only the caller-reaction window; request the helper-behavior window too.; Do not shorten the helper Read; it should run through line 13.; suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads\n` +
      `[${tempDir}] batchtask_controller.go:4   if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n` +
      `[${tempDir}] batchtask_controller.go:10 // evictLevel0ExternalPodsForHighPriority attempts to evict pods\n` +
      `[${tempDir}] batchtask_controller.go:11 func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Grep result supplements missing helper definition lines from a readable file", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-grep-summary-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "    return evictErr",
    "  }",
    "  return nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority attempts to evict pods",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "  return nil",
    "}",
    "",
  ].join("\n"));
  const result = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "evictLevel0ExternalPodsForHighPriority",
        outputMode: "content",
        workspaceResults: {
          [tempDir]: {
            result: {
              case: "content",
              value: {
                matches: [{
                  file: "batchtask_controller.go",
                  matches: [
                    { lineNumber: 4, content: "  if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                  ],
                }],
              },
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(result),
    `[${tempDir}] batchtask_controller.go summary: resolved path ${filePath}; definition at line 11; callsite at line 4 inside Reconcile (line 3); next Reads together (issue these exact windows in one response before any other same-file Read or Grep): caller window: Read path=${filePath} offset=3 limit=6; helper window: Read path=${filePath} offset=10 limit=4; callsite block at lines 3-8; callsite outcomes: evictLevel0ExternalPodsForHighPriority evictErr != nil(line 4-6); comment preview line 10: evictLevel0ExternalPodsForHighPriority attempts to evict pods; answer path: caller reaction in lines 3-8; helper behavior in lines 10-13; Do not request a same-file helper Read only to restate the helper's purpose from this comment preview.; Do not request only the caller-reaction window; request the helper-behavior window too.; Do not shorten the helper Read; it should run through line 13.; suggested Read windows usually suffice for invocation, helper behavior, and caller reaction; request both in one response when needed; avoid same-file outcome/helper Grep before those Reads\n` +
      `[${tempDir}] batchtask_controller.go:4   if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Grep result prefers non-test definition files before test-only callsites", () => {
  const result = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "evictLevel0ExternalPodsForHighPriority",
        outputMode: "content",
        workspaceResults: {
          "/tmp/project": {
            result: {
              case: "content",
              value: {
                matches: [
                  {
                    file: "controllers/eviction_test.go",
                    matches: [
                      { lineNumber: 30, content: "reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)" },
                      { lineNumber: 46, content: "reconciler.evictLevel0ExternalPodsForHighPriority(ctx, bt, pressure)" },
                    ],
                  },
                  {
                    file: "controllers/batchtask_controller.go",
                    matches: [
                      { lineNumber: 317, content: "if evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {" },
                      { lineNumber: 2867, content: "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(" },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  const output = stringifyToolResultForProvider(result);
  assert.match(output.split("\n")[0], /controllers\/batchtask_controller\.go summary/);
  assert.match(output, /controllers\/eviction_test\.go summary/);
});

test("provider-visible Grep result formats files and count result arms", () => {
  const files = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "",
        outputMode: "files_with_matches",
        workspaceResults: {
          "/tmp/project": {
            result: {
              case: "files",
              value: { files: ["/tmp/project/a.txt", "/tmp/project/b.txt"], totalFiles: 2 },
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(files),
    "[/tmp/project] /tmp/project/a.txt\n[/tmp/project] /tmp/project/b.txt",
  );

  const count = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "needle",
        outputMode: "count",
        workspaceResults: {
          "/tmp/project": {
            result: {
              case: "count",
              value: { totalMatches: 3, totalFiles: 2 },
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(count),
    "[/tmp/project] total_matches=3 total_files=2",
  );
});

test("provider-visible LS, ReadLints, and WebFetch results preserve useful native output", () => {
  const ls = normalizeExecClientResult({
    lsResult: {
      success: {
        path: "/tmp/project",
        entries: [
          { name: "src", type: "directory", children: [{ name: "index.js", type: "file" }] },
          { name: "package.json", type: "file" },
        ],
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(ls),
    "Directory: /tmp/project\nsrc (directory)\n  index.js (file)\npackage.json (file)",
  );

  const diagnostics = normalizeExecClientResult({
    diagnosticsResult: {
      success: {
        diagnostics: [
          { file: "/tmp/project/src/index.js", line: 12, column: 5, severity: "error", message: "Missing semicolon" },
          { path: "/tmp/project/src/app.js", lineNumber: 7, level: "warning", text: "Unused variable" },
        ],
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(diagnostics),
    [
      "Found 2 linter errors in 2 files:",
      "/tmp/project/src/index.js (1 error):",
      "  [ERROR] L12:5 - Missing semicolon",
      "",
      "/tmp/project/src/app.js (1 error):",
      "  [WARNING] L7:0 - Unused variable",
    ].join("\n"),
  );

  const fetch = normalizeExecClientResult({
    fetchResult: {
      success: {
        url: "https://example.test/docs",
        markdown: "# Docs\nBody text",
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(fetch),
    "# Content from https://example.test/docs\n\n# Docs\nBody text",
  );
});

test("provider-visible LS directory tree renders Cursor's official template", () => {
  const ls = normalizeExecClientResult({
    lsResult: {
      success: {
        directoryTreeRoot: {
          absPath: "/tmp/project",
          childrenWereProcessed: true,
          childrenFiles: [{ name: "package.json" }, { name: "README.md" }],
          childrenDirs: [
            {
              absPath: "/tmp/project/src",
              childrenWereProcessed: true,
              childrenFiles: [{ name: "index.js" }],
              childrenDirs: [],
            },
            {
              absPath: "/tmp/project/node_modules",
              childrenWereProcessed: false,
              childrenFiles: [],
              childrenDirs: [],
              numFiles: 120,
              fullSubtreeExtensionCounts: { js: 80, json: 30, md: 7, ts: 3 },
            },
          ],
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(ls),
    [
      "/tmp/project/",
      "  - node_modules/",
      "    [120 files in subtree: 80 *js, 30 *json, 7 *md, ...]",
      "  - package.json",
      "  - README.md",
      "  - src/",
      "    - index.js",
    ].join("\n"),
  );
});

test("provider-visible ReadLints native diagnostics render Cursor's official template", () => {
  const diagnostics = normalizeExecClientResult({
    diagnosticsResult: {
      success: {
        fileDiagnostics: [
          {
            path: "/tmp/project/src/index.js",
            diagnosticsCount: 2,
            diagnostics: [
              {
                severity: "ERROR",
                message: "Missing semicolon",
                source: "eslint",
                range: { start: { line: 12, column: 5 }, end: { line: 12, column: 6 } },
              },
              {
                severity: "WARNING",
                message: "Unused variable",
                isStale: true,
                range: { start: { line: 7, column: 3 }, end: { line: 7, column: 10 } },
              },
            ],
          },
        ],
        totalFiles: 1,
        totalDiagnostics: 2,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(diagnostics),
    [
      "Found 2 linter errors in 1 file:",
      "/tmp/project/src/index.js (2 errors):",
      "  [ERROR] L12:5 - Missing semicolon (eslint)",
      "  [WARNING] L7:3 - Unused variable, stale",
      "",
      '<system_reminder>Lints marked "stale" were computed on an older version of the file, and may be outdated.</system_reminder>',
    ].join("\n"),
  );

  const unfiltered = normalizeExecClientResult({
    diagnosticsResult: {
      success: {
        path: "/tmp/project/src/index.js",
        diagnostics: [
          { severity: 1, message: "Broken", range: { start: { line: 3, column: 2 } } },
          { severity: 3, message: "Info should be filtered", range: { start: { line: 4, column: 1 } } },
        ],
        totalDiagnostics: 2,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(unfiltered),
    "Found 1 linter error in 1 file:\n/tmp/project/src/index.js (1 error):\n  [ERROR] L3:2 - Broken",
  );

  const clean = normalizeExecClientResult({
    diagnosticsResult: {
      success: {
        fileDiagnostics: [],
        totalDiagnostics: 0,
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(clean), "No linter errors found.");

  const failed = normalizeExecClientResult({
    diagnosticsResult: {
      error: { errorMessage: "Failed to get diagnostics for /tmp/x: Request timed out after 10 seconds" },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(failed),
    "Error: Failed to get diagnostics for /tmp/x: Request timed out after 10 seconds",
  );
});

test("provider-visible Glob result renders Cursor's official file-search template", () => {
  const glob = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "",
        workspaceResults: {
          "/tmp/project": {
            files: {
              files: ["src/index.js", "src/util.js"],
              totalFiles: 2,
              clientTruncated: false,
              ripgrepTruncated: false,
            },
          },
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(glob, "Glob"),
    "Result of search in '.' (total 2 files):\n- src/index.js\n- src/util.js",
  );
  assert.match(stringifyToolResultForProvider(glob), /\[\/tmp\/project\] src\/index\.js/);

  const empty = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "",
        workspaceResults: {
          "/tmp/project": {
            files: { files: [], totalFiles: 0, clientTruncated: false, ripgrepTruncated: false },
          },
        },
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(empty, "Glob"), "Result of search in '.': 0 files found");
});

test("provider-visible MCP results format native Cursor result cases", () => {
  const list = normalizeExecClientResult({
    listMcpResourcesExecResult: {
      success: {
        resources: [
          { server: "docs", uri: "doc://alpha", name: "Alpha" },
          { server: "docs", uri: "doc://beta" },
        ],
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(list),
    "docs doc://alpha - Alpha\ndocs doc://beta",
  );

  const read = normalizeExecClientResult({
    readMcpResourceExecResult: {
      success: {
        uri: "doc://alpha",
        content: { case: "text", value: "alpha body" },
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(read), "alpha body");

  const call = normalizeExecClientResult({
    mcpResult: {
      success: {
        content: [
          { content: { case: "text", value: { text: "first block" } } },
          { content: { case: "image", value: { mimeType: "image/png" } } },
        ],
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(call), "first block\n\n[image image/png]");

  const mcpJson = normalizeExecClientResult({
    mcpResult: {
      success: {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: 102,
            files: [{ key: "README.md", summary: "Project readme" }],
          }, null, 2),
        }],
        structuredContent: {
          result: JSON.stringify({ files: [{ key: "README.md" }] }),
        },
        isError: false,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(mcpJson),
    "{\n  \"total\": 102,\n  \"files\": [\n    {\n      \"key\": \"README.md\",\n      \"summary\": \"Project readme\"\n    }\n  ]\n}",
  );
  assert.deepEqual(mcpJson.message.value.result.value.content, [{
    content: {
      case: "text",
      value: {
        text: "{\n  \"total\": 102,\n  \"files\": [\n    {\n      \"key\": \"README.md\",\n      \"summary\": \"Project readme\"\n    }\n  ]\n}",
      },
    },
  }]);

  const structuredOnly = normalizeExecClientResult({
    mcpResult: {
      success: {
        structuredContent: {
          head: "visible",
          huge: Array.from({ length: 1000 }, (_, index) => `entry-${index}`),
        },
      },
    },
  });
  const structuredText = stringifyToolResultForProvider(structuredOnly);
  assert.match(structuredText, /visible/);
  assert.match(structuredText, /truncated/);
  assert.equal(structuredText.includes("entry-999"), false);

  const missingTool = normalizeExecClientResult({
    mcpResult: {
      toolNotFound: {
        name: "user-filesystem-read_file",
        availableTools: ["user-filesystem-read_file"],
      },
    },
  });
  assert.deepEqual(missingTool.message, {
    case: "mcpResult",
    value: {
      result: {
        case: "error",
        value: { error: "MCP tool not found: user-filesystem-read_file" },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(missingTool),
    "MCP error: MCP tool not found: user-filesystem-read_file",
  );

  assert.equal(
    stringifyToolResultForProvider(normalizeExecClientResult({
      listMcpResourcesExecResult: {
        result: { case: "error", value: { error: "MCP server unavailable" } },
      },
    })),
    "List MCP resources error: MCP server unavailable",
  );
  assert.equal(
    stringifyToolResultForProvider(normalizeExecClientResult({
      readMcpResourceExecResult: {
        result: { case: "error", value: { error: "resource not found" } },
      },
    })),
    "Read MCP resource error: resource not found",
  );
});

test("exec result summary counts Grep workspace result payloads", () => {
  const result = normalizeExecClientResult({
    grepResult: {
      success: {
        pattern: "needle",
        outputMode: "content",
        workspaceResults: {
          "/tmp/project": {
            result: {
              case: "content",
              value: {
                matches: [
                  { file: "a.txt", matches: [{ lineNumber: 1, content: "needle" }] },
                  { file: "b.txt", matches: [{ lineNumber: 2, content: "needle" }] },
                ],
                totalLines: 2,
                totalMatchedLines: 2,
              },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(
    summarizeExecResult(result),
    {
      id: undefined,
      execId: undefined,
      mappedToolCallId: undefined,
      messageCase: "grepResult",
      resultCase: "success",
      shellEventCase: undefined,
      outputCase: undefined,
      stdoutLength: undefined,
      stderrLength: undefined,
      exitCode: undefined,
      contentLength: undefined,
      errorPreview: undefined,
      searchWorkspaceCount: 1,
      searchFileCount: 2,
      searchMatchCount: 2,
    },
  );
});

test("exec result summary counts normalized MCP content blocks", () => {
  const result = normalizeExecClientResult({
    mcpResult: {
      success: {
        content: [
          { content: { case: "text", value: { text: "README.md" } } },
        ],
      },
    },
  });

  assert.deepEqual(
    summarizeExecResult(result),
    {
      id: undefined,
      execId: undefined,
      mappedToolCallId: undefined,
      messageCase: "mcpResult",
      resultCase: "success",
      shellEventCase: undefined,
      outputCase: undefined,
      stdoutLength: undefined,
      stderrLength: undefined,
      exitCode: undefined,
      contentLength: undefined,
      errorPreview: undefined,
      mcpContentBlockCount: 1,
      mcpRawKeys: ["result"],
      mcpRawNestedKeys: { result: ["case", "value"] },
    },
  );
});

test("provider-visible Read result explains blob-only Cursor output instead of sending empty content", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/large.txt",
            output: { case: "contentBlobId", value: "blob-1" },
            totalLines: 5000,
            fileSize: 91549,
            readRange: { startLine: 1, endLine: 5000 },
          },
        },
      },
    },
  };

  const text = stringifyToolResultForProvider(result);
  assert.match(text, /Read result content is stored in a Cursor blob/);
  assert.match(text, /\/tmp\/large\.txt/);
  assert.match(text, /offset and limit/);
  assert.doesNotMatch(text, /"value":""/);
});

test("provider-visible Read result treats Cursor outputBlobId metadata as blob-only content", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/large.txt",
            outputBlobId: "blob-1",
            totalLines: 5000,
            fileSize: 91549,
          },
        },
      },
    },
  };

  const text = stringifyToolResultForProvider(result);
  assert.match(text, /Read result content is stored in a Cursor blob/);
  assert.match(text, /offset and limit/);
});

test("provider-visible Read result sends line-numbered Cursor content as model-visible text", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/a",
            output: { case: "content", value: "alpha\nbeta" },
            totalLines: 2,
            readRange: { startLine: 12 },
          },
        },
      },
    },
  };

  assert.equal(stringifyToolResultForProvider(result), "File: /tmp/a\nLines: 12-13\n    12|alpha\n    13|beta");
});

test("provider-visible Read result exposes Cursor source-code fence coordinates", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/repo/src/batchtask_controller.go",
            output: { case: "content", value: "if bt.Spec.Priority == \"high\" {\n\tcontinue\n}\n" },
            readRange: { startLine: 1626 },
          },
        },
      },
    },
  };

  const text = stringifyToolResultForProvider(result);
  assert.equal(text, "File: /repo/src/batchtask_controller.go\nLines: 1626-1628\n  1626|if bt.Spec.Priority == \"high\" {\n  1627|\tcontinue\n  1628|}\n");
  const prompt = loadByokSystemPrompt();
  assert.match(prompt, /Any reference to code from a file MUST include exact line information/);
  assert.match(prompt, /CODE REFERENCES or MARKDOWN CODE BLOCKS/);
  assert.match(prompt, /METHOD 1: CODE REFERENCES/);
  assert.match(prompt, /Use this exact syntax with three required components/);
  assert.match(prompt, /METHOD 2: MARKDOWN CODE BLOCKS/);
  assert.match(prompt, /startLine:endLine:filepath/);
  assert.match(prompt, /column 1 with no leading spaces/);
  assert.match(prompt, /Never emit the literal placeholder words `startLine`, `endLine`, or `filepath`/);
  assert.match(prompt, /Do not put a source-code fence inside a list item, block quote, or indented container/);
  assert.match(prompt, /\n```12:18:\/absolute\/path\/file\.go\nif bt\.Spec\.Priority == "high" \{/);
  assert.match(prompt, /File:` and `Lines:/);
  assert.match(prompt, /Do not reproduce `File:` \/ `Lines:` as assistant prose when quoting file-backed code/);
  assert.match(prompt, /read or search the file to obtain them before citing it/);
  assert.match(providerToolsDoc, /CODE REFERENCES/);
  assert.match(providerToolsDoc, /must start at column 1 with no leading spaces/);
  assert.match(providerToolsDoc, /must substitute real line numbers and file paths rather than the literal\s+placeholder words/);
  assert.match(providerToolsDoc, /\n```12:18:\/absolute\/path\/file\.go\nif bt\.Spec\.Priority == "high" \{/);
  assert.match(providerToolsCnDoc, /CODE REFERENCES/);
  assert.match(providerToolsCnDoc, /前面不能有空格/);
  assert.match(providerToolsCnDoc, /不能把 `startLine`、`endLine`、`filepath` 这些占位词原样打出来/);
  assert.match(providerToolsCnDoc, /\n```12:18:\/absolute\/path\/file\.go\nif bt\.Spec\.Priority == "high" \{/);
});

test("provider-visible Read result preserves Cursor inline content without BYOK truncation", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/large.txt",
            output: { case: "content", value: `${"x".repeat(13000)}\n` },
            totalLines: 1,
          },
        },
      },
    },
  };

  const text = stringifyToolResultForProvider(result);
  assert.equal(text.includes("\n...[truncated "), false);
  assert.equal(text.includes("x".repeat(13000)), true);
});

test("provider-visible Read result adds helper reference summary for function windows", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/repo/src/batchtask_controller.go",
            output: {
              case: "content",
              value: [
                "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
                "\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {",
                "\t\treturn err",
                "\t}",
                "\treturn r.evictPod(ctx, pod)",
                "}",
                "",
              ].join("\n"),
            },
            readRange: { startLine: 2867, endLine: 2872 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    "File: /repo/src/batchtask_controller.go\nLines: 2867-2872\nPrimary function body in this window: 2867-2872\nHelper refs in this window: findEvictableLevel0Pods(line 2868), evictPod(line 2871)\nReturn refs in this window: err(line 2869), r.evictPod(ctx, pod)(line 2871)\nCallsite blocks in this window: findEvictableLevel0Pods(line 2868-2870)\nOutcome refs in this window: findEvictableLevel0Pods err != nil(line 2868-2870)\nPrimary helper behavior is already visible in this window.\nReuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.\n" +
      "  2867|func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\n" +
      "  2868|\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {\n" +
      "  2869|\t\treturn err\n" +
      "  2870|\t}\n" +
      "  2871|\treturn r.evictPod(ctx, pod)\n" +
      "  2872|}\n",
  );
});

test("provider-visible Read result adds helper definition summary when helpers are in the same file", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-helper-defs-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {",
    "\t\treturn err",
    "\t}",
    "\tpodGPU := podGPURequest(&pod, gpu)",
    "\treturn r.evictPod(ctx, pod)",
    "}",
    "",
    "func (r *BatchTaskReconciler) findEvictableLevel0Pods(ctx context.Context, pressure any) error {",
    "\treturn nil",
    "}",
    "",
    "func podGPURequest(pod any, gpu any) int64 {",
    "\treturn 0",
    "}",
    "",
    "func (r *BatchTaskReconciler) evictPod(ctx context.Context, pod any) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
                "\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {",
                "\t\treturn err",
                "\t}",
                "\tpodGPU := podGPURequest(&pod, gpu)",
                "\treturn r.evictPod(ctx, pod)",
                "}",
                "",
              ].join("\n"),
            },
            readRange: { startLine: 1, endLine: 7 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 1-7\nPrimary function body in this window: 1-7\nHelper refs in this window: findEvictableLevel0Pods(line 2), podGPURequest(line 5), evictPod(line 6)\nHelper defs in this file: findEvictableLevel0Pods(line 9), podGPURequest(line 13), evictPod(line 17)\nReturn refs in this window: err(line 3), r.evictPod(ctx, pod)(line 6)\nCallsite blocks in this window: findEvictableLevel0Pods(line 2-4)\nOutcome refs in this window: findEvictableLevel0Pods err != nil(line 2-4)\nPrimary helper behavior is already visible in this window.\nReuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.\n` +
      "     1|func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\n" +
      "     2|\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {\n" +
      "     3|\t\treturn err\n" +
      "     4|\t}\n" +
      "     5|\tpodGPU := podGPURequest(&pod, gpu)\n" +
      "     6|\treturn r.evictPod(ctx, pod)\n" +
      "     7|}\n",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result adds same-file helper comment previews for function windows", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-helper-comment-preview-fn-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {",
    "\t\treturn err",
    "\t}",
    "\tpodGPU := podGPURequest(&pod, gpu)",
    "\treturn r.evictPod(ctx, pod)",
    "}",
    "",
    "// findEvictableLevel0Pods picks candidate pods from level-0 namespaces.",
    "// Protected pods are skipped.",
    "func (r *BatchTaskReconciler) findEvictableLevel0Pods(ctx context.Context, pressure any) error {",
    "\treturn nil",
    "}",
    "",
    "func podGPURequest(pod any, gpu any) int64 {",
    "\treturn 0",
    "}",
    "",
    "// evictPod uses the Kubernetes eviction API.",
    "// Pod disruption budgets still apply.",
    "func (r *BatchTaskReconciler) evictPod(ctx context.Context, pod any) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
                "\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {",
                "\t\treturn err",
                "\t}",
                "\tpodGPU := podGPURequest(&pod, gpu)",
                "\treturn r.evictPod(ctx, pod)",
                "}",
                "",
              ].join("\n"),
            },
            readRange: { startLine: 1, endLine: 7 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 1-7\nPrimary function body in this window: 1-7\nHelper refs in this window: findEvictableLevel0Pods(line 2), podGPURequest(line 5), evictPod(line 6)\nHelper defs in this file: findEvictableLevel0Pods(line 11), podGPURequest(line 15), evictPod(line 21)\nSame-file helper comments: findEvictableLevel0Pods(lines 9-10) findEvictableLevel0Pods picks candidate pods from level-0 namespaces. Protected pods are skipped.; evictPod(lines 19-20) evictPod uses the Kubernetes eviction API. Pod disruption budgets still apply.\nHigh-level helper purpose is already visible from these same-file helper comments. Do not request same-file helper Reads only because those helper names appear in Helper defs in this file; only request helper bodies if you still need internal branch details.\nReturn refs in this window: err(line 3), r.evictPod(ctx, pod)(line 6)\nCallsite blocks in this window: findEvictableLevel0Pods(line 2-4)\nOutcome refs in this window: findEvictableLevel0Pods err != nil(line 2-4)\nPrimary helper behavior is already visible in this window.\nReuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.\n` +
      "     1|func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\n" +
      "     2|\tif _, err := r.findEvictableLevel0Pods(ctx, pressure); err != nil {\n" +
      "     3|\t\treturn err\n" +
      "     4|\t}\n" +
      "     5|\tpodGPU := podGPURequest(&pod, gpu)\n" +
      "     6|\treturn r.evictPod(ctx, pod)\n" +
      "     7|}\n",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result adds same-file top-level symbol previews for function windows", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-top-level-symbol-preview-"));
  const filePath = path.join(tempDir, "metrics.go");
  fs.writeFileSync(filePath, [
    "package controllers",
    "",
    "import \"github.com/prometheus/client_golang/prometheus\"",
    "",
    "var (",
    "\t// Eviction metrics for level-0 external pod eviction",
    "\tevictedLevel0GPU = prometheus.NewGauge(",
    "\t\tprometheus.GaugeOpts{",
    "\t\t\tName: \"level0_gpu_released\",",
    "\t\t\tHelp: \"Total GPU released by evicting level-0 external pods for high-priority tasks\",",
    "\t\t},",
    "\t)",
    ")",
    "",
    "// UpdateEvictedLevel0GPUMetric records GPU released by level-0 pod eviction",
    "func UpdateEvictedLevel0GPUMetric(gpu int64) {",
    "\tevictedLevel0GPU.Set(float64(gpu))",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "// UpdateEvictedLevel0GPUMetric records GPU released by level-0 pod eviction",
                "func UpdateEvictedLevel0GPUMetric(gpu int64) {",
                "\tevictedLevel0GPU.Set(float64(gpu))",
                "}",
              ].join("\n"),
            },
            readRange: { startLine: 15, endLine: 18 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 15-18\nPrimary function body in this window: 16-18\nHelper refs in this window: float64(line 17)\nSame-file symbol previews: evictedLevel0GPU(line 7) NewGauge name=level0_gpu_released help=Total GPU released by evicting level-0 external pods for high-priority tasks\nHigh-level same-file symbol meaning is already visible from these previews. Do not Grep the same file for those symbol names unless you still need exact declaration details.\n    15|// UpdateEvictedLevel0GPUMetric records GPU released by level-0 pod eviction\n    16|func UpdateEvictedLevel0GPUMetric(gpu int64) {\n    17|\tevictedLevel0GPU.Set(float64(gpu))\n    18|}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result adds branch reference summary for callsite windows", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-local-refs-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "\tpressure, err := r.cohortPressure(ctx)",
    "\tif err != nil {",
    "\t\treturn err",
    "\t}",
    "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "\t\tctrl.LoggerFrom(ctx).Error(evictErr, \"failed to evict level-0 pods for high-priority task\")",
    "\t} else if evictedGPU > 0 {",
    "\t\tpressure, err = r.cohortPressure(ctx)",
    "\t}",
    "",
    "\tif pressure.gateBlocked && (bt.Spec.Priority != \"high\" || pressure.blockHigh) {",
    "\t\treturn ctrl.Result{RequeueAfter: 30 * time.Second}, nil",
    "\t}",
    "}",
    "",
    "func (r *BatchTaskReconciler) cohortPressure(ctx context.Context) (cohortPressureResult, error) {",
    "\treturn cohortPressureResult{}, nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "\tpressure, err := r.cohortPressure(ctx)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
                "\t\tctrl.LoggerFrom(ctx).Error(evictErr, \"failed to evict level-0 pods for high-priority task\")",
                "\t} else if evictedGPU > 0 {",
                "\t\tpressure, err = r.cohortPressure(ctx)",
                "\t}",
                "",
                "\tif pressure.gateBlocked && (bt.Spec.Priority != \"high\" || pressure.blockHigh) {",
                "\t\treturn ctrl.Result{RequeueAfter: 30 * time.Second}, nil",
                "\t}",
              ].join("\n"),
            },
            readRange: { startLine: 2, endLine: 13 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 2-13\nReturn refs in this window: err(line 4), ctrl.Result{RequeueAfter: 30 * time.Second}, nil(line 13)\nCallsite blocks in this window: cohortPressure(line 2-5), evictLevel0ExternalPodsForHighPriority(line 6-10)\nOutcome refs in this window: err != nil(line 3-5), evictLevel0ExternalPodsForHighPriority evictErr != nil(line 6-7), evictedGPU > 0(line 8-10)\nBranch refs in this window: err != nil(line 3), evictErr != nil(line 6), evictedGPU > 0(line 8), pressure.gateBlocked && (bt.Spec.Priority != "high" || pressure.blockHigh)(line 12)\nLocal refs in this window: pressure <- cohortPressure(line 2; def line 17), evictedGPU <- evictLevel0ExternalPodsForHighPriority(line 6)\nIf you need cohortPressure behavior, the only next same-file Read should be: path=${filePath} offset=11 limit=9; do not request smaller later-offset Reads first.\nCaller reaction is already visible in this window.\nReuse this same Read directly for caller reaction; do not request another same-file caller Read for citation.\n` +
      "     2|\tpressure, err := r.cohortPressure(ctx)\n" +
      "     3|\tif err != nil {\n" +
      "     4|\t\treturn err\n" +
      "     5|\t}\n" +
      "     6|\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n" +
      "     7|\t\tctrl.LoggerFrom(ctx).Error(evictErr, \"failed to evict level-0 pods for high-priority task\")\n" +
      "     8|\t} else if evictedGPU > 0 {\n" +
      "     9|\t\tpressure, err = r.cohortPressure(ctx)\n" +
      "    10|\t}\n" +
      "    11|\n" +
      "    12|\tif pressure.gateBlocked && (bt.Spec.Priority != \"high\" || pressure.blockHigh) {\n" +
      "    13|\t\treturn ctrl.Result{RequeueAfter: 30 * time.Second}, nil\n" +
      "    14|\t}",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result suggests one full helper Read from a callsite window", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-followup-helper-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "\tpressure, err := r.cohortPressure(ctx)",
    "\tif err != nil {",
    "\t\treturn err",
    "\t}",
    "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "\t\treturn evictErr",
    "\t} else if evictedGPU > 0 {",
    "\t\treturn nil",
    "\t}",
    "\treturn nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) cohortPressure(ctx context.Context) error {",
    "\treturn nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context, bt any, pressure any) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "\tpressure, err := r.cohortPressure(ctx)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
                "\t\treturn evictErr",
                "\t} else if evictedGPU > 0 {",
                "\t\treturn nil",
                "\t}",
              ].join("\n"),
            },
            readRange: { startLine: 2, endLine: 10 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 2-10\nReturn refs in this window: err(line 4), evictErr(line 7), nil(line 9)\nCallsite blocks in this window: cohortPressure(line 2-5), evictLevel0ExternalPodsForHighPriority(line 6-10)\nOutcome refs in this window: err != nil(line 3-5), evictLevel0ExternalPodsForHighPriority evictErr != nil(line 6-7), evictedGPU > 0(line 8-10)\nBranch refs in this window: err != nil(line 3), evictErr != nil(line 6), evictedGPU > 0(line 8)\nLocal refs in this window: pressure <- cohortPressure(line 2; def line 14), evictedGPU <- evictLevel0ExternalPodsForHighPriority(line 6; def line 18)\nIf you need evictLevel0ExternalPodsForHighPriority behavior, the only next same-file Read should be: path=${filePath} offset=12 limit=9; do not request smaller later-offset Reads first.\nCaller reaction is already visible in this window.\nReuse this same Read directly for caller reaction; do not request another same-file caller Read for citation.\n` +
      "     2|\tpressure, err := r.cohortPressure(ctx)\n" +
      "     3|\tif err != nil {\n" +
      "     4|\t\treturn err\n" +
      "     5|\t}\n" +
      "     6|\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n" +
      "     7|\t\treturn evictErr\n" +
      "     8|\t} else if evictedGPU > 0 {\n" +
      "     9|\t\treturn nil\n" +
      "    10|\t}",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result adds same-file helper comment preview for callsite windows", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-helper-comment-preview-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "func (r *BatchTaskReconciler) Reconcile(ctx context.Context) error {",
    "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
    "\t\treturn evictErr",
    "\t}",
    "\treturn nil",
    "}",
    "",
    "// evictLevel0ExternalPodsForHighPriority evicts external level-0 pods",
    "// to free GPU for high-priority admission.",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context, bt any, pressure any) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {",
                "\t\treturn evictErr",
                "\t}",
                "\treturn nil",
              ].join("\n"),
            },
            readRange: { startLine: 2, endLine: 5 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 2-5\nReturn refs in this window: evictErr(line 3), nil(line 5)\nCallsite blocks in this window: evictLevel0ExternalPodsForHighPriority(line 2-4)\nOutcome refs in this window: evictLevel0ExternalPodsForHighPriority evictErr != nil(line 2-4)\nLocal refs in this window: evictedGPU <- evictLevel0ExternalPodsForHighPriority(line 2; def line 10)\nSame-file helper comment: evictLevel0ExternalPodsForHighPriority(lines 8-9) evictLevel0ExternalPodsForHighPriority evicts external level-0 pods to free GPU for high-priority admission.\nHigh-level helper purpose is already visible from the same-file helper comment. Only request the helper body if you still need internal branch details.\nIf you need evictLevel0ExternalPodsForHighPriority behavior, the only next same-file Read should be: path=${filePath} offset=8 limit=5; do not request smaller later-offset Reads first.\nCaller reaction is already visible in this window.\nReuse this same Read directly for caller reaction; do not request another same-file caller Read for citation.\n` +
      "     2|\tif evictedGPU, evictErr := r.evictLevel0ExternalPodsForHighPriority(ctx, &bt, pressure); evictErr != nil {\n" +
      "     3|\t\treturn evictErr\n" +
      "     4|\t}\n" +
      "     5|\treturn nil",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result keeps helper summaries when comments precede a function definition", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-commented-function-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "// helper summary should still work when comments lead the window",
    "// and the function starts later",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "\tvalue, err := r.first(ctx)",
    "\tif err != nil {",
    "\t\treturn err",
    "\t}",
    "\treturn r.second(ctx, value)",
    "}",
    "",
    "func (r *BatchTaskReconciler) first(ctx context.Context) (int, error) {",
    "\treturn 0, nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) second(ctx context.Context, value int) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "// helper summary should still work when comments lead the window",
                "// and the function starts later",
                "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
                "\tvalue, err := r.first(ctx)",
                "\tif err != nil {",
                "\t\treturn err",
                "\t}",
                "\treturn r.second(ctx, value)",
                "}",
                "",
              ].join("\n"),
            },
            readRange: { startLine: 1, endLine: 9 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 1-9\nPrimary function body in this window: 3-9\nHelper refs in this window: first(line 4), second(line 8)\nHelper defs in this file: first(line 11), second(line 15)\nReturn refs in this window: err(line 6), r.second(ctx, value)(line 8)\nCallsite blocks in this window: first(line 4-7)\nOutcome refs in this window: err != nil(line 5-7)\nLocal refs in this window: value <- first(line 4; def line 11)\nPrimary helper behavior is already visible in this window.\nReuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.\n` +
      "     1|// helper summary should still work when comments lead the window\n" +
      "     2|// and the function starts later\n" +
      "     3|func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\n" +
      "     4|\tvalue, err := r.first(ctx)\n" +
      "     5|\tif err != nil {\n" +
      "     6|\t\treturn err\n" +
      "     7|\t}\n" +
      "     8|\treturn r.second(ctx, value)\n" +
      "     9|}\n",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result marks partial function windows and recommends extending from the same start", () => {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-read-partial-function-"));
  const filePath = path.join(tempDir, "batchtask_controller.go");
  fs.writeFileSync(filePath, [
    "// lead comment",
    "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
    "\tif err := r.first(ctx); err != nil {",
    "\t\treturn err",
    "\t}",
    "\tif err := r.second(ctx); err != nil {",
    "\t\treturn err",
    "\t}",
    "\treturn r.third(ctx)",
    "}",
    "",
    "func (r *BatchTaskReconciler) first(ctx context.Context) error {",
    "\treturn nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) second(ctx context.Context) error {",
    "\treturn nil",
    "}",
    "",
    "func (r *BatchTaskReconciler) third(ctx context.Context) error {",
    "\treturn nil",
    "}",
    "",
  ].join("\n"));
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: filePath,
            output: {
              case: "content",
              value: [
                "// lead comment",
                "func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {",
                "\tif err := r.first(ctx); err != nil {",
                "\t\treturn err",
                "\t}",
              ].join("\n"),
            },
            readRange: { startLine: 1, endLine: 5 },
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    `File: ${filePath}\nLines: 1-5\nPrimary function body in this window: 2-5 (function continues through line 10 in file)\nIf you need the remainder, next Read: path=${filePath} offset=1 limit=10; do not request a later-offset tail Read.\nLater same-file helper refs: second(line 6), third(line 9)\nLater same-file returns: err(line 7), r.third(ctx)(line 9)\nLater same-file effects: if err := r.second(ctx); err != nil {(line 6)\nHelper refs in this window: first(line 3)\nHelper defs in this file: first(line 12)\nReturn refs in this window: err(line 4)\nCallsite blocks in this window: first(line 3-5)\nOutcome refs in this window: first err != nil(line 3-5)\nLocal refs in this window: err <- first(line 3; def line 12)\nPrimary helper behavior is already visible in this window.\nReuse this same Read directly for helper behavior; do not request another same-file helper Read for citation.\n` +
      "     1|// lead comment\n" +
      "     2|func (r *BatchTaskReconciler) evictLevel0ExternalPodsForHighPriority(ctx context.Context) error {\n" +
      "     3|\tif err := r.first(ctx); err != nil {\n" +
      "     4|\t\treturn err\n" +
      "     5|\t}",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-visible Read result uses official oversize guidance when Cursor reports exceededLimit", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/huge.txt",
            exceededLimit: true,
            fileSize: 250000,
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    "File content (250000 characters) exceeds maximum allowed characters (100000 characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.",
  );
});

test("provider-visible Read result explains provider-visible overflow after Cursor line formatting", () => {
  const result = {
    message: {
      case: "readResult",
      value: {
        result: {
          case: "success",
          value: {
            path: "/tmp/many-short-lines.txt",
            exceededLimit: true,
            exceededLimitReason: "provider_visible_chars",
            providerVisibleChars: 112544,
            fileSize: 25000,
          },
        },
      },
    },
  };

  assert.equal(
    stringifyToolResultForProvider(result),
    "Read result expands to 112544 characters after Cursor line formatting, which exceeds maximum allowed characters (100000 characters).\nPlease retry Read with a smaller offset and limit window, or use the 'grep' tool to search for specific content.",
  );
});

test("provider-visible Shell background result surfaces shell id for AwaitShell follow-up", () => {
  const result = {
    message: {
      case: "shellResult",
      value: {
        result: {
          case: "success",
          value: {
            shellId: "shell-42",
            backgroundReason: "Shell command is still running in the background.",
            msToWait: 1500,
          },
        },
      },
    },
  };

  const text = stringifyToolResultForProvider(result);
  assert.equal(
    text,
    [
      "The command did not complete in 1500ms and was sent to the background.",
      "Shell ID: shell-42",
      "Shell command is still running in the background.",
      `Call AwaitShell with {"shell_id":"shell-42"} to wait for completion. Don't mention Shell ID to the user.`,
    ].join("\n"),
  );
});

test("provider-visible Shell foreground result surfaces stdout stderr and exit code", () => {
  const success = normalizeExecClientResult({
    shellResult: {
      success: {
        command: "pwd",
        workingDirectory: "/tmp/project",
        stdout: "/tmp/project\n",
        stderr: "",
        exitCode: 0,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(success),
    [
      "Exit code: 0",
      "",
      "Command output:",
      "",
      "```",
      "/tmp/project\n",
      "```",
      "",
      "Command completed.",
      "",
      "Shell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project",
    ].join("\n"),
  );

  const failure = normalizeExecClientResult({
    shellResult: {
      failure: {
        command: "npm test",
        workingDirectory: "/tmp/project",
        stdout: "running\n",
        stderr: "failed\n",
        exitCode: 1,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(failure),
    [
      "Exit code: 1",
      "",
      "Command output:",
      "",
      "```",
      "running\nfailed\n",
      "```",
      "",
      "Command completed.",
      "",
      "Shell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project",
    ].join("\n"),
  );
});

test("provider-visible Shell foreground result prefers interleaved output and reports timing", () => {
  const success = normalizeExecClientResult({
    shellResult: {
      success: {
        command: "make",
        workingDirectory: "/tmp/project",
        stdout: "stdout only\n",
        stderr: "stderr only\n",
        interleavedOutput: "stdout only\nstderr only\n",
        exitCode: 0,
        executionTime: 1250,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(success),
    [
      "Exit code: 0",
      "",
      "Command output:",
      "",
      "```",
      "stdout only\nstderr only\n",
      "```",
      "",
      "Command completed in 1250 ms.",
      "",
      "Shell state (cwd, env vars) persists for subsequent calls. Current directory: /tmp/project",
    ].join("\n"),
  );
});

test("provider-visible Shell aborted result reports the abort and shell reset", () => {
  const aborted = normalizeExecClientResult({
    shellResult: {
      failure: {
        command: "sleep 100",
        workingDirectory: "/tmp/project",
        stdout: "partial\n",
        stderr: "",
        exitCode: 143,
        signal: "SIGTERM",
        executionTime: 5000,
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(aborted),
    [
      "Exit code: 143",
      "",
      "Command output:",
      "",
      "```",
      "partial\n",
      "```",
      "",
      "Command aborted after 5000 ms.",
      "",
      "The previous shell command aborted, so on the next invocation of this tool, a new shell will be started at the project root.",
    ].join("\n"),
  );
});

test("provider-visible Shell output is middle-out truncated at 20000 characters", () => {
  const head = "H".repeat(15000);
  const tail = "T".repeat(15000);
  const oversized = normalizeExecClientResult({
    shellResult: {
      success: {
        command: "cat big.log",
        workingDirectory: "/tmp/project",
        stdout: head + tail,
        stderr: "",
        exitCode: 0,
      },
    },
  });
  const text = stringifyToolResultForProvider(oversized);
  assert.match(text, /Command output \(truncated to 20000 characters\):/);
  // Middle-out: both ends survive, the middle is dropped.
  assert.equal(text.includes("H".repeat(10000)), true);
  assert.equal(text.includes("T".repeat(10000)), true);
  assert.equal(text.includes("H".repeat(10001)), false);
  assert.equal(text.includes("T".repeat(10001)), false);
  assert.equal(text.includes("\n\n... (output truncated) ...\n\n"), true);
});

test("provider-visible TodoWrite result formats local todo state instead of raw JSON", () => {
  const result = normalizeExecClientResult({
    todoWriteResult: {
      success: {
        todos: [
          { content: "Inspect native result parity", status: "in_progress" },
          { id: "t2", content: "Run provider tests", status: "pending" },
        ],
        merge: true,
      },
    },
  });

  assert.equal(
    stringifyToolResultForProvider(result),
    "Todo list updated (2 items):\n- [in_progress] Inspect native result parity\n- [pending] Run provider tests",
  );
});

test("provider-visible write and delete results format common Cursor oneof cases", () => {
  const write = normalizeExecClientResult({
    writeResult: {
      success: { path: "/tmp/a.txt" },
    },
  });
  assert.equal(stringifyToolResultForProvider(write), "Wrote contents to /tmp/a.txt");

  const deletionSuccess = normalizeExecClientResult({
    deleteResult: {
      success: { path: "/tmp/a.txt", fileSize: 12 },
    },
  });
  assert.equal(stringifyToolResultForProvider(deletionSuccess), "Successfully deleted file: /tmp/a.txt (12 bytes)");

  const deletionMissing = normalizeExecClientResult({
    deleteResult: {
      fileNotFound: { path: "/tmp/missing.txt" },
    },
  });
  assert.equal(stringifyToolResultForProvider(deletionMissing), "File not found: /tmp/missing.txt");

  const deletion = normalizeExecClientResult({
    deleteResult: {
      error: { path: "/tmp/a.txt", error: "permission denied" },
    },
  });
  assert.equal(stringifyToolResultForProvider(deletion), "Delete error: permission denied");
});

test("provider-visible Edit bridge result formats final local edit outcome", () => {
  const edit = normalizeExecClientResult({
    editResult: {
      success: {
        path: "/tmp/a.txt",
        beforeFullFileContent: "alpha\nbeta\n",
        afterFullFileContent: "alpha\nBETA\n",
        message: "The file /tmp/a.txt has been updated.",
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(edit), "The file /tmp/a.txt has been updated.");

  const failure = normalizeExecClientResult({
    editResult: {
      error: { path: "/tmp/a.txt", error: "String to replace not found in file." },
    },
  });
  assert.equal(stringifyToolResultForProvider(failure), "Edit error: String to replace not found in file.");
});

test("provider-visible request context result formats unknown native tool responses", () => {
  const directText = normalizeExecClientResult({
    requestContextResult: {
      success: { output: "private tool output" },
    },
  });
  assert.equal(stringifyToolResultForProvider(directText), "private tool output");

  const pathSuccess = normalizeExecClientResult({
    requestContextResult: {
      success: { path: "/tmp/private.out" },
    },
  });
  assert.equal(stringifyToolResultForProvider(pathSuccess), "Tool completed successfully: /tmp/private.out");

  const failure = normalizeExecClientResult({
    requestContextResult: {
      rejected: { reason: "unsupported in BYOK mode" },
    },
  });
  assert.equal(stringifyToolResultForProvider(failure), "Tool rejected: unsupported in BYOK mode");
});

test("provider-visible screen and computer results format defensively without exposing provider tools", () => {
  const recordScreen = normalizeExecClientResult({
    recordScreenResult: {
      success: { path: "/tmp/screen.webm" },
    },
  });
  assert.equal(stringifyToolResultForProvider(recordScreen), "RecordScreen completed successfully: /tmp/screen.webm");

  const computerUse = normalizeExecClientResult({
    computerUseResult: {
      success: { message: "Screenshot captured." },
    },
  });
  assert.equal(stringifyToolResultForProvider(computerUse), "Screenshot captured.");
});

test("provider-visible AwaitShell and WriteShellStdin results format local/native responses", () => {
  const awaitResult = normalizeExecClientResult({
    subagentAwaitResult: {
      success: {
        complete: {
          taskId: "shell-42",
          runtimeMs: 1200,
          outputFilePath: "/tmp/shell.out",
          outputLength: 31,
        },
      },
    },
  });
  assert.equal(
    stringifyToolResultForProvider(awaitResult),
    "Task complete.\noutput_file_path: /tmp/shell.out\noutput_length: 31",
  );

  const awaitWithExit = normalizeExecClientResult({
    subagentAwaitResult: {
      success: {
        complete: {
          taskId: "shell-42",
          runtimeMs: 1200,
          exitCode: 0,
        },
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(awaitWithExit), "Task completed in 1200ms with exit code: 0.");

  const awaitRunning = normalizeExecClientResult({
    subagentAwaitResult: {
      success: {
        stillRunning: {
          taskId: "shell-42",
          runtimeMs: 30000,
        },
      },
    },
  });
  assert.equal(stringifyToolResultForProvider(awaitRunning), "Task still running after 30000ms...");

  const stdin = normalizeExecClientResult({
    writeShellStdinResult: {
      success: { shellId: "shell-42" },
    },
  });
  assert.equal(stringifyToolResultForProvider(stdin), "Successfully wrote to shell shell-42 stdin.");
});

test("provider-visible AwaitShell normalizes local awaitResult alias", () => {
  const awaitResult = normalizeExecClientResult({
    message: {
      case: "awaitResult",
      value: {
        result: {
          case: "error",
          value: { error: "AwaitShell requires shell_id or task_id from a previous background shell or subagent result." },
        },
      },
    },
  });

  assert.equal(awaitResult.message.case, "subagentAwaitResult");
  assert.equal(
    stringifyToolResultForProvider(awaitResult),
    "AwaitShell error: AwaitShell requires shell_id or task_id from a previous background shell or subagent result.",
  );
});

test("provider-visible background shell stream result preserves shell id after session normalization", async () => {
  const store = new ByokSessionStore();
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const toolCallId = "shell-bg";
  const wait = store.waitForExecResult(requestId, toolCallId, 1000);
  store.registerExecAlias(requestId, 7, toolCallId);
  store.recordClientMessage(requestId, {
    message: {
      case: "execClientMessage",
      value: {
        id: 7,
        message: {
          case: "shellStream",
          value: {
            backgrounded: {
              shellId: "shell-42",
              command: "sleep 3",
              workingDirectory: "/tmp/project",
              msToWait: 1500,
              backgroundReason: "Shell command is still running in the background.",
            },
          },
        },
      },
    },
  });

  const result = await wait;
  assert.equal(result.message.case, "shellResult");
  assert.equal(result.message.value.result.case, "success");
  assert.equal(result.message.value.result.value.shellId, "shell-42");
  const text = stringifyToolResultForProvider(result);
  assert.match(text, /The command did not complete in 1500ms and was sent to the background\./);
  assert.match(text, /Shell ID: shell-42/);
  assert.match(text, /AwaitShell with \{"shell_id":"shell-42"\} to wait for completion\. Don't mention Shell ID to the user\./);
});

test("provider JSON schemas normalize recursively and close object schemas", () => {
  assert.deepEqual(
    normalizeProviderJsonSchema({ type: "OBJECT", properties: { n: { type: "INTEGER" } }, anyOf: [{ type: "STRING" }] }),
    { type: "object", properties: { n: { type: "integer" } }, anyOf: [{ type: "string" }] },
  );
  assert.deepEqual(
    normalizeProviderJsonSchema({
      type: "ARRAY",
      prefixItems: [{ type: "STRING" }],
      additionalItems: { type: "INTEGER" },
      contains: { type: "BOOLEAN" },
    }),
    {
      type: "array",
      prefixItems: [{ type: "string" }],
      additionalItems: { type: "integer" },
      contains: { type: "boolean" },
    },
  );
  assert.deepEqual(
    normalizeProviderJsonSchema({
      type: "OBJECT",
      dependentSchemas: { mode: { type: "OBJECT", properties: { detail: { type: "STRING" } } } },
    }),
    {
      type: "object",
      dependentSchemas: { mode: { type: "object", properties: { detail: { type: "string" } } } },
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "OBJECT",
      properties: {
        path: { type: "STRING" },
        nested: { type: "OBJECT", properties: { id: { type: "STRING" } } },
      },
    }),
    {
      type: "object",
      properties: {
        path: { type: "string" },
        nested: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
      },
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      oneOf: [{ type: "object", properties: { cloneId: { type: "string" } }, required: ["cloneId"] }],
      anyOf: [{ type: "object", properties: { agentId: { type: "string" } } }],
      allOf: [{ type: "object", properties: { root: { type: "string" } } }],
      enum: ["invalid-provider-tool-parameter-top-level"],
      not: { type: "null" },
    }),
    {
      type: "object",
      properties: {
        cloneId: { type: "string" },
        agentId: { type: "string" },
        root: { type: "string" },
      },
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      required: ["root"],
      anyOf: [
        { type: "object", properties: { cloneId: { type: "string" } }, required: ["cloneId"] },
      ],
      oneOf: [
        { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
      ],
      allOf: [
        { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"] },
      ],
    }),
    {
      type: "object",
      properties: {
        cloneId: { type: "string" },
        agentId: { type: "string" },
        workspaceId: { type: "string" },
      },
      required: ["root", "workspaceId"],
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      required: ["root"],
      oneOf: [
        { type: "object", properties: { cloneId: { type: "string" } }, required: ["cloneId"] },
        { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
      ],
    }),
    {
      type: "object",
      properties: {
        cloneId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["root"],
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      allOf: [{ $ref: "#/$defs/base" }],
      oneOf: [{ $ref: "#/$defs/pathInput" }, { $ref: "#/$defs/globInput" }],
      $defs: {
        base: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
        pathInput: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        globInput: {
          type: "object",
          properties: { glob: { type: "string" } },
          required: ["glob"],
        },
      },
    }),
    {
      type: "object",
      $defs: {
        base: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
        pathInput: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        globInput: {
          type: "object",
          properties: { glob: { type: "string" } },
          required: ["glob"],
        },
      },
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      properties: {
        payload: { $ref: "#/$defs/payload" },
      },
      required: ["payload"],
      $defs: {
        payload: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    }),
    {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      required: ["payload"],
      $defs: {
        payload: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    coerceProviderToolSchema({
      type: "object",
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    }).anyOf,
    undefined,
  );
  assert.deepEqual(
    normalizeTools([{
      name: "RefTool",
      description: "ref",
      inputSchema: {
        type: "object",
        properties: {
          payload: { $ref: "#/$defs/payload" },
        },
        $defs: {
          payload: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    }])[0].validationSchema.properties.payload,
    {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
  );
});

test("prompt rules match markdown file and only apply to BYOK models", () => {
  const providers = { providers: [{ models: [{ id: "byok" }] }] };
  const isByok = (id) => id === "byok";
  const prompt = appendByokPromptRules("base", "byok", providers, isByok);
  assert.equal(prompt, `base\n\n${loadByokSystemPrompt()}`);
  assert.equal(appendByokPromptRules("base", "official", providers, isByok), "base");
  const planPrompt = appendByokPromptRules("base", "byok", providers, isByok, { composerMode: "plan" });
  assert.match(planPrompt, /<cursor_byok_plan_mode>/);
  assert.match(planPrompt, /Resolve discoverable facts through targeted exploration/);
  assert.match(planPrompt, /Internal todo\/checklist tools are for progress tracking only/);
  assert.match(planPrompt, /call CreatePlan once with the complete user-visible plan artifact/);
  assert.match(planPrompt, /YAML frontmatter and render as structured UI sections/);
  assert.match(planPrompt, /Write plan as markdown/);
  assert.equal(appendByokPromptRules(planPrompt, "byok", providers, isByok, { composerMode: "plan" }), planPrompt);
  assert.match(sanitizeProviderVisiblePromptText("ReadFile filePath read_file", "anthropic"), /Read an unsupported alternate key Read/);
  assert.equal(sanitizeProviderVisiblePromptText("ReadFile filePath read_file", "openai-chat"), "ReadFile filePath read_file");
  assert.equal(sanitizeProviderVisiblePromptText("ReadFile filePath read_file", "openai-responses"), "ReadFile filePath read_file");
});

test("BYOK prompt appends workspace roots context once when roots are available", () => {
  const providers = { providers: [{ models: [{ id: "byok" }] }] };
  const isByok = (id) => id === "byok";
  const workspaceRoots = ["/repo/main", "/repo/tools"];
  const workspaceSection = formatWorkspaceRootsPromptSection(workspaceRoots);
  assert.match(workspaceSection, /<cursor_workspace_context>/);
  assert.match(workspaceSection, /- \/repo\/main/);
  assert.match(workspaceSection, /Do not list `\/` or other filesystem roots/);
  const prompt = appendByokPromptRules("base", "byok", providers, isByok, { workspaceRoots });
  assert.match(prompt, /<cursor_workspace_context>/);
  assert.match(prompt, /- \/repo\/main/);
  assert.match(prompt, /- \/repo\/tools/);
  assert.equal(appendByokPromptRules(prompt, "byok", providers, isByok, { workspaceRoots }), prompt);
  assert.equal(formatWorkspaceRootsPromptSection([]), "");
});

test("provider cache helpers preserve expected API behavior", () => {
  const messages = [{ cache_control: { type: "ephemeral" } }];
  assert.equal(preserveAnthropicCacheControl(messages), messages);
  assert.equal(withOpenAiPromptCacheKey({ provider: "openai-responses" }, "c1").prompt_cache_key, "c1");
  assert.equal(withOpenAiPromptCacheKey({ provider: "openai-responses" }, "").prompt_cache_key, undefined);
});

test("provider prompt normalization preserves tool use and tool result structure", () => {
  assert.deepEqual(
    normalizeProviderMessage({
      role: "assistant",
      toolUse: { id: "u1", name: "Read", input: "{\"path\":\"/tmp/a\"}" },
    }),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "u1", name: "Read", input: { path: "/tmp/a" } }],
    },
  );
  assert.deepEqual(
    normalizeProviderMessage({
      type: "tool_result",
      toolResult: { toolUseId: "u1", content: "    1|ok" },
    }),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "u1", content: "    1|ok" }],
    },
  );
  assert.deepEqual(
    normalizeProviderMessage({ role: "tool", tool_call_id: "call-1", content: "ok" }),
    { role: "tool", tool_call_id: "call-1", content: "ok" },
  );
  assert.deepEqual(
    normalizeProviderMessage({ role: "tool", callId: "call-2", output: "alias ok" }),
    { role: "tool", tool_call_id: "call-2", content: "alias ok" },
  );
  assert.deepEqual(
    normalizeProviderMessage({
      type: "tool_result",
      toolResult: {
        toolUseId: "u2",
        content: [{ type: "text", text: "structured ok", extra: "cursor-only" }],
      },
    }),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "u2", content: [{ type: "text", text: "structured ok", extra: "cursor-only" }] }],
    },
  );
  assert.deepEqual(
    normalizeProviderMessage({
      type: "tool_result",
      toolResult: {
        toolCallId: "u3",
        output: "output alias ok",
      },
    }),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "u3", content: "output alias ok" }],
    },
  );
  assert.deepEqual(
    normalizeProviderMessage({
      role: "assistant",
      tool_use: { tool_call_id: "u4", tool_name: "Grep", args: { pattern: "needle" } },
    }),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "u4", name: "Grep", input: { pattern: "needle" } }],
    },
  );
});

test("provider prompt builder keeps conversation id and structured tool history", () => {
  const prompt = buildPrompt({
    conversationId: "c1",
    systemPrompt: "system",
    messages: [
      { role: "assistant", toolUse: { id: "u1", name: "Read", input: "{\"path\":\"/tmp/a\"}" } },
      { type: "tool_result", toolResult: { toolUseId: "u1", content: "    1|ok" } },
    ],
  });
  assert.equal(prompt.conversationId, "c1");
  assert.equal(prompt.system, "system");
  assert.equal(prompt.messages[0].content[0].type, "tool_use");
  assert.equal(prompt.messages[1].content[0].type, "tool_result");
});
