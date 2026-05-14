import type {
  ClaudeCodeMcpServer,
  McpServerConfig,
  SkillMcpConfig,
} from "../external/mcp-adapter.js";

// ─── Registration Types ──────────────────────────────────────────────────────

/** Source classification for an MCP registration */
export type McpRegistrationSource = "internal" | "external";

/** A registered MCP entry in the hub registry */
export type McpRegistration = {
  /** Registration identifier — the key from mcpServers config */
  name: string;
  /** Whether the MCP is internal (auto-registered) or external (registered via mcp-resolver) */
  source: McpRegistrationSource;
  /** The resolved server configuration */
  config: McpServerConfig;
  /** Whether this MCP is currently enabled and usable */
  enabled: boolean;
  /** Timestamp when the MCP was registered */
  registeredAt: number;
};

// ─── Hub Registry ────────────────────────────────────────────────────────────

/**
 * Central MCP registration table.
 *
 * Every MCP (internal or external) must register here before being usable.
 * Internal MCPs are auto-registered at startup; external MCPs register via mcp-resolver.
 */
export class OpenmoHubRegistry {
  private registrations: Map<string, McpRegistration> = new Map();

  register(entry: Omit<McpRegistration, "registeredAt">): McpRegistration {
    const record: McpRegistration = {
      ...entry,
      registeredAt: Date.now(),
    };
    this.registrations.set(entry.name, record);
    return record;
  }

  unregister(name: string): boolean {
    return this.registrations.delete(name);
  }

  isRegistered(name: string): boolean {
    const record = this.registrations.get(name);
    return record !== undefined && record.enabled;
  }

  get(name: string): McpRegistration | undefined {
    return this.registrations.get(name);
  }

  listAll(): McpRegistration[] {
    return Array.from(this.registrations.values());
  }

  listEnabled(): McpRegistration[] {
    return Array.from(this.registrations.values()).filter((r) => r.enabled);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const record = this.registrations.get(name);
    if (!record) return false;
    record.enabled = enabled;
    return true;
  }

  registerInternal(mcps: SkillMcpConfig): McpRegistration[] {
    const results: McpRegistration[] = [];
    for (const [name, config] of Object.entries(mcps)) {
      if (!config.disabled) {
        const adapted = adaptClaudeCodeMcpToServerConfig(name, config);
        results.push(
          this.register({
            name,
            source: "internal",
            config: adapted,
            enabled: true,
          }),
        );
      }
    }
    return results;
  }

  getOpencodeMcpConfig(): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    for (const reg of this.listEnabled()) {
      result[reg.name] = reg.config;
    }
    return result;
  }

  getBuiltinMcpServers(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const reg of this.listEnabled()) {
      result[reg.name] = reg.config;
    }
    return result;
  }

  clear(): void {
    this.registrations.clear();
  }
}

// ─── Adapter Helper ──────────────────────────────────────────────────────────

/**
 * Adapt a ClaudeCodeMcpServer config to our internal McpServerConfig format.
 * This mirrors the `adaptToMcpServerConfig` in mcp-adapter.ts but is kept
 * local to the hub to avoid coupling with the external scanning layer.
 */
function adaptClaudeCodeMcpToServerConfig(
  name: string,
  server: ClaudeCodeMcpServer,
): McpServerConfig {
  const explicitType = server.type;
  const hasUrl =
    typeof server.url === "string" && server.url.trim().length > 0;
  const hasCommand =
    typeof server.command === "string" && server.command.trim().length > 0;

  if (
    explicitType === "http" ||
    explicitType === "sse" ||
    (hasUrl && !hasCommand)
  ) {
    return {
      type: "remote",
      url: server.url ?? "",
      headers: server.headers,
      oauth: server.oauth,
      enabled: !server.disabled,
    };
  }

  const command = server.command ?? "";
  const args = server.args ?? [];
  return {
    type: "local",
    command: [command, ...args].filter((s) => s.length > 0),
    environment: server.env,
    enabled: !server.disabled,
  };
}
