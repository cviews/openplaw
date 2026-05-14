export type WebhookInFlightLimiterConfig = {
  /** Maximum concurrent in-flight requests per key. @default 8 */
  maxInFlightPerKey?: number;
  /** Maximum number of distinct keys tracked. @default 4096 */
  maxTrackedKeys?: number;
};

export function createWebhookInFlightLimiter(config?: WebhookInFlightLimiterConfig) {
  const maxInFlightPerKey = config?.maxInFlightPerKey ?? 8;
  const maxTrackedKeys = config?.maxTrackedKeys ?? 4096;

  const store = new Map<string, number>();

  return {
    /**
     * Try to acquire a slot for the given key.
     * Returns `true` if acquired (under the limit), `false` if rejected.
     */
    tryAcquire(key: string): boolean {
      const current = store.get(key) ?? 0;
      if (current >= maxInFlightPerKey) return false;

      if (current === 0 && store.size >= maxTrackedKeys) {
        // Evict a key with zero count (shouldn't exist but safety net)
        let evictKey: string | null = null;
        for (const [k, v] of store) {
          if (v === 0) {
            evictKey = k;
            break;
          }
        }
        if (evictKey != null) {
          store.delete(evictKey);
        } else {
          // All keys are active, reject
          return false;
        }
      }

      store.set(key, current + 1);
      return true;
    },

    /** Release a slot for the given key. */
    release(key: string): void {
      const current = store.get(key);
      if (current == null) return;
      if (current <= 1) {
        store.delete(key);
      } else {
        store.set(key, current - 1);
      }
    },

    /** Get the current number of in-flight requests for a key. */
    activeCount(key: string): number {
      return store.get(key) ?? 0;
    },

    /** Number of currently tracked keys. */
    size(): number {
      return store.size;
    },

    /** Remove all tracked state. */
    clear(): void {
      store.clear();
    },
  };
}
