// ─── Internal (channel MCP server, bridge, tools) ────────────────────────────
export { OpenmoChannelBridge } from "./internal/channel-bridge.js";
export { createOpenmoChannelMcpServer, serveOpenmoChannelMcp } from "./internal/channel-server.js";
export { registerChannelMcpTools } from "./internal/channel-tools.js";
export {
  createOpenmoBotToolsMcpServer,
  serveOpenmoBotToolsMcp,
  resolveOpenmoBotTools,
} from "./internal/bot-tools.js";

// ─── Shared (types, helpers, utilities) ──────────────────────────────────────
export type {
  McpRegistration,
  McpScope,
  McpOAuthConfig,
  ClaudeCodeMcpServer,
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
  SkillMcpConfig,
  ScannedMcpConfig,
  OpenmoMcpServeOptions,
} from "./shared/types.js";

export {
  type ApprovalDecision,
  type ApprovalKind,
  type ConversationDescriptor,
  type PendingApproval,
  type QueueEvent,
  type SessionRow,
  type WaitFilter,
  type SessionMessagePayload,
  type OpenmoMcpServeOptions as ChannelOpenmoMcpServeOptions,
  ApprovalRequestSchema,
  toConversation,
  toText,
  matchEventFilter,
  summarizeResult,
  summarizeStructuredResult,
  resolveMessageId,
  extractAttachmentsFromMessage,
  normalizeApprovalId,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "./shared/channel-shared.js";

export { createToolsMcpServer, connectToolsMcpServerToStdio } from "./shared/tools-stdio-server.js";

// ─── External (adapter, registry) ────────────────────────────────────────────
export {
  adaptToMcpServerConfig,
  adaptToSkillMcpConfig,
  adaptAllToPluginComponents,
  scanMcpJsonFromDir,
  scanMcpFromFrontmatter,
  extractMcpServerMap,
} from "./external/mcp-adapter.js";

export {
  OpenmoMcpRegistry,
  type McpRegistryOptions,
  type McpRegistryResult,
} from "./external/mcp-registry.js";

export {
  loadExternalMcpConfigs,
  type DiscoveredExternalMcp,
  type McpLoadResult,
} from "./external/mcp-loader.js";

export {
  resolveExternalMcps,
  updateOpencodeConfig,
  type ResolvedMcpEntry,
  type McpResolveResult,
} from "./external/mcp-resolver.js";

export {
  resolvePromptMcpReferences,
  resolvePromptMcpReferencesFromContent,
  type PromptMcpReference,
  type PromptMcpResolveResult,
} from "./external/prompt-mcp-resolver.js";

// ─── Hub (MCP hub server, trigger tools, client) ─────────────────────────────
export {
  OpenmoHubRegistry,
  type McpRegistration as HubMcpRegistration,
  type McpRegistrationSource as HubMcpRegistrationSource,
} from "./hub/hub-registry.js";

export {
  createOpenmoHubServer,
  type HubServerResult,
  type OpenmoHubServeOptions,
} from "./hub/hub-server.js";

export { registerHubTriggerTools } from "./hub/hub-trigger.js";

export {
  createOpenmoHubClient,
  type HubClientConfig,
  type HubClientResult,
} from "./hub/hub-client.js";
