"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { ProviderAdapter } = require("../src/server/provider-adapter");
const { loadProviders } = require("../src/config");
const { findProviderModel } = require("../src/runtime/models");
const { buildDirectReadExecResult, normalizeExecClientResult } = require("../src/server/http");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const providers = loadProviders();
  const entry = findProviderModel(options.model, providers);
  if (!entry) {
    throw new Error(`model not found: ${options.model}`);
  }
  const adapter = new ProviderAdapter({
    providersConfigProvider: loadProviders,
    log: createBenchmarkLog(options.verbose),
  });
  const runs = [];
  (async () => {
    for (let index = 0; index < options.repeat; index++) {
      runs.push(await benchmarkRun(adapter, entry, options, index));
    }
    const output = {
      model: options.model,
      provider: entry.provider.name,
      providerType: entry.provider.type || "openai-chat",
      workspace: options.workspace,
      repeat: options.repeat,
      promptPreview: options.prompt.slice(0, Math.min(options.prompt.length, 160)),
      aggregate: summarizeRuns(runs),
      runs,
    };
    console.log(JSON.stringify(output, null, 2));
  })().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

function parseArgs(argv) {
  const options = {
    model: "DeepSeek-V4-Flash",
    workspace: process.cwd(),
    prompt: "",
    repeat: 1,
    previewChars: 700,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--model":
        options.model = requiredValue(argv, ++index, "--model");
        break;
      case "--workspace":
        options.workspace = path.resolve(requiredValue(argv, ++index, "--workspace"));
        break;
      case "--prompt":
        options.prompt = requiredValue(argv, ++index, "--prompt");
        break;
      case "--prompt-file":
        options.prompt = fs.readFileSync(path.resolve(requiredValue(argv, ++index, "--prompt-file")), "utf8");
        break;
      case "--repeat":
        options.repeat = parsePositiveInt(requiredValue(argv, ++index, "--repeat"), "--repeat");
        break;
      case "--preview-chars":
        options.previewChars = parsePositiveInt(requiredValue(argv, ++index, "--preview-chars"), "--preview-chars");
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  options.prompt = String(options.prompt || "").trim();
  if (!options.prompt) {
    throw new Error("prompt is required; pass --prompt or --prompt-file");
  }
  if (!fs.existsSync(options.workspace) || !fs.statSync(options.workspace).isDirectory()) {
    throw new Error(`workspace must be an existing directory: ${options.workspace}`);
  }
  return options;
}

function requiredValue(argv, index, flag) {
  if (index >= argv.length || !argv[index]) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index];
}

function parsePositiveInt(raw, flag) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/benchmark-tool-latency.js --workspace /abs/repo --prompt \"...\" [--model DeepSeek-V4-Flash] [--repeat 3]",
    "  node scripts/benchmark-tool-latency.js --workspace /abs/repo --prompt-file ./prompt.txt",
  ].join("\n"));
}

async function benchmarkRun(adapter, entry, options, index) {
  const requestId = `bench-${Date.now()}-${index}`;
  const conversationId = `conv-${Date.now()}-${index}`;
  const startedAt = Date.now();
  const logEntries = [];
  const requestEntries = [];
  if (typeof adapter.log?.clear === "function") adapter.log.clear();
  let firstTextMs = null;
  let finalText = "";
  let finalTextChars = 0;
  let postLastBatchText = "";
  let toolCount = 0;
  let batchCount = 0;
  let waitCallCount = 0;
  let currentBatch = [];
  const batches = [];
  let lastBatchClosedAtMs = null;
  let firstTextSinceLatestBatchMs = null;
  let textCharsSinceLatestBatch = 0;
  let postLastBatchTextDeltaCount = 0;
  let lastPostLastBatchTextMs = null;
  let maxPostLastBatchInterDeltaGapMs = 0;
  let stopReason = "";
  for await (const event of adapter.run({
    provider: entry.provider,
    model: entry.model,
    request: {
      conversationId,
      requestedModel: { modelId: options.model },
      modelDetails: { modelId: options.model },
      composerMode: "agent",
      workspaceRoots: [options.workspace],
      messages: [{ role: "user", content: options.prompt }],
    },
    requestId,
    waitForToolResult: async (toolCallId, waitOptions) => {
      waitCallCount++;
      return executeReadonlyTool(options.workspace, toolCallId, waitOptions.toolName, waitOptions.toolArguments);
    },
  })) {
    if (event.type === "text_delta") {
      const nowMs = Date.now() - startedAt;
      if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
      if (lastBatchClosedAtMs !== null) {
        if (firstTextSinceLatestBatchMs === null) firstTextSinceLatestBatchMs = nowMs;
        if (lastPostLastBatchTextMs !== null) {
          const gapMs = nowMs - lastPostLastBatchTextMs;
          if (gapMs > maxPostLastBatchInterDeltaGapMs) maxPostLastBatchInterDeltaGapMs = gapMs;
        }
        lastPostLastBatchTextMs = nowMs;
        postLastBatchTextDeltaCount += 1;
        textCharsSinceLatestBatch += String(event.text || "").length;
        postLastBatchText += event.text || "";
      }
      finalText += event.text || "";
      finalTextChars += String(event.text || "").length;
    }
    if (event.type === "tool_use_done") {
      toolCount += 1;
      currentBatch.push(summarizeToolUse(event));
    }
    if (event.type === "done" && event.stopReason === "tool_use") {
      if (currentBatch.length) {
        batchCount += 1;
        const closedAtMs = Date.now() - startedAt;
        batches.push({
          closedAtMs,
          durationSincePreviousMs: lastBatchClosedAtMs === null ? closedAtMs : closedAtMs - lastBatchClosedAtMs,
          tools: currentBatch,
        });
        lastBatchClosedAtMs = closedAtMs;
        firstTextSinceLatestBatchMs = null;
        textCharsSinceLatestBatch = 0;
        postLastBatchText = "";
        postLastBatchTextDeltaCount = 0;
        lastPostLastBatchTextMs = null;
        maxPostLastBatchInterDeltaGapMs = 0;
        currentBatch = [];
      }
    } else if (event.type === "done") {
      stopReason = event.stopReason || "";
    }
  }
  if (currentBatch.length) {
    batchCount += 1;
    const closedAtMs = Date.now() - startedAt;
    batches.push({
      closedAtMs,
      durationSincePreviousMs: lastBatchClosedAtMs === null ? closedAtMs : closedAtMs - lastBatchClosedAtMs,
      tools: currentBatch,
    });
    lastBatchClosedAtMs = closedAtMs;
    firstTextSinceLatestBatchMs = null;
    textCharsSinceLatestBatch = 0;
    postLastBatchText = "";
    postLastBatchTextDeltaCount = 0;
    lastPostLastBatchTextMs = null;
    maxPostLastBatchInterDeltaGapMs = 0;
  }
  const totalMs = Date.now() - startedAt;
  if (typeof adapter.log?.drain === "function") {
    for (const entry of adapter.log.drain()) {
      if (entry?.message === "BYOK provider tool batch resolved") logEntries.push(entry.fields || {});
      if (entry?.message === "BYOK provider request") requestEntries.push(entry.fields || {});
    }
  }
  return {
    requestId,
    firstTextMs,
    totalMs,
    toolCount,
    waitCallCount,
    batchCount,
    providerRequestCount: requestEntries.length,
    hiddenToolRoundCount: Math.max(0, requestEntries.length - 1 - batchCount),
    stopReason,
    idleAfterLastBatchMs: lastBatchClosedAtMs === null ? null : totalMs - lastBatchClosedAtMs,
    postLastBatchGapMs: lastBatchClosedAtMs === null || firstTextSinceLatestBatchMs === null ? null : firstTextSinceLatestBatchMs - lastBatchClosedAtMs,
    postLastBatchAnswerMs: firstTextSinceLatestBatchMs === null ? null : totalMs - firstTextSinceLatestBatchMs,
    postLastBatchStreamSpanMs: firstTextSinceLatestBatchMs === null || lastPostLastBatchTextMs === null ? null : lastPostLastBatchTextMs - firstTextSinceLatestBatchMs,
    postLastBatchTailAfterTextMs: lastPostLastBatchTextMs === null ? null : totalMs - lastPostLastBatchTextMs,
    postLastBatchTextChars: textCharsSinceLatestBatch,
    postLastBatchTextPreview: postLastBatchText.slice(0, options.previewChars),
    postLastBatchTextDeltaCount,
    maxPostLastBatchInterDeltaGapMs: postLastBatchTextDeltaCount > 1 ? maxPostLastBatchInterDeltaGapMs : 0,
    finalTextChars,
    providerRequests: requestEntries.map((entry) => ({
      messageCount: entry.messageCount,
      inputCount: entry.inputCount,
      historyChars: entry.historyChars,
    })),
    resolvedBatches: logEntries.map((entry) => ({
      toolCount: entry.toolCount,
      dedupedToolCount: entry.dedupedToolCount || 0,
      derivedToolCount: entry.derivedToolCount || 0,
      waitMs: entry.waitMs,
      providerTextChars: entry.providerTextChars,
      tools: Array.isArray(entry.tools) ? entry.tools : [],
      toolSummaries: Array.isArray(entry.toolSummaries) ? entry.toolSummaries.map((summary) => ({
        ...summary,
        providerTextPreview: typeof summary?.providerTextPreview === "string"
          ? summary.providerTextPreview
          : undefined,
      })) : [],
    })),
    batches,
    finalTextPreview: finalText.slice(0, options.previewChars),
  };
}

function summarizeToolUse(event) {
  const args = parseJsonObject(event.arguments);
  return {
    name: event.name,
    path: stringOrEmpty(args.path),
    pattern: stringOrEmpty(args.pattern),
    outputMode: stringOrEmpty(args.output_mode || args.outputMode),
    offset: normalizeInteger(args.offset),
    limit: normalizeInteger(args.limit),
    command: stringOrEmpty(args.command),
    description: stringOrEmpty(args.description),
    workingDirectory: stringOrEmpty(args.working_directory || args.workingDirectory),
    toolArgumentsPreview: typeof event.arguments === "string"
      ? String(event.arguments).slice(0, 240)
      : undefined,
  };
}

function summarizeRuns(runs) {
  return {
    totalMs: numberSummary(runs.map((run) => run.totalMs)),
    firstTextMs: numberSummary(runs.map((run) => run.firstTextMs).filter((value) => Number.isInteger(value))),
    toolCount: numberSummary(runs.map((run) => run.toolCount)),
    waitCallCount: numberSummary(runs.map((run) => run.waitCallCount)),
    batchCount: numberSummary(runs.map((run) => run.batchCount)),
    providerRequestCount: numberSummary(runs.map((run) => run.providerRequestCount)),
    hiddenToolRoundCount: numberSummary(runs.map((run) => run.hiddenToolRoundCount)),
    idleAfterLastBatchMs: numberSummary(runs.map((run) => run.idleAfterLastBatchMs).filter((value) => Number.isInteger(value))),
    postLastBatchGapMs: numberSummary(runs.map((run) => run.postLastBatchGapMs).filter((value) => Number.isInteger(value))),
    postLastBatchAnswerMs: numberSummary(runs.map((run) => run.postLastBatchAnswerMs).filter((value) => Number.isInteger(value))),
    postLastBatchStreamSpanMs: numberSummary(runs.map((run) => run.postLastBatchStreamSpanMs).filter((value) => Number.isInteger(value))),
    postLastBatchTailAfterTextMs: numberSummary(runs.map((run) => run.postLastBatchTailAfterTextMs).filter((value) => Number.isInteger(value))),
    postLastBatchTextChars: numberSummary(runs.map((run) => run.postLastBatchTextChars).filter((value) => Number.isInteger(value))),
    postLastBatchTextDeltaCount: numberSummary(runs.map((run) => run.postLastBatchTextDeltaCount).filter((value) => Number.isInteger(value))),
    maxPostLastBatchInterDeltaGapMs: numberSummary(runs.map((run) => run.maxPostLastBatchInterDeltaGapMs).filter((value) => Number.isInteger(value))),
    finalTextChars: numberSummary(runs.map((run) => run.finalTextChars).filter((value) => Number.isInteger(value))),
    providerHistoryChars: numberSummary(runs.flatMap((run) => run.providerRequests.map((entry) => entry.historyChars)).filter((value) => Number.isInteger(value))),
  };
}

function numberSummary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    avg: total / sorted.length,
  };
}

async function executeReadonlyTool(workspaceRoot, toolCallId, toolName, rawArgs) {
  const args = parseJsonObject(rawArgs);
  switch (toolName) {
    case "Read":
    case "ReadFile":
      return readResult(workspaceRoot, toolCallId, args);
    case "Grep":
      return grepResult(workspaceRoot, toolCallId, args);
    case "Glob":
      return globResult(workspaceRoot, toolCallId, args);
    case "LS":
      return lsResult(workspaceRoot, toolCallId, args);
    case "ReadLints":
      return normalizeExecClientResult({
        execId: toolCallId,
        diagnosticsResult: { result: { case: "success", value: { output: "no diagnostics" } } },
      });
    default:
      return normalizeExecClientResult({
        execId: toolCallId,
        diagnosticsResult: {
          result: {
            case: "error",
            value: { error: `${toolName || "unknown tool"} is unsupported in the benchmark harness` },
          },
        },
      });
  }
}

function readResult(workspaceRoot, toolCallId, args) {
  const filePath = resolveToolPath(workspaceRoot, stringOrEmpty(args.path));
  return buildDirectReadExecResult(toolCallId, filePath, args);
}

function grepResult(workspaceRoot, toolCallId, args) {
  const outputMode = stringOrEmpty(args.output_mode || args.outputMode) || "content";
  let stdout = "";
  try {
    stdout = childProcess.execFileSync("rg", buildRgArgs(workspaceRoot, args), {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const entries = stdout
    ? stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const fileMap = new Map();
  for (const entry of entries) {
    if (entry.type !== "match" && entry.type !== "context") continue;
    const file = stringOrEmpty(entry.data?.path?.text);
    const lineNumber = entry.data?.line_number;
    const content = stringOrEmpty(entry.data?.lines?.text).replace(/\n$/, "");
    if (!file || !Number.isInteger(lineNumber)) continue;
    const relative = path.isAbsolute(file) ? path.relative(workspaceRoot, file) || path.basename(file) : file;
    if (!fileMap.has(relative)) fileMap.set(relative, []);
    fileMap.get(relative).push({ lineNumber, content });
  }
  const offset = Math.max(0, normalizeInteger(args.offset) || 0);
  const headLimit = normalizeInteger(args.head_limit ?? args.headLimit);
  if (outputMode === "files_with_matches") {
    const files = [...fileMap.keys()].slice(offset, headLimit !== undefined ? offset + headLimit : undefined);
    return normalizeExecClientResult({
      execId: toolCallId,
      grepResult: {
        success: {
          pattern: stringOrEmpty(args.pattern),
          outputMode,
          workspaceResults: {
            [workspaceRoot]: {
              result: {
                case: "files",
                value: { files, totalFiles: fileMap.size },
              },
            },
          },
        },
      },
    });
  }
  const flatMatches = [...fileMap.entries()].flatMap(([file, matches]) =>
    matches.map((match) => ({ file, ...match })));
  if (outputMode === "count") {
    const sliced = flatMatches.slice(offset, headLimit !== undefined ? offset + headLimit : undefined);
    return normalizeExecClientResult({
      execId: toolCallId,
      grepResult: {
        success: {
          pattern: stringOrEmpty(args.pattern),
          outputMode,
          workspaceResults: {
            [workspaceRoot]: {
              result: {
                case: "count",
                value: {
                  totalMatches: sliced.length,
                  totalFiles: new Set(sliced.map((match) => match.file)).size,
                },
              },
            },
          },
        },
      },
    });
  }
  let files = [...fileMap.entries()].map(([file, matches]) => ({ file, matches }));
  if (offset) {
    let remaining = offset;
    files = files.map(({ file, matches }) => {
      if (remaining <= 0) return { file, matches };
      if (remaining >= matches.length) {
        remaining -= matches.length;
        return { file, matches: [] };
      }
      const next = matches.slice(remaining);
      remaining = 0;
      return { file, matches: next };
    }).filter((entry) => entry.matches.length);
  }
  if (headLimit !== undefined) {
    let remaining = headLimit;
    files = files.map(({ file, matches }) => {
      if (remaining <= 0) return { file, matches: [] };
      const next = matches.slice(0, remaining);
      remaining -= next.length;
      return { file, matches: next };
    }).filter((entry) => entry.matches.length);
  }
  return normalizeExecClientResult({
    execId: toolCallId,
    grepResult: {
      success: {
        pattern: stringOrEmpty(args.pattern),
        outputMode,
        workspaceResults: {
          [workspaceRoot]: {
            result: {
              case: "content",
              value: { matches: files },
            },
          },
        },
      },
    },
  });
}

function globResult(workspaceRoot, toolCallId, args) {
  const globPattern = stringOrEmpty(args.glob_pattern || args.globPattern);
  const targetDirectory = resolveToolPath(workspaceRoot, stringOrEmpty(args.target_directory || args.targetDirectory));
  let stdout = "";
  try {
    stdout = childProcess.execFileSync("rg", ["--files", targetDirectory, "-g", globPattern], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const files = stdout ? stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  return normalizeExecClientResult({
    execId: toolCallId,
    grepResult: {
      success: {
        pattern: globPattern,
        outputMode: "files_with_matches",
        workspaceResults: {
          [workspaceRoot]: {
            result: {
              case: "files",
              value: { files, totalFiles: files.length },
            },
          },
        },
      },
    },
  });
}

function lsResult(workspaceRoot, toolCallId, args) {
  const targetDirectory = resolveToolPath(workspaceRoot, stringOrEmpty(args.path));
  return normalizeExecClientResult({
    execId: toolCallId,
    lsResult: {
      result: {
        case: "success",
        value: {
          output: fs.readdirSync(targetDirectory).slice(0, 200).join("\n"),
        },
      },
    },
  });
}

function buildRgArgs(workspaceRoot, args) {
  const rgArgs = ["--json", "--line-number", "--no-heading", "--color", "never"];
  if (args["-i"] || args.case_insensitive || args.caseInsensitive) rgArgs.push("-i");
  if (args.multiline) rgArgs.push("--multiline");
  const context = normalizeInteger(args["-C"] ?? args.context);
  const contextBefore = normalizeInteger(args["-B"] ?? args.context_before ?? args.contextBefore);
  const contextAfter = normalizeInteger(args["-A"] ?? args.context_after ?? args.contextAfter);
  if (context !== undefined) rgArgs.push("-C", String(context));
  if (contextBefore !== undefined) rgArgs.push("-B", String(contextBefore));
  if (contextAfter !== undefined) rgArgs.push("-A", String(contextAfter));
  if (typeof args.glob === "string" && args.glob) rgArgs.push("--glob", args.glob);
  if (typeof args.type === "string" && args.type) rgArgs.push(`-t${args.type}`);
  rgArgs.push(stringOrEmpty(args.pattern));
  rgArgs.push(resolveToolPath(workspaceRoot, stringOrEmpty(args.path)));
  return rgArgs;
}

function resolveToolPath(workspaceRoot, rawPath) {
  if (!rawPath) return workspaceRoot;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath);
}

function parseJsonObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeInteger(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function quietLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createBenchmarkLog(verbose) {
  const entries = [];
  return {
    info(message, fields) {
      entries.push({ level: "info", message, fields });
      if (verbose) console.error(`[info] ${message} ${safeJson(fields)}`);
    },
    warn(message, fields) {
      entries.push({ level: "warn", message, fields });
      if (verbose) console.error(`[warn] ${message} ${safeJson(fields)}`);
    },
    error(message, fields) {
      entries.push({ level: "error", message, fields });
      console.error(`[error] ${message} ${safeJson(fields)}`);
    },
    drain() {
      return entries.splice(0, entries.length);
    },
    clear() {
      entries.length = 0;
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

main();
