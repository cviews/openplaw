import type { SessionBindingService } from "../routing/session-binding.js";
import type { OpenmoChannelPlugin } from "../../plugin-sdk/channel-contract.js";

type BeforeInput = { tool: string; sessionID: string; callID: string };
type BeforeOutput = { args: Record<string, unknown> };
type AfterInput = { tool: string; sessionID: string; callID: string; args: Record<string, unknown> };
type AfterOutput = { title: string; output: string; metadata: Record<string, unknown> };

function resolveAgentName(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "call_omo_agent") {
    return typeof args.subagent_type === "string" ? args.subagent_type : undefined;
  }
  if (tool === "route_to_bot") {
    return typeof args.target === "string" ? args.target : undefined;
  }
  return undefined;
}

async function sendNotification(
  channel: OpenmoChannelPlugin,
  params: {
    to: string;
    botDisplayName: string;
    text: string;
    accountId?: string;
  },
): Promise<void> {
  try {
    await channel.outbound.sendMention({
      to: params.to,
      botName: params.botDisplayName,
      text: params.text,
    });
  } catch {
    try {
      await channel.outbound.sendText({
        to: params.to,
        text: params.text,
        accountId: params.accountId,
      });
    } catch {
      // sendMention → sendText degradation: both failed, swallow
    }
  }
}

export function createVisibilityHandlers(deps: {
  sessionBinding: SessionBindingService;
  getChannel: (channelId: string) => OpenmoChannelPlugin | null;
  botAgentMap: Record<string, string>;
}) {
  const { sessionBinding, getChannel, botAgentMap } = deps;

  const before = async (input: BeforeInput, output: BeforeOutput): Promise<void> => {
    try {
      if (input.tool !== "call_omo_agent") return;

      const agentKey = resolveAgentName(input.tool, output.args);
      if (!agentKey) return;

      const binding = sessionBinding.resolveByOmoSessionId(input.sessionID);
      if (!binding) return;

      const channel = getChannel(binding.conversation.channel);
      if (!channel) return;

      const botDisplayName = botAgentMap[agentKey] ?? agentKey;
      const text = `⏳ 正在咨询 ${botDisplayName}...`;

      await sendNotification(channel, {
        to: binding.conversation.conversationId,
        botDisplayName,
        text,
        accountId: binding.conversation.accountId,
      });
    } catch {
      // Never throw from hooks — swallow all errors
    }
  };

  const after = async (input: AfterInput, output: AfterOutput): Promise<void> => {
    try {
      if (input.tool !== "call_omo_agent") return;

      const args = (output.metadata?.args as Record<string, unknown> | undefined) ?? {};
      const agentKey = resolveAgentName(input.tool, args);
      if (!agentKey) return;

      const binding = sessionBinding.resolveByOmoSessionId(input.sessionID);
      if (!binding) return;

      const channel = getChannel(binding.conversation.channel);
      if (!channel) return;

      const botDisplayName = botAgentMap[agentKey] ?? agentKey;
      const text = `✅ ${botDisplayName} 已完成分析`;

      await sendNotification(channel, {
        to: binding.conversation.conversationId,
        botDisplayName,
        text,
        accountId: binding.conversation.accountId,
      });
    } catch {
      // Never throw from hooks — swallow all errors
    }
  };

  return { before, after };
}
