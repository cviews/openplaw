import * as path from "node:path";
import type { SkillMcpConfig } from "../mcp/index.js";
import type { SessionResetConfig } from "../core/routing/session-binding.js";
import type { SummaryConfig } from "./session-summary.js";
import { resolveOpenmoDir, resolveConfigDir } from "./loader.js";

export type OpenmoBotConfig = {
  id: string;
  agent: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  botName: string;
};

export type OpenmoGroupConfig = {
  id: string;
  chatId: string;
  name: string;
  bots: string[];
  project?: string;
};

export type OpenmoPluginConfig = {
  bots?: OpenmoBotConfig[];
  groups?: OpenmoGroupConfig[];
  /** @deprecated Use bots/groups instead. Auto-converted to bots/groups. */
  channels?: Record<string, unknown>;
  agents?: {
    directory?: string;
    /** @deprecated Bot-agent mapping is now derived from OpenmoBotConfig.agent */
    botAgentMap?: Record<string, string>;
  };
  mcp?: {
    servers?: SkillMcpConfig;
    autoRegister?: boolean;
  };
  session?: {
    reset?: {
      daily?: boolean;
      idleMinutes?: number;
    };
    summaries?: {
      pruneAfterDays?: number;
      maxEntries?: number;
      maxDiskMB?: number;
    };
  };
};

export type OpenmoConfig = {
  bots: OpenmoBotConfig[];
  groups: OpenmoGroupConfig[];
  agents: {
    directory: string;
    /** @deprecated Derived from bots for backward compat during migration */
    botAgentMap: Record<string, string>;
  };
  mcp: {
    servers: SkillMcpConfig;
    autoRegister: boolean;
  };
  gateway: {
    port: number;
    host: string;
  };
  bindings: {
    dir: string;
    file: string;
    ttlMs: number;
  };
  session: {
    reset: SessionResetConfig;
    summaries: SummaryConfig;
  };
  verbose: boolean;
  configDir: string;
  /** @deprecated Derived from bots[0] for backward compat during migration */
  channels: Record<string, unknown>;
};

const DEFAULT_BINDINGS_FILE = "current-conversations.json";
const DEFAULT_BINDINGS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_GATEWAY_HOST = "0.0.0.0";

function convertLegacyChannelsToBotsGroups(
  channels: Record<string, unknown>,
  legacyBotAgentMap?: Record<string, string>,
): { bots: OpenmoBotConfig[]; groups: OpenmoGroupConfig[] } {
  const bots: OpenmoBotConfig[] = [];
  const groups: OpenmoGroupConfig[] = [];

  const feishu = channels["feishu"];
  if (typeof feishu === "object" && feishu !== null) {
    const cfg = feishu as Record<string, unknown>;
    const appId = typeof cfg["appId"] === "string" ? cfg["appId"] : "";
    const appSecret = typeof cfg["appSecret"] === "string" ? cfg["appSecret"] : "";
    const verificationToken = typeof cfg["verificationToken"] === "string" ? cfg["verificationToken"] : "";
    const encryptKey = typeof cfg["encryptKey"] === "string" ? cfg["encryptKey"] : "";
    const botName = typeof cfg["botName"] === "string" ? cfg["botName"] : "main";
    const agent = (legacyBotAgentMap && botName in legacyBotAgentMap) ? botName : botName;
    const botId = botName;

    bots.push({ id: botId, agent, appId, appSecret, verificationToken, encryptKey, botName });
    groups.push({ id: "default", chatId: "", name: "default", bots: [botId] });
  }

  return { bots, groups };
}

export function resolveConfig(input?: OpenmoPluginConfig): OpenmoConfig {
  const partial = input ?? {};

  let bots: OpenmoBotConfig[];
  let groups: OpenmoGroupConfig[];

  if (partial.bots && partial.bots.length > 0) {
    bots = partial.bots;
    groups = partial.groups ?? [];
  } else if (partial.channels && Object.keys(partial.channels).length > 0) {
    const converted = convertLegacyChannelsToBotsGroups(partial.channels, partial.agents?.botAgentMap);
    bots = converted.bots;
    groups = converted.groups;
  } else {
    bots = [];
    groups = [];
  }

  const channels: Record<string, unknown> = {};
  if (bots.length === 1) {
    const bot = bots[0]!;
    channels["feishu"] = {
      appId: bot.appId,
      appSecret: bot.appSecret,
      verificationToken: bot.verificationToken,
      encryptKey: bot.encryptKey,
      botName: bot.botName,
    };
  }

  const botAgentMap: Record<string, string> = {};
  for (const bot of bots) {
    botAgentMap[bot.id] = bot.botName;
    botAgentMap[bot.agent] = bot.botName;
  }
  if (partial.agents?.botAgentMap) {
    for (const [key, value] of Object.entries(partial.agents.botAgentMap)) {
      if (!(key in botAgentMap)) {
        botAgentMap[key] = value;
      }
    }
  }

  const openplawDir = resolveOpenmoDir();
  const configDirPath = resolveConfigDir();

  return {
    bots,
    groups,
    channels,
    agents: {
      directory: partial.agents?.directory ?? path.join(openplawDir, "agents"),
      botAgentMap: botAgentMap,
    },
    mcp: {
      servers: partial.mcp?.servers ?? {},
      autoRegister: partial.mcp?.autoRegister ?? true,
    },
    gateway: {
      port: DEFAULT_GATEWAY_PORT,
      host: DEFAULT_GATEWAY_HOST,
    },
    bindings: {
      dir: path.join(openplawDir, "bindings"),
      file: DEFAULT_BINDINGS_FILE,
      ttlMs: DEFAULT_BINDINGS_TTL_MS,
    },
    session: {
      reset: {
        daily: partial.session?.reset?.daily ?? true,
        idleMinutes: partial.session?.reset?.idleMinutes ?? 0,
      },
      summaries: {
        pruneAfterDays: partial.session?.summaries?.pruneAfterDays ?? 30,
        maxEntries: partial.session?.summaries?.maxEntries ?? 100,
        maxDiskMB: partial.session?.summaries?.maxDiskMB ?? 50,
      },
    },
    verbose: false,
    configDir: configDirPath,
  };
}
