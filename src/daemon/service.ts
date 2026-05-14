import type {
  GatewayServiceInstallArgs,
  GatewayServiceState,
  GatewayServiceStartResult,
  GatewayServiceRestartResult,
} from "./service-types.js";
import { createLaunchdService } from "./launchd.js";
import { createSystemdService } from "./systemd.js";
import { createSchtasksService } from "./schtasks.js";

export type GatewayService = {
  label: string;
  install(args: GatewayServiceInstallArgs): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<GatewayServiceStartResult>;
  stop(): Promise<void>;
  restart(): Promise<GatewayServiceRestartResult>;
  isLoaded(): Promise<boolean>;
  readState(): Promise<GatewayServiceState>;
};

export function resolveGatewayService(): GatewayService {
  switch (process.platform) {
    case "darwin":
      return createLaunchdService();
    case "linux":
      return createSystemdService();
    case "win32":
      return createSchtasksService();
    default:
      throw new Error(`Unsupported platform for daemon: ${process.platform}`);
  }
}
