"use strict";

// Ordered patch registry. Order matters: in-place behavior patches run before
// the transport seams, mirroring the original hand-written patch pipeline.
// Severity drives install policy:
// - "transport": at least one transport patch must be applied or active on the
//   workbench target, or the install fails (no usable hook seam).
// - "critical": BYOK routing is functionally degraded without it; install
//   fails unless allowPartial is set.
// - "optional": quality-of-life patch; absence is reported as a warning.
const integrityWarning = require("./integrity-warning");
const stallDetector = require("./stall-detector");
const firstTokenThresholds = require("./first-token-thresholds");
const routerGuard = require("./router-guard");
const localAgentRun = require("./local-agent-run");
const modelPickerUnlock = require("./model-picker-unlock");
const transportPromiseClient = require("./transport-promise-client");
const transportContextRpc = require("./transport-context-rpc");

const REGISTRY = [
  integrityWarning.patch,
  stallDetector.patch,
  firstTokenThresholds.patch,
  routerGuard.patch,
  localAgentRun.patch,
  modelPickerUnlock.patch,
  transportPromiseClient.patch,
  transportContextRpc.patch,
];

const TRANSPORT_PATCH_NAMES = REGISTRY
  .filter((patch) => patch.severity === "transport")
  .map((patch) => patch.name);

module.exports = {
  REGISTRY,
  TRANSPORT_PATCH_NAMES,
};
