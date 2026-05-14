import { describe, it, expect } from "vitest";
import { toConversation, matchEventFilter } from "./channel-shared.js";
import type { SessionRow, QueueEvent, WaitFilter } from "../../shared/types.js";

describe("toConversation", () => {
  it("converts a valid SessionRow to ConversationDescriptor", () => {
    const row: SessionRow = {
      key: "agent:main:feishu:direct:user1",
      lastChannel: "feishu",
      lastTo: "chat_abc123",
      lastAccountId: "acc1",
      label: "My Chat",
      displayName: "User One",
      derivedTitle: "Chat about stuff",
      lastMessagePreview: "Hello world",
      updatedAt: 1700000000,
    };

    const result = toConversation(row);
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("agent:main:feishu:direct:user1");
    expect(result!.channel).toBe("feishu");
    expect(result!.to).toBe("chat_abc123");
    expect(result!.conversationId).toBe("chat_abc123");
    expect(result!.accountId).toBe("acc1");
    expect(result!.label).toBe("My Chat");
    expect(result!.displayName).toBe("User One");
    expect(result!.derivedTitle).toBe("Chat about stuff");
    expect(result!.lastMessagePreview).toBe("Hello world");
    expect(result!.updatedAt).toBe(1700000000);
  });

  it("falls back to channel when lastChannel is not set", () => {
    const row: SessionRow = {
      key: "sk1",
      channel: "dingtalk",
      lastTo: "chat_abc",
    };

    const result = toConversation(row);
    expect(result).not.toBeNull();
    expect(result!.channel).toBe("dingtalk");
  });

  it("returns null when lastChannel and channel are both missing", () => {
    const row: SessionRow = {
      key: "sk1",
      lastTo: "chat_abc",
    };

    const result = toConversation(row);
    expect(result).toBeNull();
  });

  it("returns null when lastTo is missing", () => {
    const row: SessionRow = {
      key: "sk1",
      lastChannel: "feishu",
    };

    const result = toConversation(row);
    expect(result).toBeNull();
  });

  it("handles empty-string channel as null", () => {
    const row: SessionRow = {
      key: "sk1",
      channel: "",
      lastTo: "chat_abc",
    };

    const result = toConversation(row);
    expect(result).toBeNull();
  });

  it("lowercases the channel name", () => {
    const row: SessionRow = {
      key: "sk1",
      lastChannel: "  FEISHU  ",
      lastTo: "chat_abc",
    };

    const result = toConversation(row);
    expect(result).not.toBeNull();
    expect(result!.channel).toBe("feishu");
  });
});

describe("matchEventFilter", () => {
  const messageEvent: QueueEvent = {
    cursor: 10,
    type: "message",
    sessionKey: "sk1",
    raw: {},
  };

  it("passes when event cursor is greater than filter afterCursor", () => {
    const filter: WaitFilter = { afterCursor: 5 };
    expect(matchEventFilter(messageEvent, filter)).toBe(true);
  });

  it("rejects when event cursor equals filter afterCursor", () => {
    const filter: WaitFilter = { afterCursor: 10 };
    expect(matchEventFilter(messageEvent, filter)).toBe(false);
  });

  it("rejects when event cursor is less than filter afterCursor", () => {
    const filter: WaitFilter = { afterCursor: 15 };
    expect(matchEventFilter(messageEvent, filter)).toBe(false);
  });

  it("filters by sessionKey", () => {
    const filter: WaitFilter = { afterCursor: 0, sessionKey: "sk1" };
    expect(matchEventFilter(messageEvent, filter)).toBe(true);
  });

  it("rejects when sessionKey does not match", () => {
    const filter: WaitFilter = { afterCursor: 0, sessionKey: "sk-other" };
    expect(matchEventFilter(messageEvent, filter)).toBe(false);
  });

  it("filters by eventType", () => {
    const filter: WaitFilter = { afterCursor: 0, eventType: "message" };
    expect(matchEventFilter(messageEvent, filter)).toBe(true);
  });

  it("rejects when eventType does not match", () => {
    const filter: WaitFilter = { afterCursor: 0, eventType: "approval_requested" };
    expect(matchEventFilter(messageEvent, filter)).toBe(false);
  });

  it("combines cursor + sessionKey + eventType filtering", () => {
    const filter: WaitFilter = { afterCursor: 5, sessionKey: "sk1", eventType: "message" };
    expect(matchEventFilter(messageEvent, filter)).toBe(true);
  });

  it("rejects when any filter condition fails", () => {
    const filter: WaitFilter = {
      afterCursor: 5,
      sessionKey: "sk1",
      eventType: "approval_requested",
    };
    expect(matchEventFilter(messageEvent, filter)).toBe(false);
  });

  it("handles approval_resolved events without sessionKey", () => {
    const event: QueueEvent = {
      cursor: 10,
      type: "approval_resolved",
      kind: "exec",
      id: "ap1",
      decision: "allow-once",
    };
    const filter: WaitFilter = { afterCursor: 5, eventType: "approval_resolved" };
    expect(matchEventFilter(event, filter)).toBe(true);
  });

  it("passes approval_resolved event when filtering by sessionKey (no sessionKey on event)", () => {
    const event: QueueEvent = {
      cursor: 10,
      type: "approval_resolved",
      kind: "exec",
      id: "ap1",
      decision: "allow-once",
    };
    const filter: WaitFilter = { afterCursor: 5, sessionKey: "sk1" };
    expect(matchEventFilter(event, filter)).toBe(true);
  });
});
