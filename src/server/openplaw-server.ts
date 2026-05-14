import type {
  BootstrapConfig,
  BootstrapResult,
} from "../bootstrap/bootstrap.js";

export type OpenplawServerConfig = BootstrapConfig & {
  mcpHubHostname?: string;
};

export type OpenplawServerResult = {
  bootstrap: BootstrapResult;
  stop: () => Promise<void>;
};

export class OpenplawServerManager {
  private config: OpenplawServerConfig;
  private bootstrap: BootstrapResult | null = null;
  private running = false;

  constructor(config: OpenplawServerConfig) {
    this.config = config;
  }

  async start(
    createBootstrap: (config: BootstrapConfig) => Promise<BootstrapResult>,
  ): Promise<OpenplawServerResult> {
    this.bootstrap = await createBootstrap(this.config);
    await this.bootstrap.start();
    this.running = true;
    return {
      bootstrap: this.bootstrap,
      stop: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    if (this.bootstrap) {
      await this.bootstrap.stop();
    }
    this.running = false;
    this.bootstrap = null;
  }

  isRunning(): boolean {
    return this.running;
  }
}
