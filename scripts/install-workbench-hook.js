"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SEARCH_COUNT } = require("../src/constants");
const { hookStatePath, loadProviders, loadRoutes, workbenchBackupDir } = require("../src/config");
const { byokModelIds, mergeAvailableModels } = require("../src/runtime/models");
const { buildWorkbenchHook } = require("../src/workbench-hook");
const { resolveCursorVersion } = require("./cursor-version");
const {
  REGISTRY,
  TRANSPORT_PATCH_NAMES,
  applyPatchPlan,
  hasActiveTransport,
  missingCriticalPatches,
  optionalPatchWarnings,
  patchedHookPoints,
  transportHookPoints,
  validateWorkbenchSyntax,
} = require("./workbench-patch-engine");
const {
  HOOK_STATE_SCHEMA_VERSION,
  ensureBackupEntry,
  hasBackupEntry,
  isStaleBackupEntry,
  readHookInstallState,
  sha256Text,
  writeFileAtomically,
  writeHookInstallState,
} = require("./workbench-backup-store");
const { patchIntegrityWarning } = require("./workbench-patches/integrity-warning");
const { patchStallDetectorCleanup } = require("./workbench-patches/stall-detector");
const { patchFirstTokenWarningThresholds } = require("./workbench-patches/first-token-thresholds");
const { patchAgentProviderRouterGuard } = require("./workbench-patches/router-guard");
const { patchLocalAgentRunForByok } = require("./workbench-patches/local-agent-run");
const { patchModelPickerUnlock } = require("./workbench-patches/model-picker-unlock");
const { patchPromiseClientFactory } = require("./workbench-patches/transport-promise-client");
const { patchContextRpcAgentClient } = require("./workbench-patches/transport-context-rpc");

const WORKBENCH = "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js";
const EXT_HOST = "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js";
const CLEAN_START = "/* CURSOR-BYOK-HOOK-V2-START */";
const CLEAN_END = "/* CURSOR-BYOK-HOOK-V2-END */";
const PREVIOUS_START = "/* CURSOR-BYOK-" + "CLEAN" + "ROOM-HOOK-START */";
const PREVIOUS_END = "/* CURSOR-BYOK-" + "CLEAN" + "ROOM-HOOK-END */";
const LEGACY_START = "/* CURSOR-BYOK-HOOK-START */";
const LEGACY_END = "/* CURSOR-BYOK-HOOK-END */";

function installWorkbenchHook(options = {}) {
  const prepared = prepareWorkbenchInstall(options);
  if (options.dryRun) return summarizePreparedInstall(prepared, { dryRun: true, backupsCreated: 0 });
  if (prepared.needsPristine) {
    const cause = prepared.pristineSourceReason === "backup-not-pristine"
      ? "is already patched and the recorded backup is itself not pristine (it contains BYOK patches)"
      : "is already patched and no pristine backup is recorded";
    throw new Error(
      `Cursor BYOK install failed: ${path.basename(prepared.workbench)} ${cause}. ` +
      "Provide a pristine workbench first: reinstall Cursor, mount the matching Cursor installer DMG and re-run `npm run install:cursor`, " +
      "or set CURSOR_WORKBENCH_PRISTINE to a pristine workbench.desktop.main.js.",
    );
  }
  if (!prepared.hasActiveTransport) {
    throw new Error("Cursor BYOK install failed: no supported Cursor transport hook point found");
  }
  const missingCritical = missingCriticalPatches(prepared.patchReport);
  if (missingCritical.length && !options.allowPartial) {
    throw new Error(
      `Cursor BYOK install failed: critical workbench patches did not apply: ${missingCritical.join(", ")}. ` +
      "The installed Cursor build may have changed these seams; BYOK routing would be degraded. " +
      "Run `npm run preflight:cursor` to inspect the patch report, or pass --allow-partial (CLI) / allowPartial (API) to install anyway.",
    );
  }

  const backupSummary = backupPreparedInstall(prepared);
  validateWorkbenchSyntax(prepared.patchedWorkbenchContent, prepared.workbench);
  writeFileAtomically(prepared.workbench, prepared.patchedWorkbenchContent);
  if (prepared.extHostExists) {
    writeFileAtomically(prepared.extHost, prepared.patchedExtHostContent);
  }
  const state = {
    schemaVersion: HOOK_STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    workbench: backupSummary.workbenchEntry,
    extHost: backupSummary.extHostEntry,
    lastInstall: {
      workbench: prepared.workbench,
      extHost: prepared.extHostExists ? prepared.extHost : null,
      routes: prepared.routeCount,
      transportHookPoints: prepared.transportHookPoints,
      patchedHookPoints: prepared.patchedHookPoints,
      cursorVersion: prepared.cursorVersion || null,
      patchReport: prepared.patchReport,
      workbenchSha256: sha256Text(prepared.patchedWorkbenchContent),
      extHostSha256: prepared.extHostExists ? sha256Text(prepared.patchedExtHostContent) : null,
    },
  };
  writeHookInstallState(state);
  return summarizePreparedInstall(prepared, {
    backupsCreated: backupSummary.createdCount,
    backupWarnings: backupSummary.warnings,
    state,
  });
}

function analyzeWorkbenchHookInstall(options = {}) {
  return summarizePreparedInstall(prepareWorkbenchInstall(options), { dryRun: true, backupsCreated: 0 });
}

function restoreWorkbenchHook(options = {}) {
  const state = readHookInstallState();
  if (!state) {
    throw new Error("Cursor BYOK restore failed: no saved workbench backup state found");
  }
  const fallbackTargets = {
    workbench: options.workbench || WORKBENCH,
    extHost: options.extHost || EXT_HOST,
  };
  const restoredFiles = [];
  const missingBackups = [];
  const unrestoredPatchedTargets = [];
  for (const key of ["workbench", "extHost"]) {
    const entry = state[key];
    if (!entry?.backupPath) {
      const target = entry?.targetPath || fallbackTargets[key];
      if (fs.existsSync(target) && hasManagedHookBlock(fs.readFileSync(target, "utf8"))) {
        unrestoredPatchedTargets.push(target);
      }
      continue;
    }
    if (!fs.existsSync(entry.backupPath)) {
      missingBackups.push(path.basename(entry.targetPath || key));
      continue;
    }
    fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
    fs.copyFileSync(entry.backupPath, entry.targetPath);
    restoredFiles.push(entry.targetPath);
  }
  if (!restoredFiles.length) {
    throw new Error("Cursor BYOK restore failed: no saved workbench backup files were found");
  }
  return {
    workbench: options.workbench || state.workbench?.targetPath || WORKBENCH,
    extHost: options.extHost || state.extHost?.targetPath || EXT_HOST,
    restoredFiles,
    missingBackups,
    unrestoredPatchedTargets,
    statePath: hookStatePath(),
    backupDir: workbenchBackupDir(),
  };
}

function prepareWorkbenchInstall(options = {}) {
  const workbench = options.workbench || WORKBENCH;
  const extHost = options.extHost || EXT_HOST;
  const cursorVersion = resolveCursorVersion(workbench, options.cursorVersion || process.env.CURSOR_VERSION);
  const routes = loadRoutes();
  const host = routes.server?.host || DEFAULT_HOST;
  const port = Number.isInteger(routes.server?.port) && routes.server.port > 0 ? routes.server.port : DEFAULT_PORT;
  const providers = loadProviders();
  const hook = buildWorkbenchHook({
    host,
    port,
    portSearchCount: DEFAULT_PORT_SEARCH_COUNT,
    routes: routes.redirect || [],
    byokModelIds: [...byokModelIds(providers)],
    byokModels: mergeAvailableModels([], providers),
  });
  const workbenchContent = fs.readFileSync(workbench, "utf8");
  const explicitPristineWorkbench = readExplicitPristineWorkbench(options.pristineWorkbench || process.env.CURSOR_WORKBENCH_PRISTINE);
  const state = readHookInstallState();
  const workbenchAlreadyPatched = hasByokPatches(workbenchContent);
  const pristine = pristineWorkbenchContent({
    workbench,
    workbenchContent,
    workbenchAlreadyPatched,
    state,
    explicitPristineWorkbench,
  });
  const needsPristine = pristine.source === "patched-no-pristine";
  const plan = needsPristine
    ? null
    : applyPatchPlan(stripManagedHookBlocks(pristine.content), { target: "workbench", cursorVersion });
  const extHostExists = fs.existsSync(extHost);
  const extHostContent = extHostExists ? fs.readFileSync(extHost, "utf8") : "";
  const extHostPlan = extHostExists
    ? applyPatchPlan(stripManagedHookBlocks(extHostContent), { target: "extHost", cursorVersion })
    : null;
  const patchedExtHostContent = extHostExists ? hook + extHostPlan.content : "";
  const extHostNeedsPatch = extHostExists && patchedExtHostContent !== extHostContent;
  return {
    workbench,
    extHost,
    extHostExists,
    cursorVersion: cursorVersion || null,
    routeCount: routes.redirect?.length || 0,
    pristineSource: pristine.source,
    pristineSourceReason: pristine.reason || null,
    needsPristine,
    patchReport: plan ? plan.report : [],
    hasActiveTransport: plan ? hasActiveTransport(plan.report) : false,
    transportHookPoints: plan ? transportHookPoints(plan.report) : [],
    patchedHookPoints: plan ? patchedHookPoints(plan.report) : [],
    workbenchContent,
    patchBaseContent: pristine.content,
    patchedFromPristineBackup: pristine.source === "backup",
    patchedWorkbenchContent: plan ? hook + plan.content : "",
    workbenchAlreadyPatched,
    extHostContent,
    patchedExtHostContent,
    extHostNeedsPatch,
    extHostPatchReport: extHostPlan ? extHostPlan.report : [],
    extHostTransportHookPoints: extHostPlan ? transportHookPoints(extHostPlan.report) : [],
    extHostPatchedHookPoints: extHostPlan ? patchedHookPoints(extHostPlan.report) : [],
    state,
  };
}

function summarizePreparedInstall(prepared, extra = {}) {
  const state = extra.state || prepared.state || {};
  const backupWarnings = Array.isArray(extra.backupWarnings) ? extra.backupWarnings : collectBackupWarnings(prepared);
  return {
    workbench: prepared.workbench,
    extHost: prepared.extHost,
    routes: prepared.routeCount,
    cursorVersion: prepared.cursorVersion,
    transportHookPoints: prepared.transportHookPoints,
    patchedHookPoints: prepared.patchedHookPoints,
    patchReport: prepared.patchReport,
    extHostPatchReport: prepared.extHostPatchReport,
    missingCriticalPatches: missingCriticalPatches(prepared.patchReport || []),
    patchWarnings: optionalPatchWarnings(prepared.patchReport || []),
    statePath: hookStatePath(),
    backupDir: workbenchBackupDir(),
    backupsCreated: extra.backupsCreated || 0,
    backupWarnings,
    dryRun: !!extra.dryRun,
    extHostExists: prepared.extHostExists,
    workbenchBackupCaptured: hasBackupEntry(state.workbench, prepared.workbench),
    extHostBackupCaptured: prepared.extHostExists ? hasBackupEntry(state.extHost, prepared.extHost) : false,
    pristineSource: prepared.pristineSource,
    pristineSourceReason: prepared.pristineSourceReason,
    needsPristine: prepared.needsPristine,
    patchedFromPristineBackup: prepared.patchedFromPristineBackup,
  };
}

function collectBackupWarnings(prepared) {
  const warnings = [];
  if (!hasBackupEntry(prepared.state?.workbench, prepared.workbench) && prepared.workbenchAlreadyPatched) {
    warnings.push(`${path.basename(prepared.workbench)} is already patched; no pristine backup is recorded`);
  }
  if (prepared.pristineSourceReason === "backup-not-pristine") {
    warnings.push(`recorded backup for ${path.basename(prepared.workbench)} is not pristine and cannot be used as a patch base`);
  }
  if (!prepared.workbenchAlreadyPatched && isStaleBackupEntry(prepared.state?.workbench, prepared.workbenchContent)) {
    warnings.push(`${path.basename(prepared.workbench)} backup is stale and will be refreshed from the current Cursor bundle`);
  }
  return warnings;
}

function readExplicitPristineWorkbench(pristineWorkbenchPath) {
  if (typeof pristineWorkbenchPath !== "string" || !pristineWorkbenchPath) return "";
  if (!fs.existsSync(pristineWorkbenchPath)) return "";
  const content = fs.readFileSync(pristineWorkbenchPath, "utf8");
  if (hasByokPatches(content)) {
    throw new Error(
      `Cursor BYOK install failed: the explicit pristine workbench at ${pristineWorkbenchPath} ` +
      "already contains BYOK patches. Point CURSOR_WORKBENCH_PRISTINE (or the pristineWorkbench option) at an unpatched workbench.desktop.main.js.",
    );
  }
  return content;
}

// A patched workbench can only descend from the pristine backup recorded for
// the same target path: Cursor app updates replace the file with unpatched
// content, and this installer only captures backups from content that carries
// no BYOK patches at all. Backups recorded by older installer versions can
// still be polluted (in-place patches without a hook block), so the backup is
// re-validated before being trusted as the patch base. Staleness checks only
// apply to unpatched targets (Cursor updated underneath the backup).
function pristineWorkbenchContent({ workbench, workbenchContent, workbenchAlreadyPatched, state, explicitPristineWorkbench = "" }) {
  if (explicitPristineWorkbench) return { content: explicitPristineWorkbench, source: "explicit" };
  if (!workbenchAlreadyPatched) return { content: workbenchContent, source: "as-is" };
  const entry = state?.workbench;
  if (hasBackupEntry(entry, workbench)) {
    const backupContent = fs.readFileSync(entry.backupPath, "utf8");
    if (!hasByokPatches(backupContent)) return { content: backupContent, source: "backup" };
    return { content: "", source: "patched-no-pristine", reason: "backup-not-pristine" };
  }
  return { content: "", source: "patched-no-pristine", reason: "backup-missing" };
}

function backupPreparedInstall(prepared) {
  const workbenchFromExplicit = prepared.workbenchAlreadyPatched && prepared.pristineSource === "explicit";
  const workbenchResult = ensureBackupEntry({
    existing: prepared.state?.workbench,
    targetPath: prepared.workbench,
    content: workbenchFromExplicit ? prepared.patchBaseContent : prepared.workbenchContent,
    canCapture: !prepared.workbenchAlreadyPatched || workbenchFromExplicit,
  });
  const existingExtHostEntry = prepared.state?.extHost && prepared.state.extHost.targetPath === prepared.extHost
    ? prepared.state.extHost
    : null;
  const extHostResult = prepared.extHostExists
    && prepared.extHostNeedsPatch
    ? ensureBackupEntry({
      existing: existingExtHostEntry,
      targetPath: prepared.extHost,
      content: prepared.extHostContent,
      canCapture: !hasByokPatches(prepared.extHostContent),
    })
    : { entry: existingExtHostEntry, created: false, warning: null };
  return {
    workbenchEntry: workbenchResult.entry,
    extHostEntry: extHostResult.entry,
    createdCount: Number(workbenchResult.created) + Number(extHostResult.created),
    warnings: [workbenchResult.warning, extHostResult.warning].filter(Boolean),
  };
}

function hasManagedHookBlock(content) {
  return content.includes(CLEAN_START) || content.includes(PREVIOUS_START) || content.includes(LEGACY_START);
}

// Pristine means pristine: no managed hook block AND no in-place BYOK patches.
// The marker-only check is not enough — older installer versions could leave
// in-place patches behind without a hook block, and capturing such content as
// a "pristine" backup is how backups get poisoned.
function hasByokPatches(content) {
  return hasManagedHookBlock(content) || content.includes("__cursorByok");
}

function stripManagedHookBlocks(content) {
  let next = content;
  next = stripMarkedBlock(next, CLEAN_START, CLEAN_END);
  next = stripMarkedBlock(next, PREVIOUS_START, PREVIOUS_END);
  next = stripMarkedBlock(next, LEGACY_START, LEGACY_END);
  return next;
}

function stripMarkedBlock(content, startMarker, endMarker) {
  for (;;) {
    const start = content.indexOf(startMarker);
    if (start < 0) return content;
    const end = content.indexOf(endMarker, start);
    if (end < 0) return content.slice(0, start);
    content = content.slice(0, start) + content.slice(end + endMarker.length);
    if (content.startsWith("\n")) content = content.slice(1);
  }
}

function patchWorkbenchContent(content, hook) {
  return patchWorkbenchContentWithStatus(content, hook).content;
}

function patchWorkbenchContentWithStatus(content, hook, { cursorVersion } = {}) {
  const plan = applyPatchPlan(stripManagedHookBlocks(content), { target: "workbench", cursorVersion });
  if (!hasActiveTransport(plan.report)) {
    throw new Error("Cursor BYOK install failed: no supported Cursor transport hook point found");
  }
  return {
    content: hook + plan.content,
    transportHookPoints: transportHookPoints(plan.report),
    patchedHookPoints: patchedHookPoints(plan.report),
    patchReport: plan.report,
  };
}

function patchTransportFactory(content) {
  return patchTransportFactoryWithStatus(content).content;
}

function patchTransportFactoryWithStatus(content, { cursorVersion } = {}) {
  const plan = applyPatchPlan(content, { names: TRANSPORT_PATCH_NAMES, cursorVersion });
  return {
    content: plan.content,
    hookPoints: transportHookPoints(plan.report),
    patchedHookPoints: patchedHookPoints(plan.report),
    hasActiveHook: hasActiveTransport(plan.report),
  };
}

function detectActiveTransportHookPoints(content) {
  return REGISTRY
    .filter((patch) => patch.severity === "transport" && patch.isActive && patch.isActive(content))
    .map((patch) => patch.name);
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const options = {
    workbench: process.env.CURSOR_WORKBENCH || WORKBENCH,
    extHost: process.env.CURSOR_EXT_HOST || EXT_HOST,
    allowPartial: args.has("--allow-partial"),
    cursorVersion: process.env.CURSOR_VERSION,
  };
  if (args.has("--restore")) {
    console.log(JSON.stringify(restoreWorkbenchHook(options), null, 2));
  } else if (args.has("--dry-run")) {
    const result = analyzeWorkbenchHookInstall(options);
    console.log(JSON.stringify(result, null, 2));
    const blocked = result.needsPristine
      || !(result.transportHookPoints || []).length
      || (result.missingCriticalPatches || []).length > 0;
    if (blocked) process.exitCode = 2;
  } else {
    console.log(JSON.stringify(installWorkbenchHook(options), null, 2));
  }
}

module.exports = {
  CLEAN_END,
  CLEAN_START,
  LEGACY_END,
  LEGACY_START,
  PREVIOUS_END,
  PREVIOUS_START,
  analyzeWorkbenchHookInstall,
  backupPreparedInstall,
  collectBackupWarnings,
  ensureBackupEntry,
  hasByokPatches,
  hasManagedHookBlock,
  installWorkbenchHook,
  patchAgentProviderRouterGuard,
  patchFirstTokenWarningThresholds,
  patchIntegrityWarning,
  patchLocalAgentRunForByok,
  patchModelPickerUnlock,
  patchStallDetectorCleanup,
  isStaleBackupEntry,
  stripManagedHookBlocks,
  validateWorkbenchSyntax,
  writeFileAtomically,
  patchContextRpcAgentClient,
  patchWorkbenchContent,
  patchWorkbenchContentWithStatus,
  patchPromiseClientFactory,
  patchTransportFactory,
  patchTransportFactoryWithStatus,
  prepareWorkbenchInstall,
  pristineWorkbenchContent,
  readHookInstallState,
  restoreWorkbenchHook,
  detectActiveTransportHookPoints,
  sha256Text,
  stripMarkedBlock,
  writeHookInstallState,
};
