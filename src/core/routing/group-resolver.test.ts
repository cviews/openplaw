import { describe, it, expect } from "vitest";
import { GroupResolver } from "./group-resolver.js";
import type { OpenmoBotConfig, OpenmoGroupConfig } from "../../config/config.js";

const BOT_A: OpenmoBotConfig = {
  id: "bot-a",
  agent: "oracle",
  appId: "cli_a",
  appSecret: "sec_a",
  verificationToken: "vt_a",
  encryptKey: "ek_a",
  botName: "OracleBot",
};

const BOT_B: OpenmoBotConfig = {
  id: "bot-b",
  agent: "explore",
  appId: "cli_b",
  appSecret: "sec_b",
  verificationToken: "vt_b",
  encryptKey: "ek_b",
  botName: "ExploreBot",
};

const BOT_C: OpenmoBotConfig = {
  id: "bot-c",
  agent: "librarian",
  appId: "cli_c",
  appSecret: "sec_c",
  verificationToken: "vt_c",
  encryptKey: "ek_c",
  botName: "LibrarianBot",
};

const GROUP_ALPHA: OpenmoGroupConfig = {
  id: "team-alpha",
  chatId: "oc_alpha",
  name: "研发部群",
  bots: ["bot-a", "bot-b"],
};

const GROUP_BETA: OpenmoGroupConfig = {
  id: "team-beta",
  chatId: "oc_beta",
  name: "产品部群",
  bots: ["bot-b", "bot-c"],
};

describe("GroupResolver", () => {
  it("resolves chatId + botId to group and bot", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B, BOT_C], [GROUP_ALPHA, GROUP_BETA]);

    const result = resolver.resolve("oc_alpha", "bot-a");
    expect(result).not.toBeNull();
    expect(result!.group.id).toBe("team-alpha");
    expect(result!.bot.id).toBe("bot-a");
    expect(result!.availableBots.length).toBe(2);
    expect(result!.availableBots.map((b) => b.id)).toEqual(["bot-a", "bot-b"]);
  });

  it("returns null for unknown chatId", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.resolve("oc_unknown", "bot-a")).toBeNull();
  });

  it("returns null for unknown botId", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.resolve("oc_alpha", "bot-unknown")).toBeNull();
  });

  it("returns null when bot is not in the group", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B, BOT_C], [GROUP_ALPHA, GROUP_BETA]);
    expect(resolver.resolve("oc_alpha", "bot-c")).toBeNull();
  });

  it("getBotById returns bot config", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.getBotById("bot-a")).toEqual(BOT_A);
  });

  it("getBotById returns null for unknown id", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.getBotById("bot-unknown")).toBeNull();
  });

  it("isBotInGroup returns true when bot is in group", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.isBotInGroup("bot-a", "oc_alpha")).toBe(true);
  });

  it("isBotInGroup returns false when bot is not in group", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B, BOT_C], [GROUP_ALPHA, GROUP_BETA]);
    expect(resolver.isBotInGroup("bot-c", "oc_alpha")).toBe(false);
  });

  it("isBotInGroup returns false for unknown chatId", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.isBotInGroup("bot-a", "oc_unknown")).toBe(false);
  });

  it("getAvailableBotIds returns all bot ids in group", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B, BOT_C], [GROUP_ALPHA, GROUP_BETA]);
    expect(resolver.getAvailableBotIds("oc_beta")).toEqual(["bot-b", "bot-c"]);
  });

  it("getAvailableBotIds returns empty for unknown chatId", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.getAvailableBotIds("oc_unknown")).toEqual([]);
  });

  it("getBotsForGroup returns full bot configs", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    const bots = resolver.getBotsForGroup("oc_alpha");
    expect(bots.length).toBe(2);
    expect(bots[0]).toEqual(BOT_A);
    expect(bots[1]).toEqual(BOT_B);
  });

  it("getBotsForGroup returns empty for unknown chatId", () => {
    const resolver = new GroupResolver([BOT_A, BOT_B], [GROUP_ALPHA]);
    expect(resolver.getBotsForGroup("oc_unknown")).toEqual([]);
  });

  it("throws on duplicate bot ids", () => {
    expect(() => {
      new GroupResolver([BOT_A, { ...BOT_A }], [GROUP_ALPHA]);
    }).toThrow('Duplicate bot id: "bot-a"');
  });

  it("throws on group referencing unknown bot id", () => {
    const group: OpenmoGroupConfig = { id: "g", chatId: "oc_x", name: "G", bots: ["unknown"] };
    expect(() => {
      new GroupResolver([BOT_A], [group]);
    }).toThrow('Group "g" references unknown bot id: "unknown"');
  });

  it("throws on duplicate chatIds across groups", () => {
    const g1: OpenmoGroupConfig = { id: "g1", chatId: "oc_dup", name: "G1", bots: ["bot-a"] };
    const g2: OpenmoGroupConfig = { id: "g2", chatId: "oc_dup", name: "G2", bots: ["bot-a"] };
    expect(() => {
      new GroupResolver([BOT_A], [g1, g2]);
    }).toThrow('Duplicate chatId across groups: "oc_dup"');
  });

  it("allows groups with empty chatId (unlearned)", () => {
    const group: OpenmoGroupConfig = { id: "g1", chatId: "", name: "Default", bots: ["bot-a"] };
    const group2: OpenmoGroupConfig = { id: "g2", chatId: "", name: "Default2", bots: ["bot-a"] };
    expect(() => {
      new GroupResolver([BOT_A], [group, group2]);
    }).not.toThrow();
  });

  it("handles empty bots and groups", () => {
    const resolver = new GroupResolver([], []);
    expect(resolver.resolve("oc_alpha", "bot-a")).toBeNull();
    expect(resolver.getBotById("bot-a")).toBeNull();
    expect(resolver.getAvailableBotIds("oc_alpha")).toEqual([]);
    expect(resolver.getBotsForGroup("oc_alpha")).toEqual([]);
  });
});
