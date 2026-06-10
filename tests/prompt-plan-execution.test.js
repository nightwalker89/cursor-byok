"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PLAN_EXECUTION_INSTRUCTION_BODY,
  buildPlanExecutionInstruction,
  buildPlanExecutionProviderMessage,
  extractPlanTitleFromContent,
  isCloudPlanExecutionRequest,
} = require("../src/runtime/prompt");

test("extractPlanTitleFromContent reads markdown H1", () => {
  assert.equal(extractPlanTitleFromContent("# Ship It\n\nbody"), "Ship It");
  assert.equal(extractPlanTitleFromContent("plain", "Fallback"), "plain");
  assert.equal(extractPlanTitleFromContent("", "Fallback"), "Fallback");
});

test("buildPlanExecutionInstruction matches Cursor local build prompt", () => {
  assert.equal(
    buildPlanExecutionInstruction({ planTitle: "Ship It", isCloud: false }),
    PLAN_EXECUTION_INSTRUCTION_BODY,
  );
});

test("buildPlanExecutionInstruction prefixes title for cloud build", () => {
  assert.equal(
    buildPlanExecutionInstruction({ planTitle: "Ship It", isCloud: true }),
    `Ship It\n\n${PLAN_EXECUTION_INSTRUCTION_BODY}`,
  );
});

test("buildPlanExecutionProviderMessage inlines attached plan for BYOK providers", () => {
  const message = buildPlanExecutionProviderMessage("# plan\n- do thing", { isCloud: false });
  assert.equal(message.role, "user");
  assert.match(message.content, /Implement the plan as specified/);
  assert.match(message.content, /# plan\n- do thing$/);
});

test("isCloudPlanExecutionRequest detects background plan builds", () => {
  assert.equal(isCloudPlanExecutionRequest({ pendingBackgroundAgent: true }), true);
  assert.equal(isCloudPlanExecutionRequest({ unifiedMode: "background" }), true);
  assert.equal(isCloudPlanExecutionRequest({ isPlanExecution: true }), false);
});