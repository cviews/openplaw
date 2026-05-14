import { z } from "zod";

import type {
  ConversationDescriptor,
  QueueEvent,
  SessionRow,
  WaitFilter,
} from "../../shared/types.js";

import { normalizeOptionalLowercaseString, toText } from "../../shared/text.js";

// Re-export shared types for backward compatibility
export type {
  ApprovalDecision,
  ApprovalKind,
  ConversationDescriptor,
  PendingApproval,
  QueueEvent,
  SessionRow,
  WaitFilter,
} from "../../shared/types.js";

export {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  toText,
} from "../../shared/text.js";

// ─── Gateway Payload Types ──────────────────────────────────────────────────

export type SessionMessagePayload = {
  sessionKey?: string;
  messageId?: string;
  messageSeq?: number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  [key: string]: unknown;
};

export type SessionListResult = {
  sessions?: SessionRow[];
};

export type SessionDescribeResult = {
  session?: SessionRow | null;
};

export type ChatHistoryResult = {
  messages?: Array<{
    id?: string;
    role?: string;
    content?: unknown;
    [key: string]: unknown;
  }>;
};

// ─── MCP Serve Options ──────────────────────────────────────────────────────

export type OpenmoMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: unknown;
  verbose?: boolean;
};

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ApprovalRequestSchema = z.object({
  method: z.literal("notifications/openplaw/approval/request"),
  params: z.object({
    request_id: z.string(),
    kind: z.enum(["exec", "plugin", "route"]),
    description: z.string(),
    input_preview: z.string().optional(),
  }),
});

// ─── MCP-specific Helper Functions ──────────────────────────────────────────

export function toConversation(row: SessionRow): ConversationDescriptor | null {
  const channel = normalizeOptionalLowercaseString(row.lastChannel ?? row.channel) ?? undefined;
  const to = toText(row.lastTo);
  if (!channel || !to) {
    return null;
  }
  return {
    sessionKey: row.key,
    channel,
    to,
    conversationId: to,
    accountId: toText(row.lastAccountId) ?? undefined,
    threadId: row.lastThreadId ?? undefined,
    label: toText(row.label) ?? undefined,
    displayName: toText(row.displayName) ?? undefined,
    derivedTitle: toText(row.derivedTitle) ?? undefined,
    lastMessagePreview: toText(row.lastMessagePreview) ?? undefined,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

export function matchEventFilter(event: QueueEvent, filter: WaitFilter): boolean {
  if (event.cursor <= filter.afterCursor) {
    return false;
  }
  if (filter.sessionKey && "sessionKey" in event && event.sessionKey !== filter.sessionKey) {
    return false;
  }
  if (filter.eventType && event.type !== filter.eventType) {
    return false;
  }
  return true;
}

export function summarizeResult(
  label: string,
  count: number,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: `${label}: ${count}` }] };
}

export function summarizeStructuredResult(
  label: string,
  count: number,
  payload: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}\n\n${JSON.stringify(payload, null, 2)}` }],
  };
}

export function resolveMessageId(entry: Record<string, unknown>): string | undefined {
  return (
    toText(entry.id) ??
    (entry.__openplaw && typeof entry.__openplaw === "object"
      ? toText((entry.__openplaw as { id?: unknown }).id)
      : undefined)
  );
}

export function extractAttachmentsFromMessage(message: unknown): unknown[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return toText((entry as { type?: unknown }).type) !== "text";
  });
}

export function normalizeApprovalId(value: unknown): string | undefined {
  const id = toText(value);
  return id ? id.trim() : undefined;
}
