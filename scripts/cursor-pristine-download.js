"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCursorVersion, readCursorVersion } = require("./cursor-version");

const SUPPORTED_CURSOR_DOWNLOAD_FAMILIES = new Set(["3.12", "3.13", "3.14"]);
const CURSOR_DOWNLOAD_HOST = "api2.cursor.sh";
const CURSOR_ARTIFACT_HOST = "downloads.cursor.com";

function cursorVersionFamily(version) {
  const parsed = parseCursorVersion(version);
  return parsed ? `${parsed[0]}.${parsed[1]}` : "";
}

function cursorDownloadArchitecture(architecture = process.arch, override = "") {
  if (["arm64", "x64", "universal"].includes(override)) return override;
  if (architecture === "arm64") return "arm64";
  if (architecture === "x64") return "x64";
  return "";
}

function cursorDownloadUrl(version, architecture) {
  const family = cursorVersionFamily(version);
  if (!SUPPORTED_CURSOR_DOWNLOAD_FAMILIES.has(family) || !["arm64", "x64", "universal"].includes(architecture)) return "";
  return `https://${CURSOR_DOWNLOAD_HOST}/updates/download/golden/darwin-${architecture}/cursor/${family}`;
}

function cachePaths(version, architecture, root = path.join(os.tmpdir(), "cursor-byok-builds")) {
  const family = cursorVersionFamily(version);
  const base = `cursor-${family}-${architecture}`;
  return {
    root,
    dmg: path.join(root, `${base}.dmg`),
    manifest: path.join(root, `${base}.json`),
  };
}

function sha256File(file, fsImpl = fs) {
  const hash = crypto.createHash("sha256");
  const input = fsImpl.readFileSync(file);
  hash.update(input);
  return hash.digest("hex");
}

function downloadPristineWorkbench({
  targetVersion,
  architecture,
  architectureOverride,
  cacheRoot,
  deps = {},
} = {}) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const execFileSync = deps.execFileSync || childProcess.execFileSync;
  if (process.platform !== "darwin" && !deps.allowNonDarwin) return unavailable("unsupported-platform");
  if (!parseCursorVersion(targetVersion)) return unavailable("unrecognized-target-version");

  const resolvedArchitecture = architecture || cursorDownloadArchitecture(process.arch, architectureOverride);
  const url = cursorDownloadUrl(targetVersion, resolvedArchitecture);
  if (!url) return unavailable("unsupported-cursor-version");

  const paths = cachePaths(targetVersion, resolvedArchitecture, cacheRoot);
  try {
    fsImpl.mkdirSync(paths.root, { recursive: true });
    const cached = readValidCache(paths, targetVersion, fsImpl);
    if (cached) {
      const inspected = inspectDmg(paths.dmg, targetVersion, execFileSync, fsImpl, pathImpl);
      if (inspected.ok) return { ...inspected, status: "cached", url, sha256: cached.sha256, cachePaths: paths };
    }

    const temp = pathImpl.join(paths.root, `.cursor-byok-${process.pid}-${Date.now()}.dmg`);
    try {
      const finalUrl = String(execFileSync("curl", [
        "--fail", "--location", "--retry", "2", "--proto", "=https",
        "--silent", "--show-error", "--write-out", "%{url_effective}",
        "--output", temp, url,
      ], { encoding: "utf8" })).trim();
      if (new URL(finalUrl).hostname !== CURSOR_ARTIFACT_HOST) return unavailable("unexpected-download-host", { url, finalUrl });
      if (!fsImpl.existsSync(temp) || fsImpl.statSync(temp).size <= 0) return unavailable("empty-download", { url, finalUrl });
      const inspected = inspectDmg(temp, targetVersion, execFileSync, fsImpl, pathImpl);
      if (!inspected.ok) return { ...inspected, url, finalUrl };
      const sha256 = sha256File(temp, fsImpl);
      fsImpl.renameSync(temp, paths.dmg);
      writeJsonAtomically(paths.manifest, {
        cursorVersion: targetVersion,
        architecture: resolvedArchitecture,
        discoveryUrl: url,
        resolvedUrl: finalUrl,
        sha256,
        bytes: fsImpl.statSync(paths.dmg).size,
        validatedAt: new Date().toISOString(),
      }, fsImpl, pathImpl);
      return { ...inspected, status: "downloaded", url, finalUrl, sha256, cachePaths: paths };
    } finally {
      if (fsImpl.existsSync(temp)) fsImpl.rmSync(temp, { force: true });
    }
  } catch (error) {
    return unavailable("download-failed", { url, error: error.message });
  }
}

function readValidCache(paths, targetVersion, fsImpl = fs) {
  try {
    const manifest = JSON.parse(fsImpl.readFileSync(paths.manifest, "utf8"));
    if (manifest.cursorVersion !== targetVersion || !manifest.sha256 || !fsImpl.existsSync(paths.dmg)) return null;
    return sha256File(paths.dmg, fsImpl) === manifest.sha256 ? manifest : null;
  } catch {
    return null;
  }
}

function inspectDmg(dmg, targetVersion, execFileSync, fsImpl = fs, pathImpl = path) {
  let mountPoint = "";
  try {
    const plist = String(execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmg], { encoding: "utf8" }));
    mountPoint = mountPointFromAttachPlist(plist);
    if (!mountPoint) return unavailable("mount-without-cursor-volume");
    const appPath = pathImpl.join(mountPoint, "Cursor.app");
    const workbench = pathImpl.join(appPath, "Contents", "Resources", "app", "out", "vs", "workbench", "workbench.desktop.main.js");
    if (!fsImpl.existsSync(workbench)) return unavailable("downloaded-workbench-missing");
    if (readCursorVersion(workbench) !== targetVersion) return unavailable("downloaded-version-mismatch", { downloadedVersion: readCursorVersion(workbench) || null });
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { encoding: "utf8", stdio: "pipe" });
    execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, content: fsImpl.readFileSync(workbench, "utf8"), appPath, workbench };
  } catch (error) {
    return unavailable("download-validation-failed", { error: error.message });
  } finally {
    if (mountPoint) {
      try {
        execFileSync("hdiutil", ["detach", mountPoint], { encoding: "utf8", stdio: "pipe" });
      } catch {}
    }
  }
}

function mountPointFromAttachPlist(plist) {
  const match = String(plist).match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1] || "";
}

function writeJsonAtomically(file, value, fsImpl = fs, pathImpl = path) {
  const temp = pathImpl.join(pathImpl.dirname(file), `.${pathImpl.basename(file)}.${process.pid}.tmp`);
  fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fsImpl.renameSync(temp, file);
}

function unavailable(reason, extra = {}) {
  return { ok: false, status: "unavailable", reason, ...extra };
}

// Internal development utility. It is intentionally not referenced by the
// production installer: use it to capture an official build, inspect the
// patch report, then add a versioned matcher/fixture when a seam changes.
function main(argv = process.argv.slice(2)) {
  const versionIndex = argv.indexOf("--version");
  const architectureIndex = argv.indexOf("--architecture");
  const targetVersion = versionIndex >= 0 ? argv[versionIndex + 1] : "";
  const architectureOverride = architectureIndex >= 0 ? argv[architectureIndex + 1] : "";
  if (!targetVersion) {
    console.error("Usage: node scripts/cursor-pristine-download.js --version <3.12.x|3.13.x|3.14.x> [--architecture arm64|x64|universal]");
    process.exitCode = 2;
    return;
  }
  const result = downloadPristineWorkbench({ targetVersion, architectureOverride });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  const { applyPatchPlan, missingCriticalPatches, transportHookPoints } = require("./workbench-patch-engine");
  const plan = applyPatchPlan(result.content, { target: "workbench", cursorVersion: targetVersion });
  console.log(JSON.stringify({
    cursorVersion: targetVersion,
    status: result.status,
    url: result.url,
    finalUrl: result.finalUrl,
    sha256: result.sha256,
    cachePaths: result.cachePaths,
    transportHookPoints: transportHookPoints(plan.report),
    missingCriticalPatches: missingCriticalPatches(plan.report),
    patchReport: plan.report,
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  CURSOR_ARTIFACT_HOST,
  CURSOR_DOWNLOAD_HOST,
  SUPPORTED_CURSOR_DOWNLOAD_FAMILIES,
  cachePaths,
  cursorDownloadArchitecture,
  cursorDownloadUrl,
  cursorVersionFamily,
  downloadPristineWorkbench,
  inspectDmg,
  mountPointFromAttachPlist,
  readValidCache,
  main,
};
