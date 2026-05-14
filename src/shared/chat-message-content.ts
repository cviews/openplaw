import { stripEnvelope, stripMessageIdHints } from "./chat-envelope.js";

export type AssistantPhase = "commentary" | "final_answer";

export function extractFirstTextBlock(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (message && typeof message === "object") {
    if ("text" in message && typeof message.text === "string") {
      return message.text;
    }
    if ("content" in message && typeof message.content === "string") {
      return message.content;
    }
    if ("message" in message && typeof message.message === "string") {
      return message.message;
    }
    if (Array.isArray(message)) {
      for (const item of message) {
        if (typeof item === "string") {
          return item;
        }
        const text = extractFirstTextBlock(item);
        if (text !== undefined) {
          return text;
        }
      }
    }
  }
  return undefined;
}

export function normalizeAssistantPhase(value: unknown): AssistantPhase | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "commentary" || lower === "final_answer") {
    return lower;
  }
  return undefined;
}

export function parseAssistantTextSignature(value: unknown): { id?: string; phase?: AssistantPhase } | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("sig:")) {
    return null;
  }
  const parts = trimmed.split(":").filter(p => p.length > 0);
  if (parts.length < 2) {
    return null;
  }
  const result: { id?: string; phase?: AssistantPhase } = {};
  result.id = parts[1];
  if (parts.length >= 3) {
    const phase = normalizeAssistantPhase(parts[2]);
    if (phase) {
      result.phase = phase;
    }
  }
  return result;
}

export function encodeAssistantTextSignature(params: { id: string; phase?: AssistantPhase }): string {
  if (params.phase) {
    return `sig:${params.id}:${params.phase}`;
  }
  return `sig:${params.id}`;
}

export function extractAssistantVisibleText(message: unknown): string | undefined {
  const raw = extractFirstTextBlock(message);
  if (raw === undefined) {
    return undefined;
  }
  let stripped = stripEnvelope(raw);
  stripped = stripMessageIdHints(stripped);
  return stripped.trim();
}
