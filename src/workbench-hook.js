"use strict";

function buildWorkbenchHook({ host, port, portSearchCount = 8, routes, byokModelIds = [], byokModels = [] }) {
  const byokUrl = `http://${host}:${port}`;
  const routePatterns = routes.map((route) => route.replace(/^REST:/, ""));
  return `/* CURSOR-BYOK-HOOK-V2-START */(${hookRuntime.toString()})(${JSON.stringify({
    byokUrl,
    byokHost: host,
    byokPort: port,
    byokPortSearchCount: portSearchCount,
    routes: routePatterns,
    byokModelIds,
    byokModels,
  })})/* CURSOR-BYOK-HOOK-V2-END */\n`;
}

function hookRuntime(config) {
  if (globalThis.__cursorByokReady) return;
  globalThis.__cursorByokReady = true;

  var byokUrl = normalizeByokBaseUrl(readRememberedByokUrl() || config.byokUrl);
  var byokBaseHost = typeof config.byokHost === "string" && config.byokHost
    ? config.byokHost
    : parseByokBaseUrl(config.byokUrl).host;
  var byokBasePort = Number.isInteger(config.byokPort) && config.byokPort > 0
    ? config.byokPort
    : parseByokBaseUrl(config.byokUrl).port;
  var byokPortSearchCount = Number.isInteger(config.byokPortSearchCount) && config.byokPortSearchCount > 0
    ? config.byokPortSearchCount
    : 8;
  var byokUrlRefreshPromise = null;
  var rawFetch = null;
  var routes = Array.isArray(config.routes) ? config.routes : [];
  var maxNdjsonLineBytes = Number.isInteger(config.maxNdjsonLineBytes) && config.maxNdjsonLineBytes > 0
    ? config.maxNdjsonLineBytes
    : 64 * 1024 * 1024;
  var byokRunReadyWaitMs = Number.isInteger(config.byokRunReadyWaitMs) && config.byokRunReadyWaitMs >= 0
    ? config.byokRunReadyWaitMs
    : 10000;
  var byokRunReadyRetryDelayMs = Number.isInteger(config.byokRunReadyRetryDelayMs) && config.byokRunReadyRetryDelayMs >= 0
    ? config.byokRunReadyRetryDelayMs
    : 100;
  var captured = {
    messageCtor: null,
  };
  var byokModelsCache = [];
  var byokModelsLoaded = false;
  var byokModelsRefreshPromise = null;
  globalThis.__cursorByokModelIds = new Set();
  globalThis.__cursorByokBypassFreeModelLock = function bypassFreeModelLock() {
    return !!(globalThis.__cursorByokModelIds && globalThis.__cursorByokModelIds.size > 0);
  };
  globalThis.__cursorByokIsModel = function isByokModelName(modelName) {
    return typeof modelName === "string" && globalThis.__cursorByokModelIds.has(modelName);
  };
  globalThis.__cursorByokPickModelId = function pickByokModelId(candidates) {
    var first = "";
    if (!Array.isArray(candidates)) return first;
    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i];
      if (typeof id !== "string" || !id) continue;
      if (!first) first = id;
      if (globalThis.__cursorByokIsModel(id)) return id;
    }
    return first;
  };
  globalThis.__cursorByokHasModelCandidate = function hasByokModelCandidate(candidates) {
    if (!Array.isArray(candidates)) return false;
    for (var i = 0; i < candidates.length; i++) {
      if (globalThis.__cursorByokIsModel(candidates[i])) return true;
    }
    return false;
  };
  if (!globalThis.__cursorByokComposerModesByRequestId || typeof globalThis.__cursorByokComposerModesByRequestId.get !== "function") {
    globalThis.__cursorByokComposerModesByRequestId = new Map();
  }
  if (!globalThis.__cursorByokConversationContextById || typeof globalThis.__cursorByokConversationContextById.get !== "function") {
    globalThis.__cursorByokConversationContextById = new Map();
  }
  var CONVERSATION_CONTEXT_CACHE_LIMIT = 64;
  var PERSISTED_CONVERSATION_CONTEXT_STORAGE_KEY = "cursorByok.conversationContext.v1";
  var PERSISTED_CONVERSATION_MESSAGE_LIMIT = 96;
  if (typeof globalThis.__cursorByokLastComposerMode !== "string") {
    globalThis.__cursorByokLastComposerMode = "";
  }
  if (!Array.isArray(globalThis.__cursorByokDebug)) {
    globalThis.__cursorByokDebug = [];
  }
  globalThis.__cursorByokRememberComposerMode = function rememberByokComposerMode(requestId, mode) {
    if (typeof requestId !== "string" || !requestId || typeof mode !== "string" || !mode) return;
    try {
      globalThis.__cursorByokComposerModesByRequestId.set(requestId, mode);
      globalThis.__cursorByokLastComposerMode = mode;
    } catch {}
  };
  function toJson(value) {
    if (!value) return null;
    try {
      if (typeof value.toJson === "function") return value.toJson();
    } catch {}
    try {
      if (typeof value.toJsonString === "function") return JSON.parse(value.toJsonString());
    } catch {}
    return value;
  }

  function fromJson(type, value) {
    if (!type) return value;
    try {
      if (typeof type.fromJson === "function") return type.fromJson(value);
    } catch {}
    try {
      return new type(value);
    } catch {
      return value;
    }
  }

  function headersToObject(headers) {
    if (!headers) return {};
    try {
      if (headers instanceof Headers) return Object.fromEntries(headers);
    } catch {}
    return typeof headers === "object" ? headers : {};
  }

  function headerValue(headers, name) {
    if (!headers) return "";
    try {
      if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {}
    var object = headersToObject(headers);
    return object[name] || object[name.toLowerCase()] || object[name.toUpperCase()] || "";
  }

  function requestIdFromHeaders(headers) {
    return headerValue(headers, "x-request-id") || headerValue(headers, "x-original-request-id") || findRequestId(headersToObject(headers));
  }

  function originalRequestIdFromHeaders(headers) {
    return headerValue(headers, "x-original-request-id") || "";
  }

  function explicitComposerMode(request) {
    if (!request || typeof request !== "object") return "";
    if (typeof request.composerMode === "string" && request.composerMode) return request.composerMode;
    if (typeof request.composer_mode === "string" && request.composer_mode) return request.composer_mode;
    if (typeof request.mode === "string" && request.mode) return request.mode;
    var state = request.conversationState || request.field6_conversationState;
    return state && typeof state.mode === "string" ? state.mode : "";
  }

  function composerModeForRequestId(requestId) {
    if (typeof requestId !== "string" || !requestId) return "";
    var modes = globalThis.__cursorByokComposerModesByRequestId;
    if (!modes || typeof modes.get !== "function") return "";
    try {
      var mode = modes.get(requestId);
      return typeof mode === "string" ? mode : "";
    } catch {
      return "";
    }
  }

  function rememberComposerModeAlias(requestId, originalRequestId) {
    if (typeof requestId !== "string" || !requestId || typeof originalRequestId !== "string" || !originalRequestId || requestId === originalRequestId) return;
    var mode = composerModeForRequestId(originalRequestId);
    if (!mode) return;
    try {
      globalThis.__cursorByokComposerModesByRequestId.set(requestId, mode);
      globalThis.__cursorByokLastComposerMode = mode;
    } catch {}
  }

  function rememberComposerModeForRequest(requestId, mode) {
    if (typeof mode !== "string" || !mode) return;
    try {
      globalThis.__cursorByokLastComposerMode = mode;
      if (typeof requestId === "string" && requestId) {
        globalThis.__cursorByokComposerModesByRequestId.set(requestId, mode);
      }
    } catch {}
  }

  function stableMessageKey(message) {
    try {
      return JSON.stringify(cloneJsonValue(message));
    } catch {
      return String(message);
    }
  }

  function normalizedComparableText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var part = normalizedComparableText(value[i]);
        if (part) parts.push(part);
      }
      return parts.join("\n");
    }
    if (!value || typeof value !== "object") return "";
    if (typeof value.text === "string" && value.text) return normalizedComparableText(value.text);
    if (value.content !== undefined) {
      var contentText = normalizedComparableText(value.content);
      if (contentText) return contentText;
    }
    if (value.value !== undefined) {
      var valueText = normalizedComparableText(value.value);
      if (valueText) return valueText;
    }
    if (value.message !== undefined) {
      var messageText = normalizedComparableText(value.message);
      if (messageText) return messageText;
    }
    if (value.output !== undefined) {
      var outputText = normalizedComparableText(value.output);
      if (outputText) return outputText;
    }
    return "";
  }

  function isEmptyComparableValue(value) {
    return value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  }

  function comparableStructuredContentToken(value) {
    if (!value || typeof value !== "object") return null;
    var type = typeof value.type === "string" ? value.type : "";
    var imageUrl = value.image_url && typeof value.image_url === "object" ? value.image_url : {};
    var url = typeof imageUrl.url === "string" && imageUrl.url
      ? imageUrl.url
      : typeof value.image_url === "string" && value.image_url
        ? value.image_url
        : typeof value.imageUrl === "string" && value.imageUrl
          ? value.imageUrl
          : typeof value.url === "string" && value.url
            ? value.url
            : "";
    if (type === "image_url" || type === "input_image" || url) {
      return {
        type: "image",
        url: url,
        detail: typeof imageUrl.detail === "string" && imageUrl.detail
          ? imageUrl.detail
          : typeof value.detail === "string" && value.detail
            ? value.detail
            : "",
      };
    }
    var source = value.source && typeof value.source === "object" ? value.source : {};
    var sourceType = typeof source.type === "string" ? source.type : "";
    if (type === "image" || sourceType) {
      return {
        type: "image",
        sourceType: sourceType,
        url: typeof source.url === "string" && source.url ? source.url : "",
        uri: typeof source.uri === "string" && source.uri ? source.uri : "",
        mediaType: typeof source.media_type === "string" && source.media_type
          ? source.media_type
          : typeof source.mimeType === "string" && source.mimeType
            ? source.mimeType
            : "",
        hasData: source.data !== undefined || value.data !== undefined,
      };
    }
    var file = value.file && typeof value.file === "object" ? value.file : {};
    var fileId = typeof file.file_id === "string" && file.file_id
      ? file.file_id
      : typeof value.file_id === "string" && value.file_id
        ? value.file_id
        : typeof value.fileId === "string" && value.fileId
          ? value.fileId
          : "";
    var filename = typeof file.filename === "string" && file.filename
      ? file.filename
      : typeof value.filename === "string" && value.filename
        ? value.filename
        : "";
    var hasFileData = file.file_data !== undefined || value.file_data !== undefined || value.fileData !== undefined;
    if (type === "file" || type === "input_file" || fileId || filename || hasFileData) {
      return {
        type: "file",
        fileId: fileId,
        filename: filename,
        hasData: hasFileData,
      };
    }
    if (type === "document") {
      return {
        type: "document",
        sourceType: sourceType,
        url: typeof source.url === "string" && source.url ? source.url : "",
        uri: typeof source.uri === "string" && source.uri ? source.uri : "",
        mediaType: typeof source.media_type === "string" && source.media_type
          ? source.media_type
          : typeof source.mimeType === "string" && source.mimeType
            ? source.mimeType
            : "",
        hasData: source.data !== undefined || value.data !== undefined,
      };
    }
    return null;
  }

  function comparableMessageValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      var allText = true;
      for (var i = 0; i < value.length; i++) {
        var part = comparableMessageValue(value[i]);
        if (isEmptyComparableValue(part)) continue;
        if (typeof part !== "string") allText = false;
        parts.push(part);
      }
      return allText ? parts.join("\n") : parts;
    }
    if (!value || typeof value !== "object") return "";
    var structured = comparableStructuredContentToken(value);
    if (structured) return structured;
    if (typeof value.text === "string" && value.text) return comparableMessageValue(value.text);
    if (value.content !== undefined) {
      var contentValue = comparableMessageValue(value.content);
      if (!isEmptyComparableValue(contentValue)) return contentValue;
    }
    if (value.value !== undefined) {
      var valueComparable = comparableMessageValue(value.value);
      if (!isEmptyComparableValue(valueComparable)) return valueComparable;
    }
    if (value.message !== undefined) {
      var messageComparable = comparableMessageValue(value.message);
      if (!isEmptyComparableValue(messageComparable)) return messageComparable;
    }
    if (value.output !== undefined) {
      var outputComparable = comparableMessageValue(value.output);
      if (!isEmptyComparableValue(outputComparable)) return outputComparable;
    }
    return "";
  }

  function comparableMessageKey(message) {
    if (!message || typeof message !== "object") return stableMessageKey(message);
    var role = typeof message.role === "string" && message.role
      ? message.role
      : typeof message.type === "string" && message.type
        ? message.type
        : "";
    var name = typeof message.name === "string" ? message.name : "";
    var content = comparableMessageValue(message.content);
    if (isEmptyComparableValue(content) && message.text !== undefined) content = comparableMessageValue(message.text);
    if (isEmptyComparableValue(content) && message.message !== undefined) content = comparableMessageValue(message.message);
    if (isEmptyComparableValue(content) && message.value !== undefined) content = comparableMessageValue(message.value);
    return JSON.stringify({ role: role, name: name, content: content });
  }

  function actionMessageHasNonTextContent(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (actionMessageHasNonTextContent(value[i])) return true;
      }
      return false;
    }
    if (!value || typeof value !== "object") return false;
    if (comparableStructuredContentToken(value)) return true;
    if (value.content !== undefined && actionMessageHasNonTextContent(value.content)) return true;
    if (value.value !== undefined && actionMessageHasNonTextContent(value.value)) return true;
    if (value.message !== undefined && actionMessageHasNonTextContent(value.message)) return true;
    if (value.output !== undefined && actionMessageHasNonTextContent(value.output)) return true;
    return false;
  }

  function actionMessageStructuredContent(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return actionMessageHasNonTextContent(value) ? cloneJsonValue(value) : null;
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value.content) && actionMessageHasNonTextContent(value.content)) return cloneJsonValue(value.content);
    if (Array.isArray(value.value) && actionMessageHasNonTextContent(value.value)) return cloneJsonValue(value.value);
    if (Array.isArray(value.message) && actionMessageHasNonTextContent(value.message)) return cloneJsonValue(value.message);
    return null;
  }

  function actionUserMessageText(message) {
    if (message === null || message === undefined) return "";
    if (typeof message === "string") return message;
    if (message && typeof message === "object" && typeof message.text === "string" && message.text) return message.text;
    return normalizedComparableText(message);
  }

  function actionUserMessageContent(message) {
    var structured = actionMessageStructuredContent(message);
    if (structured) return structured;
    return actionUserMessageText(message);
  }

  function arrayEndsWithSequence(values, suffix) {
    if (!Array.isArray(values) || !Array.isArray(suffix)) return false;
    if (!suffix.length) return true;
    if (suffix.length > values.length) return false;
    var start = values.length - suffix.length;
    for (var i = 0; i < suffix.length; i++) {
      if (values[start + i] !== suffix[i]) return false;
    }
    return true;
  }

  function largestMessageOverlap(previousKeys, nextKeys) {
    var max = Math.min(previousKeys.length, nextKeys.length);
    for (var size = max; size > 0; size--) {
      var matches = true;
      for (var i = 0; i < size; i++) {
        if (previousKeys[previousKeys.length - size + i] !== nextKeys[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return size;
    }
    return 0;
  }

  function findNextMessageIndex(messages, needleMessage, startIndex, keyFn) {
    var haystack = Array.isArray(messages) ? messages : [];
    var index = Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0;
    var key = typeof keyFn === "function" ? keyFn : stableMessageKey;
    var needleKey = key(needleMessage);
    for (; index < haystack.length; index++) {
      if (key(haystack[index]) === needleKey) return index;
    }
    return -1;
  }

  function orderedMessagePrefixLength(haystackMessages, needleMessages, keyFn) {
    var haystack = Array.isArray(haystackMessages) ? haystackMessages : [];
    var needle = Array.isArray(needleMessages) ? needleMessages : [];
    if (!needle.length) return 0;
    var key = typeof keyFn === "function" ? keyFn : stableMessageKey;
    var haystackKeys = haystack.map(key);
    var needleKeys = needle.map(key);
    var needleIndex = 0;
    for (var haystackIndex = 0; haystackIndex < haystackKeys.length && needleIndex < needleKeys.length; haystackIndex++) {
      if (haystackKeys[haystackIndex] !== needleKeys[needleIndex]) continue;
      needleIndex++;
    }
    return needleIndex;
  }

  function appendConversationMessages(previousMessages, nextMessages) {
    var previous = Array.isArray(previousMessages) ? previousMessages.map(cloneJsonValue) : [];
    var next = Array.isArray(nextMessages) ? nextMessages.map(cloneJsonValue) : [];
    if (!previous.length) return next;
    if (!next.length) return previous;
    var previousKeys = previous.map(stableMessageKey);
    var nextKeys = next.map(stableMessageKey);
    if (arrayEndsWithSequence(previousKeys, nextKeys)) return previous;
    if (arrayEndsWithSequence(nextKeys, previousKeys)) return next;
    var overlap = largestMessageOverlap(previousKeys, nextKeys);
    if (overlap > 0) return previous.concat(next.slice(overlap));
    var orderedPrefix = orderedMessagePrefixLength(previous, next, stableMessageKey);
    if (orderedPrefix <= 0) orderedPrefix = orderedMessagePrefixLength(previous, next, comparableMessageKey);
    if (orderedPrefix >= next.length) return previous;
    if (orderedPrefix > 0) return previous.concat(next.slice(orderedPrefix));
    return previous.concat(next);
  }

  function rebuildConversationMessages(previousMessages, nextMessages) {
    var previous = Array.isArray(previousMessages) ? previousMessages.map(cloneJsonValue) : [];
    var next = Array.isArray(nextMessages) ? nextMessages.map(cloneJsonValue) : [];
    if (!previous.length) return next;
    if (!next.length) return previous;
    var rebuilt = [];
    var previousIndex = 0;
    var nextIndex = 0;
    for (; nextIndex < next.length; nextIndex++) {
      var matchIndex = findNextMessageIndex(previous, next[nextIndex], previousIndex, stableMessageKey);
      if (matchIndex < 0) matchIndex = findNextMessageIndex(previous, next[nextIndex], previousIndex, comparableMessageKey);
      if (matchIndex < 0) break;
      for (var copyIndex = previousIndex; copyIndex <= matchIndex; copyIndex++) {
        rebuilt.push(previous[copyIndex]);
      }
      previousIndex = matchIndex + 1;
    }
    if (!rebuilt.length && nextIndex <= 0) return appendConversationMessages(previous, next);
    if (nextIndex >= next.length) return rebuilt;
    return rebuilt.concat(next.slice(nextIndex));
  }

  function extractRunActionsForContext(request) {
    if (!request || typeof request !== "object") return [];
    var out = [];
    function append(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) append(value[i]);
        return;
      }
      out.push(value);
    }
    append(request.action);
    append(request.actions);
    append(request.conversationAction);
    append(request.conversationActions);
    append(request.conversationActionOverride);
    return out;
  }

  function actionUserMessagesForContext(actionValue) {
    var messages = [];
    var actions = Array.isArray(actionValue) ? actionValue : actionValue ? [actionValue] : [];
    for (var i = 0; i < actions.length; i++) {
      var extracted = extractConversationAction(actions[i]);
      if (!extracted || !extracted.case || !extracted.value || typeof extracted.value !== "object") continue;
      var rawUserMessages = extracted.value.userMessage;
      var userMessages = Array.isArray(rawUserMessages)
        ? rawUserMessages
        : rawUserMessages
          ? [rawUserMessages]
          : [];
      for (var j = 0; j < userMessages.length; j++) {
        var content = actionUserMessageContent(userMessages[j]);
        if (!content) continue;
        messages.push({ role: "user", content: content });
      }
    }
    return messages;
  }

  function requestConversationMessages(request) {
    var base = Array.isArray(request && request.messages) ? request.messages.map(cloneJsonValue) : [];
    var actionMessages = actionUserMessagesForContext(extractRunActionsForContext(request));
    if (!actionMessages.length) return base;
    if (!base.length) return actionMessages;
    var baseKeys = base.map(stableMessageKey);
    var actionKeys = actionMessages.map(stableMessageKey);
    if (arrayEndsWithSequence(baseKeys, actionKeys)) return base;
    if (base.length > actionMessages.length) {
      var prefixMatches = true;
      for (var i = 0; i < actionKeys.length; i++) {
        if (baseKeys[i] !== actionKeys[i]) {
          prefixMatches = false;
          break;
        }
      }
      if (prefixMatches) return base;
    }
    var overlap = largestMessageOverlap(baseKeys, actionKeys);
    if (overlap > 0) return base.concat(actionMessages.slice(overlap));
    return base.concat(actionMessages);
  }

  function requestVisibleMessages(request) {
    return Array.isArray(request && request.messages) ? request.messages.map(cloneJsonValue) : [];
  }

  function domTranscriptText(value) {
    if (!value || typeof value !== "object") return "";
    var text = typeof value.innerText === "string"
      ? value.innerText
      : typeof value.textContent === "string"
        ? value.textContent
        : "";
    if (!text) return "";
    return text.replace(/\r\n?/g, "\n").trim();
  }

  function uniqueDomTranscriptTexts(nodes) {
    var values = [];
    var previous = "";
    var list = Array.isArray(nodes) ? nodes : nodes ? Array.prototype.slice.call(nodes) : [];
    for (var i = 0; i < list.length; i++) {
      var text = domTranscriptText(list[i]);
      if (!text || text === previous) continue;
      values.push(text);
      previous = text;
    }
    return values;
  }

  function pairTranscriptMessages(pair) {
    if (!pair || typeof pair.querySelectorAll !== "function") return [];
    var messages = [];
    var userTexts = uniqueDomTranscriptTexts(pair.querySelectorAll(".aislash-editor-input-readonly, .composer-human-message-content, .composer-human-message"));
    if (userTexts.length) messages.push({ role: "user", content: userTexts[0] });
    var assistantTexts = uniqueDomTranscriptTexts(pair.querySelectorAll(".markdown-root"));
    for (var i = 0; i < assistantTexts.length; i++) {
      messages.push({ role: "assistant", content: assistantTexts[i] });
    }
    return messages;
  }

  function visibleComposerTranscriptMessages() {
    var doc = globalThis && globalThis.document;
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    var pairs;
    try {
      pairs = doc.querySelectorAll(".composer-human-ai-pair-container");
    } catch {
      return [];
    }
    var list = Array.isArray(pairs) ? pairs : pairs ? Array.prototype.slice.call(pairs) : [];
    var messages = [];
    for (var i = 0; i < list.length; i++) {
      var pairMessages = pairTranscriptMessages(list[i]);
      for (var j = 0; j < pairMessages.length; j++) messages.push(pairMessages[j]);
    }
    return messages;
  }

  function browserStorage() {
    try {
      var storage = globalThis && globalThis.localStorage;
      if (
        storage
        && typeof storage.getItem === "function"
        && typeof storage.setItem === "function"
        && typeof storage.removeItem === "function"
      ) {
        return storage;
      }
    } catch {}
    return null;
  }

  function trimConversationContextCache(cache, limit) {
    if (!cache || typeof cache.size !== "number" || typeof cache.forEach !== "function" || cache.size <= limit) return;
    var oldestKey = "";
    var oldestAt = Infinity;
    cache.forEach(function (value, key) {
      var updatedAt = value && typeof value.updatedAt === "number" ? value.updatedAt : 0;
      if (updatedAt < oldestAt) {
        oldestAt = updatedAt;
        oldestKey = key;
      }
    });
    if (oldestKey && typeof cache.delete === "function") cache.delete(oldestKey);
  }

  function trimPersistedConversationContextEntries(entries, limit) {
    var ids = Object.keys(entries);
    if (ids.length <= limit) return entries;
    ids.sort(function (left, right) {
      var leftAt = entries[left] && typeof entries[left].updatedAt === "number" ? entries[left].updatedAt : 0;
      var rightAt = entries[right] && typeof entries[right].updatedAt === "number" ? entries[right].updatedAt : 0;
      return leftAt - rightAt;
    });
    while (ids.length > limit) {
      delete entries[ids.shift()];
    }
    return entries;
  }

  function reducedConversationContextSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    var reduced = {};
    var messages = requestConversationMessages(snapshot);
    if (messages.length > PERSISTED_CONVERSATION_MESSAGE_LIMIT) {
      messages = messages.slice(messages.length - PERSISTED_CONVERSATION_MESSAGE_LIMIT);
    }
    if (messages.length) reduced.messages = messages.map(cloneJsonValue);
    var systemPrompt = snapshot.systemPrompt !== undefined ? snapshot.systemPrompt : snapshot.system;
    if (systemPrompt !== undefined && systemPrompt !== null && systemPrompt !== "") {
      reduced.systemPrompt = cloneJsonValue(systemPrompt);
    }
    if (snapshot.customSystemPrompt !== undefined && snapshot.customSystemPrompt !== null && snapshot.customSystemPrompt !== "") {
      reduced.customSystemPrompt = cloneJsonValue(snapshot.customSystemPrompt);
    }
    if (Array.isArray(snapshot.workspaceRoots) && snapshot.workspaceRoots.length) {
      reduced.workspaceRoots = snapshot.workspaceRoots.map(cloneJsonValue);
    }
    return Object.keys(reduced).length ? reduced : null;
  }

  function readPersistedConversationContextEntries() {
    var storage = browserStorage();
    if (!storage) return {};
    try {
      var raw = storage.getItem(PERSISTED_CONVERSATION_CONTEXT_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
    return {};
  }

  function writePersistedConversationContextEntries(entries) {
    var storage = browserStorage();
    if (!storage) return;
    var next = trimPersistedConversationContextEntries(entries, CONVERSATION_CONTEXT_CACHE_LIMIT);
    for (;;) {
      var ids = Object.keys(next);
      if (!ids.length) break;
      try {
        storage.setItem(PERSISTED_CONVERSATION_CONTEXT_STORAGE_KEY, JSON.stringify(next));
        return;
      } catch {}
      ids.sort(function (left, right) {
        var leftAt = next[left] && typeof next[left].updatedAt === "number" ? next[left].updatedAt : 0;
        var rightAt = next[right] && typeof next[right].updatedAt === "number" ? next[right].updatedAt : 0;
        return leftAt - rightAt;
      });
      delete next[ids[0]];
    }
    try {
      storage.removeItem(PERSISTED_CONVERSATION_CONTEXT_STORAGE_KEY);
    } catch {}
  }

  function persistConversationContext(conversationId, snapshot, updatedAt) {
    if (typeof conversationId !== "string" || !conversationId) return;
    var reduced = reducedConversationContextSnapshot(snapshot);
    if (!reduced) return;
    var entries = readPersistedConversationContextEntries();
    entries[conversationId] = {
      request: reduced,
      updatedAt: typeof updatedAt === "number" ? updatedAt : Date.now(),
    };
    writePersistedConversationContextEntries(entries);
  }

  function restoreConversationContext(conversationId) {
    if (typeof conversationId !== "string" || !conversationId) return null;
    var entries = readPersistedConversationContextEntries();
    var persisted = entries[conversationId];
    var request = persisted && persisted.request && typeof persisted.request === "object"
      ? cloneJsonValue(persisted.request)
      : null;
    if (!request) return null;
    var entry = {
      request: request,
      updatedAt: typeof persisted.updatedAt === "number" ? persisted.updatedAt : Date.now(),
    };
    try {
      globalThis.__cursorByokConversationContextById.set(conversationId, entry);
      trimConversationContextCache(globalThis.__cursorByokConversationContextById, CONVERSATION_CONTEXT_CACHE_LIMIT);
    } catch {}
    return entry;
  }

  function rememberConversationContext(requestId, request, assistantText) {
    var conversationId = conversationIdForRequest(request, requestId);
    if (!conversationId) return;
    var snapshot = cloneJsonValue(toJson(request) || request);
    if (!snapshot || typeof snapshot !== "object") return;
    if (typeof assistantText === "string" && assistantText.trim()) {
      var messages = requestConversationMessages(snapshot);
      messages.push({ role: "assistant", content: assistantText });
      snapshot.messages = messages;
    }
    var updatedAt = Date.now();
    globalThis.__cursorByokConversationContextById.set(conversationId, {
      request: snapshot,
      updatedAt: updatedAt,
    });
    trimConversationContextCache(globalThis.__cursorByokConversationContextById, CONVERSATION_CONTEXT_CACHE_LIMIT);
    persistConversationContext(conversationId, snapshot, updatedAt);
  }

  function attachConversationContext(requestId, request) {
    var requestJson = toJson(request) || request;
    if (!requestJson || typeof requestJson !== "object") return request;
    var conversationId = conversationIdForRequest(requestJson, requestId);
    if (!conversationId) return request;
    var remembered = globalThis.__cursorByokConversationContextById.get(conversationId);
    if (!remembered || !remembered.request || typeof remembered.request !== "object") {
      remembered = restoreConversationContext(conversationId);
    }
    var previous = remembered && remembered.request && typeof remembered.request === "object" ? remembered.request : null;
    var next = cloneJsonValue(requestJson);
    var changed = false;
    var domMessages = visibleComposerTranscriptMessages();
    var previousMessages = domMessages.length
      ? domMessages
      : previous
        ? requestConversationMessages(previous)
        : [];
    if (!previous && !previousMessages.length) return request;
    var mergedMessages = rebuildConversationMessages(previousMessages, requestConversationMessages(next));
    var visibleMessages = requestVisibleMessages(next);
    if (stableMessageKey(mergedMessages) !== stableMessageKey(visibleMessages)) {
      next.messages = mergedMessages;
      changed = true;
    }
    if (!previous) return changed ? next : request;
    if ((next.systemPrompt === undefined || next.systemPrompt === null || next.systemPrompt === "") && previous.systemPrompt !== undefined) {
      next.systemPrompt = cloneJsonValue(previous.systemPrompt);
      changed = true;
    }
    if ((next.customSystemPrompt === undefined || next.customSystemPrompt === null || next.customSystemPrompt === "") && previous.customSystemPrompt !== undefined) {
      next.customSystemPrompt = cloneJsonValue(previous.customSystemPrompt);
      changed = true;
    }
    if ((!Array.isArray(next.workspaceRoots) || !next.workspaceRoots.length) && Array.isArray(previous.workspaceRoots) && previous.workspaceRoots.length) {
      next.workspaceRoots = previous.workspaceRoots.map(cloneJsonValue);
      changed = true;
    }
    if ((!Array.isArray(next.mcpTools) || !next.mcpTools.length) && Array.isArray(previous.mcpTools) && previous.mcpTools.length) {
      next.mcpTools = previous.mcpTools.map(cloneJsonValue);
      changed = true;
    }
    return changed ? next : request;
  }

  function lastComposerMode() {
    return typeof globalThis.__cursorByokLastComposerMode === "string" ? globalThis.__cursorByokLastComposerMode : "";
  }

  function originalRequestIdForRun(headers, input) {
    return originalRequestIdFromHeaders(headers) || stringArg(input && (input.originalRequestId || input.original_request_id), "");
  }

  function attachComposerMode(requestId, request, originalRequestId) {
    if (!request || typeof request !== "object") return request;
    var explicitMode = explicitComposerMode(request);
    if (explicitMode) {
      rememberComposerModeForRequest(requestId, explicitMode);
      return request;
    }
    var mode = composerModeForRequestId(requestId) || composerModeForRequestId(originalRequestId) || lastComposerMode();
    if (!mode) return request;
    rememberComposerModeAlias(requestId, originalRequestId);
    rememberComposerModeForRequest(requestId, mode);
    return Object.assign({}, request, { composerMode: mode });
  }

  function injectWindowId(headers) {
    var wid = typeof window !== "undefined" && window.vscodeWindowId;
    if (typeof wid !== "number") return headers;
    var value = String(wid);
    try {
      if (headers && typeof headers.set === "function") {
        headers.set("x-client-wid", value);
        return headers;
      }
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        headers["x-client-wid"] = value;
        return headers;
      }
      if (Array.isArray(headers)) {
        headers.push(["x-client-wid", value]);
        return headers;
      }
    } catch {}
    var next = new Headers();
    next.set("x-client-wid", value);
    return next;
  }

  function eventStreamUrl(baseUrl, path) {
    var wid = typeof window !== "undefined" && window.vscodeWindowId;
    if (typeof wid !== "number") return baseUrl + path;
    return baseUrl + path + (path.indexOf("?") === -1 ? "?" : "&") + "wid=" + encodeURIComponent(String(wid));
  }

  function findRequestId(value, seen) {
    if (!value) return "";
    if (!seen) seen = new Set();
    if (typeof value === "string") {
      var match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return match ? match[0] : "";
    }
    if (typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);
    var keys = ["requestId", "request_id", "conversationId", "conversation_id"];
    for (var i = 0; i < keys.length; i++) {
      var direct = findRequestId(value[keys[i]], seen);
      if (direct) return direct;
    }
    var values = Object.values(value);
    for (var j = 0; j < values.length; j++) {
      var nested = findRequestId(values[j], seen);
      if (nested) return nested;
    }
    return "";
  }

  function conversationIdForRequest(request, fallback) {
    if (!request || typeof request !== "object") return fallback || "";
    var state = request.conversationState;
    var nested = state && typeof state === "object" ? state.conversationId : "";
    return request.conversationId || nested || fallback || "";
  }

  function appendModelRecordCandidates(candidates, record) {
    if (!record || typeof record !== "object") return;
    candidates.push(
      record.modelId,
      record.modelName,
      record.name,
      record.apiModel,
      record.displayModelId,
      record.displayName,
    );
  }

  function resolvePrimaryModelNameFromConfig(modelConfig) {
    if (!modelConfig || typeof modelConfig !== "object") return "";
    var modelName = typeof modelConfig.modelName === "string" ? modelConfig.modelName : "";
    if (modelName && modelName !== "default") return modelName;
    var selected = modelConfig.selectedModels;
    if (!Array.isArray(selected) || !selected.length) return modelName;
    for (var i = 0; i < selected.length; i++) {
      var entry = selected[i];
      if (!entry) continue;
      if (typeof entry === "string" && entry && entry !== "default") return entry;
      if (typeof entry.modelId === "string" && entry.modelId && entry.modelId !== "default") return entry.modelId;
      if (typeof entry.modelName === "string" && entry.modelName && entry.modelName !== "default") return entry.modelName;
    }
    return modelName;
  }

  function appendModelConfigCandidates(candidates, modelConfig) {
    if (!modelConfig || typeof modelConfig !== "object") return;
    candidates.push(modelConfig.modelName, modelConfig.model, modelConfig.modelId);
    var resolved = resolvePrimaryModelNameFromConfig(modelConfig);
    if (resolved) candidates.push(resolved);
    appendSelectedModelCandidates(candidates, modelConfig.selectedModels);
  }

  function hasMeaningfulModelCandidate(candidates) {
    if (!Array.isArray(candidates)) return false;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (typeof candidate === "string" && candidate && candidate !== "default") return true;
    }
    return false;
  }

  function appendPlanExecutionModelConfigCandidates(candidates, request) {
    if (!request || typeof request !== "object") return;
    appendModelConfigCandidates(candidates, request.planExecutionModelConfig);
    if (!request.modelConfig || typeof request.modelConfig !== "object") return;
    appendModelConfigCandidates(candidates, request.modelConfig["plan-execution"]);
    appendModelConfigCandidates(candidates, request.modelConfig.planExecution);
  }

  function requestModelCandidates(request) {
    if (!request || typeof request !== "object") return [];
    var candidates = [];
    if (typeof request.modelOverride === "string" && request.modelOverride) candidates.push(request.modelOverride);
    candidates.push(
      request.requestedModel && request.requestedModel.modelId,
      request.modelDetails && request.modelDetails.modelId,
      request.requestedModel && request.requestedModel.modelName,
      request.modelDetails && request.modelDetails.modelName,
      request.requestedModel && request.requestedModel.name,
      request.modelDetails && request.modelDetails.name,
      request.requestedModel && request.requestedModel.apiModel,
      request.modelDetails && request.modelDetails.apiModel,
      request.requestedModel && request.requestedModel.displayModelId,
      request.modelDetails && request.modelDetails.displayModelId,
      request.requestedModel && request.requestedModel.displayName,
      request.modelDetails && request.modelDetails.displayName,
      request.modelId,
      request.model,
    );
    appendSelectedModelCandidates(candidates, request.selectedModels);
    appendModelConfigCandidates(candidates, request.modelConfig);
    appendModelConfigCandidates(candidates, request.composerModelConfig);
    if (!hasMeaningfulModelCandidate(candidates)) appendPlanExecutionModelConfigCandidates(candidates, request);
    return candidates;
  }

  function pushByokDebug(event, details) {
    try {
      var entry = {
        at: new Date().toISOString(),
        event: event,
        details: cloneJsonValue(details),
      };
      globalThis.__cursorByokDebug.push(entry);
      if (globalThis.__cursorByokDebug.length > 200) {
        globalThis.__cursorByokDebug.splice(0, globalThis.__cursorByokDebug.length - 200);
      }
      postJson("/byok/debug", entry);
    } catch {}
  }

  globalThis.__cursorByokMarkHookPoint = function markByokHookPoint(name, details) {
    pushByokDebug("hook-point", {
      name: typeof name === "string" ? name : "",
      details: cloneJsonValue(details),
    });
  };

  if (!globalThis.__cursorByokHookReadyPosted) {
    globalThis.__cursorByokHookReadyPosted = true;
    pushByokDebug("hook-ready", {
      byokUrl: byokUrl,
      routeCount: routes.length,
      hasFetch: typeof fetch === "function",
      hasEventSource: typeof EventSource === "function",
      hasWindow: typeof window !== "undefined",
      hasProcess: typeof process !== "undefined",
      locationHref: typeof globalThis.location !== "undefined" && typeof globalThis.location.href === "string" ? globalThis.location.href : "",
    });
  }

  function summarizeRunRequestForDebug(request) {
    var json = toJson(request) || request;
    var summary = {
      requestKeys: json && typeof json === "object" ? Object.keys(json).slice(0, 40) : [],
      messageCount: Array.isArray(json && json.messages) ? json.messages.length : 0,
      hasAction: !!(json && json.action),
      actionCase: actionCaseForDebug(json && json.action),
      hasSelectedModels: !!(json && Array.isArray(json.selectedModels) && json.selectedModels.length),
      hasModelConfig: !!(json && json.modelConfig && typeof json.modelConfig === "object"),
      hasComposerModelConfig: !!(json && json.composerModelConfig && typeof json.composerModelConfig === "object"),
      hasPlanExecutionModelConfig: !!(json && json.planExecutionModelConfig && typeof json.planExecutionModelConfig === "object"),
      isPlanExecution: !!(json && json.isPlanExecution),
      modelOverride: json && json.modelOverride,
      candidates: requestModelCandidates(json).filter(function (candidate) {
        return typeof candidate === "string" && candidate;
      }),
    };
    if (json && json.modelConfig && typeof json.modelConfig === "object") {
      summary.modelConfigKeys = Object.keys(json.modelConfig).slice(0, 20);
    }
    if (json && json.composerModelConfig && typeof json.composerModelConfig === "object") {
      summary.composerModelConfigKeys = Object.keys(json.composerModelConfig).slice(0, 20);
    }
    if (json && json.planExecutionModelConfig && typeof json.planExecutionModelConfig === "object") {
      summary.planExecutionModelConfigKeys = Object.keys(json.planExecutionModelConfig).slice(0, 20);
    }
    return summary;
  }

  var KNOWN_CONVERSATION_ACTION_CASES = [
    "userMessageAction",
    "resumeAction",
    "cancelAction",
    "summarizeAction",
    "shellCommandAction",
    "startPlanAction",
    "executePlanAction",
    "asyncAskQuestionCompletionAction",
    "cancelSubagentAction",
    "backgroundTaskCompletionAction",
    "backgroundShellAction",
    "backgroundSubagentAction",
  ];

  function normalizeActionCase(value) {
    if (typeof value !== "string" || !value) return "";
    return value.replace(/_([a-z])/g, function (_match, letter) {
      return letter.toUpperCase();
    });
  }

  function snakeCaseActionCase(value) {
    if (typeof value !== "string" || !value) return "";
    return value.replace(/[A-Z]/g, function (letter) {
      return "_" + letter.toLowerCase();
    });
  }

  function extractConversationAction(action) {
    if (!action || typeof action !== "object") return null;
    if (Array.isArray(action)) {
      for (var i = 0; i < action.length; i++) {
        var extracted = extractConversationAction(action[i]);
        if (extracted) return extracted;
      }
      return null;
    }
    if (typeof action.case === "string" && action.case) {
      return {
        case: normalizeActionCase(action.case),
        value: action.value || null,
      };
    }
    if (action.action && typeof action.action === "object") {
      var nested = extractConversationAction(action.action);
      if (nested) return nested;
    }
    var rawOneofCase = typeof action.oneofKind === "string" && action.oneofKind
      ? action.oneofKind
      : typeof action.$case === "string" && action.$case
        ? action.$case
        : "";
    var normalizedOneofCase = normalizeActionCase(rawOneofCase);
    if (rawOneofCase && Object.prototype.hasOwnProperty.call(action, rawOneofCase)) {
      return {
        case: normalizedOneofCase || rawOneofCase,
        value: action[rawOneofCase] || null,
      };
    }
    if (normalizedOneofCase && Object.prototype.hasOwnProperty.call(action, normalizedOneofCase)) {
      return {
        case: normalizedOneofCase,
        value: action[normalizedOneofCase] || null,
      };
    }
    var snakeOneofCase = snakeCaseActionCase(normalizedOneofCase);
    if (snakeOneofCase && Object.prototype.hasOwnProperty.call(action, snakeOneofCase)) {
      return {
        case: normalizedOneofCase,
        value: action[snakeOneofCase] || null,
      };
    }
    for (var j = 0; j < KNOWN_CONVERSATION_ACTION_CASES.length; j++) {
      var caseName = KNOWN_CONVERSATION_ACTION_CASES[j];
      if (Object.prototype.hasOwnProperty.call(action, caseName)) {
        return {
          case: caseName,
          value: action[caseName] || null,
        };
      }
      var snakeCaseName = snakeCaseActionCase(caseName);
      if (snakeCaseName && Object.prototype.hasOwnProperty.call(action, snakeCaseName)) {
        return {
          case: caseName,
          value: action[snakeCaseName] || null,
        };
      }
    }
    return null;
  }

  function actionCaseForDebug(action) {
    var extracted = extractConversationAction(action);
    return extracted ? extracted.case : "";
  }

  function actionValueForRequest(action) {
    var extracted = extractConversationAction(action);
    if (!extracted || !extracted.case) return null;
    return {
      case: extracted.case,
      value: cloneJsonValue(extracted.value || {}),
    };
  }

  function requestHasActionHint(request) {
    var json = toJson(request) || request;
    if (!json || typeof json !== "object") return false;
    if (json.isPlanExecution === true) return true;
    if (actionCaseForDebug(json.action)) return true;
    if (actionCaseForDebug(json.conversationAction)) return true;
    if (actionCaseForDebug(json.conversationActionOverride)) return true;
    return !!(json.action || json.actions || json.conversationAction || json.conversationActions || json.conversationActionOverride);
  }

  function hydrateRunRequestFromOptions(request, options) {
    if (!options || typeof options !== "object") return request;
    var requestJson = toJson(request) || request;
    var optionsJson = toJson(options) || options;
    var next = requestJson && typeof requestJson === "object" ? Object.assign({}, requestJson) : {};
    var changed = !requestJson || typeof requestJson !== "object";

    if (optionsJson.isPlanExecution === true && next.isPlanExecution !== true) {
      next.isPlanExecution = true;
      changed = true;
    }
    if (typeof optionsJson.modelOverride === "string" && optionsJson.modelOverride && next.modelOverride !== optionsJson.modelOverride) {
      next.modelOverride = optionsJson.modelOverride;
      changed = true;
    }
    if (!next.requestedModel && optionsJson.requestedModel && typeof optionsJson.requestedModel === "object") {
      next.requestedModel = cloneJsonValue(optionsJson.requestedModel);
      changed = true;
    }
    if ((!Array.isArray(next.selectedModels) || next.selectedModels.length === 0) && Array.isArray(optionsJson.selectedModels) && optionsJson.selectedModels.length) {
      next.selectedModels = cloneJsonValue(optionsJson.selectedModels);
      changed = true;
    }
    if ((!next.modelConfig || typeof next.modelConfig !== "object") && optionsJson.modelConfig && typeof optionsJson.modelConfig === "object") {
      next.modelConfig = cloneJsonValue(optionsJson.modelConfig);
      changed = true;
    }
    if ((!next.composerModelConfig || typeof next.composerModelConfig !== "object") && optionsJson.composerModelConfig && typeof optionsJson.composerModelConfig === "object") {
      next.composerModelConfig = cloneJsonValue(optionsJson.composerModelConfig);
      changed = true;
    }
    if ((!next.planExecutionModelConfig || typeof next.planExecutionModelConfig !== "object") && optionsJson.planExecutionModelConfig && typeof optionsJson.planExecutionModelConfig === "object") {
      next.planExecutionModelConfig = cloneJsonValue(optionsJson.planExecutionModelConfig);
      changed = true;
    }
    if (!next.action || !actionCaseForDebug(next.action)) {
      var overrideAction = actionValueForRequest(optionsJson.conversationActionOverride || optionsJson.conversationAction);
      if (overrideAction) {
        next.action = overrideAction;
        changed = true;
      }
    }
    return changed ? next : request;
  }

  function submitModelCandidates(selectedModel, modelDetails, submitOptions, composerData) {
    var candidates = [];
    if (typeof selectedModel === "string" && selectedModel) candidates.push(selectedModel);
    appendModelRecordCandidates(candidates, modelDetails);
    if (submitOptions && typeof submitOptions === "object") {
      if (typeof submitOptions.modelOverride === "string" && submitOptions.modelOverride) {
        candidates.push(submitOptions.modelOverride);
      }
      appendSelectedModelCandidates(candidates, submitOptions.selectedModels);
      appendModelConfigCandidates(candidates, submitOptions.planExecutionModelConfig);
      if (submitOptions.modelConfig && typeof submitOptions.modelConfig === "object") {
        appendModelConfigCandidates(candidates, submitOptions.modelConfig["plan-execution"]);
        appendModelConfigCandidates(candidates, submitOptions.modelConfig.planExecution);
      }
      if (submitOptions.isPlanExecution) {
        appendModelConfigCandidates(candidates, composerData && composerData.modelConfig);
        if (composerData && composerData.modelConfig && typeof composerData.modelConfig === "object") {
          appendModelConfigCandidates(candidates, composerData.modelConfig["plan-execution"]);
          appendModelConfigCandidates(candidates, composerData.modelConfig.planExecution);
        }
        appendModelConfigCandidates(candidates, composerData && composerData.planExecutionModelConfig);
      }
    }
    if (composerData && typeof composerData === "object") {
      appendModelConfigCandidates(candidates, composerData.modelConfig);
      appendModelConfigCandidates(candidates, composerData.composerModelConfig);
      appendModelConfigCandidates(candidates, composerData.planExecutionModelConfig);
      if (composerData.modelConfig && typeof composerData.modelConfig === "object") {
        appendModelConfigCandidates(candidates, composerData.modelConfig["plan-execution"]);
        appendModelConfigCandidates(candidates, composerData.modelConfig.planExecution);
      }
    }
    return candidates;
  }

  function runOptionsModelCandidates(options, selectedModel) {
    var candidates = [];
    if (options && typeof options === "object" && typeof options.modelOverride === "string" && options.modelOverride) {
      candidates.push(options.modelOverride);
    }
    appendModelRecordCandidates(candidates, options && options.requestedModel);
    appendModelRecordCandidates(candidates, options && options.modelDetails);
    appendModelRecordCandidates(candidates, selectedModel);
    if (options && typeof options === "object") {
      appendSelectedModelCandidates(candidates, options.selectedModels);
      appendModelConfigCandidates(candidates, options.modelConfig);
      appendModelConfigCandidates(candidates, options.composerModelConfig);
      appendModelConfigCandidates(candidates, options.planExecutionModelConfig);
      if (options.modelConfig && typeof options.modelConfig === "object") {
        appendModelConfigCandidates(candidates, options.modelConfig["plan-execution"]);
        appendModelConfigCandidates(candidates, options.modelConfig.planExecution);
      }
      if (options.isPlanExecution) {
        appendModelConfigCandidates(candidates, options.modelConfig);
      }
    }
    return candidates;
  }

  globalThis.__cursorByokHasSubmitModelCandidate = function hasSubmitModelCandidate(selectedModel, modelDetails, submitOptions, composerData) {
    return globalThis.__cursorByokHasModelCandidate(submitModelCandidates(selectedModel, modelDetails, submitOptions, composerData));
  };
  globalThis.__cursorByokHasRunOptionsModelCandidate = function hasRunOptionsModelCandidate(options, selectedModel) {
    return globalThis.__cursorByokHasModelCandidate(runOptionsModelCandidates(options, selectedModel));
  };

  function appendSelectedModelCandidates(candidates, selectedModels) {
    if (!Array.isArray(selectedModels)) return;
    for (var i = 0; i < selectedModels.length; i++) {
      var selected = selectedModels[i];
      if (!selected) continue;
      if (typeof selected === "string") {
        candidates.push(selected);
        continue;
      }
      candidates.push(
        selected.modelId,
        selected.modelName,
        selected.name,
        selected.apiModel,
        selected.displayModelId,
      );
    }
  }

  function normalizeByokBaseUrl(url) {
    if (typeof url !== "string" || !url) return "";
    return url.replace(/\/+$/, "");
  }

  function parseByokBaseUrl(url) {
    try {
      var parsed = new URL(url);
      return {
        host: parsed.hostname || "127.0.0.1",
        port: parsed.port ? Number(parsed.port) : 9960,
      };
    } catch {
      return { host: "127.0.0.1", port: 9960 };
    }
  }

  function readRememberedByokUrl() {
    try {
      var storage = globalThis && globalThis.localStorage;
      if (storage && typeof storage.getItem === "function") {
        return normalizeByokBaseUrl(storage.getItem("cursorByok.baseUrl") || "");
      }
    } catch {}
    return "";
  }

  function rememberByokUrl(url) {
    byokUrl = normalizeByokBaseUrl(url);
    try {
      var storage = globalThis && globalThis.localStorage;
      if (storage && typeof storage.setItem === "function" && byokUrl) {
        storage.setItem("cursorByok.baseUrl", byokUrl);
      }
    } catch {}
    return byokUrl;
  }

  function byokCandidateUrls() {
    var urls = [];
    var seen = new Set();
    function add(url) {
      var normalized = normalizeByokBaseUrl(url);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      urls.push(normalized);
    }
    add(readRememberedByokUrl());
    add(byokUrl);
    if (byokBaseHost && Number.isInteger(byokBasePort) && byokBasePort > 0) {
      for (var offset = 0; offset < byokPortSearchCount; offset++) {
        add("http://" + byokBaseHost + ":" + String(byokBasePort + offset));
      }
    }
    return urls;
  }

  async function probeByokUrl(url) {
    if (!url) return false;
    var fetchImpl = rawFetch || globalThis.fetch;
    if (typeof fetchImpl !== "function") return false;
    try {
      var response = await fetchImpl.call(globalThis, url + "/byok/health", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!response || !response.ok) return false;
      var json = await response.json();
      return !!(json && json.ok);
    } catch {
      return false;
    }
  }

  function abortErrorFromSignal(signal) {
    var reason = signal && signal.reason;
    if (reason instanceof Error) {
      if (reason.name !== "AbortError") {
        try {
          reason.name = "AbortError";
        } catch {}
      }
      return reason;
    }
    var message = typeof reason === "string" && reason ? reason : "aborted";
    var error = new Error(message);
    error.name = "AbortError";
    return error;
  }

  function isAbortError(error) {
    return !!error && (
      error.name === "AbortError" ||
      error.message === "aborted" ||
      error.message === "This operation was aborted"
    );
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(abortErrorFromSignal(signal));
        return;
      }
      var timer = setTimeout(function () {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
        reject(abortErrorFromSignal(signal));
      }
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function ensureByokUrl(forceScan) {
    if (!forceScan) return byokUrlRefreshPromise || Promise.resolve(byokUrl);
    if (byokUrlRefreshPromise) return byokUrlRefreshPromise;
    byokUrlRefreshPromise = (async function () {
      var candidates = byokCandidateUrls();
      for (var i = 0; i < candidates.length; i++) {
        if (await probeByokUrl(candidates[i])) return rememberByokUrl(candidates[i]);
      }
      return byokUrl;
    })();
    return byokUrlRefreshPromise.finally(function () {
      byokUrlRefreshPromise = null;
    });
  }

  function byokPathUrl(baseUrl, path) {
    return normalizeByokBaseUrl(baseUrl) + path;
  }

  async function fetchByokPath(path, init, options) {
    var retryOnHttpError = !options || options.retryOnHttpError !== false;
    var waitForReadyMs = options && Number.isInteger(options.waitForReadyMs) && options.waitForReadyMs > 0
      ? options.waitForReadyMs
      : 0;
    var retryDelayMs = options && Number.isInteger(options.retryDelayMs) && options.retryDelayMs >= 0
      ? options.retryDelayMs
      : byokRunReadyRetryDelayMs;
    var deadline = waitForReadyMs > 0 ? Date.now() + waitForReadyMs : 0;
    init = init || {};
    var signal = init.signal;
    if (signal && signal.aborted) throw abortErrorFromSignal(signal);
    init.headers = injectWindowId(init.headers || {});
    for (;;) {
      var baseUrl = await ensureByokUrl(false);
      try {
        var response = await fetch(byokPathUrl(baseUrl, path), init);
        if (retryOnHttpError && response && !response.ok) {
          var refreshedUrl = await ensureByokUrl(true);
          if (refreshedUrl && refreshedUrl !== baseUrl) {
            response = await fetch(byokPathUrl(refreshedUrl, path), init);
          }
        }
        return response;
      } catch (error) {
        var nextUrl = await ensureByokUrl(true);
        if (nextUrl && nextUrl !== baseUrl) return fetch(byokPathUrl(nextUrl, path), init);
        if (deadline && Date.now() < deadline) {
          await sleep(retryDelayMs, signal);
          continue;
        }
        throw error;
      }
    }
  }

  async function fetchRedirectedRoute(originalFetch, originalArgs, urlArg, init, redirectedPath) {
    var currentUrl = await ensureByokUrl(false);
    async function performFetch(baseUrl) {
      var redirected = baseUrl + redirectedPath;
      if (urlArg instanceof Request) {
        var requestInit = Object.assign({}, init);
        requestInit.headers = injectWindowId(requestInit.headers || urlArg.headers);
        return originalFetch.call(globalThis, new Request(redirected, urlArg), requestInit);
      }
      var nextInit = Object.assign({}, init);
      nextInit.headers = injectWindowId(nextInit.headers);
      var nextArgs = [redirected, nextInit];
      for (var i = 2; i < originalArgs.length; i++) nextArgs.push(originalArgs[i]);
      return originalFetch.apply(globalThis, nextArgs);
    }
    try {
      var response = await performFetch(currentUrl);
      if (response && !response.ok) {
        var refreshedUrl = await ensureByokUrl(true);
        if (refreshedUrl && refreshedUrl !== currentUrl) return performFetch(refreshedUrl);
      }
      return response;
    } catch (error) {
      var nextUrl = await ensureByokUrl(true);
      if (nextUrl && nextUrl !== currentUrl) return performFetch(nextUrl);
      throw error;
    }
  }

  async function shouldHandleByokRun(requestId, request) {
    request = attachComposerMode(requestId, request);
    var candidates = requestModelCandidates(request);
    var hasByokCandidate = globalThis.__cursorByokHasModelCandidate(candidates);
    pushByokDebug("should-handle:start", {
      requestId: requestId,
      hasByokCandidate: hasByokCandidate,
      summary: summarizeRunRequestForDebug(request),
    });
    try {
      var response = await fetchByokPath("/byok/should-handle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, request }),
      }, {
        waitForReadyMs: hasByokCandidate ? byokRunReadyWaitMs : 0,
      });
      if (!response.ok) return false;
      var json = await response.json();
      pushByokDebug("should-handle:response", {
        requestId: requestId,
        hasByokCandidate: hasByokCandidate,
        handle: !!json.handle,
        reason: json.reason,
        modelId: json.modelId,
        forcedLocal: !!(hasByokCandidate && !json.handle && json.reason === "provider-input-not-found" && requestHasActionHint(request)),
        candidates: candidates.filter(function (candidate) {
          return typeof candidate === "string" && candidate;
        }),
      });
      if (hasByokCandidate && !json.handle && json.reason === "provider-input-not-found" && requestHasActionHint(request)) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[Cursor BYOK] forcing local BYOK run after provider-input-not-found", {
            requestId: requestId,
            reason: json.reason,
            modelId: json.modelId,
            candidates: requestModelCandidates(request).filter(function (candidate) {
              return typeof candidate === "string" && candidate;
            }),
          });
        }
        return true;
      }
      if (!json.handle && typeof console !== "undefined" && console.warn) {
        console.warn("[Cursor BYOK] local run bypassed", {
          requestId: requestId,
          reason: json.reason,
          modelId: json.modelId,
          candidates: requestModelCandidates(request).filter(function (candidate) {
            return typeof candidate === "string" && candidate;
          }),
        });
      }
      return !!json.handle;
    } catch (error) {
      pushByokDebug("should-handle:error", {
        requestId: requestId,
        hasByokCandidate: hasByokCandidate,
        error: error && error.message ? error.message : String(error),
        candidates: candidates.filter(function (candidate) {
          return typeof candidate === "string" && candidate;
        }),
      });
      if (hasByokCandidate) return true;
    }
    return false;
  }

  async function postJson(path, value) {
    var body = "";
    try {
      body = JSON.stringify(value);
      var response = await fetchByokPath(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok && typeof console !== "undefined" && console.warn) {
        console.warn("[Cursor BYOK] POST " + path + " failed: HTTP " + response.status + " bodyBytes=" + body.length);
      }
      try {
        return await response.json();
      } catch {
        return {};
      }
    } catch (error) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[Cursor BYOK] POST " + path + " failed: " + (error && error.message ? error.message : String(error)) + " bodyBytes=" + body.length);
      }
      return {};
    }
  }

  function cloneJsonValue(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function normalizeByokModels(models) {
    return Array.isArray(models) ? cloneJsonValue(models) : [];
  }

  function mergeInstallTimeModelIds(ids) {
    if (!Array.isArray(config.byokModelIds)) return;
    for (var i = 0; i < config.byokModelIds.length; i++) addModelId(ids, config.byokModelIds[i]);
  }

  function setByokModelsCache(models, loaded) {
    byokModelsCache = normalizeByokModels(models);
    if (loaded === true) byokModelsLoaded = true;
    syncByokModelIds(byokModelsCache);
    mergeInstallTimeModelIds(globalThis.__cursorByokModelIds);
    return byokModelsCache;
  }

  async function fetchByokModels() {
    try {
      var response = await fetchByokPath("/byok/models", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) return null;
      var json = await response.json();
      return Array.isArray(json.models) ? json.models : [];
    } catch {
      return null;
    }
  }

  async function refreshByokModelsFromServer() {
    if (byokModelsRefreshPromise) return byokModelsRefreshPromise;
    byokModelsRefreshPromise = (async function () {
      var models = await fetchByokModels();
      if (Array.isArray(models) && models.length) setByokModelsCache(models, true);
      else if (!byokModelsCache.length && Array.isArray(models)) setByokModelsCache(models, true);
      return byokModelsCache;
    })();
    try {
      return await byokModelsRefreshPromise;
    } finally {
      byokModelsRefreshPromise = null;
    }
  }

  async function ensureByokModelsLoaded() {
    if (byokModelsLoaded) return byokModelsCache;
    return refreshByokModelsFromServer();
  }

  function addModelId(ids, value) {
    if (typeof value === "string" && value && value !== "default") ids.add(value);
  }

  function syncByokModelIds(models) {
    var ids = new Set();
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      if (typeof model === "string") {
        addModelId(ids, model);
        continue;
      }
      if (!model) continue;
      addModelId(ids, model.id);
      addModelId(ids, model.name);
      addModelId(ids, model.displayName);
      addModelId(ids, model.clientDisplayName);
      addModelId(ids, model.inputboxShortModelName);
      addModelId(ids, model.serverModelName);
      addModelId(ids, model.apiModel);
      addModelId(ids, model.legacyId);
      if (Array.isArray(model.legacySlugs)) {
        for (var j = 0; j < model.legacySlugs.length; j++) addModelId(ids, model.legacySlugs[j]);
      }
      if (Array.isArray(model.idAliases)) {
        for (var k = 0; k < model.idAliases.length; k++) addModelId(ids, model.idAliases[k]);
      }
    }
    globalThis.__cursorByokModelIds = ids;
  }

  function modelCollisionIds(model) {
    var ids = new Set();
    if (!model) return ids;
    if (typeof model === "string") {
      addModelId(ids, model);
      return ids;
    }
    addModelId(ids, model.id);
    addModelId(ids, model.name);
    addModelId(ids, model.displayName);
    addModelId(ids, model.clientDisplayName);
    addModelId(ids, model.inputboxShortModelName);
    addModelId(ids, model.serverModelName);
    addModelId(ids, model.apiModel);
    addModelId(ids, model.legacyId);
    if (Array.isArray(model.legacySlugs)) {
      for (var i = 0; i < model.legacySlugs.length; i++) addModelId(ids, model.legacySlugs[i]);
    }
    if (Array.isArray(model.idAliases)) {
      for (var j = 0; j < model.idAliases.length; j++) addModelId(ids, model.idAliases[j]);
    }
    return ids;
  }

  function positiveInteger(value) {
    var number = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  function shouldUseMaxModeContextLimit(request) {
    if (!request || typeof request !== "object") return false;
    return request.maxMode === true ||
      request.useMaxMode === true ||
      request.modelDetails && request.modelDetails.maxMode === true ||
      request.modelDetails && request.modelDetails.useMaxMode === true ||
      request.requestedModel && request.requestedModel.maxMode === true ||
      request.requestedModel && request.requestedModel.useMaxMode === true;
  }

  function byokModelForRequestFromCache(request) {
    var candidates = requestModelCandidates(request);
    if (!candidates.length || !byokModelsCache.length) return null;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (typeof candidate !== "string" || !candidate) continue;
      for (var j = 0; j < byokModelsCache.length; j++) {
        var modelIds = modelCollisionIds(byokModelsCache[j]);
        if (modelIds.has(candidate)) return byokModelsCache[j];
      }
    }
    return null;
  }

  async function contextTokenLimitForRequest(request) {
    var model = byokModelForRequestFromCache(request);
    if (!model) {
      await refreshByokModelsFromServer();
      model = byokModelForRequestFromCache(request);
    }
    if (!model || typeof model === "string") return 0;
    var contextLimit = positiveInteger(model.contextTokenLimit);
    if (shouldUseMaxModeContextLimit(request)) {
      var maxModeLimit = positiveInteger(model.contextTokenLimitForMaxMode);
      if (maxModeLimit) return maxModeLimit;
    }
    return contextLimit;
  }

  function sanitizeOfficialModelValue(value, parentKey, key, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 12) return undefined;
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      var array = [];
      for (var i = 0; i < value.length; i++) {
        var cleanItem = sanitizeOfficialModelValue(value[i], key, "", depth + 1);
        if (cleanItem !== undefined) array.push(cleanItem);
      }
      return array;
    }
    if (typeof value === "object") {
      var out = {};
      var keys = Object.keys(value);
      for (var j = 0; j < keys.length; j++) {
        var childKey = keys[j];
        var clean = sanitizeOfficialModelValue(value[childKey], key, childKey, depth + 1);
        if (clean !== undefined) out[childKey] = clean;
      }
      return out;
    }
    if (looksLikeEnumToken(value)) {
      var lowerKey = String(key || "").toLowerCase();
      var lowerParent = String(parentKey || "").toLowerCase();
      if (
        lowerKey === "degradation_status" ||
        lowerKey === "degradationstatus" ||
        lowerKey === "modelvendorid" ||
        lowerKey === "vendorid" ||
        lowerKey === "status" ||
        lowerKey.indexOf("status") >= 0 ||
        (lowerKey.indexOf("vendor") >= 0 && lowerKey.indexOf("id") >= 0) ||
        (lowerParent === "vendor" && lowerKey === "id")
      ) {
        return undefined;
      }
    }
    return value;
  }

  function looksLikeEnumToken(value) {
    return typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value);
  }

  setByokModelsCache(
    Array.isArray(config.byokModels) ? config.byokModels : [],
    false,
  );
  if (!byokModelsCache.length) syncByokModelIds(Array.isArray(config.byokModelIds) ? config.byokModelIds : []);

  async function peekAsyncIterable(value) {
    if (!value || typeof value[Symbol.asyncIterator] !== "function") {
      return { first: value, input: value };
    }
    var iterator = value[Symbol.asyncIterator]();
    var firstResult = await iterator.next();
    if (firstResult.done) return { first: undefined, input: value };
    return {
      first: firstResult.value,
      input: {
        async *[Symbol.asyncIterator]() {
          yield firstResult.value;
          for (;;) {
            var next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        },
      },
    };
  }

  async function peekUntilRunRequest(value, maxFrames) {
    if (!value || typeof value[Symbol.asyncIterator] !== "function") {
      return { first: value, runRequestFrame: value, input: value };
    }
    var iterator = value[Symbol.asyncIterator]();
    var frames = [];
    var runRequestFrame;
    var limit = Number.isInteger(maxFrames) && maxFrames > 0 ? maxFrames : 8;
    for (var i = 0; i < limit; i++) {
      var next = await iterator.next();
      if (next.done) break;
      frames.push(next.value);
      if (extractAgentClientMessage(next.value)?.case === "runRequest") {
        runRequestFrame = next.value;
        break;
      }
    }
    if (!frames.length) return { first: undefined, runRequestFrame: undefined, input: value };
    return {
      first: frames[0],
      runRequestFrame: runRequestFrame || frames[0],
      input: {
        async *[Symbol.asyncIterator]() {
          for (var j = 0; j < frames.length; j++) yield frames[j];
          for (;;) {
            var next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        },
      },
    };
  }

  function extractAgentRunRequest(value) {
    var json = toJson(value) || value;
    if (!json || typeof json !== "object") return json;
    if (json.message && json.message.case === "runRequest") {
      return toJson(json.message.value) || json.message.value || {};
    }
    if (json.runRequest) return toJson(json.runRequest) || json.runRequest;
    if (json.request) return toJson(json.request) || json.request;
    return json;
  }

  function extractAgentClientMessage(value) {
    var message = extractAgentClientMessageObject(value);
    if (message) return message;
    var json = toJson(value) || value;
    return extractAgentClientMessageObject(json);
  }

  function extractAgentClientMessageObject(json) {
    if (!json || typeof json !== "object") return null;
    if (json.message && json.message.case) {
      if (json.message.case === "interactionResponse") {
        return {
          case: "interactionResponse",
          value: normalizeInteractionResponseValue(json.message.value),
        };
      }
      return json.message;
    }
    if (json.execClientMessage) {
      return {
        case: "execClientMessage",
        value: json.execClientMessage,
      };
    }
    if (json.execClientControlMessage) {
      return {
        case: "execClientControlMessage",
        value: json.execClientControlMessage,
      };
    }
    if (json.interactionResponse) {
      return {
        case: "interactionResponse",
        value: normalizeInteractionResponseValue(json.interactionResponse),
      };
    }
    return json.case ? json : null;
  }

  function normalizeInteractionResponseValue(value) {
    if (!value || typeof value !== "object") return value;
    var out = {};
    var json = toJson(value);
    if (json && typeof json === "object") {
      var jsonKeys = Object.keys(json);
      for (var i = 0; i < jsonKeys.length; i++) out[jsonKeys[i]] = json[jsonKeys[i]];
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      if (out[keys[j]] === undefined) out[keys[j]] = value[keys[j]];
    }
    if (out.result && out.result.case) {
      return {
        id: out.id,
        result: {
          case: out.result.case,
          value: normalizeInteractionResponsePayload(out.result.value),
        },
      };
    }
    var cases = [
      "webSearchRequestResponse",
      "askQuestionInteractionResponse",
      "switchModeRequestResponse",
      "createPlanRequestResponse",
      "webFetchRequestResponse",
      "mcpAuthRequestResponse",
      "generateImageRequestResponse",
    ];
    for (var k = 0; k < cases.length; k++) {
      var caseName = cases[k];
      if (out[caseName] !== undefined) {
        return {
          id: out.id,
          result: {
            case: caseName,
            value: normalizeInteractionResponsePayload(out[caseName]),
          },
        };
      }
    }
    return out;
  }

  function normalizeInteractionResponsePayload(value) {
    if (!value || typeof value !== "object") return value;
    var json = toJson(value);
    if (json && json !== value && typeof json === "object") {
      return normalizeInteractionResponsePayload(json);
    }
    if (value.result && value.result.case) return value;
    if (value.result && typeof value.result === "object") {
      var resultJson = toJson(value.result) || value.result;
      var nested = normalizeInteractionResultUnion(resultJson);
      if (nested) return { result: nested };
    }
    var result = normalizeInteractionResultUnion(value);
    if (result) return { result: result };
    return value;
  }

  function normalizeInteractionResultUnion(value) {
    if (!value || typeof value !== "object") return null;
    var json = toJson(value);
    if (json && json !== value && typeof json === "object") {
      return normalizeInteractionResultUnion(json);
    }
    if (value.case) return value;
    var cases = ["success", "approved", "error", "rejected", "async"];
    for (var i = 0; i < cases.length; i++) {
      var caseName = cases[i];
      if (value[caseName] !== undefined) {
        return {
          case: caseName,
          value: value[caseName] || {},
        };
      }
    }
    return null;
  }

  function normalizeExecResultValue(value) {
    if (!value || typeof value !== "object") return value;
    var out = {};
    var json = toJson(value);
    if (json && typeof json === "object") {
      var jsonKeys = Object.keys(json);
      for (var i = 0; i < jsonKeys.length; i++) out[jsonKeys[i]] = json[jsonKeys[i]];
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      if (out[keys[j]] === undefined) out[keys[j]] = value[keys[j]];
    }
    var message = normalizeExecResultMessage(value) || normalizeExecResultMessage(out);
    if (message) out.message = message;
    return out;
  }

  function normalizeExecResultMessage(value) {
    if (!value || typeof value !== "object") return null;
    if (value.message && value.message.case) {
      var normalizedCase = normalizeExecResultMessageCase(value.message.case, value.message.value);
      return {
        case: normalizedCase,
        value: normalizeResultEnvelope(normalizedCase, value.message.value),
      };
    }
    var cases = [
      "shellResult",
      "shellStream",
      "writeResult",
      "deleteResult",
      "grepResult",
      "readResult",
      "redactedReadResult",
      "lsResult",
      "diagnosticsResult",
      "requestContextResult",
      "mcpResult",
      "listMcpResourcesExecResult",
      "readMcpResourceExecResult",
      "mcpAuthResult",
      "fetchResult",
      "recordScreenResult",
      "computerUseResult",
      "writeShellStdinResult",
      "subagentAwaitResult",
      "todoWriteResult",
    ];
    for (var i = 0; i < cases.length; i++) {
      var caseName = cases[i];
      if (value[caseName] !== undefined) {
        var messageCase = normalizeExecResultMessageCase(caseName, value[caseName]);
        return {
          case: messageCase,
          value: normalizeResultEnvelope(messageCase, value[caseName]),
        };
      }
    }
    return null;
  }

  function normalizeExecResultMessageCase(caseName, value) {
    if (caseName === "redactedReadResult") return "readResult";
    if (caseName === "shellStream" && isResultEnvelope(value)) return "shellResult";
    return caseName;
  }

  function isResultEnvelope(value) {
    if (!value || typeof value !== "object") return false;
    return value.result !== undefined ||
      value.success !== undefined ||
      value.error !== undefined ||
      value.rejected !== undefined ||
      value.permissionDenied !== undefined ||
      value.failure !== undefined ||
      value.spawnError !== undefined;
  }

  function normalizeResultEnvelope(messageCase, value) {
    if (!value || typeof value !== "object") return value;
    if (value.result && value.result.case) return value;
    if (messageCase === "mcpResult") {
      var mcpError = normalizeMcpErrorResult(value);
      if (mcpError) return mcpError;
    }
    var resultCases = [
      "success",
      "error",
      "rejected",
      "fileNotFound",
      "permissionDenied",
      "invalidFile",
      "failure",
      "spawnError",
      "writePermissionDenied",
    ];
    for (var i = 0; i < resultCases.length; i++) {
      var caseName = resultCases[i];
      if (value[caseName] !== undefined) {
        return {
          result: {
            case: caseName,
            value: normalizeResultValue(messageCase, caseName, value[caseName]),
          },
        };
      }
    }
    var implicitSuccess = normalizeImplicitSuccessResult(messageCase, value);
    if (implicitSuccess) return implicitSuccess;
    return value;
  }

  function normalizeImplicitSuccessResult(messageCase, value) {
    if (!value || typeof value !== "object") return null;
    if (messageCase === "mcpResult") {
      if (!Array.isArray(value.content) && value.structuredContent === undefined) return null;
      return {
        result: {
          case: "success",
          value: normalizeResultValue(messageCase, "success", value),
        },
      };
    }
    if (messageCase === "listMcpResourcesExecResult") {
      if (!Array.isArray(value.resources)) return null;
      return {
        result: {
          case: "success",
          value: value,
        },
      };
    }
    if (messageCase === "readMcpResourceExecResult") {
      if (value.uri === undefined && value.content === undefined) return null;
      return {
        result: {
          case: "success",
          value: normalizeReadMcpResourceResultValue(value),
        },
      };
    }
    return null;
  }

  function normalizeMcpErrorResult(value) {
    if (!value || typeof value !== "object") return null;
    var errorCases = [
      "toolNotFound",
      "serverNotFound",
      "invalidArgs",
      "permissionDenied",
      "rejected",
      "failure",
    ];
    for (var i = 0; i < errorCases.length; i++) {
      var caseName = errorCases[i];
      if (value[caseName] !== undefined) {
        return {
          result: {
            case: "error",
            value: { error: formatMcpError(caseName, value[caseName]) },
          },
        };
      }
    }
    return null;
  }

  function formatMcpError(caseName, value) {
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object") {
      if (typeof value.error === "string" && value.error) return value.error;
      if (typeof value.message === "string" && value.message) return value.message;
      if (caseName === "toolNotFound" && typeof value.name === "string" && value.name) {
        return "MCP tool not found: " + value.name;
      }
      try {
        return "MCP " + caseName + ": " + JSON.stringify(value);
      } catch {}
    }
    return "MCP " + caseName;
  }

  function normalizeResultValue(messageCase, resultCase, value) {
    if (messageCase === "shellResult" && value && typeof value === "object") {
      return normalizeShellResultValue(resultCase, value);
    }
    if (messageCase === "mcpResult" && value && typeof value === "object") {
      return normalizeMcpResultValue(resultCase, value);
    }
    if (messageCase !== "readResult" || resultCase !== "success" || !value || typeof value !== "object") return value;
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key !== "content" && key !== "data") out[key] = value[key];
    }
    if (value.output !== undefined) return out;
    if (value.data !== undefined) out.output = { case: "data", value: value.data };
    else if (value.content !== undefined) out.output = { case: "content", value: String(value.content) };
    return out;
  }

  function normalizeMcpResultValue(resultCase, value) {
    if (resultCase !== "success") return value;
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = value[keys[i]];
    if (Array.isArray(value.content)) {
      out.content = value.content.map(normalizeMcpContentBlock);
    }
    return out;
  }

  function normalizeMcpContentBlock(block) {
    if (!block || typeof block !== "object") return block;
    if (block.content && block.content.case) return block;
    if (block.case) return { content: block };
    switch (block.type) {
      case "text":
        return { content: { case: "text", value: { text: stringArg(block.text) } } };
      case "image":
        return {
          content: {
            case: "image",
            value: {
              mimeType: stringArg(block.mimeType),
              data: block.data,
              uri: block.uri,
            },
          },
        };
      case "resource":
        return { content: { case: "resource", value: block.resource || {} } };
      default:
        return block;
    }
  }

  function normalizeReadMcpResourceResultValue(value) {
    if (!value || typeof value !== "object") return value;
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = value[keys[i]];
    if (value.content && typeof value.content === "object" && !value.content.case) {
      out.content = normalizeMcpResourceContent(value.content);
    }
    return out;
  }

  function normalizeMcpResourceContent(content) {
    switch (content.type) {
      case "text":
        return { case: "text", value: stringArg(content.text) };
      case "blob":
        return { case: "blob", value: content.blob !== undefined ? content.blob : content.data || "" };
      default:
        return content;
    }
  }

  function normalizeShellResultValue(resultCase, value) {
    if (resultCase !== "success" && resultCase !== "failure") return value;
    var output = value;
    if (typeof value.tool_output === "string") {
      try {
        output = JSON.parse(value.tool_output);
      } catch {
        output = { output: value.tool_output };
      }
    }
    if (!output || typeof output !== "object") output = {};
    var input = value.tool_input && typeof value.tool_input === "object" ? value.tool_input : {};
    var stdout = typeof output.stdout === "string"
      ? output.stdout
      : typeof output.output === "string"
        ? output.output
        : "";
    var stderr = typeof output.stderr === "string" ? output.stderr : "";
    var exitCode = normalizeInteger(output.exitCode);
    if (exitCode === undefined) exitCode = normalizeInteger(output.exit_code);
    return {
      command: stringArg(output.command, stringArg(input.command)),
      workingDirectory: stringArg(output.workingDirectory, stringArg(output.cwd, stringArg(input.workingDirectory, stringArg(input.cwd)))),
      output: stringArg(output.output, stdout || stderr),
      stdout,
      stderr,
      exitCode: exitCode !== undefined ? exitCode : 0,
      ...(stringArg(output.shellId, stringArg(output.shell_id)) ? { shellId: stringArg(output.shellId, stringArg(output.shell_id)) } : {}),
      ...(stringArg(output.taskId, stringArg(output.task_id)) ? { taskId: stringArg(output.taskId, stringArg(output.task_id)) } : {}),
      ...(Number.isFinite(output.msToWait) ? { msToWait: output.msToWait } : {}),
      ...(Number.isFinite(output.pid) ? { pid: output.pid } : {}),
      ...(typeof output.backgroundReason === "string" ? { backgroundReason: output.backgroundReason } : {}),
      ...(output.localExecutionTimeMs !== undefined ? { localExecutionTimeMs: output.localExecutionTimeMs } : {}),
      ...(Number.isFinite(output.executionTime) ? { executionTime: output.executionTime } : {}),
      ...(typeof output.signal === "string" && output.signal ? { signal: output.signal } : {}),
      ...(typeof output.interleavedOutput === "string" ? { interleavedOutput: output.interleavedOutput } : {}),
    };
  }

  function shellStreamEvent(result) {
    if (!result || result.message && result.message.case !== "shellStream") return "";
    var value = result.message ? result.message.value : result;
    if (!value || typeof value !== "object") return "";
    var event = value.event;
    if (event && event.case) return { case: event.case, value: event.value };
    var cases = ["start", "stdout", "stderr", "exit", "rejected", "permissionDenied", "backgrounded"];
    for (var i = 0; i < cases.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, cases[i])) return { case: cases[i], value: value[cases[i]] };
    }
    return null;
  }

  function shellStreamData(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return stringArg(value.data, stringArg(value.content, stringArg(value.output, stringArg(value.text, stringArg(value.chunk)))));
  }

  var MAX_HOOK_SHELL_STREAM_BUFFER_CHARS = 1024 * 1024;

  function shellOutputBuffer() {
    return { chunks: [], length: 0, omittedChars: 0 };
  }

  function appendShellOutput(buffer, data) {
    if (!data) return;
    if (data.length >= MAX_HOOK_SHELL_STREAM_BUFFER_CHARS) {
      buffer.chunks = [data.slice(data.length - MAX_HOOK_SHELL_STREAM_BUFFER_CHARS)];
      buffer.omittedChars += buffer.length + data.length - MAX_HOOK_SHELL_STREAM_BUFFER_CHARS;
      buffer.length = MAX_HOOK_SHELL_STREAM_BUFFER_CHARS;
      return;
    }
    buffer.chunks.push(data);
    buffer.length += data.length;
    while (buffer.length > MAX_HOOK_SHELL_STREAM_BUFFER_CHARS && buffer.chunks.length) {
      var overflow = buffer.length - MAX_HOOK_SHELL_STREAM_BUFFER_CHARS;
      var first = buffer.chunks[0];
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
  }

  function shellOutputText(buffer, streamLabel) {
    var text = buffer.chunks.join("");
    if (!buffer.omittedChars) return text;
    return "[BYOK truncated " + buffer.omittedChars + " characters from the beginning of shell " + streamLabel + "]\n" + text;
  }

  function cleanUndefined(value) {
    var out = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) out[key] = value[key];
    }
    return out;
  }

  function shellStreamState(state, toolCallId, result) {
    var streams = state.shellStreamsByToolCallId || (state.shellStreamsByToolCallId = {});
    var stream = streams[toolCallId];
    if (!stream) {
      var shellArgsByToolCallId = state.shellArgsByToolCallId || {};
      var args = shellArgsByToolCallId[toolCallId] || {};
      stream = {
        id: result.id,
        execId: result.execId || "",
        command: stringArg(args.command),
        workingDirectory: stringArg(args.working_directory ?? args.workingDirectory ?? args.cwd),
        stdout: shellOutputBuffer(),
        stderr: shellOutputBuffer(),
        interleavedOutput: shellOutputBuffer(),
      };
      streams[toolCallId] = stream;
    }
    if (result.id !== undefined) stream.id = result.id;
    if (result.execId) stream.execId = result.execId;
    return stream;
  }

  function applyShellStreamStart(stream, value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.command === "string") stream.command = value.command;
    if (typeof value.cwd === "string") stream.workingDirectory = value.cwd;
    if (typeof value.workingDirectory === "string") stream.workingDirectory = value.workingDirectory;
  }

  function shellResultMessage(toolCallId, stream, result, resultCase, value) {
    return {
      id: result.id !== undefined ? result.id : stream.id,
      execId: result.execId || stream.execId || toolCallId,
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
    };
  }

  function shellExitCompletion(toolCallId, stream, result, exit) {
    var code = normalizeInteger(exit && exit.code);
    if (code === undefined) code = 0;
    var value = {
      command: stringArg(exit && exit.command, stream.command),
      workingDirectory: stringArg(exit && (exit.cwd || exit.workingDirectory), stream.workingDirectory),
      exitCode: code,
      signal: "",
      stdout: shellOutputText(stream.stdout, "stdout output"),
      stderr: shellOutputText(stream.stderr, "stderr output"),
      executionTime: 0,
    };
    var interleavedOutput = shellOutputText(stream.interleavedOutput, "interleaved output");
    if (interleavedOutput) value.interleavedOutput = interleavedOutput;
    if (exit && exit.localExecutionTimeMs !== undefined) value.localExecutionTimeMs = exit.localExecutionTimeMs;
    return shellResultMessage(toolCallId, stream, result, code === 0 ? "success" : "failure", value);
  }

  function shellBackgroundedCompletion(toolCallId, stream, result, backgrounded) {
    backgrounded = backgrounded && typeof backgrounded === "object" ? backgrounded : {};
    var value = {
      command: stringArg(backgrounded.command, stream.command),
      workingDirectory: stringArg(backgrounded.workingDirectory, stream.workingDirectory),
      exitCode: 0,
      signal: "",
      stdout: shellOutputText(stream.stdout, "stdout output"),
      stderr: shellOutputText(stream.stderr, "stderr output"),
      executionTime: 0,
      shellId: backgrounded.shellId,
      interleavedOutput: shellOutputText(stream.interleavedOutput, "interleaved output"),
      pid: backgrounded.pid,
      msToWait: backgrounded.msToWait,
      backgroundReason: backgrounded.backgroundReason,
    };
    return shellResultMessage(toolCallId, stream, result, "success", cleanUndefined(value));
  }

  function resolveShellStreamCompletion(state, toolCallId, result) {
    var message = result && result.message;
    if (!message || message.case !== "shellStream") return result;
    var event = shellStreamEvent(result);
    if (!event || !event.case) return null;
    var stream = shellStreamState(state, toolCallId, result);
    if (event.case === "stdout") {
      var stdout = shellStreamData(event.value);
      if (stdout) {
        appendShellOutput(stream.stdout, stdout);
        appendShellOutput(stream.interleavedOutput, stdout);
      }
      return null;
    }
    if (event.case === "stderr") {
      var stderr = shellStreamData(event.value);
      if (stderr) {
        appendShellOutput(stream.stderr, stderr);
        appendShellOutput(stream.interleavedOutput, stderr);
      }
      return null;
    }
    if (event.case === "start") {
      applyShellStreamStart(stream, event.value);
      return null;
    }
    delete state.shellStreamsByToolCallId[toolCallId];
    if (state.shellArgsByToolCallId) delete state.shellArgsByToolCallId[toolCallId];
    if (event.case === "exit") return shellExitCompletion(toolCallId, stream, result, event.value || {});
    if (event.case === "backgrounded") return shellBackgroundedCompletion(toolCallId, stream, result, event.value || {});
    if (event.case === "rejected" || event.case === "permissionDenied") {
      return shellResultMessage(toolCallId, stream, result, event.case, event.value || {});
    }
    return null;
  }

  function findStringToolCallId(value, seen) {
    if (!value || typeof value !== "object") return "";
    if (!seen) seen = new Set();
    if (seen.has(value)) return "";
    seen.add(value);
    var keys = ["toolCallId", "tool_call_id", "callId", "call_id", "execId"];
    for (var i = 0; i < keys.length; i++) {
      var direct = value[keys[i]];
      if (typeof direct === "string" && direct) return direct;
    }
    var values = Object.values(value);
    for (var j = 0; j < values.length; j++) {
      var nested = findStringToolCallId(values[j], seen);
      if (nested) return nested;
    }
    return "";
  }

  function execToolCallId(execMessage, state) {
    var value = execMessage && execMessage.value;
    var numericId = value && value.id !== undefined ? String(value.id) : "";
    if (numericId && state.execIdToToolCallId[numericId]) return state.execIdToToolCallId[numericId];
    var execId = value && value.execId !== undefined ? String(value.execId) : "";
    if (execId && state.execIdToToolCallId[execId]) return state.execIdToToolCallId[execId];
    var direct = findStringToolCallId(value);
    if (direct) return direct;
    return execId || numericId;
  }

  function drainRunInput(requestId, input, state) {
    if (!input || typeof input[Symbol.asyncIterator] !== "function") return;
    (async function () {
      var skippedInitialRunRequest = false;
      for await (var frame of input) {
        var message = extractAgentClientMessage(frame);
        var skipInitialRunRequest = false;
        if (!skippedInitialRunRequest && message && message.case === "runRequest") {
          skipInitialRunRequest = true;
          skippedInitialRunRequest = true;
        }
        if (!message) continue;
        if (message.case === "execClientMessage") {
          var toolCallId = execToolCallId(message, state);
          if (!toolCallId) continue;
          var normalizedExecResult = normalizeExecResultValue(message.value);
          var completion = resolveShellStreamCompletion(state, toolCallId, normalizedExecResult);
          if (completion) resolveNativeToolCompletion(state, toolCallId, completion);
          postJson("/byok/local-tool-result", {
            requestId,
            toolCallId,
            result: normalizedExecResult,
          });
        } else if (!skipInitialRunRequest) {
          postJson("/byok/local-client-message", {
            requestId,
            message,
          });
        }
      }
    })().catch(function () {});
  }

  async function mergeAvailableModelsResult(result, responseType) {
    var byokModels = await ensureByokModelsLoaded();
    if (!byokModels.length) return result;
    var messageJson = toJson(result && result.message) || {};
    var officialModels = Array.isArray(messageJson.models) ? messageJson.models : [];
    var byokNames = new Set();
    for (var i = 0; i < byokModels.length; i++) {
      var byokIds = modelCollisionIds(byokModels[i]);
      byokIds.forEach(function (id) {
        byokNames.add(id);
      });
    }
    var mergedModels = [];
    for (var j = 0; j < officialModels.length; j++) {
      var official = sanitizeOfficialModelValue(officialModels[j]);
      if (!official) continue;
      var officialIds = modelCollisionIds(official);
      if (officialIds.has("default")) continue;
      var collides = false;
      officialIds.forEach(function (id) {
        if (byokNames.has(id)) collides = true;
      });
      if (collides) continue;
      mergedModels.push(official);
    }
    for (var k = 0; k < byokModels.length; k++) {
      var model = byokModels[k];
      var modelName = model && (model.name || model.id);
      if (!modelName || modelName === "default") continue;
      if (!model.name) model = Object.assign({}, model, { name: modelName });
      mergedModels.push(model);
    }
    var mergedJson = Object.assign({}, messageJson, {
      models: mergedModels,
      modelNames: mergedModels.map(function (model) {
        return model.name || model.id;
      }).filter(Boolean),
      useModelParameters: true,
    });
    return Object.assign({}, result, { message: fromJson(responseType, mergedJson) });
  }

  async function* readNdjson(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var pending = "";
    var pendingBytes = 0;
    var completed = false;
    try {
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        pendingBytes += chunk.value.byteLength;
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          var nl = pending.indexOf("\n");
          if (nl < 0) break;
          var consumed = pending.slice(0, nl + 1);
          var line = pending.slice(0, nl).trim();
          var consumedBytes = utf8ByteLength(consumed);
          if (consumedBytes > maxNdjsonLineBytes) throw new Error("BYOK NDJSON line exceeds " + maxNdjsonLineBytes + " bytes");
          pending = pending.slice(nl + 1);
          pendingBytes -= consumedBytes;
          if (pendingBytes < 0) pendingBytes = 0;
          if (!line) continue;
          yield JSON.parse(line);
        }
        if (pendingBytes > maxNdjsonLineBytes) throw new Error("BYOK NDJSON line exceeds " + maxNdjsonLineBytes + " bytes");
      }
      pending += decoder.decode();
      if (pendingBytes > maxNdjsonLineBytes) throw new Error("BYOK NDJSON line exceeds " + maxNdjsonLineBytes + " bytes");
      completed = true;
      if (pending.trim()) yield JSON.parse(pending);
    } finally {
      if (!completed && typeof reader.cancel === "function") {
        try {
          await reader.cancel();
        } catch {}
      }
      try {
        reader.releaseLock?.();
      } catch {}
    }
  }

  function utf8ByteLength(value) {
    try {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(value || "").byteLength;
    } catch {}
    return unescape(encodeURIComponent(value || "")).length;
  }

  function serverMessage(message) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "interactionUpdate",
        value: { message },
      },
    });
  }

  function interactionQueryEnvelope(query) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "interactionQuery",
        value: query,
      },
    });
  }

  function textDelta(text) {
    return serverMessage({ case: "textDelta", value: { text } });
  }

  function thinkingDelta(text) {
    return serverMessage({ case: "thinkingDelta", value: { text, thinkingStyle: 1 } });
  }

  function thinkingDone() {
    return serverMessage({ case: "thinkingCompleted", value: { thinkingDurationMs: 0 } });
  }

  function tokenDelta(tokens) {
    return serverMessage({ case: "tokenDelta", value: { tokens } });
  }

  function stepCompleted(stepId, startedAt) {
    return serverMessage({
      case: "stepCompleted",
      value: { stepId, stepDurationMs: Date.now() - startedAt },
    });
  }

  function usedTokensForEvent(event) {
    var usage = event && event.usage || {};
    return positiveInteger(usage.inputTokens) +
      positiveInteger(usage.outputTokens) +
      positiveInteger(usage.cacheReadTokens) +
      positiveInteger(usage.cacheWriteTokens);
  }

  function conversationCheckpointBaseFromRequest(request) {
    var state = request && (request.conversationState || request.field6_conversationState);
    if (state && typeof state === "object") {
      var cloned = cloneJsonValue(state);
      if (cloned && typeof cloned === "object") return cloned;
    }
    return {
      rootPromptMessagesJson: [],
      turns: [],
      pendingToolCalls: [],
      summaryArchives: [],
      mode: 1,
      previousWorkspaceUris: [],
      readPaths: [],
      agentType: "ide",
      trackedGitRepoBranches: [],
      plans: {},
    };
  }

  function conversationCheckpointTokenUpdate(usedTokens, maxTokens, request) {
    var value = conversationCheckpointBaseFromRequest(request);
    value.tokenDetails = { usedTokens: usedTokens, maxTokens: maxTokens };
    return fromJson(captured.messageCtor, {
      message: {
        case: "conversationCheckpointUpdate",
        value: value,
      },
    });
  }

  function conversationCheckpointTokenUpdateForEvent(event, maxTokens, request) {
    if (!maxTokens) return null;
    var usedTokens = usedTokensForEvent(event);
    if (!usedTokens) return null;
    if (usedTokens > maxTokens) usedTokens = maxTokens;
    return conversationCheckpointTokenUpdate(usedTokens, maxTokens, request);
  }

  function turnEnded(event) {
    var usage = event.usage || {};
    return serverMessage({
      case: "turnEnded",
      value: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
      },
    });
  }

  function toolCallStarted(event, modelCallId) {
    var args = parseToolArguments(event.arguments);
    return serverMessage({
      case: "toolCallStarted",
      value: {
        callId: event.id,
        toolCall: toolEnvelope(event.name, args, undefined, event.id),
        modelCallId,
      },
    });
  }

  function toolCallCompleted(event, modelCallId, result) {
    var args = parseToolArguments(event.arguments);
    return serverMessage({
      case: "toolCallCompleted",
      value: {
        callId: event.id,
        toolCall: toolEnvelope(event.name, args, result, event.id),
        modelCallId,
      },
    });
  }

  function awaitShellLocalResult(event) {
    var args = parseToolArguments(event.arguments);
    var taskId = awaitTaskIdArg(args);
    if (!taskId) {
      return {
        result: {
          case: "error",
          value: {
            error: "AwaitShell requires shell_id or task_id from a previous background shell or subagent result.",
          },
        },
      };
    }
    var blockUntilMs = normalizeInteger(args.block_until_ms ?? args.blockUntilMs);
    if (blockUntilMs === undefined) blockUntilMs = 30000;
    if (blockUntilMs < 0) blockUntilMs = 0;
    if (blockUntilMs > 300000) blockUntilMs = 300000;
    return {
      result: {
        case: "success",
        value: {
          complete: {
            taskId: taskId,
            runtimeMs: blockUntilMs,
            outputFilePath: "",
            outputLength: 0,
          },
        },
      },
    };
  }

  function unsupportedLocalResult() {
    return {
      result: {
        case: "error",
        value: { error: "Cursor BYOK cannot execute this tool through native exec." },
      },
    };
  }

  function eventLocalResult(event) {
    var local = event && event.localResult;
    if (!local || !local.case || local.value === undefined) return null;
    switch (local.case) {
      case "byokExecResult":
      case "unsupportedToolResult":
      case "requestContextResult":
      case "todoWriteResult":
      case "awaitResult":
      case "subagentAwaitResult":
        return { case: local.case, value: local.value };
      default:
        return null;
    }
  }

  var localTodosByScope = {};

  function todosForScope(scopeId) {
    var key = scopeId || "default";
    if (!localTodosByScope[key]) localTodosByScope[key] = [];
    return localTodosByScope[key];
  }

  function replaceTodosForScope(scopeId, todos) {
    localTodosByScope[scopeId || "default"] = todos;
  }

  function cloneTodos(todos) {
    return todos.map(function (todo) {
      var out = {};
      var keys = Object.keys(todo || {});
      for (var i = 0; i < keys.length; i++) out[keys[i]] = todo[keys[i]];
      return out;
    });
  }

  function normalizeTodoItem(value) {
    if (!value || typeof value !== "object") return null;
    var id = stringArg(value.id || value.taskId || value.task_id, "");
    var content = stringArg(value.content || value.subject || value.description, "");
    var status = stringArg(value.status, "");
    if (!id && !content && !status) return null;
    var todo = {};
    if (id) todo.id = id;
    if (content) todo.content = content;
    if (status) todo.status = status;
    return todo;
  }

  function mergeTodos(scopeId, updates) {
    var localTodos = todosForScope(scopeId);
    for (var i = 0; i < updates.length; i++) {
      var update = normalizeTodoItem(updates[i]);
      if (!update) continue;
      var id = stringArg(update.id, "");
      var index = -1;
      if (id) {
        for (var j = 0; j < localTodos.length; j++) {
          if (localTodos[j] && localTodos[j].id === id) {
            index = j;
            break;
          }
        }
      }
      if (index >= 0) {
        localTodos[index] = { ...localTodos[index], ...update };
      } else {
        localTodos.push(update);
      }
    }
  }

  function todoUiStatus(status) {
    var normalized = planTodoStatus(status);
    return normalized === undefined ? 0 : normalized;
  }

  function todoUiItem(todo) {
    if (!todo || typeof todo !== "object") return null;
    var out = { status: todoUiStatus(todo.status) };
    if (todo.id !== undefined) out.id = stringArg(todo.id, "");
    if (todo.content !== undefined) out.content = stringArg(todo.content, "");
    if (Array.isArray(todo.dependencies) && todo.dependencies.length) out.dependencies = todo.dependencies.map(String);
    return out;
  }

  function todoWriteProviderResultFromSnapshot(snapshot, merge) {
    return {
      result: {
        case: "success",
        value: {
          todos: snapshot,
          merge: !!merge,
        },
      },
    };
  }

  function todoWriteUiResultFromSnapshot(snapshot, merge) {
    var todos = [];
    for (var i = 0; i < snapshot.length; i++) {
      var todo = todoUiItem(snapshot[i]);
      if (todo) todos.push(todo);
    }
    return {
      result: {
        case: "success",
        value: {
          todos: todos,
          totalCount: todos.length,
          wasMerge: !!merge,
        },
      },
    };
  }

  function todoWriteLocalPayload(todos, merge) {
    var snapshot = cloneTodos(todos);
    return {
      providerResult: todoWriteProviderResultFromSnapshot(snapshot, merge),
      uiResult: todoWriteUiResultFromSnapshot(snapshot, merge),
    };
  }

  function todoWriteLocalResult(event, scopeId) {
    var args = parseToolArguments(event.arguments);
    var localTodos = todosForScope(scopeId);
    if (event.name === "TaskList" || event.name === "TaskGet") {
      return todoWriteLocalPayload(localTodos, true);
    }
    if (event.name === "TaskCreate" || event.name === "TaskUpdate") {
      var taskId = stringArg(args.taskId || args.task_id || event.id || "task");
      var todo = {
        id: event.name === "TaskUpdate" ? taskId : String(event.id || "task-create"),
        status: stringArg(args.status, "in_progress"),
      };
      var content = stringArg(args.subject || args.description, "");
      if (content) todo.content = content;
      mergeTodos(scopeId, [todo]);
      return todoWriteLocalPayload(todosForScope(scopeId), true);
    }
    if (!args.merge) replaceTodosForScope(scopeId, []);
    mergeTodos(scopeId, arrayArg(args.todos));
    return todoWriteLocalPayload(todosForScope(scopeId), !!args.merge);
  }

  function editErrorResult(path, error) {
    return {
      result: {
        case: "error",
        value: { path, error: String(error || "Edit failed") },
      },
    };
  }

  function editSuccessResult(path, beforeContent, afterContent, message) {
    return {
      result: {
        case: "success",
        value: {
          path,
          beforeFullFileContent: beforeContent,
          afterFullFileContent: afterContent,
          message: message || ("The file " + path + " has been updated."),
        },
      },
    };
  }

  function readContentFromExecResult(result) {
    var message = result && result.message;
    if (!message || message.case !== "readResult") {
      return { case: "error", message: "read failed: no readResult" };
    }
    var readResult = message.value && message.value.result;
    if (!readResult || typeof readResult.case !== "string") {
      return { case: "error", message: "read failed: malformed readResult" };
    }
    if (readResult.case === "success") {
      var value = readResult.value || {};
      var output = value.output || {};
      if (output.case === "content") return { case: "success", content: String(output.value || "") };
      if (typeof output.content === "string") return { case: "success", content: output.content };
      if (typeof value.content === "string") return { case: "success", content: value.content };
      return { case: "success", content: "" };
    }
    if (readResult.case === "fileNotFound") {
      return { case: "fileNotFound", message: "File not found" };
    }
    return {
      case: "error",
      message: String((readResult.value && (readResult.value.error || readResult.value.message || readResult.value.reason)) || "read " + readResult.case),
    };
  }

  function writeErrorFromExecResult(result) {
    var message = result && result.message;
    if (!message || message.case !== "writeResult") return "write failed: no writeResult";
    var writeResult = message.value && message.value.result;
    if (writeResult && writeResult.case === "success") return "";
    return String((writeResult && writeResult.value && (writeResult.value.error || writeResult.value.message || writeResult.value.reason)) || "write failed");
  }

  function normalizeTextForEdit(text) {
    var bom = text && text.charCodeAt(0) === 0xFEFF ? "\uFEFF" : "";
    var body = bom ? text.slice(1) : text;
    var lineEnding = body.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    return {
      bom,
      lineEnding,
      normalizedText: body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    };
  }

  function restoreLineEnding(text, lineEnding) {
    return lineEnding === "\n" ? text : text.replace(/\n/g, lineEnding);
  }

  function firstStringArg() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (typeof value === "string" && value) return value;
    }
    return "";
  }

  function pathArg(args) {
    return firstStringArg(args.path, args.filePath, args.file_path, args.filename, args.target_notebook, args.targetNotebook);
  }

  function writeContentArg(args) {
    if (typeof args.contents === "string") return args.contents;
    if (typeof args.content === "string") return args.content;
    if (typeof args.fileText === "string") return args.fileText;
    return "";
  }

  function oldStringArg(args) {
    if (typeof args.old_string === "string") return args.old_string;
    if (typeof args.oldString === "string") return args.oldString;
    if (typeof args.old === "string") return args.old;
    return "";
  }

  function newStringArg(args) {
    if (typeof args.new_string === "string") return args.new_string;
    if (typeof args.newString === "string") return args.newString;
    if (typeof args.new === "string") return args.new;
    return "";
  }

  function applyStringEdit(path, beforeContent, args) {
    var oldString = oldStringArg(args);
    var newString = newStringArg(args);
    if (oldString === newString) throw new Error("No changes to make: old_string and new_string are exactly the same.");
    if (!oldString) throw new Error("Edit does not create files. Use the Write tool for new files.");
    if (/\.ipynb$/i.test(path)) throw new Error("File is a Jupyter Notebook. Use EditNotebook to edit notebook cells.");
    var normalized = normalizeTextForEdit(beforeContent);
    var oldNormalized = oldString.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var newNormalized = newString.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var count = normalized.normalizedText.split(oldNormalized).length - 1;
    if (count === 0) throw new Error("String to replace not found in file.\nString: " + oldString);
    if (count > 1 && args.replace_all !== true) {
      throw new Error("Found " + count + " matches of the string to replace, but replace_all is false. Provide more context or set replace_all to true.\nString: " + oldString);
    }
    var edited = args.replace_all === true
      ? normalized.normalizedText.split(oldNormalized).join(newNormalized)
      : normalized.normalizedText.replace(oldNormalized, newNormalized);
    return {
      beforeContent,
      fileText: normalized.bom + restoreLineEnding(edited, normalized.lineEnding),
      streamContent: restoreLineEnding(newNormalized, normalized.lineEnding),
      message: "The file " + path + " has been updated.",
    };
  }

  function parseFullApplyPatch(patchText) {
    var lines = patchText.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    var begin = 0;
    while (begin < lines.length && lines[begin].indexOf("*** Begin Patch") !== 0) begin++;
    if (begin >= lines.length) return null;
    begin++;
    var end = lines.length - 1;
    while (end > begin && lines[end].indexOf("*** End Patch") !== 0) end--;
    if (begin > end) return null;
    var body = lines.slice(begin, end);
    if (!body.length) return null;
    var header = body[0].trim();
    if (header.indexOf("*** Add File: ") === 0) {
      var addPath = header.slice(14).trim();
      var addLines = [];
      for (var i = 1; i < body.length; i++) {
        if (body[i].charAt(0) === "+") addLines.push(body[i].slice(1));
      }
      return { action: "add", path: addPath, addContents: addLines.join("\n") + "\n" };
    }
    if (header.indexOf("*** Delete File: ") === 0) {
      return { action: "delete", path: header.slice(17).trim() };
    }
    if (header.indexOf("*** Update File: ") !== 0) return null;
    var updatePath = header.slice(17).trim();
    var index = 1;
    var movePath = "";
    if (index < body.length && body[index].indexOf("*** Move to: ") === 0) {
      movePath = body[index].slice(13).trim();
      index++;
    }
    var chunks = [];
    while (index < body.length) {
      if (body[index].trim() === "") {
        index++;
        continue;
      }
      if (body[index].indexOf("***") === 0) break;
      var parsed = parsePatchChunk(body, index, chunks.length === 0);
      if (!parsed) break;
      chunks.push(parsed.chunk);
      index += parsed.consumed;
    }
    if (!chunks.length) return null;
    return { action: "update", path: updatePath, movePath, chunks };
  }

  function parsePatchChunk(lines, index, firstChunk) {
    var context = null;
    var cursor = index;
    if (lines[cursor] === "@@") {
      cursor++;
    } else if (lines[cursor].indexOf("@@ ") === 0) {
      context = lines[cursor].slice(3).trim();
      cursor++;
    } else if (!firstChunk) {
      return null;
    }
    var chunk = { changeContext: context, oldLines: [], newLines: [], isEndOfFile: false };
    var consumed = cursor - index;
    for (; cursor < lines.length; cursor++) {
      var line = lines[cursor];
      if (line === "*** End of File") {
        chunk.isEndOfFile = true;
        consumed++;
        break;
      }
      if (line === "@@" || line.indexOf("@@ ") === 0 || line.indexOf("***") === 0) break;
      var prefix = line.charAt(0);
      if (prefix === " ") {
        chunk.oldLines.push(line.slice(1));
        chunk.newLines.push(line.slice(1));
      } else if (prefix === "-") {
        chunk.oldLines.push(line.slice(1));
      } else if (prefix === "+") {
        chunk.newLines.push(line.slice(1));
      } else if (line === "") {
        chunk.oldLines.push("");
        chunk.newLines.push("");
      } else {
        break;
      }
      consumed++;
    }
    return consumed > 0 ? { chunk, consumed } : null;
  }

  function findPatchChunkIndex(lines, chunk, startIndex) {
    var oldLines = chunk.oldLines || [];
    if (!oldLines.length) return Math.min(startIndex, lines.length);
    for (var i = Math.max(0, startIndex); i <= lines.length - oldLines.length; i++) {
      var matched = true;
      for (var j = 0; j < oldLines.length; j++) {
        if (lines[i + j] !== oldLines[j]) {
          matched = false;
          break;
        }
      }
      if (matched) return i;
    }
    return -1;
  }

  function applyParsedPatch(parsed, beforeContent) {
    if (parsed.action === "add") return parsed.addContents || "";
    if (parsed.action === "delete") throw new Error("ApplyPatch Delete File is not supported by editToolCall; use the Delete tool instead.");
    if (parsed.movePath) throw new Error("Move/Rename is not supported by ApplyPatch in BYOK yet.");
    var lineEnding = beforeContent.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    var lines = beforeContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    var out = lines.slice();
    var searchFrom = 0;
    var matched = 0;
    for (var i = 0; i < (parsed.chunks || []).length; i++) {
      var chunk = parsed.chunks[i];
      var at = findPatchChunkIndex(out, chunk, searchFrom);
      if (at < 0) throw new Error("Patch did not apply to " + parsed.path + ": hunk did not match");
      out.splice.apply(out, [at, chunk.oldLines.length].concat(chunk.newLines));
      searchFrom = at + chunk.newLines.length;
      matched++;
    }
    if (!matched) throw new Error("Patch did not apply to " + parsed.path + ": no hunks matched");
    if (!out.length || out[out.length - 1] !== "") out.push("");
    return out.join(lineEnding);
  }

  function applyPatchEdit(path, beforeRead, args) {
    var patchText = applyPatchText(args);
    var parsed = parseFullApplyPatch(patchText);
    if (!parsed) throw new Error("Failed to parse patch: invalid format");
    var beforeContent = beforeRead.case === "success" ? beforeRead.content : "";
    if (parsed.action === "add") {
      if (beforeRead.case === "success") throw new Error("ApplyPatch Add File target already exists: " + path);
      if (beforeRead.case !== "fileNotFound") throw new Error(beforeRead.message);
    } else if (beforeRead.case !== "success") {
      throw new Error(beforeRead.message);
    }
    var fileText = applyParsedPatch(parsed, beforeContent);
    return {
      beforeContent,
      fileText,
      streamContent: parseApplyPatch(patchText)?.streamContent || "",
      message: "Success. Updated the following files:\n" + (parsed.action === "add" ? "A " : "M ") + path,
    };
  }

  function applyNotebookEdit(path, beforeContent, args) {
    var notebook;
    try {
      notebook = JSON.parse(beforeContent);
    } catch {
      throw new Error("Notebook is not valid JSON: " + path);
    }
    if (!notebook || !Array.isArray(notebook.cells)) throw new Error("Notebook has no cells array: " + path);
    var cellIdx = normalizeInteger(args.cell_idx);
    if (cellIdx === undefined) throw new Error("cell_idx is required");
    var newString = newStringArg(args);
    var oldString = oldStringArg(args);
    if (args.is_new_cell === true) {
      if (cellIdx < 0 || cellIdx > notebook.cells.length) throw new Error("Cell index " + cellIdx + " out of range (0.." + notebook.cells.length + ")");
      var language = stringArg(args.cell_language, "python");
      notebook.cells.splice(cellIdx, 0, {
        cell_type: language === "markdown" ? "markdown" : "code",
        metadata: {},
        source: sourceLines(newString),
        ...(language === "markdown" ? {} : { execution_count: null, outputs: [] }),
      });
    } else {
      if (cellIdx < 0 || cellIdx >= notebook.cells.length) throw new Error("Cell index " + cellIdx + " out of range (0.." + (notebook.cells.length - 1) + ")");
      var cell = notebook.cells[cellIdx];
      var current = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      if (oldString && current.indexOf(oldString) < 0) throw new Error("old_string not found in cell " + cellIdx);
      cell.source = sourceLines(oldString ? current.replace(oldString, newString) : newString);
    }
    return {
      beforeContent,
      fileText: JSON.stringify(notebook, null, 1) + "\n",
      streamContent: newString,
      message: "The notebook " + path + " has been updated.",
    };
  }

  function sourceLines(text) {
    var parts = String(text || "").split("\n");
    return parts.map(function (line, index) {
      return index < parts.length - 1 ? line + "\n" : line;
    });
  }

  function execServerMessage(event, execId) {
    var args = normalizeToolArgs(event.name, parseToolArguments(event.arguments), event.id);
    if (!args) return null;
    return execServerMessageFromParts(execId, event.id, args.case, args.value);
  }

  function execServerMessageFromParts(id, execId, messageCase, messageValue) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "execServerMessage",
        value: {
          id,
          execId,
          message: {
            case: messageCase,
            value: messageValue,
          },
        },
      },
    });
  }

  function interactionQueryMessage(queryId, queryCase, queryValue) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "interactionQuery",
        value: {
          id: queryId,
          query: {
            case: queryCase,
            value: queryValue,
          },
        },
      },
    });
  }

  function registerNativeExecAlias(requestId, id, execId, toolCallId) {
    if (!requestId || !toolCallId) return;
    postJson("/byok/exec-map", { requestId, id, execId, toolCallId });
  }

  function mapNativeExecResult(state, id, execId, toolCallId) {
    if (!state) return;
    state.execIdToToolCallId[String(id)] = toolCallId;
    state.execIdToToolCallId[execId] = toolCallId;
  }

  function toolEnvelope(name, args, result, toolCallId) {
    var cursorToolType = cursorToolTypeForName(name);
    var value = {};
    var startedArgs = normalizeStartedToolArgs(name, args, toolCallId);
    if (startedArgs !== undefined) value.args = startedArgs;
    if (result !== undefined) value.result = result;
    return {
      tool: {
        case: cursorToolType,
        value,
      },
    };
  }

  function cursorToolTypeForName(name) {
    switch (name) {
      case "Read":
      case "ReadFile":
        return "readToolCall";
      case "Edit":
      case "ApplyPatch":
      case "Write":
      case "EditNotebook":
        return "editToolCall";
      case "GenerateImage":
        return "generateImageToolCall";
      case "Shell":
        return "shellToolCall";
      case "Grep":
        return "grepToolCall";
      case "Glob":
        return "globToolCall";
      case "LS":
        return "lsToolCall";
      case "Delete":
        return "deleteToolCall";
      case "WriteShellStdin":
        return "custom";
      case "TodoWrite":
      case "TaskCreate":
      case "TaskUpdate":
      case "TaskList":
      case "TaskGet":
        return "updateTodosToolCall";
      case "ReadLints":
        return "readLintsToolCall";
      case "WebSearch":
        return "webSearchToolCall";
      case "WebFetch":
        return "webFetchToolCall";
      case "AwaitShell":
        return "awaitToolCall";
      case "CallMcpTool":
        return "mcpToolCall";
      case "ListMcpResources":
        return "listMcpResourcesToolCall";
      case "FetchMcpResource":
        return "readMcpResourceToolCall";
      case "mcp_auth":
        return "mcpAuthToolCall";
      case "AskQuestion":
        return "askQuestionToolCall";
      case "SwitchMode":
        return "switchModeToolCall";
      case "CreatePlan":
        return "createPlanToolCall";
      default:
        return "custom";
    }
  }

  function isInteractionBridgeTool(name) {
    return name === "AskQuestion" || name === "SwitchMode" || name === "CreatePlan";
  }

  function isClientInteractionTool(name) {
    return name === "WebSearch" || name === "WebFetch" || name === "GenerateImage";
  }

  function coalesceStringAliases(args, keys) {
    if (!args || typeof args !== "object") return "";
    for (var i = 0; i < keys.length; i++) {
      var value = stringArg(args[keys[i]], "");
      if (value) return value;
    }
    return "";
  }

  function normalizeWebSearchQueryArgs(args, toolCallId) {
    return {
      searchTerm: coalesceStringAliases(args, ["search_term", "searchTerm"]),
      toolCallId: stringArg(toolCallId),
    };
  }

  function normalizeWebFetchQueryArgs(args, toolCallId) {
    return {
      url: coalesceStringAliases(args, ["url"]),
      toolCallId: stringArg(toolCallId),
    };
  }

  function normalizeGenerateImageQueryArgs(args, toolCallId) {
    var referenceImagePaths = arrayArg(args.reference_image_paths ?? args.referenceImagePaths);
    var out = {
      description: stringArg(args.description),
      referenceImagePaths: referenceImagePaths,
      toolCallId: stringArg(toolCallId),
    };
    var filePath = coalesceStringAliases(args, ["filename", "filePath", "file_path"]);
    if (filePath) out.filePath = filePath;
    return out;
  }

  function buildClientInteractionQuery(toolName, toolCallId, args, queryId) {
    var id = Number(queryId) || 0;
    if (toolName === "WebSearch") {
      return {
        id: id,
        query: {
          case: "webSearchRequestQuery",
          value: {
            args: normalizeWebSearchQueryArgs(args, toolCallId),
          },
        },
      };
    }
    if (toolName === "WebFetch") {
      return {
        id: id,
        query: {
          case: "webFetchRequestQuery",
          value: {
            args: normalizeWebFetchQueryArgs(args, toolCallId),
          },
        },
      };
    }
    if (toolName === "GenerateImage") {
      return {
        id: id,
        query: {
          case: "generateImageRequestQuery",
          value: {
            args: normalizeGenerateImageQueryArgs(args, toolCallId),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    }
    return { id: id, query: { case: undefined, value: undefined } };
  }

  function interactionApprovalCase(interactionResponse) {
    var top = interactionResponse && interactionResponse.result;
    if (!top || !top.case) return "";
    var topValue = top.value || {};
    var inner = topValue.result || topValue;
    return inner && inner.case || top.case;
  }

  function interactionApprovalGranted(interactionResponse) {
    var responseCase = interactionApprovalCase(interactionResponse);
    return responseCase === "approved" || responseCase === "success";
  }

  function interactionApprovalRejected(interactionResponse) {
    return interactionApprovalCase(interactionResponse) === "rejected";
  }

  function toolResultFromClientCompletion(toolName, completion) {
    if (!completion || !completion.case) {
      return {
        result: {
          case: "error",
          value: { error: toolName + " completed without a Cursor tool result" },
        },
      };
    }
    return { result: completion };
  }

  function normalizeAskQuestionArgs(args) {
    return {
      title: stringArg(args.title, ""),
      questions: arrayArg(args.questions).map(function (question) {
        return {
          id: stringArg(question.id),
          prompt: stringArg(question.prompt),
          allowMultiple: !!(question.allow_multiple ?? question.allowMultiple),
          options: arrayArg(question.options).map(function (option) {
            return {
              id: stringArg(option.id),
              label: stringArg(option.label),
            };
          }),
        };
      }),
    };
  }

  function normalizeSwitchModeQueryArgs(args, toolCallId) {
    return {
      targetModeId: stringArg(args.target_mode_id || args.targetModeId),
      explanation: stringArg(args.explanation, ""),
      toolCallId: stringArg(toolCallId),
    };
  }

  function normalizePlanTodo(todo) {
    var out = {
      id: stringArg(todo.id),
      content: stringArg(todo.content),
      dependencies: arrayArg(todo.dependencies).map(String),
    };
    var status = planTodoStatus(todo.status);
    if (status !== undefined) out.status = status;
    return out;
  }

  function planTodoStatus(status) {
    switch (stringArg(status).toLowerCase()) {
      case "pending":
        return 1;
      case "in_progress":
      case "in-progress":
      case "inprogress":
        return 2;
      case "completed":
      case "complete":
      case "done":
        return 3;
      case "cancelled":
      case "canceled":
        return 4;
      default:
        return Number.isInteger(status) ? status : undefined;
    }
  }

  function normalizeCreatePlanQueryArgs(args) {
    return {
      name: stringArg(args.name, ""),
      overview: stringArg(args.overview, ""),
      plan: stringArg(args.plan, ""),
      todos: arrayArg(args.todos).map(normalizePlanTodo),
      isProject: !!(args.isProject ?? args.is_project),
      phases: arrayArg(args.phases).map(function (phase) {
        return {
          name: stringArg(phase.name),
          todos: arrayArg(phase.todos).map(normalizePlanTodo),
        };
      }),
    };
  }

  function buildInteractionQuery(toolName, toolCallId, args, queryId) {
    var id = Number(queryId) || 0;
    if (toolName === "AskQuestion") {
      return {
        id: id,
        query: {
          case: "askQuestionInteractionQuery",
          value: {
            args: normalizeAskQuestionArgs(args),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    }
    if (toolName === "SwitchMode") {
      return {
        id: id,
        query: {
          case: "switchModeRequestQuery",
          value: {
            args: normalizeSwitchModeQueryArgs(args, toolCallId),
          },
        },
      };
    }
    if (toolName === "CreatePlan") {
      return {
        id: id,
        query: {
          case: "createPlanRequestQuery",
          value: {
            args: normalizeCreatePlanQueryArgs(args),
            toolCallId: stringArg(toolCallId),
          },
        },
      };
    }
    return { id: id, query: { case: undefined, value: undefined } };
  }

  function unwrapInteractionPayload(toolName, interactionResponse) {
    var top = interactionResponse && interactionResponse.result;
    if (!top || !top.case) return top;
    var topValue = top.value || {};
    if (toolName === "SwitchMode" && top.case === "switchModeRequestResponse") {
      return topValue.result || topValue;
    }
    if (toolName === "AskQuestion" && top.case === "askQuestionInteractionResponse") {
      return topValue.result || topValue;
    }
    if (toolName === "CreatePlan" && top.case === "createPlanRequestResponse") {
      return topValue.result || topValue;
    }
    return top;
  }

  function askQuestionResultError(message) {
    return {
      result: {
        case: "error",
        value: { errorMessage: message },
      },
    };
  }

  function normalizedAskQuestionAnswers(value) {
    return arrayArg(value && value.answers).map(function (answer) {
      return {
        questionId: stringArg(answer && (answer.questionId || answer.question_id)),
        selectedOptionIds: arrayArg(answer && (answer.selectedOptionIds || answer.selected_option_ids)).map(String),
        freeformText: stringArg(answer && (answer.freeformText || answer.freeform_text), ""),
      };
    });
  }

  function toolResultFromInteractionResponse(toolName, interactionResponse, toolArgs) {
    var payload = unwrapInteractionPayload(toolName, interactionResponse);
    var outerCase = payload && payload.case;
    var outerValue = payload && payload.value !== undefined ? payload.value : payload || {};
    if (toolName === "AskQuestion") {
      var inner = outerValue.result || outerValue;
      var innerCase = (inner && inner.case) || outerCase;
      var innerValue = inner && inner.value !== undefined ? inner.value : inner;
      if (innerCase === "success") {
        return { result: { case: "success", value: { answers: normalizedAskQuestionAnswers(innerValue) } } };
      }
      if (innerCase === "error") {
        return {
          result: {
            case: "error",
            value: { errorMessage: stringArg(innerValue && (innerValue.errorMessage || innerValue.error), "AskQuestion failed") },
          },
        };
      }
      if (innerCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(innerValue && innerValue.reason, "User rejected the questionnaire") },
          },
        };
      }
      if (innerCase === "async") {
        return { result: { case: "success", value: { isAsync: true, answers: [] } } };
      }
      return askQuestionResultError("AskQuestion completed without a Cursor result");
    }
    if (toolName === "SwitchMode") {
      var targetModeId = stringArg(toolArgs.target_mode_id || toolArgs.targetModeId);
      var switchCase = outerCase || (outerValue && outerValue.case);
      var switchValue = outerValue && outerValue.value !== undefined ? outerValue.value : outerValue;
      if (switchCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(switchValue && switchValue.reason, "User rejected the mode switch") },
          },
        };
      }
      if (switchCase === "approved" || switchCase === "success") {
        return {
          result: {
            case: "success",
            value: { fromModeId: "", toModeId: targetModeId },
          },
        };
      }
      return {
        result: {
          case: "error",
          value: { error: stringArg(outerValue.error, "SwitchMode failed") },
        },
      };
    }
    if (toolName === "CreatePlan") {
      var planInner = outerValue.result || outerValue;
      var planCase = planInner && planInner.case;
      var planValue = planInner && planInner.value !== undefined ? planInner.value : planInner;
      if (planCase === "error") {
        return { result: { case: "error", value: { error: stringArg(planValue && planValue.error, "CreatePlan failed") } } };
      }
      if (planCase === "rejected") {
        return {
          result: {
            case: "rejected",
            value: { reason: stringArg(planValue && planValue.reason, "User rejected the plan") },
          },
        };
      }
      return { result: { case: "success", value: planValue && typeof planValue === "object" ? planValue : {} } };
    }
    return { result: { case: "error", value: { error: "Unsupported interaction tool " + toolName } } };
  }

  function nextInteractionQueryId(state) {
    if (!state) return 100000;
    if (!state.interactionQuerySeq) state.interactionQuerySeq = 100000;
    var id = state.interactionQuerySeq++;
    if (state.interactionQuerySeq > 2147483000) state.interactionQuerySeq = 100000;
    return id;
  }

  async function waitForInteractionResult(requestId, queryId, toolName, toolArguments, toolCallId, signal) {
    var response = await fetchByokPath("/byok/interaction-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        requestId: requestId,
        queryId: queryId,
        toolName: toolName,
        toolArguments: toolArguments,
        toolCallId: toolCallId,
      }),
    });
    var json = await response.json();
    return json && json.result;
  }

  function parseToolArguments(args) {
    if (args === undefined || args === null || args === "") return {};
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return {};
      }
    }
    return args;
  }

  function normalizeInteger(value) {
    if (typeof value === "number" && Math.floor(value) === value) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
    return undefined;
  }

  function readStartedArgs(args) {
    var offset = normalizeInteger(args.offset);
    var limit = normalizeInteger(args.limit);
    return {
      path: String(args.path || args.filePath || args.file_path || ""),
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  function applyPatchStartedArgs(args) {
    var plan = parseApplyPatch(applyPatchText(args));
    return { path: plan ? plan.path : String(args.path || args.filename || "") };
  }

  function normalizeStartedToolArgs(name, args, toolCallId) {
    if (args === undefined) return undefined;
    switch (name) {
      case "Read":
      case "ReadFile":
        return readStartedArgs(args);
      case "Glob":
        return {
          targetDirectory: String(args.target_directory || args.targetDirectory || args.path || ""),
          globPattern: String(args.glob_pattern || args.globPattern || args.pattern || ""),
        };
      case "LS": {
        var lsStarted = {
          path: String(args.path || args.target_directory || args.targetDirectory || ""),
        };
        var ignoreStarted = arrayArg(args.ignore || args.ignore_globs || args.ignoreGlobs);
        if (ignoreStarted.length) lsStarted.ignore = ignoreStarted;
        return lsStarted;
      }
      case "WebFetch":
        return { url: stringArg(args.url) };
      case "WriteShellStdin":
        return {
          shellId: stringArg(args.shell_id ?? args.shellId),
          chars: stringArg(args.chars),
        };
      case "AwaitShell": {
        var awaitStarted = {};
        var taskId = stringArg(args.task_id ?? args.shell_id ?? args.shellId ?? args.taskId, "");
        if (taskId) awaitStarted.taskId = taskId;
        var blockMs = normalizeInteger(args.block_until_ms ?? args.blockUntilMs);
        if (blockMs !== undefined) awaitStarted.blockUntilMs = blockMs;
        return awaitStarted;
      }
      case "Grep": {
        var grep = {
          pattern: String(args.pattern || ""),
        };
        if (args.path !== undefined) grep.path = String(args.path);
        if (args.glob !== undefined) grep.glob = String(args.glob);
        if (args.type !== undefined) grep.type = String(args.type);
        if (args.output_mode !== undefined) grep.outputMode = String(args.output_mode);
        if (args.outputMode !== undefined) grep.outputMode = String(args.outputMode);
        var contextBefore = normalizeInteger(args["-B"] ?? args.context_before ?? args.contextBefore);
        var contextAfter = normalizeInteger(args["-A"] ?? args.context_after ?? args.contextAfter);
        var context = normalizeInteger(args["-C"] ?? args.context);
        var headLimit = normalizeInteger(args.head_limit ?? args.headLimit);
        var grepOffset = normalizeInteger(args.offset);
        if (contextBefore !== undefined) grep.contextBefore = contextBefore;
        if (contextAfter !== undefined) grep.contextAfter = contextAfter;
        if (context !== undefined) grep.context = context;
        if (headLimit !== undefined) grep.headLimit = headLimit;
        if (grepOffset !== undefined) grep.offset = grepOffset;
        if (args["-i"] !== undefined) grep.caseInsensitive = !!args["-i"];
        if (args.case_insensitive !== undefined) grep.caseInsensitive = !!args.case_insensitive;
        if (args.caseInsensitive !== undefined) grep.caseInsensitive = !!args.caseInsensitive;
        if (args.multiline !== undefined) grep.multiline = !!args.multiline;
        return grep;
      }
      case "ApplyPatch":
        return applyPatchStartedArgs(args);
      case "Write":
        return { path: pathArg(args) };
      case "EditNotebook":
        return {
          path: pathArg(args),
          streamContent: newStringArg(args),
        };
      case "GenerateImage": {
        var image = { description: stringArg(args.description) };
        if (typeof args.filename === "string") image.filePath = args.filename;
        if (Array.isArray(args.reference_image_paths)) image.referenceImagePaths = args.reference_image_paths;
        if (Array.isArray(args.referenceImagePaths)) image.referenceImagePaths = args.referenceImagePaths;
        return image;
      }
      case "TodoWrite":
      case "TaskCreate":
      case "TaskUpdate":
      case "TaskList":
      case "TaskGet":
        return undefined;
      case "Task":
      case "Subagent":
        return undefined;
      case "CallMcpTool":
        return {
          name: stringArg(args.name),
          toolCallId,
          args: mcpValueMap(args.args),
          providerIdentifier: stringArg(args.providerIdentifier || args.provider),
          toolName: stringArg(args.toolName || args.tool_name),
        };
      case "ListMcpResources":
        return {
          ...(args.server ? { server: stringArg(args.server) } : {}),
        };
      case "FetchMcpResource":
        return {
          server: stringArg(args.server),
          uri: stringArg(args.uri),
          downloadPath: stringArg(args.downloadPath),
        };
      case "mcp_auth":
        return mcpAuthArgs(args, toolCallId);
      case "AskQuestion":
        return normalizeAskQuestionArgs(args);
      case "SwitchMode":
        return {
          targetModeId: stringArg(args.target_mode_id || args.targetModeId),
          explanation: stringArg(args.explanation, ""),
        };
      case "CreatePlan":
        return normalizeCreatePlanQueryArgs(args);
      default:
        return args;
    }
  }

  function stringArg(value, fallback) {
    return typeof value === "string" ? value : fallback || "";
  }

  function mcpAuthArgs(args, toolCallId) {
    return {
      serverIdentifier: stringArg(args.server_identifier ?? args.serverIdentifier),
      toolCallId: stringArg(args.tool_call_id ?? args.toolCallId, toolCallId),
    };
  }

  function applyPatchText(args) {
    if (typeof args === "string") return args;
    return stringArg(args.patch);
  }

  function parseApplyPatch(patchText) {
    var normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var header = normalized.match(/^\*\*\* Begin Patch\n\*\*\* (Add|Update|Delete) File: ([^\n]+)\n/);
    if (!header || header[1] === "Delete") return null;
    var path = header[2].trim();
    if (!path) return null;
    var streamContent = normalized
      .replace(/^\*\*\* Begin Patch\n/, "")
      .replace(/^\*\*\* (?:Add|Update|Delete) File:.*\n/, "")
      .replace(/\*\*\* End Patch\s*$/, "")
      .trim();
    return {
      path,
      patchText,
      streamContent: streamContent + "\n*** End Patch\n",
    };
  }

  function arrayArg(value) {
    return Array.isArray(value) ? value : [];
  }

  function lsPathArg(args) {
    return String(args.path || args.target_directory || args.targetDirectory || "");
  }

  function ignoreGlobsArg(args) {
    return arrayArg(args.ignore || args.ignore_globs || args.ignoreGlobs);
  }

  function shellIdArg(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
    return value;
  }

  function awaitTaskIdArg(args) {
    return String(args.task_id ?? args.shell_id ?? args.shellId ?? args.taskId ?? "").trim();
  }

  function shellArgs(args, toolCallId) {
    var command = stringArg(args.command);
    var parts = command.trim().split(/\s+/).filter(Boolean);
    var executable = parts[0] || "";
    var commandArgs = parts.slice(1).map(function (value) {
      return { type: "word", value };
    });
    var timeout = normalizeInteger(args.timeout ?? args.block_until_ms ?? args.blockUntilMs);
    var hardTimeout = normalizeInteger(args.hardTimeout);
    return {
      command,
      workingDirectory: stringArg(args.working_directory ?? args.workingDirectory ?? args.cwd),
      timeout: timeout !== undefined ? timeout : 30000,
      toolCallId,
      description: stringArg(args.description),
      simpleCommands: executable ? [executable] : [],
      parsingResult: executable
        ? { executableCommands: [{ name: executable, args: commandArgs, fullText: command }] }
        : undefined,
      fileOutputThresholdBytes: 20000,
      timeoutBehavior: 2,
      hardTimeout: hardTimeout !== undefined ? hardTimeout : 86400000,
    };
  }

  function writeArgs(name, args, toolCallId) {
    var path = pathArg(args);
    if (name === "Write") {
      var contents = writeContentArg(args);
      return {
        path,
        fileText: contents,
        encodingHint: "utf8",
        toolCallId,
      };
    }
    return null;
  }

  function normalizeToolArgs(name, args, toolCallId) {
    switch (name) {
      case "Shell":
        return { case: "shellStreamArgs", value: shellArgs(args, toolCallId) };
      case "Delete":
        return {
          case: "deleteArgs",
          value: {
            path: pathArg(args),
            toolCallId,
          },
        };
      case "Write":
        return { case: "writeArgs", value: writeArgs(name, args, toolCallId) };
      case "Read":
      case "ReadFile": {
        var offset = normalizeInteger(args.offset);
        var limit = normalizeInteger(args.limit);
        return {
          case: "readArgs",
          value: {
            path: String(args.path || args.filePath || args.file_path || ""),
            toolCallId,
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(args.encodingHint ? { encodingHint: String(args.encodingHint) } : {}),
          },
        };
      }
      case "Glob": {
        return {
          case: "grepArgs",
          value: {
            path: String(args.target_directory || args.targetDirectory || args.path || ""),
            glob: String(args.glob_pattern || args.globPattern || args.pattern || ""),
            outputMode: "files_with_matches",
            toolCallId,
            pattern: "",
          },
        };
      }
      case "LS": {
        var ls = {
          path: lsPathArg(args),
          toolCallId,
        };
        var ignore = ignoreGlobsArg(args);
        if (ignore.length) ls.ignore = ignore;
        var lsTimeout = normalizeInteger(args.timeout_ms ?? args.timeoutMs);
        if (lsTimeout !== undefined) ls.timeoutMs = lsTimeout;
        return { case: "lsArgs", value: ls };
      }
      case "WebFetch":
      case "WebSearch":
      case "GenerateImage":
        return null;
      case "WriteShellStdin":
        return {
          case: "writeShellStdinArgs",
          value: {
            shellId: shellIdArg(args.shell_id ?? args.shellId),
            chars: String(args.chars || ""),
          },
        };
      case "AwaitShell": {
        var taskId = awaitTaskIdArg(args);
        if (!taskId) return null;
        var awaitValue = {
          agentId: taskId,
        };
        var timeoutMs = normalizeInteger(args.block_until_ms ?? args.blockUntilMs);
        if (timeoutMs !== undefined) awaitValue.timeoutMs = timeoutMs;
        return { case: "subagentAwaitArgs", value: awaitValue };
      }
      case "Grep": {
        var grep = {
          pattern: String(args.pattern || ""),
          toolCallId,
        };
        if (args.path !== undefined) grep.path = String(args.path);
        if (args.glob !== undefined) grep.glob = String(args.glob);
        if (args.output_mode !== undefined) grep.outputMode = String(args.output_mode);
        if (args.outputMode !== undefined) grep.outputMode = String(args.outputMode);
        var contextBefore = normalizeInteger(args["-B"] ?? args.context_before ?? args.contextBefore);
        var contextAfter = normalizeInteger(args["-A"] ?? args.context_after ?? args.contextAfter);
        var context = normalizeInteger(args["-C"] ?? args.context);
        var headLimit = normalizeInteger(args.head_limit ?? args.headLimit);
        var grepOffset = normalizeInteger(args.offset);
        if (contextBefore !== undefined) grep.contextBefore = contextBefore;
        if (contextAfter !== undefined) grep.contextAfter = contextAfter;
        if (context !== undefined) grep.context = context;
        if (args["-i"] !== undefined) grep.caseInsensitive = !!args["-i"];
        if (args.case_insensitive !== undefined) grep.caseInsensitive = !!args.case_insensitive;
        if (args.caseInsensitive !== undefined) grep.caseInsensitive = !!args.caseInsensitive;
        if (args.type !== undefined) grep.type = String(args.type);
        if (headLimit !== undefined) grep.headLimit = headLimit;
        if (args.multiline !== undefined) grep.multiline = !!args.multiline;
        if (args.sort !== undefined) grep.sort = String(args.sort);
        if (args.sort_ascending !== undefined) grep.sortAscending = !!args.sort_ascending;
        if (args.sortAscending !== undefined) grep.sortAscending = !!args.sortAscending;
        if (grepOffset !== undefined) grep.offset = grepOffset;
        return { case: "grepArgs", value: grep };
      }
      case "ReadLints": {
        var paths = arrayArg(args.paths);
        return {
          case: "diagnosticsArgs",
          value: {
            path: String(args.path || paths[0] || ""),
            toolCallId,
          },
        };
      }
      case "ListMcpResources":
        return {
          case: "listMcpResourcesExecArgs",
          value: {
            ...(args.server ? { server: args.server } : {}),
            toolCallId,
          },
        };
      case "FetchMcpResource":
        return {
          case: "readMcpResourceExecArgs",
          value: {
            server: args.server || "",
            uri: args.uri || "",
            downloadPath: args.downloadPath || "",
            toolCallId,
          },
        };
      case "CallMcpTool":
        return {
          case: "mcpArgs",
          value: {
            name: args.name || "",
            args: mcpValueMap(args.args),
            toolCallId,
            providerIdentifier: args.providerIdentifier || args.provider || "",
            toolName: args.toolName || args.tool_name || "",
          },
        };
      default:
        return null;
    }
  }

  function mcpValueMap(value) {
    var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    var out = {};
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = mcpValue(source[key]);
    }
    return out;
  }

  function mcpValue(value) {
    if (value === null || value === undefined) {
      return { kind: { case: "nullValue", value: "NULL_VALUE" } };
    }
    if (typeof value === "string") {
      return { kind: { case: "stringValue", value } };
    }
    if (typeof value === "number") {
      return { kind: { case: "numberValue", value: Number.isFinite(value) ? value : 0 } };
    }
    if (typeof value === "boolean") {
      return { kind: { case: "boolValue", value } };
    }
    if (Array.isArray(value)) {
      return { kind: { case: "listValue", value: { values: value.map(mcpValue) } } };
    }
    if (typeof value === "object") {
      return { kind: { case: "structValue", value: { fields: mcpValueMap(value) } } };
    }
    return { kind: { case: "stringValue", value: String(value) } };
  }

  function editBridgePlan(name, args) {
    var path = "";
    if (name === "Edit") {
      path = pathArg(args);
      return path ? { name, path, startedArgs: { path, streamContent: newStringArg(args) } } : null;
    }
    if (name === "ApplyPatch") {
      var patchText = applyPatchText(args);
      var parsed = parseFullApplyPatch(patchText);
      if (!parsed || !parsed.path) return null;
      return { name, path: parsed.path, startedArgs: { path: parsed.path } };
    }
    if (name === "EditNotebook") {
      path = pathArg(args);
      return path ? { name, path, startedArgs: { path, streamContent: newStringArg(args) } } : null;
    }
    return null;
  }

  async function waitForToolResult(requestId, toolCallId, toolName, toolArguments, options) {
    var body = { requestId, toolCallId, toolName, toolArguments };
    if (options && options.directOnly) body.directOnly = true;
    if (options && options.allowLargeRead) body.allowLargeRead = true;
    var response = await fetchByokPath("/byok/tool-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options && options.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    var json = await response.json();
    return json && json.result;
  }

  var DEFAULT_NATIVE_TOOL_COMPLETION_TIMEOUT_MS = 30000;
  var LONG_NATIVE_TOOL_COMPLETION_TIMEOUT_MS = 300000;
  var CANCELLED_NATIVE_TOOL_COMPLETION_GRACE_MS = 500;

  function nativeToolCompletionTimeoutMs(event) {
    if (!event || event.name !== "Shell") return DEFAULT_NATIVE_TOOL_COMPLETION_TIMEOUT_MS;
    var args = parseToolArguments(event.arguments);
    var requested = normalizeInteger(args.block_until_ms ?? args.blockUntilMs ?? args.timeout);
    if (requested === undefined || requested < 0) return DEFAULT_NATIVE_TOOL_COMPLETION_TIMEOUT_MS;
    return Math.min(
      Math.max(requested + 5000, DEFAULT_NATIVE_TOOL_COMPLETION_TIMEOUT_MS),
      LONG_NATIVE_TOOL_COMPLETION_TIMEOUT_MS,
    );
  }

  function resultMessageCaseForToolName(toolName) {
    switch (toolName) {
      case "Shell":
        return "shellResult";
      case "Write":
        return "writeResult";
      case "Edit":
      case "ApplyPatch":
      case "EditNotebook":
        return "editResult";
      case "Delete":
        return "deleteResult";
      case "Grep":
      case "Glob":
        return "grepResult";
      case "Read":
      case "ReadFile":
        return "readResult";
      case "ReadLints":
        return "diagnosticsResult";
      case "CallMcpTool":
        return "mcpResult";
      case "ListMcpResources":
        return "listMcpResourcesExecResult";
      case "FetchMcpResource":
        return "readMcpResourceExecResult";
      case "mcp_auth":
        return "mcpAuthResult";
      case "WebFetch":
        return "fetchResult";
      case "LS":
        return "lsResult";
      case "WriteShellStdin":
        return "writeShellStdinResult";
      case "AwaitShell":
        return "subagentAwaitResult";
      case "TodoWrite":
      case "TaskCreate":
      case "TaskUpdate":
      case "TaskList":
      case "TaskGet":
        return "todoWriteResult";
      default:
        return "requestContextResult";
    }
  }

  function isDirectReadTool(name) {
    return name === "Read" || name === "ReadFile";
  }

  async function directToolResultForEvent(requestId, event, signal) {
    if (!event || event.type !== "tool_use_done" || !isDirectReadTool(event.name)) return null;
    try {
      var result = await waitForToolResult(requestId, event.id, event.name, parseToolArguments(event.arguments), {
        directOnly: true,
        signal: signal,
      });
      if (result && result.message && result.message.case === resultMessageCaseForToolName(event.name)) return result;
    } catch {}
    return null;
  }

  function readResultUsableForEdit(result) {
    if (!result || !result.message || result.message.case !== "readResult") return false;
    var readResult = result.message.value && result.message.value.result;
    if (!readResult || typeof readResult.case !== "string") return false;
    if (readResult.case === "fileNotFound") return true;
    if (readResult.case !== "success") return false;
    var value = readResult.value || {};
    var output = value.output || {};
    return output.case === "content" || typeof output.content === "string" || typeof value.content === "string";
  }

  function nativeToolTimeoutResult(toolName, toolCallId) {
    return {
      execId: toolCallId,
      message: {
        case: resultMessageCaseForToolName(toolName),
        value: {
          result: {
            case: "error",
            value: {
              error: "Timed out waiting for Cursor " + String(toolName || "tool") + " result " + String(toolCallId || ""),
            },
          },
        },
      },
    };
  }

  async function* editBridgeMessages(requestId, event, stepId, execIdStart, state, signal) {
    var args = parseToolArguments(event.arguments);
    var plan = editBridgePlan(event.name, args);
    var modelCallId = "model-" + stepId;
    var nextExecId = execIdStart;
    yield toolCallStarted(event, modelCallId);
    if (!plan) {
      var invalid = editErrorResult("", "Invalid " + event.name + " arguments");
      yield toolCallCompleted(event, modelCallId, invalid);
      postLocalToolResult(requestId, event.id, event.id, "editResult", invalid);
      return execIdStart;
    }
    var readId = nextExecId;
    var readToolCallId = event.id + "-read";
    var readArgsValue = {
      path: plan.path,
      toolCallId: readToolCallId,
    };
    var directRead = null;
    try {
      directRead = await waitForToolResult(requestId, readToolCallId, "Read", { path: plan.path }, {
        directOnly: true,
        allowLargeRead: true,
        signal: signal,
      });
    } catch {}
    if (!readResultUsableForEdit(directRead)) {
      nextExecId += 1;
      mapNativeExecResult(state, readId, readToolCallId, readToolCallId);
      registerNativeExecAlias(requestId, readId, readToolCallId, readToolCallId);
      yield execServerMessageFromParts(readId, readToolCallId, "readArgs", readArgsValue);
    }
    var editResult;
    try {
      var readResult = directRead && readResultUsableForEdit(directRead)
        ? directRead
        : await waitForToolResult(requestId, readToolCallId, "Read", { path: plan.path }, { signal: signal });
      var beforeRead = readContentFromExecResult(readResult);
      var applied;
      if (event.name === "Edit") applied = applyStringEdit(plan.path, beforeRead.content || "", args);
      else if (event.name === "ApplyPatch") applied = applyPatchEdit(plan.path, beforeRead, args);
      else applied = applyNotebookEdit(plan.path, beforeRead.content || "", args);
      var writeId = nextExecId;
      nextExecId += 1;
      var writeBridgeCallId = event.id + "-write";
      mapNativeExecResult(state, writeId, writeBridgeCallId, writeBridgeCallId);
      registerNativeExecAlias(requestId, writeId, writeBridgeCallId, writeBridgeCallId);
      var writeArgsValue = {
        path: plan.path,
        fileText: applied.fileText,
        toolCallId: writeBridgeCallId,
      };
      if (event.name === "EditNotebook") {
        writeArgsValue.returnFileContentAfterWrite = true;
        writeArgsValue.fileBytes = new Uint8Array(0);
      }
      yield execServerMessageFromParts(writeId, writeBridgeCallId, "writeArgs", writeArgsValue);
      var writeResult = await waitForToolResult(requestId, writeBridgeCallId, "Write", writeArgsValue, { signal: signal });
      var writeError = writeErrorFromExecResult(writeResult);
      if (writeError) throw new Error(writeError);
      editResult = editSuccessResult(plan.path, applied.beforeContent, applied.fileText, applied.message);
      yield toolCallCompleted(event, modelCallId, editResult);
      postLocalToolResult(requestId, event.id, event.id, "editResult", editResult);
      return nextExecId;
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return nextExecId;
      editResult = editErrorResult(plan.path, error && error.message);
      yield toolCallCompleted(event, modelCallId, editResult);
      postLocalToolResult(requestId, event.id, event.id, "editResult", editResult);
      return nextExecId;
    }
  }

  async function* interactionBridgeMessages(requestId, event, stepId, state, signal) {
    var modelCallId = "model-" + stepId;
    var args = parseToolArguments(event.arguments);
    yield toolCallStarted(event, modelCallId);
    var queryId = nextInteractionQueryId(state);
    yield interactionQueryEnvelope(buildInteractionQuery(event.name, event.id, args, queryId));
    var interactionResponse;
    try {
      interactionResponse = await waitForInteractionResult(requestId, queryId, event.name, args, event.id, signal);
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return;
      throw error;
    }
    var completedValue = toolResultFromInteractionResponse(event.name, interactionResponse, args);
    yield toolCallCompleted(event, modelCallId, completedValue);
    postLocalToolResult(requestId, event.id, event.id, "byokInteractionToolResult", {
      toolName: event.name,
      toolArguments: args,
      interactionResponse: interactionResponse,
      toolResult: completedValue,
    });
  }

  async function* mcpBridgeMessages(requestId, event, stepId, execId, state, signal) {
    var modelCallId = "model-" + stepId;
    yield toolCallStarted(event, modelCallId);
    var exec = execServerMessage(event, execId);
    if (!exec) {
      var unsupported = unsupportedLocalResult();
      yield toolCallCompleted(event, modelCallId, unsupported);
      postLocalToolResult(requestId, event.id, event.id, "unsupportedToolResult", unsupported);
      return;
    }
    if (state) mapNativeExecResult(state, execId, event.id, event.id);
    registerNativeExecAlias(requestId, execId, event.id, event.id);
    yield exec;
    var result;
    try {
      result = await waitForToolResult(requestId, event.id, event.name, parseToolArguments(event.arguments), { signal: signal });
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return;
      throw error;
    }
    var completedValue = result && result.message && result.message.value;
    if (!completedValue) completedValue = unsupportedLocalResult();
    else completedValue = normalizeResultEnvelope(result.message.case, completedValue);
    yield toolCallCompleted(event, modelCallId, completedValue);
    postLocalToolResult(requestId, event.id, event.id, result?.message?.case || "mcpResult", completedValue);
  }

  function completedValueFromExecResult(result) {
    var message = result && result.message;
    if (!message || !message.case || message.value === undefined) return unsupportedLocalResult();
    return normalizeResultEnvelope(message.case, message.value);
  }

  function nativeReadCompletedValue(value) {
    if (!value || !value.result || value.result.case !== "success" || !value.result.value) return value;
    var readSuccess = value.result.value;
    var nativeValue = {};
    var keys = ["path", "output", "totalLines", "fileSize", "truncated", "outputBlobId", "rangeApplied"];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (readSuccess[key] !== undefined) nativeValue[key] = readSuccess[key];
    }
    return {
      result: {
        case: "success",
        value: nativeValue,
      },
    };
  }

  function directReadUiCompletedValue(result) {
    return nativeReadCompletedValue(completedValueFromExecResult(result));
  }

  function completedValueForLocalResult(event, localResult) {
    if (!localResult) return unsupportedLocalResult();
    if (localResult.case === "todoWriteResult" && localResult.value && localResult.value.uiResult) {
      return localResult.value.uiResult;
    }
    if (localResult.case !== "byokExecResult") return localResult.value;
    var completedValue = completedValueFromExecResult(localResult.value);
    if (event && (event.name === "Read" || event.name === "ReadFile")) {
      return nativeReadCompletedValue(completedValue);
    }
    return completedValue;
  }

  function providerLocalResultValue(localResult) {
    if (!localResult) return null;
    if (localResult.case === "todoWriteResult" && localResult.value && localResult.value.providerResult) {
      return localResult.value.providerResult;
    }
    return localResult.value;
  }

  function nativeToolCompletionEntry(event, stepId, state) {
    var toolCallId = String(event && event.id || "");
    var completionsByToolCallId = state && typeof state === "object"
      ? (state.nativeToolCompletionsByToolCallId || (state.nativeToolCompletionsByToolCallId = {}))
      : null;
    if (state && event && event.name === "Shell" && toolCallId) {
      var shellArgsByToolCallId = state.shellArgsByToolCallId || (state.shellArgsByToolCallId = {});
      shellArgsByToolCallId[toolCallId] = parseToolArguments(event.arguments);
    }
    var entry = {
      ready: false,
      settled: false,
      completion: null,
      promise: null,
      resolve: null,
      timer: null,
      discard: null,
    };
    function cleanup() {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (completionsByToolCallId && toolCallId && completionsByToolCallId[toolCallId] === entry) {
        delete completionsByToolCallId[toolCallId];
      }
    }
    function finish(result) {
      if (entry.settled) return entry.completion;
      entry.settled = true;
      cleanup();
      entry.completion = {
        event: event,
        message: toolCallCompleted(event, "model-" + stepId, completedValueFromExecResult(result)),
      };
      return entry.completion;
    }
    entry.discard = function () {
      if (entry.settled) return;
      entry.settled = true;
      cleanup();
      entry.completion = null;
    };
    entry.promise = new Promise(function (resolve) {
      entry.resolve = function (result) {
        resolve(finish(result));
      };
      entry.timer = setTimeout(function () {
        resolve(finish(nativeToolTimeoutResult(event && event.name, toolCallId)));
      }, nativeToolCompletionTimeoutMs(event));
    });
    if (completionsByToolCallId && toolCallId) completionsByToolCallId[toolCallId] = entry;
    return entry;
  }

  function resolveNativeToolCompletion(state, toolCallId, result) {
    var completionsByToolCallId = state && state.nativeToolCompletionsByToolCallId;
    if (!completionsByToolCallId || !toolCallId) return;
    var entry = completionsByToolCallId[String(toolCallId)];
    if (!entry || typeof entry.resolve !== "function") return;
    entry.resolve(result);
  }

  async function nextPendingNativeToolCompletion(pending) {
    var ready = [];
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].ready) ready.push(pending[i]);
    }
    if (!ready.length) return null;
    return await Promise.race(ready.map(function (entry) {
      return entry.promise.then(function () { return entry; });
    }));
  }

  function hasReadyNativeToolCompletion(pending) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].ready) return true;
    }
    return false;
  }

  function removePendingNativeToolCompletion(pending, entry) {
    var index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
  }

  async function waitForNativeToolCompletion(entry, maxWaitMs) {
    if (!entry) return null;
    if (entry.settled) return entry.completion;
    if (!(Number.isInteger(maxWaitMs) && maxWaitMs >= 0)) {
      await entry.promise;
      return entry.completion;
    }
    var timer = null;
    var timedOut = false;
    await Promise.race([
      entry.promise,
      new Promise(function (resolve) {
        timer = setTimeout(function () {
          timedOut = true;
          resolve(null);
        }, maxWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut && !entry.settled) return null;
    return entry.completion;
  }

  function discardPendingNativeToolCompletion(entry) {
    if (!entry || typeof entry.discard !== "function") return;
    entry.discard();
  }

  async function* emitReadyNativeToolCompletions(pending, options) {
    var maxWaitMs = options && Number.isInteger(options.maxWaitMs) && options.maxWaitMs >= 0
      ? options.maxWaitMs
      : undefined;
    while (pending.length && pending[0].ready) {
      var entry = pending[0];
      pending.shift();
      var completion = await waitForNativeToolCompletion(entry, maxWaitMs);
      if (!completion) {
        discardPendingNativeToolCompletion(entry);
        continue;
      }
      yield completion.message;
    }
  }

  async function* clientInteractionBridgeMessages(requestId, event, stepId, state, signal) {
    var modelCallId = "model-" + stepId;
    var args = parseToolArguments(event.arguments);
    yield toolCallStarted(event, modelCallId);
    var queryId = nextInteractionQueryId(state);
    yield interactionQueryEnvelope(buildClientInteractionQuery(event.name, event.id, args, queryId));
    var interactionResponse;
    try {
      interactionResponse = await waitForInteractionResult(requestId, queryId, event.name, args, undefined, signal);
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return;
      throw error;
    }
    if (interactionApprovalRejected(interactionResponse)) {
      var rejectedValue = toolResultFromClientCompletion(event.name, {
        case: "rejected",
        value: { reason: "User rejected the request" },
      });
      yield toolCallCompleted(event, modelCallId, rejectedValue);
      postLocalToolResult(requestId, event.id, event.id, "byokInteractionToolResult", {
        toolName: event.name,
        toolArguments: args,
        interactionResponse: interactionResponse,
        toolResult: rejectedValue,
      });
      return;
    }
    if (!interactionApprovalGranted(interactionResponse)) {
      var approvalError = toolResultFromClientCompletion(event.name, {
        case: "error",
        value: { error: "Cursor did not approve the client tool request" },
      });
      yield toolCallCompleted(event, modelCallId, approvalError);
      postLocalToolResult(requestId, event.id, event.id, "byokInteractionToolResult", {
        toolName: event.name,
        toolArguments: args,
        interactionResponse: interactionResponse,
        toolResult: approvalError,
      });
      return;
    }
    var clientCompletion;
    try {
      clientCompletion = await waitForClientToolCompletion(requestId, event.id, event.name, args, signal);
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return;
      throw error;
    }
    var completedValue = toolResultFromClientCompletion(event.name, clientCompletion);
    yield toolCallCompleted(event, modelCallId, completedValue);
    postLocalToolResult(requestId, event.id, event.id, "byokInteractionToolResult", {
      toolName: event.name,
      toolArguments: args,
      interactionResponse: interactionResponse,
      clientCompletion: clientCompletion,
      toolResult: completedValue,
    });
  }

  async function waitForClientToolCompletion(requestId, toolCallId, toolName, toolArguments, signal) {
    var response = await fetchByokPath("/byok/client-tool-completion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        requestId: requestId,
        toolCallId: toolCallId,
        toolName: toolName,
        toolArguments: toolArguments,
      }),
    });
    var json = await response.json();
    return json && json.completion;
  }

  async function* mcpAuthBridgeMessages(requestId, event, stepId, state, signal) {
    var modelCallId = "model-" + stepId;
    var args = parseToolArguments(event.arguments);
    var authArgs = mcpAuthArgs(args, event.id);
    yield toolCallStarted(event, modelCallId);
    var queryId = nextInteractionQueryId(state);
    yield interactionQueryMessage(queryId, "mcpAuthRequestQuery", { args: authArgs });
    var response;
    try {
      response = await waitForInteractionResponse(requestId, queryId, "mcp_auth", authArgs, signal);
    } catch (error) {
      if ((signal && signal.aborted) || isAbortError(error)) return;
      throw error;
    }
    var result = mcpAuthToolResult(response, authArgs);
    yield toolCallCompleted(event, modelCallId, result);
    postLocalToolResult(requestId, event.id, event.id, "mcpAuthResult", result);
  }

  async function waitForInteractionResponse(requestId, queryId, toolName, toolArguments, signal) {
    var response = await fetchByokPath("/byok/interaction-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ requestId, queryId, toolName, toolArguments }),
    });
    var json = await response.json();
    return json && json.result;
  }

  function mcpAuthToolResult(response, args) {
    var result = response && response.result;
    var authResponse = result && result.case === "mcpAuthRequestResponse" ? result.value && result.value.result : null;
    if (authResponse && authResponse.case === "approved") {
      return {
        result: {
          case: "success",
          value: { serverIdentifier: args.serverIdentifier },
        },
      };
    }
    if (authResponse && authResponse.case === "rejected") {
      return {
        result: {
          case: "rejected",
          value: { reason: stringArg(authResponse.value && authResponse.value.reason) },
        },
      };
    }
    return {
      result: {
        case: "error",
        value: { error: "MCP authentication did not return a Cursor interaction response." },
      },
    };
  }

  function postLocalToolResult(requestId, toolCallId, execId, messageCase, value) {
    postJson("/byok/local-tool-result", {
      requestId,
      toolCallId,
      result: {
        execId,
        message: {
          case: messageCase,
          value,
        },
      },
    });
  }

  function eventToCursorMessages(event, stepId, startedAt, execId, localResult, contextTokenLimit, request) {
    switch (event.type) {
      case "text_delta":
        return [textDelta(event.text || "")];
      case "thinking_delta":
        return [thinkingDelta(event.text || "")];
      case "thinking_done":
        return [thinkingDone()];
      case "tool_use_start":
        return [];
      case "tool_use_delta":
        return [tokenDelta(1)];
      case "tool_use_done":
        var started = toolCallStarted(event, "model-" + stepId);
        if (localResult) {
          return [started, toolCallCompleted(event, "model-" + stepId, completedValueForLocalResult(event, localResult))];
        }
        var exec = execServerMessage(event, execId);
        if (exec) return [started, exec];
        return [started, toolCallCompleted(event, "model-" + stepId, unsupportedLocalResult())];
      case "done":
        if (event.stopReason === "cancelled") return [turnEnded(event)];
        var checkpoint = conversationCheckpointTokenUpdateForEvent(event, contextTokenLimit, request);
        if (event.stopReason === "tool_use") {
          return checkpoint
            ? [stepCompleted(stepId, startedAt), checkpoint]
            : [stepCompleted(stepId, startedAt)];
        }
        return checkpoint
          ? [stepCompleted(stepId, startedAt), checkpoint, turnEnded(event)]
          : [stepCompleted(stepId, startedAt), turnEnded(event)];
      default:
        return [];
    }
  }

  function shouldExpectNativeExecResult(event) {
    return event.type === "tool_use_done" &&
      event.name !== "mcp_auth" &&
      !isInteractionBridgeTool(event.name) &&
      !isClientInteractionTool(event.name) &&
      !!normalizeToolArgs(event.name, parseToolArguments(event.arguments), event.id);
  }

  function isMcpBridgeTool(name) {
    return name === "CallMcpTool" || name === "ListMcpResources" || name === "FetchMcpResource";
  }

  function isMcpAuthTool(name) {
    return name === "mcp_auth";
  }

  globalThis.__cursorByokWrapTransport = function wrapTransport(transport, serviceName) {
    return {
      unary: async function (service, method, signal, timeoutMs, headers, input, contextValues) {
        headers = injectWindowId(headers);
        if (service.typeName === "aiserver.v1.AiService" && method.name === "AvailableModels") {
          var availableModelsResult = await transport.unary(service, method, signal, timeoutMs, headers, input, contextValues);
          return await mergeAvailableModelsResult(availableModelsResult, method.O);
        }
        if (service.typeName === "aiserver.v1.BidiService" && method.name === "BidiAppend") {
          var bidiJson = toJson(input) || {};
          var byokBidi = await postJson("/byok/bidi", {
            requestId: findRequestId(bidiJson),
            json: bidiJson,
          });
          if (byokBidi && byokBidi.handle) {
            return fromJson(method.O, {});
          }
        }
        return transport.unary(service, method, signal, timeoutMs, headers, input, contextValues);
      },
      stream: async function (service, method, signal, timeoutMs, headers, input, contextValues) {
        headers = injectWindowId(headers);
        if (service.typeName === "agent.v1.AgentService" && method.name === "RunSSE") {
          captured.messageCtor = method.O;
          var peeked = await peekAsyncIterable(input);
          var runRequest = extractAgentRunRequest(peeked.first);
          var requestId = requestIdFromHeaders(headers) || findRequestId(runRequest) || findRequestId(peeked.first);
          var originalRequestId = originalRequestIdForRun(headers, runRequest) || originalRequestIdForRun(headers, peeked.first);
          runRequest = attachComposerMode(requestId, runRequest, originalRequestId);
          runRequest = attachConversationContext(requestId, runRequest);
          pushByokDebug("wrap-transport:run-sse", {
            serviceName: serviceName,
            requestId: requestId,
            originalRequestId: originalRequestId,
            firstFrameCase: extractAgentClientMessage(peeked.first)?.case || "",
            summary: summarizeRunRequestForDebug(runRequest),
          });
          if (await shouldHandleByokRun(requestId, runRequest)) {
            var state = { execIdToToolCallId: {}, interactionQuerySeq: 100000 };
            drainRunInput(requestId, peeked.input, state);
            return {
              header: new Headers(),
              trailer: new Headers(),
              message: byokRunMessages(requestId, runRequest, state, signal),
            };
          }
          input = peeked.input;
        }
        if (service.typeName === "agent.v1.AgentService" && method.name === "Run") {
          captured.messageCtor = method.O;
          var runPeeked = await peekUntilRunRequest(input, 8);
          var bidiRunRequest = extractAgentRunRequest(runPeeked.runRequestFrame);
          var runRequestId = requestIdFromHeaders(headers) || findRequestId(bidiRunRequest) || findRequestId(runPeeked.runRequestFrame) || findRequestId(runPeeked.first);
          var bidiOriginalRequestId = originalRequestIdForRun(headers, bidiRunRequest) || originalRequestIdForRun(headers, runPeeked.runRequestFrame) || originalRequestIdForRun(headers, runPeeked.first);
          bidiRunRequest = attachComposerMode(runRequestId, bidiRunRequest, bidiOriginalRequestId);
          bidiRunRequest = attachConversationContext(runRequestId, bidiRunRequest);
          pushByokDebug("wrap-transport:run", {
            serviceName: serviceName,
            requestId: runRequestId,
            originalRequestId: bidiOriginalRequestId,
            firstFrameCase: extractAgentClientMessage(runPeeked.first)?.case || "",
            runRequestFrameCase: extractAgentClientMessage(runPeeked.runRequestFrame)?.case || "",
            summary: summarizeRunRequestForDebug(bidiRunRequest),
          });
          if (await shouldHandleByokRun(runRequestId, bidiRunRequest)) {
            var bidiState = { execIdToToolCallId: {}, interactionQuerySeq: 100000 };
            drainRunInput(runRequestId, runPeeked.input, bidiState);
            return {
              header: new Headers(),
              trailer: new Headers(),
              message: byokRunMessages(runRequestId, bidiRunRequest, bidiState, signal),
            };
          }
          input = runPeeked.input;
        }
        return transport.stream(service, method, signal, timeoutMs, headers, input, contextValues);
      },
    };
  };

  globalThis.__cursorByokWrapAgentClient = function wrapAgentClient(client, service) {
    if (!client || typeof client.run !== "function") return client;
    return new Proxy(client, {
      get: function (target, prop, receiver) {
        var value = Reflect.get(target, prop, receiver);
        if (prop !== "run" || typeof value !== "function") return value;
        return async function* (context, input, options) {
          captured.messageCtor = service && service.methods && service.methods.run && service.methods.run.O;
          var headers = options && options.headers;
          var runPeeked = await peekUntilRunRequest(input, 8);
          var runRequest = extractAgentRunRequest(runPeeked.runRequestFrame);
          runRequest = hydrateRunRequestFromOptions(runRequest, options);
          var requestId = requestIdFromHeaders(headers) || findRequestId(runRequest) || findRequestId(runPeeked.runRequestFrame) || findRequestId(runPeeked.first);
          var originalRequestId = originalRequestIdForRun(headers, runRequest) || originalRequestIdForRun(headers, runPeeked.runRequestFrame) || originalRequestIdForRun(headers, runPeeked.first);
          runRequest = attachComposerMode(requestId, runRequest, originalRequestId);
          runRequest = attachConversationContext(requestId, runRequest);
          pushByokDebug("wrap-agent-client:run", {
            requestId: requestId,
            originalRequestId: originalRequestId,
            firstFrameCase: extractAgentClientMessage(runPeeked.first)?.case || "",
            runRequestFrameCase: extractAgentClientMessage(runPeeked.runRequestFrame)?.case || "",
            optionKeys: options && typeof options === "object" ? Object.keys(toJson(options) || options).slice(0, 20) : [],
            optionModelOverride: options && typeof options.modelOverride === "string" ? options.modelOverride : "",
            optionIsPlanExecution: !!(options && options.isPlanExecution),
            optionActionCase: actionCaseForDebug(options && (options.conversationActionOverride || options.conversationAction)),
            summary: summarizeRunRequestForDebug(runRequest),
          });
          if (await shouldHandleByokRun(requestId, runRequest)) {
            try {
              options && options.onNetworkStarted && options.onNetworkStarted();
            } catch {}
            var state = { execIdToToolCallId: {}, interactionQuerySeq: 100000 };
            drainRunInput(requestId, runPeeked.input, state);
            yield* byokRunMessages(requestId, runRequest, state, options && options.signal);
            return;
          }
          yield* value.call(target, context, runPeeked.input, options);
        };
      },
    });
  };

  async function* byokRunMessages(requestId, request, state, signal) {
    var startedAt = Date.now();
    var stepId = Math.random().toString(36).slice(2, 10);
    var execId = 1;
    request = attachComposerMode(requestId, request);
    request = attachConversationContext(requestId, request);
    var todoScopeId = conversationIdForRequest(request, requestId);
    var pendingNativeToolCompletions = [];
    var assistantText = "";
    var response;
    var contextTokenLimit = await contextTokenLimitForRequest(request);
    try {
      response = await fetchByokPath("/byok/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, request }),
      }, {
        waitForReadyMs: globalThis.__cursorByokHasModelCandidate(requestModelCandidates(request)) ? byokRunReadyWaitMs : 0,
      });
    } catch (error) {
      yield* byokRunFailedMessages(
        stepId,
        startedAt,
        "BYOK request failed: " + (error && error.message ? error.message : String(error)),
        {
          requestId: requestId,
          request: request,
          error: error && error.message ? error.message : String(error),
        },
      );
      return;
    }
    if (!response.ok) {
      yield* byokRunFailedMessages(
        stepId,
        startedAt,
        "BYOK request failed: HTTP " + response.status,
        {
          requestId: requestId,
          request: request,
          status: response.status,
        },
      );
      return;
    }
    var tokenCounter = 0;
    try {
      var iterator = readNdjson(response)[Symbol.asyncIterator]();
      var providerDone = false;
      var providerNext = iterator.next();
      while (!providerDone || pendingNativeToolCompletions.length) {
        var providerRace = providerDone
          ? null
          : providerNext.then(function (result) { return { source: "provider", result: result }; });
        var nativeRace = hasReadyNativeToolCompletion(pendingNativeToolCompletions)
          ? nextPendingNativeToolCompletion(pendingNativeToolCompletions).then(function (entry) {
            return { source: "native", entry: entry };
          })
          : null;
        var raceSet = [];
        if (providerRace) raceSet.push(providerRace);
        if (nativeRace) raceSet.push(nativeRace);
        if (!raceSet.length) break;
        var raced = await Promise.race(raceSet);
        if (raced.source === "native") {
          removePendingNativeToolCompletion(pendingNativeToolCompletions, raced.entry);
          yield raced.entry.completion.message;
          continue;
        }
        var iteration = raced.result;
        providerDone = !!iteration.done;
        if (!providerDone) providerNext = iterator.next();
        if (iteration.done) {
          for (var doneIndex = 0; doneIndex < pendingNativeToolCompletions.length; doneIndex++) {
            pendingNativeToolCompletions[doneIndex].ready = true;
          }
          yield* emitReadyNativeToolCompletions(pendingNativeToolCompletions);
          continue;
        }
        var event = iteration.value;
        if (event.type === "meta") continue;
        if (event.type === "text_delta" && typeof event.text === "string") {
          assistantText += event.text;
        }
        if (event.type === "tool_use_done") {
          var providerLocalResult = eventLocalResult(event);
          if (providerLocalResult) {
            var providerLocalExecId = execId++;
            var providerLocalMessages = eventToCursorMessages(event, stepId, startedAt, providerLocalExecId, providerLocalResult, contextTokenLimit, request);
            for (var providerLocalIndex = 0; providerLocalIndex < providerLocalMessages.length; providerLocalIndex++) {
              yield providerLocalMessages[providerLocalIndex];
            }
            postLocalToolResult(requestId, event.id, event.id, providerLocalResult.case, providerLocalResultValue(providerLocalResult));
            tokenCounter++;
            if (tokenCounter % 5 === 0) yield tokenDelta(5);
            continue;
          }
        }
        if (event.type === "tool_use_done" && editBridgePlan(event.name, parseToolArguments(event.arguments))) {
          var nextExecId = yield* editBridgeMessages(requestId, event, stepId, execId, state, signal);
          execId = nextExecId;
          tokenCounter++;
          if (tokenCounter % 5 === 0) yield tokenDelta(5);
          continue;
        }
        if (event.type === "tool_use_done" && isMcpBridgeTool(event.name)) {
          yield* mcpBridgeMessages(requestId, event, stepId, execId++, state, signal);
          tokenCounter++;
          if (tokenCounter % 5 === 0) yield tokenDelta(5);
          continue;
        }
        if (event.type === "tool_use_done" && isInteractionBridgeTool(event.name)) {
          yield* interactionBridgeMessages(requestId, event, stepId, state, signal);
          tokenCounter++;
          if (tokenCounter % 5 === 0) yield tokenDelta(5);
          continue;
        }
        if (event.type === "tool_use_done" && isClientInteractionTool(event.name)) {
          yield* clientInteractionBridgeMessages(requestId, event, stepId, state, signal);
          tokenCounter++;
          if (tokenCounter % 5 === 0) yield tokenDelta(5);
          continue;
        }
        if (event.type === "tool_use_done" && isMcpAuthTool(event.name)) {
          yield* mcpAuthBridgeMessages(requestId, event, stepId, state, signal);
          tokenCounter++;
          if (tokenCounter % 5 === 0) yield tokenDelta(5);
          continue;
        }
        if (event.type === "tool_use_done" && isDirectReadTool(event.name)) {
          var directToolResult = await directToolResultForEvent(requestId, event, signal);
          if (directToolResult) {
            var directCompletedValue = directReadUiCompletedValue(directToolResult);
            yield toolCallStarted(event, "model-" + stepId);
            yield toolCallCompleted(event, "model-" + stepId, directCompletedValue);
            postLocalToolResult(requestId, event.id, event.id, directToolResult.message.case, completedValueFromExecResult(directToolResult));
            tokenCounter++;
            if (tokenCounter % 5 === 0) yield tokenDelta(5);
            continue;
          }
        }
        var currentExecId = execId++;
        var expectsNativeExecResult = shouldExpectNativeExecResult(event);
        if (state && expectsNativeExecResult) {
          mapNativeExecResult(state, currentExecId, event.id, event.id);
        }
        if (expectsNativeExecResult) {
          registerNativeExecAlias(requestId, currentExecId, event.id, event.id);
        }
        var localResult = null;
        if (event.type === "tool_use_done" && event.name === "AwaitShell" &&
          !normalizeToolArgs(event.name, parseToolArguments(event.arguments), event.id)) {
          localResult = { case: "awaitResult", value: awaitShellLocalResult(event) };
        } else if (event.type === "tool_use_done" && (event.name === "TodoWrite" || event.name === "TaskCreate" || event.name === "TaskUpdate" || event.name === "TaskList" || event.name === "TaskGet")) {
          localResult = { case: "todoWriteResult", value: todoWriteLocalResult(event, todoScopeId) };
        }
        var messages = eventToCursorMessages(event, stepId, startedAt, currentExecId, localResult, contextTokenLimit, request);
        if (expectsNativeExecResult) {
          pendingNativeToolCompletions.push(nativeToolCompletionEntry(event, stepId, state));
        }
        if (event.type === "done") {
          if (event.stopReason === "end_turn") {
            rememberConversationContext(requestId, request, assistantText);
          }
          for (var readyIndex = 0; readyIndex < pendingNativeToolCompletions.length; readyIndex++) {
            pendingNativeToolCompletions[readyIndex].ready = true;
          }
          if (event.stopReason === "cancelled") {
            yield* emitReadyNativeToolCompletions(pendingNativeToolCompletions, {
              maxWaitMs: CANCELLED_NATIVE_TOOL_COMPLETION_GRACE_MS,
            });
            for (var cancelMessageIndex = 0; cancelMessageIndex < messages.length; cancelMessageIndex++) {
              yield messages[cancelMessageIndex];
            }
          } else {
            if (messages.length) yield messages[0];
            yield* emitReadyNativeToolCompletions(pendingNativeToolCompletions);
            for (var doneMessageIndex = 1; doneMessageIndex < messages.length; doneMessageIndex++) {
              yield messages[doneMessageIndex];
            }
          }
        } else {
          for (var i = 0; i < messages.length; i++) yield messages[i];
        }
        if (localResult) {
          postLocalToolResult(requestId, event.id, event.id, localResult.case, providerLocalResultValue(localResult));
        } else if (event.type === "tool_use_done" && !execServerMessage(event, execId - 1)) {
          postLocalToolResult(requestId, event.id, event.id, "unsupportedToolResult", unsupportedLocalResult());
        }
        tokenCounter++;
        if (tokenCounter % 5 === 0) yield tokenDelta(5);
      }
    } catch (error) {
      yield* byokRunFailedMessages(
        stepId,
        startedAt,
        "BYOK request failed: " + (error && error.message ? error.message : String(error)),
        {
          requestId: requestId,
          request: request,
          error: error && error.message ? error.message : String(error),
        },
      );
    }
  }

  function summarizeFailedRunContext(context) {
    var request = context && context.request;
    return {
      requestId: context && context.requestId,
      status: context && context.status,
      error: context && context.error,
      conversationId: conversationIdForRequest(request, context && context.requestId),
      modelCandidates: requestModelCandidates(request),
      hasMessages: !!(request && Array.isArray(request.messages) && request.messages.length),
    };
  }

  function* byokRunFailedMessages(stepId, startedAt, message, context) {
    try {
      console.warn("[Cursor BYOK] local run failed", message, summarizeFailedRunContext(context));
    } catch {}
    yield textDelta(message);
    yield stepCompleted(stepId, startedAt);
    yield turnEnded({ usage: { inputTokens: 0, outputTokens: 0 } });
  }

  if (!globalThis.__cursorByokPatchApplied) {
    globalThis.__cursorByokPatchApplied = true;
    rawFetch = globalThis.fetch;
    globalThis.fetch = async function () {
      var args = Array.prototype.slice.call(arguments);
      var urlArg = args[0];
      var url = typeof urlArg === "string" ? urlArg : urlArg instanceof Request ? urlArg.url : "";
      var init = args[1] || {};
      var fetchRoutes = routes.filter(function (route) {
        return route.charAt(0) === "/";
      });
      for (var i = 0; i < fetchRoutes.length; i++) {
        if (url.indexOf(fetchRoutes[i]) !== -1) {
          var redirectedPath = url.match(/^https?:\/\/[^/]*/)
            ? url.replace(/^https?:\/\/[^/]*/, "")
            : "/";
          return fetchRedirectedRoute(rawFetch, args, urlArg, init, redirectedPath);
        }
      }
      return rawFetch.apply(globalThis, arguments);
    };
  }

  function connectByokEvents(resolvedUrl) {
    try {
      if (globalThis.__cursorByokEvents && typeof globalThis.__cursorByokEvents.close === "function") {
        globalThis.__cursorByokEvents.close();
      }
      var events = new EventSource(eventStreamUrl(resolvedUrl, "/byok/events"));
      globalThis.__cursorByokEvents = events;
      events.addEventListener("routes", function (event) {
        try {
          routes = JSON.parse(event.data);
        } catch {}
      });
      events.addEventListener("models", function (event) {
        try {
          var data = JSON.parse(event.data);
          if (Array.isArray(data)) {
            setByokModelsCache(data, true);
            return;
          }
          if (Array.isArray(data.models)) {
            setByokModelsCache(data.models, true);
            return;
          }
          if (Array.isArray(data.modelIds)) syncByokModelIds(data.modelIds);
        } catch {}
      });
      events.addEventListener("error", function () {
        ensureByokUrl(true).then(function (nextUrl) {
          if (nextUrl && nextUrl !== resolvedUrl) connectByokEvents(nextUrl);
        }).catch(function () {});
      });
      var closeEvents = function () {
        try {
          if (globalThis.__cursorByokEvents === events) globalThis.__cursorByokEvents = null;
          events.close();
        } catch {}
      };
      if (typeof globalThis.addEventListener === "function") {
        globalThis.addEventListener("pagehide", closeEvents, { once: true });
        globalThis.addEventListener("beforeunload", closeEvents, { once: true });
      }
    } catch {}
  }

  connectByokEvents(byokUrl);

  console.log("[Cursor BYOK] hook loaded, redirects=" + routes.length);
}

function createHookRuntimeHelpersForTest(messageCtor) {
  const captured = { messageCtor };
  function fromJson(type, value) {
    if (!type) return value;
    if (typeof type.fromJson === "function") return type.fromJson(value);
    return value;
  }
  function serverMessage(message) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "interactionUpdate",
        value: { message },
      },
    });
  }
  function tokenDelta(tokens) {
    return serverMessage({ case: "tokenDelta", value: { tokens } });
  }
  function interactionQueryMessage(id, queryCase, queryValue) {
    return fromJson(captured.messageCtor, {
      message: {
        case: "interactionQuery",
        value: {
          id,
          query: {
            case: queryCase,
            value: queryValue,
          },
        },
      },
    });
  }
  function toolCallStarted(event, modelCallId) {
    const args = parseToolArgumentsForTest(event.arguments);
    return serverMessage({
      case: "toolCallStarted",
      value: {
        callId: event.id,
        toolCall: toolEnvelopeForTest(event.name, args, undefined, event.id),
        modelCallId,
      },
    });
  }
  function toolCallCompleted(event, modelCallId, result) {
    const args = parseToolArgumentsForTest(event.arguments);
    return serverMessage({
      case: "toolCallCompleted",
      value: {
        callId: event.id,
        toolCall: toolEnvelopeForTest(event.name, args, result, event.id),
        modelCallId,
      },
    });
  }
  function awaitShellLocalResult(event) {
    const args = parseToolArgumentsForTest(event.arguments);
    const taskId = String(args.task_id ?? args.shell_id ?? args.shellId ?? args.taskId ?? "").trim();
    if (!taskId) {
      return {
        result: {
          case: "error",
          value: {
            error: "AwaitShell requires shell_id or task_id from a previous background shell or subagent result.",
          },
        },
      };
    }
    let blockUntilMs = normalizeIntegerForTest(args.block_until_ms ?? args.blockUntilMs);
    if (blockUntilMs === undefined) blockUntilMs = 30000;
    if (blockUntilMs < 0) blockUntilMs = 0;
    if (blockUntilMs > 300000) blockUntilMs = 300000;
    return {
      result: {
        case: "success",
        value: {
          complete: {
            taskId,
            runtimeMs: blockUntilMs,
            outputFilePath: "",
            outputLength: 0,
          },
        },
      },
    };
  }
  function unsupportedLocalResultForTest() {
    return {
      result: {
        case: "error",
        value: { error: "Cursor BYOK cannot execute this tool through native exec." },
      },
    };
  }
  function eventLocalResultForTest(event) {
    var local = event && event.localResult;
    if (!local || !local.case || local.value === undefined) return null;
    switch (local.case) {
      case "byokExecResult":
      case "unsupportedToolResult":
      case "requestContextResult":
      case "todoWriteResult":
      case "awaitResult":
      case "subagentAwaitResult":
        return { case: local.case, value: local.value };
      default:
        return null;
    }
  }

  function completedValueFromExecResultForTest(result) {
    var message = result && result.message;
    if (!message || !message.case || message.value === undefined) return unsupportedLocalResultForTest();
    return normalizeResultEnvelopeForTest(message.case, message.value);
  }

  function nativeReadCompletedValueForTest(value) {
    if (!value || !value.result || value.result.case !== "success" || !value.result.value) return value;
    var readSuccess = value.result.value;
    var nativeValue = {};
    var keys = ["path", "output", "totalLines", "fileSize", "truncated", "outputBlobId", "rangeApplied"];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (readSuccess[key] !== undefined) nativeValue[key] = readSuccess[key];
    }
    return {
      result: {
        case: "success",
        value: nativeValue,
      },
    };
  }

  function completedValueForLocalResultForTest(event, localResult) {
    if (!localResult) return unsupportedLocalResultForTest();
    if (localResult.case === "todoWriteResult" && localResult.value && localResult.value.uiResult) {
      return localResult.value.uiResult;
    }
    if (localResult.case !== "byokExecResult") return localResult.value;
    var completedValue = completedValueFromExecResultForTest(localResult.value);
    if (event && (event.name === "Read" || event.name === "ReadFile")) {
      return nativeReadCompletedValueForTest(completedValue);
    }
    return completedValue;
  }
  function cloneTodosForTest(todos) {
    return todos.map(function (todo) {
      var out = {};
      var keys = Object.keys(todo || {});
      for (var i = 0; i < keys.length; i++) out[keys[i]] = todo[keys[i]];
      return out;
    });
  }
  function normalizeTodoItemForTest(value) {
    if (!value || typeof value !== "object") return null;
    var id = stringArgForTest(value.id || value.taskId || value.task_id, "");
    var content = stringArgForTest(value.content || value.subject || value.description, "");
    var status = stringArgForTest(value.status, "");
    if (!id && !content && !status) return null;
    var todo = {};
    if (id) todo.id = id;
    if (content) todo.content = content;
    if (status) todo.status = status;
    return todo;
  }
  function todoUiStatusForTest(status) {
    var normalized = planTodoStatusForTest(status);
    return normalized === undefined ? 0 : normalized;
  }
  function todoUiItemForTest(todo) {
    if (!todo || typeof todo !== "object") return null;
    var out = { status: todoUiStatusForTest(todo.status) };
    if (todo.id !== undefined) out.id = stringArgForTest(todo.id, "");
    if (todo.content !== undefined) out.content = stringArgForTest(todo.content, "");
    if (Array.isArray(todo.dependencies) && todo.dependencies.length) out.dependencies = todo.dependencies.map(String);
    return out;
  }
  function todoWriteProviderResultFromSnapshotForTest(snapshot, merge) {
    return {
      result: {
        case: "success",
        value: {
          todos: snapshot,
          merge: !!merge,
        },
      },
    };
  }
  function todoWriteUiResultFromSnapshotForTest(snapshot, merge) {
    var todos = [];
    for (var i = 0; i < snapshot.length; i++) {
      var todo = todoUiItemForTest(snapshot[i]);
      if (todo) todos.push(todo);
    }
    return {
      result: {
        case: "success",
        value: {
          todos: todos,
          totalCount: todos.length,
          wasMerge: !!merge,
        },
      },
    };
  }
  function todoWriteLocalPayloadForTest(todos, merge) {
    var snapshot = cloneTodosForTest(todos);
    return {
      providerResult: todoWriteProviderResultFromSnapshotForTest(snapshot, merge),
      uiResult: todoWriteUiResultFromSnapshotForTest(snapshot, merge),
    };
  }
  function replaceTodosForScopeForTest(scopeId, todos) {
    localTodosByScopeForTest[scopeId || "default"] = todos;
  }

  var localTodosByScopeForTest = {};

  function todosForScopeForTest(scopeId) {
    var key = scopeId || "default";
    if (!localTodosByScopeForTest[key]) localTodosByScopeForTest[key] = [];
    return localTodosByScopeForTest[key];
  }

  function mergeTodosForTest(scopeId, updates) {
    var localTodos = todosForScopeForTest(scopeId);
    for (var i = 0; i < updates.length; i++) {
      var update = normalizeTodoItemForTest(updates[i]);
      if (!update) continue;
      var id = stringArgForTest(update.id, "");
      var index = -1;
      if (id) {
        for (var j = 0; j < localTodos.length; j++) {
          if (localTodos[j] && localTodos[j].id === id) {
            index = j;
            break;
          }
        }
      }
      if (index >= 0) {
        localTodos[index] = { ...localTodos[index], ...update };
      } else {
        localTodos.push(update);
      }
    }
  }
  function todoWriteLocalResultForTest(event, scopeId) {
    var args = parseToolArgumentsForTest(event.arguments);
    var localTodos = todosForScopeForTest(scopeId);
    if (event.name === "TaskList" || event.name === "TaskGet") {
      return todoWriteLocalPayloadForTest(localTodos, true);
    }
    if (event.name === "TaskCreate" || event.name === "TaskUpdate") {
      var taskId = stringArgForTest(args.taskId || args.task_id || event.id || "task");
      var todo = {
        id: event.name === "TaskUpdate" ? taskId : String(event.id || "task-create"),
        status: stringArgForTest(args.status, "in_progress"),
      };
      var content = stringArgForTest(args.subject || args.description, "");
      if (content) todo.content = content;
      mergeTodosForTest(scopeId, [todo]);
      return todoWriteLocalPayloadForTest(todosForScopeForTest(scopeId), true);
    }
    if (!args.merge) replaceTodosForScopeForTest(scopeId, []);
    mergeTodosForTest(scopeId, arrayArgForTest(args.todos));
    return todoWriteLocalPayloadForTest(todosForScopeForTest(scopeId), !!args.merge);
  }
  function execServerMessage(event, execId) {
    const args = normalizeToolArgsForTest(event.name, parseToolArgumentsForTest(event.arguments), event.id);
    if (!args) return null;
    return fromJson(captured.messageCtor, {
      message: {
        case: "execServerMessage",
        value: {
          id: execId,
          execId: event.id,
          message: {
            case: args.case,
            value: args.value,
          },
        },
      },
    });
  }
  function eventToCursorMessages(event, stepId, execId = 1) {
    switch (event.type) {
      case "tool_use_done":
        {
          const localResult = eventLocalResultForTest(event);
          if (localResult) {
            return [
              toolCallStarted(event, "model-" + stepId),
              toolCallCompleted(event, "model-" + stepId, completedValueForLocalResultForTest(event, localResult)),
            ];
          }
        }
        if (event.name === "mcp_auth") {
          const args = mcpAuthArgsForTest(parseToolArgumentsForTest(event.arguments), event.id);
          return [
            toolCallStarted(event, "model-" + stepId),
            interactionQueryMessage(execId, "mcpAuthRequestQuery", { args }),
          ];
        }
        if (event.name === "AwaitShell" &&
          !normalizeToolArgsForTest(event.name, parseToolArgumentsForTest(event.arguments), event.id)) {
          return [
            toolCallStarted(event, "model-" + stepId),
            toolCallCompleted(event, "model-" + stepId, awaitShellLocalResult(event)),
          ];
        }
        if (event.name === "TodoWrite" || event.name === "TaskCreate" || event.name === "TaskUpdate" || event.name === "TaskList" || event.name === "TaskGet") {
          return [
            toolCallStarted(event, "model-" + stepId),
            toolCallCompleted(event, "model-" + stepId, todoWriteLocalResultForTest(event)),
          ];
        }
        {
          const started = toolCallStarted(event, "model-" + stepId);
          const exec = execServerMessage(event, execId);
          return exec ? [started, exec] : [started, toolCallCompleted(event, "model-" + stepId, unsupportedLocalResultForTest())];
        }
      case "tool_use_delta":
        return [tokenDelta(1)];
      default:
        return [];
    }
  }
  function normalizeInteractionResponseValueForTest(value) {
    if (!value || typeof value !== "object") return value;
    var out = {};
    var json = toJsonForTest(value);
    if (json && typeof json === "object") {
      var jsonKeys = Object.keys(json);
      for (var i = 0; i < jsonKeys.length; i++) out[jsonKeys[i]] = json[jsonKeys[i]];
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      if (out[keys[j]] === undefined) out[keys[j]] = value[keys[j]];
    }
    if (out.result && out.result.case) {
      return {
        id: out.id,
        result: {
          case: out.result.case,
          value: normalizeInteractionResponsePayloadForTest(out.result.value),
        },
      };
    }
    var cases = [
      "webSearchRequestResponse",
      "askQuestionInteractionResponse",
      "switchModeRequestResponse",
      "createPlanRequestResponse",
      "webFetchRequestResponse",
      "mcpAuthRequestResponse",
      "generateImageRequestResponse",
    ];
    for (var k = 0; k < cases.length; k++) {
      var caseName = cases[k];
      if (out[caseName] !== undefined) {
        return {
          id: out.id,
          result: {
            case: caseName,
            value: normalizeInteractionResponsePayloadForTest(out[caseName]),
          },
        };
      }
    }
    return out;
  }
  function extractAgentClientMessageObjectForTest(json) {
    if (!json || typeof json !== "object") return null;
    if (json.message && json.message.case) {
      if (json.message.case === "interactionResponse") {
        return {
          case: "interactionResponse",
          value: normalizeInteractionResponseValueForTest(json.message.value),
        };
      }
      return json.message;
    }
    if (json.execClientMessage) {
      return {
        case: "execClientMessage",
        value: json.execClientMessage,
      };
    }
    if (json.execClientControlMessage) {
      return {
        case: "execClientControlMessage",
        value: json.execClientControlMessage,
      };
    }
    if (json.interactionResponse) {
      return {
        case: "interactionResponse",
        value: normalizeInteractionResponseValueForTest(json.interactionResponse),
      };
    }
    return json.case ? json : null;
  }
  function extractAgentClientMessageForTest(value) {
    var message = extractAgentClientMessageObjectForTest(value);
    if (message) return message;
    var json = toJsonForTest(value) || value;
    return extractAgentClientMessageObjectForTest(json);
  }
  return {
    eventToCursorMessages,
    execServerMessage,
    extractAgentClientMessage: extractAgentClientMessageForTest,
    interactionQueryMessage,
    normalizeToolArgs: normalizeToolArgsForTest,
    toolCallStarted,
  };
}

function normalizeInteractionResponsePayloadForTest(value) {
  if (!value || typeof value !== "object") return value;
  var json = toJsonForTest(value);
  if (json && json !== value && typeof json === "object") {
    return normalizeInteractionResponsePayloadForTest(json);
  }
  if (value.result && value.result.case) return value;
  if (value.result && typeof value.result === "object") {
    var resultJson = toJsonForTest(value.result) || value.result;
    var nested = normalizeInteractionResultUnionForTest(resultJson);
    if (nested) return { result: nested };
  }
  var result = normalizeInteractionResultUnionForTest(value);
  if (result) return { result: result };
  return value;
}

function normalizeInteractionResultUnionForTest(value) {
  if (!value || typeof value !== "object") return null;
  var json = toJsonForTest(value);
  if (json && json !== value && typeof json === "object") {
    return normalizeInteractionResultUnionForTest(json);
  }
  if (value.case) return value;
  var cases = ["success", "approved", "error", "rejected", "async"];
  for (var i = 0; i < cases.length; i++) {
    var caseName = cases[i];
    if (value[caseName] !== undefined) {
      return {
        case: caseName,
        value: value[caseName] || {},
      };
    }
  }
  return null;
}

function toJsonForTest(value) {
  if (!value) return null;
  try {
    if (typeof value.toJson === "function") return value.toJson();
  } catch {}
  try {
    if (typeof value.toJsonString === "function") return JSON.parse(value.toJsonString());
  } catch {}
  return value;
}

function toolEnvelopeForTest(name, args, result, toolCallId) {
  var cursorToolType = cursorToolTypeForNameForTest(name);
  var value = {};
  var startedArgs = normalizeStartedToolArgsForTest(name, args, toolCallId);
  if (startedArgs !== undefined) value.args = startedArgs;
  if (result !== undefined) value.result = result;
  return {
    tool: {
      case: cursorToolType,
      value,
    },
  };
}

function cursorToolTypeForNameForTest(name) {
  switch (name) {
    case "Read":
    case "ReadFile":
      return "readToolCall";
    case "Edit":
    case "ApplyPatch":
    case "Write":
    case "EditNotebook":
      return "editToolCall";
    case "GenerateImage":
      return "generateImageToolCall";
    case "Shell":
      return "shellToolCall";
    case "Grep":
      return "grepToolCall";
    case "Glob":
      return "globToolCall";
    case "LS":
      return "lsToolCall";
    case "Delete":
      return "deleteToolCall";
    case "WriteShellStdin":
      return "custom";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "updateTodosToolCall";
    case "ReadLints":
      return "readLintsToolCall";
    case "WebSearch":
      return "webSearchToolCall";
    case "WebFetch":
      return "webFetchToolCall";
    case "AwaitShell":
      return "awaitToolCall";
    case "CallMcpTool":
      return "mcpToolCall";
    case "ListMcpResources":
      return "listMcpResourcesToolCall";
    case "FetchMcpResource":
      return "readMcpResourceToolCall";
    case "mcp_auth":
      return "mcpAuthToolCall";
    case "AskQuestion":
      return "askQuestionToolCall";
    case "SwitchMode":
      return "switchModeToolCall";
    case "CreatePlan":
      return "createPlanToolCall";
    default:
      return "custom";
  }
}

function parseToolArgumentsForTest(args) {
  if (args === undefined || args === null || args === "") return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

function normalizeIntegerForTest(value) {
  if (typeof value === "number" && Math.floor(value) === value) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function shellIdArgForTest(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return value;
}

function firstStringArgForTest() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function pathArgForTest(args) {
  return firstStringArgForTest(args.path, args.filePath, args.file_path, args.filename, args.target_notebook, args.targetNotebook);
}

function writeContentArgForTest(args) {
  if (typeof args.contents === "string") return args.contents;
  if (typeof args.content === "string") return args.content;
  if (typeof args.fileText === "string") return args.fileText;
  return "";
}

function newStringArgForTest(args) {
  if (typeof args.new_string === "string") return args.new_string;
  if (typeof args.newString === "string") return args.newString;
  if (typeof args.new === "string") return args.new;
  return "";
}

function readStartedArgsForTest(args) {
  var offset = normalizeIntegerForTest(args.offset);
  var limit = normalizeIntegerForTest(args.limit);
  return {
    path: String(args.path || args.filePath || args.file_path || ""),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function normalizeStartedToolArgsForTest(name, args, toolCallId) {
  if (args === undefined) return undefined;
  switch (name) {
    case "Read":
    case "ReadFile":
      return readStartedArgsForTest(args);
    case "Glob":
      return {
        targetDirectory: String(args.target_directory || args.targetDirectory || args.path || ""),
        globPattern: String(args.glob_pattern || args.globPattern || args.pattern || ""),
      };
    case "LS": {
      var lsStarted = {
        path: String(args.path || args.target_directory || args.targetDirectory || ""),
      };
      var ignoreStarted = arrayArgForTest(args.ignore || args.ignore_globs || args.ignoreGlobs);
      if (ignoreStarted.length) lsStarted.ignore = ignoreStarted;
      return lsStarted;
    }
    case "WebFetch":
      return { url: stringArgForTest(args.url) };
    case "WriteShellStdin":
      return {
        shellId: stringArgForTest(args.shell_id ?? args.shellId),
        chars: stringArgForTest(args.chars),
      };
    case "AwaitShell": {
      var awaitStarted = {};
      var taskId = stringArgForTest(args.task_id ?? args.shell_id ?? args.shellId ?? args.taskId, "");
      if (taskId) awaitStarted.taskId = taskId;
      var blockMs = normalizeIntegerForTest(args.block_until_ms ?? args.blockUntilMs);
      if (blockMs !== undefined) awaitStarted.blockUntilMs = blockMs;
      return awaitStarted;
    }
    case "Grep": {
      var grep = {
        pattern: String(args.pattern || ""),
      };
      if (args.path !== undefined) grep.path = String(args.path);
      if (args.glob !== undefined) grep.glob = String(args.glob);
      if (args.type !== undefined) grep.type = String(args.type);
      if (args.output_mode !== undefined) grep.outputMode = String(args.output_mode);
      if (args.outputMode !== undefined) grep.outputMode = String(args.outputMode);
      var contextBefore = normalizeIntegerForTest(args["-B"] ?? args.context_before ?? args.contextBefore);
      var contextAfter = normalizeIntegerForTest(args["-A"] ?? args.context_after ?? args.contextAfter);
      var context = normalizeIntegerForTest(args["-C"] ?? args.context);
      var headLimit = normalizeIntegerForTest(args.head_limit ?? args.headLimit);
      var grepOffset = normalizeIntegerForTest(args.offset);
      if (contextBefore !== undefined) grep.contextBefore = contextBefore;
      if (contextAfter !== undefined) grep.contextAfter = contextAfter;
      if (context !== undefined) grep.context = context;
      if (headLimit !== undefined) grep.headLimit = headLimit;
      if (grepOffset !== undefined) grep.offset = grepOffset;
      if (args["-i"] !== undefined) grep.caseInsensitive = !!args["-i"];
      if (args.case_insensitive !== undefined) grep.caseInsensitive = !!args.case_insensitive;
      if (args.caseInsensitive !== undefined) grep.caseInsensitive = !!args.caseInsensitive;
      if (args.multiline !== undefined) grep.multiline = !!args.multiline;
      return grep;
    }
    case "ApplyPatch":
      return applyPatchStartedArgsForTest(args);
    case "Write":
      return { path: pathArgForTest(args) };
    case "EditNotebook":
      return {
        path: pathArgForTest(args),
        streamContent: newStringArgForTest(args),
      };
    case "GenerateImage": {
      var image = { description: stringArgForTest(args.description) };
      if (typeof args.filename === "string") image.filePath = args.filename;
      if (Array.isArray(args.reference_image_paths)) image.referenceImagePaths = args.reference_image_paths;
      if (Array.isArray(args.referenceImagePaths)) image.referenceImagePaths = args.referenceImagePaths;
      return image;
    }
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return undefined;
    case "Task":
    case "Subagent":
      return undefined;
    case "CallMcpTool":
      return {
        name: stringArgForTest(args.name),
        toolCallId,
        args: mcpValueMapForTest(args.args),
        providerIdentifier: stringArgForTest(args.providerIdentifier || args.provider),
        toolName: stringArgForTest(args.toolName || args.tool_name),
      };
    case "ListMcpResources":
      return {
        ...(args.server ? { server: stringArgForTest(args.server) } : {}),
      };
    case "FetchMcpResource":
      return {
        server: stringArgForTest(args.server),
        uri: stringArgForTest(args.uri),
        downloadPath: stringArgForTest(args.downloadPath),
      };
    case "mcp_auth":
      return mcpAuthArgsForTest(args, toolCallId);
    case "AskQuestion":
      return normalizeAskQuestionArgsForTest(args);
    case "SwitchMode":
      return {
        targetModeId: stringArgForTest(args.target_mode_id || args.targetModeId),
        explanation: stringArgForTest(args.explanation, ""),
      };
    case "CreatePlan":
      return normalizeCreatePlanQueryArgsForTest(args);
    default:
      return args;
  }
}

  function stringArgForTest(value, fallback) {
    return typeof value === "string" ? value : fallback || "";
  }

function mcpAuthArgsForTest(args, toolCallId) {
  return {
    serverIdentifier: stringArgForTest(args.server_identifier ?? args.serverIdentifier),
    toolCallId: stringArgForTest(args.tool_call_id ?? args.toolCallId, toolCallId),
  };
}

function normalizeAskQuestionArgsForTest(args) {
  return {
    title: stringArgForTest(args.title, ""),
    questions: arrayArgForTest(args.questions).map(function (question) {
      return {
        id: stringArgForTest(question.id),
        prompt: stringArgForTest(question.prompt),
        allowMultiple: !!(question.allow_multiple ?? question.allowMultiple),
        options: arrayArgForTest(question.options).map(function (option) {
          return {
            id: stringArgForTest(option.id),
            label: stringArgForTest(option.label),
          };
        }),
      };
    }),
  };
}

  function normalizePlanTodoForTest(todo) {
    var out = {
      id: stringArgForTest(todo.id),
      content: stringArgForTest(todo.content),
      dependencies: arrayArgForTest(todo.dependencies).map(String),
    };
    var status = planTodoStatusForTest(todo.status);
    if (status !== undefined) out.status = status;
    return out;
  }

function planTodoStatusForTest(status) {
  switch (stringArgForTest(status).toLowerCase()) {
    case "pending":
      return 1;
    case "in_progress":
    case "in-progress":
    case "inprogress":
      return 2;
    case "completed":
    case "complete":
    case "done":
      return 3;
    case "cancelled":
    case "canceled":
      return 4;
    default:
      return Number.isInteger(status) ? status : undefined;
  }
}

function normalizeCreatePlanQueryArgsForTest(args) {
  return {
    name: stringArgForTest(args.name, ""),
    overview: stringArgForTest(args.overview, ""),
    plan: stringArgForTest(args.plan, ""),
    todos: arrayArgForTest(args.todos).map(normalizePlanTodoForTest),
    isProject: !!(args.isProject ?? args.is_project),
    phases: arrayArgForTest(args.phases).map(function (phase) {
      return {
        name: stringArgForTest(phase.name),
        todos: arrayArgForTest(phase.todos).map(normalizePlanTodoForTest),
      };
    }),
  };
}

function applyPatchTextForTest(args) {
  if (typeof args === "string") return args;
  return stringArgForTest(args.patch);
}

function parseApplyPatchForTest(patchText) {
  var normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var header = normalized.match(/^\*\*\* Begin Patch\n\*\*\* (Add|Update|Delete) File: ([^\n]+)\n/);
  if (!header || header[1] === "Delete") return null;
  var path = header[2].trim();
  if (!path) return null;
  var streamContent = normalized
    .replace(/^\*\*\* Begin Patch\n/, "")
    .replace(/^\*\*\* (?:Add|Update|Delete) File:.*\n/, "")
    .replace(/\*\*\* End Patch\s*$/, "")
    .trim();
  return {
    path,
    patchText,
    streamContent: streamContent + "\n*** End Patch\n",
  };
}

function applyPatchStartedArgsForTest(args) {
  var plan = parseApplyPatchForTest(applyPatchTextForTest(args));
  return { path: plan ? plan.path : String(args.path || args.filename || "") };
}

function arrayArgForTest(value) {
  return Array.isArray(value) ? value : [];
}

function shellArgsForTest(args, toolCallId) {
  var command = stringArgForTest(args.command);
  var parts = command.trim().split(/\s+/).filter(Boolean);
  var executable = parts[0] || "";
  var commandArgs = parts.slice(1).map(function (value) {
    return { type: "word", value };
  });
  var timeout = normalizeIntegerForTest(args.timeout ?? args.block_until_ms ?? args.blockUntilMs);
  var hardTimeout = normalizeIntegerForTest(args.hardTimeout);
  return {
    command,
    workingDirectory: stringArgForTest(args.working_directory ?? args.workingDirectory ?? args.cwd),
    timeout: timeout !== undefined ? timeout : 30000,
    toolCallId,
    description: stringArgForTest(args.description),
    simpleCommands: executable ? [executable] : [],
    parsingResult: executable
      ? { executableCommands: [{ name: executable, args: commandArgs, fullText: command }] }
      : undefined,
    fileOutputThresholdBytes: 20000,
    timeoutBehavior: 2,
    hardTimeout: hardTimeout !== undefined ? hardTimeout : 86400000,
  };
}

function writeArgsForTest(name, args, toolCallId) {
  var path = pathArgForTest(args);
  if (name === "Write") {
    var contents = writeContentArgForTest(args);
    return {
      path,
      fileText: contents,
      encodingHint: "utf8",
      toolCallId,
    };
  }
  return null;
}

function normalizeToolArgsForTest(name, args, toolCallId) {
  switch (name) {
    case "Shell":
      return { case: "shellStreamArgs", value: shellArgsForTest(args, toolCallId) };
    case "Delete":
      return {
        case: "deleteArgs",
        value: {
          path: pathArgForTest(args),
          toolCallId,
        },
      };
    case "Write":
      return { case: "writeArgs", value: writeArgsForTest(name, args, toolCallId) };
    case "Read":
    case "ReadFile": {
      var offset = normalizeIntegerForTest(args.offset);
      var limit = normalizeIntegerForTest(args.limit);
      return {
        case: "readArgs",
        value: {
          path: String(args.path || args.filePath || args.file_path || ""),
          toolCallId,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(args.encodingHint ? { encodingHint: String(args.encodingHint) } : {}),
        },
      };
    }
    case "Glob": {
      return {
        case: "grepArgs",
        value: {
          path: String(args.target_directory || args.targetDirectory || args.path || ""),
          glob: String(args.glob_pattern || args.globPattern || args.pattern || ""),
          outputMode: "files_with_matches",
          toolCallId,
          pattern: "",
        },
      };
    }
    case "LS": {
      var ls = {
        path: lsPathArgForTest(args),
        toolCallId,
      };
      var ignore = ignoreGlobsArgForTest(args);
      if (ignore.length) ls.ignore = ignore;
      var lsTimeout = normalizeIntegerForTest(args.timeout_ms ?? args.timeoutMs);
      if (lsTimeout !== undefined) ls.timeoutMs = lsTimeout;
      return { case: "lsArgs", value: ls };
    }
    case "WebFetch":
    case "WebSearch":
    case "GenerateImage":
      return null;
    case "WriteShellStdin":
      return {
        case: "writeShellStdinArgs",
        value: {
          shellId: shellIdArgForTest(args.shell_id ?? args.shellId),
          chars: String(args.chars || ""),
        },
      };
    case "AwaitShell": {
      var taskId = awaitTaskIdArgForTest(args);
      if (!taskId) return null;
      var awaitValue = {
        agentId: taskId,
      };
      var timeoutMs = normalizeIntegerForTest(args.block_until_ms ?? args.blockUntilMs);
      if (timeoutMs !== undefined) awaitValue.timeoutMs = timeoutMs;
      return { case: "subagentAwaitArgs", value: awaitValue };
    }
    case "Grep": {
      var grep = {
        pattern: String(args.pattern || ""),
        toolCallId,
      };
      if (args.path !== undefined) grep.path = String(args.path);
      if (args.glob !== undefined) grep.glob = String(args.glob);
      if (args.output_mode !== undefined) grep.outputMode = String(args.output_mode);
      if (args.outputMode !== undefined) grep.outputMode = String(args.outputMode);
      var contextBefore = normalizeIntegerForTest(args["-B"] ?? args.context_before ?? args.contextBefore);
      var contextAfter = normalizeIntegerForTest(args["-A"] ?? args.context_after ?? args.contextAfter);
      var context = normalizeIntegerForTest(args["-C"] ?? args.context);
      var headLimit = normalizeIntegerForTest(args.head_limit ?? args.headLimit);
      var grepOffset = normalizeIntegerForTest(args.offset);
      if (contextBefore !== undefined) grep.contextBefore = contextBefore;
      if (contextAfter !== undefined) grep.contextAfter = contextAfter;
      if (context !== undefined) grep.context = context;
      if (args["-i"] !== undefined) grep.caseInsensitive = !!args["-i"];
      if (args.case_insensitive !== undefined) grep.caseInsensitive = !!args.case_insensitive;
      if (args.caseInsensitive !== undefined) grep.caseInsensitive = !!args.caseInsensitive;
      if (args.type !== undefined) grep.type = String(args.type);
      if (headLimit !== undefined) grep.headLimit = headLimit;
      if (args.multiline !== undefined) grep.multiline = !!args.multiline;
      if (args.sort !== undefined) grep.sort = String(args.sort);
      if (args.sort_ascending !== undefined) grep.sortAscending = !!args.sort_ascending;
      if (args.sortAscending !== undefined) grep.sortAscending = !!args.sortAscending;
      if (grepOffset !== undefined) grep.offset = grepOffset;
      return { case: "grepArgs", value: grep };
    }
    case "ReadLints": {
      var paths = arrayArgForTest(args.paths);
      return {
        case: "diagnosticsArgs",
        value: {
          path: String(args.path || paths[0] || ""),
          toolCallId,
        },
      };
    }
    case "ListMcpResources":
      return {
        case: "listMcpResourcesExecArgs",
        value: {
          ...(args.server ? { server: args.server } : {}),
          toolCallId,
        },
      };
    case "FetchMcpResource":
      return {
        case: "readMcpResourceExecArgs",
        value: {
          server: args.server || "",
          uri: args.uri || "",
          downloadPath: args.downloadPath || "",
          toolCallId,
        },
      };
    case "CallMcpTool":
      return {
        case: "mcpArgs",
        value: {
          name: args.name || "",
          args: mcpValueMapForTest(args.args),
          toolCallId,
          providerIdentifier: args.providerIdentifier || args.provider || "",
          toolName: args.toolName || args.tool_name || "",
        },
      };
    default:
      return null;
  }
}

function mcpValueMapForTest(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var out = {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = mcpValueForTest(source[key]);
  }
  return out;
}

function mcpValueForTest(value) {
  if (value === null || value === undefined) {
    return { kind: { case: "nullValue", value: "NULL_VALUE" } };
  }
  if (typeof value === "string") {
    return { kind: { case: "stringValue", value } };
  }
  if (typeof value === "number") {
    return { kind: { case: "numberValue", value: Number.isFinite(value) ? value : 0 } };
  }
  if (typeof value === "boolean") {
    return { kind: { case: "boolValue", value } };
  }
  if (Array.isArray(value)) {
    return { kind: { case: "listValue", value: { values: value.map(mcpValueForTest) } } };
  }
  if (typeof value === "object") {
    return { kind: { case: "structValue", value: { fields: mcpValueMapForTest(value) } } };
  }
  return { kind: { case: "stringValue", value: String(value) } };
}

function awaitTaskIdArgForTest(args) {
  return String(args.task_id ?? args.shell_id ?? args.shellId ?? args.taskId ?? "").trim();
}

function ignoreGlobsArgForTest(args) {
  return arrayArgForTest(args.ignore || args.ignore_globs || args.ignoreGlobs);
}

function lsPathArgForTest(args) {
  return String(args.path || args.target_directory || args.targetDirectory || "");
}

function normalizeResultEnvelopeForTest(messageCase, value) {
  if (!value || typeof value !== "object") return value;
  if (value.result && value.result.case) return value;
  if (messageCase === "mcpResult") {
    var mcpError = normalizeMcpErrorResultForTest(value);
    if (mcpError) return mcpError;
  }
  var resultCases = [
    "success",
    "error",
    "rejected",
    "fileNotFound",
    "permissionDenied",
    "invalidFile",
    "failure",
    "spawnError",
    "writePermissionDenied",
  ];
  for (var i = 0; i < resultCases.length; i++) {
    var caseName = resultCases[i];
    if (value[caseName] !== undefined) {
      return {
        result: {
          case: caseName,
          value: normalizeResultValueForTest(messageCase, caseName, value[caseName]),
        },
      };
    }
  }
  var implicitSuccess = normalizeImplicitSuccessResultForTest(messageCase, value);
  if (implicitSuccess) return implicitSuccess;
  return value;
}

function normalizeImplicitSuccessResultForTest(messageCase, value) {
  if (!value || typeof value !== "object") return null;
  if (messageCase === "mcpResult") {
    if (!Array.isArray(value.content) && value.structuredContent === undefined) return null;
    return {
      result: {
        case: "success",
        value: normalizeResultValueForTest(messageCase, "success", value),
      },
    };
  }
  if (messageCase === "listMcpResourcesExecResult") {
    if (!Array.isArray(value.resources)) return null;
    return {
      result: {
        case: "success",
        value: value,
      },
    };
  }
  if (messageCase === "readMcpResourceExecResult") {
    if (value.uri === undefined && value.content === undefined) return null;
    return {
      result: {
        case: "success",
        value: normalizeReadMcpResourceResultValueForTest(value),
      },
    };
  }
  return null;
}

function normalizeMcpErrorResultForTest(value) {
  if (!value || typeof value !== "object") return null;
  var errorCases = [
    "toolNotFound",
    "serverNotFound",
    "invalidArgs",
    "permissionDenied",
    "rejected",
    "failure",
  ];
  for (var i = 0; i < errorCases.length; i++) {
    var caseName = errorCases[i];
    if (value[caseName] !== undefined) {
      return {
        result: {
          case: "error",
          value: { error: formatMcpErrorForTest(caseName, value[caseName]) },
        },
      };
    }
  }
  return null;
}

function normalizeResultValueForTest(messageCase, resultCase, value) {
  if (messageCase === "shellResult" && value && typeof value === "object") {
    return normalizeShellResultValueForTest(resultCase, value);
  }
  if (messageCase === "mcpResult" && value && typeof value === "object") {
    return normalizeMcpResultValueForTest(resultCase, value);
  }
  if (messageCase !== "readResult" || resultCase !== "success" || !value || typeof value !== "object") return value;
  var out = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key !== "content" && key !== "data") out[key] = value[key];
  }
  if (value.output !== undefined) return out;
  if (value.data !== undefined) out.output = { case: "data", value: value.data };
  else if (value.content !== undefined) out.output = { case: "content", value: String(value.content) };
  return out;
}

function formatMcpErrorForTest(caseName, value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    if (typeof value.error === "string" && value.error) return value.error;
    if (typeof value.message === "string" && value.message) return value.message;
    if (caseName === "toolNotFound" && typeof value.name === "string" && value.name) {
      return "MCP tool not found: " + value.name;
    }
    try {
      return "MCP " + caseName + ": " + JSON.stringify(value);
    } catch {}
  }
  return "MCP " + caseName;
}

function normalizeMcpContentBlockForTest(block) {
  if (!block || typeof block !== "object") return block;
  if (block.content && block.content.case) return block;
  if (block.case) return { content: block };
  switch (block.type) {
    case "text":
      return { content: { case: "text", value: { text: stringArgForTest(block.text) } } };
    case "image":
      return {
        content: {
          case: "image",
          value: {
            mimeType: stringArgForTest(block.mimeType),
            data: block.data,
            uri: block.uri,
          },
        },
      };
    case "resource":
      return { content: { case: "resource", value: block.resource || {} } };
    default:
      return block;
  }
}

function normalizeMcpResultValueForTest(resultCase, value) {
  if (resultCase !== "success") return value;
  var out = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) out[keys[i]] = value[keys[i]];
  if (Array.isArray(value.content)) {
    out.content = value.content.map(normalizeMcpContentBlockForTest);
  }
  return out;
}

function normalizeReadMcpResourceResultValueForTest(value) {
  if (!value || typeof value !== "object") return value;
  var out = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) out[keys[i]] = value[keys[i]];
  if (value.content && typeof value.content === "object" && !value.content.case) {
    out.content = normalizeMcpResourceContentForTest(value.content);
  }
  return out;
}

function normalizeShellResultValueForTest(resultCase, value) {
  if (resultCase !== "success" && resultCase !== "failure") return value;
  var output = value;
  if (typeof value.tool_output === "string") {
    try {
      output = JSON.parse(value.tool_output);
    } catch {
      output = { output: value.tool_output };
    }
  }
  if (!output || typeof output !== "object") output = {};
  var input = value.tool_input && typeof value.tool_input === "object" ? value.tool_input : {};
  var stdout = typeof output.stdout === "string"
    ? output.stdout
    : typeof output.output === "string"
      ? output.output
      : "";
  var stderr = typeof output.stderr === "string" ? output.stderr : "";
  var exitCode = normalizeIntegerForTest(output.exitCode);
  if (exitCode === undefined) exitCode = normalizeIntegerForTest(output.exit_code);
  return {
    command: stringArgForTest(output.command, stringArgForTest(input.command)),
    workingDirectory: stringArgForTest(output.workingDirectory, stringArgForTest(output.cwd, stringArgForTest(input.workingDirectory, stringArgForTest(input.cwd)))),
    output: stringArgForTest(output.output, stdout || stderr),
    stdout,
    stderr,
    exitCode: exitCode !== undefined ? exitCode : 0,
    ...(stringArgForTest(output.shellId, stringArgForTest(output.shell_id)) ? { shellId: stringArgForTest(output.shellId, stringArgForTest(output.shell_id)) } : {}),
    ...(stringArgForTest(output.taskId, stringArgForTest(output.task_id)) ? { taskId: stringArgForTest(output.taskId, stringArgForTest(output.task_id)) } : {}),
    ...(Number.isFinite(output.msToWait) ? { msToWait: output.msToWait } : {}),
    ...(Number.isFinite(output.pid) ? { pid: output.pid } : {}),
    ...(typeof output.backgroundReason === "string" ? { backgroundReason: output.backgroundReason } : {}),
    ...(output.localExecutionTimeMs !== undefined ? { localExecutionTimeMs: output.localExecutionTimeMs } : {}),
    ...(Number.isFinite(output.executionTime) ? { executionTime: output.executionTime } : {}),
    ...(typeof output.signal === "string" && output.signal ? { signal: output.signal } : {}),
    ...(typeof output.interleavedOutput === "string" ? { interleavedOutput: output.interleavedOutput } : {}),
  };
}

function normalizeMcpResourceContentForTest(content) {
  switch (content.type) {
    case "text":
      return { case: "text", value: stringArgForTest(content.text) };
    case "blob":
      return { case: "blob", value: content.blob !== undefined ? content.blob : content.data || "" };
    default:
      return content;
  }
}

module.exports = {
  buildWorkbenchHook,
  createHookRuntimeHelpersForTest,
  hookRuntime,
};
