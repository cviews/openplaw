import { SessionBindingService, type SessionResetConfig } from "../core/routing/session-binding.js";
import type { SummaryConfig } from "../config/session-summary.js";
import {
  listChannelPlugins,
  getChannelWebhookHandlers,
} from "../channels/registry.js";
import {
  defineBundledFeishuEntry,
  createFeishuHandlersForGroups,
  setBotRegistry,
  BotCredentialsRegistry,
  type FeishuChannelConfig,
} from "../extensions/feishu/index.js";
import { GroupResolver } from "../core/routing/group-resolver.js";
import { OpenmoMcpRegistry, type McpRegistryResult } from "../mcp/index.js";
import { WebhookIngress, type WebhookIngressRuntime } from "../gateway/webhook-ingress.js";
import { logger } from "../infra/logger.js";
import { normalizeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { HealthCheckServer } from "../infra/health/health-server.js";
import { startHeartbeatRunner } from "../infra/health/heartbeat-runner.js";
import { AutoReplyHandler } from "../auto-reply/auto-reply.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpenmoBotConfig, OpenmoGroupConfig } from "../config/config.js";
import {
  OpenmoHubRegistry,
  createOpenmoHubServer,
  createOpenmoHubClient,
  registerHubTriggerTools,
  type HubServerResult,
  type HubClientResult,
} from "../mcp/hub/index.js";
import { adaptToMcpServerConfig } from "../mcp/external/mcp-adapter.js";
import { ResourceManager } from "../resource/index.js";
import { AgentNameResolver } from "./agent-name-resolver.js";
import { resolveConfigDir } from "../config/loader.js";

export type BootstrapConfig = {
  bots?: OpenmoBotConfig[];
  groups?: OpenmoGroupConfig[];
  /** @deprecated Use bots/groups instead. Auto-converted to bots/groups. */
  feishu?: FeishuChannelConfig;
  agentsDir?: string;
  configDir?: string;
  healthPort?: number;
  /** @deprecated Derived from first bot's botName */
  botName?: string;
  gateway?: {
    port?: number;
    host?: string;
  };
  heartbeat?: {
    enabled?: boolean;
    intervalMs?: number;
  };
  opencodeClient?: OpencodeClient;
  mcpHubPort?: number;
  session?: {
    reset?: SessionResetConfig;
    summaries?: SummaryConfig;
  };
};

export type BootstrapResult = {
  sessionBinding: SessionBindingService;
  summariesConfig: SummaryConfig;
  groupResolver: GroupResolver;
  botRegistry: BotCredentialsRegistry;
  mcpRegistry: OpenmoMcpRegistry;
  mcpResult: McpRegistryResult | null;
  autoReply: AutoReplyHandler;
  healthServer: HealthCheckServer;
  ingressPort: number | null;
  hubClient: HubClientResult | null;
  resourceManager: ResourceManager;
  configDir: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reload: (newConfig?: BootstrapConfig) => Promise<void>;
};

function resolveBotsAndGroups(config: BootstrapConfig): {
  bots: OpenmoBotConfig[];
  groups: OpenmoGroupConfig[];
} {
  if (config.bots && config.bots.length > 0) {
    return { bots: config.bots, groups: config.groups ?? [] };
  }

  if (config.feishu?.appId && config.feishu?.appSecret) {
    const botId = config.feishu.botName ?? config.botName ?? "main";
    const agent = config.botName ?? botId;
    const bot: OpenmoBotConfig = {
      id: botId,
      agent,
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      verificationToken: config.feishu.verificationToken,
      encryptKey: config.feishu.encryptKey,
      botName: config.feishu.botName,
    };
    const group: OpenmoGroupConfig = {
      id: "default",
      chatId: "",
      name: "default",
      bots: [botId],
    };
    return { bots: [bot], groups: [group] };
  }

  return { bots: [], groups: [] };
}

export async function createOpenmoBootstrap(config: BootstrapConfig): Promise<BootstrapResult> {
  normalizeEnv();
  assertSupportedRuntime();

  logger.info("Bootstrapping openplaw...");

  const sessionResetConfig: SessionResetConfig = {
    daily: config.session?.reset?.daily ?? true,
    idleMinutes: config.session?.reset?.idleMinutes ?? 0,
  };
  const summariesConfig: SummaryConfig = {
    pruneAfterDays: config.session?.summaries?.pruneAfterDays ?? 30,
    maxEntries: config.session?.summaries?.maxEntries ?? 100,
    maxDiskMB: config.session?.summaries?.maxDiskMB ?? 50,
  };
  const sessionBinding = new SessionBindingService(sessionResetConfig);
  await sessionBinding.init();
  logger.info("SessionBindingService initialized");

  const { bots, groups } = resolveBotsAndGroups(config);
  logger.info(`Resolved ${bots.length} bot(s) and ${groups.length} group(s)`);

  const groupResolver = new GroupResolver(bots, groups);
  const botRegistry = new BotCredentialsRegistry(bots);

  const resourceManager = new ResourceManager();
  await resourceManager.scanAll(bots, groups);
  logger.info("ResourceManager scanned all resources");

  const hubRegistry = new OpenmoHubRegistry();
  let hubServer: HubServerResult | null = null;
  let hubClient: HubClientResult | null = null;

  if (config.opencodeClient) {
    const hubPort = config.mcpHubPort ?? 4097;

    hubServer = await createOpenmoHubServer(hubRegistry, {
      port: hubPort,
      verbose: true,
      resourceManager,
    });
    logger.info(`MCP hub server listening on port ${hubPort}`);

    const agentNameResolver = new AgentNameResolver();
    await agentNameResolver.initialize(config.opencodeClient);

    const rawDefaultAgent = groupResolver.getBotById("default")?.agent
      ?? bots[0]?.agent
      ?? "main";
    const resolvedDefaultAgent = agentNameResolver.resolve(rawDefaultAgent);

    logger.info("Default agent resolved", {
      raw: rawDefaultAgent,
      resolved: resolvedDefaultAgent,
      available: agentNameResolver.getAvailableAgentNames(),
    });

    for (const bot of bots) {
      if (bot.agent) {
        const resolved = agentNameResolver.resolve(bot.agent);
        if (resolved === bot.agent && !agentNameResolver.getAvailableAgentNames().includes(bot.agent)) {
          logger.error(
            `Bot "${bot.id}" has agent "${bot.agent}" configured, but this agent name was not found in the opencode serve API. Available agents: ${agentNameResolver.getAvailableAgentNames().join(", ")}. Please fix the "agent" field in your openplaw.json.`,
            { botId: bot.id, configuredAgent: bot.agent, availableAgents: agentNameResolver.getAvailableAgentNames() },
          );
        }
      }
    }

    registerHubTriggerTools(hubServer.server, {
      client: config.opencodeClient,
      getDefaultAgent: () => resolvedDefaultAgent,
      agentNameResolver,
    });
    logger.info("Hub trigger tools registered");

    // Register project MCPs from ResourceManager into hub registry
    const cached = resourceManager.getCached();
    if (cached) {
      for (const [, projectCtx] of cached.projects) {
        for (const mcp of projectCtx.mcps) {
          const serverConfig = adaptToMcpServerConfig(mcp.name, mcp.config);
          hubRegistry.register({
            name: mcp.name,
            source: "external",
            config: serverConfig,
            enabled: !mcp.config.disabled,
          });
          logger.info(`Registered project MCP: ${mcp.name} from ${mcp.projectPath}`);
        }
      }
      for (const mcp of cached.globalMcps) {
        const serverConfig = adaptToMcpServerConfig(mcp.name, mcp.config);
        hubRegistry.register({
          name: mcp.name,
          source: "external",
          config: serverConfig,
          enabled: !mcp.config.disabled,
        });
        logger.info(`Registered global MCP: ${mcp.name}`);
      }
    }

    hubClient = await createOpenmoHubClient({
      url: `http://localhost:${hubPort}`,
      name: "openplaw-gateway",
    });
    logger.info("Hub client connected");
  }

  setBotRegistry(botRegistry);

  if (bots.length > 0 && hubClient) {
    const handlersMap = createFeishuHandlersForGroups(bots, groups, {
      sessionBinding,
      hubClient,
      opencodeClient: config.opencodeClient!,
      resourceManager,
      summariesConfig,
    });

    const ingress = new WebhookIngress({
      port: config.gateway?.port ?? 3000,
      host: config.gateway?.host,
      mounts: [],
    });

    for (const [botId, webhookHandlers] of handlersMap) {
      const prefix = `/webhook/feishu/${botId}`;
      ingress.registerChannelHandlers(`feishu:${botId}`, prefix, webhookHandlers);
      logger.info(`Mounted feishu:${botId} webhook handlers at ${prefix}`);
    }

    if (bots.length === 1) {
      const legacyHandlers = handlersMap.get(bots[0]!.id);
      if (legacyHandlers) {
        ingress.registerChannelHandlers("feishu", "/webhook/feishu", legacyHandlers);
        logger.info("Mounted legacy feishu webhook handlers at /webhook/feishu");
      }
    }

    const channels = listChannelPlugins();
    logger.info(`Registered ${channels.length} channel plugin(s)`);

    for (const channel of channels) {
      if (channel.id === "feishu") continue;
      const handlers = getChannelWebhookHandlers(channel.id);
      if (handlers) {
        const prefix = `/webhook/${channel.id}`;
        ingress.registerChannelHandlers(channel.id, prefix, handlers);
        logger.info(`Mounted ${channel.id} webhook handlers at ${prefix}`);
      }
    }

    const mcpRegistry = new OpenmoMcpRegistry({
      agentsDir: config.agentsDir,
      verbose: true,
    });

    let mcpResult: McpRegistryResult | null = null;
    try {
      mcpResult = await mcpRegistry.scanAll();
      logger.info(
        `MCP scan complete: ${mcpResult.configs.length} config(s), ${mcpResult.errors.length} error(s)`,
      );
    } catch (err) {
      logger.error("MCP scan failed", { error: formatErrorMessage(err) });
    }

    const autoReply = new AutoReplyHandler({
      sessionBinding,
      botName: bots[0]?.botName ?? config.botName,
    });

    const healthServer = new HealthCheckServer({
      port: config.healthPort ?? 9090,
    });

    let heartbeatStop: (() => void) | null = null;
    if (config.heartbeat?.enabled) {
      heartbeatStop = startHeartbeatRunner(
        { intervalMs: config.heartbeat.intervalMs ?? 300_000, enabled: true },
        async () => {
          logger.debug("Heartbeat tick");
        },
      ).stop;
    }

    let ingressRuntime: WebhookIngressRuntime | null = null;

    const result: BootstrapResult = {
      sessionBinding,
      summariesConfig,
      groupResolver,
      botRegistry,
      mcpRegistry,
      mcpResult,
      autoReply,
      healthServer,
      ingressPort: null,
      hubClient,
      resourceManager,
      configDir: config.configDir ?? resolveConfigDir(),
      start: async () => {
        logger.info("openplaw starting...");
        await healthServer.start();
        logger.info(`Health check server on port ${config.healthPort ?? 9090}`);
        ingressRuntime = await ingress.start();
        logger.info(`Gateway listening on port ${ingressRuntime.port}`);
        logger.info("openplaw started");
      },
      stop: async () => {
        logger.info("openplaw stopping...");
        heartbeatStop?.();
        await healthServer.stop();
        await ingress.stop();
        ingressRuntime = null;
        if (hubClient) {
          await hubClient.close();
          hubClient = null;
        }
        if (hubServer) {
          await hubServer.close();
          hubServer = null;
        }
        await sessionBinding.dispose();
        logger.info("openplaw stopped");
      },
      reload: async (newConfig?: BootstrapConfig) => {
        logger.info("openplaw reloading...");
        try {
          const reloadConfig = newConfig ?? config;
          const { bots: newBots, groups: newGroups } = resolveBotsAndGroups(reloadConfig);

          await resourceManager.reload(newBots, newGroups);

          result.groupResolver = new GroupResolver(newBots, newGroups);
          result.botRegistry = new BotCredentialsRegistry(newBots);
          setBotRegistry(result.botRegistry);

          hubRegistry.clear();
          const refreshed = resourceManager.getCached();
          if (refreshed) {
            for (const [, projectCtx] of refreshed.projects) {
              for (const mcp of projectCtx.mcps) {
                hubRegistry.register({
                  name: mcp.name,
                  source: "external",
                  config: adaptToMcpServerConfig(mcp.name, mcp.config),
                  enabled: !mcp.config.disabled,
                });
              }
            }
            for (const mcp of refreshed.globalMcps) {
              hubRegistry.register({
                name: mcp.name,
                source: "external",
                config: adaptToMcpServerConfig(mcp.name, mcp.config),
                enabled: !mcp.config.disabled,
              });
            }
          }

          if (hubClient && ingressRuntime) {
            for (const botId of result.botRegistry.getAllBotIds()) {
              ingress.unmount(`/webhook/feishu/${botId}`);
            }
            ingress.unmount("/webhook/feishu");

            const newHandlersMap = createFeishuHandlersForGroups(newBots, newGroups, {
              sessionBinding,
              hubClient,
              opencodeClient: config.opencodeClient!,
              resourceManager,
              summariesConfig,
            });

            for (const [botId, webhookHandlers] of newHandlersMap) {
              const prefix = `/webhook/feishu/${botId}`;
              ingress.registerChannelHandlers(`feishu:${botId}`, prefix, webhookHandlers);
              logger.info(`Re-mounted feishu:${botId} webhook handlers at ${prefix}`);
            }

            if (newBots.length === 1) {
              const legacyHandlers = newHandlersMap.get(newBots[0]!.id);
              if (legacyHandlers) {
                ingress.registerChannelHandlers("feishu", "/webhook/feishu", legacyHandlers);
              }
            }
          }

          logger.info("openplaw reload complete");
        } catch (err) {
          logger.error("Reload failed", { error: formatErrorMessage(err) });
          throw err;
        }
      },
    };

    return result;
  }

  // Legacy path: no bots with feishu credentials, use old single-bot flow
  if (config.feishu?.appId && config.feishu?.appSecret) {
    if (!hubClient) {
      throw new Error("Feishu channel requires hubClient — opencodeClient must be provided in BootstrapConfig");
    }
    defineBundledFeishuEntry(config.feishu, {
      sessionBinding,
      hubClient,
      opencodeClient: config.opencodeClient!,
      defaultAgent: config.botName ?? "sisyphus",
    });
  }
  const channels = listChannelPlugins();
  logger.info(`Registered ${channels.length} channel plugin(s)`);

  const ingress = new WebhookIngress({
    port: config.gateway?.port ?? 3000,
    host: config.gateway?.host,
    mounts: [],
  });

  for (const channel of channels) {
    const handlers = getChannelWebhookHandlers(channel.id);
    if (handlers) {
      const prefix = `/webhook/${channel.id}`;
      ingress.registerChannelHandlers(channel.id, prefix, handlers);
      logger.info(`Mounted ${channel.id} webhook handlers at ${prefix}`);
    }
  }

  const mcpRegistry = new OpenmoMcpRegistry({
    agentsDir: config.agentsDir,
    verbose: true,
  });

  let mcpResult: McpRegistryResult | null = null;
  try {
    mcpResult = await mcpRegistry.scanAll();
    logger.info(
      `MCP scan complete: ${mcpResult.configs.length} config(s), ${mcpResult.errors.length} error(s)`,
    );
  } catch (err) {
    logger.error("MCP scan failed", { error: formatErrorMessage(err) });
  }

  const autoReply = new AutoReplyHandler({
    sessionBinding,
    botName: config.botName,
  });

  const healthServer = new HealthCheckServer({
    port: config.healthPort ?? 9090,
  });

  let heartbeatStop: (() => void) | null = null;
  if (config.heartbeat?.enabled) {
    heartbeatStop = startHeartbeatRunner(
      { intervalMs: config.heartbeat.intervalMs ?? 300_000, enabled: true },
      async () => {
        logger.debug("Heartbeat tick");
      },
    ).stop;
  }

  let ingressRuntime: WebhookIngressRuntime | null = null;

  const result: BootstrapResult = {
    sessionBinding,
    summariesConfig,
    groupResolver,
    botRegistry,
    mcpRegistry,
    mcpResult,
    autoReply,
    healthServer,
    ingressPort: null,
    hubClient,
    resourceManager,
    configDir: config.configDir ?? resolveConfigDir(),
    start: async () => {
      logger.info("openplaw starting...");
      await healthServer.start();
      logger.info(`Health check server on port ${config.healthPort ?? 9090}`);
      ingressRuntime = await ingress.start();
      logger.info(`Gateway listening on port ${ingressRuntime.port}`);
      logger.info("openplaw started");
    },
    stop: async () => {
      logger.info("openplaw stopping...");
      heartbeatStop?.();
      await healthServer.stop();
      await ingress.stop();
      ingressRuntime = null;
      if (hubClient) {
        await hubClient.close();
        hubClient = null;
      }
      if (hubServer) {
        await hubServer.close();
        hubServer = null;
      }
      await sessionBinding.dispose();
      logger.info("openplaw stopped");
    },
    reload: async (newConfig?: BootstrapConfig) => {
      logger.info("openplaw reloading (legacy path)...");
      try {
        const reloadConfig = newConfig ?? config;
        const { bots: newBots, groups: newGroups } = resolveBotsAndGroups(reloadConfig);
        await resourceManager.reload(newBots, newGroups);
        result.groupResolver = new GroupResolver(newBots, newGroups);
        result.botRegistry = new BotCredentialsRegistry(newBots);
        setBotRegistry(result.botRegistry);
        if (hubRegistry) {
          hubRegistry.clear();
          const refreshed = resourceManager.getCached();
          if (refreshed) {
            for (const [, projectCtx] of refreshed.projects) {
              for (const mcp of projectCtx.mcps) {
                hubRegistry.register({
                  name: mcp.name,
                  source: "external",
                  config: adaptToMcpServerConfig(mcp.name, mcp.config),
                  enabled: !mcp.config.disabled,
                });
              }
            }
            for (const mcp of refreshed.globalMcps) {
              hubRegistry.register({
                name: mcp.name,
                source: "external",
                config: adaptToMcpServerConfig(mcp.name, mcp.config),
                enabled: !mcp.config.disabled,
              });
            }
          }
        }
        logger.info("openplaw reload complete (legacy path)");
      } catch (err) {
        logger.error("Reload failed", { error: formatErrorMessage(err) });
        throw err;
      }
    },
  };

  return result;
}
