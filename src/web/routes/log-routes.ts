import { Hono } from "hono";
import { logger } from "../../infra/logger.js";
import type { RouteDeps } from "./config-routes.js";

export type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
  source?: string;
};

const MAX_LOG_ENTRIES = 1000;

const logBuffer: LogEntry[] = [];

export function pushLogEntry(entry: LogEntry): void {
  if (logBuffer.length >= MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
  logBuffer.push(entry);
}

export function createLogRoutes(_deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const level = c.req.query("level");
    const source = c.req.query("source");
    const limit = Number(c.req.query("limit") ?? "200");
    const search = c.req.query("search");

    let filtered = [...logBuffer];

    if (level) {
      const levels = level.split(",");
      filtered = filtered.filter((e) => levels.includes(e.level));
    }
    if (source) {
      filtered = filtered.filter((e) => e.source === source);
    }
    if (search) {
      const lowerSearch = search.toLowerCase();
      filtered = filtered.filter(
        (e) => e.message.toLowerCase().includes(lowerSearch) ||
          (e.meta && JSON.stringify(e.meta).toLowerCase().includes(lowerSearch)),
      );
    }

    const capped = filtered.slice(-limit);

    return c.json({
      entries: capped,
      total: logBuffer.length,
      filtered: filtered.length,
    });
  });

  app.delete("/", async (c) => {
    logBuffer.length = 0;
    logger.info("Log buffer cleared via web UI");
    return c.json({ ok: true });
  });

  return app;
}