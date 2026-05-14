import {
  tool,
  type Plugin,
  type PluginInput,
  type Hooks,
} from "@opencode-ai/plugin";
import { OpenmoMcpRegistry, type McpRegistryResult } from "../mcp/index.js";
import type { OpenmoPluginConfig } from "../config/config.js";
import type { OpenmoChannelPlugin } from "./channel-contract.js";
import type { OpenmoChannelBridge } from "../mcp/index.js";
import type { SessionBindingService } from "../core/routing/session-binding.js";
import type { GroupResolver } from "../core/routing/group-resolver.js";
import type { BotCredentialsRegistry } from "../extensions/feishu/index.js";

const s = tool.schema;

export type OpenmoRuntimeDeps = {
  channelBridge: OpenmoChannelBridge;
  channelRegistry: {
    get: (channelId: string) => OpenmoChannelPlugin | null;
    register: (plugin: OpenmoChannelPlugin) => void;
    list: () => OpenmoChannelPlugin[];
  };
  sessionBinding: SessionBindingService;
  groupResolver: GroupResolver;
  botRegistry: BotCredentialsRegistry;
  omoClient: {
    session: {
      create: (input: Record<string, unknown>) => Promise<{ data: { id: string } }>;
      promptAsync: (input: Record<string, unknown>) => Promise<unknown>;
      messages: (input: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      status: () => Promise<{ data: Record<string, { type: string }> }>;
    };
  };
};

export type OpenmoPluginModule = {
  id?: string;
  server: Plugin;
  tui?: never;
};

export function createOpenmoPlugin(deps: OpenmoRuntimeDeps, config?: OpenmoPluginConfig): Plugin {
  return async (input: PluginInput, _options?: Record<string, unknown>): Promise<Hooks> => {
    const agentsDir = config?.agents?.directory ?? `${input.directory}/agents`;
    const botAgentMap = config?.agents?.botAgentMap ?? {};

    const mcpRegistry = new OpenmoMcpRegistry({
      agentsDir,
      verbose: false,
    });

    const availableBotIds = deps.botRegistry.getAllBotIds();

    deps.channelBridge.injectDeps({
      sessionBinding: deps.sessionBinding,
      channelRegistry: deps.channelRegistry,
      botAgentMap,
      groupResolver: deps.groupResolver,
      omoClient: deps.omoClient,
    });

    return {
      config: async (omoConfig) => {
        if (config?.mcp?.autoRegister ?? true) {
          const result: McpRegistryResult = await mcpRegistry.scanAll();

          if (omoConfig.mcp === undefined || typeof omoConfig.mcp === "object") {
            const existingServers = (omoConfig as Record<string, unknown>).mcp as
              | Record<string, unknown>
              | undefined;
            const mergedServers = {
              ...((existingServers?.servers as Record<string, unknown>) ?? {}),
              ...result.pluginComponents,
            };
            (omoConfig as Record<string, unknown>).mcp = {
              ...existingServers,
              servers: mergedServers,
            };
          }
        }
      },
      tool: {
        openplaw_route_to_bot: {
          description: `Route a message to another bot in the group chat. Available bots: ${availableBotIds.join(", ") || "(none configured)"}`,
          args: {
            target: s.string().min(1).describe("Bot ID to call"),
            message: s.string().min(1).describe("Task description for the target bot"),
            visible: s.boolean().default(true).describe("Show @mention in group chat"),
          },
          execute: async (args) => {
            const targetId = args.target as string;
            const targetBotConfig = deps.botRegistry.getBotConfig(targetId);
            if (!targetBotConfig) {
              return `Error: Bot "${targetId}" not found. Available bots: ${availableBotIds.join(", ") || "(none)"}`;
            }

            const result = await deps.channelBridge.routeToBot({
              sessionKey: "current",
              target: targetId,
              message: args.message as string,
              visible: args.visible as boolean,
            });
            return result.success
              ? `Routed to ${targetBotConfig.botName}`
              : `Route failed: ${result.error ?? "unknown"}`;
          },
        },
      },
    };
  };
}
