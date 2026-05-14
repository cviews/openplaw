import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type AgentTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (callId: string, args: unknown) => Promise<unknown>;
};

export function createToolsMcpServer(params: {
  name: string;
  version: string;
  tools: AgentTool[];
}): Server {
  const toolMap = new Map<string, AgentTool>();
  for (const tool of params.tools) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: params.name, version: params.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(`mcp-${Date.now()}`, request.params.arguments ?? {});
      const rawContent =
        result && typeof result === "object" && "content" in result
          ? (result as { content?: unknown }).content
          : result;
      return {
        content: Array.isArray(rawContent)
          ? rawContent
          : [
              {
                type: "text",
                text: typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent),
              },
            ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function connectToolsMcpServerToStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void server.close();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}
