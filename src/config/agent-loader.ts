import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../infra/logger.js";
import type { OpencodeConfig } from "./types.js";
import { resolveConfigDir } from "./loader.js";

export type LoadedAgent = {
  name: string;
  prompt: string;
  overrides?: Record<string, unknown>;
  path: string;
};

/**
 * Scan a directory for custom agent definitions.
 * Only format: <agentsDir>/<name>/prompt.md
 * The prompt.md file contains plain text — no frontmatter, no extra config.
 * The file content IS the agent prompt.
 */
export async function scanCustomAgents(agentsDirs: string | string[]): Promise<LoadedAgent[]> {
  const dirs = typeof agentsDirs === "string" ? [agentsDirs] : agentsDirs;
  const agents: LoadedAgent[] = [];
  const seen = new Set<string>();

  for (const agentsDir of dirs) {
    if (!existsSync(agentsDir)) continue;

    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);

        const promptPath = path.join(agentsDir, entry.name, "prompt.md");
        if (!existsSync(promptPath)) {
          logger.debug(`Agent "${entry.name}" has no prompt.md, skipping`, { dir: path.join(agentsDir, entry.name) });
          continue;
        }

        const prompt = await readFile(promptPath, "utf-8");
        if (!prompt.trim()) {
          logger.warn(`Agent "${entry.name}" has empty prompt.md, skipping`, { path: promptPath });
          continue;
        }

        logger.info(`Loaded custom agent: ${entry.name}`, { path: promptPath });
        agents.push({ name: entry.name, prompt: prompt.trim(), path: promptPath });
      }
    } catch (err) {
      logger.warn("Failed to scan custom agents directory", {
        dir: agentsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return agents;
}

/**
 * Read omo plugin config for agent overrides.
 * omo.json is read from the config dir (~/.config/openplaw/omo.json by default) — this is where agent model/description
 * overrides are configured, same as built-in agents like sisyphus.
 * Custom agents need these overrides merged into OPENCODE_CONFIG_CONTENT.agent
 * because omo only applies pluginConfig.agents to built-in agents, not configAgent.
 */
export async function readOmoAgentOverrides(configDir?: string): Promise<Record<string, Record<string, unknown>>> {
  const dir = configDir ?? resolveConfigDir();
  const filePath = path.join(dir, "omo.json");

  if (!existsSync(filePath)) return {};

  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const agents = parsed["agents"];
    if (typeof agents === "object" && agents !== null) {
      logger.debug(`Read omo agent overrides from ${filePath}`, {
        agents: Object.keys(agents as Record<string, unknown>),
      });
      return agents as Record<string, Record<string, unknown>>;
    }
  } catch (err) {
    logger.debug(`Failed to read omo config: ${filePath}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {};
}

/**
 * Inject custom agents into the opencode config's `agent` field.
 * For each agent found via prompt.md scan:
 *   - Base config: { prompt: content } (omo defaults mode to "subagent")
 *   - If omo.json has an override for this agent name, merge it in
 *     (model, description, fallback_models, etc.)
 *   - omo.json overrides bridge the gap: omo only applies pluginConfig.agents
 *     to built-in agents, not to configAgent from OPENCODE_CONFIG_CONTENT.
 *     So we merge the overrides ourselves before injection.
 */
export function injectCustomAgentsIntoOpencodeConfig(
  opencodeConfig: OpencodeConfig,
  agents: LoadedAgent[],
  omoOverrides: Record<string, Record<string, unknown>>,
): OpencodeConfig {
  if (agents.length === 0) return opencodeConfig;

  const existingAgents = typeof opencodeConfig.agent === "object" && opencodeConfig.agent !== null
    ? { ...opencodeConfig.agent as Record<string, unknown> }
    : {};

  for (const agent of agents) {
    if (existingAgents[agent.name]) {
      logger.warn(`Custom agent "${agent.name}" conflicts with existing config, keeping existing`);
      continue;
    }

    const override = omoOverrides[agent.name];
    const config: Record<string, unknown> = { prompt: agent.prompt };
    if (override) {
      for (const [key, value] of Object.entries(override)) {
        if (key !== "prompt_append") {
          config[key] = value;
        }
      }
      if (override["prompt_append"]) {
        config["prompt"] = agent.prompt + "\n\n" + override["prompt_append"];
      }
      logger.info(`Merged omo override for custom agent: ${agent.name}`, {
        overrideKeys: Object.keys(override),
      });
    }

    existingAgents[agent.name] = config;
  }

  logger.info(`Injected ${agents.length} custom agent(s) into opencode config`, {
    agents: agents.map((a) => a.name).join(", "),
  });

  return { ...opencodeConfig, agent: existingAgents };
}