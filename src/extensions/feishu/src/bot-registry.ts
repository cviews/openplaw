import * as lark from "@larksuiteoapi/node-sdk";
import type { OpenmoBotConfig } from "../../../config/config.js";

export class BotCredentialsRegistry {
  private bots: Map<string, OpenmoBotConfig>;
  private clients: Map<string, lark.Client>;

  constructor(bots: OpenmoBotConfig[]) {
    this.bots = new Map();
    this.clients = new Map();
    for (const bot of bots) {
      this.bots.set(bot.id, bot);
    }
  }

  getBotConfig(botId: string): OpenmoBotConfig | null {
    return this.bots.get(botId) ?? null;
  }

  getClient(botId: string): lark.Client | null {
    const cached = this.clients.get(botId);
    if (cached) return cached;

    const botConfig = this.bots.get(botId);
    if (!botConfig) return null;

    const client = new lark.Client({
      appId: botConfig.appId,
      appSecret: botConfig.appSecret,
      appType: lark.AppType.SelfBuild,
    });
    this.clients.set(botId, client);
    return client;
  }

  getAllBotIds(): string[] {
    return [...this.bots.keys()];
  }

  findByVerificationToken(token: string): OpenmoBotConfig | null {
    for (const bot of this.bots.values()) {
      if (bot.verificationToken === token) return bot;
    }
    return null;
  }

  getDefaultBot(): OpenmoBotConfig | null {
    const firstEntry = this.bots.values().next();
    return firstEntry.done ? null : firstEntry.value;
  }

  getDefaultClient(): lark.Client | null {
    const defaultBot = this.getDefaultBot();
    if (!defaultBot) return null;
    return this.getClient(defaultBot.id);
  }
}
