import {
  type OpencodeClient,
  type Config,
} from "@opencode-ai/sdk";
import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfigDir } from "../config/loader.js";
import { ensureOpencodeInPath } from "../utils/path.js";
import { logger } from "../infra/logger.js";

const PID_FILENAME = "opencode-server.pid";

function pidFilePath(): string {
  return path.join(resolveConfigDir(), PID_FILENAME);
}

function writePidFile(pid: number): void {
  try {
    const dir = resolveConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(pidFilePath(), String(pid), "utf-8");
  } catch (err) {
    logger.debug(`Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readPidFile(): number | null {
  try {
    const content = fs.readFileSync(pidFilePath(), "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function deletePidFile(): void {
  try {
    fs.unlinkSync(pidFilePath());
  } catch {
    // File may not exist, ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find PID of the process listening on a given port (macOS / Linux).
 * Returns null if no process found or command unavailable.
 */
function findProcessOnPort(port: number): number | null {
  try {
    const output = child_process.execSync(`lsof -i :${port} -t -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = output.trim().split("\n").filter(Boolean);
    const pid = parseInt(lines[0]!, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export type OpencodeServerConfig = {
  /** Port for opencode server HTTP API */
  port?: number;
  /** Hostname */
  hostname?: string;
  /** Full opencode config (serialized as OPENCODE_CONFIG_CONTENT env var) */
  config: Config;
  /** Abort signal for graceful shutdown */
  signal?: AbortSignal;
};

export type OpencodeServerResult = {
  url: string;
  port: number;
  client: OpencodeClient;
  stop: () => Promise<void>;
};

const DEFAULT_OPENCODE_PORT = 4096;
const DEFAULT_HOSTNAME = "127.0.0.1";

export class OpencodeServerManager {
  private childProcess: child_process.ChildProcess | null = null;
  private client: OpencodeClient | null = null;
  private config: OpencodeServerConfig;
  private url: string = "";
  private running = false;

  constructor(config: OpencodeServerConfig) {
    this.config = config;
  }

  async start(): Promise<OpencodeServerResult> {
    const port = this.config.port ?? DEFAULT_OPENCODE_PORT;
    const hostname = this.config.hostname ?? DEFAULT_HOSTNAME;
    this.url = `http://${hostname}:${port}`;

    await this.cleanupOrphanedServer(port, hostname);

    ensureOpencodeInPath();

    const configDir = resolveConfigDir();

    const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    const serverStartScript = path.resolve(packageRoot, "dist/server/server-start.js");

    const configContent = JSON.stringify(this.config.config);

    this.childProcess = child_process.spawn("node", [serverStartScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: configContent,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_SERVER_PORT: String(port),
        OPENCODE_SERVER_HOSTNAME: hostname,
      },
      detached: false,
    });

    this.childProcess.stdout?.on("data", (data: Buffer) => {
      logger.debug(`[opencode-server] ${data.toString().trim()}`);
    });
    this.childProcess.stderr?.on("data", (data: Buffer) => {
      logger.debug(`[opencode-server stderr] ${data.toString().trim()}`);
    });

    this.childProcess.on("exit", (code) => {
      logger.info(`opencode server process exited with code ${code}`);
      this.running = false;
      this.childProcess = null;
      deletePidFile();
    });

    const pid = this.childProcess.pid;
    if (pid) {
      writePidFile(pid);
    }

    await this.waitForReady(port, hostname);

    this.client = createV2OpencodeClient({
      baseUrl: this.url,
    }) as unknown as OpencodeClient;

    this.running = true;
    logger.info(`opencode server started at ${this.url}`);

    return {
      url: this.url,
      port,
      client: this.client,
      stop: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill("SIGKILL");
          }
          resolve();
        }, 10_000);
        this.childProcess?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    deletePidFile();
    this.running = false;
    this.childProcess = null;
    this.client = null;
  }

  getClient(): OpencodeClient | null {
    return this.client;
  }

  isRunning(): boolean {
    return this.running && this.childProcess !== null;
  }

  getUrl(): string {
    return this.url;
  }

  private async waitForReady(
    port: number,
    hostname: string,
    maxRetries = 30,
    intervalMs = 1_000,
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`http://${hostname}:${port}/`);
        if (response.ok || response.status === 404) {
          logger.info("opencode server is ready");
          return;
        }
      } catch {
        // not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `opencode server did not become ready within ${maxRetries * intervalMs}ms`,
    );
  }

  private async cleanupOrphanedServer(port: number, hostname: string): Promise<void> {
    const savedPid = readPidFile();
    const hadPidFile = savedPid !== null;

    if (savedPid !== null && isProcessRunning(savedPid)) {
      logger.info(`Found orphaned opencode server (PID ${savedPid}), terminating it`);
      try {
        process.kill(savedPid, "SIGTERM");
      } catch {
        // already dead
      }
      await this.waitForProcessExit(savedPid, 5000);
    }

    deletePidFile();

    if (!hadPidFile) {
      return;
    }

    try {
      const response = await fetch(`http://${hostname}:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      // Port still occupied after PID-based cleanup — PID may have been recycled
      const portPid = findProcessOnPort(port);
      if (portPid !== null && portPid !== process.pid) {
        logger.warn(`Port ${port} still occupied by PID ${portPid}, force-killing`);
        try {
          process.kill(portPid, "SIGKILL");
        } catch {
          // already dead
        }
        await this.waitForProcessExit(portPid, 3000);
      }
    } catch (fetchErr) {
      // fetch failed → port is free, good
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isProcessRunning(pid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}
