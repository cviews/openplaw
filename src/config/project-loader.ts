import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../infra/logger.js";
import type { OpencodeConfig } from "../config/types.js";
import { extractMcpServerMap } from "../mcp/external/mcp-adapter.js";
import type { ClaudeCodeMcpServer } from "../mcp/external/mcp-adapter.js";

export type ProjectOpenplawConfig = {
  skillsDir: string;
  commandsDir: string;
  mcpDir: string;
  exists: boolean;
};

export function resolveProjectOpenplawDir(projectPath?: string): string {
  return path.join(projectPath ?? process.cwd(), ".openplaw");
}

export async function scanProjectOpenplaw(projectPath?: string): Promise<ProjectOpenplawConfig> {
  const dir = resolveProjectOpenplawDir(projectPath);

  if (!existsSync(dir)) {
    return { skillsDir: "", commandsDir: "", mcpDir: "", exists: false };
  }

  const skillsDir = path.join(dir, "skills");
  const commandsDir = path.join(dir, "commands");
  const mcpDir = path.join(dir, "mcp");

  return { skillsDir, commandsDir, mcpDir, exists: true };
}

export type SkillInfo = {
  name: string;
  path: string;
  content: string;
};

export type CommandInfo = {
  name: string;
  path: string;
  content: string;
};

export async function scanProjectSkills(skillsDir: string): Promise<SkillInfo[]> {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (existsSync(skillMdPath)) {
        const content = await readFile(skillMdPath, "utf-8");
        skills.push({ name: entry.name, path: skillMdPath, content });
      }
    }
  } catch (err) {
    logger.warn("Failed to scan project skills", { error: err instanceof Error ? err.message : String(err) });
  }

  return skills;
}

export async function scanProjectCommands(commandsDir: string): Promise<CommandInfo[]> {
  if (!existsSync(commandsDir)) return [];

  const commands: CommandInfo[] = [];
  try {
    const entries = await readdir(commandsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
      const filePath = path.join(commandsDir, entry);
      const content = await readFile(filePath, "utf-8");
      const name = entry.replace(/\.md$/, "");
      commands.push({ name, path: filePath, content });
    }
  } catch (err) {
    logger.warn("Failed to scan project commands", { error: err instanceof Error ? err.message : String(err) });
  }

  return commands;
}

export type ProjectMcpEntry = {
  name: string;
  config: ClaudeCodeMcpServer;
  source: "project_mcp";
  projectPath: string;
  configPath: string;
};

export async function scanProjectMcpConfigs(mcpDir: string, projectPath: string): Promise<ProjectMcpEntry[]> {
  if (!existsSync(mcpDir)) return [];

  const entries: ProjectMcpEntry[] = [];
  try {
    const files = await readdir(mcpDir);
    for (const fileName of files) {
      if (!fileName.endsWith(".json") || fileName.startsWith(".")) continue;
      const filePath = path.join(mcpDir, fileName);
      try {
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        const mcpMap = extractMcpServerMap(parsed);
        if (mcpMap) {
          for (const [serverName, serverConfig] of Object.entries(mcpMap)) {
            entries.push({
              name: serverName,
              config: serverConfig,
              source: "project_mcp",
              projectPath,
              configPath: filePath,
            });
          }
        }
      } catch (err) {
        logger.warn("Failed to parse project MCP config", {
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn("Failed to scan project MCP dir", { error: err instanceof Error ? err.message : String(err) });
  }

  return entries;
}

export type GlobalSkillInfo = {
  name: string;
  path: string;
  content: string;
};

export async function scanGlobalSkills(): Promise<GlobalSkillInfo[]> {
  const { resolveOpenmoDir, resolveConfigDir } = await import("../config/loader.js");
  const dataDir = resolveOpenmoDir();
  const configDir = resolveConfigDir();

  const byName = new Map<string, GlobalSkillInfo>();

  const scanAgentsDir = async (agentsDir: string): Promise<void> => {
    if (!existsSync(agentsDir)) return;

    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const skillMdPath = path.join(agentsDir, entry.name, "SKILL.md");
        if (existsSync(skillMdPath)) {
          const content = await readFile(skillMdPath, "utf-8");
          byName.set(entry.name, { name: entry.name, path: skillMdPath, content });
        }
      }
    } catch (err) {
      logger.warn("Failed to scan global skills", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  await scanAgentsDir(path.join(dataDir, "agents"));
  await scanAgentsDir(path.join(configDir, "agents"));

  return Array.from(byName.values());
}

export function injectProjectSkillsIntoOpencodeConfig(
  opencodeConfig: OpencodeConfig,
  projectSkills: SkillInfo[],
  globalSkills: GlobalSkillInfo[],
): OpencodeConfig {
  if (projectSkills.length === 0 && globalSkills.length === 0) {
    return opencodeConfig;
  }

  const existingInstructions = Array.isArray(opencodeConfig.instructions)
    ? [...opencodeConfig.instructions]
    : [];

  for (const skill of [...projectSkills, ...globalSkills]) {
    existingInstructions.push(skill.content);
  }

  return { ...opencodeConfig, instructions: existingInstructions };
}

export function injectProjectMcpIntoOpencodeConfig(
  opencodeConfig: OpencodeConfig,
  projectMcpEntries: ProjectMcpEntry[],
): OpencodeConfig {
  if (projectMcpEntries.length === 0) {
    return opencodeConfig;
  }

  const existingMcp = typeof opencodeConfig.mcp === "object" && opencodeConfig.mcp !== null
    ? { ...opencodeConfig.mcp as Record<string, unknown> }
    : {};

  const existingMcpServers = typeof existingMcp.mcpServers === "object" && existingMcp.mcpServers !== null
    ? { ...(existingMcp.mcpServers as Record<string, unknown>) }
    : {};

  for (const entry of projectMcpEntries) {
    existingMcpServers[entry.name] = entry.config;
  }

  existingMcp.mcpServers = existingMcpServers;

  return { ...opencodeConfig, mcp: existingMcp };
}

export async function scanAllBotProjects(groups: Array<{ id: string; project?: string }>): Promise<{
  projectSkills: SkillInfo[];
  projectCommands: CommandInfo[];
  projectMcpEntries: ProjectMcpEntry[];
  projectsWithOpenplaw: string[];
}> {
  const projectSkills: SkillInfo[] = [];
  const projectCommands: CommandInfo[] = [];
  const projectMcpEntries: ProjectMcpEntry[] = [];
  const projectsWithOpenplaw: string[] = [];

  const seenProjects = new Set<string>();

  for (const group of groups) {
    if (!group.project || seenProjects.has(group.project)) continue;
    seenProjects.add(group.project);

    const projectOpenplaw = await scanProjectOpenplaw(group.project);
    if (!projectOpenplaw.exists) continue;

    projectsWithOpenplaw.push(group.project);

    const skills = await scanProjectSkills(projectOpenplaw.skillsDir);
    const commands = await scanProjectCommands(projectOpenplaw.commandsDir);
    const mcpEntries = await scanProjectMcpConfigs(projectOpenplaw.mcpDir, group.project);

    projectSkills.push(...skills);
    projectCommands.push(...commands);
    projectMcpEntries.push(...mcpEntries);
  }

  if (projectSkills.length > 0 || projectMcpEntries.length > 0) {
    logger.info(`Scanned ${projectsWithOpenplaw.length} project(s): ${projectSkills.length} skills, ${projectCommands.length} commands, ${projectMcpEntries.length} MCPs`);
  }

  return { projectSkills, projectCommands, projectMcpEntries, projectsWithOpenplaw };
}