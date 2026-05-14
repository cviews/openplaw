/**
 * Opencode app configuration type — structurally compatible with
 * the SDK's Config type from @opencode-ai/sdk/dist/gen/types.gen.js
 *
 * The SDK doesn't publicly export this type through its package exports map,
 * so we define our own compatible version here. When passing this to
 * createOpencodeTui(), TypeScript will verify structural compatibility.
 */
export type OpencodeConfig = {
  $schema?: string;
  theme?: string;
  keybinds?: Record<string, unknown>;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  tui?: Record<string, unknown>;
  command?: Record<string, unknown>;
  watcher?: { ignore?: Array<string> };
  plugin?: Array<string>;
  snapshot?: boolean;
  share?: "manual" | "auto" | "disabled";
  autoupdate?: boolean | "notify";
  disabled_providers?: Array<string>;
  enabled_providers?: Array<string>;
  model?: string;
  small_model?: string;
  username?: string;
  agent?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  formatter?: false | Record<string, unknown>;
  lsp?: false | Record<string, unknown>;
  instructions?: Array<string>;
  layout?: Record<string, unknown>;
  permission?: string | Record<string, unknown>;
  tools?: Record<string, boolean>;
  enterprise?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  compaction?: {
    auto?: boolean;
    tail_turns?: number;
    preserve_recent_tokens?: number;
  };
};

/** @deprecated Credentials are now embedded in OpenmoBotConfig. Kept for migration compat. */
export type ChannelCredentials = {
  channelId: string;
  [key: string]: unknown;
};