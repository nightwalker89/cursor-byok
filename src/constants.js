"use strict";

const EXTENSION_ID = "starduster.cursor-byok";
const DISPLAY_NAME = "Cursor BYOK";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9960;
const DEFAULT_PORT_SEARCH_COUNT = 8;
const CONFIG_DIR_NAME = ".cursor-byok";
const PROVIDERS_FILE = "providers.json";
const ROUTES_FILE = "routes.json";
const CATALOG_FILE = "models-catalog.json";
const HOOK_STATE_FILE = "workbench-hook-state.json";
const LOG_FILE = "cursor-byok.log";
const UPSTREAM_ORIGIN = "https://api2.cursor.sh";
const WORKBENCH_BACKUP_DIR = "workbench-backups";

const LEGACY_DEFAULT_REDIRECTS = [
  "REST:/auth/full_stripe_profile",
  "REST:/auth/stripe_profile",
  "aiserver.v1.AiService/AvailableModels",
  "agent.v1.AgentService/RunSSE",
  "agent.v1.AgentService/UploadConversationBlobs",
  "aiserver.v1.BidiService/BidiAppend",
  "aiserver.v1.ChatService/GetConversationSummary",
  "aiserver.v1.ChatService/StreamSpeculativeSummaries",
  "aiserver.v1.AiService/KnowledgeBaseList",
  "aiserver.v1.AiService/KnowledgeBaseAdd",
  "aiserver.v1.AiService/KnowledgeBaseUpdate",
  "aiserver.v1.AiService/KnowledgeBaseRemove",
  "aiserver.v1.AuthService",
  "aiserver.v1.DashboardService/GetPlanInfo",
  "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "aiserver.v1.DashboardService/GetTeams",
  "aiserver.v1.DashboardService/GetUserPrivacyMode",
  "aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
  "aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "aiserver.v1.DashboardService/IsOnNewPricing",
  "aiserver.v1.DashboardService/GetManagedSkills",
  "aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
  "aiserver.v1.DashboardService/GetGlobalCommands",
  "aiserver.v1.DashboardService/GetTeamCommands",
  "aiserver.v1.DashboardService/GetSlackInstallUrl",
  "aiserver.v1.ServerConfigService",
  "aiserver.v1.NetworkService",
  "aiserver.v1.HealthService",
  "aiserver.v1.InAppAdService",
  "aiserver.v1.BackgroundComposerService/ListBackgroundComposers",
  "aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings",
  "aiserver.v1.BackgroundComposerService/ListTeamEnvironments",
  "aiserver.v1.BackgroundComposerService/ListPersonalEnvironments",
  "REST:/auth/has_valid_payment_method",
  "REST:/auth/poll",
  "REST:/auth/logout",
];

// Transport-only configs shipped by earlier local builds. They are too narrow
// for transcript/checkpoint parity and should be migrated forward.
const PREVIOUS_TRANSPORT_ONLY_REDIRECTS = [
  "aiserver.v1.AiService/AvailableModels",
  "agent.v1.AgentService/RunSSE",
  "agent.v1.AgentService/Run",
  "aiserver.v1.BidiService/BidiAppend",
];

// Keep the default redirect surface narrow. Auth/payment probes must stay local
// so Cursor exposes BYOK without requiring a Cursor subscription; the transport
// routes are the only gRPC hooks required for BYOK turns.
const DEFAULT_REDIRECTS = [
  "REST:/auth/full_stripe_profile",
  "REST:/auth/stripe_profile",
  "REST:/auth/has_valid_payment_method",
  "REST:/auth/poll",
  "REST:/auth/logout",
  "REST:/byok/checkpoint",
  "aiserver.v1.AiService/AvailableModels",
  "agent.v1.AgentService/RunSSE",
  "agent.v1.AgentService/Run",
  "aiserver.v1.BidiService/BidiAppend",
];

module.exports = {
  CATALOG_FILE,
  CONFIG_DIR_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PORT_SEARCH_COUNT,
  DEFAULT_REDIRECTS,
  DISPLAY_NAME,
  EXTENSION_ID,
  HOOK_STATE_FILE,
  LEGACY_DEFAULT_REDIRECTS,
  LOG_FILE,
  PREVIOUS_TRANSPORT_ONLY_REDIRECTS,
  PROVIDERS_FILE,
  ROUTES_FILE,
  UPSTREAM_ORIGIN,
  WORKBENCH_BACKUP_DIR,
};
