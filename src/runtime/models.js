"use strict";

function listProviderModels(providersConfig) {
  const providers = Array.isArray(providersConfig?.providers) ? providersConfig.providers : [];
  const models = [];
  for (const provider of providers) {
    if (!provider || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model) continue;
      models.push({ provider, model });
    }
  }
  return models;
}

// Every identifier Cursor can hand back for a configured model. Keep this in
// lockstep with workbench-hook syncByokModelIds so hook-side routing and
// server-side provider lookup make the same decision.
const MODEL_ID_KEYS = [
  "id",
  "apiModel",
  "name",
  "displayName",
  "clientDisplayName",
  "inputboxShortModelName",
  "serverModelName",
  "legacyId",
];

function modelIdCandidates(model) {
  if (!model || typeof model !== "object") return [];
  const out = new Set();
  for (const key of MODEL_ID_KEYS) {
    const value = model[key];
    if (value && value !== "default") out.add(value);
  }
  for (const key of ["legacySlugs", "idAliases"]) {
    if (!Array.isArray(model[key])) continue;
    for (const value of model[key]) {
      if (value && value !== "default") out.add(value);
    }
  }
  return [...out];
}

function byokModelIds(providersConfig) {
  const ids = new Set();
  for (const { model } of listProviderModels(providersConfig)) {
    for (const candidate of modelIdCandidates(model)) ids.add(candidate);
  }
  return ids;
}

function byokPublicModelIds(providersConfig) {
  const ids = new Set();
  for (const { model } of listProviderModels(providersConfig)) {
    addModelId(ids, publicCursorModelId(model));
    addModelId(ids, model.name);
    addModelId(ids, model.displayName);
    addModelId(ids, model.clientDisplayName);
    addModelId(ids, model.inputboxShortModelName);
    addModelId(ids, model.legacyId);
    addModelIds(ids, model.legacySlugs);
    addModelIds(ids, model.idAliases);
  }
  return ids;
}

function addModelId(ids, value) {
  if (typeof value === "string" && value && value !== "default") ids.add(value);
}

function addModelIds(ids, values) {
  if (!Array.isArray(values)) return;
  for (const value of values) addModelId(ids, value);
}

function pickModelId(candidates, providersConfig) {
  const ids = byokModelIds(providersConfig);
  let first = "";
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    if (!first) first = candidate;
    if (ids.has(candidate)) return candidate;
  }
  return first;
}

function findProviderModel(modelId, providersConfig) {
  if (!modelId) return null;
  for (const entry of listProviderModels(providersConfig)) {
    if (modelIdCandidates(entry.model).includes(modelId)) return entry;
  }
  return null;
}

function isByokModel(modelId, providersConfig) {
  return !!findProviderModel(modelId, providersConfig);
}

function sanitizeOfficialModelValue(value, parentKey = "", key = "", depth = 0) {
  if (depth > 12) return undefined;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const clean = sanitizeOfficialModelValue(item, key, "", depth + 1);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value)) {
      const clean = sanitizeOfficialModelValue(value[childKey], key, childKey, depth + 1);
      if (clean !== undefined) out[childKey] = clean;
    }
    return out;
  }
  if (looksLikeEnumToken(value)) {
    const lowerKey = String(key).toLowerCase();
    const lowerParent = String(parentKey).toLowerCase();
    if (
      lowerKey === "degradationstatus" ||
      lowerKey === "degradation_status" ||
      lowerKey === "modelvendorid" ||
      lowerKey === "vendorid" ||
      lowerKey === "status" ||
      lowerKey.includes("status") ||
      (lowerKey.includes("vendor") && lowerKey.includes("id")) ||
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

function toCursorModel(provider, model, namedModelSectionIndex = 2) {
  const contextTokenLimit = integerOr(model.contextTokenLimit, 128000);
  const maxOutputTokens = integerOr(model.maxOutputTokens, 8192);
  const id = publicCursorModelId(model);
  const name = model.displayName || model.name || id;
  const legacySlugs = legacySlugsFor(model, id);
  const out = {
    id,
    name,
    displayName: name,
    clientDisplayName: name,
    inputboxShortModelName: model.inputboxShortModelName || name,
    apiModel: model.apiModel || id,
    serverModelName: model.serverModelName || model.apiModel || id,
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.type,
    isByok: true,
    defaultOn: model.defaultOn !== false,
    supportsAgent: model.supportsAgent !== false,
    supportsImages: !!model.supportsImages,
    supportsThinking: !!model.thinking,
    supportsMaxMode: model.supportsMaxMode !== false,
    supportsNonMaxMode: model.supportsNonMaxMode !== false,
    supportsAutoContext: !!model.supportsAutoContext,
    supportsPlanMode: model.supportsPlan !== false,
    supportsCmdK: !!model.supportsCmdK,
    contextTokenLimit,
    contextTokenLimitForMaxMode: integerOr(model.contextTokenLimitForMaxMode, contextTokenLimit),
    maxOutputTokens,
    isUserAdded: true,
    parameterDefinitions: [],
    variants: modelVariantsFor(model, id, name, legacySlugs),
    legacySlugs,
    idAliases: [],
    visibleInRoutedModelView: !!model.visibleInRoutedModelView,
    namedModelSectionIndex,
  };
  if (model.tooltipMarkdown) out.tooltipData = { markdownContent: model.tooltipMarkdown };
  if (model.vendorName) out.vendorName = model.vendorName;
  return out;
}

function modelVariantsFor(model, id, name, legacySlugs) {
  const legacySlug = legacySlugs[0];
  if (!legacySlug) return [];
  return [{
    displayName: name,
    displayNameOutsidePicker: name,
    parameterValues: [],
    isMaxMode: model.supportsNonMaxMode === false,
    isDefaultNonMaxConfig: model.supportsNonMaxMode !== false,
    isDefaultMaxConfig: model.supportsMaxMode !== false,
    variantStringRepresentation: `${id}[]`,
    legacySlug,
  }];
}

function publicCursorModelId(model) {
  if (!isLegacyRandomModelId(model.id)) return model.id || model.displayName || model.name || model.apiModel;
  return model.displayName || model.name || model.apiModel || model.id;
}

function legacySlugsFor(model, publicId) {
  const out = [];
  addLegacySlug(out, publicId);
  if (Array.isArray(model.legacySlugs)) {
    for (const slug of model.legacySlugs) {
      addLegacySlug(out, slug);
    }
  }
  addLegacySlug(out, model.legacyId);
  if (isLegacyRandomModelId(model.id)) addLegacySlug(out, model.id);
  return out;
}

function addLegacySlug(out, value) {
  if (typeof value === "string" && value && value !== "default" && !out.includes(value)) out.push(value);
}

function isLegacyRandomModelId(id) {
  return typeof id === "string" && /^model-[a-z0-9]{6}$/i.test(id);
}

function mergeAvailableModels(officialModels, providersConfig) {
  const entries = listProviderModels(providersConfig);
  const byok = entries.map(({ provider, model }) => toCursorModel(provider, model));
  // Dedup against every identifier a configured model is reachable by — plus its
  // derived public id — so an official model colliding on displayName /
  // serverModelName / legacyId is replaced by the BYOK one rather than leaking
  // through as a duplicate.
  const byokIds = new Set();
  for (const { model } of entries) {
    for (const candidate of modelIdCandidates(model)) byokIds.add(candidate);
    const publicId = publicCursorModelId(model);
    if (publicId && publicId !== "default") byokIds.add(publicId);
  }
  const merged = [];
  for (const model of officialModels || []) {
    if (!model) continue;
    const clean = sanitizeOfficialModelValue(model);
    if (!clean || typeof clean !== "object") continue;
    if ((clean.id && byokIds.has(clean.id)) || (clean.name && byokIds.has(clean.name))) continue;
    if ((clean.id || clean.name) === "default") continue;
    merged.push(clean);
  }
  for (const model of byok) {
    if ((model.id || model.name) === "default") continue;
    merged.push(model);
  }
  return merged;
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
  byokModelIds,
  byokPublicModelIds,
  findProviderModel,
  isByokModel,
  listProviderModels,
  mergeAvailableModels,
  modelIdCandidates,
  pickModelId,
  publicCursorModelId,
  sanitizeOfficialModelValue,
  toCursorModel,
};
