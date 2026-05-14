export type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";

/**
 * Extract error code from NodeJS-style errors
 */
export function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Read error name from unknown error, fallback to "UnknownError"
 */
export function readErrorName(err: unknown): string {
  if (err instanceof Error) {
    return err.name;
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name: unknown }).name;
    return typeof name === "string" ? name : "UnknownError";
  }
  return "UnknownError";
}

/**
 * Type guard for NodeJS ErrnoException (errors with .code property)
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && extractErrorCode(err) !== undefined;
}

/**
 * Check if error has specific errno code
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  const actualCode = extractErrorCode(err);
  return actualCode === code;
}

/**
 * Format error message for logging (includes message + code if available)
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = extractErrorCode(err);
    return code ? `${err.message} [code: ${code}]` : err.message;
  }
  return String(err);
}

/**
 * Format error for uncaught/fatal context (includes name, message, and code)
 */
export function formatUncaughtError(err: unknown): string {
  const name = readErrorName(err);
  const message = formatErrorMessage(err);
  const code = extractErrorCode(err);
  let result = `${name}: ${message}`;
  if (code) {
    result += ` (code: ${code})`;
  }
  return result;
}

/**
 * Detect error kind from error patterns
 */
export function detectErrorKind(err: unknown): ErrorKind | undefined {
  const code = extractErrorCode(err) || "";
  let message = "";
  if (err instanceof Error) {
    message = err.message.toLowerCase();
  } else if (typeof err === "string") {
    message = err.toLowerCase();
  }
  const name = readErrorName(err).toLowerCase();
  let status: number | undefined;
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") {
      status = s;
    }
  }

  // Check timeout first
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    (message && message.includes("timeout")) ||
    name === "aborterror" ||
    name.includes("abort")
  ) {
    return "timeout";
  }

  // Check rate limit
  if (
    status === 429 ||
    (code && code.toLowerCase().includes("rate_limit")) ||
    (message && message.includes("rate_limit")) ||
    (message && message.includes("rate limit"))
  ) {
    return "rate_limit";
  }

  // Check refusal
  if (
    (message && message.includes("refusal")) ||
    (message && message.includes("refused"))
  ) {
    return "refusal";
  }

  // Check context length
  if (
    (code && code.toLowerCase().includes("context_length")) ||
    (message && message.includes("context_length")) ||
    (message && message.includes("context length")) ||
    (message && message.includes("maximum context")) ||
    status === 413
  ) {
    return "context_length";
  }

  return undefined;
}

/**
 * Traverse nested error graph to collect all error candidates
 */
export function collectErrorGraphCandidates(
  err: unknown,
  resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>
): unknown[] {
  const result: unknown[] = [];
  const visited = new WeakSet();

  function traverse(current: unknown): void {
    if (!current || typeof current !== "object") {
      return;
    }
    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    // Add any object error-like thing to the result
    result.push(current);

    let candidates: Iterable<unknown>;
    if (resolveNested) {
      candidates = resolveNested(current as Record<string, unknown>);
    } else {
      // Default: check common nested error properties
      candidates = [
        (current as Record<string, unknown>).cause,
        (current as Record<string, unknown>).error,
        (current as Record<string, unknown>).innerError,
        (current as Record<string, unknown>).originalError,
      ].filter((v): v is unknown => v !== undefined);
    }

    Array.from(candidates).forEach((candidate) => traverse(candidate));
  }

  traverse(err);
  return result;
}
