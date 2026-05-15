import { startWebServer, type WebServerConfig } from "../web/web-server.js";
import { loadOpenmoConfigs, resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { mergeConfig } from "../config/merger.js";
import { bridgeLoggerToWeb } from "../infra/logger-bridge.js";
import { logger } from "../infra/logger.js";
import { ResourceManager } from "../resource/index.js";
import { OpencodeServerManager, type OpencodeServerConfig } from "../server/opencode-server.js";
import { injectProjectSkillsIntoOpencodeConfig, injectProjectMcpIntoOpencodeConfig, type SkillInfo, type GlobalSkillInfo, type ProjectMcpEntry } from "../config/project-loader.js";
import { setOpencodeClientForWeb } from "../web/routes/chat-routes.js";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { resolveConfig, type OpenmoPluginConfig } from "../config/config.js";
import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2";
import { scanCustomAgents, injectCustomAgentsIntoOpencodeConfig, readOmoAgentOverrides } from "../config/agent-loader.js";
import { expandTildePath } from "../utils/path.js";
import path from "node:path";

export type WebCommandOptions = {
  port?: number;
  host?: string;
  opencodePort?: number;
  hubPort?: number;
};

async function tryConnectExistingServer(port: number): Promise<OpencodeClient | null> {
  try {
    const response = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
    if (response.ok || response.status === 404) {
      logger.info(`Found existing opencode server on port ${port}, connecting to it`);
      return createV2OpencodeClient({ baseUrl: `http://localhost:${port}` }) as unknown as OpencodeClient;
    }
  } catch {
    // No existing server on this port
  }
  return null;
}

export async function webCommand(options?: WebCommandOptions): Promise<void> {
  logger.info("Starting Openplaw Web UI...");

  bridgeLoggerToWeb();
  const configs = await loadOpenmoConfigs();
  const openplawDir = resolveOpenmoDir();

  const resourceManager = new ResourceManager();
  const bots = configs.openplaw.bots ?? [];
  const groups = configs.openplaw.groups ?? [];
  const scanResult = await resourceManager.scanAll(bots, groups);

  const merged = mergeConfig(configs);

  const globalSkills: GlobalSkillInfo[] = scanResult.globalSkills.map(s => ({
    name: s.name, path: "", content: s.content,
  }));
  const projectSkills: SkillInfo[] = [];
  for (const [, projectCtx] of scanResult.projects) {
    for (const skill of projectCtx.skills) {
      projectSkills.push({ name: skill.name, path: "", content: skill.content });
    }
  }

  let enrichedConfig = injectProjectSkillsIntoOpencodeConfig(
    merged.opencodeConfig, projectSkills, globalSkills,
  );

  const projectMcpEntries: ProjectMcpEntry[] = [];
  for (const [, projectCtx] of scanResult.projects) {
    for (const mcp of projectCtx.mcps) {
      projectMcpEntries.push({
        name: mcp.name, config: mcp.config, source: "project_mcp",
        projectPath: mcp.projectPath ?? projectCtx.projectPath, configPath: "",
      });
    }
  }
  for (const mcp of scanResult.globalMcps) {
    projectMcpEntries.push({
      name: mcp.name, config: mcp.config, source: "project_mcp",
      projectPath: "", configPath: "",
    });
  }
  enrichedConfig = injectProjectMcpIntoOpencodeConfig(enrichedConfig, projectMcpEntries);

  const resolvedConfig = resolveConfig(configs.openplaw as OpenmoPluginConfig);
  const agentsDirs = resolvedConfig.agents.directory.map(expandTildePath);
  const customAgents = await scanCustomAgents(agentsDirs);
  const omoOverrides = await readOmoAgentOverrides(resolveConfigDir());
  enrichedConfig = injectCustomAgentsIntoOpencodeConfig(enrichedConfig, customAgents, omoOverrides);

  const opencodePort = options?.opencodePort ?? resolvedConfig.ports.opencode;

  let opencodeClient: OpencodeClient;
  let opencodeServer: OpencodeServerManager | null = null;

  const existingClient = await tryConnectExistingServer(opencodePort);
  if (existingClient) {
    opencodeClient = existingClient;
    logger.info(`Using existing opencode server on port ${opencodePort}`);
  } else {
    const opencodeConfig: OpencodeServerConfig = {
      port: opencodePort,
      hostname: "localhost",
      config: enrichedConfig as unknown as import("@opencode-ai/sdk").Config,
    };

    logger.info("Starting opencode server...");
    opencodeServer = new OpencodeServerManager(opencodeConfig);
    const opencodeResult = await opencodeServer.start();
    opencodeClient = opencodeResult.client;
    logger.info(`opencode server started at ${opencodeResult.url}`);
  }

  setOpencodeClientForWeb(opencodeClient);

  const webConfig: WebServerConfig = {
    port: options?.port ?? resolvedConfig.ports.web,
    host: options?.host ?? "0.0.0.0",
    openplawDir,
    configDir: resolveConfigDir(),
    resourceManager,
    opencodeClient,
  };

  const server = await startWebServer(webConfig);

  logger.info(`Openplaw Web UI available at http://localhost:${server.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    if (opencodeServer) await opencodeServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Openplaw Web UI running. Press Ctrl+C to stop.");
}
