import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOpenmoDir, resolveConfigDir } from "../../config/loader.js";
import { adaptToMcpServerConfig } from "./mcp-adapter.js";
import { OpenmoHubRegistry } from "../hub/hub-registry.js";
import type { DiscoveredExternalMcp } from "./mcp-loader.js";
import type { McpServerConfig } from "../shared/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResolvedMcpEntry = {
  name: string;
  source: "external_user" | "external_agent";
  config: McpServerConfig;
  enabled: boolean;
  agentName?: string;
  configPath: string;
  registered: boolean;
};

export type McpResolveResult = {
  resolved: ResolvedMcpEntry[];
  errors: Array<{ source: string; message: string }>;
};

// ─── Resolver ─────────────────────────────────────────────────────────────────

export function resolveExternalMcps(
  discovered: DiscoveredExternalMcp[],
  hubRegistry: OpenmoHubRegistry,
): McpResolveResult {
  const resolved: ResolvedMcpEntry[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const entry of discovered) {
    try {
      const serverConfig = adaptToMcpServerConfig(entry.name, entry.config);
      const enabled = !entry.config.disabled;

      hubRegistry.register({
        name: entry.name,
        source: "external",
        config: serverConfig,
        enabled,
      });

      resolved.push({
        name: entry.name,
        source: entry.source,
        config: serverConfig,
        enabled,
        agentName: entry.agentName,
        configPath: entry.configPath,
        registered: true,
      });
    } catch (err) {
      errors.push({
        source: entry.configPath,
        message: `Failed to register MCP "${entry.name}": ${err instanceof Error ? err.message : String(err)}`,
      });
      resolved.push({
        name: entry.name,
        source: entry.source,
        config: adaptToMcpServerConfig(entry.name, entry.config),
        enabled: !entry.config.disabled,
        agentName: entry.agentName,
        configPath: entry.configPath,
        registered: false,
      });
    }
  }

  return { resolved, errors };
}

// ─── Opencode Config Sync ────────────────────────────────────────────────────

export function updateOpencodeConfig(
  hubRegistry: OpenmoHubRegistry,
  openplawDir?: string,
): void {
  const baseDir = openplawDir ?? resolveConfigDir();
  const opencodePath = path.join(baseDir, "opencode.json");

  let opencodeConfig: Record<string, unknown> = {};
  if (fs.existsSync(opencodePath)) {
    try {
      const content = fs.readFileSync(opencodePath, "utf-8");
      opencodeConfig = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // corrupt or unreadable — start fresh
    }
  }

  opencodeConfig["mcpServers"] = hubRegistry.getBuiltinMcpServers();

  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(opencodePath, JSON.stringify(opencodeConfig, null, 2), "utf-8");
}
