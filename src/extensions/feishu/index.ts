import { registerChannelPlugin, registerChannelWebhookHandlers } from "../../channels/registry.js";
import {
  createFeishuChannelPlugin,
  getFeishuWebhookHandlers,
  setBotRegistry,
  BotCredentialsRegistry,
} from "./src/index.js";
import { createFeishuWebhookHandlersForBot, type FeishuWebhookHandlers } from "./src/handler.js";
import type { SessionBindingService } from "../../core/routing/session-binding.js";
import type { HubClientResult } from "../../mcp/hub/hub-client.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpenmoBotConfig, OpenmoGroupConfig } from "../../config/config.js";
import type { ResourceManager } from "../../resource/index.js";
export type { FeishuChannelConfig } from "./src/index.js";

export type FeishuEntryDeps = {
  sessionBinding: SessionBindingService;
  hubClient: HubClientResult;
  opencodeClient: OpencodeClient;
  defaultAgent?: string;
};

import type { SummaryConfig } from "../../config/session-summary.js";

export type FeishuMultiBotEntryDeps = {
  sessionBinding: SessionBindingService;
  hubClient: HubClientResult;
  opencodeClient: OpencodeClient;
  resourceManager: ResourceManager;
  summariesConfig?: SummaryConfig;
  onCardAction?: (event: unknown) => Promise<void>;
};

export function defineBundledFeishuEntry(
  config: import("./src/index.js").FeishuChannelConfig,
  deps: FeishuEntryDeps,
): void {
  const plugin = createFeishuChannelPlugin(config, {
    sessionBinding: deps.sessionBinding,
    hubClient: deps.hubClient,
    defaultAgent: deps.defaultAgent,
  });
  registerChannelPlugin(plugin);

  const handlers = getFeishuWebhookHandlers();
  if (handlers) {
    registerChannelWebhookHandlers("feishu", handlers);
  }
}

export function createFeishuHandlersForGroups(
  bots: OpenmoBotConfig[],
  groups: OpenmoGroupConfig[],
  deps: FeishuMultiBotEntryDeps,
): Map<string, FeishuWebhookHandlers> {
  const registry = new BotCredentialsRegistry(bots);
  setBotRegistry(registry);

  const handlersMap = new Map<string, FeishuWebhookHandlers>();

  // Build a map of botId → group project for quick lookup
  const botProjectMap = new Map<string, string>();
  for (const group of groups) {
    for (const botId of group.bots) {
      if (group.project) {
        botProjectMap.set(botId, group.project);
      }
    }
  }

  for (const bot of bots) {
    const handlers = createFeishuWebhookHandlersForBot(bot, {
      sessionBinding: deps.sessionBinding,
      hubClient: deps.hubClient,
      opencodeClient: deps.opencodeClient,
      project: botProjectMap.get(bot.id),
      resourceManager: deps.resourceManager,
      summariesConfig: deps.summariesConfig,
      onCardAction: deps.onCardAction,
    });
    handlersMap.set(bot.id, handlers);
  }

  return handlersMap;
}

export { createFeishuChannelPlugin, getFeishuWebhookHandlers, BotCredentialsRegistry, setBotRegistry } from "./src/index.js";
export { createFeishuWebhookHandlersForBot } from "./src/handler.js";
