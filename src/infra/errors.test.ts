import { describe, it, expect } from "vitest";
import {
  extractErrorCode,
  readErrorName,
  isErrno,
  hasErrnoCode,
  formatErrorMessage,
  formatUncaughtError,
  detectErrorKind,
  collectErrorGraphCandidates,
  type ErrorKind,
} from "./errors.js";

describe("extractErrorCode", () => {
  it("should return code from NodeJS error", () => {
    const err = { code: "ENOENT" };
    expect(extractErrorCode(err)).toBe("ENOENT");
  });

  it("should return undefined if no code", () => {
    expect(extractErrorCode(new Error("boom"))).toBeUndefined();
    expect(extractErrorCode(null)).toBeUndefined();
    expect(extractErrorCode(undefined)).toBeUndefined();
    expect(extractErrorCode(123)).toBeUndefined();
  });

  it("should return undefined if code is not string", () => {
    expect(extractErrorCode({ code: 404 })).toBeUndefined();
  });
});

describe("readErrorName", () => {
  it("should return name from Error instance", () => {
    expect(readErrorName(new TypeError("bad"))).toBe("TypeError");
  });

  it("should return name from plain object", () => {
    expect(readErrorName({ name: "CustomError" })).toBe("CustomError");
  });

  it('should fallbacks to "UnknownError"', () => {
    expect(readErrorName(null)).toBe("UnknownError");
    expect(readErrorName(undefined)).toBe("UnknownError");
    expect(readErrorName({})).toBe("UnknownError");
    expect(readErrorName({ name: 123 })).toBe("UnknownError");
  });
});

describe("isErrno", () => {
  it("should return true for Error with code", () => {
    const err = new Error("not found");
    (err as NodeJS.ErrnoException & { code: string }).code = "ENOENT";
    expect(isErrno(err)).toBe(true);
  });

  it("should return false for Error without code", () => {
    expect(isErrno(new Error("boom"))).toBe(false);
  });
});

describe("hasErrnoCode", () => {
  it("should return true when code matches", () => {
    const err = { code: "ETIMEDOUT" };
    expect(hasErrnoCode(err, "ETIMEDOUT")).toBe(true);
  });

  it("should return false when code does not match", () => {
    const err = { code: "ENOENT" };
    expect(hasErrnoCode(err, "ETIMEDOUT")).toBe(false);
  });
});

describe("formatErrorMessage", () => {
  it("should format Error with code", () => {
    const err = new Error("file not found");
    (err as NodeJS.ErrnoException & { code: string }).code = "ENOENT";
    expect(formatErrorMessage(err)).toBe("file not found [code: ENOENT]");
  });

  it("should format Error without code", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("should stringify non-Error", () => {
    expect(formatErrorMessage("boom")).toBe("boom");
  });
});

describe("formatUncaughtError", () => {
  it("should include name, message and code", () => {
    const err = new Error("file not found");
    (err as NodeJS.ErrnoException & { code: string }).code = "ENOENT";
    expect(formatUncaughtError(err)).toBe("Error: file not found [code: ENOENT] (code: ENOENT)");
  });
});

describe("detectErrorKind", () => {
  const testCases: Array<[unknown, ErrorKind | undefined]> = [
    [{ code: "ECONNREFUSED" }, "timeout"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [new Error("connection timeout"), "timeout"],
    [new (class extends Error { constructor() { super("abort"); this.name = "AbortError"; } })(), "timeout"],
    [{ status: 429 }, "rate_limit"],
    [{ code: "rate_limit_exceeded" }, "rate_limit"],
    [new Error("rate limit exceeded"), "rate_limit"],
    [new Error("request refused"), "refusal"],
    [new Error("context_length exceeded"), "context_length"],
    [new Error("maximum context length reached"), "context_length"],
    [{ status: 413 }, "context_length"],
    [new Error("random error"), undefined],
  ];

  testCases.forEach(([input, expected]) => {
    const title = input instanceof Error 
      ? `${input.constructor.name} { message: '${input.message}' }` 
      : JSON.stringify(input);
    it(`should detect ${expected} for ${title}`, () => {
      expect(detectErrorKind(input)).toBe(expected);
    });
  });
});

describe("collectErrorGraphCandidates", () => {
  it("should collect nested errors", () => {
    const root = new Error("root");
    const cause = new Error("cause");
    (root as NodeJS.ErrnoException & { cause: Error }).cause = cause;
    const result = collectErrorGraphCandidates(root);
    expect(result).toHaveLength(2);
    expect(result).toContain(root);
    expect(result).toContain(cause);
  });

  it("should avoid cycles", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as NodeJS.ErrnoException & { cause: Error }).cause = b;
    (b as NodeJS.ErrnoException & { cause: Error }).cause = a;
    const result = collectErrorGraphCandidates(a);
    expect(result).toHaveLength(2); // No infinite loop
  });
});
