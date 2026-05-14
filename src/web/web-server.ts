import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import path from "node:path";
import { resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { logger } from "../infra/logger.js";
import { createConfigRoutes, type RouteDeps } from "./routes/config-routes.js";
import { createBotRoutes } from "./routes/bot-routes.js";
import { createSystemRoutes } from "./routes/system-routes.js";
import { createChatRoutes } from "./routes/chat-routes.js";
import { createLogRoutes } from "./routes/log-routes.js";
import { createAgentMcpRoutes } from "./routes/agent-mcp-routes.js";
import { createResourceRoutes, type ResourceRouteDeps } from "./routes/resource-routes.js";
import type { ResourceManager } from "../resource/index.js";
import type { BootstrapResult } from "../bootstrap/bootstrap.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

export type WebServerConfig = {
  port?: number;
  host?: string;
  openplawDir?: string;
  configDir?: string;
  resourceManager?: ResourceManager;
  bootstrap?: BootstrapResult;
  opencodeClient?: OpencodeClient;
};

export function createWebServerApp(config: WebServerConfig): Hono {
  const app = new Hono();

  app.use("/api/*", cors());

  const openplawDir = config.openplawDir ?? resolveOpenmoDir();
  const configDir = config.configDir ?? resolveConfigDir();
  const deps: RouteDeps = { openplawDir, configDir };

  app.route("/api/config", createConfigRoutes(deps));
  app.route("/api/bots", createBotRoutes(deps));
  app.route("/api/system", createSystemRoutes({
    openplawDir,
    configDir,
    resourceManager: config.resourceManager,
    bootstrap: config.bootstrap,
    opencodeClient: config.opencodeClient,
  }));
  app.route("/api/chat", createChatRoutes(deps));
  app.route("/api/logs", createLogRoutes(deps));
  app.route("/api/agents-mcp", createAgentMcpRoutes(deps));

  if (config.resourceManager) {
    const resourceDeps: ResourceRouteDeps = { resourceManager: config.resourceManager };
    app.route("/api/resources", createResourceRoutes(resourceDeps));
  }

  const webDistPath = path.resolve(process.cwd(), "web/dist");
  app.use("/assets/*", serveStatic({ root: webDistPath }));
  app.use("/favicon.svg", serveStatic({ root: webDistPath }));

  app.get("*", async (c) => {
    const indexPath = path.join(webDistPath, "index.html");
    try {
      const { readFile } = await import("node:fs/promises");
      const html = await readFile(indexPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("Openplaw Web UI not built. Run: npm run web:build", 503);
    }
  });

  return app;
}

export async function startWebServer(config: WebServerConfig): Promise<{ port: number; close: () => void }> {
  const app = createWebServerApp(config);
  const port = config.port ?? 4098;
  const host = config.host ?? "0.0.0.0";

  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      logger.info(`Openplaw Web UI server listening on http://${host}:${info.port}`);
      resolve({
        port: info.port,
        close: () => {},
      });
    });
  });
}
