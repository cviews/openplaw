import { describe, it, expect } from "vitest";
import {
  readStringValue,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
  normalizeLowercaseStringOrEmpty,
  lowercasePreservingWhitespace,
  hasNonEmptyString,
} from "./string-coerce.js";

describe("readStringValue", () => {
  it("returns string as-is", () => {
    expect(readStringValue("hello")).toBe("hello");
  });

  it("coerces number to string", () => {
    expect(readStringValue(42)).toBe("42");
  });

  it("coerces boolean to string", () => {
    expect(readStringValue(true)).toBe("true");
    expect(readStringValue(false)).toBe("false");
  });

  it("returns undefined for null", () => {
    expect(readStringValue(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(readStringValue(undefined)).toBeUndefined();
  });

  it("returns undefined for objects", () => {
    expect(readStringValue({})).toBeUndefined();
    expect(readStringValue([])).toBeUndefined();
  });
});

describe("normalizeNullableString", () => {
  it("returns null for null/undefined/empty", () => {
    expect(normalizeNullableString(null)).toBeNull();
    expect(normalizeNullableString(undefined)).toBeNull();
    expect(normalizeNullableString("")).toBeNull();
  });

  it("trims non-empty string", () => {
    expect(normalizeNullableString("  hello  ")).toBe("hello");
  });

  it("returns null for non-string values", () => {
    expect(normalizeNullableString(42)).toBeNull();
    expect(normalizeNullableString(true)).toBeNull();
  });
});

describe("normalizeOptionalString", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(normalizeOptionalString(null)).toBeUndefined();
    expect(normalizeOptionalString(undefined)).toBeUndefined();
    expect(normalizeOptionalString("")).toBeUndefined();
  });

  it("trims non-empty string", () => {
    expect(normalizeOptionalString("  hello  ")).toBe("hello");
  });

  it("returns undefined for non-string values", () => {
    expect(normalizeOptionalString(42)).toBeUndefined();
    expect(normalizeOptionalString(true)).toBeUndefined();
  });
});

describe("normalizeOptionalLowercaseString", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(normalizeOptionalLowercaseString(null)).toBeUndefined();
    expect(normalizeOptionalLowercaseString(undefined)).toBeUndefined();
    expect(normalizeOptionalLowercaseString("")).toBeUndefined();
  });

  it("trims and lowercases non-empty string", () => {
    expect(normalizeOptionalLowercaseString("  Hello World  ")).toBe("hello world");
  });
});

describe("normalizeLowercaseStringOrEmpty", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeLowercaseStringOrEmpty(null)).toBe("");
    expect(normalizeLowercaseStringOrEmpty(undefined)).toBe("");
    expect(normalizeLowercaseStringOrEmpty("")).toBe("");
  });

  it("trims and lowercases non-empty string", () => {
    expect(normalizeLowercaseStringOrEmpty("  Hello World  ")).toBe("hello world");
  });
});

describe("lowercasePreservingWhitespace", () => {
  it("trims outer and lowercases but preserves internal whitespace", () => {
    expect(lowercasePreservingWhitespace("  Hello   World  ")).toBe("hello   world");
  });
});

describe("hasNonEmptyString", () => {
  it("returns true for non-empty string", () => {
    expect(hasNonEmptyString("hello")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(hasNonEmptyString("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(hasNonEmptyString(42)).toBe(false);
    expect(hasNonEmptyString(null)).toBe(false);
    expect(hasNonEmptyString(undefined)).toBe(false);
    expect(hasNonEmptyString(true)).toBe(false);
    expect(hasNonEmptyString({})).toBe(false);
  });
});
