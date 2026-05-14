import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GatewayServiceInstallArgs,
  GatewayServiceState,
  GatewayServiceStartResult,
  GatewayServiceRestartResult,
} from "./service-types.js";
import type { GatewayService } from "./service.js";

const LABEL = "com.openplaw.gateway";
const PLIST_FILENAME = `${LABEL}.plist`;
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, PLIST_FILENAME);
const LOG_DIR = join(homedir(), ".openplaw", "logs");

function generatePlist(args: GatewayServiceInstallArgs): string {
  const envEntries = Object.entries(args.env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join("\n");

  const programArgs = args.programArguments
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(LOG_DIR, "gateway.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(LOG_DIR, "gateway-error.log"))}</string>${envEntries.length > 0 ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>` : ""}${args.workingDirectory ? `\n  <key>WorkingDirectory</key>\n  <string>${escapeXml(args.workingDirectory)}</string>` : ""}
</dict>
</plist>
`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function ensurePlistDir(): void {
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }
}

function execLaunchctl(...args: string[]): string {
  try {
    return execSync(`launchctl ${args.join(" ")}`, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function createLaunchdService(): GatewayService {
  return {
    label: LABEL,

    async install(args: GatewayServiceInstallArgs): Promise<void> {
      ensureLogDir();
      ensurePlistDir();
      writeFileSync(PLIST_PATH, generatePlist(args), "utf-8");
      execLaunchctl("load", PLIST_PATH);
    },

    async uninstall(): Promise<void> {
      if (existsSync(PLIST_PATH)) {
        try {
          execLaunchctl("unload", PLIST_PATH);
        } catch {
          // Service may not be loaded, that's fine
        }
        unlinkSync(PLIST_PATH);
      }
    },

    async start(): Promise<GatewayServiceStartResult> {
      if (!existsSync(PLIST_PATH)) {
        const state = await this.readState();
        return { outcome: "missing-install", state };
      }
      execLaunchctl("load", PLIST_PATH);
      const state = await this.readState();
      return { outcome: "started", state };
    },

    async stop(): Promise<void> {
      if (existsSync(PLIST_PATH)) {
        execLaunchctl("unload", PLIST_PATH);
      }
    },

    async restart(): Promise<GatewayServiceRestartResult> {
      if (existsSync(PLIST_PATH)) {
        try {
          execLaunchctl("unload", PLIST_PATH);
        } catch {
          // May not be loaded
        }
        execLaunchctl("load", PLIST_PATH);
      }
      return { outcome: "completed" };
    },

    async isLoaded(): Promise<boolean> {
      try {
        const output = execSync(`launchctl list | grep ${LABEL}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return output.includes(LABEL);
      } catch {
        return false;
      }
    },

    async readState(): Promise<GatewayServiceState> {
      const installed = existsSync(PLIST_PATH);
      let loaded = false;
      let running = false;
      let pid: number | undefined;

      if (installed) {
        try {
          const output = execSync(`launchctl list ${LABEL}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          loaded = true;

          const pidMatch = output.match(/PID\s*=\s*(\d+)/);
          if (pidMatch?.[1]) {
            pid = parseInt(pidMatch[1], 10);
            running = Number.isFinite(pid);
          }

          const exitMatch = output.match(/LastExitStatus\s*=\s*(\d+)/);
          if (exitMatch?.[1] && exitMatch[1] !== "0" && !pid) {
            running = false;
          }
        } catch {
          loaded = false;
        }
      }

      let env: Record<string, string | undefined> = {};
      if (installed) {
        try {
          const plistContent = readFileSync(PLIST_PATH, "utf-8");
          env = parsePlistEnv(plistContent);
        } catch {
          // Ignore parse errors
        }
      }

      return { installed, loaded, running, pid, env };
    },
  };
}

function parsePlistEnv(plistContent: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const envMatch = plistContent.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!envMatch?.[1]) {
    return env;
  }
  const dictContent = envMatch[1];
  const keyRegex = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(dictContent)) !== null) {
    const key = match[1];
    if (key) {
      env[key] = match[2] ?? undefined;
    }
  }
  return env;
}
