import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveOpenmoDir, resolveConfigDir } from "../config/loader.js";
import { logger } from "../infra/logger.js";

export type InitCommandOptions = {
  force?: boolean;
};

const GLOBAL_DEFAULT_CONFIGS = [
  {
    name: "openplaw.json",
    content: JSON.stringify(
      {
        bots: [],
        groups: [],
        agents: { directory: ["~/.config/openplaw/agents"] },
        mcp: { autoRegister: true },
        ports: {
          gateway: 3000,
          gatewayHost: "0.0.0.0",
          health: 9090,
          opencode: 4096,
          hub: 4097,
          web: 4098,
        },
      },
      null,
      2,
    ) + "\n",
  },
  {
    name: "opencode.json",
    content: JSON.stringify({}, null, 2) + "\n",
  },
  {
    name: "oh-my-openagent.json",
    content: JSON.stringify({}, null, 2) + "\n",
  },
] as const;

const PROJECT_DIRS = ["skills", "commands", "mcp"] as const;

const PROJECT_SKILL_TEMPLATE = `---
name: example
description: An example skill
---

## What I do

This is an example skill. Replace this with your actual skill definition.

## When to use me

Use this when you need a demonstration of how skills work.
`;

const PROJECT_COMMAND_TEMPLATE = `---
description: Run tests
agent: build
---

Run the test suite and report any failures.
`;

const PROJECT_MCP_TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      example_mcp: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-example"],
        type: "stdio",
      },
    },
  },
  null,
  2,
) + "\n";

export async function initCommand(options?: InitCommandOptions): Promise<void> {
  const force = options?.force ?? false;
  const projectDir = process.cwd();
  const projectOpenplawDir = path.join(projectDir, ".openplaw");
  const globalDir = resolveOpenmoDir();
  const configDir = resolveConfigDir();

  logger.info("Initializing openplaw...", { projectDir, globalDir, configDir });

  if (!existsSync(globalDir)) {
    await mkdir(globalDir, { recursive: true });
  }

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const dataSubDirs = ["agents", "mcp", "skills"];
  for (const subDir of dataSubDirs) {
    const dirPath = path.join(globalDir, subDir);
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      if (subDir === "mcp" || subDir === "skills") {
        await writeFile(path.join(dirPath, ".gitkeep"), "", "utf-8");
      }
      logger.info(`Created data directory: ${subDir}`);
    }
  }

  const configSubDirs = ["agents", "credentials", "mcp", "skills"];
  for (const subDir of configSubDirs) {
    const dirPath = path.join(configDir, subDir);
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      if (subDir === "credentials" || subDir === "mcp") {
        await writeFile(path.join(dirPath, ".gitkeep"), "", "utf-8");
      }
      logger.info(`Created config directory: ${subDir}`);
    }
  }

  for (const { name, content } of GLOBAL_DEFAULT_CONFIGS) {
    const filePath = path.join(configDir, name);
    if (force || !existsSync(filePath)) {
      await writeFile(filePath, content, "utf-8");
      logger.info(`Created config: ${name}`);
    } else {
      logger.info(`Config ${name} already exists — skipping`);
    }
  }

  // --- Project init: .openplaw/ ---
  if (!existsSync(projectOpenplawDir)) {
    await mkdir(projectOpenplawDir, { recursive: true });
    logger.info("Created project .openplaw directory");
  }

  for (const dirName of PROJECT_DIRS) {
    const dirPath = path.join(projectOpenplawDir, dirName);
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      logger.info(`Created project directory: .openplaw/${dirName}`);
    }
  }

  // Create example skill
  const exampleSkillDir = path.join(projectOpenplawDir, "skills", "example");
  if (!existsSync(exampleSkillDir)) {
    await mkdir(exampleSkillDir, { recursive: true });
  }
  const skillFilePath = path.join(exampleSkillDir, "SKILL.md");
  if (force || !existsSync(skillFilePath)) {
    await writeFile(skillFilePath, PROJECT_SKILL_TEMPLATE, "utf-8");
    logger.info("Created example skill: .openplaw/skills/example/SKILL.md");
  }

  // Create example command
  const commandFilePath = path.join(projectOpenplawDir, "commands", "test.md");
  if (force || !existsSync(commandFilePath)) {
    await writeFile(commandFilePath, PROJECT_COMMAND_TEMPLATE, "utf-8");
    logger.info("Created example command: .openplaw/commands/test.md");
  }

  // Create example MCP config
  const mcpFilePath = path.join(projectOpenplawDir, "mcp", "default.json");
  if (force || !existsSync(mcpFilePath)) {
    await writeFile(mcpFilePath, PROJECT_MCP_TEMPLATE, "utf-8");
    logger.info("Created example MCP config: .openplaw/mcp/default.json");
  }

  // Create .gitignore for .openplaw if not exists
  const gitignorePath = path.join(projectOpenplawDir, ".gitignore");
  if (force || !existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "node_modules/\n", "utf-8");
    logger.info("Created .openplaw/.gitignore");
  }

  logger.info("openplaw initialized successfully");
  console.log(`Initialized openplaw at ${projectOpenplawDir} (project), ${configDir} (config), and ${globalDir} (data)`);
}