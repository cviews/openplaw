import type { OpencodeClient } from "@opencode-ai/sdk";
import { logger } from "../infra/logger.js";

/**
 * Resolves short agent names (e.g. "sisyphus") to display names
 * that the opencode serve API requires (e.g. "Sisyphus - Ultraworker").
 *
 * The omo plugin registers agents with display names like "Sisyphus - Ultraworker",
 * but users configure short names like "sisyphus" in openplaw.json.
 * The opencode serve API only accepts the full display name.
 */
export class AgentNameResolver {
  private nameMap: Map<string, string> = new Map();
  private initialized = false;

  /**
   * Query the opencode serve API for available agents and build
   * the short-name → display-name mapping.
   */
  async initialize(client: OpencodeClient): Promise<void> {
    try {
      const result = await client.app.agents();
      if (!result.data) {
        logger.warn("AgentNameResolver: no agent data returned from API");
        return;
      }

      this.nameMap.clear();

      for (const agent of result.data) {
        const displayName = agent.name;
        // Register the full display name as-is
        this.nameMap.set(displayName, displayName);
        this.nameMap.set(displayName.toLowerCase(), displayName);

        // "Sisyphus - Ultraworker" → short "sisyphus" (space-dash-space pattern only)
        // "Hephaestus - Deep Agent" → short "hephaestus"
        // "Prometheus - Plan Builder" → short "prometheus"
        // Does NOT match compound names like "Sisyphus-Junior" or "OpenCode-Builder"
        const spacedDashMatch = displayName.match(/^([A-Za-z]+)\s+-\s+/);
        if (spacedDashMatch?.[1]) {
          const shortName = spacedDashMatch[1].toLowerCase();
          this.nameMap.set(shortName, displayName);
        }

        // "OpenCode-Builder" → "opencode-builder"
        // "Sisyphus-Junior" → "sisyphus-junior"
        if (displayName.includes("-") && !displayName.includes(" ")) {
          this.nameMap.set(displayName.toLowerCase(), displayName);
        }
      }

      this.initialized = true;
      logger.info("AgentNameResolver initialized", {
        agents: Array.from(this.nameMap.entries()).map(([k, v]) => `${k} → ${v}`),
      });
    } catch (err) {
      logger.error("AgentNameResolver: failed to query agents from API", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve a short or partial agent name to the full display name
   * required by the opencode serve API.
   *
   * If the resolver is not initialized, returns the input unchanged.
   * If no mapping is found, returns the input unchanged (the API will
   * return an error listing available agents).
   */
  resolve(name: string): string {
    if (!this.initialized) {
      logger.warn("AgentNameResolver not initialized, returning name unchanged", { name });
      return name;
    }

    // Try exact match first
    const exact = this.nameMap.get(name);
    if (exact) return exact;

    // Try lowercase
    const lower = this.nameMap.get(name.toLowerCase());
    if (lower) return lower;

    // No mapping found - this likely means a configuration error in openplaw.json
    const uniqueDisplayNames = this.getAvailableAgentNames();
    logger.error(
      `Agent name "${name}" not found. This is likely a configuration error — check the "agent" field in your openplaw.json bots config. Available agents: ${uniqueDisplayNames.join(", ")}`,
      { configuredName: name, availableAgents: uniqueDisplayNames },
    );
    return name;
  }

  /** Get all available display names */
  getAvailableAgentNames(): string[] {
    const unique = new Set<string>();
    for (const displayName of this.nameMap.values()) {
      unique.add(displayName);
    }
    return Array.from(unique);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}