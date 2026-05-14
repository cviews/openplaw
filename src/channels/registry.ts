import type { OpenmoChannelPlugin } from "../plugin-sdk/channel-contract.js";
import type { ChannelWebhookHandlers } from "../gateway/webhook-ingress.js";

const channelPlugins = new Map<string, OpenmoChannelPlugin>();
const channelWebhookHandlers = new Map<string, ChannelWebhookHandlers>();

function normalizeChannelId(channelId: string): string {
  return channelId.trim().toLowerCase();
}

export function registerChannelPlugin(plugin: OpenmoChannelPlugin): void {
  channelPlugins.set(normalizeChannelId(plugin.id), plugin);
}

export function getChannelPlugin(channelId: string): OpenmoChannelPlugin | null {
  return channelPlugins.get(normalizeChannelId(channelId)) ?? null;
}

export function listChannelPlugins(): OpenmoChannelPlugin[] {
  return [...channelPlugins.values()];
}

export function listRegisteredChannelPluginIds(): string[] {
  return [...channelPlugins.keys()];
}

export function clearChannelPlugins(): void {
  channelPlugins.clear();
  channelWebhookHandlers.clear();
}

export function registerChannelWebhookHandlers(
  channelId: string,
  handlers: ChannelWebhookHandlers,
): void {
  channelWebhookHandlers.set(normalizeChannelId(channelId), handlers);
}

export function getChannelWebhookHandlers(channelId: string): ChannelWebhookHandlers | null {
  return channelWebhookHandlers.get(normalizeChannelId(channelId)) ?? null;
}
