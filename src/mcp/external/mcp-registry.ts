import * as fs from "node:fs";
import * as path from "node:path";
import {
  adaptAllToPluginComponents,
  adaptToSkillMcpConfig,
  scanMcpFromFrontmatter,
  scanMcpJsonFromDir,
  type ScannedMcpConfig,
  type SkillMcpConfig,
} from "./mcp-adapter.js";
import { resolveOpenmoDir, resolveConfigDir } from "../../config/loader.js";

export type McpRegistryOptions = {
  agentsDir?: string;
  configDir?: string;
  verbose?: boolean;
};

export type McpRegistryResult = {
  configs: ScannedMcpConfig[];
  pluginComponents: Record<string, unknown>;
  errors: Array<{ source: string; message: string }>;
};

export class OpenmoMcpRegistry {
  private options: McpRegistryOptions;
  private cachedConfigs: ScannedMcpConfig[] | null = null;

  constructor(options: McpRegistryOptions = {}) {
    this.options = options;
  }

  async scanAll(): Promise<McpRegistryResult> {
    const configs: ScannedMcpConfig[] = [];
    const errors: Array<{ source: string; message: string }> = [];

    const dataAgentsDir = this.options.agentsDir ?? path.join(resolveOpenmoDir(), "agents");
    if (dataAgentsDir && fs.existsSync(dataAgentsDir)) {
      const agentConfigs = this.scanAgentDirectory(dataAgentsDir);
      configs.push(...agentConfigs.configs);
      errors.push(...agentConfigs.errors);
    }

    const configDir = this.options.configDir ?? resolveConfigDir();
    const configAgentsDir = path.join(configDir, "agents");
    if (configAgentsDir !== dataAgentsDir && fs.existsSync(configAgentsDir)) {
      const configAgentConfigs = this.scanAgentDirectory(configAgentsDir);
      // Config dir entries override data dir entries with same agentName/source
      const configNames = new Set(configAgentConfigs.configs.map((c) => `${c.agentName}/${c.source}`));
      const keptDataConfigs = configs.filter((c) => !configNames.has(`${c.agentName}/${c.source}`));
      configs.length = 0;
      configs.push(...keptDataConfigs, ...configAgentConfigs.configs);
      errors.push(...configAgentConfigs.errors);
    }

    // 3. Build PluginComponents.mcpServers for omo registration
    const pluginComponents = adaptAllToPluginComponents(configs);

    this.cachedConfigs = configs;

    return { configs, pluginComponents, errors };
  }

  getCachedConfigs(): ScannedMcpConfig[] | null {
    return this.cachedConfigs;
  }

  getConfigsForAgent(agentName: string): SkillMcpConfig[] {
    if (!this.cachedConfigs) {
      return [];
    }
    return this.cachedConfigs
      .filter((c) => c.agentName === agentName)
      .map((c) => adaptToSkillMcpConfig(c));
  }

  private scanAgentDirectory(agentsDir: string): {
    configs: ScannedMcpConfig[];
    errors: Array<{ source: string; message: string }>;
  } {
    const configs: ScannedMcpConfig[] = [];
    const errors: Array<{ source: string; message: string }> = [];

    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const agentDir = path.join(agentsDir, entry.name);
        const agentName = entry.name;

        // Check for agent MD file (pm.md, SKILL.md, etc.)
        const mdFiles = this.findAgentMdFiles(agentDir);

        for (const mdFile of mdFiles) {
          try {
            const content = fs.readFileSync(mdFile, "utf-8");
            const frontmatterMcp = scanMcpFromFrontmatter(content);
            if (frontmatterMcp && Object.keys(frontmatterMcp).length > 0) {
              configs.push({
                source: "frontmatter",
                agentName,
                agentPath: agentDir,
                config: frontmatterMcp,
              });
            }
          } catch (err) {
            errors.push({
              source: `${agentDir}/${path.basename(mdFile)}`,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Check for mcp.json in agent root (Option A: compatible with omo)
        try {
          const mcpJsonMcp = scanMcpJsonFromDir(agentDir);
          if (mcpJsonMcp && Object.keys(mcpJsonMcp).length > 0) {
            configs.push({
              source: "mcp_json",
              agentName,
              agentPath: agentDir,
              config: mcpJsonMcp,
            });
          }
        } catch (err) {
          errors.push({
            source: `${agentDir}/mcp.json`,
            message: err instanceof Error ? err.message : String(err),
          });
        }

        // Recurse into sub-directories for nested agent packages
        const subEntries = fs.readdirSync(agentDir, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory() || subEntry.name.startsWith(".")) {
            continue;
          }
          const subDir = path.join(agentDir, subEntry.name);

          // Check for mcp.json in sub-directories too (deep scan)
          try {
            const subMcp = scanMcpJsonFromDir(subDir);
            if (subMcp && Object.keys(subMcp).length > 0) {
              configs.push({
                source: "mcp_json",
                agentName: `${agentName}_${subEntry.name}`,
                agentPath: subDir,
                config: subMcp,
              });
            }
          } catch (err) {
            errors.push({
              source: `${subDir}/mcp.json`,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        source: agentsDir,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return { configs, errors };
  }

  private findAgentMdFiles(agentDir: string): string[] {
    const results: string[] = [];

    // Standard skill MD files: SKILL.md, <dirname>.md
    const dirName = path.basename(agentDir);
    const candidates = ["SKILL.md", `${dirName}.md`];

    for (const candidate of candidates) {
      const filePath = path.join(agentDir, candidate);
      if (fs.existsSync(filePath)) {
        results.push(filePath);
      }
    }

    // Also check any .md file that has frontmatter with mcpServers
    try {
      const entries = fs.readdirSync(agentDir);
      for (const entry of entries) {
        if (entry.endsWith(".md") && !candidates.includes(entry)) {
          const filePath = path.join(agentDir, entry);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.startsWith("---") && content.includes("mcpServers")) {
              results.push(filePath);
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // skip unreadable directories
    }

    return results;
  }

  private resolveAgentsDir(): string | undefined {
    // Try common locations for agent directories
    const workspaceDir = process.cwd();
    const candidates = [
      path.join(workspaceDir, "agents"),
      path.join(workspaceDir, ".openplaw", "agents"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}
