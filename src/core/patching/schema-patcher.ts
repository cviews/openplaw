import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export function findOmoDistPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const omoPkgJsonPath = require.resolve("oh-my-opencode/package.json");
    const distPath = path.join(path.dirname(omoPkgJsonPath), "dist", "index.js");
    if (existsSync(distPath)) return distPath;
  } catch {
    // omo not installed or not resolvable
  }
  return null;
}

function patchAgentRestrictions(content: string): string {
  const marker = "AGENT_RESTRICTIONS = {";
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error("[openplaw schema-patcher] Could not find AGENT_RESTRICTIONS in omo dist");
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = markerIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error("[openplaw schema-patcher] Could not find end of AGENT_RESTRICTIONS in omo dist");
  }

  const before = content.slice(0, markerIdx);
  let block = content.slice(markerIdx, endIdx + 1);
  const after = content.slice(endIdx + 1);

  if (block.includes("route_to_bot")) {
    return content;
  }

  for (const agent of ["explore", "librarian"]) {
    const regex = new RegExp(`(${agent}:\\s*)EXPLORATION_AGENT_DENYLIST([,\\s])`, "g");
    block = block.replace(regex, "$1{ ...EXPLORATION_AGENT_DENYLIST, route_to_bot: false }$2");
  }

  const objAgents = ["oracle", "metis", "momus", '"multimodal-looker"', '"sisyphus-junior"'];
  for (const agent of objAgents) {
    const regex = new RegExp(`(${agent}:\\s*\\{)([^}]*)(\\})`, "g");
    block = block.replace(regex, (_match, open: string, inner: string, close: string) => {
      if (inner.includes("route_to_bot")) {
        return `${open}${inner}${close}`;
      }
      const trimmed = inner.trimEnd();
      const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
      return `${open}${trimmed}${needsComma ? "," : ""} route_to_bot: false${close}`;
    });
  }

  return before + block + after;
}

function patchBuiltinAgentNameSchema(content: string): string {
  const marker = "var BuiltinAgentNameSchema = ";
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error("[openplaw schema-patcher] Could not find BuiltinAgentNameSchema in omo dist");
  }

  const enumStart = content.indexOf("enum([", markerIdx);
  if (enumStart === -1) {
    throw new Error("[openplaw schema-patcher] Could not find z.enum in BuiltinAgentNameSchema");
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = enumStart; i < content.length; i++) {
    if (content[i] === "(" || content[i] === "[" || content[i] === "{") depth++;
    else if (content[i] === ")" || content[i] === "]" || content[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error("[openplaw schema-patcher] Could not find end of BuiltinAgentNameSchema enum");
  }

  const currentDef = content.slice(markerIdx + marker.length, endIdx + 1);
  if (!currentDef.includes("enum(")) {
    return content;
  }

  const zVar = content.slice(markerIdx + marker.length, enumStart);
  const replacement = `${zVar}string()`;

  const before = content.slice(0, markerIdx + marker.length);
  const after = content.slice(endIdx + 1);

  return before + replacement + after;
}

async function createBackup(filePath: string): Promise<string> {
  const backupPath = filePath + ".openplaw-bak";
  await copyFile(filePath, backupPath);
  return backupPath;
}

function verifyPatch(content: string): void {
  if (!content.includes("route_to_bot: false")) {
    throw new Error("[openplaw schema-patcher] Verification failed — missing route_to_bot marker");
  }
  if (!content.includes("BuiltinAgentNameSchema = ") || !content.match(/BuiltinAgentNameSchema\s*=\s*\w+\.string\(\)/)) {
    throw new Error("[openplaw schema-patcher] Verification failed — BuiltinAgentNameSchema was not patched to z.string()");
  }
}

export async function applySchemaPatch(omoDistPath: string): Promise<void> {
  let content = await readFile(omoDistPath, "utf-8");

  if (content.includes("route_to_bot: false") && content.match(/BuiltinAgentNameSchema\s*=\s*\w+\.string\(\)/)) {
    console.log("[openplaw] Schema patch already applied — skipping");
    return;
  }

  const backupPath = await createBackup(omoDistPath);
  console.log(`[openplaw] Backup created: ${backupPath}`);

  try {
    content = patchAgentRestrictions(content);
    content = patchBuiltinAgentNameSchema(content);

    verifyPatch(content);

    await writeFile(omoDistPath, content, "utf-8");
    console.log(`[openplaw] Patched: ${omoDistPath}`);
  } catch (err) {
    console.error("[openplaw] Patch failed, restoring from backup:", err);
    try {
      await copyFile(backupPath, omoDistPath);
    } catch {
      // Best-effort restore
    }
    throw err;
  }
}
