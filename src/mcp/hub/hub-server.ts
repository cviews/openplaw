import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as http from "node:http";
import { z } from "zod";
import { OpenmoHubRegistry } from "./hub-registry.js";
import type { ResourceManager } from "../../resource/resource-manager.js";

const VERSION = "0.1.0";

export type OpenmoHubServeOptions = {
  port?: number;
  hostname?: string;
  verbose?: boolean;
  resourceManager?: ResourceManager;
};

export type HubServerResult = {
  server: McpServer;
  registry: OpenmoHubRegistry;
  httpServer: http.Server;
  url: string;
  close: () => Promise<void>;
};

/**
 * Create the openplaw hub MCP server.
 *
 * Uses SSE transport so that multiple clients (gateway + opencode agent) can
 * connect simultaneously. The server exposes all tools from the hub-registry
 * plus hub management tools.
 *
 * NOTE: SSEServerTransport is deprecated in favour of StreamableHTTPServerTransport
 * in the MCP SDK. We use SSE for now because it's simpler and widely supported.
 * Migration to StreamableHTTP is a future task.
 */
export async function createOpenmoHubServer(
  registry: OpenmoHubRegistry,
  options: OpenmoHubServeOptions = {},
): Promise<HubServerResult> {
  const server = new McpServer({
    name: "openplaw-hub",
    version: VERSION,
  });

  const resourceManager = options.resourceManager ?? null;

  registerHubCoreTools(server, registry);
  if (resourceManager) {
    registerResourceTools(server, resourceManager);
  }

  const port = options.port ?? 4097;
  const hostname = options.hostname ?? "localhost";
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer();

  httpServer.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);

    // ── Resource API routes ──────────────────────────────────────────────
    if (url.pathname.startsWith("/api/resources")) {
      if (!resourceManager) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ResourceManager not available" }));
        return;
      }
      await handleResourceApi(req, res, url, resourceManager);
      return;
    }

    // ── SSE transport ────────────────────────────────────────────────────
    if (url.pathname === "/sse" && req.method === "GET") {
      try {
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        transport.onclose = () => {
          transports.delete(sessionId);
        };

        await server.connect(transport);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500).end("SSE connection error");
        }
      }
      return;
    }

    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400).end("Missing sessionId parameter");
        return;
      }
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end("Session not found");
        return;
      }
      try {
        await transport.handlePostMessage(req, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500).end("Error handling message");
        }
      }
      return;
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, hostname, () => resolve());
  });

  const url = `http://${hostname}:${port}`;

  return {
    server,
    registry,
    httpServer,
    url,
    close: async () => {
      for (const [, transport] of transports) {
        try {
          await transport.close();
        } catch {
          // best-effort close
        }
      }
      transports.clear();
      httpServer.close();
      await server.close();
    },
  };
}

function registerHubCoreTools(
  server: McpServer,
  registry: OpenmoHubRegistry,
): void {
  server.tool(
    "mcp_list_registered",
    "List all registered MCP servers available in openplaw hub.",
    {},
    async () => {
      const registrations = registry.listEnabled();
      return {
        content: [
          {
            type: "text" as const,
            text: `Registered MCPs: ${registrations.length}`,
          },
        ],
      };
    },
  );

  server.tool(
    "mcp_check_registered",
    "Check if a specific MCP is registered in openplaw hub.",
    { name: z.string().min(1).describe("MCP name to check") },
    async ({ name }) => {
      const isReg = registry.isRegistered(name);
      return {
        content: [
          {
            type: "text" as const,
            text: isReg
              ? `MCP "${name}" is registered`
              : `MCP "${name}" is NOT registered`,
          },
        ],
      };
    },
  );
}

function registerResourceTools(
  server: McpServer,
  resourceManager: ResourceManager,
): void {
  server.tool(
    "list_skills",
    "List all available skills (merged global + project, project overrides global).",
    { project: z.string().optional().describe("Project path for project-specific merge") },
    async ({ project }) => {
      const skills = resourceManager.getMergedSkills(project);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(skills.map((s) => ({ name: s.name, source: s.source, projectPath: s.projectPath })),
            null,
            2),
          },
        ],
      };
    },
  );

  server.tool(
    "list_commands",
    "List all available commands (merged global + project, project overrides global).",
    { project: z.string().optional().describe("Project path for project-specific merge") },
    async ({ project }) => {
      const commands = resourceManager.getMergedCommands(project);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(commands.map((c) => ({ name: c.name, source: c.source, projectPath: c.projectPath })),
            null,
            2),
          },
        ],
      };
    },
  );

  server.tool(
    "list_mcp",
    "List all available MCP servers (merged global + project, project overrides global).",
    { project: z.string().optional().describe("Project path for project-specific merge") },
    async ({ project }) => {
      const mcps = resourceManager.getMergedMcps(project);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(mcps.map((m) => ({ name: m.name, source: m.source, projectPath: m.projectPath })),
            null,
            2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_project_context",
    "Get full merged resource context for a project (skills, commands, MCPs, agents).",
    { project: z.string().describe("Project path to get context for") },
    async ({ project }) => {
      const skills = resourceManager.getMergedSkills(project);
      const commands = resourceManager.getMergedCommands(project);
      const mcps = resourceManager.getMergedMcps(project);
      const agents = resourceManager.getMergedAgents(project);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { project, skills: skills.length, commands: commands.length, mcps: mcps.length, agents: agents.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

async function handleResourceApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  resourceManager: ResourceManager,
): Promise<void> {
  const projectPath = url.searchParams.get("project") ?? undefined;

  if (url.pathname === "/api/resources/skills" && req.method === "GET") {
    sendJson(res, resourceManager.getMergedSkills(projectPath));
    return;
  }

  if (url.pathname === "/api/resources/commands" && req.method === "GET") {
    sendJson(res, resourceManager.getMergedCommands(projectPath));
    return;
  }

  if (url.pathname === "/api/resources/mcps" && req.method === "GET") {
    sendJson(res, resourceManager.getMergedMcps(projectPath));
    return;
  }

  if (url.pathname === "/api/resources/agents" && req.method === "GET") {
    sendJson(res, resourceManager.getMergedAgents(projectPath));
    return;
  }

  if (url.pathname === "/api/resources/all" && req.method === "GET") {
    const cached = resourceManager.getCached();
    if (!cached) {
      sendJson(res, { error: "ResourceManager not initialized" }, 503);
      return;
    }
    const result: Record<string, unknown> = {
      globalSkills: cached.globalSkills,
      globalCommands: cached.globalCommands,
      globalMcps: cached.globalMcps,
      globalAgents: cached.globalAgents,
      projects: Object.fromEntries(cached.projects),
    };
    if (projectPath) {
      result.skills = resourceManager.getMergedSkills(projectPath);
      result.commands = resourceManager.getMergedCommands(projectPath);
      result.mcps = resourceManager.getMergedMcps(projectPath);
      result.agents = resourceManager.getMergedAgents(projectPath);
    }
    sendJson(res, result);
    return;
  }

  if (url.pathname === "/api/resources/projects" && req.method === "GET") {
    sendJson(res, resourceManager.getAllProjectPaths());
    return;
  }

  if (url.pathname === "/api/resources/refresh" && req.method === "POST") {
    sendJson(res, { message: "Use openplaw server restart for refresh" });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

function sendJson(res: http.ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
