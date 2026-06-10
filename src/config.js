"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CATALOG_FILE,
  CONFIG_DIR_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_REDIRECTS,
  HOOK_STATE_FILE,
  LEGACY_DEFAULT_REDIRECTS,
  LOG_FILE,
  PREVIOUS_TRANSPORT_ONLY_REDIRECTS,
  PROVIDERS_FILE,
  ROUTES_FILE,
  WORKBENCH_BACKUP_DIR,
} = require("./constants");

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function configDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function providersPath() {
  return path.join(configDir(), PROVIDERS_FILE);
}

function routesPath() {
  return path.join(configDir(), ROUTES_FILE);
}

function logPath() {
  return path.join(configDir(), LOG_FILE);
}

function hookStatePath() {
  return path.join(configDir(), HOOK_STATE_FILE);
}

function workbenchBackupDir() {
  return path.join(configDir(), WORKBENCH_BACKUP_DIR);
}

function catalogSourcePath() {
  return path.join(repoRoot(), CATALOG_FILE);
}

function defaultProvidersConfig() {
  return {
    schemaVersion: 1,
    webFetch: {
      provider: "builtin",
    },
    webSearch: {
      provider: "exa",
    },
    providers: []
  };
}

function loadProviders() {
  return readJsonFile(providersPath(), defaultProvidersConfig());
}

function loadRoutes() {
  const routes = readJsonFile(routesPath(), null);
  return normalizeRoutes(routes || {});
}

function ensureConfigFiles() {
  ensureDir(configDir());
  if (!fs.existsSync(providersPath())) {
    writeJsonFile(providersPath(), defaultProvidersConfig());
  }
  const currentRoutes = readJsonFile(routesPath(), null);
  const normalizedRoutes = normalizeRoutes(currentRoutes || {});
  if (!currentRoutes || JSON.stringify(currentRoutes) !== JSON.stringify(normalizedRoutes)) {
    writeJsonFile(routesPath(), normalizedRoutes);
  }
  const catalogDestination = path.join(configDir(), CATALOG_FILE);
  if (!fs.existsSync(catalogDestination) && fs.existsSync(catalogSourcePath())) {
    fs.copyFileSync(catalogSourcePath(), catalogDestination);
  }
}

function normalizeWebFetchConfigEntry(webFetch) {
  if (!webFetch || typeof webFetch !== "object" || Array.isArray(webFetch)) return undefined;
  const provider = nonEmptyString(webFetch.provider) || "builtin";
  const apiKey = nonEmptyString(webFetch.apiKey);
  const baseUrl = nonEmptyString(webFetch.baseUrl);
  const normalized = { provider };
  if (apiKey) normalized.apiKey = apiKey;
  if (baseUrl) normalized.baseUrl = baseUrl;
  return normalized;
}

function normalizeWebSearchConfigEntry(webSearch) {
  if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch)) return undefined;
  const provider = nonEmptyString(webSearch.provider) || "exa";
  const apiKey = nonEmptyString(webSearch.apiKey);
  const baseUrl = nonEmptyString(webSearch.baseUrl);
  const searchType = nonEmptyString(webSearch.type);
  const parsedNumResults = typeof webSearch.numResults === "number"
    ? webSearch.numResults
    : typeof webSearch.numResults === "string" && /^\d+$/.test(webSearch.numResults.trim())
      ? Number.parseInt(webSearch.numResults.trim(), 10)
      : undefined;
  const numResults = Number.isInteger(parsedNumResults) && parsedNumResults > 0
    ? Math.min(parsedNumResults, 100)
    : undefined;
  const normalized = { provider };
  if (apiKey) normalized.apiKey = apiKey;
  if (baseUrl) normalized.baseUrl = baseUrl;
  if (searchType) normalized.type = searchType;
  if (numResults !== undefined) normalized.numResults = numResults;
  return normalized;
}

function normalizeProvidersConfig(providersConfig) {
  const providers = Array.isArray(providersConfig)
    ? providersConfig
    : Array.isArray(providersConfig?.providers)
      ? providersConfig.providers
      : [];
  const normalized = {
    schemaVersion: 1,
    providers: providers.map(normalizeProviderConfig).filter(Boolean),
  };
  const webSearch = normalizeWebSearchConfigEntry(providersConfig?.webSearch);
  if (webSearch) normalized.webSearch = webSearch;
  const webFetch = normalizeWebFetchConfigEntry(providersConfig?.webFetch);
  if (webFetch) normalized.webFetch = webFetch;
  return normalized;
}

function normalizeProviderConfig(provider) {
  if (!provider || typeof provider !== "object") return null;
  const id = nonEmptyString(provider.id) || slugify(provider.name) || "provider";
  const normalized = {
    ...provider,
    id,
    name: nonEmptyString(provider.name) || id,
    type: nonEmptyString(provider.type) || "openai-chat",
    models: Array.isArray(provider.models) ? provider.models.map(normalizeModelConfig).filter(Boolean) : [],
  };
  assignString(normalized, "baseUrl", provider.baseUrl);
  const authValue = nonEmptyString(provider.auth?.value);
  if (authValue) {
    const authKind = normalizeAuthKind(provider.auth?.kind);
    normalized.auth = authKind ? { kind: authKind, value: authValue } : { value: authValue };
  } else {
    delete normalized.auth;
  }
  if (provider.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers)) {
    normalized.headers = provider.headers;
  } else {
    delete normalized.headers;
  }
  return normalized;
}

function normalizeModelConfig(model) {
  if (!model || typeof model !== "object") return null;
  const id = nonEmptyString(model.id) || nonEmptyString(model.apiModel) || nonEmptyString(model.displayName);
  if (!id) return null;
  const normalized = { ...model, id };
  assignString(normalized, "apiModel", model.apiModel);
  assignString(normalized, "name", model.name);
  assignString(normalized, "displayName", model.displayName);
  assignString(normalized, "clientDisplayName", model.clientDisplayName);
  assignString(normalized, "serverModelName", model.serverModelName);
  assignString(normalized, "inputboxShortModelName", model.inputboxShortModelName);
  assignString(normalized, "legacyId", model.legacyId);
  assignString(normalized, "tooltipMarkdown", model.tooltipMarkdown);
  assignString(normalized, "thinkingLevel", model.thinkingLevel);
  assignString(normalized, "vendorName", model.vendorName);
  assignStringArray(normalized, "legacySlugs", model.legacySlugs);
  assignStringArray(normalized, "idAliases", model.idAliases);
  assignPositiveInteger(normalized, "contextTokenLimit", model.contextTokenLimit);
  assignPositiveInteger(normalized, "contextTokenLimitForMaxMode", model.contextTokenLimitForMaxMode);
  assignPositiveInteger(normalized, "maxOutputTokens", model.maxOutputTokens);
  assignPositiveInteger(normalized, "thinkingBudgetTokens", model.thinkingBudgetTokens);
  assignBoolean(normalized, "defaultOn", model.defaultOn);
  assignBoolean(normalized, "supportsAgent", model.supportsAgent);
  assignBoolean(normalized, "supportsImages", model.supportsImages);
  assignBoolean(normalized, "supportsCmdK", model.supportsCmdK);
  assignBoolean(normalized, "supportsPlan", model.supportsPlan);
  assignBoolean(normalized, "supportsAutoContext", model.supportsAutoContext);
  assignBoolean(normalized, "supportsMaxMode", model.supportsMaxMode);
  assignBoolean(normalized, "supportsNonMaxMode", model.supportsNonMaxMode);
  assignBoolean(normalized, "visibleInRoutedModelView", model.visibleInRoutedModelView);
  assignBoolean(normalized, "thinking", model.thinking);
  return normalized;
}

function assignString(target, key, value) {
  const text = nonEmptyString(value);
  if (text) target[key] = text;
  else delete target[key];
}

function assignPositiveInteger(target, key, value) {
  const number = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (Number.isInteger(number) && number > 0) target[key] = number;
  else delete target[key];
}

function assignBoolean(target, key, value) {
  if (typeof value === "boolean") target[key] = value;
  else delete target[key];
}

function assignStringArray(target, key, value) {
  if (!Array.isArray(value)) {
    delete target[key];
    return;
  }
  const out = [];
  for (const item of value) {
    const text = nonEmptyString(item);
    if (text) out.push(text);
  }
  if (out.length) target[key] = out;
  else delete target[key];
}

function normalizeAuthKind(value) {
  const text = nonEmptyString(value);
  return text === "bearer" || text === "api-key" ? text : "";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function slugify(value) {
  return nonEmptyString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeRoutes(routes) {
  const redirectSource = Array.isArray(routes.redirect) && routes.redirect.length
    ? routes.redirect
    : DEFAULT_REDIRECTS;
  let redirect = normalizeRedirects(redirectSource);
  if (
    !redirect.length
    || sameRouteSet(redirect, LEGACY_DEFAULT_REDIRECTS)
    || sameRouteSet(redirect, PREVIOUS_TRANSPORT_ONLY_REDIRECTS)
  ) {
    redirect = [...DEFAULT_REDIRECTS];
  }
  return {
    schemaVersion: 1,
    byokMode: routes.byokMode === 0 ? 0 : 1,
    server: {
      host: routes.server?.host || DEFAULT_HOST,
      port: Number.isInteger(routes.server?.port) ? routes.server.port : DEFAULT_PORT,
    },
    redirect,
  };
}

function normalizeRedirects(redirects) {
  const out = [];
  const seen = new Set();
  for (const route of Array.isArray(redirects) ? redirects : []) {
    const text = nonEmptyString(route);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function sameRouteSet(left, right) {
  const a = normalizeRedirects(left);
  const b = normalizeRedirects(right);
  if (a.length !== b.length) return false;
  const rightSet = new Set(b);
  return a.every((route) => rightSet.has(route));
}

function writeRoutes(routes) {
  writeJsonFile(routesPath(), normalizeRoutes(routes));
}

module.exports = {
  catalogSourcePath,
  configDir,
  defaultProvidersConfig,
  ensureConfigFiles,
  hookStatePath,
  loadProviders,
  loadRoutes,
  logPath,
  normalizeModelConfig,
  normalizeAuthKind,
  normalizeProviderConfig,
  normalizeProvidersConfig,
  normalizeWebSearchConfigEntry,
  normalizeWebFetchConfigEntry,
  normalizeRoutes,
  providersPath,
  readJsonFile,
  routesPath,
  slugify,
  workbenchBackupDir,
  writeJsonFile,
  writeRoutes,
};
