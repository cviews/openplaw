import * as http from "node:http";
import { logger } from "../infra/logger.js";

export type ChannelWebhookHandlers = {
  eventHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  cardHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};

/**
 * A single webhook route mounted on the ingress server.
 *
 * Channels register one route per HTTP endpoint they need
 * (e.g., Feishu registers separate routes for event and card callbacks).
 */
export type WebhookRoute = {
  /** Absolute path this route handles, e.g. "/webhook/feishu/event" */
  path: string;
  /** Async handler — same signature as http.RequestListener but must return a promise */
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};

/**
 * A channel's set of routes mounted under a common path prefix.
 *
 * The ingress server uses `pathPrefix` to quickly dispatch requests
 * to the correct channel's route table without scanning all routes.
 */
export type ChannelRouteMount = {
  /** Channel identifier, e.g. "feishu" or "dingtalk" */
  channelId: string;
  /** Path prefix for all routes in this mount, e.g. "/webhook/feishu" */
  pathPrefix: string;
  /** Ordered list of routes under this prefix */
  routes: WebhookRoute[];
};

/**
 * Configuration for creating a WebhookIngress instance.
 *
 * `port` is a gateway-level concern — there is one HTTP server
 * shared by all channels, unlike the per-channel servers used before.
 */
export type WebhookIngressConfig = {
  /** Port to listen on (0 = OS-assigned ephemeral port) */
  port: number;
  /** Bind host (defaults to "0.0.0.0") */
  host?: string;
  /** Channel route mounts to register at startup */
  mounts: ChannelRouteMount[];
};

/**
 * Runtime state returned after the ingress server starts.
 */
export type WebhookIngressRuntime = {
  /** The underlying http.Server (for advanced use) */
  server: http.Server;
  /** Actual port the server is listening on (resolves ephemeral port 0) */
  port: number;
};

type RouteMatch = {
  prefix: string;
  routes: WebhookRoute[];
};

/**
 * Generic HTTP webhook ingress — the single entry point for all
 * channel webhook callbacks.
 *
 * Design notes:
 * - Creates ONE http.Server that all channels share.
 * - Routes by path prefix: /webhook/feishu/* → feishu handlers,
 *   /webhook/dingtalk/* → dingtalk handlers.
 * - Each channel plugin provides WebhookRoute[] via ChannelRouteMount.
 * - Supports graceful shutdown (SIGINT/SIGTERM).
 * - Port is a gateway-level config, not per-channel.
 */
export class WebhookIngress {
  private readonly config: WebhookIngressConfig;
  private readonly prefixMap: Map<string, RouteMatch>;
  private server: http.Server | null = null;
  private running = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];

  constructor(config: WebhookIngressConfig) {
    this.config = config;
    this.prefixMap = new Map();

    for (const mount of config.mounts) {
      this.prefixMap.set(mount.pathPrefix, {
        prefix: mount.pathPrefix,
        routes: mount.routes,
      });
    }
  }

  /**
   * Register a channel's route mount after construction.
   * Useful for dynamic channel registration.
   */
  mount(mount: ChannelRouteMount): void {
    this.prefixMap.set(mount.pathPrefix, {
      prefix: mount.pathPrefix,
      routes: mount.routes,
    });
  }

  /**
   * Remove a channel's route mount.
   */
  unmount(pathPrefix: string): void {
    this.prefixMap.delete(pathPrefix);
  }

  /**
   * Register a feishu channel's webhook handlers under a path prefix.
   * Mounts two routes: `${prefix}/event` and `${prefix}/card`.
   */
  registerChannelHandlers(
    channelId: string,
    prefix: string,
    handlers: ChannelWebhookHandlers,
  ): void {
    this.mount({
      channelId,
      pathPrefix: prefix,
      routes: [
        { path: `${prefix}/event`, handler: handlers.eventHandler },
        { path: `${prefix}/card`, handler: handlers.cardHandler },
      ],
    });
  }

  /**
   * Start the shared HTTP server and begin listening.
   * Returns runtime state including the actual port.
   */
  async start(): Promise<WebhookIngressRuntime> {
    if (this.running) {
      throw new Error("WebhookIngress is already running");
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Internal server error";
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end(message);
      });
    });

    const port = this.config.port;
    const host = this.config.host ?? "0.0.0.0";

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.on("error", reject);
    });

    const address = this.server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;

    this.running = true;
    this.installSignalHandlers();

    return { server: this.server, port: actualPort };
  }

  /**
   * Gracefully stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    this.removeSignalHandlers();

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });

    this.server = null;
    this.running = false;
  }

  /**
   * Register a callback to be invoked during graceful shutdown.
   * Use this for channel-specific cleanup (e.g., abort signals).
   */
  onShutdown(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  /**
   * Whether the ingress server is currently listening.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Core request dispatcher: match URL path against registered
   * channel prefixes, then try each route in the matching channel.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = req.url ?? "/";
    const method = req.method ?? "GET";

    logger.debug(`[webhook-ingress] ${method} ${urlPath}`);

    let bestMatch: RouteMatch | null = null;
    let bestLen = -1;

    for (const match of this.prefixMap.values()) {
      if (urlPath.startsWith(match.prefix) && match.prefix.length > bestLen) {
        bestMatch = match;
        bestLen = match.prefix.length;
      }
    }

    if (!bestMatch) {
      logger.debug(`[webhook-ingress] no route match for ${method} ${urlPath}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    let handled = false;
    for (const route of bestMatch.routes) {
      if (urlPath === route.path || urlPath.startsWith(route.path)) {
        try {
          await route.handler(req, res);
          handled = true;
          break;
        } catch (err) {
          logger.debug(`[webhook-ingress] handler error for ${urlPath}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
    }

    if (!handled) {
      logger.debug(`[webhook-ingress] no handler matched for ${urlPath} under ${bestMatch.prefix}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private installSignalHandlers(): void {
    const shutdown = () => {
      this.gracefulShutdown();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    this._signalHandler = shutdown;
  }

  private removeSignalHandlers(): void {
    if (this._signalHandler) {
      process.off("SIGINT", this._signalHandler);
      process.off("SIGTERM", this._signalHandler);
      this._signalHandler = null;
    }
  }

  private async gracefulShutdown(): Promise<void> {
    await Promise.all(this.shutdownHandlers.map((handler) => handler().catch(() => {})));

    await this.stop();
  }

  /** @internal stored for cleanup */
  private _signalHandler: (() => void) | null = null;
}

/**
 * Convenience factory — create and start a WebhookIngress in one call.
 */
export async function createWebhookIngress(
  config: WebhookIngressConfig,
): Promise<WebhookIngress & WebhookIngressRuntime> {
  const ingress = new WebhookIngress(config);
  const runtime = await ingress.start();
  return Object.assign(ingress, runtime);
}
