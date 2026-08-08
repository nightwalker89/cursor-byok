"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parseCursorVersion(value) {
  const match = typeof value === "string" && value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareCursorVersions(left, right) {
  const leftParts = parseCursorVersion(left);
  const rightParts = parseCursorVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

// Match definitions are introduced at the Cursor version whose minified shape
// they were captured from. Later Cursor versions intentionally select the most
// recent known definition until a newer build proves that the seam changed.
function latestKnownCursorMatch(matches, cursorVersion) {
  const known = matches
    .filter((entry) => parseCursorVersion(entry.cursorVersion))
    .slice()
    .sort((left, right) => compareCursorVersions(left.cursorVersion, right.cursorVersion));
  if (!known.length) return null;

  const current = parseCursorVersion(cursorVersion);
  if (!current) return known.at(-1);
  return known.filter((entry) => compareCursorVersions(entry.cursorVersion, cursorVersion) <= 0).at(-1) || null;
}

function cursorAppPathForWorkbench(workbenchPath) {
  const resolved = path.resolve(workbenchPath);
  const parts = resolved.split(path.sep);
  const contentsIndex = parts.lastIndexOf("Contents");
  if (contentsIndex <= 0) return "";
  return parts.slice(0, contentsIndex).join(path.sep) || path.sep;
}

function readCursorVersion(workbenchPath) {
  const appPath = cursorAppPathForWorkbench(workbenchPath);
  if (!appPath) return "";
  try {
    const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    const version = match?.[1]?.trim() || "";
    return parseCursorVersion(version) ? version : "";
  } catch {
    return "";
  }
}

function resolveCursorVersion(workbenchPath, configuredVersion = "") {
  return parseCursorVersion(configuredVersion) ? configuredVersion.trim() : readCursorVersion(workbenchPath);
}

module.exports = {
  compareCursorVersions,
  cursorAppPathForWorkbench,
  latestKnownCursorMatch,
  parseCursorVersion,
  readCursorVersion,
  resolveCursorVersion,
};
