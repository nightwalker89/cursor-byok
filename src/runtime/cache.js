"use strict";

// Intentional pass-through: Anthropic `cache_control` markers already live on the
// message blocks we forward, so there is nothing to re-apply. Kept as a named seam
// so callers have an explicit hook if cache-control rewriting is ever needed.
function preserveAnthropicCacheControl(messages) {
  return messages;
}

function withOpenAiPromptCacheKey(request, conversationId) {
  if (!conversationId) return request;
  const next = { ...request };
  next.prompt_cache_key = conversationId;
  return next;
}

module.exports = {
  preserveAnthropicCacheControl,
  withOpenAiPromptCacheKey,
};
