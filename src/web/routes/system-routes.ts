import { Hono } from "hono";
import { readOpenplawConfig } from "./config-routes.js";
import type { RouteDeps } from "./config-routes.js";
import { logger } from "../../infra/logger.js";
import type { ResourceManager } from "../../resource/index.js";
import type { BootstrapResult } from "../../bootstrap/bootstrap.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { loadOpenmoConfigs } from "../../config/loader.js";
import { mergeConfig } from "../../config/merger.js";
import {
  injectProjectSkillsIntoOpencodeConfig,
  injectProjectMcpIntoOpencodeConfig,
  type SkillInfo,
  type GlobalSkillInfo,
  type ProjectMcpEntry,
} from "../../config/project-loader.js";
import type { Config } from "@opencode-ai/sdk";
import type { OpencodeConfig } from "../../config/types.js";

const startTime = Date.now();

export type SystemRouteDeps = RouteDeps & {
  resourceManager?: ResourceManager;
  bootstrap?: BootstrapResult;
  opencodeClient?: OpencodeClient;
};

export function createSystemRoutes(deps: SystemRouteDeps): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    try {
      const config = await readOpenplawConfig(deps.configDir);
      const bots = config.bots ?? [];
      const groups = config.groups ?? [];
      const mcpServers = config.mcp?.servers ? Object.keys(config.mcp.servers) : [];

      const resourceCounts = deps.resourceManager?.getCached() ?? {
        globalSkills: [],
        globalCommands: [],
        globalMcps: [],
        globalAgents: [],
        projects: {},
      };

      const projectCount = Object.keys(resourceCounts.projects).length;
      const skillsCount = resourceCounts.globalSkills.length +
        Object.values(resourceCounts.projects).reduce((sum, p) => sum + p.skills.length, 0);
      const commandsCount = resourceCounts.globalCommands.length +
        Object.values(resourceCounts.projects).reduce((sum, p) => sum + p.commands.length, 0);
      const agentsCount = resourceCounts.globalAgents.length +
        Object.values(resourceCounts.projects).reduce((sum, p) => sum + p.agents.length, 0);
      const totalMcps = resourceCounts.globalMcps.length +
        Object.values(resourceCounts.projects).reduce((sum, p) => sum + p.mcps.length, 0);

      return c.json({
        bots: bots.length,
        groups: groups.length,
        mcpServers: mcpServers.length,
        agentsDir: config.agents?.directory ?? "",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        projects: projectCount,
        skills: skillsCount,
        commands: commandsCount,
        agents: agentsCount,
        totalMcps: totalMcps,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to get system status", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/reload", async (c) => {
    try {
      if (deps.resourceManager) {
        const config = await readOpenplawConfig(deps.configDir);
        const bots = config.bots ?? [];
        const groups = config.groups ?? [];
        await deps.resourceManager.reload(bots, groups);
        logger.info("ResourceManager reload complete via web API");
      }

      if (deps.bootstrap) {
        await deps.bootstrap.reload();
        logger.info("Bootstrap reload complete via web API");
      }

      if (deps.opencodeClient && deps.resourceManager) {
        const configs = await loadOpenmoConfigs();
        const merged = mergeConfig(configs);
        const cached = deps.resourceManager.getCached();
        if (!cached) {
          logger.warn("ResourceManager cache is empty, skipping Level 3 config push");
        } else {
          const globalSkills: GlobalSkillInfo[] = cached.globalSkills.map(s => ({
            name: s.name, path: "", content: s.content,
          }));
          const projectSkills: SkillInfo[] = [];
          for (const [, projectCtx] of cached.projects) {
            for (const skill of projectCtx.skills) {
              projectSkills.push({ name: skill.name, path: "", content: skill.content });
            }
          }

          let enrichedConfig: OpencodeConfig = injectProjectSkillsIntoOpencodeConfig(
            merged.opencodeConfig, projectSkills, globalSkills,
          );

          const projectMcpEntries: ProjectMcpEntry[] = [];
          for (const [, projectCtx] of cached.projects) {
            for (const mcp of projectCtx.mcps) {
              projectMcpEntries.push({
                name: mcp.name, config: mcp.config, source: "project_mcp",
                projectPath: mcp.projectPath ?? projectCtx.projectPath, configPath: "",
              });
            }
          }
          for (const mcp of cached.globalMcps) {
            projectMcpEntries.push({
              name: mcp.name, config: mcp.config, source: "project_mcp",
              projectPath: "", configPath: "",
            });
          }

          enrichedConfig = injectProjectMcpIntoOpencodeConfig(enrichedConfig, projectMcpEntries);

          await deps.opencodeClient.config.update({
            body: enrichedConfig as unknown as Config,
          });
          logger.info("Pushed updated config to running opencode instance (Level 3)");
        }
      }

      if (!deps.resourceManager && !deps.bootstrap && !deps.opencodeClient) {
        logger.warn("Reload requested but no reload handler available");
        return c.json({ ok: false, message: "No reload handler configured" }, 503);
      }

      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Reload failed", { error: message });
      return c.json({ ok: false, error: message }, 500);
    }
  });

  app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

  return app;
}