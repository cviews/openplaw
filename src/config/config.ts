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

export type OpenmoPortsConfig = {
  /** Gateway webhook port (default: 3000) */
  gateway?: number;
  /** Gateway bind host (default: "0.0.0.0") */
  gatewayHost?: string;
  /** Health check port (default: 9090) */
  health?: number;
  /** OpenCode server port (default: 4096) */
  opencode?: number;
  /** MCP hub server port (default: 4097) */
  hub?: number;
  /** Web UI port (default: 4098) */
  web?: number;
};

export type OpenmoPluginConfig = {
  bots?: OpenmoBotConfig[];
  groups?: OpenmoGroupConfig[];
  /** @deprecated Use bots/groups instead. Auto-converted to bots/groups. */
  channels?: Record<string, unknown>;
  agents?: {
    /** Agent scan directories. String for single dir (backward compat), string[] for multiple dirs. */
    directory?: string | string[];
    /** @deprecated Bot-agent mapping is now derived from OpenmoBotConfig.agent */
    botAgentMap?: Record<string, string>;
  };
  mcp?: {
    servers?: SkillMcpConfig;
    autoRegister?: boolean;
  };
  gateway?: {
    port?: number;
    host?: string;
  };
  ports?: OpenmoPortsConfig;
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
    directory: string[];
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
  ports: {
    health: number;
    opencode: number;
    hub: number;
    web: number;
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

export const DEFAULT_BINDINGS_FILE = "current-conversations.json";
export const DEFAULT_BINDINGS_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GATEWAY_PORT = 3000;
export const DEFAULT_GATEWAY_HOST = "0.0.0.0";
export const DEFAULT_HEALTH_PORT = 9090;
export const DEFAULT_OPENCODE_PORT = 4096;
export const DEFAULT_HUB_PORT = 4097;
export const DEFAULT_WEB_PORT = 4098;

function normalizeAgentsDirectory(
  directory: string | string[] | undefined,
  configDir: string,
): string[] {
  const defaultDir = path.join(configDir, "agents");
  if (directory === undefined) return [defaultDir];
  if (typeof directory === "string") return [directory];
  return directory;
}

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
      directory: normalizeAgentsDirectory(partial.agents?.directory, configDirPath),
      botAgentMap: botAgentMap,
    },
    mcp: {
      servers: partial.mcp?.servers ?? {},
      autoRegister: partial.mcp?.autoRegister ?? true,
    },
    gateway: {
      port: partial.ports?.gateway ?? partial.gateway?.port ?? DEFAULT_GATEWAY_PORT,
      host: partial.ports?.gatewayHost ?? partial.gateway?.host ?? DEFAULT_GATEWAY_HOST,
    },
    ports: {
      health: partial.ports?.health ?? DEFAULT_HEALTH_PORT,
      opencode: partial.ports?.opencode ?? DEFAULT_OPENCODE_PORT,
      hub: partial.ports?.hub ?? DEFAULT_HUB_PORT,
      web: partial.ports?.web ?? DEFAULT_WEB_PORT,
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
