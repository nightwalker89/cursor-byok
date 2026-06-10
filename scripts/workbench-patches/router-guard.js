"use strict";

const { applyEdits, findAnchors, methodAt, parseClassMethod, walk } = require("../workbench-patch-ast");

// The submitChat method name and the structured-log string literal survive
// minification across Cursor builds; only local identifiers churn. The seam
// is located by the method name, the method is parsed locally, and every
// identifier (flag, conversation, selected model, model details, submit
// options, request id) is read from the AST instead of guessed by regex
// backscans over the surrounding minified text.
const SUBMIT_METHOD_ANCHOR = "async submitChatMaybeAbortCurrent(";
const SUBMIT_METHOD_HEAD = /async submitChatMaybeAbortCurrent\(([^)]*)\)\{/;

function patchAgentProviderRouterGuard(content) {
  // The method name may appear on more than one class; a site qualifies only
  // when its method actually contains the router-guard seam, and exactly one
  // site may qualify.
  const candidates = [];
  for (const anchor of findAnchors(content, SUBMIT_METHOD_ANCHOR)) {
    const method = methodAt(content, anchor, SUBMIT_METHOD_HEAD);
    if (!method) continue;
    const edited = patchSubmitMethodSource(method.source);
    if (edited !== null && edited !== method.source) candidates.push({ method, edited });
  }
  if (candidates.length !== 1) return content;
  const { method, edited } = candidates[0];
  return content.slice(0, method.start) + edited + content.slice(method.end);
}

function patchSubmitMethodSource(methodSource) {
  const parsed = parseClassMethod(methodSource);
  if (!parsed) return null;
  const { method, toSourceIndex } = parsed;
  const body = method.value.body;

  // Submit options: the identifier read as `X?._internalTurnTracker`, falling
  // back to the method's last plain parameter.
  let submitOptionsVar = "";
  walk(body, (node) => {
    if (submitOptionsVar) return false;
    if (node.type === "MemberExpression"
      && node.property?.type === "Identifier"
      && node.property.name === "_internalTurnTracker"
      && node.object?.type === "Identifier") {
      submitOptionsVar = node.object.name;
    }
  });
  if (!submitOptionsVar) {
    const params = method.value.params.filter((param) => param.type === "Identifier");
    submitOptionsVar = params.at(-1)?.name || "";
  }
  if (!submitOptionsVar) return null;

  // Guard declaration: const FLAG=(CONV.data.agentBackend??"cursor-agent")!=="cursor-agent";
  let guard = null;
  walk(body, (node) => {
    if (guard) return false;
    if (node.type !== "VariableDeclaration" || node.declarations.length !== 1) return;
    const declarator = node.declarations[0];
    const init = declarator.init;
    if (declarator.id?.type !== "Identifier" || !init || init.type !== "BinaryExpression" || init.operator !== "!==") return;
    if (init.right?.type !== "Literal" || init.right.value !== "cursor-agent") return;
    let agentBackendMember = null;
    walk(init.left, (left) => {
      if (agentBackendMember) return false;
      if (left.type === "MemberExpression"
        && left.property?.type === "Identifier" && left.property.name === "agentBackend"
        && left.object?.type === "MemberExpression"
        && left.object.property?.type === "Identifier" && left.object.property.name === "data"
        && left.object.object?.type === "Identifier") {
        agentBackendMember = left;
      }
    });
    if (!agentBackendMember) return;
    guard = {
      node,
      flagVar: declarator.id.name,
      left: init.left,
      conversationVar: agentBackendMember.object.object.name,
    };
  });
  if (!guard) return null;

  // Selected model: the argument of the Claude-Code compatibility check. The
  // call name is the stable anchor; the surrounding if/throw scaffolding is
  // incidental and is not required.
  let selectedModelVar = "";
  walk(body, (node) => {
    if (selectedModelVar) return false;
    if (node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && node.callee.property?.name === "isModelCompatibleWithClaudeCodeBackend"
      && node.arguments[0]?.type === "Identifier") {
      selectedModelVar = node.arguments[0].name;
    }
  });
  if (!selectedModelVar) return null;

  // The structured-log call carrying the request id; the composer-mode capture
  // is inserted right after it when present. Its modelName:DETAILS.modelName
  // property is also the primary source of the model-details identifier.
  let logStmt = null;
  let requestIdVar = "";
  let modelDetailsVar = "";
  walk(body, (node) => {
    if (logStmt) return false;
    if (node.type !== "ExpressionStatement" || node.expression?.type !== "CallExpression") return;
    const callee = node.expression.callee;
    if (callee?.type !== "MemberExpression" || callee.property?.name !== "info") return;
    const args = node.expression.arguments;
    if (args[0]?.value !== "composer" || args[1]?.value !== "Starting stream request") return;
    const objectArg = args[2]?.type === "ObjectExpression" ? args[2] : null;
    const requestIdProp = objectArg?.properties.find((property) =>
      property.type === "Property" && property.key?.name === "requestId" && property.value?.type === "Identifier");
    if (!requestIdProp) return;
    logStmt = node;
    requestIdVar = requestIdProp.value.name;
    const modelNameProp = objectArg.properties.find((property) =>
      property.type === "Property" && property.key?.name === "modelName"
      && property.value?.type === "MemberExpression" && property.value.property?.name === "modelName"
      && property.value.object?.type === "Identifier");
    if (modelNameProp) modelDetailsVar = modelNameProp.value.object.name;
  });

  // Fallback source: DETAILS.modelName??… in the incompatible-model throw.
  // modelDetails is one of several candidate sources hook-side, so when no
  // source matches the patch degrades that one signal instead of going absent.
  if (!modelDetailsVar) {
    walk(body, (node) => {
      if (modelDetailsVar) return false;
      if (node.type === "LogicalExpression" && node.operator === "??"
        && node.left?.type === "MemberExpression" && node.left.property?.name === "modelName"
        && node.left.object?.type === "Identifier") {
        modelDetailsVar = node.left.object.name;
      }
    });
  }

  const backendExpression = methodSource.slice(toSourceIndex(guard.left.start), toSourceIndex(guard.left.end));
  const guardStart = toSourceIndex(guard.node.start);
  let guardEnd = toSourceIndex(guard.node.end);
  if (methodSource[guardEnd - 1] !== ";") {
    if (methodSource[guardEnd] !== ";") return null;
    guardEnd += 1;
  }
  const replacement =
    `const ${guard.flagVar}=(${backendExpression})!=="cursor-agent"&&!(typeof globalThis.__cursorByokHasSubmitModelCandidate==="function"&&globalThis.__cursorByokHasSubmitModelCandidate(${selectedModelVar},${modelDetailsVar || "undefined"},${submitOptionsVar},${guard.conversationVar}.data));`;
  const edits = [{ start: guardStart, end: guardEnd, replacement }];
  if (logStmt && requestIdVar) {
    let insertAt = toSourceIndex(logStmt.end);
    if (methodSource[insertAt] === ";") insertAt += 1;
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement:
        `if(typeof globalThis.__cursorByokRememberComposerMode==="function")try{globalThis.__cursorByokRememberComposerMode(${requestIdVar},${guard.conversationVar}.data&&${guard.conversationVar}.data.unifiedMode)}catch(e){}`,
    });
  }
  return applyEdits(methodSource, edits);
}

module.exports = {
  patchAgentProviderRouterGuard,
  patch: {
    name: "router-guard",
    targets: ["workbench"],
    severity: "critical",
    isActive: (content) => content.includes("__cursorByokHasSubmitModelCandidate("),
    apply: patchAgentProviderRouterGuard,
  },
};
