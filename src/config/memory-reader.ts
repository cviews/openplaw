import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import * as path from "node:path";

import { resolveOpenmoDir } from "./loader.js";
import { logger } from "../infra/logger.js";

const MEMORY_FILE = "MEMORY.md";

export type MemoryContent = {
  global: string;
  project: string;
  combined: string;
};

export async function readMemoryFiles(projectDir?: string): Promise<MemoryContent> {
  const openplawDir = resolveOpenmoDir();
  const globalMemoryPath = path.join(openplawDir, MEMORY_FILE);

  let globalContent = "";
  try {
    globalContent = (await readFile(globalMemoryPath, "utf-8")).trim();
  } catch {
    // No global memory file yet
  }

  let projectContent = "";
  if (projectDir) {
    const projectMemoryPath = path.join(projectDir, ".openplaw", MEMORY_FILE);
    try {
      projectContent = (await readFile(projectMemoryPath, "utf-8")).trim();
    } catch {
      // No project memory file yet
    }
  }

  const parts: string[] = [];
  if (globalContent) {
    parts.push(`[Global Memory]\n${globalContent}`);
    logger.debug("Loaded global MEMORY.md", { path: globalMemoryPath, length: globalContent.length });
  }
  if (projectContent) {
    parts.push(`[Project Memory]\n${projectContent}`);
    logger.debug("Loaded project MEMORY.md", { projectDir, length: projectContent.length });
  }

  return {
    global: globalContent,
    project: projectContent,
    combined: parts.join("\n\n"),
  };
}

export async function ensureProjectOpenplawDir(projectDir: string): Promise<string> {
  const dir = path.join(projectDir, ".openplaw");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpFile = `${targetPath}.tmp.${process.pid}`;
  try {
    await writeFile(tmpFile, content, "utf-8");
    await rename(tmpFile, targetPath);
  } catch (err: unknown) {
    try {
      await unlink(tmpFile);
    } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export async function promoteGlobalPreferences(projectDir: string): Promise<void> {
  const projectMemoryPath = path.join(projectDir, ".openplaw", MEMORY_FILE);

  let projectContent: string;
  try {
    projectContent = (await readFile(projectMemoryPath, "utf-8")).trim();
  } catch {
    return;
  }

  const globalSectionRegex = /^## \[Global Preferences\]\s*\n([\s\S]*?)(?=\n## (?!\[Global Preferences\])|$)/;
  const match = globalSectionRegex.exec(projectContent);
  if (!match) {
    return;
  }

  const globalContent = match[1] ?? "";
  const trimmedGlobal = globalContent.trim();
  if (!trimmedGlobal) {
    return;
  }

  const openplawDir = resolveOpenmoDir();
  const globalMemoryPath = path.join(openplawDir, MEMORY_FILE);

  let existingGlobal = "";
  try {
    existingGlobal = (await readFile(globalMemoryPath, "utf-8")).trim();
  } catch {
    // No global memory file yet
  }

  const newGlobalContent = existingGlobal
    ? `${existingGlobal}\n\n${trimmedGlobal}`
    : trimmedGlobal;

  await atomicWrite(globalMemoryPath, `${newGlobalContent}\n`);
  logger.debug("Promoted global preferences to global MEMORY.md", { path: globalMemoryPath });

  const remainingContent = projectContent
    .replace(globalSectionRegex, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (remainingContent) {
    await atomicWrite(projectMemoryPath, `${remainingContent}\n`);
    logger.debug("Removed [Global Preferences] section from project MEMORY.md", { path: projectMemoryPath });
  } else {
    await atomicWrite(projectMemoryPath, "");
    logger.debug("Project MEMORY.md is empty after removing [Global Preferences]", { path: projectMemoryPath });
  }
}

const MEMORY_WRITE_PROMPT_TEMPLATE =
  `When you detect stable user preferences, decisions, or important information, write them to the project's .openplaw/MEMORY.md file.
Use section markers to distinguish scope:
- ## [Global Preferences]: preferences that apply across ALL projects (language, style, habits). These will be promoted to the global memory file automatically.
- ## [Project Preferences]: preferences specific to THIS project only (framework, architecture, config paths). These stay in the project file.

当你检测到用户的稳定偏好、决策或重要信息时，请将其写入项目的 .openplaw/MEMORY.md 文件。
使用分区标记区分范围：
- ## [Global Preferences]: 跨所有项目通用的偏好（语言、风格、习惯）。这些会自动提升到全局记忆文件。
- ## [Project Preferences]: 仅与本项目相关的偏好（框架、架构、配置路径）。这些留在项目文件中。`;

export function buildMemoryInstructions(memory: MemoryContent, projectDir?: string): string[] {
  const instructions: string[] = [];

  if (memory.combined) {
    instructions.push(`[Cross-Session Memory / 跨会话记忆 - MEMORY.md]:\n${memory.combined}`);
  }

  const prompt = projectDir
    ? MEMORY_WRITE_PROMPT_TEMPLATE.replace(
        "项目的 .openplaw/MEMORY.md",
        `${path.resolve(projectDir)}/.openplaw/MEMORY.md`,
      ).replace(
        "the project's .openplaw/MEMORY.md file",
        `${path.resolve(projectDir)}/.openplaw/MEMORY.md`,
      )
    : MEMORY_WRITE_PROMPT_TEMPLATE;

  instructions.push(prompt);

  return instructions;
}
