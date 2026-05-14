import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GatewayServiceInstallArgs,
  GatewayServiceState,
  GatewayServiceStartResult,
  GatewayServiceRestartResult,
} from "./service-types.js";
import type { GatewayService } from "./service.js";

const TASK_NAME = "OpenmoGateway";
const STARTUP_FOLDER = join(
  homedir(),
  "AppData",
  "Roaming",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup"
);
const STARTUP_VBS_PATH = join(STARTUP_FOLDER, "OpenmoGateway.vbs");

function generateStartupVbs(args: GatewayServiceInstallArgs): string {
  const command = args.programArguments.join(" ");
  const envLines = Object.entries(args.env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `ws.Environment("Process").Item("${k}") = "${v}"`)
    .join("\n");

  return `Set ws = CreateObject("WScript.Shell")
${envLines}
ws.Run "${command}", 0, False
`;
}

function ensureStartupFolder(): void {
  if (!existsSync(STARTUP_FOLDER)) {
    mkdirSync(STARTUP_FOLDER, { recursive: true });
  }
}

function execCmd(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(
      `${cmd} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function createSchtasksService(): GatewayService {
  return {
    label: TASK_NAME,

    async install(args: GatewayServiceInstallArgs): Promise<void> {
      const command = args.programArguments.join(" ");
      try {
        execCmd(
          `schtasks /create /tn ${TASK_NAME} /tr "${command}" /sc ONSTART /ru "${process.env.USERNAME ?? "%USERNAME%"}" /f`
        );
      } catch {
        ensureStartupFolder();
        writeFileSync(STARTUP_VBS_PATH, generateStartupVbs(args), "utf-8");
      }
    },

    async uninstall(): Promise<void> {
      try {
        execCmd(`schtasks /delete /tn ${TASK_NAME} /f`);
      } catch {
        // Task may not exist
      }
      if (existsSync(STARTUP_VBS_PATH)) {
        unlinkSync(STARTUP_VBS_PATH);
      }
    },

    async start(): Promise<GatewayServiceStartResult> {
      if (!existsSync(STARTUP_VBS_PATH)) {
        try {
          execSync(`schtasks /query /tn ${TASK_NAME}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          const state = await this.readState();
          return { outcome: "missing-install", state };
        }
      }
      try {
        execCmd(`schtasks /run /tn ${TASK_NAME}`);
      } catch {
        // Task may already be running
      }
      const state = await this.readState();
      return { outcome: "started", state };
    },

    async stop(): Promise<void> {
      try {
        execSync(
          `taskkill /fi "WINDOWTITLE eq ${TASK_NAME}" /f`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
        // Process may not be running
      }
      try {
        execCmd(`schtasks /end /tn ${TASK_NAME}`);
      } catch {
        // Task may not be running
      }
    },

    async restart(): Promise<GatewayServiceRestartResult> {
      await this.stop();
      await this.start();
      return { outcome: "completed" };
    },

    async isLoaded(): Promise<boolean> {
      try {
        execSync(`schtasks /query /tn ${TASK_NAME}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
      } catch {
        return existsSync(STARTUP_VBS_PATH);
      }
    },

    async readState(): Promise<GatewayServiceState> {
      let installed = false;
      let loaded = false;
      let running = false;
      const env: Record<string, string | undefined> = {};

      try {
        const output = execSync(`schtasks /query /tn ${TASK_NAME} /fo list`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        installed = true;
        loaded = true;
        running = output.includes("Running");
      } catch {
        installed = existsSync(STARTUP_VBS_PATH);
        loaded = installed;
      }

      return { installed, loaded, running, env };
    },
  };
}
