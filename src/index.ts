import type { PluginInput, PluginOptions, Hooks, PluginModule } from "@opencode-ai/plugin";

import { createOpenmoBootstrap } from "./bootstrap/bootstrap.js";
import { resolveConfig, type OpenmoPluginConfig } from "./config/config.js";
import { resolveOpenmoDir } from "./config/loader.js";
import path from "node:path";
import { createVisibilityHandlers } from "./core/visibility/visibility-hook.js";
import { createRouteToBotTool } from "./core/routing/route-to-bot.js";
import { getChannelPlugin } from "./channels/registry.js";

const DEFAULT_BOT_AGENT_MAP: Record<string, string> = {
  oracle: "OracleBot",
  explore: "ExploreBot",
  librarian: "LibrarianBot",
  metis: "MetisBot",
  momus: "MomusBot",
};

export type OpenmoOptions = PluginOptions &
  OpenmoPluginConfig & {
    botAgentMap?: Record<string, string>;
  };

export async function openplawServerPlugin(
  input: PluginInput,
  options?: OpenmoOptions,
): Promise<Hooks> {
  const resolvedConfig = resolveConfig(options);
  const botAgentMap = options?.botAgentMap ?? DEFAULT_BOT_AGENT_MAP;

  const bootstrap = await createOpenmoBootstrap({
    bots: resolvedConfig.bots,
    groups: resolvedConfig.groups,
    feishu: resolvedConfig.channels["feishu"] as
      | {
          appId: string;
          appSecret: string;
          verificationToken: string;
          encryptKey: string;
          botName: string;
          port?: number;
        }
      | undefined,
    agentsDir: path.join(resolveOpenmoDir(), "agents"),
    botName: Object.values(botAgentMap)[0],
    gateway: {
      port: resolvedConfig.gateway.port,
      host: resolvedConfig.gateway.host,
    },
  });

  await bootstrap.start();

  const client = input.client;

  const { before, after } = createVisibilityHandlers({
    sessionBinding: bootstrap.sessionBinding,
    getChannel: getChannelPlugin,
    botAgentMap,
  });

  const routeToBot = createRouteToBotTool({
    client,
    sessionBinding: bootstrap.sessionBinding,
    groupResolver: bootstrap.groupResolver,
    botRegistry: bootstrap.botRegistry,
    getChannel: getChannelPlugin,
  });

  return {
    tool: { route_to_bot: routeToBot },
    "tool.execute.before": before,
    "tool.execute.after": after,
  };
}

const pluginModule: PluginModule = { id: "openplaw", server: openplawServerPlugin };
export default pluginModule;
