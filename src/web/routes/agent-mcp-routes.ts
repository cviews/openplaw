import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../../infra/logger.js";
import type { RouteDeps } from "./config-routes.js";
import { readOpenplawConfig, writeOpenplawConfig } from "./config-routes.js";

type AgentInfo = {
  name: string;
  filename: string;
  type: "md" | "json";
  exists: boolean;
};

type McpServerEntry = {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
};

export function createAgentMcpRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/agents", async (c) => {
    try {
      const byName = new Map<string, AgentInfo>();

      const scanAgentsDir = async (agentsDir: string): Promise<void> => {
        if (!existsSync(agentsDir)) return;
        try {
          const entries = await readdir(agentsDir);
          for (const filename of entries) {
            if (!filename.endsWith(".md") && !filename.endsWith(".json")) continue;
            const name = filename.replace(/\.(md|json)$/, "");
            byName.set(name, {
              name,
              filename,
              type: filename.endsWith(".md") ? "md" : "json",
              exists: true,
            });
          }
        } catch {
          void 0;
        }
      };

      await scanAgentsDir(path.join(deps.openplawDir, "agents"));
      await scanAgentsDir(path.join(deps.configDir, "agents"));

      const agents = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ agents, directory: path.join(deps.configDir, "agents") });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to scan agents", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/agents/:name/content", async (c) => {
    try {
      const name = c.req.param("name");

      for (const ext of ["md", "json"]) {
        const fileName = `${name}.${ext}`;
        const configPath = path.join(deps.configDir, "agents", fileName);
        if (existsSync(configPath)) {
          const content = await readFile(configPath, "utf-8");
          return c.json({ name, type: ext, content });
        }
        const dataPath = path.join(deps.openplawDir, "agents", fileName);
        if (existsSync(dataPath)) {
          const content = await readFile(dataPath, "utf-8");
          return c.json({ name, type: ext, content });
        }
      }

      return c.json({ error: `Agent "${name}" not found` }, 404);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read agent content", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/mcp", async (c) => {
    try {
      const config = await readOpenplawConfig(deps.configDir);
      const servers = config.mcp?.servers ?? {};
      const mcpEntries: McpServerEntry[] = Object.entries(servers).map(([name, serverConfig]) => ({
        name,
        config: serverConfig as Record<string, unknown>,
        enabled: true,
      }));

      return c.json({
        servers: mcpEntries,
        autoRegister: config.mcp?.autoRegister ?? true,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to get MCP servers", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/mcp/autoRegister", async (c) => {
    try {
      const body = await c.req.json<{ autoRegister: boolean }>();
      const config = await readOpenplawConfig(deps.configDir);
      config.mcp = { ...config.mcp, autoRegister: body.autoRegister };
      await writeOpenplawConfig(deps.configDir, config);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to update MCP autoRegister", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/mcp/servers/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const body = await c.req.json<{ config: Record<string, unknown>; enabled?: boolean }>();
      const config = await readOpenplawConfig(deps.configDir);
      const servers = config.mcp?.servers ?? {};

      if (body.enabled === false) {
        delete servers[name];
      } else {
        servers[name] = body.config;
      }

      config.mcp = { ...config.mcp, servers };
      await writeOpenplawConfig(deps.configDir, config);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to update MCP server", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/mcp/servers/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const config = await readOpenplawConfig(deps.configDir);
      const servers = config.mcp?.servers ?? {};
      delete servers[name];
      config.mcp = { ...config.mcp, servers };
      await writeOpenplawConfig(deps.configDir, config);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to delete MCP server", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}