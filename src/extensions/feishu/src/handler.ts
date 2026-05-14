import * as http from "node:http";
import { Readable } from "node:stream";
import * as lark from "@larksuiteoapi/node-sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  SessionBindingService,
  buildAgentPeerSessionKey,
  type ConversationRef,
} from "../../../core/routing/session-binding.js";
import { promoteGlobalPreferences } from "../../../config/memory-reader.js";
import { createFixedWindowRateLimiter } from "../../../security/rate-limiter.js";
import { createWebhookInFlightLimiter } from "../../../security/in-flight-limiter.js";
import { applyBasicWebhookRequestGuards } from "../../../security/request-guards.js";
import { verifyFeishuWebhook } from "./feishu-verify.js";
import { logger } from "../../../infra/logger.js";
import type { HubClientResult } from "../../../mcp/hub/hub-client.js";
import type { OpenmoBotConfig } from "../../../config/config.js";
import type { ResourceManager } from "../../../resource/index.js";
import { FeishuStreamingSession, type FeishuStreamingConfig } from "./streaming-card.js";
import { saveSessionSummary, loadRecentSummaries, pruneSessionSummaries, type SummaryConfig } from "../../../config/session-summary.js";
import { ensureProjectOpenplawDir } from "../../../config/memory-reader.js";

// Chinese phrases naturally used in group chats to reference past conversations
const HISTORY_KEYWORDS = /上次|之前|之前讨论|昨天|上回|刚才|last time|previous|earlier|we discussed/i;
const NEW_SESSION_COMMANDS = /^\/new|^新话题|^重新开始/i;

function extractConversationSummary(messages: any[], maxRounds: number): string {
  const allMsgs = messages.filter((msg: any) => msg.info?.role === "user" || msg.info?.role === "assistant");
  const recent = allMsgs.slice(-maxRounds);
  const parts: string[] = [];
  for (const msg of recent) {
    const role = msg.info?.role;
    for (const part of msg.parts ?? []) {
      if (part.type === "text") {
        parts.push(`${role}: ${part.text}`);
      }
    }
  }
  return parts.join("\n");
}

export type FeishuHandlerConfig = {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  botName: string;
  /** @deprecated Port is now a gateway-level concern; this field is ignored. */
  port?: number;
};

type HandlerDeps = {
  sessionBinding: SessionBindingService;
  hubClient: HubClientResult;
  opencodeClient?: OpencodeClient;
  defaultAgent?: string;
  project?: string;
  resourceManager?: ResourceManager;
  summariesConfig?: SummaryConfig;
  onCardAction?: (event: unknown) => Promise<void>;
};

export type FeishuWebhookHandlers = {
  eventHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  cardHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};

const rateLimiter = createFixedWindowRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  maxTrackedKeys: 4096,
});

const inFlightLimiter = createWebhookInFlightLimiter({
  maxInFlightPerKey: 8,
  maxTrackedKeys: 4096,
});

function parseMessageContent(rawContent: string): string {
  if (!rawContent) return "";
  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
      const text = (parsed as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    return "";
  } catch {
    return rawContent;
  }
}

function stripMentionAt(text: string): string {
  return text
    .replace(/<at user_id="[^"]*">[^<]*<\/at>/g, "")
    .replace(/@[a-zA-Z_]\w*/g, "")
    .trim();
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function reconstructRequest(
  original: http.IncomingMessage,
  rawBody: string,
): http.IncomingMessage {
  const readable = Readable.from([Buffer.from(rawBody)]);
  Object.setPrototypeOf(readable, http.IncomingMessage.prototype);
  const reconstructed = readable as unknown as http.IncomingMessage;

  reconstructed.headers = { ...original.headers };
  reconstructed.method = original.method;
  reconstructed.url = original.url;
  reconstructed.httpVersion = original.httpVersion;
  reconstructed.httpVersionMajor = original.httpVersionMajor;
  reconstructed.httpVersionMinor = original.httpVersionMinor;
  reconstructed.trailers = { ...original.trailers };
  reconstructed.socket = original.socket;

  return reconstructed;
}

function sendJsonError(
  res: http.ServerResponse,
  statusCode: number,
  error: string,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

async function applySecurityPipeline(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
  config: FeishuHandlerConfig,
  rateLimitKey = "feishu",
): Promise<boolean> {
  if (
    !applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter,
      rateLimitKey,
    })
  ) {
    logger.debug(`[feishu-security] basic guards rejected ${req.method} ${req.url}`);
    return false;
  }

  if (!inFlightLimiter.tryAcquire(rateLimitKey)) {
    sendJsonError(res, 503, "Too Many Concurrent Requests");
    return false;
  }

  const timestamp =
    (req.headers["x-lark-request-timestamp"] as string | undefined) ?? "";
  const nonce =
    (req.headers["x-lark-request-nonce"] as string | undefined) ?? "";
  const signature =
    (req.headers["x-lark-signature"] as string | undefined) ?? "";

  if (
    !verifyFeishuWebhook({
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
      body: rawBody,
      timestamp,
      nonce,
      signature,
    })
  ) {
    logger.debug(`[feishu-security] signature verification failed for ${req.url}, hasHeaders: ts=${!!timestamp} nonce=${!!nonce} sig=${!!signature}`);
    sendJsonError(res, 403, "Invalid Signature");
    inFlightLimiter.release(rateLimitKey);
    return false;
  }

  return true;
}

/**
 * Create feishu webhook handlers for mounting on a shared gateway.
 * `basePath` controls the URL paths registered with lark.adaptDefault:
 * event handler → `${basePath}/event`, card handler → `${basePath}/card`.
 */
const REPLY_TIMEOUT_MS = 300_000;
const POLL_FAST_MS = 300;
const POLL_SLOW_MS = 1_500;
const STABLE_POLLS_TO_COMPLETE = 4;

async function streamAgentReply(
  opencodeClient: OpencodeClient,
  sessionId: string,
  chatId: string,
  messageId: string,
  larkClient: lark.Client,
  creds: FeishuStreamingConfig,
  directory?: string,
): Promise<void> {
  logger.info(`[feishu-streaming] Starting streamAgentReply: sessionId=${sessionId}, chatId=${chatId}, directory=${directory ?? "none"}`);
  const streaming = new FeishuStreamingSession(larkClient, creds, (msg) =>
    logger.info(`[feishu-streaming] ${msg}`),
  );

  try {
    await streaming.start(chatId, "chat_id", {
      replyToMessageId: messageId,
    });

    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    let lastText = "";
    let stablePollCount = 0;
    let hasSeenContent = false;
    let pollCount = 0;
    let currentInterval = POLL_SLOW_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, currentInterval));
      pollCount++;

      let currentText = "";
      try {
        const messagesArgs: Record<string, unknown> = { sessionID: sessionId };
        if (directory) messagesArgs.directory = directory;
        const messagesResult = await opencodeClient.session.messages(messagesArgs as any);
        if (messagesResult.data) {
          const assistantMsgs = messagesResult.data.filter(
            (msg: any) => msg.info?.role === "assistant",
          );
          const lastMsg = assistantMsgs.at(-1);
          if (lastMsg) {
            const parts: string[] = [];
            for (const part of lastMsg.parts ?? []) {
              if (part.type === "text") {
                parts.push(part.text);
              }
            }
            currentText = parts.join("\n");
          }
        }
      } catch (err) {
        logger.debug(`[feishu-streaming] Messages poll error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (currentText && currentText !== lastText) {
        lastText = currentText;
        stablePollCount = 0;
        hasSeenContent = true;
        currentInterval = POLL_FAST_MS;
        await streaming.update(currentText);
        logger.info(`[feishu-streaming] Updated card (poll #${pollCount}, ${currentText.length} chars)`);
      } else if (currentText && currentText === lastText) {
        stablePollCount++;
        currentInterval = POLL_SLOW_MS;
      } else {
        stablePollCount = 0;
        currentInterval = POLL_SLOW_MS;
      }

      if (hasSeenContent && stablePollCount >= STABLE_POLLS_TO_COMPLETE) {
        logger.info(`[feishu-streaming] Content stabilized, closing: sessionId=${sessionId}`);
        break;
      }
    }

    if (!hasSeenContent) {
      logger.warn(`[feishu-streaming] No content received within timeout for session ${sessionId}`);
    }

    await streaming.close(lastText || undefined);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("[feishu-streaming] Error in streaming reply", { error: errMsg, sessionId, chatId });
    try {
      await streaming.close(`❌ Error: ${errMsg}`);
    } catch {
      // give up
    }
  }
}

type TriggerAndStreamDeps = {
  opencodeClient: OpencodeClient;
  hubClient: HubClientResult;
  sessionBinding: SessionBindingService;
  bindingId: string;
  currentOmoSessionId: string;
  chatId: string;
  messageId: string;
  messageText: string;
  agentName: string;
  directory?: string;
  larkCreds: FeishuStreamingConfig;
  feishuHandlerConfig: FeishuHandlerConfig;
};

async function triggerAndStreamReply(deps: TriggerAndStreamDeps): Promise<void> {
  const larkClient = new lark.Client({
    appId: deps.feishuHandlerConfig.appId,
    appSecret: deps.feishuHandlerConfig.appSecret,
    appType: lark.AppType.SelfBuild,
  });

  try {
    const triggerArgs: Record<string, unknown> = {
      message: deps.messageText,
      agent: deps.agentName,
    };
    if (deps.directory) triggerArgs.directory = deps.directory;
    if (deps.currentOmoSessionId && !deps.currentOmoSessionId.startsWith("agent:")) {
      triggerArgs.session_id = deps.currentOmoSessionId;
    }

    const result = await deps.hubClient.callTool("trigger_agent", triggerArgs);
    const structured = (result as { structuredContent?: { session_id?: string } })?.structuredContent;
    const sessionId = structured?.session_id;
    logger.info(`[feishu-handler] trigger_agent returned session_id=${sessionId ?? "undefined"}`);

    if (!sessionId) {
      logger.warn("[feishu-handler] No session_id from trigger, cannot stream");
      return;
    }

    if (deps.currentOmoSessionId !== sessionId) {
      await deps.sessionBinding.updateOmoSessionId(deps.bindingId, sessionId);
    }

    await streamAgentReply(
      deps.opencodeClient,
      sessionId,
      deps.chatId,
      deps.messageId,
      larkClient,
      deps.larkCreds,
      deps.directory,
    );
  } catch (err) {
    logger.error("[feishu-handler] triggerAndStreamReply error", {
      error: err instanceof Error ? err.message : String(err),
      chatId: deps.chatId,
    });
  }
}

export function createFeishuWebhookHandlers(
  config: FeishuHandlerConfig,
  deps: HandlerDeps,
  basePath = "/webhook/feishu",
): FeishuWebhookHandlers {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  }).register({
    "im.message.receive_v1": async (data: unknown) => {
      const event = data as {
        sender?: { sender_id?: { open_id?: string; user_id?: string } };
        message?: {
          chat_id?: string;
          chat_type?: string;
          message_id?: string;
          content?: string;
          thread_id?: string;
        };
      };

      const message = event.message;
      if (!message) return;

      const chatId = message.chat_id ?? "";
      const chatType = message.chat_type === "group" ? "group" : "p2p";
      const messageId = message.message_id ?? "";
      const threadId = message.thread_id;
      const rawContent = message.content ?? "";
      const text = stripMentionAt(parseMessageContent(rawContent));

      if (!text) return;

      const accountId = "default";

      const conversationRef: ConversationRef = {
        channel: "feishu",
        accountId,
        conversationId: chatId,
        ...(threadId ? { parentConversationId: chatId } : {}),
      };

      let existingBinding = deps.sessionBinding.resolveByConversation(conversationRef);

      if (existingBinding) {
        await deps.sessionBinding.touch(existingBinding.bindingId);
      } else {
        const peerKind = chatType === "group" ? "group" : "direct";
        const sessionKey = buildAgentPeerSessionKey({
          agentId: "main",
          channel: "feishu",
          accountId,
          peerKind,
          peerId: chatId,
          threadId,
        });

        const newBinding = await deps.sessionBinding.bind({
          sessionKey,
          omoSessionId: sessionKey,
          conversation: conversationRef,
        });
        existingBinding = newBinding;
      }

      let triggeredSessionId: string | undefined;

      try {
        const triggerArgs: Record<string, unknown> = {
          message: text,
        };

        if (deps.project) {
          triggerArgs.directory = deps.project;
        }

        if (
          existingBinding.omoSessionId &&
          !existingBinding.omoSessionId.startsWith("agent:")
        ) {
          triggerArgs.session_id = existingBinding.omoSessionId;
        }

        const result = await deps.hubClient.callTool("trigger_agent", triggerArgs);

        const structured = (result as { structuredContent?: { session_id?: string } })
          ?.structuredContent;
        if (structured?.session_id) {
          const realSessionId = structured.session_id;
          triggeredSessionId = realSessionId;
          if (existingBinding.omoSessionId !== realSessionId) {
            await deps.sessionBinding.updateOmoSessionId(
              existingBinding.bindingId,
              realSessionId,
            );
          }
        }
      } catch (err) {
        logger.error("Failed to trigger agent via hub", {
          error: err instanceof Error ? err.message : String(err),
          chatId,
          messageId,
        });
      }

      if (triggeredSessionId && deps.opencodeClient) {
        const larkClient = new lark.Client({
          appId: config.appId,
          appSecret: config.appSecret,
          appType: lark.AppType.SelfBuild,
        });
        void streamAgentReply(
          deps.opencodeClient,
          triggeredSessionId,
          chatId,
          messageId,
          larkClient,
          { appId: config.appId, appSecret: config.appSecret },
          deps.project,
        );
      }
    },
  });

  const cardActionHandler = new lark.CardActionHandler(
    {
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
    },
    async (data: unknown) => {
      await deps.onCardAction?.(data);
      return {};
    },
  );

  const rawEventHandler = lark.adaptDefault(`${basePath}/event`, dispatcher, {
    autoChallenge: true,
  });
  const rawCardHandler = lark.adaptDefault(`${basePath}/card`, cardActionHandler, { autoChallenge: true });

  const eventHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const rawBody = await readRequestBody(req);

    // Challenge requests are encrypted ({"encrypt":"..."}) with no signature headers;
    // the lark SDK's autoChallenge decrypts and validates via encryptKey.
    const hasSig = !!req.headers["x-lark-request-timestamp"]
      && !!req.headers["x-lark-request-nonce"]
      && !!req.headers["x-lark-request-signature"];

    if (!hasSig) {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawEventHandler(reconstructedReq, res);
      return;
    }

    const securityOk = await applySecurityPipeline(req, res, rawBody, config);
    if (!securityOk) return;

    try {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawEventHandler(reconstructedReq, res);
    } finally {
      inFlightLimiter.release("feishu");
    }
  };

  const cardHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const rawBody = await readRequestBody(req);

    const hasSig = !!req.headers["x-lark-request-timestamp"]
      && !!req.headers["x-lark-request-nonce"]
      && !!req.headers["x-lark-request-signature"];

    if (!hasSig) {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawCardHandler(reconstructedReq, res);
      return;
    }

    const securityOk = await applySecurityPipeline(req, res, rawBody, config);
    if (!securityOk) return;

    try {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawCardHandler(reconstructedReq, res);
    } finally {
      inFlightLimiter.release("feishu");
    }
  };

  return { eventHandler, cardHandler };
}

export function createFeishuWebhookHandlersForBot(
  botConfig: OpenmoBotConfig,
  deps: HandlerDeps,
  basePath?: string,
): FeishuWebhookHandlers {
  const config: FeishuHandlerConfig = {
    appId: botConfig.appId,
    appSecret: botConfig.appSecret,
    verificationToken: botConfig.verificationToken,
    encryptKey: botConfig.encryptKey,
    botName: botConfig.botName,
  };

  const resolvedBasePath = basePath ?? `/webhook/feishu/${botConfig.id}`;

  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  }).register({
    "im.message.receive_v1": async (data: unknown) => {
      const event = data as {
        sender?: { sender_id?: { open_id?: string; user_id?: string } };
        message?: {
          chat_id?: string;
          chat_type?: string;
          message_id?: string;
          content?: string;
          thread_id?: string;
        };
      };

      const message = event.message;
      if (!message) return;

      const chatId = message.chat_id ?? "";
      const chatType = message.chat_type === "group" ? "group" : "p2p";
      const messageId = message.message_id ?? "";
      const threadId = message.thread_id;
      const rawContent = message.content ?? "";
      const text = stripMentionAt(parseMessageContent(rawContent));

      if (!text) return;

      const accountId = botConfig.id;

      const conversationRef: ConversationRef = {
        channel: "feishu",
        accountId,
        conversationId: chatId,
        ...(threadId ? { parentConversationId: chatId } : {}),
      };

      const peekedBinding = deps.sessionBinding.peekByConversation(conversationRef);

      if (peekedBinding && deps.sessionBinding.shouldReset(peekedBinding)) {
        const oldSessionId = peekedBinding.omoSessionId;

        if (oldSessionId && !oldSessionId.startsWith("agent:")) {
          try {
            const flushArgs: Record<string, unknown> = {
              message: "请将本次对话中的重要信息、偏好和决策保存到项目的 .openplaw/MEMORY.md 文件中。Please save important information, preferences, and decisions from this conversation to the project's .openplaw/MEMORY.md file.",
            };
            if (deps.project) flushArgs.directory = deps.project;
            flushArgs.session_id = oldSessionId;

            await deps.hubClient.callTool("trigger_agent", flushArgs);

            await new Promise(resolve => setTimeout(resolve, 15_000));
          } catch (err) {
            logger.warn("[feishu-handler] Flush prompt failed", { error: err instanceof Error ? err.message : String(err) });
          }

          if (deps.opencodeClient) {
            try {
              const messagesArgs: Record<string, unknown> = { sessionID: oldSessionId };
              if (deps.project) messagesArgs.directory = deps.project;
              const messagesResult = await deps.opencodeClient.session.messages(messagesArgs as Parameters<typeof deps.opencodeClient.session.messages>[0]);
              if (messagesResult.data) {
                const summaryContent = extractConversationSummary(messagesResult.data, 15);
                if (summaryContent) {
                  const savedPath = await saveSessionSummary({
                    sessionKey: peekedBinding.sessionKey,
                    sessionId: oldSessionId,
                    source: "daily-reset",
                    content: summaryContent,
                  });
                  logger.info("[feishu-handler] Saved session summary", { path: savedPath });
                  const pruneResult = await pruneSessionSummaries(deps.summariesConfig);
                  if (pruneResult.pruned > 0) {
                    logger.info("[feishu-handler] Pruned session summaries", { pruned: pruneResult.pruned, remaining: pruneResult.remaining });
                  }
                }
              }
            } catch (err) {
              logger.warn("[feishu-handler] Failed to save session summary", { error: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        await deps.sessionBinding.archiveCurrentSession(peekedBinding.bindingId);

        if (deps.project) {
          try {
            await ensureProjectOpenplawDir(deps.project);
            await promoteGlobalPreferences(deps.project);
          } catch (err) {
            logger.warn("[feishu-handler] Memory promotion failed", { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      let existingBinding = deps.sessionBinding.resolveByConversation(conversationRef);

      if (existingBinding) {
        await deps.sessionBinding.touch(existingBinding.bindingId);
      } else {
        const peerKind = chatType === "group" ? "group" : "direct";
        const sessionKey = buildAgentPeerSessionKey({
          agentId: botConfig.agent,
          channel: "feishu",
          accountId,
          peerKind,
          peerId: chatId,
          threadId,
        });

        const newBinding = await deps.sessionBinding.bind({
          sessionKey,
          omoSessionId: sessionKey,
          conversation: conversationRef,
        });
        existingBinding = newBinding;

        if (deps.project) {
          try {
            await ensureProjectOpenplawDir(deps.project);
            await promoteGlobalPreferences(deps.project);
          } catch (err) {
            logger.warn("[feishu-handler] Memory promotion on new session failed", { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // /new command — archive current session and start fresh
      if (NEW_SESSION_COMMANDS.test(text.trim())) {
        if (existingBinding.omoSessionId && !existingBinding.omoSessionId.startsWith("agent:")) {
          try {
            const flushArgs: Record<string, unknown> = {
              message: "请将本次对话中的重要信息、偏好和决策保存到项目的 .openplaw/MEMORY.md 文件中。Please save important information, preferences, and decisions from this conversation to the project's .openplaw/MEMORY.md file.",
            };
            if (deps.project) flushArgs.directory = deps.project;
            flushArgs.session_id = existingBinding.omoSessionId;

            await deps.hubClient.callTool("trigger_agent", flushArgs);

            await new Promise(resolve => setTimeout(resolve, 15_000));
          } catch (err) {
            logger.warn("[feishu-handler] Flush prompt on /new failed", { error: err instanceof Error ? err.message : String(err) });
          }

          if (deps.opencodeClient) {
            try {
              const messagesArgs: Record<string, unknown> = { sessionID: existingBinding.omoSessionId };
              if (deps.project) messagesArgs.directory = deps.project;
              const messagesResult = await deps.opencodeClient.session.messages(messagesArgs as Parameters<typeof deps.opencodeClient.session.messages>[0]);
              if (messagesResult.data) {
                const summaryContent = extractConversationSummary(messagesResult.data, 15);
                if (summaryContent) {
                  const savedPath = await saveSessionSummary({
                    sessionKey: existingBinding.sessionKey,
                    sessionId: existingBinding.omoSessionId,
                    source: "/new",
                    content: summaryContent,
                  });
                  logger.info("[feishu-handler] Saved session summary on /new", { path: savedPath });
                  const pruneResult = await pruneSessionSummaries(deps.summariesConfig);
                  if (pruneResult.pruned > 0) {
                    logger.info("[feishu-handler] Pruned session summaries", { pruned: pruneResult.pruned, remaining: pruneResult.remaining });
                  }
                }
              }
            } catch (err) {
              logger.warn("[feishu-handler] Failed to save session summary on /new", { error: err instanceof Error ? err.message : String(err) });
            }
          }

          await deps.sessionBinding.archiveCurrentSession(existingBinding.bindingId);

          if (deps.project) {
            try {
              await ensureProjectOpenplawDir(deps.project);
              await promoteGlobalPreferences(deps.project);
            } catch (err) {
              logger.warn("[feishu-handler] Memory promotion on /new failed", { error: err instanceof Error ? err.message : String(err) });
            }
          }

          existingBinding = deps.sessionBinding.resolveByConversation(conversationRef) ?? existingBinding;
        }
        const larkClient = new lark.Client({ appId: config.appId, appSecret: config.appSecret, appType: lark.AppType.SelfBuild });
        await larkClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "✅ 已开始新话题" }) },
        });
        return;
      }

      let messageText = text;
      if (HISTORY_KEYWORDS.test(text)) {
        try {
          const summaries = await loadRecentSummaries(deps.summariesConfig, text);
          if (summaries) {
            messageText = `[历史上下文]: ${summaries.slice(0, 2000)}\n\n${text}`;
            logger.info("[feishu-handler] Injected past context from stored summaries", { length: summaries.length });
          }
        } catch (err) {
          logger.warn("[feishu-handler] Failed to load session summaries", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      let triggeredSessionId: string | undefined;

      if (deps.opencodeClient) {
        logger.info(`[feishu-handler] Starting trigger+stream for chatId=${chatId}`);
        void triggerAndStreamReply({
          opencodeClient: deps.opencodeClient,
          hubClient: deps.hubClient,
          sessionBinding: deps.sessionBinding,
          bindingId: existingBinding.bindingId,
          currentOmoSessionId: existingBinding.omoSessionId ?? "",
          chatId,
          messageId,
          messageText,
          agentName: botConfig.agent ?? "main",
          directory: deps.project,
          larkCreds: { appId: config.appId, appSecret: config.appSecret },
          feishuHandlerConfig: config,
        }).catch((err: unknown) => {
          logger.error("[feishu-handler] triggerAndStreamReply top-level error", {
            error: err instanceof Error ? err.message : String(err),
            chatId,
          });
        });
      } else {
        try {
          const triggerArgs: Record<string, unknown> = {
            message: messageText,
            agent: botConfig.agent,
          };
          if (deps.project) triggerArgs.directory = deps.project;
          if (existingBinding.omoSessionId && !existingBinding.omoSessionId.startsWith("agent:")) {
            triggerArgs.session_id = existingBinding.omoSessionId;
          }
          await deps.hubClient.callTool("trigger_agent", triggerArgs);
        } catch (err) {
          logger.error("Failed to trigger agent via hub", {
            error: err instanceof Error ? err.message : String(err),
            chatId,
            messageId,
          });
        }
      }
    },
  });

  const cardActionHandler = new lark.CardActionHandler(
    {
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
    },
    async (data: unknown) => {
      await deps.onCardAction?.(data);
      return {};
    },
  );

  const rawEventHandler = lark.adaptDefault(`${resolvedBasePath}/event`, dispatcher, {
    autoChallenge: true,
  });
  const rawCardHandler = lark.adaptDefault(`${resolvedBasePath}/card`, cardActionHandler, { autoChallenge: true });

  const rateLimiterKey = `feishu:${botConfig.id}`;

  const eventHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const rawBody = await readRequestBody(req);

    // Challenge requests are encrypted ({"encrypt":"..."}) with no signature headers;
    // the lark SDK's autoChallenge decrypts and validates via encryptKey.
    const hasSig = !!req.headers["x-lark-request-timestamp"]
      && !!req.headers["x-lark-request-nonce"]
      && !!req.headers["x-lark-request-signature"];

    if (!hasSig) {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawEventHandler(reconstructedReq, res);
      return;
    }

    const securityOk = await applySecurityPipeline(req, res, rawBody, config, rateLimiterKey);
    if (!securityOk) return;

    try {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawEventHandler(reconstructedReq, res);
    } finally {
      inFlightLimiter.release(rateLimiterKey);
    }
  };

  const cardHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const rawBody = await readRequestBody(req);

    const hasSig = !!req.headers["x-lark-request-timestamp"]
      && !!req.headers["x-lark-request-nonce"]
      && !!req.headers["x-lark-request-signature"];

    if (!hasSig) {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawCardHandler(reconstructedReq, res);
      return;
    }

    const securityOk = await applySecurityPipeline(req, res, rawBody, config, rateLimiterKey);
    if (!securityOk) return;

    try {
      const reconstructedReq = reconstructRequest(req, rawBody);
      await rawCardHandler(reconstructedReq, res);
    } finally {
      inFlightLimiter.release(rateLimiterKey);
    }
  };

  return { eventHandler, cardHandler };
}
