import { timingSafeEqual } from "node:crypto";

/**
 * Timing-safe string comparison for secrets.
 *
 * Pads both strings to equal-length buffers so `timingSafeEqual` never
 * throws on length mismatch, then performs an explicit length check
 * after the constant-time comparison.
 *
 * Returns `false` (not timing-safe) if either argument is nullish
 * or not a string — this prevents crashes but leaks type information,
 * which is acceptable since null/undefined is a caller bug, not a
 * secret-comparison concern.
 */
export function safeEqualSecret(provided: string, expected: string): boolean {
  if (provided == null || expected == null) return false;
  if (typeof provided !== "string" || typeof expected !== "string") return false;

  const providedBuf = Buffer.from(provided, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");

  const maxLen = Math.max(providedBuf.length, expectedBuf.length);
  const paddedProvided = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  providedBuf.copy(paddedProvided);
  expectedBuf.copy(paddedExpected);

  const constantTimeEqual = timingSafeEqual(paddedProvided, paddedExpected);
  return constantTimeEqual && providedBuf.length === expectedBuf.length;
}
