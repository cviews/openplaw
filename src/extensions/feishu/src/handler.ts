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
const CARD_RELAY_THRESHOLD = 4_000;

type ActiveStreamingEntry = {
  session: FeishuStreamingSession;
  sessionId: string;
  opencodeClient: OpencodeClient;
  directory?: string;
};

const activeStreamingSessions = new Map<string, ActiveStreamingEntry>();

async function abortAndSendNewMessage(
  chatId: string,
  message: string,
  agentName?: string,
): Promise<boolean> {
  const existing = activeStreamingSessions.get(chatId);
  if (!existing) return false;

  logger.info(`[feishu-streaming] Sending new message to session ${existing.sessionId} for chatId=${chatId} (will queue), then aborting current execution`);

  // 1. Queue the new message first (opencode queues it while current execution is running)
  try {
    const promptArgs: Record<string, unknown> = {
      path: { id: existing.sessionId },
      body: {
        parts: [{ type: "text", text: message }],
        ...(agentName ? { agent: agentName } : {}),
      },
    };
    if (existing.directory) promptArgs.query = { directory: existing.directory };
    await existing.opencodeClient.session.promptAsync(promptArgs as any);
    logger.info(`[feishu-streaming] New message queued in session ${existing.sessionId}`);
  } catch (e) {
    logger.error(`[feishu-streaming] Failed to queue new message in session ${existing.sessionId}: ${String(e)}`);
    return false;
  }

  // 2. Abort current execution (equivalent to ESC in TUI) — queued message starts immediately
  try {
    const abortArgs: Record<string, unknown> = { path: { id: existing.sessionId } };
    if (existing.directory) abortArgs.query = { directory: existing.directory };
    await existing.opencodeClient.session.abort(abortArgs as any);
    logger.info(`[feishu-streaming] Session ${existing.sessionId} aborted, queued message will start immediately`);
  } catch (e) {
    logger.warn(`[feishu-streaming] Session abort failed: ${String(e)}, queued message may wait for current execution to finish`);
  }

  return true;
}

// ─── Phase Tracker ────────────────────────────────────────────────────

type AgentPhase = {
  name: string;
  startTime: number;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
};

class PhaseTracker {
  private agents = new Map<string, AgentPhase>();
  private nextId = 0;

  addPending(agentName: string): string {
    const id = `${agentName}_${this.nextId++}`;
    this.agents.set(id, { name: agentName, startTime: Date.now(), status: "running" });
    return id;
  }

  addAsQueued(agentName: string): string {
    const id = `${agentName}_${this.nextId++}`;
    this.agents.set(id, { name: agentName, startTime: Date.now(), status: "pending" });
    return id;
  }

  markCompleted(id: string): void {
    const phase = this.agents.get(id);
    if (phase) phase.status = "completed";
  }

  markCompletedByName(agentName: string): void {
    for (const [id, phase] of this.agents) {
      if (phase.name === agentName && phase.status !== "completed" && phase.status !== "failed") {
        phase.status = "completed";
        return;
      }
    }
  }

  markFailed(id: string, error: string): void {
    const phase = this.agents.get(id);
    if (phase) { phase.status = "failed"; phase.error = error; }
  }

  markFailedByName(agentName: string, error: string): void {
    for (const [id, phase] of this.agents) {
      if (phase.name === agentName && phase.status !== "completed" && phase.status !== "failed") {
        phase.status = "failed"; phase.error = error;
        return;
      }
    }
  }

  markRunningByName(agentName: string): void {
    for (const [, phase] of this.agents) {
      if (phase.name === agentName && phase.status === "pending") {
        phase.status = "running";
        return;
      }
    }
  }

  isDelegating(): boolean {
    for (const [, phase] of this.agents) {
      if (phase.status === "pending" || phase.status === "running") return true;
    }
    return false;
  }

  hasPendingWithName(agentName: string): boolean {
    for (const [, phase] of this.agents) {
      if (phase.name === agentName && (phase.status === "pending" || phase.status === "running")) return true;
    }
    return false;
  }

  allDone(): boolean {
    if (this.agents.size === 0) return false;
    for (const [, phase] of this.agents) {
      if (phase.status === "pending" || phase.status === "running") return false;
    }
    return true;
  }

  getTotal(): number {
    return this.agents.size;
  }

  getCompletedCount(): number {
    let count = 0;
    for (const [, phase] of this.agents) { if (phase.status === "completed") count++; }
    return count;
  }

  getPendingNames(): string[] {
    const names: string[] = [];
    for (const [, phase] of this.agents) {
      if (phase.status === "pending" || phase.status === "running") names.push(phase.name);
    }
    return names;
  }

  getElapsedMsForFirstPending(): number {
    for (const [, phase] of this.agents) {
      if (phase.status === "pending" || phase.status === "running") return Date.now() - phase.startTime;
    }
    return 0;
  }

  buildNote(): string {
    if (this.agents.size === 0) return "";

    const queued: string[] = [];
    const running: string[] = [];
    const completed: string[] = [];
    const failed: string[] = [];

    for (const [, phase] of this.agents) {
      switch (phase.status) {
        case "pending": queued.push(phase.name); break;
        case "running": running.push(phase.name); break;
        case "completed": completed.push(phase.name); break;
        case "failed": failed.push(phase.name); break;
      }
    }

    const lines: string[] = ["📋 子任务进展"];

    if (running.length > 0) {
      lines.push(`🔄 执行中(${running.length}): ${running.join("、")}`);
    }
    if (queued.length > 0) {
      lines.push(`⏳ 待执行(${queued.length}): ${queued.join("、")}`);
    }
    if (completed.length > 0) {
      lines.push(`✅ 已完成(${completed.length}): ${completed.join("、")}`);
    }
    if (failed.length > 0) {
      lines.push(`❌ 失败(${failed.length}): ${failed.join("、")}`);
    }

    if (this.isDelegating()) {
      const elapsed = this.getElapsedMsForFirstPending();
      if (elapsed > 60_000) {
        lines.push(`⏱ 已等${formatElapsed(elapsed)}`);
      }
    }

    return lines.join("\n");
  }

  buildFinalNote(): string {
    if (this.agents.size === 0) return "✅ 完成";
    const completed = this.getCompletedCount();
    const failed = this.failedCount();
    const total = this.agents.size;

    if (failed > 0) {
      return `⚠️ 完成 (${completed}个成功/${total}个, ${failed}个失败)`;
    }
    return `✅ 完成 (${completed}个子任务)`;
  }

  private failedCount(): number {
    let count = 0;
    for (const [, phase] of this.agents) { if (phase.status === "failed") count++; }
    return count;
  }
}

// ─── Thinking Tracker ──────────────────────────────────────────────────

const THINKING_TOOL_EMOJI: Record<string, string> = {
  read: "📖", grep: "🔍", bash: "⚡", edit: "✏️", write: "📝",
  glob: "📂", ast_grep_search: "🔍", ast_grep_replace: "✏️",
  lsp_diagnostics: "🔍", lsp_goto_definition: "🔍", lsp_find_references: "🔍",
};

class ThinkingTracker {
  private active: Array<{ tool: string; label: string; id: number }> = [];
  private counts = new Map<string, number>();
  private nextId = 0;

  start(tool: string, label?: string): number {
    const id = this.nextId++;
    this.active.push({ tool, label: label ?? this.fallbackLabel(tool), id });
    return id;
  }

  completeById(id: number): void {
    const entry = this.active.find((a) => a.id === id);
    if (entry) {
      this.active = this.active.filter((a) => a.id !== id);
      this.counts.set(entry.tool, (this.counts.get(entry.tool) ?? 0) + 1);
    }
  }

  completeAllByName(tool: string): void {
    const entries = this.active.filter((a) => a.tool === tool);
    for (const entry of entries) {
      this.counts.set(entry.tool, (this.counts.get(entry.tool) ?? 0) + 1);
    }
    this.active = this.active.filter((a) => a.tool !== tool);
  }

  failById(id: number): void {
    this.active = this.active.filter((a) => a.id !== id);
  }

  buildDisplay(): string {
    if (this.active.length === 0 && this.counts.size === 0) return "";

    const lines: string[] = [];

    const recent = this.active.slice(-2);
    for (const entry of recent) {
      const emoji = THINKING_TOOL_EMOJI[entry.tool.toLowerCase()] ?? THINKING_TOOL_EMOJI[entry.tool] ?? "🔧";
      lines.push(`${emoji} ${entry.label}`);
    }

    const summary = this.buildSummary();
    if (summary) lines.push(summary);

    return lines.join("\n");
  }

  private buildSummary(): string {
    const items: string[] = [];
    let reads = 0, searches = 0, commands = 0, edits = 0, writes = 0, others = 0;
    for (const [tool, count] of this.counts) {
      const lower = tool.toLowerCase();
      if (lower === "read") reads += count;
      else if (lower.includes("grep") || lower.includes("search") || lower === "glob" || lower === "lsp_diagnostics" || lower === "lsp_goto_definition" || lower === "lsp_find_references") searches += count;
      else if (lower === "bash") commands += count;
      else if (lower === "edit" || lower === "ast_grep_replace") edits += count;
      else if (lower === "write") writes += count;
      else if (lower !== "task" && lower !== "route_to_bot" && lower !== "call_omo_agent") others += count;
    }
    if (reads > 0) items.push(`📖${reads}文件`);
    if (searches > 0) items.push(`🔍${searches}搜索`);
    if (commands > 0) items.push(`⚡${commands}命令`);
    if (edits > 0) items.push(`✏️${edits}编辑`);
    if (writes > 0) items.push(`📝${writes}写入`);
    if (others > 0) items.push(`🔧${others}操作`);
    return items.length > 0 ? `已探索: ${items.join(" · ")}` : "";
  }

  private fallbackLabel(tool: string): string {
    const lower = tool.toLowerCase();
    if (lower === "read") return "正在阅读文件";
    if (lower.includes("grep") || lower.includes("search")) return "正在搜索";
    if (lower === "bash") return "正在执行命令";
    if (lower === "edit" || lower === "ast_grep_replace") return "正在编辑文件";
    if (lower === "write") return "正在写入文件";
    if (lower === "glob") return "正在查找文件";
    if (lower === "lsp_diagnostics") return "正在检查错误";
    if (lower === "lsp_goto_definition") return "正在追踪定义";
    if (lower === "lsp_find_references") return "正在查找引用";
    return `正在使用 ${tool}`;
  }
}

// ─── Content Display Strategy ────────────────────────────────────────

// ─── Subtask / Tool Part Detection ───────────────────────────────────

function handleToolPartUpdate(
  part: { tool?: string; state?: { status?: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; error?: string; title?: string }; metadata?: Record<string, unknown> },
  phase: PhaseTracker,
): void {
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

  const partMetadata = part.metadata ?? {};
  const stateMetadata = state.metadata ?? {};
  const stateInput = (state.input as Record<string, unknown>) ?? {};
  const isBackground =
    (partMetadata.background as boolean | undefined) ?? (stateMetadata.background as boolean | undefined) ?? (stateInput.background as boolean | undefined) ?? false;

  if (status === "running") phase.addPending(agentName);

  if (status === "completed") {
    if (isBackground) {
      // Background task: tool call completed, but child agent still running.
      // Keep as pending so isDelegating()=true prevents premature close.
      if (!phase.hasPendingWithName(agentName)) {
        phase.addPending(agentName);
      }
      logger.info(`[feishu-streaming] Background delegation ${toolName} completed, keeping ${agentName} as running (child agent still active)`);
    } else {
      // Foreground task or delegation without background flag (route_to_bot, call_omo_agent):
      // tool call completed means child work is done.
      phase.markCompletedByName(agentName);
      logger.info(`[feishu-streaming] Foreground delegation ${toolName} completed, marking ${agentName} as done`);
    }
  }
  if (status === "error") phase.markFailedByName(agentName, state.error ?? "unknown error");
}

function extractLastAssistantText(messages: any[]): string {  const assistantMsgs = messages.filter(
    (msg: any) => {
      if (msg.info?.role !== "assistant") return false;
      const agent = (msg.info?.agent ?? msg.agent ?? "") as string;
      if (agent.trim().toLowerCase() === "compaction") return false;
      const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
      if (parts.some((p) => p.type === "compaction")) return false;
      return true;
    },
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

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
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

  let streaming = new FeishuStreamingSession(larkClient, creds, (msg) =>
    logger.info(`[feishu-streaming] ${msg}`),
  );

  let phase = new PhaseTracker();
  let thinking = new ThinkingTracker();
  const startTime = Date.now();

  try {
    await streaming.warmTokenCache();

    logger.info(`[feishu-streaming] Calling streaming.start for chatId=${chatId}`);
    await streaming.start(chatId, "chat_id", {
      replyToMessageId: messageId,
    });
    logger.info(`[feishu-streaming] streaming.start succeeded for chatId=${chatId}`);

    activeStreamingSessions.set(chatId, { session: streaming, sessionId, opencodeClient, directory });

    let accumulatedText = "";
    let lastNote = "";
    let lastThinkingDisplay = "";
    let sessionIdle = false;

    let sseProducedText = false;
    let relayIndex = 0;

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
    let isCompacting = false;
    let compactReason: "auto" | "manual" = "auto";

    const STREAMING_KEEPALIVE_INTERVAL_MS = 9 * 60 * 1000;
    let lastKeepAliveMs = sseStart;
    let cardTimedOut = false;

    async function ensureActiveStreamingCard(): Promise<boolean> {
      if (!cardTimedOut && !streaming.isCardTimedOut()) return true;

      logger.warn(`[feishu-streaming] Card timed out, creating new streaming card for chatId=${chatId}`);

      const oldText = accumulatedText;
      const newStreaming = new FeishuStreamingSession(larkClient, creds, (msg) =>
        logger.info(`[feishu-streaming] ${msg}`),
      );

      try {
        await newStreaming.warmTokenCache();
        await newStreaming.start(chatId, "chat_id", {
          replyToMessageId: messageId,
        });

        const statusContent = oldText
          ? `${oldText}\n\n---\n⏳ 继续等待子任务完成...`
          : "⏳ 子任务仍在执行，完成后会继续更新";
        newStreaming.replaceContent(statusContent);

        activeStreamingSessions.set(chatId, { session: newStreaming, sessionId, opencodeClient, directory });
        streaming = newStreaming;

        cardTimedOut = false;
        lastKeepAliveMs = Date.now();
        lastThinkingDisplay = "";
        lastLoadingContent = "";

        logger.info(`[feishu-streaming] New streaming card created after timeout`);
        return true;
      } catch (e) {
        logger.error(`[feishu-streaming] Failed to create new streaming card: ${String(e)}`);
        return false;
      }
    }

    async function relayStreamingCard(): Promise<boolean> {
      relayIndex++;
      logger.info(`[feishu-streaming] Content approaching limit (${accumulatedText.length} chars), relaying to new card (part ${relayIndex + 1})`);

      try {
        await streaming.close(`📋 第${relayIndex}部分已完成，见下条消息继续`, { note: "内容过长，自动分片显示" });
      } catch (e) {
        logger.warn(`[feishu-streaming] Close old card during relay failed: ${String(e)}`);
      }

      const newStreaming = new FeishuStreamingSession(larkClient, creds, (msg) =>
        logger.info(`[feishu-streaming] ${msg}`),
      );

      try {
        await newStreaming.warmTokenCache();
        await newStreaming.start(chatId, "chat_id", {
          replyToMessageId: messageId,
          header: { title: `第${relayIndex + 1}部分（续）`, template: "blue" },
        });

        activeStreamingSessions.set(chatId, { session: newStreaming, sessionId, opencodeClient, directory });
        streaming = newStreaming;

        cardTimedOut = false;
        lastKeepAliveMs = Date.now();
        lastThinkingDisplay = "";
        lastLoadingContent = "";
        lastNote = "";
        accumulatedText = "";
        receivedTextDelta = false;
        sseProducedText = false;

        logger.info(`[feishu-streaming] New relay card created (part ${relayIndex + 1})`);
        return true;
      } catch (e) {
        logger.error(`[feishu-streaming] Failed to create relay card: ${String(e)}`);
        return false;
      }
    }

    const SSE_INITIAL_TIMEOUT_MS = 8_000;
    let sseFirstEventReceived = false;

const LOADING_DOTS = ["", ".", "..", "..."];
    let loadingDotsIndex = 0;
    let lastLoadingContent = "";
    let lastNoteContent = "";

const thinkingHeartbeat = setInterval(() => {
      if (!streaming.isActive()) return;

      if (!cardTimedOut && Date.now() - lastKeepAliveMs >= STREAMING_KEEPALIVE_INTERVAL_MS) {
        lastKeepAliveMs = Date.now();
        streaming.keepAlive().then((ok) => {
          if (!ok) {
            cardTimedOut = true;
            logger.warn(`[feishu-streaming] keepAlive failed, card may have timed out — will create new card on next content update`);
          } else {
            logger.info(`[feishu-streaming] keepAlive: streaming_mode reset`);
          }
        }).catch((e) => {
          cardTimedOut = true;
          logger.warn(`[feishu-streaming] keepAlive error: ${String(e)} — will create new card on next content update`);
        });
      }

      loadingDotsIndex = (loadingDotsIndex + 1) % LOADING_DOTS.length;
      const dots = LOADING_DOTS[loadingDotsIndex];

      if (!receivedTextDelta) {
        if (isCompacting) {
          const compactLabel = compactReason === "auto" ? "自动压缩上下文" : "压缩上下文";
          const elapsed = formatElapsed(Date.now() - sseStart);
          const cardContent = `🔄 ${compactLabel}${dots} (${elapsed})\n上下文过长，正在压缩以继续回复...`;
          if (cardContent !== lastThinkingDisplay) {
            lastThinkingDisplay = cardContent;
            streaming.replaceContent(cardContent);
          }
        } else {
          const thinkingDisplay = thinking.buildDisplay();
          const phaseNote = phase.buildNote();
          const cardContent = thinkingDisplay
            ? `⏳ 正在思考${dots}\n${thinkingDisplay}`
            : (phaseNote ? `⏳ AI正在处理${dots}\n${phaseNote}` : `⏳ 正在思考${dots}`);

          if (cardContent !== lastThinkingDisplay) {
            lastThinkingDisplay = cardContent;
            streaming.replaceContent(cardContent);
          }
        }
      } else {
        const thinkingDisplay = thinking.buildDisplay();
        const phaseNote = phase.buildNote();
        const elapsed = formatElapsed(Date.now() - sseStart);
        let loadingContent = "";
        if (isCompacting) {
          loadingContent = `🔄 上下文过长，正在${dots} (${elapsed})`;
        } else if (thinkingDisplay) {
          loadingContent = `${thinkingDisplay}\n⏳ 思考${dots} (${elapsed})`;
        } else if (phaseNote) {
          loadingContent = `${phaseNote}\n⏳ 处理中${dots} (${elapsed})`;
        } else {
          loadingContent = `⏳ 等待回复${dots} (${elapsed})`;
        }
        if (loadingContent !== lastLoadingContent) {
          lastLoadingContent = loadingContent;
          streaming.updateLoadingContent(loadingContent);
        }
      }
    }, 1500);

    try {
      const sseIterator = eventResult.stream[Symbol.asyncIterator]();

      for (;;) {
        if (Date.now() - sseStart > REPLY_TIMEOUT_MS) {
          logger.warn(`[feishu-streaming] Session deadline exceeded (${REPLY_TIMEOUT_MS}ms), closing SSE`);
          sessionDone = true;
          break;
        }
        if (sessionDone) break;

        const nextEventPromise = sseIterator.next();

        let iteratorResult: IteratorResult<unknown>;
        if (!sseFirstEventReceived) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<IteratorResult<never>>((resolve) => {
            timeoutId = setTimeout(() => {
              logger.warn(`[feishu-streaming] No SSE events within ${SSE_INITIAL_TIMEOUT_MS}ms, falling back to polling`);
              resolve({ done: true, value: undefined as never });
            }, SSE_INITIAL_TIMEOUT_MS);
          });
          iteratorResult = await Promise.race([nextEventPromise, timeoutPromise]);
          if (timeoutId) clearTimeout(timeoutId);
        } else {
          iteratorResult = await nextEventPromise;
        }

        if (iteratorResult.done) {
          logger.info(`[feishu-streaming] SSE stream ended (iteratorResult.done), sessionDone=${sessionDone}, sessionIdle=${sessionIdle}, sseProducedText=${sseProducedText}, phase.isDelegating=${phase.isDelegating()}, phase.total=${phase.getTotal()}, accumulatedText.length=${accumulatedText.length}`);
          if (sseProducedText && !phase.isDelegating()) {
            streaming.updateLoadingContent("");
          }
          if (phase.isDelegating()) {
            logger.info(`[feishu-streaming] SSE stream ended while background tasks still running, transitioning to polling for completion`);
            sessionIdle = true;
            break;
          }
          if (!sseFirstEventReceived) {
            logger.warn(`[feishu-streaming] SSE stream ended or timed out with no events, falling back to polling`);
          }
          break;
        }

        sseFirstEventReceived = true;
        const globalEvent = iteratorResult.value;

        const event = globalEvent as { directory?: string; payload: Record<string, unknown> };
        const payload = event.payload;
        const props = (payload.properties as Record<string, unknown> | undefined) ?? {};
        const payloadType = (payload.type as string) ?? (props.type as string);
        const payloadSessionId = (props.sessionID as string | undefined) ?? (payload.sessionID as string | undefined);
        logger.debug(`[feishu-streaming] SSE raw event: type=${payloadType ?? 'unknown'}, sessionID=${payloadSessionId ?? 'none'}, keys=${Object.keys(payload).join(',')}, elapsed=${Date.now() - sseStart}ms`);

        if (directory && event.directory !== undefined && event.directory !== directory) {
          logger.debug(`[feishu-streaming] SSE event filtered by directory: eventDir=${event.directory ?? 'none'}, expectedDir=${directory}`);
          continue;
        }

        if (cardTimedOut || streaming.isCardTimedOut()) {
          const ok = await ensureActiveStreamingCard();
          if (!ok) {
            logger.warn(`[feishu-streaming] Cannot create new card, skipping event: ${payloadType}`);
            continue;
          }
        }

        switch (payloadType) {
          case "server.connected": {
            logger.info(`[feishu-streaming] SSE connected to event stream`);
            break;
          }

          case "server.heartbeat": {
            logger.debug(`[feishu-streaming] SSE heartbeat received`);
            break;
          }

          case "session.next.compaction.started": {
            if (payloadSessionId === sessionId) {
              isCompacting = true;
              compactReason = ((props.reason as string) ?? (payload.reason as string)) === "manual" ? "manual" : "auto";
              receivedTextDelta = false;
              logger.info(`[feishu-streaming] SSE compaction started: reason=${compactReason}`);
            }
            break;
          }

          case "session.next.compaction.delta": {
            if (payloadSessionId === sessionId) {
              const delta = (props.text as string) ?? (payload.text as string) ?? "";
              logger.debug(`[feishu-streaming] SSE compaction delta: +${delta.length} chars (suppressed from card)`);
            }
            break;
          }

          case "session.next.compaction.ended": {
            if (payloadSessionId === sessionId) {
              isCompacting = false;
              lastThinkingDisplay = "";
              lastLoadingContent = "";
              logger.info(`[feishu-streaming] SSE compaction ended, resuming normal display`);
            }
            break;
          }

          case "session.next.text.delta": {
            if (payloadSessionId === sessionId) {
              if (isCompacting) {
                logger.debug(`[feishu-streaming] SSE text delta suppressed during compaction`);
                break;
              }
              const delta = (props.delta as string) ?? (payload.delta as string) ?? "";
              accumulatedText += delta;

              if (accumulatedText.length >= CARD_RELAY_THRESHOLD) {
                streaming.update(accumulatedText);
                sseProducedText = true;
                const relayOk = await relayStreamingCard();
                if (!relayOk) {
                  logger.warn(`[feishu-streaming] Relay failed, continuing on current card (may hit content limit)`);
                }
                break;
              }

              if (!receivedTextDelta) {
                receivedTextDelta = true;
                streaming.replaceContent(accumulatedText);
                logger.info(`[feishu-streaming] SSE first text delta: +${delta.length} chars (total: ${accumulatedText.length}), replaced thinking`);
              } else {
                streaming.update(accumulatedText);
              }
              sseProducedText = true;
              logger.info(`[feishu-streaming] SSE text delta: +${delta.length} chars (total: ${accumulatedText.length})`);
            }
            break;
          }

          case "message.part.delta": {
            if (payloadSessionId === sessionId) {
              if (isCompacting) {
                logger.debug(`[feishu-streaming] SSE message.part.delta suppressed during compaction`);
                break;
              }
              const delta = (props.delta as string) ?? (payload.delta as string) ?? "";
              if (delta) {
                accumulatedText += delta;

                if (accumulatedText.length >= CARD_RELAY_THRESHOLD) {
                  streaming.update(accumulatedText);
                  sseProducedText = true;
                  const relayOk = await relayStreamingCard();
                  if (!relayOk) {
                    logger.warn(`[feishu-streaming] Relay failed, continuing on current card (may hit content limit)`);
                  }
                  break;
                }

                if (!receivedTextDelta) {
                  receivedTextDelta = true;
                  streaming.replaceContent(accumulatedText);
                } else {
                  streaming.update(accumulatedText);
                }
                sseProducedText = true;
                logger.info(`[feishu-streaming] SSE message.part.delta: +${delta.length} chars (total: ${accumulatedText.length})`);
              }
            }
            break;
          }

          case "message.part.updated": {
            if (payloadSessionId !== sessionId) break;

            const part = (props.part as Record<string, unknown>) ?? (payload.part as Record<string, unknown>);

            if (part.type === "compaction") {
              isCompacting = true;
              compactReason = part.auto === false ? "manual" : "auto";
              logger.info(`[feishu-streaming] SSE compaction part detected (auto=${compactReason})`);
              break;
            }

            if (isCompacting && part.type === "text") {
              logger.debug(`[feishu-streaming] SSE text part suppressed during compaction`);
              break;
            }

            if (part.type === "text" && part.synthetic === true) {
              const syntheticText = part.text as string;
              logger.info(`[feishu-streaming] SSE synthetic text part detected: textLen=${syntheticText?.length ?? 0}`);

              const completedMatch = syntheticText?.match(/^Background task completed:\s*(.+)/m) ?? null;
              const failedMatch = syntheticText?.match(/^Background task failed:\s*(.+)/m) ?? null;

              if (completedMatch) {
                const agentName = (completedMatch[1] ?? "").trim() || "unknown";
                phase.markCompletedByName(agentName);
                logger.info(`[feishu-streaming] Background task completed: agent=${agentName}, phase.total=${phase.getTotal()}, phase.isDelegating=${phase.isDelegating()}`);
                sessionIdle = false;
              } else if (failedMatch) {
                const agentName = (failedMatch[1] ?? "").trim() || "unknown";
                const errorMsg = syntheticText?.match(/<task_error>([\s\S]*?)<\/task_error>/)?.[1]?.trim() ?? "unknown error";
                phase.markFailedByName(agentName, errorMsg);
                logger.info(`[feishu-streaming] Background task failed: agent=${agentName}, error=${errorMsg}`);
                sessionIdle = false;
              }

              const newNote = phase.buildNote();
              if (newNote !== lastNote) {
                lastNote = newNote;
                if (newNote) streaming.updateNoteContent(newNote);
              }

              break;
            }

            // ── Regular text part update ──
            if (part.type === "text") {
              const newText = part.text as string;
              if (newText && newText !== accumulatedText) {
                accumulatedText = newText;
                sseProducedText = true;
                if (!receivedTextDelta) {
                  receivedTextDelta = true;
                  streaming.replaceContent(accumulatedText);
                  logger.info(`[feishu-streaming] SSE message.part.updated text: ${accumulatedText.length} chars (first text)`);
                } else {
                  streaming.update(accumulatedText);
                  logger.info(`[feishu-streaming] SSE message.part.updated text: ${accumulatedText.length} chars (updated)`);
                }
              }
            }

if (part.type === "tool") {
              handleToolPartUpdate(part as { tool?: string; state?: { status?: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; error?: string; title?: string }; metadata?: Record<string, unknown> }, phase);

              const toolState = (part.state as { status?: string; title?: string }) ?? {};
              const toolName = (part.tool as string) ?? "";
              const isDelegationTool = toolName === "route_to_bot" || toolName === "call_omo_agent" || toolName === "task";
              if (!isDelegationTool) {
                const status = toolState.status;
                if (status === "running" || status === "pending") {
                  thinking.start(toolName, status === "pending" ? (toolState.title ?? "等待执行") : toolState.title);
                }
                if (status === "completed") thinking.completeAllByName(toolName);
                if (status === "error") thinking.completeAllByName(toolName);
              }

              const newNote = phase.buildNote();
              if (newNote !== lastNote) {
                lastNote = newNote;
                if (newNote) streaming.updateNoteContent(newNote);
              }

              if (!receivedTextDelta) {
                loadingDotsIndex = (loadingDotsIndex + 1) % LOADING_DOTS.length;
                const dots = LOADING_DOTS[loadingDotsIndex];
                const thinkingDisplay = thinking.buildDisplay();
                const cardContent = thinkingDisplay
                  ? `⏳ 正在思考${dots}\n${thinkingDisplay}`
                  : (newNote ? `⏳ AI正在处理${dots}\n${newNote}` : `⏳ 正在思考${dots}`);

                if (cardContent !== lastThinkingDisplay) {
                  lastThinkingDisplay = cardContent;
                  streaming.replaceContent(cardContent);
                }
              } else {
                loadingDotsIndex = (loadingDotsIndex + 1) % LOADING_DOTS.length;
                const dots = LOADING_DOTS[loadingDotsIndex];
                const thinkingDisplay = thinking.buildDisplay();
                const elapsed = formatElapsed(Date.now() - sseStart);
                let loadingContent = "";
                if (isCompacting) {
                  loadingContent = `🔄 上下文过长，正在${dots} (${elapsed})`;
                } else if (thinkingDisplay) {
                  loadingContent = `${thinkingDisplay}\n⏳ 思考${dots} (${elapsed})`;
                } else if (newNote) {
                  loadingContent = `${newNote}\n⏳ 处理中${dots} (${elapsed})`;
} else {
          loadingContent = `⏳ 等待回复${dots} (${elapsed})`;
                }
                if (loadingContent !== lastLoadingContent) {
                  lastLoadingContent = loadingContent;
                  streaming.updateLoadingContent(loadingContent);
                }
              }

              logger.info(`[feishu-streaming] SSE tool update: ${toolName} status=${toolState.status ?? "?"}`);
            }

            if (part.type === "subtask" && part.agent) {
              phase.addPending(String(part.agent));
              logger.info(`[feishu-streaming] SSE subtask part: agent=${part.agent}`);
            }
            if (part.type === "agent" && (part as Record<string, unknown>).name) {
              phase.addPending(String((part as Record<string, unknown>).name));
              logger.info(`[feishu-streaming] SSE agent part: name=${(part as Record<string, unknown>).name}`);
            }
            break;
          }

          case "session.next.text.ended": {
            if (payloadSessionId === sessionId) {
              if (isCompacting) {
                logger.debug(`[feishu-streaming] SSE text ended suppressed during compaction`);
                break;
              }
              const text = (props.text as string) ?? (payload.text as string) ?? "";
              accumulatedText = text;
              if (!receivedTextDelta) {
                receivedTextDelta = true;
                streaming.replaceContent(accumulatedText);
              } else {
                streaming.update(accumulatedText);
              }
              sseProducedText = true;
              logger.info(`[feishu-streaming] SSE text generation ended: ${accumulatedText.length} chars`);
            }
            break;
          }

          case "message.updated": {
            if (payloadSessionId === sessionId) {
              const info = (props.info as Record<string, unknown>) ?? (payload.info as Record<string, unknown>);
              const agent = (info?.agent as string) ?? (props.agent as string) ?? (payload.agent as string) ?? "";
              if (agent.trim().toLowerCase() === "compaction") {
                const messageError = (info?.error as Record<string, unknown>) ?? (props.error as Record<string, unknown>) ?? (payload.error as Record<string, unknown>);
                if (messageError) {
                  const errorMsg = (messageError.message as string) ?? (messageError.name as string) ?? String(messageError);
                  isCompacting = false;
                  lastThinkingDisplay = "";
                  lastLoadingContent = "";
                  const userMsg = `❌ 上下文压缩失败：${errorMsg}`;
                  if (!receivedTextDelta) {
                    streaming.replaceContent(userMsg);
                  } else {
                    streaming.updateLoadingContent("");
                    streaming.update(accumulatedText);
                  }
                  logger.warn(`[feishu-streaming] SSE compaction failed: ${errorMsg}`);
                } else {
                  isCompacting = true;
                  logger.info(`[feishu-streaming] SSE compaction message detected (agent=compaction)`);
                }
                break;
              }
              if (isCompacting) {
                logger.debug(`[feishu-streaming] SSE message.updated suppressed during compaction`);
                break;
              }
              if (info?.role === "assistant" && !receivedTextDelta) {
                const parts = (info.parts as Array<Record<string, unknown>>) ?? [];
                const hasCompactionPart = parts.some((p) => p.type === "compaction");
                if (hasCompactionPart) {
                  isCompacting = true;
                  logger.info(`[feishu-streaming] SSE compaction part found in message.updated`);
                  break;
                }
                for (const p of parts) {
                  if (p.type === "text" && p.text) {
                    const newText = p.text as string;
                    if (newText && newText !== accumulatedText) {
                      accumulatedText = newText;
                      sseProducedText = true;
                      streaming.replaceContent(accumulatedText);
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
              logger.info(`[feishu-streaming] SSE session idle: isCompacting=${isCompacting}, phase.isDelegating=${phase.isDelegating()}, phase.total=${phase.getTotal()}, phase.pending=${JSON.stringify(phase.getPendingNames())}`);
              if (isCompacting) {
                logger.info(`[feishu-streaming] SSE session idle while compacting, not closing yet`);
              } else if (phase.isDelegating()) {
                logger.info(`[feishu-streaming] SSE session idle while delegating subtasks, not closing yet`);
              } else {
                logger.info(`[feishu-streaming] SSE session idle, will verify on next event cycle`);
                sessionIdle = true;
              }
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
                if (!receivedTextDelta) {
                  streaming.replaceContent(`${userMsg}\n\n🔄 自动重试中 (attempt ${status.attempt ?? "?"})`);
                } else {
                  streaming.update(`${userMsg}\n\n🔄 自动重试中 (attempt ${status.attempt ?? "?"})`);
                }
                if (actionInfo?.link) {
                  streaming.updateNoteContent(`[${actionInfo.label ?? "查看详情"}](${actionInfo.link})`);
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

                const isUserAbort = errorName === "MessageAbortedError" && activeStreamingSessions.has(chatId);
                if (isUserAbort) {
                  logger.info(`[feishu-streaming] SSE MessageAbortedError — user sent new message, waiting for queued response`);
                  accumulatedText = "";
                  receivedTextDelta = false;
                  sseProducedText = false;
                  sessionIdle = false;
                  lastError = null;
                  lastThinkingDisplay = "";
                  lastLoadingContent = "";
                  lastNote = "";
                  isCompacting = false;
                  phase = new PhaseTracker();
                  thinking = new ThinkingTracker();
                  streaming.replaceContent("⏳ 新消息已到达，正在切换处理...");
                  continue;
                }

                lastError = errorMsg;
                if (isCompacting) {
                  isCompacting = false;
                  lastThinkingDisplay = "";
                  lastLoadingContent = "";
                  logger.warn(`[feishu-streaming] SSE session error during compaction: ${errorName} - ${errorMsg}`);
                }
                const userMsg = classifyErrorForUser(errorName, errorMsg, statusCode);
                if (!receivedTextDelta) {
                  streaming.replaceContent(userMsg);
                } else {
                  streaming.updateLoadingContent("");
                  streaming.update(userMsg);
                }
                logger.warn(`[feishu-streaming] SSE session error: ${errorName} - ${errorMsg}`);
              }
            }
            break;
          }
        }

        // ── Post-processing: event-driven completion check ─────────────
        // Close ONLY here — never on session.idle alone.
        // If PhaseTracker hasn't seen subtask events yet (race condition),
        // the next SSE event will update it and phase.isDelegating()=true prevents closing.
        if (sessionIdle && !phase.isDelegating() && !isCompacting) {
          if (phase.allDone()) {
            logger.info(`[feishu-streaming] Event-driven close: all subtasks done (total=${phase.getTotal()}, completed=${phase.getCompletedCount()}), session was idle`);
            streaming.updateLoadingContent("");
            sessionDone = true;
            break;
          }
          if (sseProducedText) {
            logger.info(`[feishu-streaming] Event-driven close: session idle with content produced (no subtasks tracked, total=${phase.getTotal()})`);
            streaming.updateLoadingContent("");
            sessionDone = true;
            break;
          }
          if (phase.getTotal() === 0) {
            logger.info(`[feishu-streaming] SSE session idle but no content yet, continuing SSE loop for text or error`);
          } else {
            logger.info(`[feishu-streaming] sessionIdle=true but phase incomplete (total=${phase.getTotal()}, delegating=${phase.isDelegating()}), continuing SSE loop for more events`);
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConnectionError = /fetch|network|ECONN|SSE|abort|timeout/i.test(errMsg);
      if (isConnectionError) {
        logger.warn(`[feishu-streaming] SSE connection exhausted (SDK retries failed): ${errMsg}, falling back to polling`);
        if (!sseProducedText) {
          streaming.replaceContent(`🌐 SSE连接中断，正在切换到轮询模式获取结果...\n\n${errMsg}`);
        }
      } else {
        logger.warn(`[feishu-streaming] SSE stream error: ${errMsg}, falling back to polling`);
      }
    } finally {
      clearInterval(thinkingHeartbeat);
    }

    if (phase.isDelegating() || (!sseProducedText && !sessionIdle)) {
      const reason = phase.isDelegating()
        ? `background tasks still running after SSE stream ended (total=${phase.getTotal()}, delegating=true), polling for completion`
        : `SSE did not produce content, falling back to polling for session ${sessionId}`;
      logger.info(`[feishu-streaming] ${reason}`);

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
              streaming.update(`${userMsg}\n\n🔄 自动重试中 (attempt ${sessionStatus.attempt ?? "?"})`);
              const actionInfo = sessionStatus.action;
              if (actionInfo?.link) {
                streaming.updateNoteContent(`[${actionInfo.label ?? "查看详情"}](${actionInfo.link})`);
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
          if (msg.info?.role !== "assistant" && msg.info?.role !== "user") continue;
          const agent = (msg.info?.agent ?? msg.agent ?? "") as string;
          if (agent.trim().toLowerCase() === "compaction") continue;
          const parts = (msg.parts ?? []) as Array<{ type: string; agent?: string; tool?: string; state?: Record<string, unknown>; text?: string; synthetic?: boolean }>;
          if (parts.some((p) => p.type === "compaction")) continue;
          for (const part of parts) {
            if (part.type === "subtask") {
              phase.addPending(part.agent ?? "unknown");
            }
            if (part.type === "tool") {
              handleToolPartUpdate(part as { tool?: string; state?: { status?: string; metadata?: Record<string, unknown>; input?: Record<string, unknown>; error?: string; title?: string }; metadata?: Record<string, unknown> }, phase);
            }
            if (part.type === "text" && part.synthetic === true) {
              const syntheticText = part.text ?? "";
              const completedMatch = syntheticText.match(/^Background task completed:\s*(.+)/m);
              const failedMatch = syntheticText.match(/^Background task failed:\s*(.+)/m);
              if (completedMatch && completedMatch[1]) {
                const name = completedMatch[1].trim() || "unknown";
                phase.markCompletedByName(name);
                logger.info(`[feishu-streaming] Polling: background task completed: ${name}`);
              } else if (failedMatch && failedMatch[1]) {
                const name = failedMatch[1].trim() || "unknown";
                const errorMsg = syntheticText.match(/<task_error>([\s\S]*?)<\/task_error>/)?.[1]?.trim() ?? "unknown error";
                phase.markFailedByName(name, errorMsg);
                logger.info(`[feishu-streaming] Polling: background task failed: ${name}`);
              }
            }
          }
        }

        const newNote = phase.buildNote();
        if (newNote !== lastNote) {
          lastNote = newNote;
          if (newNote) streaming.updateNoteContent(newNote);
        }

        const currentText = extractLastAssistantText(currentMessages);
        if (currentText && currentText !== lastText) {
          lastText = currentText;
          accumulatedText = currentText;
          if (!sseProducedText) {
            streaming.replaceContent(currentText);
          } else {
            streaming.update(currentText);
          }
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

    // ── Close final streaming card ────────────────────────────────
    const finalNote = phase.buildFinalNote();
    if (relayIndex > 0) {
      const relayNote = finalNote ? `${finalNote} · 第${relayIndex + 1}部分(共${relayIndex + 1}部分)` : `第${relayIndex + 1}部分(共${relayIndex + 1}部分)`;
      await streaming.close(accumulatedText || "✅ 完成", { note: relayNote });
    } else if (accumulatedText) {
      await streaming.close(accumulatedText, { note: finalNote });
    } else if (lastError) {
      const userMsg = classifyErrorForUser("", lastError);
      await streaming.close(userMsg, { note: "❌ 执行失败" });
    } else {
      const elapsed = Math.round((Date.now() - startTime) / 60_000);
      await streaming.close(
        `⚠️ 执行超时 (已运行${elapsed}分钟)，Agent仍在后台继续。请稍后再问一次获取结果。`,
        { note: "⚠️ 超时" },
      );
    }
    const currentEntry = activeStreamingSessions.get(chatId);
    if (currentEntry?.session === streaming) activeStreamingSessions.delete(chatId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCauses: string[] = [];
    let cause: unknown = err instanceof Error ? err.cause : undefined;
    while (cause instanceof Error) {
      errCauses.push(`${cause.message} (${cause.constructor.name})`);
      cause = cause.cause;
    }
    if (cause !== undefined && cause !== null) {
      errCauses.push(String(cause));
    }
    logger.error("[feishu-streaming] Error in streaming reply", {
      error: errMsg,
      cause: errCauses.length ? errCauses.join(" → ") : undefined,
      sessionId,
      chatId,
    });
    const currentEntry = activeStreamingSessions.get(chatId);
    if (currentEntry?.session === streaming) activeStreamingSessions.delete(chatId);
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

      // If this chat already has an active streaming session, abort current execution
      // and send the new message in the same session (opencode queues + abort like ESC)
      if (deps.opencodeClient && activeStreamingSessions.has(chatId)) {
        const abortOk = await abortAndSendNewMessage(chatId, text);
        if (abortOk) {
          logger.info(`[feishu-handler] Sent new message to active session for chatId=${chatId}, skipping full trigger+stream`);
          return;
        }
        logger.warn(`[feishu-handler] abortAndSendNewMessage failed for chatId=${chatId}, falling back to full trigger+stream`);
      }

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

      // If this chat already has an active streaming session, abort current execution
      // and send the new message in the same session (opencode queues + abort like ESC)
      if (deps.opencodeClient && activeStreamingSessions.has(chatId)) {
        const abortOk = await abortAndSendNewMessage(chatId, text, botConfig.agent ?? "main");
        if (abortOk) {
          logger.info(`[feishu-handler-bot] Sent new message to active session for chatId=${chatId}, skipping full trigger+stream`);
          return;
        }
        logger.warn(`[feishu-handler-bot] abortAndSendNewMessage failed for chatId=${chatId}, falling back to full trigger+stream`);
      }

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
