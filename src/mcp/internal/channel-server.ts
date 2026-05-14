import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalRequestSchema, type OpenmoMcpServeOptions } from "../shared/channel-shared.js";
import { OpenmoChannelBridge } from "./channel-bridge.js";
import { registerChannelMcpTools } from "./channel-tools.js";

export { OpenmoChannelBridge } from "./channel-bridge.js";

const VERSION = "0.1.0";

export async function createOpenmoChannelMcpServer(opts: OpenmoMcpServeOptions = {}): Promise<{
  server: McpServer;
  bridge: OpenmoChannelBridge;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const bridge = new OpenmoChannelBridge({ verbose: opts.verbose ?? false });
  const server = new McpServer({ name: "openplaw", version: VERSION });

  bridge.setServer(server);

  server.server.setNotificationHandler(ApprovalRequestSchema, async ({ params }) => {
    bridge.trackApproval(params.kind as "exec" | "plugin" | "route", {
      id: params.request_id,
      request: { description: params.description, inputPreview: params.input_preview },
    });
  });

  registerChannelMcpTools(server, bridge);

  return {
    server,
    bridge,
    start: async () => {
      // Bridge connects to openplaw runtime deps when available
      // In production, this would connect to the gateway WebSocket
    },
    close: async () => {
      await bridge.close();
      await server.close();
    },
  };
}

export async function serveOpenmoChannelMcp(opts: OpenmoMcpServeOptions = {}): Promise<void> {
  const { server, close } = await createOpenmoChannelMcpServer(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    transport["onclose"] = undefined;
    close().then(resolveClosed, resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}
