import { type FeishuChannelConfig } from "../extensions/feishu/index.js";
import { loadOpenmoConfigs, resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { mergeConfig } from "../config/merger.js";
import { logger } from "../infra/logger.js";
import { ServerCoordinator, type ServerCoordinatorConfig } from "../server/index.js";
import type { Config } from "@opencode-ai/sdk";
import type { OpenmoBotConfig, OpenmoGroupConfig, OpenmoPluginConfig } from "../config/config.js";
import { resolveConfig } from "../config/config.js";
import path from "node:path";
import { ResourceManager } from "../resource/index.js";
import { injectProjectSkillsIntoOpencodeConfig, injectProjectMcpIntoOpencodeConfig } from "../config/project-loader.js";
import type { SkillInfo, GlobalSkillInfo, ProjectMcpEntry } from "../config/project-loader.js";
import { scanCustomAgents, injectCustomAgentsIntoOpencodeConfig, readOmoAgentOverrides } from "../config/agent-loader.js";
import { expandTildePath } from "../utils/path.js";
import { readMemoryFiles, buildMemoryInstructions, type MemoryContent } from "../config/memory-reader.js";

export type StartCommandOptions = {
  healthPort?: number;
  agentsDir?: string;
  opencodePort?: number;
  hubPort?: number;
  gatewayPort?: number;
};

export async function startCommand(options?: StartCommandOptions): Promise<void> {
  logger.info("Starting openplaw...");

  const configs = await loadOpenmoConfigs();

  const resolvedConfig = resolveConfig(configs.openplaw as OpenmoPluginConfig);

  const bots: OpenmoBotConfig[] = configs.openplaw.bots ?? [];
  const groups: OpenmoGroupConfig[] = configs.openplaw.groups ?? [];
  const feishuConfig = configs.openplaw.channels?.feishu as FeishuChannelConfig | undefined;
  const agentsDir = expandTildePath(options?.agentsDir ?? configs.openplaw.agents?.directory ?? path.join(resolveOpenmoDir(), "agents"));
  const opencodePort = options?.opencodePort ?? 4096;
  const mcpHubPort = options?.hubPort ?? 4097;
  const gatewayPort = options?.gatewayPort ?? resolvedConfig.gateway.port;

  const merged = mergeConfig(configs);

  const resourceManager = new ResourceManager();
  const scanResult = await resourceManager.scanAll(bots, groups);

  const globalSkills: GlobalSkillInfo[] = scanResult.globalSkills.map((s) => ({
    name: s.name,
    path: "",
    content: s.content,
  }));

  const projectSkills: SkillInfo[] = [];
  for (const [, projectCtx] of scanResult.projects) {
    for (const skill of projectCtx.skills) {
      projectSkills.push({ name: skill.name, path: "", content: skill.content });
    }
  }

  const cwdSkills = resourceManager.getMergedSkills(process.cwd());
  for (const skill of cwdSkills) {
    if (skill.source === "project" && skill.projectPath === process.cwd()) {
      projectSkills.push({ name: skill.name, path: "", content: skill.content });
    }
  }

  let enrichedConfig = injectProjectSkillsIntoOpencodeConfig(merged.opencodeConfig, projectSkills, globalSkills);

  const projectMcpEntries: ProjectMcpEntry[] = [];
  for (const [, projectCtx] of scanResult.projects) {
    for (const mcp of projectCtx.mcps) {
      projectMcpEntries.push({
        name: mcp.name,
        config: mcp.config,
        source: "project_mcp",
        projectPath: mcp.projectPath ?? projectCtx.projectPath,
        configPath: "",
      });
    }
  }
  for (const mcp of scanResult.globalMcps) {
    projectMcpEntries.push({
      name: mcp.name,
      config: mcp.config,
      source: "project_mcp",
      projectPath: "",
      configPath: "",
    });
  }

  enrichedConfig = injectProjectMcpIntoOpencodeConfig(enrichedConfig, projectMcpEntries);

  const customAgents = await scanCustomAgents(agentsDir);
  const omoOverrides = await readOmoAgentOverrides(resolveConfigDir());
  enrichedConfig = injectCustomAgentsIntoOpencodeConfig(enrichedConfig, customAgents, omoOverrides);

  const projectDirs = [...new Set(groups.filter(g => g.project).map(g => g.project!))];
  const allMemory = await Promise.all(projectDirs.map(dir => readMemoryFiles(dir)));
  const combinedMemory = allMemory.reduce<MemoryContent>(
    (acc, m) => ({
      global: acc.global || m.global,
      project: [acc.project, m.project].filter(Boolean).join("\n\n"),
      combined: [acc.combined, m.combined].filter(Boolean).join("\n\n"),
    }),
    { global: "", project: "", combined: "" },
  );
  const memoryInstructions = buildMemoryInstructions(combinedMemory, projectDirs.length === 1 ? projectDirs[0] : undefined);
  if (memoryInstructions.length > 0) {
    enrichedConfig.instructions = [...(enrichedConfig.instructions ?? []), ...memoryInstructions];
  }

  const opencodeConfig = enrichedConfig as Config;

  const coordinatorConfig: ServerCoordinatorConfig = {
    opencode: {
      port: opencodePort,
      config: opencodeConfig,
    },
    openplaw: {
      bots: bots.length > 0 ? bots : undefined,
      groups: groups.length > 0 ? groups : undefined,
      feishu: bots.length === 0 && feishuConfig?.appId ? feishuConfig : undefined,
      agentsDir,
      healthPort: options?.healthPort ?? 9090,
      botName: bots[0]?.botName ?? feishuConfig?.botName ?? "openplaw",
      gateway: { port: gatewayPort },
      mcpHubPort,
    },
  };

  const coordinator = new ServerCoordinator(coordinatorConfig);
  const result = await coordinator.start();

  logger.info(`opencode client available at ${result.opencodeServer.url}`);
  logger.info(`MCP hub client ready: ${result.openplawServer.bootstrap.hubClient ? "connected" : "not available"}`);
  logger.info(`Bots configured: ${result.openplawServer.bootstrap.botRegistry.getAllBotIds().join(", ") || "none"}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await result.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("openplaw running. Press Ctrl+C to stop.");
}
