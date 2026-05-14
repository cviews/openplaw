import { createServer, type Server } from "node:http";
import { logger } from "../logger.js";

export type HealthProviders = {
  getGatewayStatus?: () => Promise<{ running: boolean; port: number | null }>;
  getChannelCount?: () => number;
  getBindingsCount?: () => number;
};

export type HealthCheckOptions = {
  port?: number;
  host?: string;
  providers?: HealthProviders;
};

export type HealthCheckResult = {
  status: string;
  uptime: number;
  gateway: { running: boolean; port: number | null } | null;
  channels: number;
  bindings: number;
  timestamp: string;
};

export class HealthCheckServer {
  private server: Server | null = null;
  private port: number;
  private host: string;
  private providers: HealthProviders;
  private startedAt: number;

  constructor(options: HealthCheckOptions) {
    this.port = options.port ?? 9090;
    this.host = options.host ?? "127.0.0.1";
    this.providers = options.providers ?? {};
    this.startedAt = Date.now();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.startedAt = Date.now();
    this.server = createServer(async (_req, res) => {
      const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
      let gatewayStatus: { running: boolean; port: number | null } | null = null;
      
      if (this.providers.getGatewayStatus) {
        gatewayStatus = await this.providers.getGatewayStatus();
      }

      const channels = this.providers.getChannelCount?.() ?? 0;
      const bindings = this.providers.getBindingsCount?.() ?? 0;

      const result: HealthCheckResult = {
        status: "ok",
        uptime,
        gateway: gatewayStatus,
        channels,
        bindings,
        timestamp: new Date().toISOString(),
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });

    return new Promise((resolve, reject) => {
      const server = this.server!;
      server.on("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        logger.info(`Health check server listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }
}
