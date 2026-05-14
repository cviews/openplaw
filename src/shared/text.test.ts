import { describe, it, expect } from "vitest";
import {
  toText,
  normalizeOptionalLowercaseString,
  normalizeLowercaseStringOrEmpty,
} from "./text.js";

describe("toText", () => {
  it("returns the string unchanged for string input", () => {
    expect(toText("hello")).toBe("hello");
  });

  it("returns undefined for null", () => {
    expect(toText(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(toText(undefined)).toBeUndefined();
  });

  it("converts a number to its string representation", () => {
    expect(toText(123)).toBe("123");
  });

  it("converts an object using String()", () => {
    expect(toText({})).toBe("[object Object]");
  });

  it("converts a boolean to its string representation", () => {
    expect(toText(true)).toBe("true");
    expect(toText(false)).toBe("false");
  });

  it("converts zero to '0'", () => {
    expect(toText(0)).toBe("0");
  });

  it("converts an empty string to empty string (not undefined)", () => {
    expect(toText("")).toBe("");
  });
});

describe("normalizeOptionalLowercaseString", () => {
  it("trims and lowercases a string with whitespace", () => {
    expect(normalizeOptionalLowercaseString("  HELLO  ")).toBe("hello");
  });

  it("returns undefined for whitespace-only input", () => {
    expect(normalizeOptionalLowercaseString("   ")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeOptionalLowercaseString("")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeOptionalLowercaseString(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeOptionalLowercaseString(undefined)).toBeUndefined();
  });

  it("lowercases without trimming whitespace inside", () => {
    expect(normalizeOptionalLowercaseString("HeLLo World")).toBe("hello world");
  });

  it("handles already-lowercase input", () => {
    expect(normalizeOptionalLowercaseString("hello")).toBe("hello");
  });
});

describe("normalizeLowercaseStringOrEmpty", () => {
  it("trims and lowercases a string with whitespace", () => {
    expect(normalizeLowercaseStringOrEmpty("  HELLO  ")).toBe("hello");
  });

  it("returns empty string for null", () => {
    expect(normalizeLowercaseStringOrEmpty(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeLowercaseStringOrEmpty(undefined)).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeLowercaseStringOrEmpty("   ")).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(normalizeLowercaseStringOrEmpty("")).toBe("");
  });

  it("lowercases a normal string", () => {
    expect(normalizeLowercaseStringOrEmpty("Hello")).toBe("hello");
  });
});
