import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { stripJsonc } from "./json.js";
import { resolveConfigDir } from "./path.js";

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export function parseModelString(model: string): ModelRef | null {
  if (!model || typeof model !== "string") return null;
  const idx = model.indexOf("/");
  if (idx === -1) return null;
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
}

export async function readLatestModelFromConfig(): Promise<ModelRef | null> {
  const configDir = resolveConfigDir();
  const configPath = path.join(configDir, "opencode.json");

  if (!existsSync(configPath)) return null;

  try {
    const raw = await readFile(configPath, "utf-8");
    const stripped = stripJsonc(raw);
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed === "object" && parsed !== null && "model" in parsed) {
      const model = (parsed as { model?: string }).model;
      return parseModelString(model ?? "");
    }
    return null;
  } catch {
    return null;
  }
}