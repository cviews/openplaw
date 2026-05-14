import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export type HubClientConfig = {
  /** Hub server URL (e.g. "http://localhost:4097") */
  url: string;
  /** Client name for identification */
  name?: string;
};

export type HubClientResult = {
  client: Client;
  close: () => Promise<void>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listTools: () => Promise<Array<{ name: string; description?: string }>>;
};

export async function createOpenmoHubClient(
  config: HubClientConfig,
): Promise<HubClientResult> {
  const client = new Client({
    name: config.name ?? "openplaw-gateway",
    version: "0.1.0",
  });

  const sseUrl = `${config.url}/sse`;
  const transport = new SSEClientTransport(new URL(sseUrl));

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
    callTool: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return result;
    },
    listTools: async () => {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name, description: t.description }));
    },
  };
}
