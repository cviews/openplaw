import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionBindingService } from "./session-binding.js";
import type { OpenmoChannelPlugin } from "../../plugin-sdk/channel-contract.js";
import type { GroupResolver } from "./group-resolver.js";
import type { BotCredentialsRegistry } from "../../extensions/feishu/index.js";

const s = tool.schema;

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;

type RouteToBotArgs = {
  target: string;
  message: string;
  visible: boolean;
  wait_for_result: boolean;
};

function classifyError(error: unknown): { type: string; message: string; template: string } {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: number })?.code;

  if (errorMsg.includes("quota") || errorMsg.includes("insufficient_quota") || errorCode === 402) {
    return { type: "quota", message: errorMsg, template: "API额度已用完，请联系管理员增加额度" };
  }

  if (errorCode === 429 || errorMsg.includes("rate limit") || errorMsg.includes("rate_limit")) {
    return { type: "rate_limit", message: errorMsg, template: "API调用频率过高，正在重试中..." };
  }

  if (
    errorCode === 500 ||
    errorCode === 503 ||
    errorMsg.includes("internal server error") ||
    errorMsg.includes("service unavailable")
  ) {
    return { type: "service_error", message: errorMsg, template: "AI服务暂时不可用，请稍后再试" };
  }

  if (errorMsg.includes("connection refused") || errorMsg.includes("ECONNREFUSED")) {
    return { type: "connection", message: errorMsg, template: "AI服务连接失败" };
  }

  return { type: "unknown", message: errorMsg, template: `处理失败: ${errorMsg}` };
}

function classifyErrorFromPromptResult(error: unknown): { type: string; message: string; template: string } {
  const errorStr = typeof error === "string" ? error : JSON.stringify(error);
  const errorMsg = errorStr;

  if (errorMsg.includes("quota") || errorMsg.includes("insufficient_quota")) {
    return { type: "quota", message: errorMsg, template: "API额度已用完，请联系管理员增加额度" };
  }

  if (errorMsg.includes("rate limit") || errorMsg.includes("rate_limit")) {
    return { type: "rate_limit", message: errorMsg, template: "API调用频率过高，正在重试中..." };
  }

  if (errorMsg.includes("internal server error") || errorMsg.includes("service unavailable")) {
    return { type: "service_error", message: errorMsg, template: "AI服务暂时不可用，请稍后再试" };
  }

  if (errorMsg.includes("connection refused") || errorMsg.includes("ECONNREFUSED")) {
    return { type: "connection", message: errorMsg, template: "AI服务连接失败" };
  }

  return { type: "unknown", message: errorMsg, template: `处理失败: ${errorMsg}` };
}

async function extractAIContentFromSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<string> {
  try {
    const messagesResult = await client.session.messages({ sessionID: sessionId } as any);
    if (!messagesResult.data) return "";

    const parts: string[] = [];
    for (const msg of messagesResult.data) {
      if (msg.info.role === "assistant") {
        for (const part of msg.parts) {
          if (part.type === "text") {
            parts.push(part.text);
          }
        }
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

export function createRouteToBotTool(deps: {
  client: OpencodeClient;
  sessionBinding: SessionBindingService;
  groupResolver: GroupResolver;
  botRegistry: BotCredentialsRegistry;
  getChannel: (channelId: string) => OpenmoChannelPlugin | null;
}): ReturnType<typeof tool> {
  const { client, sessionBinding, groupResolver, botRegistry, getChannel } = deps;
  const availableBots = botRegistry.getAllBotIds().join(", ");

  return tool({
    description: `Call another bot (agent) in the current group chat with visible @mention routing.

Available bots: ${availableBots}

Use this tool to delegate sub-tasks to specialized bots. The delegation will be visible in the group chat via @mention messages from the target bot's identity, and actual AI content will be returned.

Parameters:
- target: The bot ID to call (e.g., "oracle", "explore", "librarian")
- message: Clear task description with sufficient context for the target agent
- visible: Whether to show @mention messages in the group chat (default: true)
- wait_for_result: Whether to wait for the result (default: true)`,

    args: {
      target: s.string().min(1).describe("Bot ID to call (from available bots list)"),
      message: s.string().min(1).describe("Task description to send to the target agent"),
      visible: s.boolean().default(true).describe("Show @mention in group chat"),
      wait_for_result: s.boolean().default(true).describe("Wait for completion before returning"),
    },

    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const { target, message, visible, wait_for_result } = args as RouteToBotArgs;

      const targetBotConfig = botRegistry.getBotConfig(target);
      if (!targetBotConfig) {
        return `Error: Bot "${target}" not found. Available bots: ${botRegistry.getAllBotIds().join(", ") || "(none configured)"}`;
      }

      const binding = sessionBinding.resolveByOmoSessionId(ctx.sessionID);
      const callingBotId = binding?.conversation.accountId ?? "default";
      const callingBotConfig = botRegistry.getBotConfig(callingBotId);

      const chatId = binding?.conversation.conversationId ?? "";
      const targetInGroup = chatId ? groupResolver.isBotInGroup(target, chatId) : false;
      const canBeVisible = visible && targetInGroup && binding !== null;
      const channel = binding ? getChannel(binding.conversation.channel) : null;

      const targetDisplayName = targetBotConfig.botName;

      let childSessionID: string;
      try {
        const createResult = await client.session.create(
          { parentID: ctx.sessionID } as any,
        );
        if (!createResult.data) {
          const errorDetail = `status: ${createResult.response.status}`;
          if (canBeVisible && channel) {
            await channel.outbound.sendText({
              to: binding!.conversation.conversationId,
              text: `❌ ${targetDisplayName} 会话创建失败: ${errorDetail}`,
              botId: callingBotId,
            });
          }
          return `Error: Failed to create child session for "${target}": ${errorDetail}`;
        }
        childSessionID = createResult.data.id;
      } catch (err) {
        const classified = classifyError(err);
        if (canBeVisible && channel) {
          await channel.outbound.sendText({
            to: binding!.conversation.conversationId,
            text: `❌ ${targetDisplayName} ${classified.template}`,
            botId: callingBotId,
          });
        }
        return `Error: ${classified.template}`;
      }

      if (binding) {
        try {
          await sessionBinding.bind({
            sessionKey: `route_to_bot:${target}:${childSessionID}`,
            omoSessionId: childSessionID,
            conversation: binding.conversation,
          });
        } catch {
          // Best-effort binding, non-fatal
        }
      }

      try {
        const promptResult = await client.session.promptAsync({
          sessionID: childSessionID,
          agent: targetBotConfig.agent,
          parts: [{ type: "text" as const, text: message }],
        } as any);
        if (promptResult.error) {
          const classified = classifyErrorFromPromptResult(promptResult.error);
          const errorText = `❌ ${targetDisplayName} ${classified.template}`;

          if (canBeVisible && channel) {
            await channel.outbound.sendText({
              to: binding!.conversation.conversationId,
              text: errorText,
              botId: target,
            });
          }
          return errorText;
        }
      } catch (err) {
        const classified = classifyError(err);
        if (canBeVisible && channel) {
          await channel.outbound.sendText({
            to: binding!.conversation.conversationId,
            text: `❌ ${targetDisplayName} ${classified.template}`,
            botId: target,
          });
        }
        return `Error: ${classified.template}`;
      }

      if (!wait_for_result) {
        if (canBeVisible && channel) {
          await channel.outbound.sendMention({
            to: binding!.conversation.conversationId,
            botName: callingBotConfig?.botName ?? callingBotId,
            text: `⏳ ${targetDisplayName} 正在处理...`,
            botId: callingBotId,
          });
        }
        return `Delegated to ${targetDisplayName} (session: ${childSessionID}). Processing asynchronously.`;
      }

      const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;
      let completed = false;

      while (Date.now() < deadline) {
        try {
          const statusResult = await client.session.status();
          if (statusResult.data) {
            const sessionStatus = statusResult.data[childSessionID];
            if (sessionStatus?.type === "idle") {
              completed = true;
              break;
            }
          }
        } catch {
          // Continue polling on transient errors
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        if (ctx.abort.aborted) {
          return `Delegated to ${targetDisplayName} (session: ${childSessionID}) — aborted while waiting.`;
        }
      }

      const aiContent = await extractAIContentFromSession(client, childSessionID);

      if (canBeVisible && channel) {
        if (!completed) {
          const partial = aiContent ? `\n部分结果:\n${aiContent}` : "";
          await channel.outbound.sendText({
            to: binding!.conversation.conversationId,
            text: `⚠️ ${targetDisplayName} 处理超时${partial}`,
            botId: target,
          });
        } else if (aiContent) {
          await channel.outbound.sendMention({
            to: binding!.conversation.conversationId,
            botName: targetDisplayName,
            text: aiContent,
            botId: target,
            mentionUserId: callingBotConfig?.appId,
          });
        } else {
          await channel.outbound.sendText({
            to: binding!.conversation.conversationId,
            text: `❌ ${targetDisplayName} 完成但无输出`,
            botId: target,
          });
        }
      }

      if (!completed) {
        const partial = aiContent ? `\n\nPartial result:\n${aiContent}` : "";
        return `Warning: Timed out waiting for ${targetDisplayName}.${partial}`;
      }
      if (!aiContent) return `${targetDisplayName} completed but returned no output.`;
      return aiContent;
    },
  });
}
