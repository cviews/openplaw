export {
  type ClaudeCodeMcpServer,
  type McpServerConfig,
  type SkillMcpConfig,
  type ScannedMcpConfig,
  adaptToMcpServerConfig,
  adaptToSkillMcpConfig,
  adaptAllToPluginComponents,
  scanMcpJsonFromDir,
  scanMcpFromFrontmatter,
  extractMcpServerMap,
} from "./mcp-adapter.js";

export {
  OpenmoMcpRegistry,
  type McpRegistryOptions,
  type McpRegistryResult,
} from "./mcp-registry.js";

export {
  loadExternalMcpConfigs,
  type DiscoveredExternalMcp,
  type McpLoadResult,
} from "./mcp-loader.js";

export {
  resolveExternalMcps,
  updateOpencodeConfig,
  type ResolvedMcpEntry,
  type McpResolveResult,
} from "./mcp-resolver.js";

export {
  resolvePromptMcpReferences,
  resolvePromptMcpReferencesFromContent,
  type PromptMcpReference,
  type PromptMcpResolveResult,
} from "./prompt-mcp-resolver.js";
