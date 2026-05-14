import * as fs from "node:fs";
import { OpenmoHubRegistry } from "../hub/hub-registry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PromptMcpReference = {
  name: string;
  found: boolean;
  registered: boolean;
};

export type PromptMcpResolveResult = {
  filePath: string;
  references: PromptMcpReference[];
  warnings: Array<{ name: string; message: string }>;
};

// ─── Regex ────────────────────────────────────────────────────────────────────

const MCP_NAME_PATTERN = /(?:使用|use)\s+(\w+)/gi;

// ─── Resolver ─────────────────────────────────────────────────────────────────

export function resolvePromptMcpReferences(
  filePath: string,
  hubRegistry: OpenmoHubRegistry,
): PromptMcpResolveResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {
      filePath,
      references: [],
      warnings: [{ name: "", message: `Cannot read file: ${filePath}` }],
    };
  }

  return resolvePromptMcpReferencesFromContent(content, hubRegistry, filePath);
}

export function resolvePromptMcpReferencesFromContent(
  content: string,
  hubRegistry: OpenmoHubRegistry,
  filePath?: string,
): PromptMcpResolveResult {
  const references: PromptMcpReference[] = [];
  const warnings: Array<{ name: string; message: string }> = [];

  const strippedContent = stripFrontmatter(content);
  const matches = strippedContent.matchAll(MCP_NAME_PATTERN);
  const seenNames = new Set<string>();

  for (const match of matches) {
    const name = match[1];
    if (!name || seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);

    const isRegistered = hubRegistry.isRegistered(name);
    references.push({
      name,
      found: true,
      registered: isRegistered,
    });

    if (!isRegistered) {
      warnings.push({
        name,
        message: `MCP "${name}" is referenced in prompt but not registered in the hub`,
      });
    }
  }

  return { filePath: filePath ?? "", references, warnings };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function stripFrontmatter(content: string): string {
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (frontmatterMatch) {
    return content.slice(frontmatterMatch[0].length);
  }
  return content;
}
