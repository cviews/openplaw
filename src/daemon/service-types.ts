export type GatewayServiceEnv = Record<string, string | undefined>;

export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  programArguments: string[];
  workingDirectory?: string;
  description?: string;
};

export type GatewayServiceState = {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
  env: GatewayServiceEnv;
};

export type GatewayServiceStartResult =
  | { outcome: "started"; state: GatewayServiceState }
  | { outcome: "scheduled"; state: GatewayServiceState }
  | { outcome: "missing-install"; state: GatewayServiceState };

export type GatewayServiceRestartResult = { outcome: "completed" | "scheduled" };
