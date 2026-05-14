import { describe, it, expect } from "vitest";
import { createFixedWindowRateLimiter } from "./rate-limiter.js";

describe("createFixedWindowRateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 3 });
    expect(limiter.isRateLimited("key1", 0)).toBe(false);
    expect(limiter.isRateLimited("key1", 100)).toBe(false);
    expect(limiter.isRateLimited("key1", 200)).toBe(false);
  });

  it("blocks requests over the limit", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });
    expect(limiter.isRateLimited("key1", 0)).toBe(false);
    expect(limiter.isRateLimited("key1", 100)).toBe(false);
    expect(limiter.isRateLimited("key1", 200)).toBe(true);
  });

  it("resets the window after windowMs has passed", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });
    expect(limiter.isRateLimited("key1", 0)).toBe(false);
    expect(limiter.isRateLimited("key1", 500)).toBe(false);
    expect(limiter.isRateLimited("key1", 500)).toBe(true);
    expect(limiter.isRateLimited("key1", 1001)).toBe(false);
  });

  it("tracks different keys independently", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.isRateLimited("key1", 0)).toBe(false);
    expect(limiter.isRateLimited("key2", 0)).toBe(false);
    expect(limiter.isRateLimited("key1", 100)).toBe(true);
    expect(limiter.isRateLimited("key2", 100)).toBe(true);
  });

  it("prunes expired entries", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 5, maxTrackedKeys: 100 });
    limiter.isRateLimited("key1", 0);
    limiter.isRateLimited("key2", 0);
    expect(limiter.size()).toBe(2);
    limiter.isRateLimited("key3", 2000);
    expect(limiter.size()).toBe(1);
  });

  it("enforces maxTrackedKeys", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 10000, maxRequests: 5, maxTrackedKeys: 2 });
    limiter.isRateLimited("key1", 0);
    limiter.isRateLimited("key2", 0);
    limiter.isRateLimited("key3", 100);
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  it("clear() resets all state", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.isRateLimited("key1", 0);
    expect(limiter.size()).toBe(1);
    limiter.clear();
    expect(limiter.size()).toBe(0);
    expect(limiter.isRateLimited("key1", 0)).toBe(false);
  });

  it("uses default config values when no config provided", () => {
    const limiter = createFixedWindowRateLimiter();
    for (let i = 0; i < 120; i++) {
      expect(limiter.isRateLimited("key1", i * 10)).toBe(false);
    }
    expect(limiter.isRateLimited("key1", 1200)).toBe(true);
  });
});
