import type { OpenmoChannelPlugin } from "../plugin-sdk/channel-contract.js";
import { getChannelPlugin, listChannelPlugins } from "../channels/registry.js";
import type { SessionBindingService } from "../core/routing/session-binding.js";
import { logger } from "../infra/logger.js";

export type AutoReplyContext = {
  channel: string;
  text: string;
  chatId: string;
  senderId?: string;
  replyToId?: string;
};

export type AutoReplyHandlerOptions = {
  sessionBinding: SessionBindingService;
  botName?: string;
};

type AutoReplyPattern = {
  match: (text: string) => boolean;
  respond: (ctx: AutoReplyContext, channel: OpenmoChannelPlugin) => Promise<void>;
};

export class AutoReplyHandler {
  private sessionBinding: SessionBindingService;
  private botName: string;
  private patterns: AutoReplyPattern[];

  constructor(options: AutoReplyHandlerOptions) {
    this.sessionBinding = options.sessionBinding;
    this.botName = options.botName ?? "openplaw";
    this.patterns = this.buildPatterns();
  }

  async handle(ctx: AutoReplyContext): Promise<boolean> {
    const channel = getChannelPlugin(ctx.channel);
    if (!channel) {
      return false;
    }

    const normalizedText = ctx.text.trim().toLowerCase();

    for (const pattern of this.patterns) {
      if (pattern.match(normalizedText)) {
        try {
          await pattern.respond(ctx, channel);
          return true;
        } catch (err) {
          logger.error("Auto-reply failed", {
            channel: ctx.channel,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      }
    }

    return false;
  }

  private buildPatterns(): AutoReplyPattern[] {
    return [
      {
        match: (text) => text === "help",
        respond: async (ctx, channel) => {
          const plugins = listChannelPlugins();
          const botList = plugins.map((p) => `- ${p.meta.name} (${p.id})`).join("\n");
          const helpText = `Available bots:\n${botList || "(none registered)"}\n\nCommands: help, status, @${this.botName} ping`;
          await channel.outbound.sendText({
            to: ctx.chatId,
            text: helpText,
            replyToId: ctx.replyToId,
          });
        },
      },
      {
        match: (text) => text === "status",
        respond: async (ctx, channel) => {
          const plugins = listChannelPlugins();
          const statusLines = plugins.map((p) => `${p.id}: active`);
          const statusText = `Binding status: ok\nChannels: ${statusLines.join(", ") || "none"}`;
          await channel.outbound.sendText({
            to: ctx.chatId,
            text: statusText,
            replyToId: ctx.replyToId,
          });
        },
      },
      {
        match: (text) =>
          text === `@${this.botName.toLowerCase()} ping` ||
          text.endsWith(`@${this.botName.toLowerCase()} ping`),
        respond: async (ctx, channel) => {
          await channel.outbound.sendText({
            to: ctx.chatId,
            text: "pong",
            replyToId: ctx.replyToId,
          });
        },
      },
    ];
  }
}
