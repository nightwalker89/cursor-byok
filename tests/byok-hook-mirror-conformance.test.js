"use strict";

// The hook test helpers in src/workbench-hook.js duplicate production functions
// from inside hookRuntime() with a ForTest suffix, because hookRuntime is
// shipped as serialized source (hookRuntime.toString()) and its inner closures
// cannot be imported directly. Historically the two copies drifted apart
// (e.g. `||` vs `??` isProject coalescing, a missing execClientMessage branch,
// a scope-less todo store), which let production regressions pass every mirror
// test. This suite locks each ForTest mirror to its production counterpart at
// the source level: any future edit to one copy without the other fails here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const HOOK_SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "workbench-hook.js"), "utf8");
const MIRROR_START = HOOK_SOURCE.indexOf("function createHookRuntimeHelpersForTest");

function findFunctionSource(name, { before, after } = {}) {
  const pattern = new RegExp(`(^|\\n)([ \\t]*)function ${name}\\(`, "g");
  let match;
  while ((match = pattern.exec(HOOK_SOURCE)) !== null) {
    const start = match.index + match[1].length;
    if (before !== undefined && start >= before) continue;
    if (after !== undefined && start < after) continue;
    const braceStart = HOOK_SOURCE.indexOf("{", pattern.lastIndex - 1);
    let depth = 0;
    for (let i = braceStart; i < HOOK_SOURCE.length; i++) {
      const char = HOOK_SOURCE[i];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return HOOK_SOURCE.slice(start, i + 1);
      }
    }
  }
  return null;
}

function normalizeFunctionSource(source) {
  return source
    .replace(/ForTest/g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mirrorFunctionNames() {
  const names = new Set();
  const pattern = /function (\w+)ForTest\(/g;
  let match;
  while ((match = pattern.exec(HOOK_SOURCE.slice(MIRROR_START))) !== null) {
    if (match[1] !== "createHookRuntimeHelpers") names.add(match[1]);
  }
  return [...names].sort();
}

test("hook test mirror exists and is non-trivial", () => {
  assert.notEqual(MIRROR_START, -1);
  const names = mirrorFunctionNames();
  // The mirror covers the hook's pure mapping helpers; a sharp drop means the
  // extraction regex broke, not that the mirror legitimately shrank.
  assert.equal(names.length >= 40, true, `only ${names.length} mirror functions found`);
});

test("every ForTest mirror function matches its production hookRuntime source", () => {
  const names = mirrorFunctionNames();
  const missingProduction = [];
  const drifted = [];
  for (const name of names) {
    const production = findFunctionSource(name, { before: MIRROR_START });
    const mirror = findFunctionSource(`${name}ForTest`, { after: MIRROR_START });
    assert.notEqual(mirror, null, `mirror ${name}ForTest not extractable`);
    if (production === null) {
      missingProduction.push(name);
      continue;
    }
    if (normalizeFunctionSource(production) !== normalizeFunctionSource(mirror)) {
      drifted.push(name);
    }
  }
  assert.deepEqual(
    missingProduction,
    [],
    `mirror functions without a production counterpart (rename or delete them): ${missingProduction.join(", ")}`,
  );
  assert.deepEqual(
    drifted,
    [],
    `mirror functions drifted from production (copy the production body, suffixing helper identifiers with ForTest): ${drifted.join(", ")}`,
  );
});
