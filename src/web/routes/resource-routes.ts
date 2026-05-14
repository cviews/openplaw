import { Hono } from "hono";
import type { ResourceManager } from "../../resource/index.js";
import { logger } from "../../infra/logger.js";

export type ResourceRouteDeps = {
  resourceManager: ResourceManager;
};

export function createResourceRoutes(deps: ResourceRouteDeps): Hono {
  const app = new Hono();

  app.get("/skills", (c) => {
    const projectPath = c.req.query("project") ?? undefined;
    const skills = deps.resourceManager.getMergedSkills(projectPath);
    return c.json(skills);
  });

  app.get("/commands", (c) => {
    const projectPath = c.req.query("project") ?? undefined;
    const commands = deps.resourceManager.getMergedCommands(projectPath);
    return c.json(commands);
  });

  app.get("/mcps", (c) => {
    const projectPath = c.req.query("project") ?? undefined;
    const mcps = deps.resourceManager.getMergedMcps(projectPath);
    return c.json(mcps);
  });

  app.get("/agents", (c) => {
    const projectPath = c.req.query("project") ?? undefined;
    const agents = deps.resourceManager.getMergedAgents(projectPath);
    return c.json(agents);
  });

  app.get("/projects", (c) => {
    const paths = deps.resourceManager.getAllProjectPaths();
    return c.json(paths);
  });

  app.get("/all", (c) => {
    const projectPath = c.req.query("project") ?? undefined;
    const cached = deps.resourceManager.getCached();
    if (!cached) {
      return c.json({ error: "ResourceManager not initialized" }, 503);
    }
    const result: Record<string, unknown> = {
      globalSkills: cached.globalSkills,
      globalCommands: cached.globalCommands,
      globalMcps: cached.globalMcps,
      globalAgents: cached.globalAgents,
      projects: Object.fromEntries(cached.projects),
    };
    if (projectPath) {
      result.skills = deps.resourceManager.getMergedSkills(projectPath);
      result.commands = deps.resourceManager.getMergedCommands(projectPath);
      result.mcps = deps.resourceManager.getMergedMcps(projectPath);
      result.agents = deps.resourceManager.getMergedAgents(projectPath);
    }
    return c.json(result);
  });

  app.post("/refresh", async (c) => {
    logger.info("Resource refresh requested via web API");
    return c.json({ message: "Use openplaw server restart for full refresh" });
  });

  return app;
}