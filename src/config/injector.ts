import type { OpencodeConfig } from "./types.js";
import type { LoadedConfigs } from "./loader.js";
import type { MergedConfigResult } from "./merger.js";
import { resolveConfigDir } from "./loader.js";
import { logger } from "../infra/logger.js";

export type InjectResult = {
  configContent: string;
  opencodeConfigDir: string;
};

export function serializeConfig(config: OpencodeConfig): string {
  return JSON.stringify(config);
}

export async function injectConfig(configs: LoadedConfigs, merged: MergedConfigResult): Promise<InjectResult> {
  const configContent = serializeConfig(merged.opencodeConfig);
  const opencodeConfigDir = resolveConfigDir();

  logger.info("Config injected", { opencodeConfigDir });

  return { configContent, opencodeConfigDir };
}
