export type FixedWindowRateLimiterConfig = {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
};

type WindowEntry = { count: number; windowStart: number };

export function createFixedWindowRateLimiter(
  config: Partial<FixedWindowRateLimiterConfig> = {},
): {
  isRateLimited(key: string, nowMs?: number): boolean;
  size(): number;
  clear(): void;
} {
  const { windowMs = 60_000, maxRequests = 120, maxTrackedKeys = 4096 } = config;

  const store = new Map<string, WindowEntry>();

  function pruneExpired(nowMs: number): void {
    for (const [key, entry] of store) {
      if (nowMs - entry.windowStart >= windowMs) {
        store.delete(key);
      }
    }
  }

  function isRateLimited(key: string, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();

    // Prune expired entries before checking
    pruneExpired(now);

    const entry = store.get(key);

    if (entry == null || now - entry.windowStart >= windowMs) {
      // New window
      if (store.size >= maxTrackedKeys) {
        // Evict oldest entry to stay within limit
        const oldest = [...store.entries()].sort(
          (a, b) => a[1].windowStart - b[1].windowStart,
        )[0];
        if (oldest != null) store.delete(oldest[0]);
      }
      store.set(key, { count: 1, windowStart: now });
      return false;
    }

    // Existing window
    entry.count += 1;
    return entry.count > maxRequests;
  }

  function size(): number {
    return store.size;
  }

  function clear(): void {
    store.clear();
  }

  return { isRateLimited, size, clear };
}
