import * as http from "node:http";
import type { ResourceManager } from "../resource/resource-manager.js";

export function mountResourceApiRoutes(
  httpServer: http.Server,
  resourceManager: ResourceManager,
  hostname: string,
  port: number,
): void {
  const originalListeners = httpServer.listeners("request") as Array<http.RequestListener>;

  httpServer.removeAllListeners("request");

  httpServer.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);

    if (url.pathname.startsWith("/api/resources")) {
      await handleResourceApiRequest(req, res, url, resourceManager);
      return;
    }

    for (const listener of originalListeners) {
      listener(req, res);
    }
  });
}

async function handleResourceApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  resourceManager: ResourceManager,
): Promise<void> {
  const projectPath = url.searchParams.get("project") ?? undefined;

  if (url.pathname === "/api/resources/skills" && req.method === "GET") {
    const skills = resourceManager.getMergedSkills(projectPath);
    sendJson(res, skills);
    return;
  }

  if (url.pathname === "/api/resources/commands" && req.method === "GET") {
    const commands = resourceManager.getMergedCommands(projectPath);
    sendJson(res, commands);
    return;
  }

  if (url.pathname === "/api/resources/mcps" && req.method === "GET") {
    const mcps = resourceManager.getMergedMcps(projectPath);
    sendJson(res, mcps);
    return;
  }

  if (url.pathname === "/api/resources/agents" && req.method === "GET") {
    const agents = resourceManager.getMergedAgents(projectPath);
    sendJson(res, agents);
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Use openplaw server restart for refresh" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function sendJson(res: http.ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}