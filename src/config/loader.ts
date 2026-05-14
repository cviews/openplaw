import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { stripJsonc } from "../utils/json.js";
import { logger } from "../infra/logger.js";
import type { ChannelCredentials } from "./types.js";
import type { OpenmoBotConfig, OpenmoGroupConfig } from "./config.js";
import { loadExternalMcpConfigs } from "../mcp/external/mcp-loader.js";

export type OpenmoFileConfig = {
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
    servers?: Record<string, unknown>;
    autoRegister?: boolean;
  };
};

export type OpencodeFileConfig = {
  [key: string]: unknown;
  plugin?: Array<string | [string, Record<string, unknown>]>;
};

export type OmoFileConfig = {
  [key: string]: unknown;
};

export type LoadedConfigs = {
  openplaw: OpenmoFileConfig;
  opencode: OpencodeFileConfig;
  omo: OmoFileConfig;
  openplawDir: string;
  configDir: string;
  externalMcps: import("../mcp/external/mcp-loader.js").McpLoadResult;
};

export function resolveOpenmoDir(): string {
  return process.env["OPENMO_HOME"] ?? path.join(os.homedir(), ".openplaw");
}

export function resolveConfigDir(): string {
  return process.env["OPENMO_CONFIG_HOME"] ?? process.env["OPENMO_HOME"] ?? path.join(os.homedir(), ".config", "openplaw");
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  if (!existsSync(filePath)) {
    return {} as T;
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const jsonText = stripJsonc(raw);
    return JSON.parse(jsonText) as T;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Corrupt JSON in config file ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

async function readJsonFileWithFallback<T>(fileName: string, configDir: string, fallbackDir: string): Promise<T> {
  const configPath = path.join(configDir, fileName);
  if (existsSync(configPath)) {
    return readJsonFile<T>(configPath);
  }
  const fallbackPath = path.join(fallbackDir, fileName);
  return readJsonFile<T>(fallbackPath);
}

/** @deprecated Credentials are now embedded in OpenmoBotConfig. Kept for migration compat. */
export async function loadCredentials(configDir: string, fallbackDir?: string): Promise<Map<string, ChannelCredentials>> {
  const result = new Map<string, ChannelCredentials>();

  const dirs = [configDir];
  if (fallbackDir && fallbackDir !== configDir) {
    dirs.push(fallbackDir);
  }

  for (const dir of dirs) {
    const credentialsDir = path.join(dir, "credentials");

    if (!existsSync(credentialsDir)) {
      logger.debug(`Credentials directory not found: ${credentialsDir}`);
      continue;
    }

    let entries: string[];
    try {
      entries = await readdir(credentialsDir);
    } catch {
      logger.debug(`Failed to read credentials directory: ${credentialsDir}`);
      continue;
    }

    const jsonFiles = entries.filter((name) => name.endsWith(".json"));
    logger.debug(`Found ${jsonFiles.length} credential files in ${credentialsDir}: ${jsonFiles.join(",")}`);

    for (const fileName of jsonFiles) {
      const filePath = path.join(credentialsDir, fileName);

      let parsed: unknown;
      try {
        const raw = await readFile(filePath, "utf-8");
        parsed = JSON.parse(stripJsonc(raw));
      } catch (err: unknown) {
        if (err instanceof SyntaxError) {
          throw new Error(`Corrupt JSON in credentials file ${filePath}: ${err.message}`);
        }
        throw err;
      }

      if (typeof parsed !== "object" || parsed === null || !("channelId" in parsed)) {
        throw new Error(`Missing channelId in credentials file ${filePath}`);
      }

      const cred = parsed as Record<string, unknown>;
      if (typeof cred["channelId"] !== "string") {
        throw new Error(`channelId is not a string in credentials file ${filePath}`);
      }

      const channelId = cred["channelId"];
      if (result.has(channelId)) continue;
      const { channelId: channelIdToExclude, ...rest } = cred;
      void channelIdToExclude;
      result.set(channelId, { channelId, ...rest } as ChannelCredentials);
    }
  }

  return result;
}

/** @deprecated Credentials are now embedded in OpenmoBotConfig. Kept for migration compat. */
export function mergeCredentialsIntoOpenmoConfig(
  openplawConfig: OpenmoFileConfig,
  credentials: Map<string, ChannelCredentials>,
): void {
  if (credentials.size === 0) {
    return;
  }

  if (!openplawConfig.channels) {
    openplawConfig.channels = {};
  }

  for (const [channelId, cred] of credentials) {
    const { channelId: channelIdToExclude, ...secretFields } = cred;
    void channelIdToExclude;
    const existing = openplawConfig.channels[channelId];
    openplawConfig.channels[channelId] = {
      ...(typeof existing === "object" && existing !== null ? existing as Record<string, unknown> : {}),
      ...secretFields,
    };
  }

  // Also merge credentials into bots[] by matching appId
  if (openplawConfig.bots && openplawConfig.bots.length > 0) {
    for (const [channelId, cred] of credentials) {
      const { channelId: _, appId: credAppId, ...secretFields } = cred;
      void _;
      for (const bot of openplawConfig.bots) {
        if (bot.appId === credAppId) {
          Object.assign(bot, secretFields);
          logger.debug(`Merged credentials into bot "${bot.id}" (appId: ${credAppId}), keys: ${Object.keys(secretFields).join(",")}`);
        }
      }
    }
  }
}

function autoConvertLegacyFormat(openplaw: OpenmoFileConfig): void {
  if (openplaw.bots && openplaw.bots.length > 0) {
    return;
  }

  if (!openplaw.channels || Object.keys(openplaw.channels).length === 0) {
    return;
  }

  const feishu = openplaw.channels["feishu"];
  if (typeof feishu !== "object" || feishu === null) {
    return;
  }

  const cfg = feishu as Record<string, unknown>;
  const appId = typeof cfg["appId"] === "string" ? cfg["appId"] : "";
  const appSecret = typeof cfg["appSecret"] === "string" ? cfg["appSecret"] : "";
  const verificationToken = typeof cfg["verificationToken"] === "string" ? cfg["verificationToken"] : "";
  const encryptKey = typeof cfg["encryptKey"] === "string" ? cfg["encryptKey"] : "";
  const botName = typeof cfg["botName"] === "string" ? cfg["botName"] : "main";

  const botId = botName;
  openplaw.bots = [
    { id: botId, agent: botName, appId, appSecret, verificationToken, encryptKey, botName },
  ];
  openplaw.groups = [
    { id: "default", chatId: "", name: "default", bots: [botId] },
  ];

  logger.warn("Using deprecated channels format, consider migrating to bots/groups");
}

export async function loadOpenmoConfigs(): Promise<LoadedConfigs> {
  const openplawDir = resolveOpenmoDir();
  const configDir = resolveConfigDir();

  const [openplaw, opencode, omo] = await Promise.all([
    readJsonFileWithFallback<OpenmoFileConfig>("openplaw.json", configDir, openplawDir),
    readJsonFileWithFallback<OpencodeFileConfig>("opencode.json", configDir, openplawDir),
    readJsonFileWithFallback<OmoFileConfig>("omo.json", configDir, openplawDir),
  ]);

  const credentials = await loadCredentials(configDir, openplawDir);
  mergeCredentialsIntoOpenmoConfig(openplaw, credentials);

  autoConvertLegacyFormat(openplaw);

  const externalMcps = loadExternalMcpConfigs(openplawDir, configDir);

  if (externalMcps.discovered.length > 0) {
    logger.debug("Discovered external MCPs", { count: externalMcps.discovered.length });
  }
  if (externalMcps.errors.length > 0) {
    logger.warn("External MCP load errors", { count: externalMcps.errors.length });
  }

  logger.debug("Loaded openplaw configs", { openplawDir, configDir });

  return { openplaw, opencode, omo, openplawDir, configDir, externalMcps };
}
