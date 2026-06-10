"use strict";

// Opt-in smoke test against the actually installed Cursor bundle:
//   BYOK_LIVE_PREFLIGHT=1 node --test tests/byok-workbench-preflight-live.test.js
// Skipped in CI and on machines without Cursor. This is the regression net for
// real Cursor updates: it fails when a critical patch seam stops matching the
// installed build.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const WORKBENCH = "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js";
const enabled = process.env.BYOK_LIVE_PREFLIGHT === "1" && fs.existsSync(WORKBENCH);

test("live Cursor bundle preflight reports an installable or honestly blocked state", { skip: !enabled }, () => {
  const { analyzeWorkbenchHookInstall } = require("../scripts/install-workbench-hook");
  const result = analyzeWorkbenchHookInstall();
  if (result.needsPristine) {
    // Blocked is acceptable only when preflight says exactly why.
    assert.equal(result.pristineSource, "patched-no-pristine");
    assert.equal(result.backupWarnings.length > 0, true);
    return;
  }
  assert.equal(result.transportHookPoints.length > 0, true, JSON.stringify(result.patchReport));
  assert.deepEqual(result.missingCriticalPatches, [], JSON.stringify(result.patchReport));
});
