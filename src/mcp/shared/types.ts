/**
 * MCP registration record — the core data structure for the hub registry.
 * Every MCP (internal or external) must register to be discoverable and usable.
 */
export type McpRegistration = {
  /** Unique MCP name — the key from mcpServers config, used for identification */
  name: string;
  /** Source of this MCP registration */
  source: "internal" | "external_agent" | "external_user" | "external_custom";
  /** The server configuration (stdio or remote) */
  config: McpServerConfig;
  /** Whether this MCP is currently enabled */
  enabled: boolean;
  /** Agent name if this MCP belongs to a custom agent */
  agentName?: string;
  /** Path to the config file if loaded from external source */
  configPath?: string;
  /** Registered timestamp */
  registeredAt: number;
};

export type McpScope = "user" | "project" | "local";

export type McpOAuthConfig = {
  clientId?: string;
  scopes?: string[];
};

/**
 * Claude Code compatible MCP server config — used in mcp.json files.
 * The key in mcpServers is the MCP name (registration identifier).
 */
export type ClaudeCodeMcpServer = {
  type?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  scope?: McpScope;
  projectPath?: string;
  disabled?: boolean;
};

/**
 * opencode/omo compatible MCP server config — for injection into opencode config.
 */
export type McpLocalConfig = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};

export type McpRemoteConfig = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  enabled?: boolean;
};

export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

/**
 * Skill MCP config — the format found in mcp.json and SKILL.md frontmatter.
 * Key = MCP name, value = server config.
 */
export type SkillMcpConfig = Record<string, ClaudeCodeMcpServer>;

/**
 * Scanned MCP config — a discovered MCP before registration.
 */
export type ScannedMcpConfig = {
  source: "frontmatter" | "mcp_json" | "openplaw_config";
  agentName?: string;
  agentPath?: string;
  config: SkillMcpConfig;
};

/**
 * MCP hub serve options.
 */
export type OpenmoMcpServeOptions = {
  verbose?: boolean;
  port?: number;
  hostname?: string;
};
