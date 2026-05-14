export type ConversationDescriptor = {
  sessionKey: string;
  channel: string;
  to: string;
  conversationId: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

export type SessionRow = {
  key: string;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

export type ApprovalKind = "exec" | "plugin" | "route";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type PendingApproval = {
  kind: ApprovalKind;
  id: string;
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
};

export type QueueEvent =
  | {
      cursor: number;
      type: "message";
      sessionKey: string;
      conversation?: ConversationDescriptor;
      messageId?: string;
      messageSeq?: number;
      role?: string;
      text?: string;
      raw: Record<string, unknown>;
    }
  | {
      cursor: number;
      type: "approval_requested";
      kind: ApprovalKind;
      id: string;
      request?: Record<string, unknown>;
      createdAtMs?: number;
      expiresAtMs?: number;
    }
  | {
      cursor: number;
      type: "approval_resolved";
      kind: ApprovalKind;
      id: string;
      decision: ApprovalDecision;
    }
  | {
      cursor: number;
      type: "route_to_bot";
      sessionKey: string;
      fromBot: string;
      toBot: string;
      message: string;
      visible: boolean;
      conversation?: ConversationDescriptor;
    };

export type WaitFilter = {
  afterCursor: number;
  sessionKey?: string;
  eventType?: QueueEvent["type"];
};
