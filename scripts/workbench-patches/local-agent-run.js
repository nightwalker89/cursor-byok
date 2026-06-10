"use strict";

const { applyEdits, enclosingMethod, findAnchors, parseClassMethod, walk } = require("../workbench-patch-ast");

// The run-options literal (`clientSupportsInlineImages:!0`) is the
// minification-stable anchor; the enclosing `async run(` method is extracted
// and parsed so the options variable, localMode receiver, and selected-model
// parameter come from the AST instead of a single brittle mega-regex.
const RUN_OPTIONS_ANCHOR = "clientSupportsInlineImages:!0";
const RUN_METHOD_HEAD = /async run\(([^)]*)\)\{/;

function patchLocalAgentRunForByok(content) {
  const method = findRunMethod(content);
  if (!method) return content;
  const edited = patchRunMethodSource(method.source, method.headMatch[1]);
  if (edited === null || edited === method.source) return content;
  return content.slice(0, method.start) + edited + content.slice(method.end);
}

// The anchor also appears in nearby request literals (e.g. openPrewarmStream),
// so anchor sites are disambiguated by their enclosing method: exactly one
// distinct `async run(` method may contain anchor sites.
function findRunMethod(content) {
  const methods = new Map();
  for (const anchor of findAnchors(content, RUN_OPTIONS_ANCHOR)) {
    const method = enclosingMethod(content, anchor, RUN_METHOD_HEAD, 4096);
    if (method) methods.set(method.start, method);
  }
  if (methods.size !== 1) return null;
  return methods.values().next().value;
}

function patchRunMethodSource(methodSource, runParams) {
  const parsed = parseClassMethod(methodSource);
  if (!parsed) return null;
  const { method, toSourceIndex } = parsed;
  const statements = method.value.body?.body || [];

  // The run-options declaration — const OPTS={...m,isRunningInTest:…,
  // clientSupportsInlineImages:!0,…}; — located by shape, not statement
  // position, with properties checked by membership so builds that insert
  // statements or append options keep matching.
  const optionsIndex = statements.findIndex(isRunOptionsDeclaration);
  if (optionsIndex < 0) return null;
  const optionsVar = statements[optionsIndex].declarations[0].id.name;

  // The branch BYOK models must skip: the first top-level if(X.localMode){…}
  // after the options declaration.
  const localModeIf = statements.find((statement, index) => index > optionsIndex && isLocalModeIf(statement));
  if (!localModeIf) return null;
  const test = localModeIf.test;

  const selectedModelVar = localAgentSelectedModelVar(runParams, optionsVar);
  const selectedArg = selectedModelVar || "undefined";
  const byokGuard =
    `typeof globalThis.__cursorByokHasRunOptionsModelCandidate==="function"&&globalThis.__cursorByokHasRunOptionsModelCandidate(${optionsVar},${selectedArg})`;
  return applyEdits(methodSource, [{
    start: toSourceIndex(test.start),
    end: toSourceIndex(test.end),
    replacement: `${test.object.name}.localMode&&!(${byokGuard})`,
  }]);
}

// Builds older than the local-mode feature (e.g. 3.3.30, which has no
// `localMode` build flag and no runLocalAgentInExtensionHost) have nothing to
// patch: the run method builds options and forwards them straight to
// `this.client.run(...)`, the transport path the BYOK hook already intercepts.
// The shape check is strict — any branch after the options declaration means
// a route this analysis does not understand, and the patch keeps reporting
// "absent" (loud) instead of silently passing.
function isLocalAgentRunPatchUnnecessary(content) {
  const method = findRunMethod(content);
  if (!method) return false;
  const parsed = parseClassMethod(method.source);
  if (!parsed) return false;
  const statements = parsed.method.value.body?.body || [];
  const optionsIndex = statements.findIndex(isRunOptionsDeclaration);
  if (optionsIndex < 0) return false;
  const optionsVar = statements[optionsIndex].declarations[0].id.name;
  const rest = statements.slice(optionsIndex + 1);
  if (rest.some(containsBranch)) return false;
  const returns = [];
  for (const statement of rest) {
    walk(statement, (node) => {
      if (node.type === "ReturnStatement") returns.push(node);
      if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return false;
    });
  }
  return returns.length === 1 && isForwardingRunCall(returns[0].argument, optionsVar);
}

function containsBranch(statement) {
  let branched = false;
  walk(statement, (node) => {
    if (node.type === "IfStatement" || node.type === "SwitchStatement" || node.type === "ConditionalExpression") {
      branched = true;
      return false;
    }
  });
  return branched;
}

function isForwardingRunCall(node, optionsVar) {
  const call = node?.type === "AwaitExpression" ? node.argument : node;
  if (call?.type !== "CallExpression") return false;
  const callee = call.callee;
  if (callee?.type !== "MemberExpression" || callee.computed || callee.property?.name !== "run") return false;
  return call.arguments.some((argument) => argument.type === "Identifier" && argument.name === optionsVar);
}

function isRunOptionsDeclaration(statement) {
  if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return false;
  const declarator = statement.declarations[0];
  if (declarator.id?.type !== "Identifier" || declarator.init?.type !== "ObjectExpression") return false;
  const properties = declarator.init.properties;
  return properties[0]?.type === "SpreadElement"
    && hasNamedProperty(properties, "isRunningInTest")
    && hasNamedProperty(properties, "clientSupportsInlineImages");
}

function isLocalModeIf(statement) {
  if (statement.type !== "IfStatement") return false;
  const test = statement.test;
  return test?.type === "MemberExpression" && !test.computed
    && test.property?.name === "localMode" && test.object?.type === "Identifier";
}

function hasNamedProperty(properties, name) {
  return properties.some((property) => property.type === "Property" && property.key?.name === name);
}

function localAgentSelectedModelVar(runParams, optionsVar) {
  const params = String(runParams || "").split(",");
  const candidate = params[3]?.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(candidate || "") || candidate === optionsVar) return "";
  return candidate;
}

module.exports = {
  isLocalAgentRunPatchUnnecessary,
  patchLocalAgentRunForByok,
  localAgentSelectedModelVar,
  patch: {
    name: "local-agent-run",
    targets: ["workbench"],
    severity: "critical",
    isActive: (content) => content.includes("__cursorByokHasRunOptionsModelCandidate("),
    isNotNeeded: isLocalAgentRunPatchUnnecessary,
    apply: patchLocalAgentRunForByok,
  },
};
