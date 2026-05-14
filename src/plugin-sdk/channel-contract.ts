/**
 * Channel plugin interface — openplaw's multi-channel abstraction.
 *
 * All adapters are optional. Core auto-degrades when a channel
 * doesn't support a capability (e.g., interactive cards → plain text).
 */

export type OpenmoChannelCapabilities = {
  chatTypes: Array<"direct" | "group" | "thread">;
  interactive?: boolean; // Interactive cards (Feishu: yes, DingTalk: no)
  streaming?: boolean; // Streaming card updates (Feishu: yes)
  threads?: boolean; // Thread/topic support
  media?: boolean; // Media/file support
  edit?: boolean; // Message edit (for streaming in-place replacement)
  textChunkLimit?: number; // Max chars per text message (Feishu: 4000)
};

export type SendTextContext = {
  to: string; // chat_id or user_id
  text: string;
  replyToId?: string;
  threadId?: string;
  accountId?: string;
  botId?: string;
  silent?: boolean;
};

export type SendMentionContext = {
  to: string;
  botName: string; // Display name for @mention
  text: string; // Message text with @mention prefix
  replyToId?: string;
  botId?: string;
  mentionUserId?: string; // open_id of the user/bot being @mentioned
};

export type OpenmoChannelPlugin = {
  id: string; // "feishu" | "dingtalk"
  meta: { name: string; description: string };
  capabilities: OpenmoChannelCapabilities;

  // Required: all channels must support sending text
  config: {
    resolveAccount: (cfg: unknown) => unknown;
    resolveAccounts: (cfg: unknown) => unknown[];
  };

  outbound: {
    sendText: (ctx: SendTextContext) => Promise<void>;
    sendMention: (ctx: SendMentionContext) => Promise<void>;
  };

  // Optional: connection management (webhook/stream/websocket)
  gateway?: {
    startAccount: (ctx: {
      cfg: unknown;
      account: unknown;
      abortSignal?: AbortSignal;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }) => Promise<void>;
    stopAccount?: (ctx: { cfg: unknown; account: unknown }) => Promise<void>;
  };

  // Optional: streaming card support
  streaming?: {
    startStreaming: (ctx: {
      to: string;
      replyToId?: string;
      header?: { title: string; template?: string };
    }) => Promise<string>; // Returns streaming session ID
    updateStreaming: (sessionId: string, text: string) => Promise<void>;
    closeStreaming: (
      sessionId: string,
      finalText?: string,
      options?: { note?: string },
    ) => Promise<void>;
  };

  // Optional: interactive card support (approval, confirmation)
  interactive?: {
    sendInteractiveCard: (ctx: { to: string; card: Record<string, unknown> }) => Promise<void>;
    updateInteractiveCard: (ctx: {
      cardId: string;
      card: Record<string, unknown>;
    }) => Promise<void>;
    handleInteractiveCallback: (event: unknown) => Promise<void>;
  };

  // Optional: thread/topic support
  threading?: {
    resolveThreadId: (event: unknown) => string | null;
  };

  // Optional: secrets management
  secrets?: {
    getRequiredSecrets: () => string[];
  };
};
