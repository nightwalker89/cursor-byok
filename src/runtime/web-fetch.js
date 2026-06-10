"use strict";

const WEB_FETCH_MAX_CHARS = 30000;
const WEB_FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
const WEB_FETCH_MAX_REDIRECTS = 5;
const WEB_FETCH_TIMEOUT_MS = 60000;
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_JINA_READER_BASE_URL = "https://r.jina.ai";
const DEFAULT_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; CursorBYOK/1.0; +https://cursor.com)";

let supermarkdownModule = undefined;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringArg(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeWebFetchConfig(providersConfig) {
  const source = providersConfig && typeof providersConfig === "object" && !Array.isArray(providersConfig)
    ? providersConfig.webFetch
    : null;
  const provider = nonEmptyString(source?.provider) || "builtin";
  if (provider === "builtin") {
    return { provider: "builtin" };
  }
  if (provider === "jina") {
    const apiKey = nonEmptyString(source?.apiKey) || nonEmptyString(process.env.JINA_API_KEY);
    if (!apiKey) return null;
    const baseUrl = nonEmptyString(source?.baseUrl) || DEFAULT_JINA_READER_BASE_URL;
    return { provider: "jina", apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
  }
  if (provider === "firecrawl") {
    const apiKey = nonEmptyString(source?.apiKey) || nonEmptyString(process.env.FIRECRAWL_API_KEY);
    if (!apiKey) return null;
    const baseUrl = nonEmptyString(source?.baseUrl) || DEFAULT_FIRECRAWL_BASE_URL;
    return { provider: "firecrawl", apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
  }
  return null;
}

function isWebFetchServerConfigured(providersConfig) {
  return normalizeWebFetchConfig(providersConfig) !== null;
}

function describeWebFetchMisconfiguration(providersConfig) {
  const source = providersConfig && typeof providersConfig === "object" && !Array.isArray(providersConfig)
    ? providersConfig.webFetch
    : null;
  const provider = nonEmptyString(source?.provider) || "builtin";
  if (provider === "builtin") return null;
  if (normalizeWebFetchConfig(providersConfig)) return null;
  if (provider === "jina") return "Jina API key is required for server-side WebFetch";
  if (provider === "firecrawl") return "Firecrawl API key is required for server-side WebFetch";
  return `Unknown web fetch provider: ${provider}`;
}

function urlFromToolArguments(toolArguments) {
  const args = typeof toolArguments === "string"
    ? (() => {
      try {
        return JSON.parse(toolArguments);
      } catch {
        return {};
      }
    })()
    : toolArguments;
  return nonEmptyString(args?.url);
}

function truncateFetchMarkdown(text, limit = WEB_FETCH_MAX_CHARS) {
  if (typeof text !== "string" || text.length <= limit) return typeof text === "string" ? text : "";
  const droppedLines = (text.slice(limit).match(/\n/g) || []).length + 1;
  return `${text.slice(0, limit)}\n\n...[${droppedLines} line${droppedLines === 1 ? "" : "s"} truncated]`;
}

function decodeNumericEntity(num) {
  const code = Number.parseInt(num, 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeHexEntity(hex) {
  const code = Number.parseInt(hex, 16);
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeHexEntity(hex))
    .replace(/&#(\d+);/g, (_, num) => decodeNumericEntity(num))
    .replace(/&amp;/gi, "&");
}

function stripHtmlToMarkdown(html, baseUrl) {
  let text = String(html || "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const hashes = "#".repeat(Math.min(6, Math.max(1, Number.parseInt(level, 10))));
    return `\n\n${hashes} ${body.replace(/<[^>]+>/g, "").trim()}\n\n`;
  });
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = body.replace(/<[^>]+>/g, "").trim();
    let resolved = href;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      resolved = href;
    }
    return label ? `[${label}](${resolved})` : resolved;
  });
  text = text.replace(/<(?:p|div|section|article|main|header|footer|li|br)\b[^>]*>/gi, "\n");
  text = text.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code}\``);
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities once, after all tags are stripped, so escaped markup (e.g.
  // `&lt;div&gt;`) becomes literal text instead of being re-parsed and dropped
  // as a tag, and double-escaped content is decoded exactly one level.
  text = decodeHtmlEntities(text);
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function loadSupermarkdown() {
  if (supermarkdownModule !== undefined) return supermarkdownModule;
  try {
    supermarkdownModule = require("@vakra-dev/supermarkdown");
  } catch {
    supermarkdownModule = null;
  }
  return supermarkdownModule;
}

async function htmlToMarkdown(html, baseUrl) {
  const supermarkdown = loadSupermarkdown();
  const convertAsync = typeof supermarkdown?.convertAsync === "function"
    ? supermarkdown.convertAsync
    : supermarkdown?.default?.convertAsync;
  if (typeof convertAsync === "function") {
    try {
      const converted = await convertAsync(html, { baseUrl });
      if (typeof converted === "string" && converted.trim()) return converted.trim();
    } catch {
      // Fall back to the built-in converter when supermarkdown fails.
    }
  }
  const convert = typeof supermarkdown?.convert === "function"
    ? supermarkdown.convert
    : supermarkdown?.default?.convert;
  if (typeof convert === "function") {
    try {
      const converted = convert(html, { baseUrl });
      if (typeof converted === "string" && converted.trim()) return converted.trim();
    } catch {
      // Fall back to the built-in converter when supermarkdown fails.
    }
  }
  return stripHtmlToMarkdown(html, baseUrl);
}

function normalizeHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function isPrivateOrLocalIpv4(parts) {
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateOrLocalHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;

  const ipv4MappedDotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedDotted) {
    const parts = ipv4MappedDotted[1].split(".").map((part) => Number.parseInt(part, 10));
    return isPrivateOrLocalIpv4(parts);
  }
  const ipv4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (ipv4MappedHex) {
    const high = Number.parseInt(ipv4MappedHex[1], 16);
    const low = Number.parseInt(ipv4MappedHex[2], 16);
    const parts = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
    return isPrivateOrLocalIpv4(parts);
  }

  if (host.includes(":")) {
    if (/^fe[89ab][0-9a-f]{0,2}:/i.test(host)) return true;
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true;
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;
  return isPrivateOrLocalIpv4(ipv4Match.slice(1).map((part) => Number.parseInt(part, 10)));
}

function validateFetchUrl(rawUrl) {
  const text = nonEmptyString(rawUrl);
  if (!text) throw new Error("WebFetch requires a non-empty url");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid URL: ${text}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error("Fetching localhost or private network URLs is not supported");
  }
  return parsed.toString();
}

function isBinaryContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (!type) return false;
  if (type.startsWith("text/")) return false;
  if (type.includes("json") || type.includes("xml") || type.includes("javascript")) return false;
  if (type.includes("html")) return false;
  return type.includes("image/") || type.includes("audio/") || type.includes("video/")
    || type.includes("application/pdf") || type.includes("application/octet-stream")
    || type.includes("application/zip");
}

function createFetchAbortSignal(timeoutMs) {
  const ms = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : WEB_FETCH_TIMEOUT_MS;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Web fetch timed out after ${ms}ms`)), ms);
  if (typeof timer.unref === "function") timer.unref();
  return controller.signal;
}

async function readResponseTextLimited(response, maxBytes = WEB_FETCH_MAX_BODY_BYTES) {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`Response body too large (${length} bytes)`);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error(`Response body too large (>${maxBytes} bytes)`);
    }
    return body;
  }

  const chunks = [];
  let total = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Response body too large (>${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return decoder.decode(Buffer.concat(chunks));
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithValidatedRedirects(url, init, fetchFn, options = {}) {
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : WEB_FETCH_MAX_REDIRECTS;
  let current = validateFetchUrl(url);
  let response;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    response = await fetchFn(current, { ...init, redirect: "manual" });
    if (!isRedirectStatus(response.status)) {
      return { response, url: current };
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect response ${response.status} missing Location header`);
    current = validateFetchUrl(new URL(location, current).toString());
  }
  throw new Error(`Too many redirects while fetching ${url}`);
}

function webFetchSuccessCompletion({ url, markdown }) {
  return {
    case: "success",
    value: {
      url,
      markdown: truncateFetchMarkdown(markdown),
    },
  };
}

function mapWebFetchProviderError(error) {
  const message = stringArg(error?.message, "Web fetch failed");
  return {
    case: "error",
    value: { error: message },
  };
}

async function fetchBuiltinMarkdown(url, fetchFn = globalThis.fetch, options = {}) {
  const signal = options.signal || createFetchAbortSignal(options.timeoutMs);
  const { response, url: resolvedUrl } = await fetchWithValidatedRedirects(url, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_FETCH_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
    signal,
  }, fetchFn, options);
  if (!response.ok) {
    throw new Error(`URL returned status ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (isBinaryContentType(contentType)) {
    throw new Error("This tool does not support fetching binary content");
  }
  const body = await readResponseTextLimited(response, options.maxBodyBytes);
  if (!body.trim()) throw new Error("Fetched page was empty");
  return htmlToMarkdown(body, resolvedUrl);
}

async function fetchJinaMarkdown(url, config, fetchFn = globalThis.fetch, options = {}) {
  const signal = options.signal || createFetchAbortSignal(options.timeoutMs);
  const target = `${config.baseUrl}/${url}`;
  const { response } = await fetchWithValidatedRedirects(target, {
    method: "GET",
    headers: {
      Accept: "text/markdown,text/plain,*/*",
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal,
  }, fetchFn, options);
  const body = await readResponseTextLimited(response, options.maxBodyBytes);
  if (!response.ok) {
    throw new Error(`Jina fetch failed: ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
  }
  if (!body.trim()) throw new Error("Jina returned empty content");
  return body.trim();
}

async function fetchFirecrawlMarkdown(url, config, fetchFn = globalThis.fetch, options = {}) {
  const signal = options.signal || createFetchAbortSignal(options.timeoutMs);
  const response = await fetchFn(`${config.baseUrl}/v1/scrape`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
    }),
    redirect: "manual",
    signal,
  });
  const bodyText = await readResponseTextLimited(response, options.maxBodyBytes);
  if (!response.ok) {
    throw new Error(`Firecrawl fetch failed: ${response.status}${bodyText ? ` ${bodyText.slice(0, 200)}` : ""}`);
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Firecrawl returned invalid JSON: ${error.message}`);
  }
  const markdown = nonEmptyString(payload?.data?.markdown)
    || nonEmptyString(payload?.markdown)
    || nonEmptyString(payload?.data?.content);
  if (!markdown) throw new Error("Firecrawl returned no markdown content");
  return markdown;
}

async function fetchWebMarkdown({ url, config, fetchFn = globalThis.fetch, timeoutMs, signal, maxBodyBytes }) {
  const normalizedUrl = validateFetchUrl(url);
  const resolved = config || normalizeWebFetchConfig({ webFetch: { provider: "builtin" } });
  const fetchOptions = { timeoutMs, signal, maxBodyBytes };
  switch (resolved.provider) {
    case "builtin":
      return { url: normalizedUrl, markdown: await fetchBuiltinMarkdown(normalizedUrl, fetchFn, fetchOptions) };
    case "jina":
      return { url: normalizedUrl, markdown: await fetchJinaMarkdown(normalizedUrl, resolved, fetchFn, fetchOptions) };
    case "firecrawl":
      return { url: normalizedUrl, markdown: await fetchFirecrawlMarkdown(normalizedUrl, resolved, fetchFn, fetchOptions) };
    default:
      throw new Error(`Unknown web fetch provider: ${resolved.provider}`);
  }
}

async function webFetchCompletion({
  url,
  config,
  fetchFn = globalThis.fetch,
  timeoutMs,
  signal,
  maxBodyBytes,
}) {
  try {
    const result = await fetchWebMarkdown({ url, config, fetchFn, timeoutMs, signal, maxBodyBytes });
    return webFetchSuccessCompletion(result);
  } catch (error) {
    return mapWebFetchProviderError(error);
  }
}

module.exports = {
  DEFAULT_FETCH_USER_AGENT,
  DEFAULT_FIRECRAWL_BASE_URL,
  DEFAULT_JINA_READER_BASE_URL,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_MAX_BODY_BYTES,
  WEB_FETCH_TIMEOUT_MS,
  describeWebFetchMisconfiguration,
  fetchWebMarkdown,
  htmlToMarkdown,
  isWebFetchServerConfigured,
  mapWebFetchProviderError,
  normalizeWebFetchConfig,
  truncateFetchMarkdown,
  urlFromToolArguments,
  validateFetchUrl,
  webFetchCompletion,
  webFetchSuccessCompletion,
};