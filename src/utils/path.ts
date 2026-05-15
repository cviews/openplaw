import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

/**
 * Resolve the directory containing the `opencode` binary from @openplaw/opencode.
 * Returns null if the package is not installed.
 */
export function resolveOpencodeBinDir(): string | null {
  try {
    const pkgJsonPath = require.resolve("@openplaw/opencode/package.json");
    return path.join(path.dirname(pkgJsonPath), "bin");
  } catch {
    return null;
  }
}

/**
 * Ensure the `opencode` binary from @openplaw/opencode is on PATH,
 * so that @opencode-ai/sdk's cross-spawn('opencode', ...) can find it.
 * Idempotent — safe to call multiple times.
 */
export function ensureOpencodeInPath(): void {
  const binDir = resolveOpencodeBinDir();
  if (!binDir) {
    return;
  }
  const pathSep = process.platform === "win32" ? ";" : ":";
  const existingPath = process.env.PATH ?? "";
  if (!existingPath.split(pathSep).includes(binDir)) {
    process.env.PATH = `${binDir}${pathSep}${existingPath}`;
  }
}
