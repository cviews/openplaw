import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ClaudeCodeMcpServer,
  McpServerConfig,
  SkillMcpConfig,
  ScannedMcpConfig,
} from "../shared/types.js";

export type { ClaudeCodeMcpServer, McpServerConfig, SkillMcpConfig, ScannedMcpConfig };

const MCP_JSON_FILENAME = "mcp.json";
const DOT_MCP_JSON_FILENAME = ".mcp.json";

export function adaptToMcpServerConfig(name: string, server: ClaudeCodeMcpServer): McpServerConfig {
  const explicitType = server.type;
  const hasUrl = typeof server.url === "string" && server.url.trim().length > 0;
  const hasCommand = typeof server.command === "string" && server.command.trim().length > 0;

  if (explicitType === "http" || explicitType === "sse" || (hasUrl && !hasCommand)) {
    return {
      type: "remote",
      url: server.url ?? "",
      headers: server.headers,
      oauth: server.oauth,
      enabled: !server.disabled,
    };
  }

  const command = server.command ?? "";
  const args = server.args ?? [];
  return {
    type: "local",
    command: [command, ...args].filter((s) => s.length > 0),
    environment: server.env,
    enabled: !server.disabled,
  };
}

export function adaptToSkillMcpConfig(scanned: ScannedMcpConfig): SkillMcpConfig {
  return scanned.config;
}

export function adaptAllToPluginComponents(
  scannedConfigs: ScannedMcpConfig[],
): Record<string, unknown> {
  const merged: SkillMcpConfig = {};
  for (const scanned of scannedConfigs) {
    for (const [serverName, serverConfig] of Object.entries(scanned.config)) {
      if (!serverConfig.disabled) {
        const prefixedName = scanned.agentName ? `${scanned.agentName}_${serverName}` : serverName;
        merged[prefixedName] = absolutizeMcpServerConfig(
          serverConfig,
          scanned.agentPath ?? process.cwd(),
        );
      }
    }
  }
  return merged;
}

export function scanMcpJsonFromDir(agentDir: string): SkillMcpConfig | undefined {
  const mcpJsonPath = path.join(agentDir, MCP_JSON_FILENAME);
  const dotMcpJsonPath = path.join(agentDir, DOT_MCP_JSON_FILENAME);

  for (const filePath of [mcpJsonPath, dotMcpJsonPath]) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        return extractMcpServerMap(parsed);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function scanMcpFromFrontmatter(frontmatterContent: string): SkillMcpConfig | undefined {
  try {
    const parsed = parseFrontmatter(frontmatterContent);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return extractMcpServerMap(parsed);
  } catch {
    return undefined;
  }
}

export function extractMcpServerMap(raw: unknown): SkillMcpConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const mcpServers = isRecord(record.mcpServers)
    ? record.mcpServers
    : isRecord(record.servers)
      ? record.servers
      : undefined;

  if (!mcpServers) {
    return undefined;
  }

  const result: SkillMcpConfig = {};
  for (const [serverName, serverRaw] of Object.entries(mcpServers)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = serverRaw as ClaudeCodeMcpServer;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result;
}

function absolutizeMcpServerConfig(
  server: ClaudeCodeMcpServer,
  baseDir: string,
): ClaudeCodeMcpServer {
  const next: ClaudeCodeMcpServer & Record<string, unknown> = { ...server };

  if (typeof next.command === "string" && isExplicitRelativePath(next.command)) {
    next.command = path.resolve(baseDir, next.command);
  }

  if (Array.isArray(next.args)) {
    next.args = next.args.map((arg) => {
      if (typeof arg === "string" && isExplicitRelativePath(arg)) {
        return path.resolve(baseDir, arg);
      }
      return arg;
    });
  }

  if (typeof next.cwd === "string" && isExplicitRelativePath(next.cwd)) {
    next.cwd = path.resolve(baseDir, next.cwd as string);
  }

  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([key, value]) => [
        key,
        typeof value === "string" && isExplicitRelativePath(value)
          ? path.resolve(baseDir, value)
          : value,
      ]),
    );
  }

  return next;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!yamlMatch) {
    return null;
  }
  const yaml = yamlMatch[1];
  const result: Record<string, unknown> = {};
  if (!yaml) {
    return null;
  }
  const lines = yaml.split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}
