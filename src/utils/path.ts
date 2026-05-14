import os from "node:os";
import path from "node:path";

export function homeDir(): string {
  return os.homedir();
}

export function resolveConfigDir(): string {
  const envDir = process.env["OPENCODE_CONFIG_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".config", "opencode");
}

export function toTildePath(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath.startsWith(home + path.sep)) {
    return "~" + absolutePath.slice(home.length);
  }
  if (absolutePath === home) return "~";
  return absolutePath;
}

export function expandTildePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
