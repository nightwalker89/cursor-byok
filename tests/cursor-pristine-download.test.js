"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  cachePaths,
  cursorDownloadArchitecture,
  cursorDownloadUrl,
  cursorVersionFamily,
  mountPointFromAttachPlist,
  readValidCache,
} = require("../scripts/cursor-pristine-download");

test("Cursor 3.12 through 3.14 use only official macOS download endpoints", () => {
  assert.equal(cursorVersionFamily("3.14.27"), "3.14");
  assert.equal(cursorDownloadArchitecture("arm64"), "arm64");
  assert.equal(cursorDownloadArchitecture("x64"), "x64");
  assert.equal(cursorDownloadArchitecture("arm64", "universal"), "universal");
  assert.equal(cursorDownloadUrl("3.12.30", "arm64"), "https://api2.cursor.sh/updates/download/golden/darwin-arm64/cursor/3.12");
  assert.equal(cursorDownloadUrl("3.14.27", "x64"), "https://api2.cursor.sh/updates/download/golden/darwin-x64/cursor/3.14");
  assert.equal(cursorDownloadUrl("3.15.6", "arm64"), "");
});

test("download cache rejects a changed artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-download-cache-"));
  const paths = cachePaths("3.13.25", "arm64", root);
  try {
    fs.writeFileSync(paths.dmg, "signed-artifact");
    const hash = require("node:crypto").createHash("sha256").update("signed-artifact").digest("hex");
    fs.writeFileSync(paths.manifest, JSON.stringify({ cursorVersion: "3.13.25", sha256: hash }));
    assert.equal(readValidCache(paths, "3.13.25").sha256, hash);
    fs.appendFileSync(paths.dmg, "changed");
    assert.equal(readValidCache(paths, "3.13.25"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DMG attach plist parser extracts the read-only volume path", () => {
  const plist = "<plist><array><dict><key>mount-point</key><string>/Volumes/Cursor Installer</string></dict></array></plist>";
  assert.equal(mountPointFromAttachPlist(plist), "/Volumes/Cursor Installer");
});
