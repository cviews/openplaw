import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionBindingService } from "./session-binding.js";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn().mockRejectedValue({ code: "ENOENT" }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("node:os", () => ({
  homedir: () => "/tmp/test-home",
}));

vi.mock("node:path", () => ({
  join: (...segments: string[]) => segments.join("/"),
}));

const conversation = {
  channel: "feishu",
  accountId: "acc1",
  conversationId: "conv1",
};

describe("SessionBindingService", () => {
  let service: SessionBindingService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new SessionBindingService();
    await service.init();
  });

  it("bind + resolveBySessionKey returns the binding", async () => {
    const binding = await service.bind({
      sessionKey: "sk1",
      omoSessionId: "omo1",
      conversation,
    });
    expect(binding.sessionKey).toBe("sk1");
    expect(binding.omoSessionId).toBe("omo1");

    const resolved = service.resolveBySessionKey("sk1");
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionKey).toBe("sk1");
  });

  it("bind + resolveByOmoSessionId returns the binding", async () => {
    await service.bind({
      sessionKey: "sk2",
      omoSessionId: "omo2",
      conversation,
    });

    const resolved = service.resolveByOmoSessionId("omo2");
    expect(resolved).not.toBeNull();
    expect(resolved!.omoSessionId).toBe("omo2");
  });

  it("resolveByConversation returns the binding", async () => {
    await service.bind({
      sessionKey: "sk3",
      omoSessionId: "omo3",
      conversation,
    });

    const resolved = service.resolveByConversation(conversation);
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionKey).toBe("sk3");
  });

  it("resolveByConversation returns null for non-existent conversation", () => {
    const resolved = service.resolveByConversation({
      channel: "feishu",
      accountId: "acc1",
      conversationId: "nonexistent",
    });
    expect(resolved).toBeNull();
  });

  it("TTL expiry causes resolveByConversation to return null", async () => {
    await service.bind({
      sessionKey: "sk-expired",
      omoSessionId: "omo-expired",
      conversation,
    });

    // Manually expire the binding by setting boundAt far in the past
    // Access internal bindings map to tamper with TTL
    // We'll re-bind with a very short TTL by tampering after bind
    const internalBindings = (
      service as unknown as {
        bindings: Map<
          string,
          { boundAt: number; ttlMs: number; conversation: typeof conversation }
        >;
      }
    ).bindings;
    for (const [, rec] of internalBindings) {
      rec.boundAt = Date.now() - 100_000;
      rec.ttlMs = 1;
    }

    expect(service.resolveByConversation(conversation)).toBeNull();
  });

  it("TTL expiry causes resolveBySessionKey to return null", async () => {
    await service.bind({
      sessionKey: "sk-exp2",
      omoSessionId: "omo-exp2",
      conversation,
    });

    const internalBindings = (
      service as unknown as { bindings: Map<string, { boundAt: number; ttlMs: number }> }
    ).bindings;
    for (const [, rec] of internalBindings) {
      rec.boundAt = Date.now() - 100_000;
      rec.ttlMs = 1;
    }

    expect(service.resolveBySessionKey("sk-exp2")).toBeNull();
  });

  it("unbind removes the binding by conversation", async () => {
    await service.bind({
      sessionKey: "sk-unbind",
      omoSessionId: "omo-unbind",
      conversation,
    });

    const removed = await service.unbind({ conversation });
    expect(removed.length).toBe(1);
    expect(removed[0].sessionKey).toBe("sk-unbind");

    expect(service.resolveByConversation(conversation)).toBeNull();
  });

  it("unbind removes the binding by sessionKey", async () => {
    await service.bind({
      sessionKey: "sk-unbind2",
      omoSessionId: "omo-unbind2",
      conversation,
    });

    const removed = await service.unbind({ sessionKey: "sk-unbind2" });
    expect(removed.length).toBe(1);

    expect(service.resolveBySessionKey("sk-unbind2")).toBeNull();
  });

  it("touch updates lastActivityAt", async () => {
    const binding = await service.bind({
      sessionKey: "sk-touch",
      omoSessionId: "omo-touch",
      conversation,
    });
    const originalActivity = binding.lastActivityAt;

    // Wait a tiny bit to ensure different timestamp
    const newTs = originalActivity + 1000;
    await service.touch(binding.bindingId, newTs);

    const resolved = service.resolveBySessionKey("sk-touch");
    expect(resolved!.lastActivityAt).toBe(newTs);
    expect(resolved!.lastActivityAt).not.toBe(originalActivity);
  });

  it("resolveByOmoSessionId returns null for unknown id", () => {
    expect(service.resolveByOmoSessionId("nonexistent")).toBeNull();
  });

  it("resolveBySessionKey returns null for unknown key", () => {
    expect(service.resolveBySessionKey("nonexistent")).toBeNull();
  });

  it("unbind with no match returns empty array", async () => {
    const removed = await service.unbind({ sessionKey: "nothing" });
    expect(removed).toEqual([]);
  });
});
