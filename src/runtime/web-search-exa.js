"use strict";

const { normalizeWebSearchQueryArgs } = require("./client-tool-bridge");

const DEFAULT_EXA_BASE_URL = "https://api.exa.ai";
const DEFAULT_EXA_NUM_RESULTS = 10;
const WEB_SEARCH_CHUNK_MAX_CHARS = 30000;
const WEB_SEARCH_PROVIDER_ERROR_MESSAGE = "The web search provider returned an error; this may be temporary. Please try again.";

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const number = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return number;
}

function normalizeWebSearchConfig(providersConfig) {
  const source = providersConfig && typeof providersConfig === "object" && !Array.isArray(providersConfig)
    ? providersConfig.webSearch
    : null;
  const provider = nonEmptyString(source?.provider) || "exa";
  if (provider === "client") return null;
  const apiKey = nonEmptyString(source?.apiKey) || nonEmptyString(process.env.EXA_API_KEY);
  const baseUrl = nonEmptyString(source?.baseUrl) || DEFAULT_EXA_BASE_URL;
  const numResults = normalizePositiveInteger(source?.numResults, DEFAULT_EXA_NUM_RESULTS);
  const searchType = nonEmptyString(source?.type) || "auto";
  if (provider !== "exa" || !apiKey) return null;
  return {
    provider,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    numResults: Math.min(numResults, 100),
    type: searchType,
  };
}

function isWebSearchExaConfigured(providersConfig) {
  return normalizeWebSearchConfig(providersConfig) !== null;
}

function searchTermFromToolArguments(toolArguments, toolCallId = "") {
  const args = typeof toolArguments === "string"
    ? (() => {
      try {
        return JSON.parse(toolArguments);
      } catch {
        return {};
      }
    })()
    : toolArguments;
  return normalizeWebSearchQueryArgs(args, toolCallId).searchTerm.trim();
}

function providerStatusFromError(error) {
  if (!error || typeof error !== "object") return undefined;
  if (Number.isInteger(error.status) && error.status > 0) return error.status;
  const cause = error.cause;
  if (cause && typeof cause === "object" && Number.isInteger(cause.status) && cause.status > 0) {
    return cause.status;
  }
  const match = stringArg(error.message).match(/provider_status=(\d{3})/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function isRetryableProviderStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500);
}

function mapWebSearchProviderError(error) {
  const status = providerStatusFromError(error);
  if (status !== undefined && isRetryableProviderStatus(status)) {
    return {
      case: "error",
      value: { error: WEB_SEARCH_PROVIDER_ERROR_MESSAGE },
    };
  }
  const message = stringArg(error?.message, "Web search failed");
  return {
    case: "error",
    value: { error: message },
  };
}

function exaDocumentsFromResponse(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const documents = [];
  const seen = new Set();
  for (const result of results) {
    const url = stringArg(result?.url).trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    documents.push({
      url,
      title: stringArg(result?.title, url),
      text: stringArg(result?.text),
    });
  }
  return documents;
}

function exaAnswerFromResponse(payload) {
  const outputContent = stringArg(payload?.output?.content).trim();
  if (outputContent) return outputContent;
  const context = stringArg(payload?.context).trim();
  return context || undefined;
}

function buildWebSearchReferences({ answer, documents }) {
  const references = [];
  const normalizedAnswer = typeof answer === "string" && answer !== "" ? answer : undefined;
  if (normalizedAnswer !== undefined) {
    references.push({
      title: "Web search results",
      url: "",
      chunk: normalizedAnswer,
    });
  }
  for (const document of documents) {
    if (normalizedAnswer !== undefined) continue;
    const chunk = stringArg(document.text).slice(0, WEB_SEARCH_CHUNK_MAX_CHARS);
    references.push({
      title: stringArg(document.title, document.url),
      url: document.url,
      chunk,
    });
  }
  return references;
}

function webSearchSuccessCompletion({ answer, documents }) {
  return {
    case: "success",
    value: {
      references: buildWebSearchReferences({ answer, documents }),
    },
  };
}

async function searchWebWithExa({ searchTerm, config, fetchFn = globalThis.fetch }) {
  const query = stringArg(searchTerm).trim();
  if (!query) {
    throw new Error("Web search requires a non-empty search_term");
  }
  const resolved = config || normalizeWebSearchConfig({});
  if (!resolved?.apiKey) {
    throw new Error("Exa web search is not configured");
  }
  const response = await fetchFn(`${resolved.baseUrl}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": resolved.apiKey,
    },
    body: JSON.stringify({
      query,
      type: resolved.type,
      numResults: resolved.numResults,
      outputSchema: {
        type: "text",
        description: "A concise answer with sources for the search query.",
      },
      contents: {
        text: true,
      },
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(`Exa search failed: ${response.status} ${response.statusText}`);
    error.status = response.status;
    if (bodyText) error.message += `\n${bodyText}`;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    const parseError = new Error(`Exa search returned invalid JSON: ${error.message}`);
    parseError.cause = error;
    throw parseError;
  }
  return {
    answer: exaAnswerFromResponse(payload),
    documents: exaDocumentsFromResponse(payload),
  };
}

async function webSearchCompletionFromExa({
  searchTerm,
  config,
  fetchFn = globalThis.fetch,
}) {
  try {
    const result = await searchWebWithExa({ searchTerm, config, fetchFn });
    return webSearchSuccessCompletion(result);
  } catch (error) {
    return mapWebSearchProviderError(error);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  DEFAULT_EXA_BASE_URL,
  DEFAULT_EXA_NUM_RESULTS,
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
  webSearchSuccessCompletion,
};