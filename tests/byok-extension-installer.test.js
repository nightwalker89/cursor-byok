"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CATALOG_FILE, DEFAULT_REDIRECTS } = require("../src/constants");
const { copyTree, refreshRegistry, removeLegacyAppExtensions, removeLegacyExtensions, shouldCopy } = require("../scripts/install-cursor");
const {
  configDir,
  ensureConfigFiles,
  loadRoutes,
  providersPath,
  routesPath,
  writeRoutes,
  writeJsonFile,
  logPath,
} = require("../src/config");
const { ByokServer, DEFAULT_MAX_MCP_PROJECT_CACHE_ENTRIES, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_UPSTREAM_RESPONSE_BYTES, normalizeExecClientResult, normalizeRunRequestForProvider, pipeResponseBody, readResponseText, routePatterns, summarizeExecResult } = require("../src/server/http");
const { protoMessage, fieldMessage, fieldString, quietLog, recordingLog, deferred, tick, useHome, pickFields, waitForWebviewPost, runPanelWebviewScript, fakeReadableStream, interceptModule, interceptModules } = require("./byok-fixtures");

const root = path.resolve(__dirname, "..");

test("extension installer copies runtime files but not tests or git metadata", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-copy-"));
  const src = path.join(tmpRoot, "src");
  const dst = path.join(tmpRoot, "dst");
  fs.mkdirSync(path.join(src, "tests"), { recursive: true });
  fs.mkdirSync(path.join(src, ".git"), { recursive: true });
  fs.mkdirSync(path.join(src, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(src, "analysis"), { recursive: true });
  fs.mkdirSync(path.join(src, "vsix-unpacked"), { recursive: true });
  fs.mkdirSync(path.join(src, "src"), { recursive: true });
  fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), "{}");
  fs.writeFileSync(path.join(src, "debug-notes.md"), "progress");
  fs.writeFileSync(path.join(src, "tests", "runtime.test.js"), "test");
  fs.writeFileSync(path.join(src, ".git", "HEAD"), "main");
  fs.writeFileSync(path.join(src, ".claude", "settings.local.json"), "{}");
  fs.writeFileSync(path.join(src, "analysis", "notes.md"), "notes");
  fs.writeFileSync(path.join(src, "vsix-unpacked", "extension.js"), "old");
  fs.writeFileSync(path.join(src, "src", "extension.js"), "runtime");
  fs.writeFileSync(path.join(src, "scripts", "install-cursor.js"), "installer");
  copyTree(src, dst, shouldCopy);
  assert.equal(fs.existsSync(path.join(dst, "package.json")), true);
  assert.equal(fs.existsSync(path.join(dst, "src", "extension.js")), true);
  assert.equal(fs.existsSync(path.join(dst, "scripts", "install-cursor.js")), true);
  assert.equal(fs.existsSync(path.join(dst, "tests")), false);
  assert.equal(fs.existsSync(path.join(dst, ".git")), false);
  assert.equal(fs.existsSync(path.join(dst, ".claude")), false);
  assert.equal(fs.existsSync(path.join(dst, "analysis")), false);
  assert.equal(fs.existsSync(path.join(dst, "vsix-unpacked")), false);
  assert.equal(fs.existsSync(path.join(dst, "debug-notes.md")), false);
});

test("extension installer removes legacy extension directories and registry entries", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-registry-"));
  const extensionsDir = path.join(tmpRoot, ".cursor", "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  const legacyA = ["come", "tix-space.cursor", "2", "plus-0.0.10"].join("");
  const legacyB = ["come", "tix-space.cursor-byok-0.0.10"].join("");
  const legacyC = ["lo", "cal-byok.cursor-byok-", "clean", "room-1.0.0"].join("");
  fs.mkdirSync(path.join(extensionsDir, legacyA), { recursive: true });
  fs.mkdirSync(path.join(extensionsDir, legacyB), { recursive: true });
  fs.mkdirSync(path.join(extensionsDir, legacyC), { recursive: true });
  fs.mkdirSync(path.join(extensionsDir, "keep.extension-1.0.0"), { recursive: true });
  removeLegacyExtensions(extensionsDir);
  assert.equal(fs.existsSync(path.join(extensionsDir, legacyA)), false);
  assert.equal(fs.existsSync(path.join(extensionsDir, legacyB)), false);
  assert.equal(fs.existsSync(path.join(extensionsDir, legacyC)), false);
  assert.equal(fs.existsSync(path.join(extensionsDir, "keep.extension-1.0.0")), true);

  const restoreHome = useHome(tmpRoot);
  try {
    fs.writeFileSync(path.join(extensionsDir, "extensions.json"), JSON.stringify([
      { identifier: { id: legacyA.replace(/-0\.0\.10$/, "") } },
      { identifier: { id: legacyC.replace(/-1\.0\.0$/, "") } },
      { identifier: { id: "keep.extension" } },
    ]));
    refreshRegistry(path.join(extensionsDir, "starduster.cursor-byok-1.0.0"), {
      version: "1.0.0",
    });
    const entries = JSON.parse(fs.readFileSync(path.join(extensionsDir, "extensions.json"), "utf8"));
    assert.equal(entries.some((entry) => entry.identifier.id === "keep.extension"), true);
    assert.equal(entries.some((entry) => entry.identifier.id === "starduster.cursor-byok"), true);
    assert.equal(entries.some((entry) => entry.identifier.id === legacyC.replace(/-1\.0\.0$/, "")), false);
    assert.equal(entries.some((entry) => entry.identifier.id === legacyA.replace(/-0\.0\.10$/, "")), false);
  } finally {
    restoreHome();
  }
});

test("extension installer removes legacy builtin app extension directory", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-app-extensions-"));
  fs.mkdirSync(path.join(tmpRoot, "cursor2plus"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "cometix-space.cursor-byok-0.0.10"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "keep.extension"), { recursive: true });
  removeLegacyAppExtensions(tmpRoot);
  assert.equal(fs.existsSync(path.join(tmpRoot, "cursor2plus")), false);
  assert.equal(fs.existsSync(path.join(tmpRoot, "cometix-space.cursor-byok-0.0.10")), false);
  assert.equal(fs.existsSync(path.join(tmpRoot, "keep.extension")), true);
});
