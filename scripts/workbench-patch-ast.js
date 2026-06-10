"use strict";

// Stable-anchor + local-AST patching primitives. Instead of matching whole
// minified regions with regexes (which couple the patch to every identifier
// in the region), callers locate a seam by a minification-stable anchor
// (string literals, property/method names), extract the enclosing method with
// tokenizer-accurate brace matching, parse just that method, and splice edits
// by AST node ranges. Identifier renames between Cursor builds then stop
// mattering; only genuine structural changes make a patch report "absent".
const acorn = require("acorn");

function findAnchors(content, anchor) {
  const indices = [];
  let idx = content.indexOf(anchor);
  while (idx >= 0) {
    indices.push(idx);
    idx = content.indexOf(anchor, idx + 1);
  }
  return indices;
}

function lastRegexMatch(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let match = null;
  for (;;) {
    const next = regex.exec(text);
    if (!next) return match;
    match = next;
  }
}

// Finds the index just past the brace that closes the one at openBraceIdx.
// Tokenizing (rather than counting characters) keeps braces inside strings,
// regex literals, and template literals from corrupting the depth count.
const OPEN_BRACE_LABELS = new Set(["{", "${"]);

function matchBracesFrom(content, openBraceIdx, maxLength = 2 * 1024 * 1024) {
  const slice = content.slice(openBraceIdx, openBraceIdx + maxLength);
  const tokenizer = acorn.tokenizer(slice, { ecmaVersion: "latest" });
  let depth = 0;
  for (;;) {
    let token;
    try {
      token = tokenizer.getToken();
    } catch {
      return -1;
    }
    if (token.type.label === "eof") return -1;
    if (OPEN_BRACE_LABELS.has(token.type.label)) {
      depth += 1;
    } else if (token.type.label === "}") {
      depth -= 1;
      if (depth === 0) return openBraceIdx + token.end;
      if (depth < 0) return -1;
    }
  }
}

// Extracts the method whose head starts exactly at headStart. headPattern must
// end with the opening brace (e.g. /async run\(([^)]*)\)\{/).
function methodAt(content, headStart, headPattern) {
  const sticky = new RegExp(headPattern.source, "y");
  sticky.lastIndex = headStart;
  const headMatch = sticky.exec(content);
  if (!headMatch) return null;
  const braceIdx = headStart + headMatch[0].length - 1;
  const end = matchBracesFrom(content, braceIdx);
  if (end < 0) return null;
  return { start: headStart, end, headMatch, source: content.slice(headStart, end) };
}

// Extracts the nearest method head matching headPattern before anchorIdx and
// requires the anchor to fall inside the method body.
function enclosingMethod(content, anchorIdx, headPattern, windowSize = 65536) {
  const windowStart = Math.max(0, anchorIdx - windowSize);
  const head = lastRegexMatch(content.slice(windowStart, anchorIdx), headPattern);
  if (!head) return null;
  const method = methodAt(content, windowStart + head.index, headPattern);
  if (!method || method.end <= anchorIdx) return null;
  return method;
}

// Parses a single extracted class-method source ("async name(...){...}",
// generators included). Returns the MethodDefinition node plus a mapper from
// AST positions back to methodSource indices.
const METHOD_WRAP_PREFIX = "(class{";

function parseClassMethod(methodSource) {
  let program;
  try {
    program = acorn.parse(METHOD_WRAP_PREFIX + methodSource + "})", { ecmaVersion: "latest" });
  } catch {
    return null;
  }
  const classBody = program.body[0]?.expression?.body?.body;
  if (!Array.isArray(classBody) || classBody.length !== 1 || classBody[0].type !== "MethodDefinition") return null;
  return {
    method: classBody[0],
    toSourceIndex: (position) => position - METHOD_WRAP_PREFIX.length,
  };
}

// Minimal AST walker (document order). Returning false from visit prunes the
// node's children.
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") walk(child, visit);
      }
    } else if (value && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

function findFirst(root, predicate) {
  let found = null;
  walk(root, (node) => {
    if (found) return false;
    if (predicate(node)) {
      found = node;
      return false;
    }
  });
  return found;
}

// Applies non-overlapping {start, end, replacement} edits (start === end
// inserts) against the original source coordinates.
function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

module.exports = {
  applyEdits,
  enclosingMethod,
  findAnchors,
  findFirst,
  lastRegexMatch,
  matchBracesFrom,
  methodAt,
  parseClassMethod,
  walk,
};
