import { createOpencodeTui } from "@opencode-ai/sdk/server";
import { loadOpenmoConfigs } from "../config/loader.js";
import { mergeConfig } from "../config/merger.js";
import { injectConfig } from "../config/injector.js";
import { injectProjectSkillsIntoOpencodeConfig } from "../config/project-loader.js";
import { ResourceManager } from "../resource/index.js";
import { logger } from "../infra/logger.js";
import type { SkillInfo, GlobalSkillInfo, ProjectMcpEntry } from "../config/project-loader.js";
import { injectProjectMcpIntoOpencodeConfig } from "../config/project-loader.js";
import { scanCustomAgents, injectCustomAgentsIntoOpencodeConfig, readOmoAgentOverrides } from "../config/agent-loader.js";
import { resolveConfigDir } from "../config/loader.js";
import { resolveConfig } from "../config/config.js";
import type { OpenmoPluginConfig } from "../config/config.js";
import { expandTildePath } from "../utils/path.js";
import { readMemoryFiles, buildMemoryInstructions } from "../config/memory-reader.js";

export type TuiCommandOptions = {
  project?: string;
  model?: string;
  session?: string;
  agent?: string;
  hubUrl?: string;
};

async function pullResourcesFromServer(hubUrl: string, projectPath?: string): Promise<{
  skills: SkillInfo[];
  globalSkills: GlobalSkillInfo[];
  mcpEntries: ProjectMcpEntry[];
} | null> {
  try {
    const url = new URL("/api/resources/all", hubUrl);
    if (projectPath) url.searchParams.set("project", projectPath);

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;

    const data = await response.json() as Record<string, unknown>;

    const globalSkills: GlobalSkillInfo[] = ((data.globalSkills as Array<{ name: string; content: string }>) ?? []).map((s) => ({
      name: s.name,
      path: "",
      content: s.content,
    }));

    const skills: SkillInfo[] = ((data.skills ?? data.globalSkills) as Array<{ name: string; content: string }> ?? []).map((s) => ({
      name: s.name,
      path: "",
      content: s.content,
    }));

    const mcpEntries: ProjectMcpEntry[] = ((data.mcps ?? data.globalMcps) as Array<{ name: string; config: unknown; projectPath?: string }> ?? []).map((m) => ({
      name: m.name,
      config: m.config as import("../mcp/external/mcp-adapter.js").ClaudeCodeMcpServer,
      source: "project_mcp",
      projectPath: (m as { projectPath?: string }).projectPath ?? "",
      configPath: "",
    }));

    logger.info(`Pulled resources from server: ${globalSkills.length} global skills, ${skills.length} merged skills, ${mcpEntries.length} MCPs`);
    return { skills, globalSkills, mcpEntries };
  } catch {
    logger.debug("Could not connect to openplaw server, using local ResourceManager");
    return null;
  }
}

export async function tuiCommand(options?: TuiCommandOptions): Promise<void> {
  logger.info("Starting openplaw TUI...");

  const projectPath = options?.project ?? process.cwd();

  const configs = await loadOpenmoConfigs();
  logger.debug("Loaded configs", { openplawDir: configs.openplawDir });

  const merged = mergeConfig(configs);

  const hubUrl = options?.hubUrl ?? `http://localhost:4097`;

  const serverResources = await pullResourcesFromServer(hubUrl, projectPath);

  let enrichedConfig = merged.opencodeConfig;

  if (serverResources) {
    enrichedConfig = injectProjectSkillsIntoOpencodeConfig(
      enrichedConfig,
      serverResources.skills,
      serverResources.globalSkills,
    );
    enrichedConfig = injectProjectMcpIntoOpencodeConfig(enrichedConfig, serverResources.mcpEntries);
  } else {
    const resourceManager = new ResourceManager();
    const scanResult = await resourceManager.scanAll([], []);

    const globalSkills: GlobalSkillInfo[] = scanResult.globalSkills.map((s) => ({
      name: s.name,
      path: "",
      content: s.content,
    }));

    const projectSkills: SkillInfo[] = resourceManager.getMergedSkills(projectPath).map((s) => ({
      name: s.name,
      path: "",
      content: s.content,
    }));

    enrichedConfig = injectProjectSkillsIntoOpencodeConfig(
      enrichedConfig,
      projectSkills,
      globalSkills,
    );

    const mcpEntries: ProjectMcpEntry[] = resourceManager.getMergedMcps(projectPath).map((m) => ({
      name: m.name,
      config: m.config,
      source: "project_mcp",
      projectPath: m.projectPath ?? "",
      configPath: "",
    }));
    enrichedConfig = injectProjectMcpIntoOpencodeConfig(enrichedConfig, mcpEntries);
  }

  const resolvedConfig = resolveConfig(configs.openplaw as OpenmoPluginConfig);
  const agentsDirs = resolvedConfig.agents.directory.map(expandTildePath);
  const customAgents = await scanCustomAgents(agentsDirs);
  const omoOverrides = await readOmoAgentOverrides(resolveConfigDir());
  enrichedConfig = injectCustomAgentsIntoOpencodeConfig(enrichedConfig, customAgents, omoOverrides);

  const memory = await readMemoryFiles(projectPath);
  const memoryInstructions = buildMemoryInstructions(memory, projectPath);
  if (memoryInstructions.length > 0) {
    enrichedConfig.instructions = [...(enrichedConfig.instructions ?? []), ...memoryInstructions];
  }

  const injected = await injectConfig(configs, { ...merged, opencodeConfig: enrichedConfig });

  process.env["OPENCODE_CONFIG_CONTENT"] = injected.configContent;

  const tui = createOpencodeTui({
    project: projectPath,
    model: options?.model ?? enrichedConfig.model,
    session: options?.session,
    agent: options?.agent,
  });

  logger.info("TUI launched");

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, closing TUI...`);
    tui.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}