"use strict";

const { applyEdits, findAnchors, methodAt, parseClassMethod, walk } = require("../workbench-patch-ast");

// The submitChat method name and the structured-log string literal survive
// minification across Cursor builds; only local identifiers churn. The seam
// is located by the method name, the method is parsed locally, and every
// identifier (flag, conversation, selected model, model details, submit
// options, request id) is read from the AST instead of guessed by regex
// backscans over the surrounding minified text.
//
// Newer builds split `submitChatMaybeAbortCurrent` into a thin public wrapper
// that delegates to a private `_submitChatMaybeAbortCurrent` carrying the
// router-guard seam. Both anchors are searched; candidate qualification (the
// seam actually being present) naturally selects whichever method owns it.
const SUBMIT_METHOD_ANCHORS = [
  { anchor: "async submitChatMaybeAbortCurrent(", head: /async submitChatMaybeAbortCurrent\(([^)]*)\)\{/ },
  { anchor: "async _submitChatMaybeAbortCurrent(", head: /async _submitChatMaybeAbortCurrent\(([^)]*)\)\{/ },
];

function patchAgentProviderRouterGuard(content) {
  // The method name may appear on more than one class; a site qualifies only
  // when its method actually contains the router-guard seam, and exactly one
  // site may qualify. Searching both the public and private method names lets
  // the patch follow the seam across the wrapper/private refactor.
  const candidates = [];
  for (const { anchor, head } of SUBMIT_METHOD_ANCHORS) {
    for (const idx of findAnchors(content, anchor)) {
      const method = methodAt(content, idx, head);
      if (!method) continue;
      const edited = patchSubmitMethodSource(method.source);
      if (edited !== null && edited !== method.source) candidates.push({ method, edited });
    }
  }
  if (candidates.length !== 1) return content;
  const { method, edited } = candidates[0];
  return content.slice(0, method.start) + edited + content.slice(method.end);
}

// Locates the `CONV.data.agentBackend` member expression anywhere under a
// node. The property names (`agentBackend`, `data`) are minification-stable;
// the conversation handle identifier is read from the AST.
function findAgentBackendMember(root) {
  let found = null;
  walk(root, (node) => {
    if (found) return false;
    if (node.type === "MemberExpression"
      && node.property?.type === "Identifier" && node.property.name === "agentBackend"
      && node.object?.type === "MemberExpression"
      && node.object.property?.type === "Identifier" && node.object.property.name === "data"
      && node.object.object?.type === "Identifier") {
      found = node;
      return false;
    }
  });
  return found;
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

  // Guard declaration. Two forms are supported:
  //   const FLAG=(CONV.data.agentBackend??"cursor-agent")!=="cursor-agent";
  // and the newer split form, where the backend value is bound to its own
  // declarator and the flag compares against that binding:
  //   const BD=CONV.data.agentBackend??"cursor-agent",FLAG=BD!=="cursor-agent";
  // The `agentBackend` member and the `"cursor-agent"` literal are stable; the
  // flag identifier and conversation handle come from the AST. The single form
  // rewrites the whole declaration; the split form edits only the flag
  // declarator's init so the backend binding (referenced later in the body)
  // is preserved.
  let guard = null;
  walk(body, (node) => {
    if (guard) return false;
    if (node.type !== "VariableDeclaration") return;
    for (let i = 0; i < node.declarations.length; i++) {
      const declarator = node.declarations[i];
      const init = declarator.init;
      if (declarator.id?.type !== "Identifier" || !init
        || init.type !== "BinaryExpression" || init.operator !== "!==") continue;
      if (init.right?.type !== "Literal" || init.right.value !== "cursor-agent") continue;
      // Old single form: LEFT directly carries CONV.data.agentBackend.
      const direct = findAgentBackendMember(init.left);
      if (direct) {
        guard = {
          flagVar: declarator.id.name,
          conversationVar: direct.object.object.name,
          backendExpression: methodSource.slice(toSourceIndex(init.left.start), toSourceIndex(init.left.end)),
          editStart: node.start,
          editEnd: node.end,
          form: "single",
        };
        return false;
      }
      // New split form: LEFT is an Identifier bound by an earlier declarator
      // in this declaration whose init carries CONV.data.agentBackend.
      if (init.left?.type === "Identifier") {
        const refName = init.left.name;
        const binding = i > 0
          ? node.declarations.slice(0, i).find((d) => d.id?.type === "Identifier" && d.id.name === refName)
          : null;
        const indirect = binding ? findAgentBackendMember(binding.init) : null;
        if (indirect) {
          guard = {
            flagVar: declarator.id.name,
            conversationVar: indirect.object.object.name,
            initSource: methodSource.slice(toSourceIndex(init.start), toSourceIndex(init.end)),
            editStart: init.start,
            editEnd: init.end,
            form: "split",
          };
          return false;
        }
      }
    }
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

  const byokGuardSuffix =
    `&&!(typeof globalThis.__cursorByokHasSubmitModelCandidate==="function"&&globalThis.__cursorByokHasSubmitModelCandidate(${selectedModelVar},${modelDetailsVar || "undefined"},${submitOptionsVar},${guard.conversationVar}.data))`;
  const guardStart = toSourceIndex(guard.editStart);
  let guardEnd = toSourceIndex(guard.editEnd);
  let replacement;
  if (guard.form === "single") {
    if (methodSource[guardEnd - 1] !== ";") {
      if (methodSource[guardEnd] !== ";") return null;
      guardEnd += 1;
    }
    replacement = `const ${guard.flagVar}=(${guard.backendExpression})!=="cursor-agent"${byokGuardSuffix};`;
  } else {
    replacement = `${guard.initSource}${byokGuardSuffix}`;
  }
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
