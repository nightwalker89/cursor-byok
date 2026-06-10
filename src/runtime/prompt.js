"use strict";

const fs = require("node:fs");
const path = require("node:path");

function byokSystemPromptPath() {
  return path.resolve(__dirname, "..", "..", "byok-system-prompt.md");
}

function loadByokSystemPrompt() {
  return fs.readFileSync(byokSystemPromptPath(), "utf8").trim();
}

function formatWorkspaceRootsPromptSection(workspaceRoots) {
  const roots = Array.isArray(workspaceRoots)
    ? workspaceRoots.filter((value) => typeof value === "string" && value)
    : [];
  if (!roots.length) return "";
  return [
    "<cursor_workspace_context>",
    "- Current workspace roots are listed below. Treat these as the default project scope for repository exploration.",
    "- Prefer searching, listing, and reading within these workspace roots. Do not list `/` or other filesystem roots to discover the repository when these roots are available.",
    ...roots.map((root) => `- ${root}`),
    "</cursor_workspace_context>",
  ].join("\n");
}

const PLAN_EXECUTION_INSTRUCTION_BODY = `Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.`;

const PLAN_MODE_PROMPT_RULES = `<cursor_byok_plan_mode>
- Current Cursor composer mode is plan. Treat this as a planning-only collaboration mode, not an execution request.
- Do not implement the plan, edit files, apply patches, run mutating formatters/codegen/migrations, or perform side-effectful commands whose purpose is doing the work.
- You may use non-mutating tools to ground the plan: search/read files, inspect configs/types/docs, run dry-run checks, and run tests/builds only when they do not change repo-tracked files.
- Start by grounding yourself in the actual environment. Resolve discoverable facts through targeted exploration before asking the user.
- Ask the user only for high-impact intent, scope, constraint, or tradeoff decisions that cannot be discovered from the repo or environment. Use AskQuestion when available.
- Internal todo/checklist tools are for progress tracking only; they are not the final plan artifact.
- Do not call CreatePlan until the plan is decision-complete: goal, success criteria, key approach, interfaces/data flow, edge cases, tests, assumptions, and important constraints are settled.
- To deliver the final plan, call CreatePlan once with the complete user-visible plan artifact; do not put it in normal assistant text.
- Cursor composes the .plan.md artifact from structured CreatePlan fields: name, overview, todos, isProject, and phases go to YAML frontmatter and render as structured UI sections; the plan string becomes the markdown body below the frontmatter.
- Set overview to one concise paragraph summarizing goal and approach. Put implementation steps in todos, and use phases when the work naturally splits into stages. Todo items use id, content, optional status, optional dependencies. Do not duplicate the todo checklist inside plan.
- Write plan as markdown: start with a single # title, then ## sections such as Goals, Key Changes, Test Plan, and Assumptions when appropriate. Use lists, code fences, and mermaid only when they help. Do not use plain-text section labels without markdown headings in plan.
- Do not ask whether to proceed after creating the plan. After CreatePlan succeeds, do not continue with normal assistant text.
</cursor_byok_plan_mode>`;

function extractPlanTitleFromContent(planContent, fallbackName = "") {
  const firstLine = String(planContent || "").split("\n")[0]?.trim() || "";
  const title = firstLine.startsWith("#") ? firstLine.slice(1).trim() : firstLine;
  const fallback = String(fallbackName || "").trim();
  return title || fallback || "Untitled Plan";
}

function buildPlanExecutionInstruction(options = {}) {
  const title = String(options.planTitle || "").trim();
  if (options.isCloud && title) {
    return `${title}\n\n${PLAN_EXECUTION_INSTRUCTION_BODY}`;
  }
  return PLAN_EXECUTION_INSTRUCTION_BODY;
}

function buildPlanExecutionProviderMessage(planFileContent, options = {}) {
  const content = String(planFileContent || "").trim();
  const planTitle = extractPlanTitleFromContent(content, options.planName);
  const instruction = buildPlanExecutionInstruction({
    planTitle,
    isCloud: !!options.isCloud,
  });
  if (!content) {
    return { role: "user", content: instruction };
  }
  return { role: "user", content: `${instruction}\n\n${content}` };
}

function isCloudPlanExecutionRequest(request) {
  if (!request || typeof request !== "object") return false;
  if (request.pendingBackgroundAgent === true) return true;
  const mode = typeof request.unifiedMode === "string"
    ? request.unifiedMode
    : typeof request.mode === "string"
      ? request.mode
      : "";
  return mode === "background";
}

function appendByokPromptRules(systemPrompt, modelId, providersConfig, isByokModel, options = {}) {
  if (!isByokModel(modelId, providersConfig)) return systemPrompt;
  const rules = loadByokSystemPrompt();
  const chunks = [systemPrompt.replace(/\s+$/, "")];
  if (!systemPrompt.includes("<cursor_byok_prompt_compatibility>")) chunks.push(rules);
  const workspaceContext = formatWorkspaceRootsPromptSection(options.workspaceRoots);
  if (workspaceContext && !systemPrompt.includes("<cursor_workspace_context>")) chunks.push(workspaceContext);
  if (options?.composerMode === "plan" && !systemPrompt.includes("<cursor_byok_plan_mode>")) {
    chunks.push(PLAN_MODE_PROMPT_RULES);
  }
  return chunks.join("\n\n");
}

function sanitizeProviderVisiblePromptText(text, providerType) {
  if (typeof text !== "string") return text;
  if (providerType && providerType !== "anthropic") return text;
  return text
    .replaceAll("ReadFile", "Read")
    .replaceAll("read_file", "Read")
    .replaceAll("filePath", "an unsupported alternate key");
}

module.exports = {
  appendByokPromptRules,
  buildPlanExecutionInstruction,
  buildPlanExecutionProviderMessage,
  byokSystemPromptPath,
  extractPlanTitleFromContent,
  formatWorkspaceRootsPromptSection,
  isCloudPlanExecutionRequest,
  loadByokSystemPrompt,
  PLAN_EXECUTION_INSTRUCTION_BODY,
  PLAN_MODE_PROMPT_RULES,
  sanitizeProviderVisiblePromptText,
};
