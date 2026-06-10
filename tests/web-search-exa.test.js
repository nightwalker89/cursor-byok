"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeProvidersConfig } = require("../src/config");
const {
  WEB_SEARCH_CHUNK_MAX_CHARS,
  WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
  buildWebSearchReferences,
  exaAnswerFromResponse,
  exaDocumentsFromResponse,
  isWebSearchExaConfigured,
  mapWebSearchProviderError,
  normalizeWebSearchConfig,
  searchTermFromToolArguments,
  searchWebWithExa,
  webSearchCompletionFromExa,
} = require("../src/runtime/web-search-exa");

test("normalizeWebSearchConfig prefers providers.json and falls back to EXA_API_KEY", () => {
  const original = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "env-key";
  try {
    assert.deepEqual(normalizeWebSearchConfig({
      webSearch: { provider: "exa", apiKey: "file-key", baseUrl: "https://api.exa.ai/" },
    }), {
      provider: "exa",
      apiKey: "file-key",
      baseUrl: "https://api.exa.ai",
      numResults: 10,
      type: "auto",
    });
    assert.deepEqual(normalizeWebSearchConfig({}), {
      provider: "exa",
      apiKey: "env-key",
      baseUrl: "https://api.exa.ai",
      numResults: 10,
      type: "auto",
    });
    assert.equal(normalizeWebSearchConfig({ webSearch: { provider: "bing" } }), null);
    assert.equal(normalizeWebSearchConfig({ webSearch: { provider: "client" } }), null);
  } finally {
    if (original === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = original;
  }
});

test("normalizeProvidersConfig preserves webSearch settings", () => {
  const normalized = normalizeProvidersConfig({
    providers: [{ id: "p", name: "P" }],
    webSearch: { provider: "exa", apiKey: "secret", numResults: 5, type: "fast" },
  });
  assert.deepEqual(normalizeProvidersConfig({
    providers: [{ id: "p", name: "P" }],
    webSearch: { provider: "client", apiKey: "ignored", type: "fast" },
  }).webSearch, {
    provider: "client",
    apiKey: "ignored",
    type: "fast",
  });
  assert.deepEqual(normalized.webSearch, {
    provider: "exa",
    apiKey: "secret",
    numResults: 5,
    type: "fast",
  });
});

test("searchTermFromToolArguments normalizes aliases", () => {
  assert.equal(
    searchTermFromToolArguments({ search_term: "Cursor BYOK" }, "web-1"),
    "Cursor BYOK",
  );
  assert.equal(
    searchTermFromToolArguments("{\"searchTerm\":\"Exa search\"}", "web-2"),
    "Exa search",
  );
});

test("buildWebSearchReferences matches official answer-first and document-skip rules", () => {
  assert.deepEqual(
    buildWebSearchReferences({
      answer: "Concise answer",
      documents: [{ title: "Doc", url: "https://example.com", text: "Body" }],
    }),
    [{
      title: "Web search results",
      url: "",
      chunk: "Concise answer",
    }],
  );
  assert.deepEqual(
    buildWebSearchReferences({
      documents: [
        { title: "Doc A", url: "https://a.test", text: "A".repeat(WEB_SEARCH_CHUNK_MAX_CHARS + 50) },
        { title: "Doc B", url: "https://b.test", text: "short" },
      ],
    }),
    [
      {
        title: "Doc A",
        url: "https://a.test",
        chunk: "A".repeat(WEB_SEARCH_CHUNK_MAX_CHARS),
      },
      {
        title: "Doc B",
        url: "https://b.test",
        chunk: "short",
      },
    ],
  );
});

test("exa response parsers prefer output.content and dedupe documents", () => {
  const payload = {
    output: { content: "Synthesized answer" },
    results: [
      { title: "First", url: "https://example.com/a", text: "alpha" },
      { title: "Duplicate", url: "https://example.com/a", text: "ignored" },
      { title: "Second", url: "https://example.com/b", text: "beta" },
    ],
  };
  assert.equal(exaAnswerFromResponse(payload), "Synthesized answer");
  assert.deepEqual(exaDocumentsFromResponse(payload), [
    { title: "First", url: "https://example.com/a", text: "alpha" },
    { title: "Second", url: "https://example.com/b", text: "beta" },
  ]);
});

test("mapWebSearchProviderError aligns retryable provider failures with Cursor", () => {
  for (const status of [429, 500, 503]) {
    assert.deepEqual(
      mapWebSearchProviderError(Object.assign(new Error(`failed provider_status=${status}`), { status })),
      { case: "error", value: { error: WEB_SEARCH_PROVIDER_ERROR_MESSAGE } },
    );
  }
  assert.deepEqual(
    mapWebSearchProviderError(new Error("Web search requires a non-empty search_term")),
    { case: "error", value: { error: "Web search requires a non-empty search_term" } },
  );
});

test("searchWebWithExa posts official-shaped Exa request and maps success completion", async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        output: { content: "Answer from Exa" },
        results: [{ title: "Result", url: "https://example.com", text: "details" }],
      }),
    };
  };
  const result = await searchWebWithExa({
    searchTerm: "Cursor web search",
    config: {
      provider: "exa",
      apiKey: "test-key",
      baseUrl: "https://api.exa.ai",
      numResults: 8,
      type: "fast",
    },
    fetchFn,
  });
  assert.equal(result.answer, "Answer from Exa");
  assert.equal(result.documents.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "Cursor web search",
    type: "fast",
    numResults: 8,
    outputSchema: {
      type: "text",
      description: "A concise answer with sources for the search query.",
    },
    contents: { text: true },
  });
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");

  const completion = await webSearchCompletionFromExa({
    searchTerm: "Cursor web search",
    config: {
      provider: "exa",
      apiKey: "test-key",
      baseUrl: "https://api.exa.ai",
      numResults: 8,
      type: "fast",
    },
    fetchFn,
  });
  assert.deepEqual(completion, {
    case: "success",
    value: {
      references: [{
        title: "Web search results",
        url: "",
        chunk: "Answer from Exa",
      }],
    },
  });
});

test("handleClientToolCompletion executes Exa directly when configured", async () => {
  const { ByokServer } = require("../src/server/http");
  const { quietLog } = require("./byok-fixtures");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EXA_API_KEY;
  let waited = false;
  process.env.EXA_API_KEY = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({
      output: { content: "Direct Exa answer" },
      results: [],
    }),
  });
  const server = new ByokServer({
    host: "127.0.0.1",
    port: 0,
    log: quietLog(),
    providerAdapter: { async *run() {} },
  });
  server.sessions.waitForClientToolCompletion = async () => {
    waited = true;
    return { case: "success", value: { references: [] } };
  };
  try {
    let resolved;
    const response = {
      headersSent: false,
      writeHead() {
        this.headersSent = true;
      },
      end(body = "") {
        resolved = JSON.parse(String(body));
      },
    };
    await server.handleClientToolCompletion({
      requestId: "req-exa",
      toolCallId: "web-exa",
      toolName: "WebSearch",
      toolArguments: { search_term: "Cursor BYOK" },
    }, response);
    assert.equal(waited, false);
    assert.deepEqual(resolved, {
      ok: true,
      completion: {
        case: "success",
        value: {
          references: [{
            title: "Web search results",
            url: "",
            chunk: "Direct Exa answer",
          }],
        },
      },
    });
  } finally {
    if (originalApiKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
  }
});

test("isWebSearchExaConfigured reflects resolved api key availability", () => {
  const original = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    assert.equal(isWebSearchExaConfigured({ webSearch: { provider: "exa" } }), false);
    assert.equal(isWebSearchExaConfigured({ webSearch: { provider: "exa", apiKey: "k" } }), true);
    process.env.EXA_API_KEY = "env";
    assert.equal(isWebSearchExaConfigured({}), true);
  } finally {
    if (original === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = original;
  }
});