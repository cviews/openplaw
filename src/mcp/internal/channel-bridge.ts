import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionBindingService } from "../../core/routing/session-binding.js";
import {
  matchEventFilter,
  normalizeApprovalId,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  toConversation,
  toText,
  type ApprovalDecision,
  type ApprovalKind,
  type ChatHistoryResult,
  type ConversationDescriptor,
  type PendingApproval,
  type QueueEvent,
  type SessionMessagePayload,
  type WaitFilter,
} from "../shared/channel-shared.js";

type PendingWaiter = {
  filter: WaitFilter;
  resolve: (value: QueueEvent | null) => void;
  timeout: NodeJS.Timeout | null;
};

type ServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

const QUEUE_LIMIT = 1_000;

function bindingToDescriptor(binding: {
  sessionKey: string;
  conversation: import("../../core/routing/session-binding.js").ConversationRef;
}): ConversationDescriptor {
  return {
    sessionKey: binding.sessionKey,
    channel: binding.conversation.channel,
    to: binding.conversation.conversationId,
    conversationId: binding.conversation.conversationId,
    accountId: binding.conversation.accountId,
    ...(binding.conversation.parentConversationId
      ? { threadId: binding.conversation.parentConversationId }
      : {}),
  };
}

export class OpenmoChannelBridge {
  private verbose: boolean;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;

  // Dependencies injected from openplaw runtime
  private sessionBinding: SessionBindingService | null = null;

  private channelRegistry: {
    get: (channelId: string) => {
      outbound: {
        sendText: (ctx: { to: string; text: string; accountId?: string; botId?: string }) => Promise<void>;
        sendMention: (ctx: { to: string; botName: string; text: string; botId?: string; mentionUserId?: string }) => Promise<void>;
      };
    } | null;
  } | null = null;

  private botAgentMap: Record<string, string> = {};
  private groupResolver: {
    isBotInGroup: (botId: string, chatId: string) => boolean;
    getAvailableBotIds: (chatId: string) => string[];
  } | null = null;
  private omoClient: {
    session: {
      create: (input: Record<string, unknown>) => Promise<{ data: { id: string } }>;
      promptAsync: (input: Record<string, unknown>) => Promise<unknown>;
      messages: (input: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      status: () => Promise<{ data: Record<string, { type: string }> }>;
    };
  } | null = null;

  constructor(params: { verbose?: boolean }) {
    this.verbose = params.verbose ?? false;
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  injectDeps(deps: {
    sessionBinding: SessionBindingService;
    channelRegistry: OpenmoChannelBridge["channelRegistry"];
    botAgentMap: Record<string, string>;
    groupResolver: OpenmoChannelBridge["groupResolver"];
    omoClient: OpenmoChannelBridge["omoClient"];
  }): void {
    this.sessionBinding = deps.sessionBinding;
    this.channelRegistry = deps.channelRegistry;
    this.botAgentMap = deps.botAgentMap;
    this.groupResolver = deps.groupResolver;
    this.omoClient = deps.omoClient;
  }

  async listConversations(params?: {
    limit?: number;
    search?: string;
    channel?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
  }): Promise<ConversationDescriptor[]> {
    const requestedChannel = normalizeOptionalLowercaseString(params?.channel);

    // Return conversations from session binding
    if (!this.sessionBinding) {
      return [];
    }

    const conversations: ConversationDescriptor[] = [];
    // In production, this would query the gateway for session list
    // For now, return from local bindings
    return conversations.filter((c) =>
      requestedChannel ? normalizeLowercaseStringOrEmpty(c.channel) === requestedChannel : true,
    );
  }

  async getConversation(sessionKey: string): Promise<ConversationDescriptor | null> {
    const normalized = sessionKey.trim();
    if (!normalized || !this.sessionBinding) {
      return null;
    }
    const binding = this.sessionBinding.resolveBySessionKey(normalized);
    if (!binding) {
      return null;
    }
    return bindingToDescriptor(binding);
  }

  async readMessages(
    sessionKey: string,
    _limit = 20,
  ): Promise<NonNullable<ChatHistoryResult["messages"]>> {
    if (!this.omoClient) {
      return [];
    }
    try {
      const result = await this.omoClient.session.messages({
        sessionID: sessionKey,
      });
      return result.data as Array<{
        id?: string;
        role?: string;
        content?: unknown;
        [key: string]: unknown;
      }>;
    } catch {
      return [];
    }
  }

  async sendMessage(params: {
    sessionKey: string;
    text: string;
  }): Promise<Record<string, unknown>> {
    const conversation = await this.getConversation(params.sessionKey);
    if (!conversation || !this.channelRegistry) {
      throw new Error(`Cannot send: conversation or channel not found for ${params.sessionKey}`);
    }
    const channel = this.channelRegistry.get(conversation.channel);
    if (!channel) {
      throw new Error(`Channel ${conversation.channel} not registered`);
    }
    await channel.outbound.sendText({
      to: conversation.to,
      text: params.text,
      accountId: conversation.accountId ?? undefined,
      botId: conversation.accountId ?? undefined,
    });
    return { sent: true, sessionKey: params.sessionKey };
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].sort(
      (a: PendingApproval, b: PendingApproval) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0),
    );
  }

  async respondToApproval(params: {
    kind: ApprovalKind;
    id: string;
    decision: ApprovalDecision;
  }): Promise<Record<string, unknown>> {
    const id = normalizeApprovalId(params.id);
    if (!id) {
      throw new Error("Invalid approval ID");
    }
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      throw new Error(`Approval ${id} not found`);
    }
    this.pendingApprovals.delete(id);
    this.enqueue({
      cursor: this.nextCursor(),
      type: "approval_resolved",
      kind: params.kind,
      id: params.id,
      decision: params.decision,
    });
    return { resolved: true, id: params.id, decision: params.decision };
  }

  async routeToBot(params: {
    sessionKey: string;
    target: string;
    message: string;
    visible: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    if (!(params.target in this.botAgentMap)) {
      return {
        success: false,
        error: `Bot "${params.target}" not found. Available: ${Object.keys(this.botAgentMap).join(", ")}`,
      };
    }

    const binding = this.sessionBinding?.resolveBySessionKey(params.sessionKey);
    const channel = binding ? this.channelRegistry?.get(binding.conversation.channel) : null;
    const chatId = binding?.conversation.conversationId ?? "";
    const callingBotId = binding?.conversation.accountId ?? "default";

    const targetInGroup = chatId && this.groupResolver
      ? this.groupResolver.isBotInGroup(params.target, chatId)
      : true;
    const canBeVisible = params.visible && targetInGroup && binding !== null && channel !== null;

    if (canBeVisible && binding && channel) {
      const botDisplayName = this.botAgentMap[params.target] ?? params.target;
      try {
        await channel.outbound.sendMention({
          to: binding.conversation.conversationId,
          botName: botDisplayName,
          text: `正在委派 ${botDisplayName} 处理...`,
          botId: params.target,
        });
      } catch {
        try {
          await channel.outbound.sendText({
            to: binding.conversation.conversationId,
            text: `正在委派 ${botDisplayName} 处理...`,
            accountId: callingBotId,
            botId: callingBotId,
          });
        } catch {
          // degradation: both failed
        }
      }
    }

    this.enqueue({
      cursor: this.nextCursor(),
      type: "route_to_bot",
      sessionKey: params.sessionKey,
      fromBot: callingBotId,
      toBot: params.target,
      message: params.message,
      visible: canBeVisible,
      conversation: binding ? bindingToDescriptor(binding) : undefined,
    });

    return { success: true };
  }

  pollEvents(filter: WaitFilter, limit = 20): { events: QueueEvent[]; nextCursor: number } {
    const events = this.queue.filter((event) => matchEventFilter(event, filter)).slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? filter.afterCursor;
    return { events, nextCursor };
  }

  async waitForEvent(filter: WaitFilter, timeoutMs = 30_000): Promise<QueueEvent | null> {
    const existing = this.queue.find((event) => matchEventFilter(event, filter));
    if (existing) {
      return existing;
    }
    return await new Promise<QueueEvent | null>((resolve) => {
      const waiter: PendingWaiter = {
        filter,
        resolve: (value) => {
          this.pendingWaiters.delete(waiter);
          resolve(value);
        },
        timeout: null,
      };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve(null);
        }, timeoutMs);
      }
      this.pendingWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.pendingWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(null);
    }
    this.pendingWaiters.clear();
  }

  private async sendNotification(notification: ServerNotification): Promise<void> {
    if (!this.server || this.closed) {
      return;
    }
    try {
      await this.server.server.notification(notification);
    } catch {
      // best-effort notification
    }
  }

  private nextCursor(): number {
    this.cursor += 1;
    return this.cursor;
  }

  private enqueue(event: QueueEvent): void {
    this.queue.push(event);
    while (this.queue.length > QUEUE_LIMIT) {
      this.queue.shift();
    }
    for (const waiter of this.pendingWaiters) {
      if (!matchEventFilter(event, waiter.filter)) {
        continue;
      }
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(event);
    }
  }

  trackApproval(kind: ApprovalKind, payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (!id) {
      return;
    }
    this.pendingApprovals.set(id, {
      kind,
      id,
      request:
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : undefined,
      createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : undefined,
      expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined,
    });
  }

  handleGatewayEvent(event: { event: string; payload: SessionMessagePayload }): void {
    switch (event.event) {
      case "session.message":
        this.handleSessionMessageEvent(event.payload);
        return;
      case "exec.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("exec", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "approval_requested",
          kind: "exec",
          id: normalizeApprovalId(raw.id) ?? "",
          request: raw,
          createdAtMs: typeof raw.createdAtMs === "number" ? raw.createdAtMs : undefined,
          expiresAtMs: typeof raw.expiresAtMs === "number" ? raw.expiresAtMs : undefined,
        });
        return;
      }
      case "plugin.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("plugin", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "approval_requested",
          kind: "plugin",
          id: normalizeApprovalId(raw.id) ?? "",
          request: raw,
          createdAtMs: typeof raw.createdAtMs === "number" ? raw.createdAtMs : undefined,
          expiresAtMs: typeof raw.expiresAtMs === "number" ? raw.expiresAtMs : undefined,
        });
        return;
      }
    }
  }

  private handleSessionMessageEvent(payload: SessionMessagePayload): void {
    const sessionKey = toText(payload.sessionKey);
    if (!sessionKey) {
      return;
    }

    const conversation =
      toConversation({
        key: sessionKey,
        lastChannel: toText(payload.lastChannel),
        lastTo: toText(payload.lastTo),
        lastAccountId: toText(payload.lastAccountId),
        lastThreadId: payload.lastThreadId,
      }) ?? undefined;

    const role = toText(payload.message?.role);
    const text = this.extractFirstTextBlock(payload.message);

    this.enqueue({
      cursor: this.nextCursor(),
      type: "message",
      sessionKey,
      conversation,
      messageId: toText(payload.messageId),
      messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
      role,
      text,
      raw: payload,
    });

    void this.sendNotification({
      method: "notifications/openplaw/channel",
      params: {
        content: text ?? "[non-text message]",
        meta: {
          session_key: sessionKey,
          channel: conversation?.channel ?? "",
          to: conversation?.to ?? "",
          account_id: conversation?.accountId ?? "",
          thread_id: conversation?.threadId == null ? "" : String(conversation.threadId),
          message_id: toText(payload.messageId) ?? "",
        },
      },
    });
  }

  private extractFirstTextBlock(message: unknown): string | undefined {
    if (!message || typeof message !== "object") {
      return undefined;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return typeof content === "string" ? content : undefined;
    }
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = toText((block as { text?: unknown }).text);
        return text ?? undefined;
      }
    }
    return undefined;
  }
}
