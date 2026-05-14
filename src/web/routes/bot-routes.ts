import { Hono } from "hono";
import { logger } from "../../infra/logger.js";
import type { RouteDeps } from "./config-routes.js";
import { readOpenplawConfig, writeOpenplawConfig } from "./config-routes.js";
import type { OpenmoBotConfig, OpenmoGroupConfig } from "../../config/config.js";

export function createBotRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  // --- Bot CRUD ---
  app.get("/", async (c) => {
    try {
      const config = await readOpenplawConfig(deps.configDir);
      return c.json(config.bots ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read bots", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/", async (c) => {
    try {
      const bot = await c.req.json<OpenmoBotConfig>();
      if (!bot.id || !bot.agent || !bot.appId || !bot.appSecret || !bot.verificationToken || !bot.encryptKey || !bot.botName) {
        return c.json({ error: "Missing required fields: id, agent, appId, appSecret, verificationToken, encryptKey, botName (project is optional)" }, 400);
      }
      const config = await readOpenplawConfig(deps.configDir);
      const bots = config.bots ?? [];
      if (bots.some((b) => b.id === bot.id)) {
        return c.json({ error: `Bot with id "${bot.id}" already exists` }, 409);
      }
      bots.push(bot);
      config.bots = bots;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json(bot, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to create bot", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const updates = await c.req.json<Partial<OpenmoBotConfig>>();
      const config = await readOpenplawConfig(deps.configDir);
      const bots = config.bots ?? [];
      const idx = bots.findIndex((b) => b.id === id);
      if (idx === -1) {
        return c.json({ error: `Bot with id "${id}" not found` }, 404);
      }
      const existing = bots[idx]!;
      const merged: OpenmoBotConfig = {
        id: existing.id,
        agent: updates.agent ?? existing.agent,
        appId: updates.appId ?? existing.appId,
        appSecret: updates.appSecret ?? existing.appSecret,
        verificationToken: updates.verificationToken ?? existing.verificationToken,
        encryptKey: updates.encryptKey ?? existing.encryptKey,
        botName: updates.botName ?? existing.botName,
      };
      bots[idx] = merged;
      config.bots = bots;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json(bots[idx]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to update bot", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const config = await readOpenplawConfig(deps.configDir);
      const bots = config.bots ?? [];
      const idx = bots.findIndex((b) => b.id === id);
      if (idx === -1) {
        return c.json({ error: `Bot with id "${id}" not found` }, 404);
      }
      bots.splice(idx, 1);
      config.bots = bots;
      // Also remove from groups
      const groups = config.groups ?? [];
      for (const group of groups) {
        group.bots = group.bots.filter((botId) => botId !== id);
      }
      config.groups = groups;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to delete bot", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  // --- Group CRUD ---
  app.get("/groups", async (c) => {
    try {
      const config = await readOpenplawConfig(deps.configDir);
      return c.json(config.groups ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read groups", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/groups", async (c) => {
    try {
      const group = await c.req.json<OpenmoGroupConfig>();
      if (!group.id || !group.chatId || !group.name) {
        return c.json({ error: "Missing required fields: id, chatId, name" }, 400);
      }
      const config = await readOpenplawConfig(deps.configDir);
      const groups = config.groups ?? [];
      if (groups.some((g) => g.id === group.id)) {
        return c.json({ error: `Group with id "${group.id}" already exists` }, 409);
      }
      group.bots = group.bots ?? [];
      groups.push(group);
      config.groups = groups;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json(group, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to create group", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/groups/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const updates = await c.req.json<Partial<OpenmoGroupConfig>>();
      const config = await readOpenplawConfig(deps.configDir);
      const groups = config.groups ?? [];
      const idx = groups.findIndex((g) => g.id === id);
      if (idx === -1) {
        return c.json({ error: `Group with id "${id}" not found` }, 404);
      }
      const existingGroup = groups[idx]!;
      const mergedGroup: OpenmoGroupConfig = {
        id: existingGroup.id,
        chatId: updates.chatId ?? existingGroup.chatId,
        name: updates.name ?? existingGroup.name,
        bots: updates.bots ?? existingGroup.bots,
      };
      groups[idx] = mergedGroup;
      config.groups = groups;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json(groups[idx]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to update group", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/groups/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const config = await readOpenplawConfig(deps.configDir);
      const groups = config.groups ?? [];
      const idx = groups.findIndex((g) => g.id === id);
      if (idx === -1) {
        return c.json({ error: `Group with id "${id}" not found` }, 404);
      }
      groups.splice(idx, 1);
      config.groups = groups;
      await writeOpenplawConfig(deps.configDir, config);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to delete group", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}