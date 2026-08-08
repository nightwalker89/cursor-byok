"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareCursorVersions,
  latestKnownCursorMatch,
  readCursorVersion,
} = require("../scripts/cursor-version");
const { contextRpcMatchForCursorVersion } = require("../scripts/workbench-patches/transport-context-rpc");

test("later Cursor versions use the newest known context-rpc match", () => {
  assert.equal(contextRpcMatchForCursorVersion("3.15.5").cursorVersion, "0.0.0");
  assert.equal(contextRpcMatchForCursorVersion("3.15.6").cursorVersion, "3.15.6");
  assert.equal(contextRpcMatchForCursorVersion("3.16.0").cursorVersion, "3.15.6");
  assert.equal(contextRpcMatchForCursorVersion("4.0.0").cursorVersion, "3.15.6");
  assert.equal(contextRpcMatchForCursorVersion("").cursorVersion, "3.15.6");
});

test("versioned matcher selection does not use a future match on an older Cursor", () => {
  const matches = [
    { cursorVersion: "3.15.6", name: "latest" },
  ];
  assert.equal(latestKnownCursorMatch(matches, "3.15.5"), null);
  assert.equal(latestKnownCursorMatch(matches, "3.15.7").name, "latest");
  assert.equal(compareCursorVersions("3.15.6", "3.15.6"), 0);
  assert.ok(compareCursorVersions("3.15.7", "3.15.6") > 0);
});

test("Cursor version is read from the target app bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-version-"));
  const workbench = path.join(root, "Cursor.app", "Contents", "Resources", "app", "out", "workbench.js");
  try {
    fs.mkdirSync(path.dirname(workbench), { recursive: true });
    fs.writeFileSync(workbench, "");
    fs.writeFileSync(path.join(root, "Cursor.app", "Contents", "Info.plist"), [
      "<?xml version=\"1.0\"?>",
      "<plist><dict>",
      "<key>CFBundleShortVersionString</key><string>3.16.1</string>",
      "</dict></plist>",
    ].join("\n"));
    assert.equal(readCursorVersion(workbench), "3.16.1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
