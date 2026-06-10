"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EXTENSION_ID } = require("../src/constants");
const { ensureConfigFiles } = require("../src/config");
const { installWorkbenchHook } = require("./install-workbench-hook");

const LEGACY_NAME_RE = new RegExp(
  "^(?:c[a-z]+ix-space\\.cursor(?:" + "2" + "plus|-byok)|" +
    "lo" + "cal-byok\\.cursor-byok-" + "clean" + "room)(?:-|$)",
  "i",
);
const LEGACY_BUILTIN_NAME = "cursor" + "2" + "plus";

function main() {
  ensureConfigFiles();
  const repo = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const extensionDirName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
  const extensionRoot = path.join(os.homedir(), ".cursor", "extensions", extensionDirName);
  removeLegacyExtensions(path.dirname(extensionRoot));
  removeLegacyAppExtensions();
  fs.rmSync(extensionRoot, { recursive: true, force: true });
  copyTree(repo, extensionRoot, shouldCopy);
  installRuntimeDependencies(extensionRoot);
  refreshRegistry(extensionRoot, pkg);
  const pristineWorkbench = findMountedCursorInstallerWorkbench();
  const hook = installWorkbenchHook(pristineWorkbench ? { pristineWorkbench } : {});
  console.log(JSON.stringify({ extensionRoot, hook }, null, 2));
}

function shouldCopy(file) {
  const relative = file.replace(/\\/g, "/");
  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.some((part) => part === ".DS_Store" || part === "node_modules" || part === ".git")) return false;
  const top = parts[0];
  if (["src", "scripts", "docs", "resources"].includes(top)) return true;
  if (parts.length !== 1) return false;
  return [
    "package.json",
    "package-lock.json",
    "README.md",
    "README_CN.md",
    "CONTRIBUTING.md",
    "byok-system-prompt.md",
    "models-catalog.json",
    "install.sh",
    "reinstall.sh",
  ].includes(top);
}

function installRuntimeDependencies(extensionRoot) {
  childProcess.execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
    cwd: extensionRoot,
    stdio: "inherit",
  });
}

function copyTree(src, dst, predicate, root = src) {
  const stat = fs.statSync(src);
  const relative = path.relative(root, src);
  if (relative && !predicate(relative)) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dst, entry), predicate, root);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function refreshRegistry(extensionRoot, pkg) {
  const extensionsJson = path.join(os.homedir(), ".cursor", "extensions", "extensions.json");
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(extensionsJson, "utf8"));
  } catch {}
  const identifier = { id: EXTENSION_ID };
  const entry = {
    identifier,
    version: pkg.version,
    location: { $mid: 1, path: extensionRoot, scheme: "file" },
    relativeLocation: path.basename(extensionRoot),
    metadata: {
      installedTimestamp: Date.now(),
      pinned: true,
      source: "vsix",
    },
  };
  entries = entries.filter((item) => !LEGACY_NAME_RE.test(item?.identifier?.id || ""));
  const index = entries.findIndex((item) => item?.identifier?.id === EXTENSION_ID);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  fs.mkdirSync(path.dirname(extensionsJson), { recursive: true });
  fs.writeFileSync(extensionsJson, JSON.stringify(entries, null, 2));
}

function removeLegacyExtensions(extensionsDir) {
  if (!fs.existsSync(extensionsDir)) return;
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (LEGACY_NAME_RE.test(entry.name)) {
      fs.rmSync(path.join(extensionsDir, entry.name), { recursive: true, force: true });
    }
  }
}

function removeLegacyAppExtensions(appExtensionsDir = "/Applications/Cursor.app/Contents/Resources/app/extensions") {
  if (!fs.existsSync(appExtensionsDir)) return;
  for (const entry of fs.readdirSync(appExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (LEGACY_NAME_RE.test(entry.name) || entry.name === LEGACY_BUILTIN_NAME) {
      fs.rmSync(path.join(appExtensionsDir, entry.name), { recursive: true, force: true });
    }
  }
}

function findMountedCursorInstallerWorkbench() {
  const candidates = [
    "/Volumes/Cursor Installer/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
  ];
  try {
    for (const entry of fs.readdirSync("/private/tmp")) {
      if (!entry.startsWith("cursor-dmg-")) continue;
      candidates.push(path.join("/private/tmp", entry, "Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js"));
    }
  } catch {}
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

if (require.main === module) main();

module.exports = {
  copyTree,
  findMountedCursorInstallerWorkbench,
  installRuntimeDependencies,
  removeLegacyAppExtensions,
  removeLegacyExtensions,
  refreshRegistry,
  shouldCopy,
};
