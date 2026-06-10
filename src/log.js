"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { logPath } = require("./config");

const DEFAULT_MAX_LOG_DETAIL_CHARS = 64 * 1024;
const DEFAULT_MAX_LOG_DEPTH = 6;
const DEFAULT_MAX_LOG_ARRAY_ITEMS = 64;
const DEFAULT_MAX_LOG_OBJECT_KEYS = 64;
const DEFAULT_MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;

class LocalLog {
  constructor(outputChannel, options = {}) {
    this.outputChannel = outputChannel;
    this.fileEnabledProvider = options.fileEnabledProvider || (() => true);
    this.filePathProvider = options.filePathProvider || logPath;
    this.maxDetailChars = normalizePositiveInteger(options.maxDetailChars, DEFAULT_MAX_LOG_DETAIL_CHARS);
    this.maxFileBytes = normalizePositiveInteger(options.maxFileBytes, DEFAULT_MAX_LOG_FILE_BYTES);
  }

  info(message, detail) {
    this.write("info", message, detail);
  }

  warn(message, detail) {
    this.write("warn", message, detail);
  }

  error(message, detail) {
    this.write("error", message, detail);
  }

  write(level, message, detail) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${detail === undefined ? "" : ` ${safeJson(detail, this.maxDetailChars)}`}`;
    try {
      this.outputChannel?.appendLine(line);
    } catch {}
    if (!this.fileEnabledProvider()) return;
    try {
      const file = this.filePathProvider();
      const entry = `${line}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateLogFileIfNeeded(file, Buffer.byteLength(entry, "utf8"), this.maxFileBytes);
      fs.appendFileSync(file, entry);
    } catch {}
  }
}

function rotateLogFileIfNeeded(file, nextBytes, maxFileBytes) {
  if (!maxFileBytes || nextBytes > maxFileBytes) return;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size + nextBytes <= maxFileBytes) return;
  const rotated = `${file}.1`;
  try {
    fs.rmSync(rotated, { force: true });
  } catch {}
  try {
    fs.renameSync(file, rotated);
  } catch {}
}

function safeJson(value, maxChars = DEFAULT_MAX_LOG_DETAIL_CHARS) {
  const limit = normalizePositiveInteger(maxChars, DEFAULT_MAX_LOG_DETAIL_CHARS);
  if (typeof value === "string") return boundedString(value, limit);
  let text;
  text = boundedJson(value, limit);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function boundedJson(value, limit) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(boundedValue(value, {
      limit,
      seen,
      used: 0,
      truncated: 0,
      depth: 0,
    }));
  } catch {
    return boundedString(String(value), limit);
  }
}

function boundedValue(value, state) {
  if (state.used >= state.limit) {
    state.truncated++;
    return "[truncated]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    state.used += 8;
    return value;
  }
  if (typeof value === "bigint") {
    const text = boundedString(value.toString(), state.limit - state.used);
    state.used += text.length;
    return text;
  }
  if (typeof value === "string") {
    const text = boundedString(value, state.limit - state.used);
    state.used += text.length;
    return text;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    state.used += 16;
    return String(value);
  }
  if (state.depth >= DEFAULT_MAX_LOG_DEPTH) {
    state.truncated++;
    return "[max-depth]";
  }
  if (seenHas(state, value)) {
    state.truncated++;
    return "[circular]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const out = [];
    const length = Math.min(value.length, DEFAULT_MAX_LOG_ARRAY_ITEMS);
    state.depth++;
    for (let i = 0; i < length; i++) {
      out.push(boundedValue(value[i], state));
      if (state.used >= state.limit) break;
    }
    state.depth--;
    if (value.length > length) out.push(`[truncated ${value.length - length} array item(s)]`);
    return out;
  }
  const out = {};
  const keys = Object.keys(value);
  const length = Math.min(keys.length, DEFAULT_MAX_LOG_OBJECT_KEYS);
  state.depth++;
  for (let i = 0; i < length; i++) {
    const key = keys[i];
    state.used += key.length;
    out[key] = boundedValue(value[key], state);
    if (state.used >= state.limit) break;
  }
  state.depth--;
  if (keys.length > length) out.__truncatedKeys = keys.length - length;
  return out;
}

function seenHas(state, value) {
  try {
    return state.seen.has(value);
  } catch {
    return false;
  }
}

function boundedString(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit))}...[truncated ${value.length - limit} chars]`;
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
  DEFAULT_MAX_LOG_DETAIL_CHARS,
  DEFAULT_MAX_LOG_FILE_BYTES,
  LocalLog,
  safeJson,
};
