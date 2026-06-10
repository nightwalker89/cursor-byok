"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeProvidersConfig } = require("../src/config");
const {
  describeWebFetchMisconfiguration,
  htmlToMarkdown,
  isWebFetchServerConfigured,
  normalizeWebFetchConfig,
  truncateFetchMarkdown,
  urlFromToolArguments,
  validateFetchUrl,
  webFetchCompletion,
} = require("../src/runtime/web-fetch");

test("normalizeWebFetchConfig defaults to builtin and resolves provider keys", () => {
  assert.deepEqual(normalizeWebFetchConfig({ webFetch: { provider: "builtin" } }), {
    provider: "builtin",
  });
  const originalJina = process.env.JINA_API_KEY;
  const originalFirecrawl = process.env.FIRECRAWL_API_KEY;
  process.env.JINA_API_KEY = "jina-key";
  process.env.FIRECRAWL_API_KEY = "firecrawl-key";
  try {
    assert.deepEqual(normalizeWebFetchConfig({ webFetch: { provider: "jina" } }), {
      provider: "jina",
      apiKey: "jina-key",
      baseUrl: "https://r.jina.ai",
    });
    assert.deepEqual(normalizeWebFetchConfig({
      webFetch: {
        provider: "firecrawl",
        baseUrl: "https://api.firecrawl.dev/",
      },
    }), {
      provider: "firecrawl",
      apiKey: "firecrawl-key",
      baseUrl: "https://api.firecrawl.dev",
    });
    const savedJina = process.env.JINA_API_KEY;
    delete process.env.JINA_API_KEY;
    assert.equal(normalizeWebFetchConfig({ webFetch: { provider: "jina", apiKey: "" } }), null);
    process.env.JINA_API_KEY = savedJina;
  } finally {
    if (originalJina === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = originalJina;
    if (originalFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalFirecrawl;
  }
});

test("normalizeProvidersConfig preserves webFetch settings and webSearch secrets for client provider", () => {
  const normalized = normalizeProvidersConfig({
    providers: [{ id: "p", name: "P" }],
    webFetch: { provider: "builtin" },
    webSearch: {
      provider: "client",
      apiKey: "exa-secret",
      baseUrl: "https://api.exa.ai",
      type: "auto",
      numResults: 10,
    },
  });
  assert.deepEqual(normalized.webFetch, { provider: "builtin" });
  assert.deepEqual(normalized.webSearch, {
    provider: "client",
    apiKey: "exa-secret",
    baseUrl: "https://api.exa.ai",
    type: "auto",
    numResults: 10,
  });
});

test("urlFromToolArguments and validateFetchUrl enforce fetchable URLs", () => {
  assert.equal(urlFromToolArguments({ url: "https://example.com/docs" }), "https://example.com/docs");
  assert.equal(urlFromToolArguments("{\"url\":\"https://example.com\"}"), "https://example.com");
  assert.equal(validateFetchUrl("https://example.com/page"), "https://example.com/page");
  assert.throws(() => validateFetchUrl("http://127.0.0.1/secret"), /private network/i);
  assert.throws(() => validateFetchUrl("http://[::ffff:127.0.0.1]/"), /private network/i);
  assert.throws(() => validateFetchUrl("http://[fe80::1]/"), /private network/i);
  assert.throws(() => validateFetchUrl("http://[fd00::1]/"), /private network/i);
  assert.throws(() => validateFetchUrl("ftp://example.com"), /protocol/i);
});

test("validateFetchUrl rejects redirect targets to private networks", async () => {
  const fetchFn = async (url, init) => {
    if (url === "https://example.com/start") {
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => (name.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null) },
        body: null,
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const completion = await webFetchCompletion({
    url: "https://example.com/start",
    config: { provider: "builtin" },
    fetchFn,
    timeoutMs: 5000,
  });
  assert.equal(completion.case, "error");
  assert.match(completion.value.error, /private network/i);
});

test("htmlToMarkdown converts basic HTML and preserves escaped code content", async () => {
  const markdown = await htmlToMarkdown("<html><body><h1>Title</h1><p>Hello <a href=\"/x\">link</a></p></body></html>", "https://example.com");
  assert.match(markdown, /# Title/);
  assert.match(markdown, /\[link\]\(https:\/\/example\.com\/x\)/);
  const escaped = await htmlToMarkdown("<code>&amp;lt;div&amp;gt;</code>", "https://example.com");
  assert.match(escaped, /&lt;div&gt;/);
  const invalidEntity = await htmlToMarkdown("<p>&#xFFFFFFFF;</p>", "https://example.com");
  assert.doesNotMatch(invalidEntity, /RangeError/);
  const long = "a\n".repeat(40000);
  const truncated = truncateFetchMarkdown(long, 100);
  assert.ok(truncated.length < long.length);
  assert.match(truncated, /\.\.\.\[[0-9]+ lines truncated\]/);
});

test("describeWebFetchMisconfiguration reports missing provider keys", () => {
  assert.match(
    describeWebFetchMisconfiguration({ webFetch: { provider: "jina" } }),
    /Jina API key/i,
  );
  assert.match(
    describeWebFetchMisconfiguration({ webFetch: { provider: "firecrawl" } }),
    /Firecrawl API key/i,
  );
  assert.equal(describeWebFetchMisconfiguration({ webFetch: { provider: "builtin" } }), null);
});

test("webFetchCompletion uses builtin fetch and formats fetchResult success", async () => {
  const fetchFn = async (url) => {
    if (url === "https://example.com/article") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html><body><h1>Article</h1><p>Body</p></body></html>",
        body: null,
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const completion = await webFetchCompletion({
    url: "https://example.com/article",
    config: { provider: "builtin" },
    fetchFn,
  });
  assert.equal(completion.case, "success");
  assert.equal(completion.value.url, "https://example.com/article");
  assert.match(completion.value.markdown, /Article/);
  assert.equal(isWebFetchServerConfigured({ webFetch: { provider: "builtin" } }), true);
});

test("webFetchCompletion maps provider failures to fetchResult errors", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => "text/html" },
    text: async () => "missing",
    body: null,
  });
  const completion = await webFetchCompletion({
    url: "https://example.com/missing",
    config: { provider: "builtin" },
    fetchFn,
  });
  assert.equal(completion.case, "error");
  assert.match(completion.value.error, /404/);
});