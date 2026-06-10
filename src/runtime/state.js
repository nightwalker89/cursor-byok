"use strict";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEFAULT_MAX_BIDI_QUEUE_RECORDS = 4096;
const DEFAULT_MAX_BIDI_QUEUE_RECORDS_PER_REQUEST = 512;
const DEFAULT_MAX_SESSION_RECORDS = 4096;
const DEFAULT_MAX_PENDING_RESULTS = 1024;
const DEFAULT_MAX_COMPLETED_RESULTS = 4096;
const DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS = 16 * 1024 * 1024;

class BidiRawQueue {
  constructor({ maxRecords = DEFAULT_MAX_BIDI_QUEUE_RECORDS, maxRecordsPerRequest = DEFAULT_MAX_BIDI_QUEUE_RECORDS_PER_REQUEST, log } = {}) {
    this.maxRecords = positiveIntegerOrDefault(maxRecords, DEFAULT_MAX_BIDI_QUEUE_RECORDS);
    this.maxRecordsPerRequest = positiveIntegerOrDefault(maxRecordsPerRequest, DEFAULT_MAX_BIDI_QUEUE_RECORDS_PER_REQUEST);
    this.log = log || null;
    this.byRequestId = new Map();
    this.fifo = [];
    this.order = [];
  }

  push(record) {
    const normalized = normalizeBidiRecord(record);
    Object.defineProperty(normalized, "_queueKey", {
      value: normalized.requestId || "",
      enumerable: false,
      configurable: true,
    });
    if (normalized.requestId) {
      let queue = this.byRequestId.get(normalized.requestId);
      if (!queue) {
        queue = [];
        this.byRequestId.set(normalized.requestId, queue);
      }
      queue.push(normalized);
    } else {
      this.fifo.push(normalized);
    }
    this.order.push(normalized);
    this.trim();
    return normalized;
  }

  take(requestId) {
    if (requestId) {
      const queue = this.byRequestId.get(requestId);
      if (queue && queue.length) {
        const record = queue.shift();
        if (queue.length === 0) this.byRequestId.delete(requestId);
        this.removeFromOrder(record);
        return record;
      }
    }
    const record = this.fifo.shift() || null;
    if (record) this.removeFromOrder(record);
    return record;
  }

  sizeFor(requestId) {
    return this.byRequestId.get(requestId)?.length || 0;
  }

  get fifoSize() {
    return this.fifo.length;
  }

  trim() {
    for (const [requestId, queue] of this.byRequestId) {
      while (queue.length > this.maxRecordsPerRequest) {
        this.logDroppedRecord(queue[0], "per-request-limit", queue.length);
        this.removeQueuedRecord(queue[0]);
      }
      if (queue.length === 0) this.byRequestId.delete(requestId);
    }
    while (this.fifo.length > this.maxRecordsPerRequest) {
      this.logDroppedRecord(this.fifo[0], "fifo-limit", this.fifo.length);
      this.removeQueuedRecord(this.fifo[0]);
    }
    while (this.order.length > this.maxRecords) {
      this.logDroppedRecord(this.order[0], "global-limit", this.order.length);
      this.removeQueuedRecord(this.order[0]);
    }
  }

  removeQueuedRecord(record) {
    if (!record) return;
    if (record._queueKey) {
      const queue = this.byRequestId.get(record._queueKey);
      if (queue) {
        removeArrayItem(queue, record);
        if (queue.length === 0) this.byRequestId.delete(record._queueKey);
      }
    } else {
      removeArrayItem(this.fifo, record);
    }
    this.removeFromOrder(record);
  }

  removeFromOrder(record) {
    removeArrayItem(this.order, record);
  }

  logDroppedRecord(record, reason, queueSize) {
    this.log?.warn?.("BYOK dropped stale BidiAppend payload", {
      reason,
      requestId: record?.requestId || "",
      kindHint: record?.kindHint || "",
      payloadLength: record?.payloadLength || 0,
      queueSize,
      maxRecords: this.maxRecords,
      maxRecordsPerRequest: this.maxRecordsPerRequest,
    });
  }
}

class ConversationPins {
  constructor(ttlMs = 300000, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.pins = new Map();
  }

  pin(conversationId) {
    if (conversationId) this.pins.set(conversationId, this.now() + this.ttlMs);
  }

  has(conversationId) {
    if (!conversationId) return false;
    const expiresAt = this.pins.get(conversationId);
    if (!expiresAt) return false;
    if (this.now() > expiresAt) {
      this.pins.delete(conversationId);
      return false;
    }
    return true;
  }
}

class ByokSessionStore {
  constructor({
    now = () => Date.now(),
    ttlMs = 300000,
    maxRecords = DEFAULT_MAX_SESSION_RECORDS,
    maxPendingResults = DEFAULT_MAX_PENDING_RESULTS,
    maxCompletedResults = DEFAULT_MAX_COMPLETED_RESULTS,
    maxShellStreamBufferChars = DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS,
    log,
  } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRecords = positiveIntegerOrDefault(maxRecords, DEFAULT_MAX_SESSION_RECORDS);
    this.maxPendingResults = positiveIntegerOrDefault(maxPendingResults, DEFAULT_MAX_PENDING_RESULTS);
    this.maxCompletedResults = positiveIntegerOrDefault(maxCompletedResults, DEFAULT_MAX_COMPLETED_RESULTS);
    this.maxShellStreamBufferChars = positiveIntegerOrDefault(maxShellStreamBufferChars, DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS);
    this.log = log || null;
    this.byRequestId = new Map();
  }

  recordClientMessage(requestId, clientMessage, rawRecord) {
    if (!requestId && clientMessage?.message?.case) {
      let bestSession = null;
      for (const session of this.byRequestId.values()) {
        if (!bestSession || session.updatedAt > bestSession.updatedAt) {
          bestSession = session;
        }
      }
      if (bestSession) {
        requestId = bestSession.requestId;
      }
    }
    if (!requestId || !clientMessage?.message?.case) return null;
    const session = this.getOrCreate(requestId);
    session.updatedAt = this.now();
    if (clientMessage.message.case === "runRequest") {
      session.runRequest = mergeRunRequest(session.runRequest, clientMessage.message.value);
      this.resolveRunRequestWaiters(session);
    } else if (clientMessage.message.case === "conversationAction") {
      session.runRequest = mergeRunRequest(session.runRequest, { action: clientMessage.message.value });
      this.resolveRunRequestWaiters(session);
    } else if (clientMessage.message.case === "execClientMessage") {
      this.resolveExecResult(session, clientMessage.message.value);
    } else if (clientMessage.message.case === "interactionResponse") {
      this.resolveInteractionResponse(session, clientMessage.message.value);
    } else {
      pushLimited(
        session.records,
        { clientMessage, rawRecord },
        this.maxRecords,
        (dropped, lengthBeforeTrim) => this.logSessionTrim(session, "records", dropped, lengthBeforeTrim),
      );
      this.resolveClientToolCompletionFromRecord(session, clientMessage, rawRecord);
    }
    this.sweep();
    return session;
  }

  get(requestId) {
    if (!requestId) return null;
    const session = this.byRequestId.get(requestId);
    if (!session) return null;
    session.updatedAt = this.now();
    return session;
  }

  getOrCreate(requestId) {
    let session = this.byRequestId.get(requestId);
    if (!session) {
      session = {
        requestId,
        createdAt: this.now(),
        updatedAt: this.now(),
        records: [],
        runRequest: null,
        runRequestWaiters: [],
        pendingExecResults: [],
        completedExecResultsByToolCallId: new Map(),
        waitersByToolCallId: new Map(),
        execAliases: new Map(),
        shellStreamsByToolCallId: new Map(),
        pendingInteractionResponses: [],
        completedInteractionResponsesById: new Map(),
        interactionWaitersById: new Map(),
        pendingClientToolCompletions: [],
        completedClientToolCompletionsByToolCallId: new Map(),
        clientToolWaitersByToolCallId: new Map(),
        maxShellStreamBufferChars: this.maxShellStreamBufferChars,
        _log: this.log,
      };
      this.byRequestId.set(requestId, session);
    }
    return session;
  }

  registerExecAlias(requestId, id, toolCallId, execId) {
    if (!requestId || !toolCallId) return null;
    const session = this.getOrCreate(requestId);
    session.updatedAt = this.now();
    if (id !== undefined && id !== null && id !== "") {
      const key = String(id);
      session.execAliases.set(key, toolCallId);
      migrateShellStreamAlias(session, key, toolCallId);
    }
    if (execId !== undefined && execId !== null && execId !== "") {
      const key = String(execId);
      session.execAliases.set(key, toolCallId);
      migrateShellStreamAlias(session, key, toolCallId);
    }
    this.resolvePendingExecResults(session);
    this.sweep();
    return session;
  }

  waitForRunRequest(requestId, timeoutMs = 5000, predicate = Boolean) {
    const existing = this.get(requestId)?.runRequest;
    if (existing && predicate(existing)) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const session = this.getOrCreate(requestId);
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = session.runRequestWaiters.indexOf(waiter);
          if (index >= 0) session.runRequestWaiters.splice(index, 1);
          resolve(null);
        }, timeoutMs),
      };
      session.runRequestWaiters.push(waiter);
    });
  }

  resolveRunRequestWaiters(session) {
    if (!session.runRequestWaiters.length) return;
    for (let i = 0; i < session.runRequestWaiters.length;) {
      const waiter = session.runRequestWaiters[i];
      if (!waiter.predicate(session.runRequest)) {
        i++;
        continue;
      }
      session.runRequestWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(session.runRequest);
    }
  }

  waitForExecResult(requestId, toolCallId, timeoutMs = 300000) {
    const session = this.getOrCreate(requestId);
    const completed = session.completedExecResultsByToolCallId.get(toolCallId);
    if (completed) return Promise.resolve(completed);
    const existingIndex = session.pendingExecResults.findIndex((result) =>
      execResultMatches(session, result, toolCallId)
    );
    if (existingIndex >= 0) {
      const [result] = session.pendingExecResults.splice(existingIndex, 1);
      annotateExecToolCallId(session, result);
      storeCompletedExecResult(session, toolCallId, result, this.maxCompletedResults);
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      const timer = setTimeout(() => {
        const waiters = session.waitersByToolCallId.get(toolCallId);
        if (waiters) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) session.waitersByToolCallId.delete(toolCallId);
        }
        reject(new Error(`Timed out waiting for Cursor exec result ${toolCallId}`));
      }, timeoutMs);
      let waiters = session.waitersByToolCallId.get(toolCallId);
      if (!waiters) {
        waiters = [];
        session.waitersByToolCallId.set(toolCallId, waiters);
      }
      waiters.push(waiter);
    });
  }

  storeExecResult(requestId, toolCallId, execClientMessage) {
    if (!requestId || !toolCallId || !execClientMessage) return null;
    const session = this.getOrCreate(requestId);
    session.updatedAt = this.now();
    execClientMessage._byokToolCallId = toolCallId;
    this.resolveExecResult(session, execClientMessage);
    this.sweep();
    return execClientMessage;
  }

  waitForInteractionResponse(requestId, queryId, timeoutMs = 300000) {
    const session = this.getOrCreate(requestId);
    const key = String(queryId);
    const completed = session.completedInteractionResponsesById.get(key);
    if (completed) return Promise.resolve(completed);
    const existingIndex = session.pendingInteractionResponses.findIndex((result) => String(result?.id ?? "") === key);
    if (existingIndex >= 0) {
      const [result] = session.pendingInteractionResponses.splice(existingIndex, 1);
      storeCompletedInteractionResponse(session, key, result, this.maxCompletedResults);
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      const timer = setTimeout(() => {
        const waiters = session.interactionWaitersById.get(key);
        if (waiters) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) session.interactionWaitersById.delete(key);
        }
        reject(new Error(`Timed out waiting for Cursor interaction response ${queryId}`));
      }, timeoutMs);
      let waiters = session.interactionWaitersById.get(key);
      if (!waiters) {
        waiters = [];
        session.interactionWaitersById.set(key, waiters);
      }
      waiters.push(waiter);
    });
  }

  resolveInteractionResponse(session, interactionResponse) {
    const key = String(interactionResponse?.id ?? "");
    if (!key) {
      pushLimited(
        session.pendingInteractionResponses,
        interactionResponse,
        this.maxPendingResults,
        (dropped, lengthBeforeTrim) => this.logSessionTrim(session, "pendingInteractionResponses", dropped, lengthBeforeTrim),
      );
      return;
    }
    storeCompletedInteractionResponse(session, key, interactionResponse, this.maxCompletedResults);
    const waiters = session.interactionWaitersById.get(key);
    if (waiters?.length) {
      session.interactionWaitersById.delete(key);
      for (const waiter of waiters.splice(0)) waiter.resolve(interactionResponse);
    }
  }

  waitForClientToolCompletion(requestId, toolCallId, toolName, timeoutMs = 300000) {
    const session = this.getOrCreate(requestId);
    const key = String(toolCallId || "");
    const completed = session.completedClientToolCompletionsByToolCallId.get(key);
    if (completed) return Promise.resolve(completed);
    const existingIndex = session.pendingClientToolCompletions.findIndex((entry) => entry.toolCallId === key);
    if (existingIndex >= 0) {
      const [entry] = session.pendingClientToolCompletions.splice(existingIndex, 1);
      this.storeCompletedClientToolCompletion(session, key, entry.completion);
      return Promise.resolve(entry.completion);
    }
    const fromRecords = findClientToolCompletionInSession(session, key, toolName);
    if (fromRecords) {
      this.storeCompletedClientToolCompletion(session, key, fromRecords);
      return Promise.resolve(fromRecords);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (completion) => {
          clearTimeout(timer);
          resolve(completion);
        },
      };
      const timer = setTimeout(() => {
        const waiters = session.clientToolWaitersByToolCallId.get(key);
        if (waiters) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) session.clientToolWaitersByToolCallId.delete(key);
        }
        reject(new Error(`Timed out waiting for Cursor client tool completion ${toolCallId}`));
      }, timeoutMs);
      let waiters = session.clientToolWaitersByToolCallId.get(key);
      if (!waiters) {
        waiters = [];
        session.clientToolWaitersByToolCallId.set(key, waiters);
      }
      waiters.push(waiter);
    });
  }

  resolveClientToolCompletion(session, toolCallId, completion) {
    const key = String(toolCallId || "");
    if (!key || !completion) {
      pushLimited(
        session.pendingClientToolCompletions,
        { toolCallId: key, completion },
        this.maxPendingResults,
        (dropped, lengthBeforeTrim) => this.logSessionTrim(session, "pendingClientToolCompletions", dropped, lengthBeforeTrim),
      );
      return;
    }
    this.storeCompletedClientToolCompletion(session, key, completion);
    const waiters = session.clientToolWaitersByToolCallId.get(key);
    if (waiters?.length) {
      session.clientToolWaitersByToolCallId.delete(key);
      for (const waiter of waiters.splice(0)) waiter.resolve(completion);
    }
  }

  resolveClientToolCompletionFromRecord(session, clientMessage, rawRecord) {
    const { findClientToolCompletion } = require("./client-tool-bridge");
    for (const toolName of ["WebSearch", "GenerateImage"]) {
      for (const toolCallId of collectToolCallIdsFromRecord(clientMessage, rawRecord)) {
        const completion = findClientToolCompletion(session.records, toolCallId, toolName);
        if (completion) this.resolveClientToolCompletion(session, toolCallId, completion);
      }
    }
    this.resolveShellCompletionFromRecord(session, clientMessage, rawRecord);
  }

  resolveShellCompletionFromRecord(session, clientMessage, rawRecord) {
    for (const toolCallId of collectToolCallIdsFromRecord(clientMessage, rawRecord)) {
      if (!toolCallId || session.completedExecResultsByToolCallId.has(toolCallId)) continue;
      const shellResult = findShellToolCompletionResult(session.records, toolCallId);
      if (!shellResult) continue;
      this.resolveExecResult(session, shellResult);
    }
  }

  resolveExecResult(session, execClientMessage) {
    const toolCallId = annotateExecToolCallId(session, execClientMessage);
    if (execClientMessage?.message?.case === "shellStream") {
      const shellResult = resolveShellStreamResult(session, toolCallId, execClientMessage);
      if (!shellResult) return;
      execClientMessage = shellResult;
    }
    if (!toolCallId || isUnaliasedNumericExecResult(session, execClientMessage, toolCallId)) {
      pushLimited(
        session.pendingExecResults,
        execClientMessage,
        this.maxPendingResults,
        (dropped, lengthBeforeTrim) => this.logSessionTrim(session, "pendingExecResults", dropped, lengthBeforeTrim),
      );
      return;
    }
    const waiters = session.waitersByToolCallId.get(toolCallId);
    storeCompletedExecResult(session, toolCallId, execClientMessage, this.maxCompletedResults);
    if (waiters?.length) {
      session.waitersByToolCallId.delete(toolCallId);
      for (const waiter of waiters.splice(0)) {
        waiter.resolve(execClientMessage);
      }
      return;
    }
  }

  resolvePendingExecResults(session) {
    for (let i = 0; i < session.pendingExecResults.length;) {
      const execClientMessage = session.pendingExecResults[i];
      const toolCallId = annotateExecToolCallId(session, execClientMessage);
      if (!toolCallId) {
        i++;
        continue;
      }
      session.pendingExecResults.splice(i, 1);
      this.resolveExecResult(session, execClientMessage);
    }
  }

  sweep() {
    const expiresBefore = this.now() - this.ttlMs;
    for (const [requestId, session] of this.byRequestId) {
      if (session.updatedAt < expiresBefore) this.byRequestId.delete(requestId);
    }
  }

  storeCompletedClientToolCompletion(session, toolCallId, completion) {
    setLimitedMap(
      session.completedClientToolCompletionsByToolCallId,
      toolCallId,
      completion,
      this.maxCompletedResults,
      (droppedKey) => logCompletedTrim(session, "completedClientToolCompletionsByToolCallId", droppedKey, this.maxCompletedResults),
    );
  }

  logSessionTrim(session, bucket, dropped, lengthBeforeTrim) {
    this.log?.warn?.("BYOK trimmed session cache", {
      requestId: session?.requestId || "",
      bucket,
      lengthBeforeTrim,
      maxRecords: this.maxRecords,
      maxPendingResults: this.maxPendingResults,
      maxCompletedResults: this.maxCompletedResults,
      droppedMessageCase: dropped?.clientMessage?.message?.case || dropped?.message?.case || "",
      droppedToolCallId: findExecToolCallId(dropped?.clientMessage?.message?.value || dropped) || "",
    });
  }
}

function logCompletedTrim(session, bucket, droppedKey, maxCompletedResults) {
  session?._log?.warn?.("BYOK trimmed completed result cache", {
    requestId: session?.requestId || "",
    bucket,
    droppedKey: String(droppedKey || ""),
    maxCompletedResults,
  });
}

function storeCompletedExecResult(session, toolCallId, execClientMessage, maxCompletedResults = DEFAULT_MAX_COMPLETED_RESULTS) {
  if (!toolCallId) return;
  setLimitedMap(
    session.completedExecResultsByToolCallId,
    toolCallId,
    execClientMessage,
    maxCompletedResults,
    (droppedKey) => logCompletedTrim(session, "completedExecResultsByToolCallId", droppedKey, maxCompletedResults),
  );
}

function storeCompletedInteractionResponse(session, queryId, interactionResponse, maxCompletedResults = DEFAULT_MAX_COMPLETED_RESULTS) {
  if (!queryId) return;
  setLimitedMap(
    session.completedInteractionResponsesById,
    queryId,
    interactionResponse,
    maxCompletedResults,
    (droppedKey) => logCompletedTrim(session, "completedInteractionResponsesById", droppedKey, maxCompletedResults),
  );
}

function normalizeBidiRecord(record) {
  const json = record?.json ?? record?.body ?? record;
  const requestId = record?.requestId || findRequestId(json) || "";
  const payload = extractPayloadBytes(json);
  return {
    requestId,
    kindHint: record?.kindHint || classifyBidiPayload(payload),
    json,
    payloadLength: payload.length,
    payloadPrefixHex: payload.subarray(0, 4).toString("hex"),
    receivedAt: record?.receivedAt || Date.now(),
  };
}

function mergeRunRequest(existing, update) {
  if (!existing) return cloneJson(update);
  if (!update || typeof update !== "object") return existing;
  const next = { ...existing, ...cloneJson(update) };
  if (existing.action || update.action) {
    next.action = [...arrayOf(existing.action), ...arrayOf(update.action)];
  }
  if (existing.mcpTools || update.mcpTools) {
    next.mcpTools = [...arrayOf(existing.mcpTools), ...arrayOf(update.mcpTools)];
  }
  return next;
}

function arrayOf(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function classifyBidiPayload(payload) {
  if (!payload || payload.length === 0) return "data";
  const prefix = payload.subarray(0, 4).toString("hex");
  if (payload.length >= 120 && payload.length <= 140 && prefix === "0a4e3232") return "conversationAction";
  if (payload.length <= 8) return "clientHeartbeat";
  return "data";
}

function extractPayloadBytes(value) {
  const payload = findPayload(value);
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (Array.isArray(payload) && payload.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Buffer.from(payload);
  }
  if (typeof payload !== "string") return Buffer.alloc(0);
  const trimmed = payload.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) return Buffer.from(trimmed, "hex");
  try {
    return Buffer.from(trimmed, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function findPayload(value, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  for (const key of ["dataBinary", "data_binary", "data", "body", "payload", "raw", "bytes"]) {
    if (
      typeof value[key] === "string" ||
      Buffer.isBuffer(value[key]) ||
      value[key] instanceof Uint8Array ||
      Array.isArray(value[key])
    ) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const found = findPayload(child, seen);
    if (found) return found;
  }
  return null;
}

function findRequestId(value, seen = new Set()) {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(UUID_RE);
    return match ? match[0] : "";
  }
  if (Buffer.isBuffer(value)) return findRequestId(value.toString("utf8"));
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  for (const key of ["requestId", "request_id", "conversationId", "conversation_id"]) {
    const found = findRequestId(value[key], seen);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findRequestId(child, seen);
    if (found) return found;
  }
  return "";
}

function findExecToolCallId(execClientMessage) {
  if (!execClientMessage || typeof execClientMessage !== "object") return "";
  const value = execClientMessage.message?.value;
  return execClientMessage._byokToolCallId ||
    findToolCallIdInValue(value) ||
    execClientMessage.execId ||
    String(execClientMessage.id || "");
}

function annotateExecToolCallId(session, execClientMessage) {
  if (!execClientMessage || typeof execClientMessage !== "object") return "";
  const direct = execClientMessage._byokToolCallId || findToolCallIdInValue(execClientMessage.message?.value);
  if (direct) {
    execClientMessage._byokToolCallId = direct;
    return direct;
  }
  const execId = execClientMessage.execId !== undefined && execClientMessage.execId !== null
    ? String(execClientMessage.execId)
    : "";
  if (execId && session?.execAliases?.has(execId)) {
    execClientMessage._byokToolCallId = session.execAliases.get(execId);
    return execClientMessage._byokToolCallId;
  }
  const numericId = execClientMessage.id !== undefined && execClientMessage.id !== null
    ? String(execClientMessage.id)
    : "";
  if (numericId && session?.execAliases?.has(numericId)) {
    execClientMessage._byokToolCallId = session.execAliases.get(numericId);
    return execClientMessage._byokToolCallId;
  }
  return execId || numericId;
}

function findToolCallIdInValue(value, seen = new Set()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  for (const key of ["toolCallId", "tool_call_id", "callId", "id"]) {
    const child = value[key];
    if (typeof child === "string" && child) return child;
  }
  for (const child of Object.values(value)) {
    const found = findToolCallIdInValue(child, seen);
    if (found) return found;
  }
  return "";
}

function execResultMatches(session, execClientMessage, toolCallId) {
  return annotateExecToolCallId(session, execClientMessage) === toolCallId ||
    execClientMessage?.execId === toolCallId ||
    String(execClientMessage?.id || "") === toolCallId;
}

function isUnaliasedNumericExecResult(session, execClientMessage, toolCallId) {
  const id = execClientMessage?.id;
  if (id === undefined || id === null || id === "") return false;
  const numericId = String(id);
  if (toolCallId !== numericId) return false;
  if (execClientMessage?._byokToolCallId) return false;
  if (session?.execAliases?.has(numericId)) return false;
  return execClientMessage?.execId === undefined || execClientMessage.execId === null || execClientMessage.execId === "";
}

function resolveShellStreamResult(session, toolCallId, execClientMessage) {
  if (!toolCallId) return null;
  const event = shellStreamEvent(execClientMessage.message?.value);
  if (!event?.case) return null;
  let stream = session.shellStreamsByToolCallId.get(toolCallId);
  if (!stream) {
    stream = {
      id: execClientMessage.id,
      execId: execClientMessage.execId || "",
      command: "",
      workingDirectory: "",
      stdout: shellOutputBuffer("stdout", session.maxShellStreamBufferChars),
      stderr: shellOutputBuffer("stderr", session.maxShellStreamBufferChars),
      interleaved: shellOutputBuffer("interleaved", session.maxShellStreamBufferChars),
    };
    session.shellStreamsByToolCallId.set(toolCallId, stream);
  }
  if (execClientMessage.id !== undefined) stream.id = execClientMessage.id;
  if (execClientMessage.execId) stream.execId = execClientMessage.execId;
  switch (event.case) {
    case "stdout": {
      const data = shellStreamData(event.value);
      if (data) {
        appendShellOutput(session, toolCallId, stream.stdout, data);
        appendShellOutput(session, toolCallId, stream.interleaved, data);
      }
      return null;
    }
    case "stderr": {
      const data = shellStreamData(event.value);
      if (data) {
        appendShellOutput(session, toolCallId, stream.stderr, data);
        appendShellOutput(session, toolCallId, stream.interleaved, data);
      }
      return null;
    }
    case "start":
      applyShellStreamStart(stream, event.value);
      return null;
    case "exit":
      session.shellStreamsByToolCallId.delete(toolCallId);
      return shellResultFromExit(toolCallId, stream, execClientMessage, event.value || {});
    case "rejected":
      session.shellStreamsByToolCallId.delete(toolCallId);
      return shellResultFromTerminalCase(toolCallId, stream, execClientMessage, "rejected", event.value || {});
    case "permissionDenied":
      session.shellStreamsByToolCallId.delete(toolCallId);
      return shellResultFromTerminalCase(toolCallId, stream, execClientMessage, "permissionDenied", event.value || {});
    case "backgrounded":
      session.shellStreamsByToolCallId.delete(toolCallId);
      return shellResultFromBackgrounded(toolCallId, stream, execClientMessage, event.value || {});
    default:
      return null;
  }
}

function shellStreamEvent(value) {
  if (!value || typeof value !== "object") return null;
  const event = value.event;
  if (event?.case) return { case: event.case, value: event.value };
  for (const key of ["start", "stdout", "stderr", "exit", "rejected", "permissionDenied", "backgrounded"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return { case: key, value: value[key] };
    }
  }
  return null;
}

function applyShellStreamStart(stream, value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.command === "string") stream.command = value.command;
  if (typeof value.cwd === "string") stream.workingDirectory = value.cwd;
  if (typeof value.workingDirectory === "string") stream.workingDirectory = value.workingDirectory;
}

function migrateShellStreamAlias(session, fromToolCallId, toToolCallId) {
  if (!fromToolCallId || fromToolCallId === toToolCallId) return;
  const from = session.shellStreamsByToolCallId.get(fromToolCallId);
  if (!from) return;
  const existing = session.shellStreamsByToolCallId.get(toToolCallId);
  if (existing) {
    mergeShellOutput(session, toToolCallId, existing.stdout, from.stdout);
    mergeShellOutput(session, toToolCallId, existing.stderr, from.stderr);
    mergeShellOutput(session, toToolCallId, existing.interleaved, from.interleaved);
    if (from.id !== undefined) existing.id = from.id;
    if (from.execId) existing.execId = from.execId;
  } else {
    session.shellStreamsByToolCallId.set(toToolCallId, from);
  }
  session.shellStreamsByToolCallId.delete(fromToolCallId);
}

function shellStreamData(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (!value || typeof value !== "object") return "";
  if (typeof value.data === "string") return value.data;
  if (typeof value.content === "string") return value.content;
  if (typeof value.output === "string") return value.output;
  if (typeof value.text === "string") return value.text;
  if (typeof value.chunk === "string") return value.chunk;
  return "";
}

function shellOutputBuffer(name, maxChars) {
  return {
    name,
    maxChars,
    chunks: [],
    length: 0,
    omittedChars: 0,
    truncationLogged: false,
  };
}

function appendShellOutput(session, toolCallId, buffer, data) {
  if (!data) return;
  if (data.length >= buffer.maxChars) {
    buffer.chunks = [data.slice(data.length - buffer.maxChars)];
    buffer.omittedChars += buffer.length + data.length - buffer.maxChars;
    buffer.length = buffer.maxChars;
    if (buffer.omittedChars) logShellOutputTruncation(session, toolCallId, buffer, data.length);
    return;
  }
  buffer.chunks.push(data);
  buffer.length += data.length;
  while (buffer.length > buffer.maxChars && buffer.chunks.length) {
    const overflow = buffer.length - buffer.maxChars;
    const first = buffer.chunks[0];
    if (first.length <= overflow) {
      buffer.chunks.shift();
      buffer.length -= first.length;
      buffer.omittedChars += first.length;
    } else {
      buffer.chunks[0] = first.slice(overflow);
      buffer.length -= overflow;
      buffer.omittedChars += overflow;
    }
  }
  if (buffer.omittedChars) logShellOutputTruncation(session, toolCallId, buffer, data.length);
}

function mergeShellOutput(session, toolCallId, target, source) {
  if (source.omittedChars) {
    target.omittedChars += source.omittedChars;
    if (source.truncationLogged) target.truncationLogged = true;
  }
  for (const chunk of source.chunks || []) appendShellOutput(session, toolCallId, target, chunk);
}

function shellOutputText(buffer) {
  const text = buffer.chunks.join("");
  if (!buffer.omittedChars) return text;
  return `[BYOK truncated ${buffer.omittedChars} characters from the beginning of shell ${buffer.name} output]\n${text}`;
}

function logShellOutputTruncation(session, toolCallId, buffer, chunkChars) {
  if (buffer.truncationLogged) return;
  buffer.truncationLogged = true;
  session?._log?.warn?.("BYOK truncated shell stream output", {
    requestId: session?.requestId || "",
    toolCallId: String(toolCallId || ""),
    stream: buffer.name,
    maxChars: buffer.maxChars,
    omittedChars: buffer.omittedChars,
    chunkChars,
  });
}

function shellResultFromExit(toolCallId, stream, execClientMessage, exit) {
  const stdout = shellOutputText(stream.stdout);
  const stderr = shellOutputText(stream.stderr);
  const interleavedOutput = shellOutputText(stream.interleaved);
  const code = Number.isInteger(exit.code) ? exit.code : 0;
  const value = {
    command: typeof exit.command === "string" ? exit.command : stream.command,
    workingDirectory: exit.cwd || exit.workingDirectory || stream.workingDirectory,
    exitCode: code,
    signal: "",
    stdout,
    stderr,
    executionTime: 0,
  };
  if (exit.outputLocation !== undefined) value.outputLocation = exit.outputLocation;
  if (interleavedOutput) value.interleavedOutput = interleavedOutput;
  if (exit.localExecutionTimeMs !== undefined) value.localExecutionTimeMs = exit.localExecutionTimeMs;
  if (exit.aborted !== undefined) value.aborted = !!exit.aborted;
  if (exit.abortReason !== undefined) value.abortReason = exit.abortReason;
  return shellResultMessage(toolCallId, stream, execClientMessage, code === 0 ? "success" : "failure", value);
}

function shellResultFromTerminalCase(toolCallId, stream, execClientMessage, resultCase, value) {
  return shellResultMessage(toolCallId, stream, execClientMessage, resultCase, cloneJson(value));
}

function shellResultFromBackgrounded(toolCallId, stream, execClientMessage, backgrounded) {
  const stdout = shellOutputText(stream.stdout);
  const stderr = shellOutputText(stream.stderr);
  const interleavedOutput = shellOutputText(stream.interleaved);
  const value = {
    command: backgrounded.command || "",
    workingDirectory: backgrounded.workingDirectory || "",
    exitCode: 0,
    signal: "",
    stdout,
    stderr,
    executionTime: 0,
    shellId: backgrounded.shellId,
    interleavedOutput,
    pid: backgrounded.pid,
    msToWait: backgrounded.msToWait,
    backgroundReason: backgrounded.backgroundReason,
  };
  return shellResultMessage(toolCallId, stream, execClientMessage, "success", cleanUndefined(value));
}

function shellResultMessage(toolCallId, stream, execClientMessage, resultCase, value) {
  return cleanUndefined({
    id: execClientMessage.id ?? stream.id,
    execId: execClientMessage.execId || stream.execId || toolCallId,
    _byokToolCallId: toolCallId,
    message: {
      case: "shellResult",
      value: {
        result: {
          case: resultCase,
          value,
        },
      },
    },
  });
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanUndefined(value) {
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function positiveIntegerOrDefault(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function pushLimited(array, value, limit, onDrop) {
  array.push(value);
  while (array.length > limit) {
    const lengthBeforeTrim = array.length;
    const dropped = array.shift();
    onDrop?.(dropped, lengthBeforeTrim);
  }
}

function setLimitedMap(map, key, value, limit, onDrop) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const droppedKey = map.keys().next().value;
    map.delete(droppedKey);
    onDrop?.(droppedKey);
  }
}

function removeArrayItem(array, item) {
  const index = array.indexOf(item);
  if (index >= 0) array.splice(index, 1);
}

function findClientToolCompletionInSession(session, toolCallId, toolName) {
  const { findClientToolCompletion } = require("./client-tool-bridge");
  return findClientToolCompletion(session.records, toolCallId, toolName);
}

function findShellToolCompletionResult(records, toolCallId) {
  const wantedId = String(toolCallId || "");
  if (!wantedId) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const shellResult = collectShellToolCompletionResult(records[i]?.clientMessage, wantedId) ||
      collectShellToolCompletionResult(records[i]?.rawRecord, wantedId);
    if (shellResult) return shellResult;
  }
  return null;
}

function collectShellToolCompletionResult(node, toolCallId, depth = 0) {
  if (!node || depth > 24) return null;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const result = collectShellToolCompletionResult(node[i], toolCallId, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const messageCase = node.case ?? node.message?.case;
  if (messageCase === "toolCallCompleted") {
    const envelope = node.value?.message?.value ?? node.value ?? node.message?.value ?? node;
    if (extractCompletedToolCallId(envelope) === toolCallId) {
      const shellResult = shellResultFromCompletionEnvelope(envelope, toolCallId);
      if (shellResult) return shellResult;
    }
  }

  if (messageCase === "interactionUpdate") {
    const inner = node.value?.message ?? node.message?.value?.message ?? node.value?.message?.value?.message;
    const nested = collectShellToolCompletionResult(inner, toolCallId, depth + 1);
    if (nested) return nested;
  }

  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") continue;
    const nested = collectShellToolCompletionResult(value, toolCallId, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function extractCompletedToolCallId(node) {
  if (!node || typeof node !== "object") return "";
  const direct = node.callId ?? node.call_id ?? node.toolCallId ?? node.tool_call_id;
  if (typeof direct === "string" && direct) return direct;
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  const toolCall = node.toolCall;
  if (toolCall && typeof toolCall === "object") {
    const nested = toolCall.toolCallId ?? toolCall.tool_call_id ?? toolCall.callId ?? toolCall.call_id;
    if (typeof nested === "string" && nested) return nested;
    if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
  }
  return "";
}

function shellResultFromCompletionEnvelope(node, toolCallId) {
  const tool = node?.toolCall?.tool ?? node?.tool?.tool ?? node?.tool;
  if (!tool || typeof tool !== "object" || tool.case !== "shellToolCall") return null;
  const result = tool.value?.result ?? tool.result;
  if (!result || typeof result !== "object") return null;
  return {
    execId: toolCallId,
    _byokToolCallId: toolCallId,
    message: {
      case: "shellResult",
      value: normalizeShellToolCompletionResult(result),
    },
  };
}

function normalizeShellToolCompletionResult(result) {
  if (result?.result?.case) {
    return {
      ...result,
      result: {
        case: result.result.case,
        value: normalizeShellToolCompletionValue(result.result.value),
      },
    };
  }
  for (const caseName of ["success", "error", "rejected", "permissionDenied", "failure", "spawnError"]) {
    if (result?.[caseName] !== undefined) {
      return {
        result: {
          case: caseName,
          value: normalizeShellToolCompletionValue(result[caseName]),
        },
      };
    }
  }
  return { result: { case: "success", value: normalizeShellToolCompletionValue(result) } };
}

function normalizeShellToolCompletionValue(value) {
  if (!value || typeof value !== "object") return value;
  const normalized = { ...value };
  if (normalized.workingDirectory === undefined && typeof normalized.cwd === "string") {
    normalized.workingDirectory = normalized.cwd;
  }
  if (normalized.stdout === undefined && typeof normalized.output === "string") normalized.stdout = normalized.output;
  if (normalized.stderr === undefined) normalized.stderr = "";
  if (normalized.output === undefined && typeof normalized.stdout === "string") normalized.output = normalized.stdout;
  if (normalized.exitCode === undefined && normalized.code !== undefined) normalized.exitCode = normalized.code;
  return normalized;
}

function collectToolCallIdsFromRecord(clientMessage, rawRecord) {
  const ids = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > 24) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const direct = node.callId ?? node.call_id ?? node.toolCallId ?? node.tool_call_id;
    if (typeof direct === "string" && direct) ids.add(direct);
    if (typeof direct === "number" && Number.isFinite(direct)) ids.add(String(direct));
    const toolCall = node.toolCall;
    if (toolCall && typeof toolCall === "object") {
      const nested = toolCall.callId ?? toolCall.call_id ?? toolCall.toolCallId ?? toolCall.tool_call_id;
      if (typeof nested === "string" && nested) ids.add(nested);
      if (typeof nested === "number" && Number.isFinite(nested)) ids.add(String(nested));
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(clientMessage);
  visit(rawRecord);
  return [...ids];
}

module.exports = {
  BidiRawQueue,
  ByokSessionStore,
  ConversationPins,
  DEFAULT_MAX_SHELL_STREAM_BUFFER_CHARS,
  classifyBidiPayload,
  extractPayloadBytes,
  findExecToolCallId,
  findRequestId,
  findToolCallIdInValue,
  mergeRunRequest,
  normalizeBidiRecord,
};
