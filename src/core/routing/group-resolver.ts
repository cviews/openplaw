import type { OpenmoBotConfig, OpenmoGroupConfig } from "../../config/config.js";

export type GroupResolverResult = {
  group: OpenmoGroupConfig;
  bot: OpenmoBotConfig;
  availableBots: OpenmoBotConfig[];
};

export class GroupResolver {
  private bots: Map<string, OpenmoBotConfig>;
  private groups: OpenmoGroupConfig[];
  private chatIdToGroup: Map<string, OpenmoGroupConfig>;

  constructor(bots: OpenmoBotConfig[], groups: OpenmoGroupConfig[]) {
    this.bots = new Map();
    this.groups = groups;
    this.chatIdToGroup = new Map();

    const seenBotIds = new Set<string>();
    for (const bot of bots) {
      if (seenBotIds.has(bot.id)) {
        throw new Error(`Duplicate bot id: "${bot.id}"`);
      }
      seenBotIds.add(bot.id);
      this.bots.set(bot.id, bot);
    }

    const seenChatIds = new Set<string>();
    for (const group of groups) {
      for (const botId of group.bots) {
        if (!this.bots.has(botId)) {
          throw new Error(
            `Group "${group.id}" references unknown bot id: "${botId}"`,
          );
        }
      }

      if (group.chatId) {
        if (seenChatIds.has(group.chatId)) {
          throw new Error(`Duplicate chatId across groups: "${group.chatId}"`);
        }
        seenChatIds.add(group.chatId);
        this.chatIdToGroup.set(group.chatId, group);
      }
    }
  }

  resolve(chatId: string, botId: string): GroupResolverResult | null {
    const group = this.chatIdToGroup.get(chatId);
    if (!group) return null;

    const bot = this.bots.get(botId);
    if (!bot) return null;

    if (!group.bots.includes(botId)) return null;

    const availableBots = group.bots
      .map((id) => this.bots.get(id))
      .filter((b): b is OpenmoBotConfig => b !== undefined);

    return { group, bot, availableBots };
  }

  getBotById(botId: string): OpenmoBotConfig | null {
    return this.bots.get(botId) ?? null;
  }

  isBotInGroup(botId: string, chatId: string): boolean {
    const group = this.chatIdToGroup.get(chatId);
    if (!group) return false;
    return group.bots.includes(botId);
  }

  getAvailableBotIds(chatId: string): string[] {
    const group = this.chatIdToGroup.get(chatId);
    if (!group) return [];
    return [...group.bots];
  }

  getBotsForGroup(chatId: string): OpenmoBotConfig[] {
    const group = this.chatIdToGroup.get(chatId);
    if (!group) return [];
    return group.bots
      .map((id) => this.bots.get(id))
      .filter((b): b is OpenmoBotConfig => b !== undefined);
  }
}
