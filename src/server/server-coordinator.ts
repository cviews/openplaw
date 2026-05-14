import {
  OpencodeServerManager,
  type OpencodeServerConfig,
  type OpencodeServerResult,
} from "./opencode-server.js";
import {
  OpenplawServerManager,
  type OpenplawServerConfig,
  type OpenplawServerResult,
} from "./openplaw-server.js";
import {
  createOpenmoBootstrap,
  type BootstrapConfig,
} from "../bootstrap/bootstrap.js";
import { logger } from "../infra/logger.js";

export type ServerCoordinatorConfig = {
  opencode: OpencodeServerConfig;
  openplaw: OpenplawServerConfig;
};

export type ServerCoordinatorResult = {
  opencodeServer: OpencodeServerResult;
  openplawServer: OpenplawServerResult;
  stop: () => Promise<void>;
};

export class ServerCoordinator {
  private opencodeManager: OpencodeServerManager;
  private openplawManager: OpenplawServerManager;
  private config: ServerCoordinatorConfig;
  private running = false;

  constructor(config: ServerCoordinatorConfig) {
    this.config = config;
    this.opencodeManager = new OpencodeServerManager(config.opencode);
    this.openplawManager = new OpenplawServerManager(config.openplaw);
  }

  async start(): Promise<ServerCoordinatorResult> {
    logger.info("ServerCoordinator starting...");

    // opencode first — openplaw gateway needs its HTTP API for MCP trigger
    logger.info("Starting opencode server...");
    const opencodeServer = await this.opencodeManager.start();
    logger.info(`opencode server ready at ${opencodeServer.url}`);

    // openplaw second — gateway + MCP hub
    logger.info("Starting openplaw server...");
    const enrichedConfig: BootstrapConfig = {
      ...this.config.openplaw,
      opencodeClient: opencodeServer.client,
    };
    const openplawServer = await this.openplawManager.start(
      (_config: BootstrapConfig) => createOpenmoBootstrap(enrichedConfig),
    );
    logger.info("openplaw server ready");

    this.running = true;
    logger.info("ServerCoordinator started successfully");

    return {
      opencodeServer,
      openplawServer,
      stop: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    logger.info("ServerCoordinator stopping...");

    // openplaw first — stop accepting new requests
    try {
      await this.openplawManager.stop();
      logger.info("openplaw server stopped");
    } catch (err) {
      logger.error("Error stopping openplaw server", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // opencode second — let it finish current processing
    try {
      await this.opencodeManager.stop();
      logger.info("opencode server stopped");
    } catch (err) {
      logger.error("Error stopping opencode server", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.running = false;
    logger.info("ServerCoordinator stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getOpencodeClient(): OpencodeServerResult["client"] | null {
    return this.opencodeManager.getClient();
  }
}
