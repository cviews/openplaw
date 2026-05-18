import { resolveGatewayService } from "../daemon/index.js";
import { logger } from "../infra/logger.js";
import type { GatewayServiceEnv } from "../daemon/service-types.js";

export type DaemonSubcommand = "status" | "install" | "uninstall" | "start" | "stop" | "restart";

export async function daemonCommand(subcommand: DaemonSubcommand): Promise<void> {
  const service = resolveGatewayService();
  switch (subcommand) {
    case "status": {
      const state = await service.readState();
      console.log(
        `Installed: ${state.installed}, Loaded: ${state.loaded}, Running: ${state.running}${state.pid ? `, PID: ${state.pid}` : ""}`
      );
      break;
    }
    case "install": {
      await service.install({
        env: process.env as GatewayServiceEnv,
        programArguments: [process.execPath, process.argv[1]!, "start"],
      });
      logger.info("Daemon installed successfully");
      break;
    }
    case "uninstall": {
      await service.uninstall();
      logger.info("Daemon uninstalled successfully");
      break;
    }
    case "start": {
      const result = await service.start();
      logger.info(`Daemon start: ${result.outcome}`);
      break;
    }
    case "stop": {
      await service.stop();
      logger.info("Daemon stopped");
      break;
    }
    case "restart": {
      const result = await service.restart();
      logger.info(`Daemon restart: ${result.outcome}`);
      break;
    }
  }
}
