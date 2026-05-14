import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveOpenmoDir, resolveConfigDir } from "../../config/loader.js";
import { toTildePath } from "../../utils/path.js";

export async function scanAgentFiles(): Promise<string[]> {
  const dataDir = resolveOpenmoDir();
  const configDir = resolveConfigDir();
  const dataAgentsDir = path.join(dataDir, "agents");
  const configAgentsDir = path.join(configDir, "agents");

  const byName = new Map<string, string>();

  const scanDir = async (agentsDir: string): Promise<void> => {
    if (!existsSync(agentsDir)) return;

    let entries: string[];
    try {
      entries = await readdir(agentsDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }

    const files = entries
      .filter((name) => name.endsWith(".md") || name.endsWith(".json"))
      .sort();

    for (const name of files) {
      byName.set(name, path.join(agentsDir, name));
    }
  };

  await scanDir(dataAgentsDir);
  await scanDir(configAgentsDir);

  if (byName.size === 0 && !existsSync(dataAgentsDir)) {
    await mkdir(dataAgentsDir, { recursive: true });
  }

  return Array.from(byName.values());
}

export async function updateOmoConfig(discoveredPaths: string[]): Promise<void> {
  const configDir = resolveConfigDir();
  const configPath = path.join(configDir, "omo.json");

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8");
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        throw new Error(`Corrupt JSON in config file ${configPath}: ${err.message}`);
      }
      if ((err as NodeJS.ErrnoException | null)?.code === "EACCES") {
        throw new Error(`Permission denied reading config file: ${configPath}`);
      }
      throw err;
    }
  }

  const existing: string[] = Array.isArray(config["agent_definitions"])
    ? (config["agent_definitions"] as string[])
    : [];
  const seen = new Set(existing);

  const tildePaths = discoveredPaths.map(toTildePath);
  const merged = [...existing];
  for (const p of tildePaths) {
    if (!seen.has(p)) {
      merged.push(p);
      seen.add(p);
    }
  }

  config["agent_definitions"] = merged;

  const content = JSON.stringify(config, null, 2) + "\n";
  const tmpPath = configPath + ".tmp";

  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, configPath);
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

export async function loadAgentDefinitions(): Promise<string[]> {
  const agentFiles = await scanAgentFiles();

  if (agentFiles.length === 0) return [];

  const agentNames = agentFiles.map((filePath) => {
    const base = path.basename(filePath);
    const ext = path.extname(base);
    return base.slice(0, -ext.length) || base;
  });

  return agentNames;
}

export function buildOrchestratorAgentMd(params: {
  agentId: string;
  displayName: string;
  availableAgents: string[];
}): string {
  const agentList = params.availableAgents.map((name) => `- ${name}`).join("\n");

  return `# ${params.displayName}

## 工具
你有 route_to_bot 工具，可以在群内调用其他 agent 协作完成任务。

route_to_bot 参数：
- target: 目标 agent 名称（从下方可用列表选择）
- message: 传递给目标 agent 的任务描述
- visible: 是否在群内展示调用过程（默认 true）
- wait_for_result: 是否等待结果返回（默认 true）

## 当前可用的 agent
{available_bots}

## 编排策略
分析用户任务，判断是否需要委派给其他 agent：
${agentList}

自己能直接完成的简单任务 → 直接完成，不委派。
委派时提供清晰的任务描述，包含足够的上下文信息。
`;
}

export function injectAvailableBots(
  toolDescription: string,
  availableAgents: string[],
  botAgentMap: Record<string, string>,
): string {
  const botsList = availableAgents
    .map((agentName) => {
      const botName = botAgentMap[agentName] ?? agentName;
      return `- ${agentName}（${botName}）`;
    })
    .join("\n");

  return toolDescription.replace("{available_bots}", botsList);
}
