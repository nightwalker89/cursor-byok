"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DEFAULT_MAX_LOG_DETAIL_CHARS, DEFAULT_MAX_LOG_FILE_BYTES, LocalLog, safeJson } = require("../src/log");

test("safeJson bounds large or unsafe details", () => {
  assert.equal(safeJson("abcdefghij", 4), "abcd...[truncated 6 chars]");

  const objectText = safeJson({ value: "abcdefghij" }, 12);
  assert.equal(objectText.startsWith("{\"value\":\""), true);
  assert.match(objectText, /\.\.\.\[truncated \d+ chars\]$/);
  assert.equal(objectText.includes("abcdefghij"), false);
  assert.equal(objectText.length < DEFAULT_MAX_LOG_DETAIL_CHARS, true);

  const value = {};
  value.self = value;
  assert.match(safeJson(value, 64), /\[circular\]/);

  const arrayText = safeJson({ values: Array.from({ length: 1000 }, (_, index) => `value-${index}`) }, 256);
  assert.equal(arrayText.includes("value-999"), false);
  assert.match(arrayText, /truncated/);
  assert.equal(arrayText.length <= 512, true);
});

test("LocalLog writes bounded detail text to the output channel", () => {
  const lines = [];
  const log = new LocalLog({
    appendLine(line) {
      lines.push(line);
    },
  }, {
    fileEnabledProvider: () => false,
    maxDetailChars: 8,
  });

  log.info("large detail", { value: "abcdefghij" });

  assert.equal(lines.length, 1);
  assert.match(lines[0], / INFO large detail /);
  assert.match(lines[0], /\.\.\.\[truncated \d+ chars\]$/);
  assert.equal(lines[0].includes("abcdefghij"), false);
});

test("LocalLog rotates file logs before unbounded growth", () => {
  assert.equal(DEFAULT_MAX_LOG_FILE_BYTES >= 1024 * 1024, true);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "byok-log-rotate-"));
  const file = path.join(tmpRoot, "cursor-byok.log");
  fs.writeFileSync(file, `${"x".repeat(120)}\n`);
  const lines = [];
  const log = new LocalLog({
    appendLine(line) {
      lines.push(line);
    },
  }, {
    filePathProvider: () => file,
    maxFileBytes: 180,
    maxDetailChars: 16,
  });

  log.info("rotated", { value: "abcdefghij" });

  assert.equal(lines.length, 1);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), `${"x".repeat(120)}\n`);
  const current = fs.readFileSync(file, "utf8");
  assert.match(current, / INFO rotated /);
  assert.equal(current.includes("abcdefghij"), false);
  assert.equal(Buffer.byteLength(current, "utf8") <= 180, true);
});