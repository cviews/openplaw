import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createToolsMcpServer, connectToolsMcpServerToStdio } from "../shared/tools-stdio-server.js";

const VERSION = "0.1.0";

function resolveOpenmoBotTools(): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (callId: string, args: unknown) => Promise<unknown>;
}> {
  return [
    {
      name: "openplaw_status",
      description: "Check openplaw bot platform status — active bots, channels, bindings.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return {
          content: [
            {
              type: "text",
              text: "openplaw 0.1.0 — status check placeholder (gateway not yet connected)",
            },
          ],
        };
      },
    },
    {
      name: "openplaw_list_bots",
      description: "List all configured bots and their agent mappings.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return {
          content: [
            { type: "text", text: "[] — bot list placeholder (registry not yet connected)" },
          ],
        };
      },
    },
  ];
}

function createOpenmoBotToolsMcpServer(): Server {
  const tools = resolveOpenmoBotTools();
  return createToolsMcpServer({ name: "openplaw-bot-tools", version: VERSION, tools });
}

async function serveOpenmoBotToolsMcp(): Promise<void> {
  const server = createOpenmoBotToolsMcpServer();
  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveOpenmoBotToolsMcp().catch((err) => {
    process.stderr.write(
      `openplaw-bot-tools-serve: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

export { createOpenmoBotToolsMcpServer, serveOpenmoBotToolsMcp, resolveOpenmoBotTools };
