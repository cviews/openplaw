import * as lark from "@larksuiteoapi/node-sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  OpenmoChannelPlugin,
  SendTextContext,
  SendMentionContext,
} from "../../../plugin-sdk/channel-contract.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import {
  decodeCardAction,
  sendApprovalCard,
  updateApprovalCard,
  type ApprovalCallbackResult,
} from "./card-approval.js";
import {
  createFeishuWebhookHandlers,
  type FeishuHandlerConfig,
  type FeishuWebhookHandlers,
} from "./handler.js";
import { SessionBindingService } from "../../../core/routing/session-binding.js";
import type { HubClientResult } from "../../../mcp/hub/hub-client.js";
import { BotCredentialsRegistry } from "./bot-registry.js";

export type FeishuChannelConfig = {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  botName: string;
  port?: number;
};

type FeishuAccount = {
  appId: string;
  appSecret: string;
  botName: string;
  verificationToken: string;
  encryptKey: string;
};

const streamingSessions = new Map<string, FeishuStreamingSession>();

let pendingApprovalCallbacks: ((result: ApprovalCallbackResult) => Promise<void>) | null = null;

let botRegistry: BotCredentialsRegistry | null = null;

export function setBotRegistry(registry: BotCredentialsRegistry): void {
  botRegistry = registry;
}

function resolveAccount(cfg: unknown): FeishuAccount {
  const config = cfg as FeishuChannelConfig;
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    botName: config.botName,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
  };
}

function resolveAccounts(cfg: unknown): FeishuAccount[] {
  const account = resolveAccount(cfg);
  if (!account.appId || !account.appSecret) return [];
  return [account];
}

function createLarkClient(config: FeishuChannelConfig): lark.Client {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
  });
}

async function sendText(ctx: SendTextContext): Promise<void> {
  const client = resolveLarkClient(ctx.botId, ctx.accountId);

  if (ctx.replyToId) {
    const replyData: {
      msg_type: string;
      content: string;
      disable_robot_notification?: boolean;
    } = {
      msg_type: "text",
      content: JSON.stringify({ text: ctx.text }),
    };
    if (ctx.silent) {
      replyData.disable_robot_notification = true;
    }
    const response = await client.im.message.reply({
      path: { message_id: ctx.replyToId },
      data: replyData,
    });
    if (response.code !== 0) {
      throw new Error(`Feishu reply failed: ${response.msg}`);
    }
    return;
  }

  const createData: {
    receive_id: string;
    msg_type: string;
    content: string;
    disable_robot_notification?: boolean;
  } = {
    receive_id: ctx.to,
    msg_type: "text",
    content: JSON.stringify({ text: ctx.text }),
  };
  if (ctx.silent) {
    createData.disable_robot_notification = true;
  }
  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: createData,
  });

  if (response.code !== 0) {
    throw new Error(`Feishu send failed: ${response.msg}`);
  }
}

async function sendMention(ctx: SendMentionContext): Promise<void> {
  const client = resolveLarkClient(ctx.botId);

  const contentLine: Array<Record<string, string>> = [];

  if (ctx.mentionUserId) {
    contentLine.push({ tag: "at", user_id: ctx.mentionUserId });
  }

  contentLine.push({ tag: "text", text: ctx.mentionUserId ? ctx.text : `@${ctx.botName} ${ctx.text}` });

  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: ctx.to,
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [
            contentLine,
          ],
        },
      }),
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu mention send failed: ${response.msg}`);
  }
}

function resolveLarkClient(botId?: string, accountId?: string): lark.Client {
  if (botRegistry) {
    const targetId = botId ?? accountId;
    if (targetId) {
      const client = botRegistry.getClient(targetId);
      if (client) return client;
    }
    const defaultClient = botRegistry.getDefaultClient();
    if (defaultClient) return defaultClient;
  }

  if (channelConfig) {
    return createLarkClient(channelConfig);
  }

  throw new Error("Feishu client not configured: no botRegistry and no channelConfig");
}

let channelConfig: FeishuChannelConfig | null = null;

export function createFeishuChannelPlugin(
  config: FeishuChannelConfig,
  deps?: { sessionBinding?: SessionBindingService; hubClient?: HubClientResult; opencodeClient?: OpencodeClient; defaultAgent?: string },
): OpenmoChannelPlugin {
  channelConfig = config;

  const handlerConfig: FeishuHandlerConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
    botName: config.botName,
  };

  const sessionBinding = deps?.sessionBinding ?? new SessionBindingService();

  if (!deps?.hubClient) {
    throw new Error("Feishu channel plugin requires a hubClient dependency for MCP hub integration");
  }

  const webhookHandlers = createFeishuWebhookHandlers(handlerConfig, {
    sessionBinding,
    hubClient: deps.hubClient,
    opencodeClient: deps.opencodeClient,
    defaultAgent: deps?.defaultAgent,
    onCardAction: async (event: unknown) => {
      const result = decodeCardAction(event);
      if (result && pendingApprovalCallbacks) {
        await pendingApprovalCallbacks(result);
      }
    },
  });

  storedWebhookHandlers = webhookHandlers;

  const plugin: OpenmoChannelPlugin = {
    id: "feishu",
    meta: {
      name: "Feishu",
      description: "Feishu/Lark enterprise messaging channel",
    },
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      interactive: true,
      streaming: true,
      threads: true,
      edit: false,
      textChunkLimit: 4000,
    },
    config: {
      resolveAccount: (cfg: unknown) => resolveAccount(cfg),
      resolveAccounts: (cfg: unknown) => resolveAccounts(cfg),
    },
    outbound: {
      sendText,
      sendMention,
    },
    streaming: {
      startStreaming: async (ctx) => {
        const client = resolveLarkClient();
        const botConfig = botRegistry?.getDefaultBot();
        const session = new FeishuStreamingSession(client, {
          appId: botConfig?.appId ?? config.appId,
          appSecret: botConfig?.appSecret ?? config.appSecret,
        });

        const receiveIdType = ctx.to.startsWith("ou_") ? "open_id" : "chat_id";

        await session.start(ctx.to, receiveIdType, {
          replyToMessageId: ctx.replyToId,
          header: ctx.header,
        });

        const sessionId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        streamingSessions.set(sessionId, session);
        return sessionId;
      },
      updateStreaming: async (sessionId: string, text: string) => {
        const session = streamingSessions.get(sessionId);
        if (session && session.isActive()) {
          await session.update(text);
        }
      },
      closeStreaming: async (
        sessionId: string,
        finalText?: string,
        options?: { note?: string },
      ) => {
        const session = streamingSessions.get(sessionId);
        if (session) {
          await session.close(finalText, options);
          streamingSessions.delete(sessionId);
        }
      },
    },
    interactive: {
      sendInteractiveCard: async (ctx) => {
        const client = resolveLarkClient();
        const response = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: ctx.to,
            msg_type: "interactive",
            content: JSON.stringify(ctx.card),
          },
        });
        if (response.code !== 0) {
          throw new Error(`Feishu interactive card send failed: ${response.msg}`);
        }
      },
      updateInteractiveCard: async (ctx) => {
        const client = resolveLarkClient();
        const response = await client.im.message.patch({
          path: { message_id: ctx.cardId },
          data: { content: JSON.stringify(ctx.card) },
        });
        if (response.code !== 0) {
          throw new Error(`Feishu interactive card update failed: ${response.msg}`);
        }
      },
      handleInteractiveCallback: async (event: unknown) => {
        const result = decodeCardAction(event);
        if (result && pendingApprovalCallbacks) {
          await pendingApprovalCallbacks(result);
        }
      },
    },
    threading: {
      resolveThreadId: (event: unknown) => {
        const e = event as { message?: { thread_id?: string } };
        return e.message?.thread_id ?? null;
      },
    },
    secrets: {
      getRequiredSecrets: () => ["appId", "appSecret", "verificationToken", "encryptKey"],
    },
  };

  return plugin;
}

export function registerApprovalCallback(
  callback: (result: ApprovalCallbackResult) => Promise<void>,
): void {
  pendingApprovalCallbacks = callback;
}

export { sendApprovalCard, updateApprovalCard, decodeCardAction };
export type { ApprovalCallbackResult };
export { FeishuStreamingSession } from "./streaming-card.js";
export {
  createFeishuWebhookHandlers,
  createFeishuWebhookHandlersForBot,
  type FeishuHandlerConfig,
  type FeishuWebhookHandlers,
} from "./handler.js";
export { BotCredentialsRegistry } from "./bot-registry.js";

let storedWebhookHandlers: FeishuWebhookHandlers | null = null;

export function getFeishuWebhookHandlers(): FeishuWebhookHandlers | null {
  return storedWebhookHandlers;
}
