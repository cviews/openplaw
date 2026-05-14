import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpencodeConfig } from "./types.js";
import type { LoadedConfigs, OmoFileConfig } from "./loader.js";
import type { MergedConfigResult } from "./merger.js";
import { resolveConfigDir } from "../utils/path.js";
import { logger } from "../infra/logger.js";

export type InjectResult = {
  configContent: string;       // JSON string for OPENCODE_CONFIG_CONTENT env var
  opencodeConfigDir: string;   // Resolved opencode config directory path
};

/**
 * Serialize a Config object to a JSON string.
 * Pure function — no side effects, suitable for testing without mocks.
 */
export function serializeConfig(config: OpencodeConfig): string {
  return JSON.stringify(config);
}

/**
 * Write omo config to the opencode config directory using atomic write.
 * Creates the directory if it doesn't exist.
 */
export async function writeOmoConfig(omoConfig: OmoFileConfig, configDir: string): Promise<void> {
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, "oh-my-opencode.json");
  const content = JSON.stringify(omoConfig, null, 2) + "\n";
  const tmpPath = configPath + ".tmp";

  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, configPath);
    logger.debug("Wrote omo config", { path: configPath });
  } catch (err: unknown) {
    try {
      if (existsSync(tmpPath)) await unlink(tmpPath);
    } catch {
      // intentional no-op
    }
    if ((err as NodeJS.ErrnoException | null)?.code === "EACCES") {
      throw new Error(`Permission denied writing config file: ${configPath}`);
    }
    throw err;
  }
}

/**
 * Prepare the merged config for TUI launch:
 * 1. Serialize the merged opencode config as JSON → for OPENCODE_CONFIG_CONTENT env var
 * 2. Write omo config to the opencode config directory → omo reads it from there
 */
export async function injectConfig(configs: LoadedConfigs, merged: MergedConfigResult): Promise<InjectResult> {
  const configContent = serializeConfig(merged.opencodeConfig);
  const opencodeConfigDir = resolveConfigDir();

  await writeOmoConfig(configs.omo, opencodeConfigDir);

  logger.info("Config injected", { opencodeConfigDir });

  return { configContent, opencodeConfigDir };
}
