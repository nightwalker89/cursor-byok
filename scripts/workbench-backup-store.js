"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hookStatePath, readJsonFile, workbenchBackupDir, writeJsonFile } = require("../src/config");

const HOOK_STATE_SCHEMA_VERSION = 1;

function readHookInstallState() {
  const state = readJsonFile(hookStatePath(), null);
  if (!state || typeof state !== "object") return null;
  if (state.schemaVersion !== HOOK_STATE_SCHEMA_VERSION) return null;
  return state;
}

function writeHookInstallState(state) {
  writeJsonFile(hookStatePath(), state);
}

function hasBackupEntry(entry, targetPath) {
  return !!(entry && entry.targetPath === targetPath && typeof entry.backupPath === "string" && fs.existsSync(entry.backupPath));
}

function isStaleBackupEntry(entry, content) {
  if (!entry || typeof entry.backupPath !== "string" || !fs.existsSync(entry.backupPath)) return false;
  return entry.sha256 !== sha256Text(content);
}

function ensureBackupEntry({ existing, targetPath, content, canCapture }) {
  if (hasBackupEntry(existing, targetPath)) {
    if (canCapture && isStaleBackupEntry(existing, content)) {
      const refreshed = captureBackupEntry({ targetPath, content });
      return {
        entry: refreshed.entry,
        created: refreshed.created,
        warning: `${path.basename(targetPath)} backup refreshed after Cursor bundle changed`,
      };
    }
    return { entry: existing, created: false, warning: null };
  }
  if (!canCapture) {
    return {
      entry: existing && existing.targetPath === targetPath ? existing : null,
      created: false,
      warning: `${path.basename(targetPath)} was already modified before backup capture`,
    };
  }
  return captureBackupEntry({ targetPath, content });
}

function captureBackupEntry({ targetPath, content }) {
  fs.mkdirSync(workbenchBackupDir(), { recursive: true });
  const sha256 = sha256Text(content);
  const baseName = path.basename(targetPath).replace(/[^A-Za-z0-9_.-]+/g, "_");
  const backupPath = path.join(workbenchBackupDir(), `${baseName}.${sha256}.orig`);
  const created = !fs.existsSync(backupPath);
  if (created) fs.writeFileSync(backupPath, content);
  return {
    entry: {
      targetPath,
      backupPath,
      sha256,
      size: Buffer.byteLength(content),
      capturedAt: new Date().toISOString(),
    },
    created,
    warning: null,
  };
}

function writeFileAtomically(targetPath, content) {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.cursor-byok.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, targetPath);
}

function sha256Text(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

module.exports = {
  HOOK_STATE_SCHEMA_VERSION,
  captureBackupEntry,
  ensureBackupEntry,
  hasBackupEntry,
  isStaleBackupEntry,
  readHookInstallState,
  sha256Text,
  writeFileAtomically,
  writeHookInstallState,
};
