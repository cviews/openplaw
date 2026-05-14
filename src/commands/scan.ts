import { OpenmoMcpRegistry } from "../mcp/index.js";
import { logger } from "../infra/logger.js";

export type ScanCommandOptions = {
  agentsDir?: string;
  verbose?: boolean;
};

export async function scanCommand(options?: ScanCommandOptions): Promise<void> {
  logger.info("Scanning for agents and MCP servers...");

  const registry = new OpenmoMcpRegistry({
    agentsDir: options?.agentsDir,
    verbose: options?.verbose,
  });

  const result = await registry.scanAll();

  logger.info(`Scan complete: ${result.configs.length} MCP config(s) found`);

  for (const config of result.configs) {
    const serverNames = Object.keys(config.config);
    logger.info(
      `  [${config.source}] ${config.agentName ?? "unknown"}: ${serverNames.join(", ") || "(empty)"}`,
    );
  }

  if (result.errors.length > 0) {
    logger.warn(`${result.errors.length} error(s) during scan:`);
    for (const err of result.errors) {
      logger.warn(`  ${err.source}: ${err.message}`);
    }
  }
}
