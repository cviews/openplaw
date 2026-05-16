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
const REPLY_TIMEOUT_MS = 3_600_000;
const CARD_CONTENT_TRUNCATE_THRESHOLD = 8_000;
const CARD_CONTENT_LIMIT = 25_000;
const FOLLOW_UP_CHUNK_SIZE = 4_000;

const activeStreamingSessions = new Map<string, FeishuStreamingSession>();

async function closeActiveStreamingSession(chatId: string): Promise<void> {
  const existing = activeStreamingSessions.get(chatId);
  if (existing && existing.isActive()) {
    logger.info(`[feishu-streaming] Closing previous streaming session for chatId=${chatId} (new message arrived)`);
    try {
      await existing.close(undefined, { note: "⏳ 新消息已到达，此任务暂停显示" });
    } catch {
      // best-effort close
    }
    activeStreamingSessions.delete(chatId);
  }
}

// ─── Phase Tracker ────────────────────────────────────────────────────

type AgentPhase = {
  name: string;
  startTime: number;
};

class PhaseTracker {
  private pendingAgents = new Map<string, AgentPhase>();
  private completedAgents = new Set<string>();
  private failedAgents = new Map<string, string>();
  private totalDelegations = 0;

  addPending(agentName: string): void {
    if (!this.completedAgents.has(agentName) && !this.pendingAgents.has(agentName)) {
      this.pendingAgents.set(agentName, { name: agentName, startTime: Date.now() });
      this.totalDelegations++;
    }
  }

  markCompleted(agentName: string): void {
    this.pendingAgents.delete(agentName);
    this.completedAgents.add(agentName);
  }

  markFailed(agentName: string, error: string): void {
    this.pendingAgents.delete(agentName);
    this.failedAgents.set(agentName, error);
  }

  isDelegating(): boolean {
    return this.pendingAgents.size > 0;
  }

  allDone(): boolean {
    return this.pendingAgents.size === 0 && this.totalDelegations > 0;
  }

  getTotal(): number {
    return this.totalDelegations;
  }

  getCompletedCount(): number {
    return this.completedAgents.size;
  }

  getPendingNames(): string[] {
    return [...this.pendingAgents.values()].map((a) => a.name);
  }

  getElapsedMsForFirstPending(): number {
    const first = this.pendingAgents.values().next().value;
    return first ? Date.now() - first.startTime : 0;
  }

  buildNote(): string {
    if (this.totalDelegations === 0) return "";

    const parts: string[] = [];
    const completedCount = this.completedAgents.size;
    const total = this.totalDelegations;

    if (this.pendingAgents.size > 0) {
      const pendingNames = this.getPendingNames();
      const elapsed = this.getElapsedMsForFirstPending();
      let pendingLabel = `🔍 ${pendingNames.join(", ")} 正在执行`;
      if (elapsed > 60_000) {
        const minutes = Math.round(elapsed / 60_000);
        pendingLabel += ` (已等${minutes}分钟)`;
      }
      parts.push(pendingLabel);
    }

    if (this.completedAgents.size > 0) {
      parts.push(`✅ ${completedCount}/${total} 完成`);
    }

    if (this.failedAgents.size > 0) {
      const failedNames = [...this.failedAgents.keys()];
      parts.push(`❌ ${failedNames.join(", ")} 失败`);
    }

    return parts.join(" · ");
  }

  buildFinalNote(): string {
    if (this.totalDelegations === 0) return "✅ 完成";
    const total = this.totalDelegations;
    const completed = this.completedAgents.size;
    const failed = this.failedAgents.size;

    if (failed > 0) {
      return `⚠️ 完成 (${completed}/${total} 成功, ${failed} 失败)`;
    }
    return `✅ 完成 (${completed}/${total} 子任务)`;
  }
}

// ─── Content Display Strategy ────────────────────────────────────────

type DisplayStrategy =
  | { type: "full"; cardContent: string }
  | { type: "truncate"; cardContent: string; followUp: string }
  | { type: "summary"; cardContent: string; followUp: string };

function extractSummaryFromLongContent(content: string): string {
  const lines = content.split("\n");
  const summaryLines: string[] = [];
  let inCodeBlock = false;
  let codeBlockCount = 0;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        codeBlockCount++;
        summaryLines.push(line);
        summaryLines.push(`... (代码改动详情见下方消息)`);
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock) {
      summaryLines.push(line);
    }
  }

  const summary = summaryLines.join("\n");
  if (summary.length > CARD_CONTENT_TRUNCATE_THRESHOLD) {
    return summary.slice(0, CARD_CONTENT_TRUNCATE_THRESHOLD) + "\n\n...";
  }
  return summary;
}

function chooseDisplayStrategy(finalText: string): DisplayStrategy {
  if (finalText.length <= CARD_CONTENT_TRUNCATE_THRESHOLD) {
    return { type: "full", cardContent: finalText };
  }

  if (finalText.length <= CARD_CONTENT_LIMIT) {
    const cardContent =
      finalText.slice(0, CARD_CONTENT_TRUNCATE_THRESHOLD) +
      "\n\n---\n💡 **内容过长，完整改动结果见下方消息**";
    return { type: "truncate", cardContent, followUp: finalText };
  }

  const summary = extractSummaryFromLongContent(finalText);
  const cardContent =
    summary + "\n\n---\n💡 **完整代码改动见下方消息**";
  return { type: "summary", cardContent, followUp: finalText };
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

async function sendFollowUpMessage(
  larkClient: lark.Client,
  chatId: string,
  fullContent: string,
): Promise<void> {
  if (fullContent.length <= FOLLOW_UP_CHUNK_SIZE) {
    const data: {
      receive_id: string;
      msg_type: string;
      content: string;
      disable_robot_notification?: boolean;
    } = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: `📋 完整结果：\n${fullContent}` }),
      disable_robot_notification: true,
    };
    await larkClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data,
    });
    return;
  }

  const chunks = splitIntoChunks(fullContent, FOLLOW_UP_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    const prefix =
      i === 0
        ? `📋 完整结果 (${chunks.length} 条消息)：\n`
        : `📋 续 (${i + 1}/${chunks.length})：\n`;
    const data: {
      receive_id: string;
      msg_type: string;
      content: string;
      disable_robot_notification?: boolean;
    } = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: `${prefix}${chunks[i]}` }),
      disable_robot_notification: true,
    };
    await larkClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data,
    });
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// ─── Subtask / Tool Part Detection ───────────────────────────────────

function handleToolPartUpdate(part: { tool?: string; state?: { status?: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; error?: string; title?: string } }, phase: PhaseTracker): void {
  const toolName = part.tool;
  const isDelegationTool =
    toolName === "route_to_bot" || toolName === "call_omo_agent" || toolName === "task";
  if (!isDelegationTool || !part.state) return;

  const state = part.state;
  const status = state.status;

  const target =
    state.metadata?.target ?? (state.input as Record<string, unknown>)?.subagent_type ?? (state.input as Record<string, unknown>)?.target ?? null;
  const titleMatch = (state.title ?? "").match(/委派\s*(\S+)\s*处理/);
  const agentName = String(target ?? titleMatch?.[1] ?? "unknown");

  if (status === "running") phase.addPending(agentName);
  if (status === "completed") phase.markCompleted(agentName);
  if (status === "error") phase.markFailed(agentName, state.error ?? "unknown error");
}

function extractLastAssistantText(messages: any[]): string {  const assistantMsgs = messages.filter(
    (msg: any) => msg.info?.role === "assistant",
  );
  const lastMsg = assistantMsgs.at(-1);
  if (!lastMsg) return "";
  const parts: string[] = [];
  for (const part of lastMsg.parts ?? []) {
    if (part.type === "text") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

type ErrorCategory = "quota" | "rate_limit" | "auth" | "network" | "context_overflow" | "output_length" | "aborted" | "unknown";

function classifyErrorCategory(errorName: string, errorMsg: string, statusCode?: number): ErrorCategory {
  const msg = errorMsg.toLowerCase();
  const name = errorName.toLowerCase();

  if (/quota|exceeded|usage|capacity|weekly|monthly/i.test(msg)) return "quota";
  if (/rate.?limit|429|too.?many.?request|throttl|qps|rps|request.?per/i.test(msg) || statusCode === 429) return "rate_limit";
  if (/auth|unauthorized|401|403|invalid.?key|forbidden|ProviderAuthError/i.test(msg) || name === "providerautherror" || statusCode === 401 || statusCode === 403) return "auth";
  if (/context.?overflow|too.?long|context.?length/i.test(msg) || name === "contextoverflowerror") return "context_overflow";
  if (/output.?length|max.?output|too.?many.?tokens.?output/i.test(msg) || name === "messageoutputlengtherror") return "output_length";
  if (/aborted|cancelled|cancel/i.test(msg) || name === "messageabortederror") return "aborted";
  if (/fetch|network|ECONN|timeout|abort|SSE|disconnect|DNS|socket/i.test(msg)) return "network";

  return "unknown";
}

function classifyErrorForUser(errorName: string, errorMsg: string, statusCode?: number): string {
  const category = classifyErrorCategory(errorName, errorMsg, statusCode);
  switch (category) {
    case "quota":
      return `⚠️ 模型额度已用尽\n\n${errorMsg}`;
    case "rate_limit":
      return `⚠️ 请求频率过高 (QPS限流)\n\n${errorMsg}`;
    case "auth":
      return `❌ 认证失败\n\n${errorMsg}`;
    case "network":
      return `🌐 网络连接异常\n\n${errorMsg}`;
    case "context_overflow":
      return `⚠️ 上下文过长溢出\n\n${errorMsg}`;
    case "output_length":
      return `⚠️ 输出超过长度限制\n\n${errorMsg}`;
    case "aborted":
      return `⏠️ 请求被中断\n\n${errorMsg}`;
    default:
      return `❌ 请求出错\n\n${errorMsg}`;
  }
}

// ─── Enhanced streamAgentReply ────────────────────────────────────────

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

  await closeActiveStreamingSession(chatId);

  const phase = new PhaseTracker();
  const startTime = Date.now();

  try {
    await streaming.start(chatId, "chat_id", {
      replyToMessageId: messageId,
    });

    activeStreamingSessions.set(chatId, streaming);

    let accumulatedText = "";
    let lastNote = "";
    let sessionIdle = false;

    let sseProducedText = false;

    const sseStart = Date.now();
    const eventResult = await opencodeClient.global.event({
      onSseError: (error) => {
        logger.warn(`[feishu-streaming] SSE connection error (SDK auto-reconnects): ${String(error)}`);
      },
      sseMaxRetryAttempts: 15,
      sseDefaultRetryDelay: 3000,
      sseMaxRetryDelay: 30000,
    });
    logger.info(`[feishu-streaming] SSE subscription started`);

    let receivedTextDelta = false;
    let sessionDone = false;
    let lastError: string | null = null;

    try {
      for await (const globalEvent of eventResult.stream) {
        if (Date.now() - sseStart > REPLY_TIMEOUT_MS) {
          logger.warn(`[feishu-streaming] Session deadline exceeded (${REPLY_TIMEOUT_MS}ms), closing SSE`);
          sessionDone = true;
          break;
        }
        if (sessionDone) break;

        const event = globalEvent as { directory?: string; payload: Record<string, unknown> };
        const payload = event.payload;
        // SDK v2 events have nested structure: { id, type, properties: { sessionID, delta, ... } }
        // but older/opencode-server events may use flat structure: { type, sessionID, delta, ... }
        // Support both by extracting from properties first, then fallback to flat level
        const props = (payload.properties as Record<string, unknown> | undefined) ?? {};
        const payloadType = (payload.type as string) ?? (props.type as string);
        const payloadSessionId = (props.sessionID as string | undefined) ?? (payload.sessionID as string | undefined);
        logger.debug(`[feishu-streaming] SSE raw event: type=${payloadType ?? 'unknown'}, sessionID=${payloadSessionId ?? 'none'}, keys=${Object.keys(payload).join(',')}, elapsed=${Date.now() - sseStart}ms`);
        if (directory && event.directory !== directory) continue;

        switch (payloadType) {
          case "server.connected": {
            logger.info(`[feishu-streaming] SSE connected to event stream`);
            break;
          }

          case "server.heartbeat": {
            logger.debug(`[feishu-streaming] SSE heartbeat received`);
            break;
          }

          case "session.next.text.delta": {
            if (payloadSessionId === sessionId) {
              const delta = (props.delta as string) ?? (payload.delta as string) ?? "";
              accumulatedText += delta;
              receivedTextDelta = true;
              sseProducedText = true;
              await streaming.update(accumulatedText);
              logger.info(`[feishu-streaming] SSE text delta: +${delta.length} chars (total: ${accumulatedText.length})`);
            }
            break;
          }

          case "message.part.delta": {
            if (payloadSessionId === sessionId) {
              const delta = (props.delta as string) ?? (payload.delta as string) ?? "";
              if (delta) {
                accumulatedText += delta;
                receivedTextDelta = true;
                sseProducedText = true;
                await streaming.update(accumulatedText);
                logger.info(`[feishu-streaming] SSE message.part.delta: +${delta.length} chars (total: ${accumulatedText.length})`);
              }
            }
            break;
          }

          case "message.part.updated": {
            if (payloadSessionId !== sessionId) break;

            const part = (props.part as Record<string, unknown>) ?? (payload.part as Record<string, unknown>);

            if (part.type === "text" && !receivedTextDelta) {
              const newText = part.text as string;
              if (newText && newText !== accumulatedText) {
                accumulatedText = newText;
                sseProducedText = true;
                await streaming.update(accumulatedText);
              }
            }

            if (part.type === "tool") {
              handleToolPartUpdate(part as { tool?: string; state?: { status?: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; error?: string; title?: string } }, phase);
              const newNote = phase.buildNote();
              if (newNote !== lastNote) {
                lastNote = newNote;
                if (newNote) await streaming.updateNoteContent(newNote);
                logger.info(`[feishu-streaming] SSE note updated: ${newNote}`);
              }
            }

            if (part.type === "subtask" && part.agent) {
              phase.addPending(String(part.agent));
            }
            break;
          }

          case "session.next.text.ended": {
            if (payloadSessionId === sessionId) {
              const text = (props.text as string) ?? (payload.text as string) ?? "";
              accumulatedText = text;
              receivedTextDelta = true;
              sseProducedText = true;
              await streaming.update(accumulatedText);
              logger.info(`[feishu-streaming] SSE text generation ended: ${accumulatedText.length} chars`);
            }
            break;
          }

          case "message.updated": {
            if (payloadSessionId === sessionId) {
              const info = (props.info as Record<string, unknown>) ?? (payload.info as Record<string, unknown>);
              if (info?.role === "assistant" && !receivedTextDelta) {
                const parts = (info.parts as Array<Record<string, unknown>>) ?? [];
                for (const p of parts) {
                  if (p.type === "text" && p.text) {
                    const newText = p.text as string;
                    if (newText && newText !== accumulatedText) {
                      accumulatedText = newText;
                      sseProducedText = true;
                      await streaming.update(accumulatedText);
                      logger.info(`[feishu-streaming] SSE message.updated text: ${accumulatedText.length} chars`);
                    }
                    break;
                  }
                }
              }
            }
            break;
          }

          case "session.idle": {
            if (payloadSessionId === sessionId) {
              logger.info(`[feishu-streaming] SSE session idle, closing: sessionId=${sessionId}`);
              sessionDone = true;
              sessionIdle = true;
            }
            break;
          }

          case "session.status": {
            if (payloadSessionId === sessionId) {
              const status = (props.status as { type: string; attempt?: number; message?: string; action?: { reason?: string; provider?: string; title?: string; message?: string; label?: string; link?: string }; next?: number }) ?? (payload.status as { type: string; attempt?: number; message?: string });
              if (status.type === "retry") {
                lastError = status.message ?? lastError;
                const actionInfo = status.action;
                const userMsg = classifyErrorForUser("", lastError ?? "unknown");
                await streaming.update(`${userMsg}\n\n🔄 自动重试中 (attempt ${status.attempt ?? "?"})`);
                if (actionInfo?.link) {
                  await streaming.updateNoteContent(`[${actionInfo.label ?? "查看详情"}](${actionInfo.link})`);
                }
                logger.info(`[feishu-streaming] SSE session retry: attempt=${status.attempt ?? "?"}, message=${lastError ?? "unknown"}, action=${actionInfo ? JSON.stringify(actionInfo) : "none"}`);
              }
            }
            break;
          }

          case "session.error": {
            if (payloadSessionId === sessionId) {
              const error = (props.error as Record<string, unknown> | undefined) ?? (payload.error as Record<string, unknown> | undefined);
              if (error) {
                const errorName = (error.name as string) ?? "UnknownError";
                const errorData = (error.data as Record<string, unknown>) ?? {};
                const errorMsg = (errorData.message as string) ?? (error.message as string) ?? String(error);
                const statusCode = (errorData.statusCode as number) ?? (errorData.status as number);
                lastError = errorMsg;
                const userMsg = classifyErrorForUser(errorName, errorMsg, statusCode);
                await streaming.update(userMsg);
                logger.warn(`[feishu-streaming] SSE session error: ${errorName} - ${errorMsg}`);
              }
            }
            break;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConnectionError = /fetch|network|ECONN|SSE|abort|timeout/i.test(errMsg);
      if (isConnectionError) {
        logger.warn(`[feishu-streaming] SSE connection exhausted (SDK retries failed): ${errMsg}, falling back to polling`);
        if (!sseProducedText) {
          await streaming.update(`🌐 SSE连接中断，正在切换到轮询模式获取结果...\n\n${errMsg}`);
        }
      } else {
        logger.warn(`[feishu-streaming] SSE stream error: ${errMsg}, falling back to polling`);
      }
    }

    if (!sseProducedText && !sessionIdle) {
      logger.info(`[feishu-streaming] SSE did not produce content, falling back to polling for session ${sessionId}`);

      const POLL_FAST_MS = 300;
      const POLL_SLOW_MS = 1_500;
      const POLL_DELEGATING_MS = 3_000;
      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      let lastText = "";

      while (Date.now() < deadline) {
        let isRetry = false;
        try {
          const statusArgs: Record<string, unknown> = {};
          if (directory) statusArgs.directory = directory;
          const statusResult = await opencodeClient.session.status(statusArgs as any);
          if (statusResult.data) {
            const sessionStatus = statusResult.data[sessionId] as { type: string; attempt?: number; message?: string; action?: { reason?: string; provider?: string; title?: string; message?: string; label?: string; link?: string }; next?: number } | undefined;
            if (sessionStatus?.type === "idle") {
              if (phase.getTotal() > 0 && phase.allDone()) {
                logger.info(`[feishu-streaming] Polling: session idle + all subtasks done`);
                break;
              }
              if (phase.getTotal() === 0 && lastText) {
                logger.info(`[feishu-streaming] Polling: session idle + content present`);
                break;
              }
            }
            if (sessionStatus?.type === "retry") {
              isRetry = true;
              lastError = sessionStatus.message ?? lastError;
              const userMsg = classifyErrorForUser("", lastError ?? "unknown");
              await streaming.update(`${userMsg}\n\n🔄 自动重试中 (attempt ${sessionStatus.attempt ?? "?"})`);
              const actionInfo = sessionStatus.action;
              if (actionInfo?.link) {
                await streaming.updateNoteContent(`[${actionInfo.label ?? "查看详情"}](${actionInfo.link})`);
              }
            }
          }
        } catch (err) {
          logger.debug(`[feishu-streaming] Polling status error: ${err instanceof Error ? err.message : String(err)}`);
        }

        let currentMessages: any[] = [];
        try {
          const messagesArgs: Record<string, unknown> = { sessionID: sessionId };
          if (directory) messagesArgs.directory = directory;
          const messagesResult = await opencodeClient.session.messages(messagesArgs as any);
          if (messagesResult.data) {
            currentMessages = messagesResult.data as any[];
          }
        } catch (err) {
          logger.debug(`[feishu-streaming] Polling messages error: ${err instanceof Error ? err.message : String(err)}`);
        }

        for (const msg of currentMessages) {
          if (msg.info?.role !== "assistant") continue;
          for (const part of msg.parts ?? []) {
            if (part.type === "subtask") {
              phase.addPending(part.agent ?? "unknown");
            }
            if (part.type === "tool") {
              handleToolPartUpdate(part, phase);
            }
          }
        }

        const newNote = phase.buildNote();
        if (newNote !== lastNote) {
          lastNote = newNote;
          if (newNote) await streaming.updateNoteContent(newNote);
        }

        const currentText = extractLastAssistantText(currentMessages);
        if (currentText && currentText !== lastText) {
          lastText = currentText;
          accumulatedText = currentText;
          await streaming.update(currentText);
          logger.info(`[feishu-streaming] Polling updated card (${currentText.length} chars)`);
        }

        const interval = isRetry ? POLL_DELEGATING_MS
          : phase.isDelegating() ? POLL_DELEGATING_MS
          : currentText && currentText !== lastText ? POLL_FAST_MS
          : POLL_SLOW_MS;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      accumulatedText = accumulatedText || lastText;
    }

    if (!accumulatedText) {
      logger.warn(`[feishu-streaming] No content received for session ${sessionId}`);
    }

    // ── Choose display strategy & close ────────────────────────────────
    const finalNote = phase.buildFinalNote();
    const displayResult = accumulatedText ? chooseDisplayStrategy(accumulatedText) : null;

    if (displayResult) {
      await streaming.close(displayResult.cardContent, { note: finalNote });
      activeStreamingSessions.delete(chatId);
      if (displayResult.type !== "full" && displayResult.followUp) {
        await sendFollowUpMessage(larkClient, chatId, displayResult.followUp);
      }
    } else {
      if (lastError) {
        const userMsg = classifyErrorForUser("", lastError);
        await streaming.close(userMsg, { note: "❌ 执行失败" });
      } else {
        const elapsed = Math.round((Date.now() - startTime) / 60_000);
        await streaming.close(
          `⚠️ 执行超时 (已运行${elapsed}分钟)，Agent仍在后台继续。请稍后再问一次获取结果。`,
          { note: "⚠️ 超时" },
        );
      }
      activeStreamingSessions.delete(chatId);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("[feishu-streaming] Error in streaming reply", { error: errMsg, sessionId, chatId });
    activeStreamingSessions.delete(chatId);
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
