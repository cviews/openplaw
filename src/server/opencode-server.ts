import {
  type OpencodeClient,
  type Config,
} from "@opencode-ai/sdk";
import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2";
import * as child_process from "node:child_process";
import * as path from "node:path";
import { logger } from "../infra/logger.js";

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
const DEFAULT_HOSTNAME = "localhost";

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

    // The child process calls createOpencodeServer internally
    // Resolve from package root so it works both from dist/ (production) and src/ (tsx dev)
    const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    const serverStartScript = path.resolve(packageRoot, "dist/server/server-start.js");

    const configContent = JSON.stringify(this.config.config);

    this.childProcess = child_process.spawn("node", [serverStartScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: configContent,
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
    });

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
        // Any response (even 404) means the HTTP server is up and accepting connections
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
}
