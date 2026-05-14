import type { OpencodeConfig } from "./types.js";
import type {
  OpenmoFileConfig,
  OpencodeFileConfig,
  LoadedConfigs,
} from "./loader.js";
import { logger } from "../infra/logger.js";

export type MergedConfigResult = {
  opencodeConfig: OpencodeConfig;
  openplawConfig: OpenmoFileConfig;
};

type PluginEntry = string | [string, Record<string, unknown>];

const AUTO_PLUGINS = ["oh-my-openagent@latest"] as const;

function getPluginName(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry[0];
}

export function injectPlugins(
  baseConfig: OpencodeFileConfig,
  plugins: ReadonlyArray<string>,
): OpencodeConfig {
  const existing: PluginEntry[] = Array.isArray(baseConfig.plugin)
    ? [...baseConfig.plugin]
    : [];

  const existingNames = new Set(existing.map(getPluginName));

  const toAdd = plugins.filter((name) => !existingNames.has(name));
  const merged: PluginEntry[] = [...existing, ...toAdd];

  const { plugin, ...rest } = baseConfig;
  void plugin;

  const result: OpencodeConfig = {
    ...rest,
    ...(merged.length > 0 ? { plugin: merged as Array<string> } : {}),
  };

  return result;
}

export function mergeConfig(configs: LoadedConfigs): MergedConfigResult {
  let opencodeConfig = injectPlugins(
    configs.opencode,
    [...AUTO_PLUGINS],
  );

  if (!opencodeConfig.compaction) {
    opencodeConfig.compaction = { auto: true, tail_turns: 20 };
  }

  // Auto-approve all tool operations for non-interactive bot context.
  // In bot sessions there is no interactive user to confirm tool actions,
  // so all permission prompts must be silently approved.
  if (!opencodeConfig.permission) {
    opencodeConfig.permission = "allow";
  }

  return {
    opencodeConfig,
    openplawConfig: configs.openplaw,
  };
}
