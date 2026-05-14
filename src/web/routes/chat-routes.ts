import { Hono } from "hono";
import { logger } from "../../infra/logger.js";
import type { RouteDeps } from "./config-routes.js";

export function createChatRoutes(_deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/sessions", async (c) => {
    try {
      const client = getOpencodeClient();
      if (!client) {
        return c.json({ error: "Opencode server not running" }, 503);
      }
      const result = await client.session.list();
      if (result.error) {
        return c.json({ error: String(result.error) }, 500);
      }
      return c.json(result.data ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to list sessions", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/sessions", async (c) => {
    try {
      const client = getOpencodeClient();
      if (!client) {
        return c.json({ error: "Opencode server not running" }, 503);
      }
      const body = await c.req.json<{ parentID?: string }>();
      const result = await client.session.create(body as any);
      if (result.error) {
        return c.json({ error: String(result.error) }, 500);
      }
      return c.json(result.data, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to create session", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/sessions/:id/messages", async (c) => {
    try {
      const client = getOpencodeClient();
      if (!client) {
        return c.json({ error: "Opencode server not running" }, 503);
      }
      const id = c.req.param("id");
      const result = await client.session.messages({ sessionID: id } as any);
      if (result.error) {
        return c.json({ error: String(result.error) }, 500);
      }
      return c.json(result.data ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to get messages", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.post("/sessions/:id/prompt", async (c) => {
    try {
      const client = getOpencodeClient();
      if (!client) {
        return c.json({ error: "Opencode server not running" }, 503);
      }
      const id = c.req.param("id");
      const body = await c.req.json<{ agent?: string; parts: Array<{ type: "text"; text: string }> }>();
      const result = await client.session.promptAsync({
        sessionID: id,
        agent: body.agent ?? "sisyphus",
        parts: body.parts,
      } as any);
      if (result.error) {
        return c.json({ error: String(result.error) }, 500);
      }
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to send prompt", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/sessions/:id", async (c) => {
    try {
      const client = getOpencodeClient();
      if (!client) {
        return c.json({ error: "Opencode server not running" }, 503);
      }
      const id = c.req.param("id");
      await client.session.delete({ sessionID: id } as any);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to delete session", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

let opencodeClient: import("@opencode-ai/sdk").OpencodeClient | null = null;

export function setOpencodeClientForWeb(client: import("@opencode-ai/sdk").OpencodeClient | null): void {
  opencodeClient = client;
}

function getOpencodeClient(): import("@opencode-ai/sdk").OpencodeClient | null {
  return opencodeClient;
}