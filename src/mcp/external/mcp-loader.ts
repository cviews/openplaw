import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOpenmoDir, resolveConfigDir } from "../../config/loader.js";
import { extractMcpServerMap } from "./mcp-adapter.js";
import type { ClaudeCodeMcpServer } from "../shared/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiscoveredExternalMcp = {
  /** MCP name — the key from mcpServers in the JSON config */
  name: string;
  /** Raw server config (ClaudeCode format) */
  config: ClaudeCodeMcpServer;
  /** Where this MCP was discovered */
  source: "external_user" | "external_agent";
  /** Agent name if discovered from an agent-specific directory */
  agentName?: string;
  /** Absolute path to the JSON config file */
  configPath: string;
};

export type McpLoadResult = {
  discovered: DiscoveredExternalMcp[];
  errors: Array<{ source: string; message: string }>;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load external MCP configs with overlay pattern:
 *   1. Scan ~/.openplaw/mcp/ (built-in defaults, lower priority)
 *   2. Scan ~/.config/openplaw/mcp/ (user customizations, higher priority)
 *   3. Scan agent-specific mcp/ from both dirs
 *   4. Config dir entries override data dir entries with same name
 *
 * Each JSON file follows the mcpServers format:
 * { "mcpServers": { "search_mcp": { "command": "npx", "args": [...], "type": "stdio" } } }
 *
 * The key in mcpServers IS the MCP name (registration identifier).
 */
export function loadExternalMcpConfigs(openplawDir?: string, configDir?: string): McpLoadResult {
  const dataDir = openplawDir ?? resolveOpenmoDir();
  const cfgDir = configDir ?? resolveConfigDir();
  const discovered: DiscoveredExternalMcp[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  const dataMcpDir = path.join(dataDir, "mcp");
  if (fs.existsSync(dataMcpDir)) {
    const dataResults = scanMcpJsonFiles(dataMcpDir, "external_user");
    discovered.push(...dataResults.discovered);
    errors.push(...dataResults.errors);
  }

  if (cfgDir !== dataDir) {
    const configMcpDir = path.join(cfgDir, "mcp");
    if (fs.existsSync(configMcpDir)) {
      const configResults = scanMcpJsonFiles(configMcpDir, "external_user");
      discovered.push(...configResults.discovered);
      errors.push(...configResults.errors);
    }
  }
  const dataAgentsDir = path.join(dataDir, "agents");
  if (fs.existsSync(dataAgentsDir)) {
    try {
      const agentEntries = fs.readdirSync(dataAgentsDir, { withFileTypes: true });
      for (const entry of agentEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        const agentMcpDir = path.join(dataAgentsDir, entry.name, "mcp");
        if (fs.existsSync(agentMcpDir)) {
          const agentResults = scanMcpJsonFiles(agentMcpDir, "external_agent", entry.name);
          discovered.push(...agentResults.discovered);
          errors.push(...agentResults.errors);
        }
      }
    } catch (err) {
      errors.push({
        source: dataAgentsDir,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (cfgDir !== dataDir) {
    const configAgentsDir = path.join(cfgDir, "agents");
    if (fs.existsSync(configAgentsDir)) {
      try {
        const agentEntries = fs.readdirSync(configAgentsDir, { withFileTypes: true });
        for (const entry of agentEntries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
            continue;
          }
          const agentMcpDir = path.join(configAgentsDir, entry.name, "mcp");
          if (fs.existsSync(agentMcpDir)) {
            const agentResults = scanMcpJsonFiles(agentMcpDir, "external_agent", entry.name);
            discovered.push(...agentResults.discovered);
            errors.push(...agentResults.errors);
          }
        }
      } catch (err) {
        errors.push({
          source: cfgDir,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const byName = new Map<string, DiscoveredExternalMcp>();
  for (const entry of discovered) {
    const key = entry.agentName ? `${entry.agentName}/${entry.name}` : entry.name;
    const existing = byName.get(key);
    if (!existing || entry.configPath.includes(cfgDir)) {
      byName.set(key, entry);
    }
  }

  const deduped = Array.from(byName.values());

  return { discovered: deduped, errors };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function scanMcpJsonFiles(
  dir: string,
  source: "external_user" | "external_agent",
  agentName?: string,
): McpLoadResult {
  const discovered: DiscoveredExternalMcp[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  try {
    const entries = fs.readdirSync(dir);
    const jsonFiles = entries.filter((name) => name.endsWith(".json"));

    for (const fileName of jsonFiles) {
      const filePath = path.join(dir, fileName);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const mcpMap = extractMcpServerMap(parsed);

        if (mcpMap) {
          for (const [serverName, serverConfig] of Object.entries(mcpMap)) {
            discovered.push({
              name: serverName,
              config: serverConfig,
              source,
              agentName,
              configPath: filePath,
            });
          }
        }
      } catch (err) {
        errors.push({
          source: filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    errors.push({
      source: dir,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { discovered, errors };
}
