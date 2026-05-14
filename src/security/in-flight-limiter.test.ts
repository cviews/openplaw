import { describe, it, expect } from "vitest";
import { createWebhookInFlightLimiter } from "./in-flight-limiter.js";

describe("createWebhookInFlightLimiter", () => {
  it("acquires and tracks active count", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 3 });
    expect(limiter.tryAcquire("key1")).toBe(true);
    expect(limiter.activeCount("key1")).toBe(1);
    expect(limiter.tryAcquire("key1")).toBe(true);
    expect(limiter.activeCount("key1")).toBe(2);
  });

  it("blocks at max in-flight", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 2 });
    expect(limiter.tryAcquire("key1")).toBe(true);
    expect(limiter.tryAcquire("key1")).toBe(true);
    expect(limiter.tryAcquire("key1")).toBe(false);
  });

  it("releases and allows re-acquire", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 2 });
    limiter.tryAcquire("key1");
    limiter.tryAcquire("key1");
    expect(limiter.tryAcquire("key1")).toBe(false);
    limiter.release("key1");
    expect(limiter.activeCount("key1")).toBe(1);
    expect(limiter.tryAcquire("key1")).toBe(true);
  });

  it("removes key from tracking when count reaches zero", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 2 });
    limiter.tryAcquire("key1");
    limiter.release("key1");
    expect(limiter.activeCount("key1")).toBe(0);
    expect(limiter.size()).toBe(0);
  });

  it("tracks different keys independently", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 1 });
    expect(limiter.tryAcquire("key1")).toBe(true);
    expect(limiter.tryAcquire("key2")).toBe(true);
    expect(limiter.tryAcquire("key1")).toBe(false);
    expect(limiter.tryAcquire("key2")).toBe(false);
  });

  it("release on non-existent key is a no-op", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 2 });
    expect(() => limiter.release("nonexistent")).not.toThrow();
  });

  it("clear() resets all state", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 5 });
    limiter.tryAcquire("key1");
    limiter.tryAcquire("key2");
    limiter.clear();
    expect(limiter.size()).toBe(0);
    expect(limiter.activeCount("key1")).toBe(0);
  });

  it("size() returns number of tracked keys", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 5 });
    expect(limiter.size()).toBe(0);
    limiter.tryAcquire("key1");
    expect(limiter.size()).toBe(1);
    limiter.tryAcquire("key2");
    expect(limiter.size()).toBe(2);
  });

  it("enforces maxTrackedKeys", () => {
    const limiter = createWebhookInFlightLimiter({ maxInFlightPerKey: 5, maxTrackedKeys: 2 });
    limiter.tryAcquire("key1");
    limiter.tryAcquire("key2");
    limiter.tryAcquire("key3");
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  it("uses default config values when no config provided", () => {
    const limiter = createWebhookInFlightLimiter();
    for (let i = 0; i < 8; i++) {
      expect(limiter.tryAcquire("key1")).toBe(true);
    }
    expect(limiter.tryAcquire("key1")).toBe(false);
  });
});
