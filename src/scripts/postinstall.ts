/**
 * openplaw postinstall script — ensures ~/.openplaw/ directory structure,
 * patches omo's dist/index.js to add route_to_bot agent restrictions
 * and allow custom agent names, then scans ~/.openplaw/agents/ and updates omo config.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { loadAgentDefinitions } from "../core/discovery/agent-loader.js";
import { applySchemaPatch, findOmoDistPath } from "../core/patching/schema-patcher.js";
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_HEALTH_PORT,
  DEFAULT_OPENCODE_PORT,
  DEFAULT_HUB_PORT,
  DEFAULT_WEB_PORT,
} from "../config/config.js";

async function ensureOpenmoDir(): Promise<void> {
  const openplawDir = resolveOpenmoDir();
  const configDir = resolveConfigDir();

  if (!existsSync(openplawDir)) {
    await mkdir(openplawDir, { recursive: true });
  }

  // Data dir: ~/.openplaw/ — built-in defaults + runtime
  const dataAgentsDir = path.join(openplawDir, "agents");
  if (!existsSync(dataAgentsDir)) {
    await mkdir(dataAgentsDir, { recursive: true });
  }

  const dataMcpDir = path.join(openplawDir, "mcp");
  if (!existsSync(dataMcpDir)) {
    await mkdir(dataMcpDir, { recursive: true });
    await writeFile(path.join(dataMcpDir, ".gitkeep"), "", "utf-8");
  }

  const dataSkillsDir = path.join(openplawDir, "skills");
  if (!existsSync(dataSkillsDir)) {
    await mkdir(dataSkillsDir, { recursive: true });
    await writeFile(path.join(dataSkillsDir, ".gitkeep"), "", "utf-8");
  }

  const bindingsDir = path.join(openplawDir, "bindings");
  if (!existsSync(bindingsDir)) {
    await mkdir(bindingsDir, { recursive: true });
    await writeFile(path.join(bindingsDir, ".gitkeep"), "", "utf-8");
  }

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const configAgentsDir = path.join(configDir, "agents");
  if (!existsSync(configAgentsDir)) {
    await mkdir(configAgentsDir, { recursive: true });
  }

  const configMcpDir = path.join(configDir, "mcp");
  if (!existsSync(configMcpDir)) {
    await mkdir(configMcpDir, { recursive: true });
    await writeFile(path.join(configMcpDir, ".gitkeep"), "", "utf-8");
  }

  const configSkillsDir = path.join(configDir, "skills");
  if (!existsSync(configSkillsDir)) {
    await mkdir(configSkillsDir, { recursive: true });
  }

  const configCredentialsDir = path.join(configDir, "credentials");
  if (!existsSync(configCredentialsDir)) {
    await mkdir(configCredentialsDir, { recursive: true });
    await writeFile(path.join(configCredentialsDir, ".gitkeep"), "", "utf-8");
  }

  const DEFAULT_OPENPLAW_CONFIG = JSON.stringify(
    {
      bots: [],
      groups: [],
      agents: { directory: "~/.openplaw/agents" },
      mcp: { autoRegister: true },
      ports: {
        gateway: DEFAULT_GATEWAY_PORT,
        gatewayHost: DEFAULT_GATEWAY_HOST,
        health: DEFAULT_HEALTH_PORT,
        opencode: DEFAULT_OPENCODE_PORT,
        hub: DEFAULT_HUB_PORT,
        web: DEFAULT_WEB_PORT,
      },
    },
    null,
    2,
  ) + "\n";

  for (const fileName of ["openplaw.json", "opencode.json", "omo.json"]) {
    const filePath = path.join(configDir, fileName);
    if (!existsSync(filePath)) {
      const content = fileName === "openplaw.json" ? DEFAULT_OPENPLAW_CONFIG : "{}\n";
      await writeFile(filePath, content, "utf-8");
    }
  }
}

async function main(): Promise<void> {
  try {
    await ensureOpenmoDir();
  } catch (err) {
    console.error("[openplaw] Failed to ensure openplaw directory:", err);
  }

  const omoDistPath = findOmoDistPath();
  if (omoDistPath) {
    try {
      await applySchemaPatch(omoDistPath);
    } catch (err) {
      console.error("[openplaw] Schema patch failed:", err);
    }
  } else {
    console.warn("[openplaw] Could not find omo dist/index.js — skipping schema patch");
  }

  try {
    const agentNames = await loadAgentDefinitions();
    if (agentNames.length > 0) {
      console.log(`[openplaw] Discovered agents: ${agentNames.join(", ")}`);
    }
  } catch (err) {
    console.error("[openplaw] Agent loader failed:", err);
  }
}

main().catch((err) => {
  console.error("[openplaw] Postinstall script failed:", err);
  process.exit(0); // Don't block npm install
});
