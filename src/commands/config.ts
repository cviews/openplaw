import { loadOpenmoConfigs } from "../config/loader.js";
import { mergeConfig } from "../config/merger.js";
import { logger } from "../infra/logger.js";

export type ConfigCommandOptions = Record<string, never>;

export async function configCommand(_options?: ConfigCommandOptions): Promise<void> {
  const configs = await loadOpenmoConfigs();
  const merged = mergeConfig(configs);

  const output = {
    openplawDir: configs.openplawDir,
    openplaw: configs.openplaw,
    opencode: configs.opencode,
    omo: configs.omo,
    mergedOpencodeConfig: merged.opencodeConfig,
  };

  logger.info(`Resolved openplaw directory: ${configs.openplawDir}`);
  console.log(JSON.stringify(output, null, 2));
}
