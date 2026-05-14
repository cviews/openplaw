import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { resolveOpenmoDir } from "./loader.js";
import { logger } from "../infra/logger.js";

export type SummaryConfig = {
  pruneAfterDays: number;
  maxEntries: number;
  maxDiskMB: number;
};

const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  pruneAfterDays: 30,
  maxEntries: 100,
  maxDiskMB: 50,
};

const SESSIONS_DIR_NAME = "sessions";
const MAX_RECENT_FILES = 5;

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

async function resolveSessionsDir(): Promise<string> {
  const dir = path.join(resolveOpenmoDir(), SESSIONS_DIR_NAME);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

async function resolveAvailableFilename(
  sessionsDir: string,
  dateStr: string,
  slug: string,
): Promise<string> {
  const baseName = `${dateStr}-${slug}`;
  const basePath = path.join(sessionsDir, `${baseName}.md`);
  if (!existsSync(basePath)) {
    return basePath;
  }
  let suffix = 2;
  while (true) {
    const candidate = path.join(sessionsDir, `${baseName}-${suffix}.md`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    suffix++;
  }
}

function formatSessionTimestamp(): { dateStr: string; slug: string; headerTime: string } {
  const now = new Date();
  const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(now);
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  const [hour, minute] = timeParts.split(":");
  const slug = `${hour}${minute}`;

  const headerTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);

  return { dateStr, slug, headerTime: `${dateStr} ${timeParts} ${headerTime.split(" ").pop() ?? tz}` };
}

export async function saveSessionSummary(params: {
  sessionKey: string;
  sessionId: string;
  source: string;
  content: string;
}): Promise<string> {
  const sessionsDir = await resolveSessionsDir();
  const { dateStr, slug, headerTime } = formatSessionTimestamp();

  const targetPath = await resolveAvailableFilename(sessionsDir, dateStr, slug);

  const markdown = [
    `# Session: ${headerTime}`,
    "",
    `- **Session Key**: ${params.sessionKey}`,
    `- **Session ID**: ${params.sessionId}`,
    `- **Source**: ${params.source}`,
    "",
    "## Conversation Summary",
    "",
    params.content,
    "",
  ].join("\n");

  await atomicWrite(targetPath, markdown);
  logger.debug("Saved session summary", { path: targetPath });

  return targetPath;
}

export async function loadRecentSummaries(
  _config?: SummaryConfig,
  keyword?: string,
): Promise<string> {
  const sessionsDir = path.join(resolveOpenmoDir(), SESSIONS_DIR_NAME);
  if (!existsSync(sessionsDir)) {
    return "";
  }

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return "";
  }

  const mdFiles = entries
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse();

  const candidates = mdFiles.slice(0, MAX_RECENT_FILES);

  const parts: string[] = [];
  for (const fileName of candidates) {
    const filePath = path.join(sessionsDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    if (keyword && !content.toLowerCase().includes(keyword.toLowerCase())) {
      continue;
    }

    const dateLabel = fileName.replace(/\.md$/, "");
    parts.push(`[Session Summary: ${dateLabel}]:\n${content}`);
  }

  return parts.join("\n\n");
}

export async function pruneSessionSummaries(
  config?: SummaryConfig,
): Promise<{ pruned: number; remaining: number }> {
  const effective = config ?? DEFAULT_SUMMARY_CONFIG;
  const sessionsDir = path.join(resolveOpenmoDir(), SESSIONS_DIR_NAME);

  if (!existsSync(sessionsDir)) {
    return { pruned: 0, remaining: 0 };
  }

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return { pruned: 0, remaining: 0 };
  }

  const mdFiles = entries.filter((name) => name.endsWith(".md"));

  type FileEntry = { name: string; path: string; mtime: number; size: number };
  const fileEntries: FileEntry[] = [];

  for (const name of mdFiles) {
    const filePath = path.join(sessionsDir, name);
    try {
      const s = await stat(filePath);
      fileEntries.push({ name, path: filePath, mtime: s.mtimeMs, size: s.size });
    } catch {
      // File may have been deleted between readdir and stat
    }
  }

  const toDelete = new Set<string>();
  const now = Date.now();
  const ageThreshold = effective.pruneAfterDays * 24 * 60 * 60 * 1000;

  // Step 1: Age-based pruning
  for (const entry of fileEntries) {
    if (now - entry.mtime > ageThreshold) {
      toDelete.add(entry.path);
    }
  }

  // Step 2: Count-based capping
  const afterAge = fileEntries.filter((e) => !toDelete.has(e.path));
  if (afterAge.length > effective.maxEntries) {
    const sorted = [...afterAge].sort((a, b) => a.mtime - b.mtime);
    const excess = sorted.length - effective.maxEntries;
    for (let i = 0; i < excess; i++) {
      toDelete.add(sorted[i]!.path);
    }
  }

  // Step 3: Disk-based cleanup
  if (effective.maxDiskMB > 0) {
    const afterCount = fileEntries.filter((e) => !toDelete.has(e.path));
    const totalBytes = afterCount.reduce((sum, e) => sum + e.size, 0);
    const maxBytes = effective.maxDiskMB * 1024 * 1024;
    if (totalBytes > maxBytes) {
      const targetBytes = maxBytes * 0.8;
      const sorted = [...afterCount].sort((a, b) => a.mtime - b.mtime);
      let currentBytes = totalBytes;
      for (const entry of sorted) {
        if (currentBytes <= targetBytes) break;
        toDelete.add(entry.path);
        currentBytes -= entry.size;
      }
    }
  }

  let pruned = 0;
  for (const filePath of toDelete) {
    try {
      await unlink(filePath);
      pruned++;
    } catch {
      // Best-effort deletion
    }
  }

  const remaining = fileEntries.length - pruned;

  if (pruned > 0) {
    logger.debug("Pruned session summaries", {
      pruned,
      remaining,
      pruneAfterDays: effective.pruneAfterDays,
      maxEntries: effective.maxEntries,
    });
  }

  return { pruned, remaining };
}
