import { Hono } from "hono";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { stripJsonc } from "../../utils/json.js";
import { loadOpenmoConfigs } from "../../config/loader.js";
import { logger } from "../../infra/logger.js";
import type { OpenmoFileConfig } from "../../config/loader.js";

export type RouteDeps = {
  openplawDir: string;
  configDir: string;
};

async function readJsonConfigFile(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = await readFile(filePath, "utf-8");
  const jsonText = stripJsonc(raw);
  return JSON.parse(jsonText) as Record<string, unknown>;
}

async function writeJsonConfigFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = filePath + ".tmp";

  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
    logger.debug("Wrote config file", { path: filePath });
  } catch (err: unknown) {
    try {
      if (existsSync(tmpPath)) await unlink(tmpPath);
    } catch {
      void 0;
    }
    if ((err as NodeJS.ErrnoException | null)?.code === "EACCES") {
      throw new Error(`Permission denied writing config file: ${filePath}`);
    }
    throw err;
  }
}

async function readOpenplawConfig(configDir: string): Promise<OpenmoFileConfig> {
  const configPath = path.join(configDir, "openplaw.json");
  const result = await readJsonConfigFile(configPath);
  return result as OpenmoFileConfig;
}

async function writeOpenplawConfig(configDir: string, config: OpenmoFileConfig): Promise<void> {
  const configPath = path.join(configDir, "openplaw.json");
  await writeJsonConfigFile(configPath, config as Record<string, unknown>);
}

export function createConfigRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/openplaw", async (c) => {
    try {
      const config = await readOpenplawConfig(deps.configDir);
      return c.json(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read openplaw config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/openplaw", async (c) => {
    try {
      const body = await c.req.json<OpenmoFileConfig>();
      await writeOpenplawConfig(deps.configDir, body);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to write openplaw config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/merged", async (c) => {
    try {
      const configs = await loadOpenmoConfigs();
      return c.json(configs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to load merged config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/opencode", async (c) => {
    try {
      const config = await readJsonConfigFile(path.join(deps.configDir, "opencode.json"));
      return c.json(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read opencode config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/opencode", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      await writeJsonConfigFile(path.join(deps.configDir, "opencode.json"), body);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to write opencode config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.get("/omo", async (c) => {
    try {
      const config = await readJsonConfigFile(path.join(deps.configDir, "omo.json"));
      return c.json(config);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to read omo config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  app.put("/omo", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      await writeJsonConfigFile(path.join(deps.configDir, "omo.json"), body);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Failed to write omo config", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

export { readOpenplawConfig, writeOpenplawConfig };
