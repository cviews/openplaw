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

const UNIT_NAME = "openplaw-gateway.service";
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME);

function generateUnit(args: GatewayServiceInstallArgs): string {
  const envLines = Object.entries(args.env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");

  const execStart = args.programArguments.join(" ");

  return `[Unit]
Description=${args.description ?? "Openmo Gateway Daemon"}
After=network.target

[Service]
Type=exec
ExecStart=${execStart}
Restart=always
RestartSec=5${envLines.length > 0 ? `\n${envLines}` : ""}${args.workingDirectory ? `\nWorkingDirectory=${args.workingDirectory}` : ""}

[Install]
WantedBy=default.target
`;
}

function ensureUnitDir(): void {
  if (!existsSync(UNIT_DIR)) {
    mkdirSync(UNIT_DIR, { recursive: true });
  }
}

function execSystemctl(...args: string[]): string {
  try {
    return execSync(`systemctl --user ${args.join(" ")}`, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function enableLinger(): void {
  try {
    execSync("loginctl enable-linger", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    // Linger may already be enabled or not available; non-fatal
  }
}

export function createSystemdService(): GatewayService {
  return {
    label: UNIT_NAME,

    async install(args: GatewayServiceInstallArgs): Promise<void> {
      ensureUnitDir();
      writeFileSync(UNIT_PATH, generateUnit(args), "utf-8");
      execSystemctl("daemon-reload");
      execSystemctl("enable", UNIT_NAME);
      enableLinger();
    },

    async uninstall(): Promise<void> {
      if (existsSync(UNIT_PATH)) {
        try {
          execSystemctl("stop", UNIT_NAME);
        } catch {
          // May not be running
        }
        try {
          execSystemctl("disable", UNIT_NAME);
        } catch {
          // May not be enabled
        }
        unlinkSync(UNIT_PATH);
        execSystemctl("daemon-reload");
      }
    },

    async start(): Promise<GatewayServiceStartResult> {
      if (!existsSync(UNIT_PATH)) {
        const state = await this.readState();
        return { outcome: "missing-install", state };
      }
      execSystemctl("start", UNIT_NAME);
      const state = await this.readState();
      return { outcome: "started", state };
    },

    async stop(): Promise<void> {
      execSystemctl("stop", UNIT_NAME);
    },

    async restart(): Promise<GatewayServiceRestartResult> {
      execSystemctl("restart", UNIT_NAME);
      return { outcome: "completed" };
    },

    async isLoaded(): Promise<boolean> {
      try {
        const output = execSync(`systemctl --user is-enabled ${UNIT_NAME}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return output.trim() === "enabled";
      } catch {
        return false;
      }
    },

    async readState(): Promise<GatewayServiceState> {
      const installed = existsSync(UNIT_PATH);
      let loaded = false;
      let running = false;
      let pid: number | undefined;
      let env: Record<string, string | undefined> = {};

      if (installed) {
        try {
          const unitContent = readFileSync(UNIT_PATH, "utf-8");
          env = parseUnitEnv(unitContent);
        } catch {
          // Ignore read errors
        }

        try {
          const isEnabledOutput = execSync(`systemctl --user is-enabled ${UNIT_NAME}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          loaded = isEnabledOutput.trim() === "enabled";
        } catch {
          loaded = false;
        }

        try {
          const statusOutput = execSync(`systemctl --user status ${UNIT_NAME}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const pidMatch = statusOutput.match(/Main PID:\s*(\d+)/);
          if (pidMatch?.[1]) {
            pid = parseInt(pidMatch[1], 10);
            running = Number.isFinite(pid);
          }
          if (statusOutput.includes("active (running)")) {
            running = true;
          }
        } catch {
          running = false;
        }
      }

      return { installed, loaded, running, pid, env };
    },
  };
}

function parseUnitEnv(unitContent: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const regex = /Environment="([^=]+)=(.*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(unitContent)) !== null) {
    const key = match[1];
    if (key) {
      env[key] = match[2] ?? undefined;
    }
  }
  return env;
}
