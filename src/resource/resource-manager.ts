import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { logger } from "../infra/logger.js";
import { extractMcpServerMap } from "../mcp/external/mcp-adapter.js";
import type { ClaudeCodeMcpServer } from "../mcp/external/mcp-adapter.js";

export type ResourceSkill = {
  name: string;
  content: string;
  source: "project" | "global";
  projectPath?: string;
};

export type ResourceCommand = {
  name: string;
  content: string;
  source: "project" | "global";
  projectPath?: string;
};

export type ResourceMcp = {
  name: string;
  config: ClaudeCodeMcpServer;
  source: "project" | "global";
  projectPath?: string;
};

export type ResourceAgent = {
  name: string;
  content: string;
  source: "project" | "global";
  projectPath?: string;
  filePath: string;
};

export type ProjectContext = {
  projectPath: string;
  skills: ResourceSkill[];
  commands: ResourceCommand[];
  mcps: ResourceMcp[];
  agents: ResourceAgent[];
};

export type ResourceManagerResult = {
  globalSkills: ResourceSkill[];
  globalCommands: ResourceCommand[];
  globalMcps: ResourceMcp[];
  globalAgents: ResourceAgent[];
  projects: Map<string, ProjectContext>;
};

export class ResourceManager {
  private cached: ResourceManagerResult | null = null;

  async scanAll(bots: Array<{ id: string }>, groups: Array<{ id: string; project?: string }>): Promise<ResourceManagerResult> {
    const globalSkills: ResourceSkill[] = [];
    const globalCommands: ResourceCommand[] = [];
    const globalMcps: ResourceMcp[] = [];
    const globalAgents: ResourceAgent[] = [];
    const projects = new Map<string, ProjectContext>();

    const openplawDir = resolveOpenmoDir();
    const configDir = resolveConfigDir();

    const globalAgentsDir = path.join(openplawDir, "agents");
    if (existsSync(globalAgentsDir)) {
      await this.scanAgentDirectory(globalAgentsDir, globalSkills, globalMcps, globalAgents);
    }

    const configAgentsDir = path.join(configDir, "agents");
    if (configAgentsDir !== globalAgentsDir && existsSync(configAgentsDir)) {
      const configAgentNames = await this.scanAgentDirectory(configAgentsDir, globalSkills, globalMcps, globalAgents);
      for (const name of configAgentNames) {
        const dataIdx = globalAgents.findIndex((a) => a.name === name && a.filePath.includes(openplawDir));
        if (dataIdx !== -1) globalAgents.splice(dataIdx, 1);
        const dataSkillIdx = globalSkills.findIndex((s) => s.name === name && s.source === "global");
        if (dataSkillIdx !== -1) globalSkills.splice(dataSkillIdx, 1);
      }
    }

    const globalMcpDir = path.join(openplawDir, "mcp");
    if (existsSync(globalMcpDir)) {
      await this.scanMcpDirectory(globalMcpDir, globalMcps);
    }

    const configMcpDir = path.join(configDir, "mcp");
    if (configMcpDir !== globalMcpDir && existsSync(configMcpDir)) {
      const beforeCount = globalMcps.length;
      await this.scanMcpDirectory(configMcpDir, globalMcps);
      if (globalMcps.length > beforeCount) {
        const configMcpNames = new Set<string>();
        for (let i = beforeCount; i < globalMcps.length; i++) {
          configMcpNames.add(globalMcps[i]!.name);
        }
        for (let i = beforeCount - 1; i >= 0; i--) {
          if (configMcpNames.has(globalMcps[i]!.name)) {
            globalMcps.splice(i, 1);
          }
        }
      }
    }

    // Scan project-level resources from groups
    const seenProjects = new Set<string>();
    for (const group of groups) {
      if (!group.project || seenProjects.has(group.project)) continue;
      seenProjects.add(group.project);

      const projectDir = path.join(group.project, ".openplaw");
      if (!existsSync(projectDir)) continue;

      const projectSkills: ResourceSkill[] = [];
      const projectCommands: ResourceCommand[] = [];
      const projectMcps: ResourceMcp[] = [];
      const projectAgents: ResourceAgent[] = [];

      // Project skills
      const skillsDir = path.join(projectDir, "skills");
      if (existsSync(skillsDir)) {
        try {
          const entries = await readdir(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
            if (existsSync(skillMd)) {
              const content = await readFile(skillMd, "utf-8");
              projectSkills.push({ name: entry.name, content, source: "project", projectPath: group.project });
            }
          }
        } catch {
          void 0;
        }
      }

      // Project commands
      const commandsDir = path.join(projectDir, "commands");
      if (existsSync(commandsDir)) {
        try {
          const entries = await readdir(commandsDir);
          for (const entry of entries) {
            if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
            const filePath = path.join(commandsDir, entry);
            const content = await readFile(filePath, "utf-8");
            projectCommands.push({ name: entry.replace(/\.md$/, ""), content, source: "project", projectPath: group.project });
          }
        } catch {
          void 0;
        }
      }

      // Project MCP
      const mcpDir = path.join(projectDir, "mcp");
      if (existsSync(mcpDir)) {
        try {
          const files = await readdir(mcpDir);
          for (const fileName of files) {
            if (!fileName.endsWith(".json") || fileName.startsWith(".")) continue;
            const filePath = path.join(mcpDir, fileName);
            try {
              const raw = await readFile(filePath, "utf-8");
              const mcpMap = extractMcpServerMap(JSON.parse(raw));
              if (mcpMap) {
                for (const [mcpName, mcpConfig] of Object.entries(mcpMap)) {
                  projectMcps.push({ name: mcpName, config: mcpConfig, source: "project", projectPath: group.project });
                }
              }
            } catch {
              void 0;
            }
          }
        } catch {
          void 0;
        }
      }

      // Project agents (custom agent prompt.md in .openplaw/agents/)
      const projectAgentsDir = path.join(projectDir, "agents");
      if (existsSync(projectAgentsDir)) {
        try {
          const entries = await readdir(projectAgentsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const agentMd = path.join(projectAgentsDir, entry.name, `${entry.name}.md`);
            if (existsSync(agentMd)) {
              const content = await readFile(agentMd, "utf-8");
              projectAgents.push({ name: entry.name, content, source: "project", projectPath: group.project, filePath: agentMd });
            }
          }
        } catch {
          void 0;
        }
      }

      projects.set(group.project, {
        projectPath: group.project,
        skills: projectSkills,
        commands: projectCommands,
        mcps: projectMcps,
        agents: projectAgents,
      });
    }

    // Also scan current working directory as implicit project
    const cwdProjectDir = path.join(process.cwd(), ".openplaw");
    if (existsSync(cwdProjectDir) && !seenProjects.has(process.cwd())) {
      const skillsDir = path.join(cwdProjectDir, "skills");
      const commandsDir = path.join(cwdProjectDir, "commands");
      const mcpDir = path.join(cwdProjectDir, "mcp");
      const agentsDir = path.join(cwdProjectDir, "agents");

      const cwdSkills: ResourceSkill[] = [];
      const cwdCommands: ResourceCommand[] = [];
      const cwdMcps: ResourceMcp[] = [];
      const cwdAgents: ResourceAgent[] = [];

      if (existsSync(skillsDir)) {
        try {
          const entries = await readdir(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
            if (existsSync(skillMd)) {
              cwdSkills.push({ name: entry.name, content: await readFile(skillMd, "utf-8"), source: "project", projectPath: process.cwd() });
            }
          }
        } catch { void 0; }
      }

      if (existsSync(commandsDir)) {
        try {
          const entries = await readdir(commandsDir);
          for (const entry of entries) {
            if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
            cwdCommands.push({ name: entry.replace(/\.md$/, ""), content: await readFile(path.join(commandsDir, entry), "utf-8"), source: "project", projectPath: process.cwd() });
          }
        } catch { void 0; }
      }

      if (existsSync(mcpDir)) {
        try {
          const files = await readdir(mcpDir);
          for (const fileName of files) {
            if (!fileName.endsWith(".json") || fileName.startsWith(".")) continue;
            try {
              const mcpMap = extractMcpServerMap(JSON.parse(await readFile(path.join(mcpDir, fileName), "utf-8")));
              if (mcpMap) {
                for (const [mcpName, mcpConfig] of Object.entries(mcpMap)) {
                  cwdMcps.push({ name: mcpName, config: mcpConfig, source: "project", projectPath: process.cwd() });
                }
              }
            } catch { void 0; }
          }
        } catch { void 0; }
      }

      if (existsSync(agentsDir)) {
        try {
          const entries = await readdir(agentsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const agentMd = path.join(agentsDir, entry.name, `${entry.name}.md`);
            if (existsSync(agentMd)) {
              cwdAgents.push({ name: entry.name, content: await readFile(agentMd, "utf-8"), source: "project", projectPath: process.cwd(), filePath: agentMd });
            }
          }
        } catch { void 0; }
      }

      if (cwdSkills.length > 0 || cwdCommands.length > 0 || cwdMcps.length > 0 || cwdAgents.length > 0) {
        projects.set(process.cwd(), {
          projectPath: process.cwd(),
          skills: cwdSkills,
          commands: cwdCommands,
          mcps: cwdMcps,
          agents: cwdAgents,
        });
      }
    }

    this.cached = { globalSkills, globalCommands, globalMcps, globalAgents, projects };
    logger.info(`ResourceManager: ${globalSkills.length} global skills, ${globalMcps.length} global MCPs, ${globalAgents.length} global agents, ${projects.size} projects`);

    return this.cached;
  }

  getCached(): ResourceManagerResult | null {
    return this.cached;
  }

  getMergedSkills(projectPath?: string): ResourceSkill[] {
    if (!this.cached) return [];
    const global = this.cached.globalSkills;
    if (!projectPath) return global;
    const projectCtx = this.cached.projects.get(projectPath);
    if (!projectCtx) return global;
    return mergeByName(global, projectCtx.skills, "skills");
  }

  getMergedCommands(projectPath?: string): ResourceCommand[] {
    if (!this.cached) return [];
    const global = this.cached.globalCommands;
    if (!projectPath) return global;
    const projectCtx = this.cached.projects.get(projectPath);
    if (!projectCtx) return global;
    return mergeByName(global, projectCtx.commands, "commands");
  }

  getMergedMcps(projectPath?: string): ResourceMcp[] {
    if (!this.cached) return [];
    const global = this.cached.globalMcps;
    if (!projectPath) return global;
    const projectCtx = this.cached.projects.get(projectPath);
    if (!projectCtx) return global;
    return mergeByName(global, projectCtx.mcps, "MCPs");
  }

  getMergedAgents(projectPath?: string): ResourceAgent[] {
    if (!this.cached) return [];
    const global = this.cached.globalAgents;
    if (!projectPath) return global;
    const projectCtx = this.cached.projects.get(projectPath);
    if (!projectCtx) return global;
    return mergeByName(global, projectCtx.agents, "agents");
  }

  getAllProjectPaths(): string[] {
    if (!this.cached) return [];
    return Array.from(this.cached.projects.keys());
  }

  async reload(bots: Array<{ id: string }>, groups: Array<{ id: string; project?: string }>): Promise<ResourceManagerResult> {
    logger.info("ResourceManager: reloading all resources...");
    return this.scanAll(bots, groups);
  }

  private async scanAgentDirectory(
    agentsDir: string,
    skills: ResourceSkill[],
    mcps: ResourceMcp[],
    agents: ResourceAgent[],
  ): Promise<Set<string>> {
    const discoveredNames = new Set<string>();
    if (!existsSync(agentsDir)) return discoveredNames;

    try {
      const agentEntries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of agentEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const agentDir = path.join(agentsDir, entry.name);
        discoveredNames.add(entry.name);

        const agentMd = path.join(agentDir, `${entry.name}.md`);
        if (existsSync(agentMd)) {
          const content = await readFile(agentMd, "utf-8");
          agents.push({ name: entry.name, content, source: "global", filePath: agentMd });
        }

        const skillMd = path.join(agentDir, "SKILL.md");
        if (existsSync(skillMd)) {
          const content = await readFile(skillMd, "utf-8");
          skills.push({ name: entry.name, content, source: "global" });
        }

        const mcpJsonPath = path.join(agentDir, "mcp.json");
        if (existsSync(mcpJsonPath)) {
          try {
            const raw = await readFile(mcpJsonPath, "utf-8");
            const mcpMap = extractMcpServerMap(JSON.parse(raw));
            if (mcpMap) {
              for (const [mcpName, mcpConfig] of Object.entries(mcpMap)) {
                mcps.push({ name: mcpName, config: mcpConfig, source: "global" });
              }
            }
          } catch (err) {
            logger.warn(`Failed to parse ${mcpJsonPath}`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    } catch {
      void 0;
    }

    return discoveredNames;
  }

  private async scanMcpDirectory(mcpDir: string, mcps: ResourceMcp[]): Promise<void> {
    if (!existsSync(mcpDir)) return;

    try {
      const mcpFiles = await readdir(mcpDir);
      for (const fileName of mcpFiles) {
        if (!fileName.endsWith(".json") || fileName.startsWith(".")) continue;
        const filePath = path.join(mcpDir, fileName);
        try {
          const raw = await readFile(filePath, "utf-8");
          const mcpMap = extractMcpServerMap(JSON.parse(raw));
          if (mcpMap) {
            for (const [mcpName, mcpConfig] of Object.entries(mcpMap)) {
              mcps.push({ name: mcpName, config: mcpConfig, source: "global" });
            }
          }
        } catch (err) {
          logger.warn(`Failed to parse ${filePath}`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch {
      void 0;
    }
  }
}

function mergeByName<T extends { name: string }>(global: T[], project: T[], label: string): T[] {
  const projectNames = new Set(project.map((p) => p.name));
  const keptGlobal = global.filter((g) => !projectNames.has(g.name));
  const merged = [...keptGlobal, ...project];
  const overrides = projectNames.size;
  if (overrides > 0) {
    logger.debug(`${label}: project overrides ${overrides} global entries`);
  }
  return merged;
}