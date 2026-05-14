import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpenmoChannelBridge } from "./channel-bridge.js";
import {
  extractAttachmentsFromMessage,
  resolveMessageId,
  summarizeResult,
  summarizeStructuredResult,
  toText,
} from "../shared/channel-shared.js";

export function registerChannelMcpTools(server: McpServer, bridge: OpenmoChannelBridge): void {
  server.tool(
    "conversations_list",
    "List openplaw channel-backed conversations (Feishu/DingTalk bot sessions).",
    {
      limit: z.number().int().min(1).max(500).optional(),
      search: z.string().optional(),
      channel: z.string().optional(),
      includeDerivedTitles: z.boolean().optional(),
      includeLastMessage: z.boolean().optional(),
    },
    async (args) => {
      const conversations = await bridge.listConversations(args);
      return {
        ...summarizeStructuredResult("conversations", conversations.length, { conversations }),
        structuredContent: { conversations },
      };
    },
  );

  server.tool(
    "conversation_get",
    "Get one openplaw conversation by session key.",
    { session_key: z.string().min(1) },
    async ({ session_key }) => {
      const conversation = await bridge.getConversation(session_key);
      if (!conversation) {
        return {
          content: [{ type: "text", text: `conversation not found: ${session_key}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `conversation ${conversation.sessionKey}` }],
        structuredContent: { conversation },
      };
    },
  );

  server.tool(
    "messages_read",
    "Read recent messages for one openplaw conversation.",
    {
      session_key: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 20);
      return {
        ...summarizeStructuredResult("messages", messages.length, { messages }),
        structuredContent: { messages },
      };
    },
  );

  server.tool(
    "attachments_fetch",
    "List non-text attachments for a message in one openplaw conversation.",
    {
      session_key: z.string().min(1),
      message_id: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, message_id, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 100);
      const message = messages.find((entry) => resolveMessageId(entry) === message_id);
      if (!message) {
        return {
          content: [{ type: "text", text: `message not found: ${message_id}` }],
          isError: true,
        };
      }
      const attachments = extractAttachmentsFromMessage(message);
      return {
        ...summarizeResult("attachments", attachments.length),
        structuredContent: { attachments, message },
      };
    },
  );

  server.tool(
    "events_poll",
    "Poll queued openplaw conversation events since a cursor.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ after_cursor, session_key, limit }) => {
      const { events, nextCursor } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit ?? 20,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: { events, next_cursor: nextCursor },
      };
    },
  );

  server.tool(
    "events_wait",
    "Wait for the next queued openplaw conversation event.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      timeout_ms: z.number().int().min(1).max(300_000).optional(),
    },
    async ({ after_cursor, session_key, timeout_ms }) => {
      const event = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms ?? 30_000,
      );
      return {
        content: [{ type: "text", text: event ? `event ${event.cursor}` : "timeout" }],
        structuredContent: { event },
      };
    },
  );

  server.tool(
    "messages_send",
    "Send a message back through the same openplaw conversation route.",
    {
      session_key: z.string().min(1),
      text: z.string().min(1),
    },
    async ({ session_key, text }) => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ type: "text", text: "sent" }],
        structuredContent: { result },
      };
    },
  );

  server.tool(
    "approvals_list_open",
    "List open exec, plugin, or route approval requests.",
    {},
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
    },
  );

  server.tool(
    "approvals_respond",
    "Allow or deny one pending approval request.",
    {
      kind: z.enum(["exec", "plugin", "route"]),
      id: z.string().min(1),
      decision: z.enum(["allow-once", "allow-always", "deny"]),
    },
    async ({ kind, id, decision }) => {
      const result = await bridge.respondToApproval({ kind, id, decision });
      return {
        content: [{ type: "text", text: "approval resolved" }],
        structuredContent: { result },
      };
    },
  );

  server.tool(
    "route_to_bot",
    "Route a message to another bot in the same group chat. Visibility depends on whether the target bot is in the group.",
    {
      session_key: z.string().min(1),
      target: z.string().min(1),
      message: z.string().min(1),
      visible: z.boolean().default(true),
    },
    async ({ session_key, target, message, visible }) => {
      const result = await bridge.routeToBot({
        sessionKey: session_key,
        target,
        message,
        visible,
      });
      return {
        content: [
          {
            type: "text",
            text: result.success ? `routed to ${target}` : `route failed: ${result.error}`,
          },
        ],
        structuredContent: { result },
      };
    },
  );
}
