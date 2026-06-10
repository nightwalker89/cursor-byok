"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_REDIRECTS, LEGACY_DEFAULT_REDIRECTS } = require("../src/constants");

const {
  defaultProvidersConfig,
  normalizeRoutes,
  normalizeProvidersConfig,
  normalizeAuthKind,
  normalizeProviderConfig,
  normalizeModelConfig,
  slugify,
} = require("../src/config");

// Pure config normalization — no vscode, no filesystem. These exercise the
// helpers that moved out of extension.js so they are independently testable.

test("defaultProvidersConfig returns a fresh, non-shared object each call", () => {
  const a = defaultProvidersConfig();
  const b = defaultProvidersConfig();
  assert.notEqual(a, b);
  assert.notEqual(a.providers, b.providers);
  assert.equal(a.schemaVersion, 1);
  assert.deepEqual(a.providers, []);
  a.providers.push({ id: "mutated" });
  assert.deepEqual(b.providers, []);
});

test("normalizeProvidersConfig accepts an array, a {providers} object, or garbage", () => {
  const fromArray = normalizeProvidersConfig([{ id: "p", name: "P" }]);
  assert.equal(fromArray.schemaVersion, 1);
  assert.equal(fromArray.providers.length, 1);

  const fromObject = normalizeProvidersConfig({ providers: [{ id: "p", name: "P" }] });
  assert.equal(fromObject.providers.length, 1);

  for (const garbage of [null, undefined, 42, "nope", { providers: "not-array" }]) {
    assert.deepEqual(normalizeProvidersConfig(garbage), { schemaVersion: 1, providers: [] });
  }
});

test("normalizeProviderConfig derives id from name when id is missing", () => {
  const provider = normalizeProviderConfig({ name: "My Cool Provider!" });
  assert.equal(provider.id, "my-cool-provider");
  assert.equal(provider.name, "My Cool Provider!");
  assert.equal(provider.type, "openai-chat");
  assert.deepEqual(provider.models, []);
});

test("normalizeProviderConfig trims auth value while preserving supported auth kind", () => {
  const provider = normalizeProviderConfig({
    id: "p",
    auth: { kind: "api-key", value: "  secret  " },
    headers: { "x-test": "1" },
    baseUrl: "https://example.com",
  });
  assert.deepEqual(provider.auth, { kind: "api-key", value: "secret" });
  assert.deepEqual(provider.headers, { "x-test": "1" });
  assert.equal(provider.baseUrl, "https://example.com");
});

test("normalizeProviderConfig omits unsupported auth kind instead of saving bad header mode", () => {
  const provider = normalizeProviderConfig({
    id: "p",
    auth: { kind: "token", value: "secret" },
  });
  assert.deepEqual(provider.auth, { value: "secret" });
});

test("normalizeProviderConfig drops empty and invalid normalized provider fields while preserving extensions", () => {
  const provider = normalizeProviderConfig({
    id: "p",
    baseUrl: "  ",
    auth: { kind: "api-key", value: "  " },
    headers: [],
    models: [],
    customProviderOption: { enabled: true },
  });
  assert.equal(provider.baseUrl, undefined);
  assert.equal(provider.auth, undefined);
  assert.equal(provider.headers, undefined);
  assert.deepEqual(provider.customProviderOption, { enabled: true });
});

test("normalizeProviderConfig rejects null and non-object entries", () => {
  assert.equal(normalizeProviderConfig(null), null);
  assert.equal(normalizeProviderConfig(undefined), null);
  assert.equal(normalizeProviderConfig(42), null);
  assert.equal(normalizeProviderConfig("x"), null);
});

test("normalizeModelConfig falls back id to apiModel then displayName, else drops the model", () => {
  assert.equal(normalizeModelConfig({ apiModel: "gpt-x" }).id, "gpt-x");
  assert.equal(normalizeModelConfig({ displayName: "Shiny" }).id, "Shiny");
  assert.equal(normalizeModelConfig({}), null);
  assert.equal(normalizeModelConfig({ id: "  " }), null);
});

test("normalizeModelConfig coerces numeric-string token limits to integers", () => {
  const model = normalizeModelConfig({
    id: "m",
    contextTokenLimit: "1000",
    maxOutputTokens: 8192,
    supportsAgent: true,
  });
  assert.equal(model.contextTokenLimit, 1000); // numeric string -> integer
  assert.equal(model.maxOutputTokens, 8192);
  assert.equal(model.supportsAgent, true);
});

test("normalizeModelConfig preserves supported model metadata and unknown model extensions", () => {
  const model = normalizeModelConfig({
    id: "m",
    apiModel: "  upstream-m  ",
    name: "Model Name",
    displayName: "Display",
    clientDisplayName: " Client Display ",
    serverModelName: "server-m",
    inputboxShortModelName: "Short",
    legacyId: "legacy-m",
    legacySlugs: [" old ", "", 9],
    idAliases: [" alias ", "", 10],
    tooltipMarkdown: "tooltip",
    thinkingLevel: "high",
    vendorName: "Vendor",
    contextTokenLimit: "bad",
    contextTokenLimitForMaxMode: "2000",
    maxOutputTokens: "3000",
    thinkingBudgetTokens: "400",
    defaultOn: false,
    supportsAgent: false,
    supportsImages: true,
    supportsCmdK: true,
    supportsPlan: true,
    supportsAutoContext: true,
    supportsMaxMode: false,
    supportsNonMaxMode: false,
    visibleInRoutedModelView: true,
    thinking: true,
    customModelOption: { routingHint: "keep" },
  });
  assert.deepEqual(model, {
    id: "m",
    apiModel: "upstream-m",
    name: "Model Name",
    displayName: "Display",
    clientDisplayName: "Client Display",
    serverModelName: "server-m",
    inputboxShortModelName: "Short",
    legacyId: "legacy-m",
    tooltipMarkdown: "tooltip",
    thinkingLevel: "high",
    vendorName: "Vendor",
    legacySlugs: ["old"],
    idAliases: ["alias"],
    contextTokenLimitForMaxMode: 2000,
    maxOutputTokens: 3000,
    thinkingBudgetTokens: 400,
    defaultOn: false,
    supportsAgent: false,
    supportsImages: true,
    supportsCmdK: true,
    supportsPlan: true,
    supportsAutoContext: true,
    supportsMaxMode: false,
    supportsNonMaxMode: false,
    visibleInRoutedModelView: true,
    thinking: true,
    customModelOption: { routingHint: "keep" },
  });
});

test("slugify lowercases, collapses non-alphanumerics, and trims dashes", () => {
  assert.equal(slugify("  Hello, World!! "), "hello-world");
  assert.equal(slugify("___mixed--CASE__"), "mixed-case");
  assert.equal(slugify(""), "");
});

test("normalizeAuthKind accepts only supported provider auth modes", () => {
  assert.equal(normalizeAuthKind("bearer"), "bearer");
  assert.equal(normalizeAuthKind("api-key"), "api-key");
  assert.equal(normalizeAuthKind(" api-key "), "api-key");
  assert.equal(normalizeAuthKind("token"), "");
  assert.equal(normalizeAuthKind(undefined), "");
});

test("normalizeRoutes migrates the legacy broad default redirect set to auth plus transport defaults", () => {
  const normalized = normalizeRoutes({
    schemaVersion: 1,
    byokMode: 1,
    server: { host: "127.0.0.1", port: 9960 },
    redirect: [...LEGACY_DEFAULT_REDIRECTS],
  });
  assert.deepEqual(normalized.redirect, DEFAULT_REDIRECTS);
});

test("normalizeRoutes preserves explicit custom redirect sets", () => {
  const custom = [
    "agent.v1.AgentService/RunSSE",
    "REST:/auth/poll",
    "/custom-route",
  ];
  const normalized = normalizeRoutes({
    schemaVersion: 1,
    byokMode: 1,
    server: { host: "127.0.0.1", port: 9960 },
    redirect: custom,
  });
  assert.deepEqual(normalized.redirect, custom);
});
