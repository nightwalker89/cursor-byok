"use strict";

const acorn = require("acorn");
const { REGISTRY, TRANSPORT_PATCH_NAMES } = require("./workbench-patches");

// Runs the registry over `content` and reports per-patch status. The engine
// never throws on missing seams — policy (which absences are fatal) lives in
// the installer, so dry-run analysis and real installs share one code path.
// Statuses:
// - "applied":        the patch changed the content in this run
// - "active":         the patch's output is already present (detectable only
//                     for patches with an isActive probe)
// - "not-needed":     an isNotNeeded probe confirmed the build lacks the
//                     behavior the patch neutralizes (e.g. pre-local-mode
//                     builds for local-agent-run), so absence is not a failure
// - "absent":         the patch did not match this content
// - "skipped-target": the patch does not apply to the requested target
function applyPatchPlan(content, { target, names, cursorVersion } = {}) {
  const report = [];
  for (const patch of REGISTRY) {
    if (names && !names.includes(patch.name)) continue;
    if (target && !patch.targets.includes(target)) {
      report.push({ name: patch.name, severity: patch.severity, status: "skipped-target" });
      continue;
    }
    const matchContext = { target, cursorVersion };
    const matchVersion = patch.matchVersion?.(matchContext) || null;
    const reportEntry = (status) => ({
      name: patch.name,
      severity: patch.severity,
      status,
      ...(matchVersion ? { matchVersion } : {}),
    });
    const next = patch.apply(content, matchContext);
    if (next !== content) {
      content = next;
      report.push(reportEntry("applied"));
    } else if (patch.isActive && patch.isActive(content)) {
      report.push(reportEntry("active"));
    } else if (patch.isNotNeeded && patch.isNotNeeded(content)) {
      report.push(reportEntry("not-needed"));
    } else {
      report.push(reportEntry("absent"));
    }
  }
  return { content, report };
}

function transportHookPoints(report) {
  return report
    .filter((entry) => entry.severity === "transport" && (entry.status === "applied" || entry.status === "active"))
    .map((entry) => entry.name);
}

function patchedHookPoints(report) {
  return report
    .filter((entry) => entry.severity === "transport" && entry.status === "applied")
    .map((entry) => entry.name);
}

function hasActiveTransport(report) {
  return transportHookPoints(report).length > 0;
}

function missingCriticalPatches(report) {
  return report
    .filter((entry) => entry.severity === "critical" && entry.status === "absent")
    .map((entry) => entry.name);
}

function optionalPatchWarnings(report) {
  return report
    .filter((entry) => entry.severity === "optional" && entry.status === "absent")
    .map((entry) => `optional patch ${entry.name} did not apply to this Cursor build`);
}

function validateWorkbenchSyntax(content, targetPath = "workbench.desktop.main.js") {
  try {
    acorn.parse(content, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
  } catch (error) {
    const loc = error.loc ? `:${error.loc.line}:${error.loc.column}` : "";
    throw new Error(`Cursor BYOK install failed: patched workbench syntax check failed for ${targetPath}${loc}\n${error.message}`);
  }
}

module.exports = {
  REGISTRY,
  TRANSPORT_PATCH_NAMES,
  applyPatchPlan,
  hasActiveTransport,
  missingCriticalPatches,
  optionalPatchWarnings,
  patchedHookPoints,
  transportHookPoints,
  validateWorkbenchSyntax,
};
