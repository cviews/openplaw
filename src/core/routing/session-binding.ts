import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOpenmoDir } from "../../config/loader.js";

export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export type SessionResetConfig = {
  daily: boolean;       // default true - reset at 4:00 AM local time
  idleMinutes: number;  // default 0 (disabled) - reset after N minutes idle
};

export type SessionBindingRecord = {
  bindingId: string;
  sessionKey: string;
  omoSessionId: string;
  pastOmoSessionIds: string[];      // archived past session IDs (most recent first, max 5)
  conversation: ConversationRef;
  boundAt: number;
  sessionStartedAt?: number;        // when current session actually started (for daily reset)
  lastActivityAt: number;
  lastInteractionAt?: number;       // last real user/channel interaction (for idle reset)
  ttlMs: number;                    // backward compat, but reset logic uses daily/idle
};

const BINDINGS_DIR = path.join(resolveOpenmoDir(), "bindings");
const BINDINGS_FILE = path.join(BINDINGS_DIR, "current-conversations.json");

// Next 4:00 AM after sessionStart (or same day if before 4:00 AM)
function nextDailyResetAt(sessionStart: number): number {
  const d = new Date(sessionStart);
  if (d.getHours() >= 4) d.setDate(d.getDate() + 1);
  d.setHours(4, 0, 0, 0);
  return d.getTime();
}

export class SessionBindingService {
  private bindings: Map<string, SessionBindingRecord> = new Map();
  private initialized = false;
  private resetConfig: SessionResetConfig;

  constructor(resetConfig?: SessionResetConfig) {
    this.resetConfig = resetConfig ?? { daily: true, idleMinutes: 0 };
  }

  shouldReset(binding: SessionBindingRecord): boolean {
    if (this.resetConfig.daily) {
      const sessionStart = binding.sessionStartedAt ?? binding.boundAt;
      if (Date.now() >= nextDailyResetAt(sessionStart)) return true;
    }
    if (this.resetConfig.idleMinutes > 0) {
      const lastInteraction = binding.lastInteractionAt ?? binding.lastActivityAt;
      const idleMs = this.resetConfig.idleMinutes * 60_000;
      if (Date.now() >= lastInteraction + idleMs) return true;
    }
    return false;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    let records: SessionBindingRecord[] = [];
    try {
      const data = await fs.promises.readFile(BINDINGS_FILE, "utf-8");
      const parsed: unknown = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        throw new Error("Expected JSON array at top level");
      }
      records = parsed as SessionBindingRecord[];
    } catch (err: unknown) {
      if (isNodeJsError(err) && err.code === "ENOENT") {
        // no bindings file yet, start fresh
      } else if (err instanceof SyntaxError) {
        console.warn(
          `[SessionBinding] Corrupt JSON in ${BINDINGS_FILE}, starting with empty bindings:`,
          (err as SyntaxError).message,
        );
      } else {
        console.warn(
          `[SessionBinding] Failed to read ${BINDINGS_FILE}, starting with empty bindings:`,
          err,
        );
      }
    }

    const now = Date.now();
    this.bindings.clear();
    for (const record of records) {
      // Backward compat: populate missing fields from loaded JSON
      if (!record.pastOmoSessionIds) record.pastOmoSessionIds = [];

      const expired = this.resetConfig.daily || this.resetConfig.idleMinutes > 0
        ? this.shouldReset(record)
        : now >= record.boundAt + record.ttlMs;
      if (!expired) {
        const key = this.buildConversationKey(record.conversation);
        this.bindings.set(key, record);
      }
    }

    this.initialized = true;
  }

  async save(): Promise<void> {
    const records = Array.from(this.bindings.values());
    const json = JSON.stringify(records, null, 2);

    try {
      await fs.promises.mkdir(BINDINGS_DIR, { recursive: true });
    } catch (err: unknown) {
      if (isNodeJsError(err) && err.code !== "EEXIST") {
        console.warn(`[SessionBinding] Failed to create directory ${BINDINGS_DIR}:`, err);
        throw err;
      }
    }

    const tmpFile = path.join(BINDINGS_DIR, `.current-conversations.json.tmp.${process.pid}`);
    try {
      await fs.promises.writeFile(tmpFile, json, "utf-8");
      await fs.promises.rename(tmpFile, BINDINGS_FILE);
    } catch (err: unknown) {
      try {
        await fs.promises.unlink(tmpFile);
      } catch { /* best-effort cleanup */ }
      console.warn(`[SessionBinding] Failed to save bindings to ${BINDINGS_FILE}:`, err);
      throw err;
    }
  }

  peekByConversation(ref: ConversationRef): SessionBindingRecord | null {
    const key = this.buildConversationKey(ref);
    return this.bindings.get(key) ?? null;
  }

  resolveByConversation(ref: ConversationRef): SessionBindingRecord | null {
    const key = this.buildConversationKey(ref);
    const binding = this.bindings.get(key);
    if (!binding) return null;
    if (!this.shouldReset(binding)) return binding;
    this.bindings.delete(key);
    return null;
  }

  resolveBySessionKey(sessionKey: string): SessionBindingRecord | null {
    for (const binding of this.bindings.values()) {
      if (binding.sessionKey === sessionKey) {
        if (!this.shouldReset(binding)) return binding;
        const key = this.buildConversationKey(binding.conversation);
        this.bindings.delete(key);
        return null;
      }
    }
    return null;
  }

  resolveByOmoSessionId(omoSessionId: string): SessionBindingRecord | null {
    for (const binding of this.bindings.values()) {
      if (binding.omoSessionId === omoSessionId) {
        if (!this.shouldReset(binding)) return binding;
        const key = this.buildConversationKey(binding.conversation);
        this.bindings.delete(key);
        return null;
      }
    }
    return null;
  }

  async bind(input: {
    sessionKey: string;
    omoSessionId: string;
    conversation: ConversationRef;
  }): Promise<SessionBindingRecord> {
    const key = this.buildConversationKey(input.conversation);
    const binding: SessionBindingRecord = {
      bindingId: `bnd_${Date.now()}`,
      sessionKey: input.sessionKey,
      omoSessionId: input.omoSessionId,
      pastOmoSessionIds: [],
      conversation: input.conversation,
      boundAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastActivityAt: Date.now(),
      lastInteractionAt: Date.now(),
      ttlMs: 24 * 60 * 60 * 1000,
    };
    this.bindings.set(key, binding);
    await this.save();
    return binding;
  }

  async touch(bindingId: string, at?: number): Promise<void> {
    const ts = at ?? Date.now();
    for (const binding of this.bindings.values()) {
      if (binding.bindingId === bindingId) {
        binding.lastActivityAt = ts;
        binding.lastInteractionAt = ts;
      }
    }
    await this.save();
  }

  async updateOmoSessionId(bindingId: string, omoSessionId: string): Promise<SessionBindingRecord | null> {
    for (const binding of this.bindings.values()) {
      if (binding.bindingId === bindingId) {
        const wasPlaceholder = binding.omoSessionId.startsWith("agent:");
        binding.omoSessionId = omoSessionId;
        binding.lastActivityAt = Date.now();
        if (wasPlaceholder) {
          binding.sessionStartedAt = Date.now();
        }
        await this.save();
        return binding;
      }
    }
    return null;
  }

  async archiveCurrentSession(bindingId: string): Promise<void> {
    for (const binding of this.bindings.values()) {
      if (binding.bindingId === bindingId) {
        if (!binding.omoSessionId.startsWith("agent:")) {
          binding.pastOmoSessionIds = [binding.omoSessionId, ...binding.pastOmoSessionIds].slice(0, 5);
        }
        binding.omoSessionId = binding.sessionKey;
        delete binding.sessionStartedAt;
        delete binding.lastInteractionAt;
        await this.save();
        return;
      }
    }
  }

  async unbind(input: {
    sessionKey?: string;
    conversation?: ConversationRef;
  }): Promise<SessionBindingRecord[]> {
    const removed: SessionBindingRecord[] = [];

    if (input.conversation) {
      const key = this.buildConversationKey(input.conversation);
      const binding = this.bindings.get(key);
      if (binding) {
        removed.push(binding);
        this.bindings.delete(key);
      }
    }

    if (input.sessionKey) {
      for (const [key, binding] of this.bindings.entries()) {
        if (binding.sessionKey === input.sessionKey) {
          removed.push(binding);
          this.bindings.delete(key);
        }
      }
    }

    if (removed.length > 0) {
      await this.save();
    }

    return removed;
  }

  async dispose(): Promise<void> {
    try {
      await this.save();
    } catch { /* best-effort persist on dispose */ }
    this.bindings.clear();
    this.initialized = false;
  }

  private buildConversationKey(ref: ConversationRef): string {
    return [ref.channel, ref.accountId, ref.parentConversationId ?? "", ref.conversationId].join(
      "\u241f",
    );
  }
}

export function buildAgentPeerSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string;
  peerKind?: "group" | "direct" | "channel";
  peerId?: string;
  threadId?: string;
}): string {
  const agentId = params.agentId.trim().toLowerCase() || "main";
  const channel = params.channel.trim().toLowerCase() || "unknown";
  const peerKind = params.peerKind ?? "direct";
  const peerId = params.peerId?.trim().toLowerCase() || "unknown";

  const base = `agent:${agentId}:${channel}:${peerKind}:${peerId}`;
  if (params.threadId?.trim()) {
    return `${base}:thread:${params.threadId.trim().toLowerCase()}`;
  }
  return base;
}

function isNodeJsError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
