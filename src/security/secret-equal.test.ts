import { describe, it, expect } from "vitest";
import { safeEqualSecret } from "./secret-equal.js";

describe("safeEqualSecret", () => {
  it("returns true for identical strings", () => {
    expect(safeEqualSecret("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeEqualSecret("hello", "world")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(safeEqualSecret("short", "a-much-longer-string")).toBe(false);
  });

  it("returns false when provided is empty and expected is not", () => {
    expect(safeEqualSecret("", "secret")).toBe(false);
  });

  it("returns false when expected is empty and provided is not", () => {
    expect(safeEqualSecret("secret", "")).toBe(false);
  });

  it("returns true for both empty strings", () => {
    expect(safeEqualSecret("", "")).toBe(true);
  });

  it("returns false when provided is null", () => {
    expect(safeEqualSecret(null as unknown as string, "secret")).toBe(false);
  });

  it("returns false when expected is null", () => {
    expect(safeEqualSecret("secret", null as unknown as string)).toBe(false);
  });

  it("returns false when provided is undefined", () => {
    expect(safeEqualSecret(undefined as unknown as string, "secret")).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(safeEqualSecret("secret", undefined as unknown as string)).toBe(false);
  });

  it("returns false when provided is a non-string type", () => {
    expect(safeEqualSecret(42 as unknown as string, "secret")).toBe(false);
  });

  it("returns false when expected is a non-string type", () => {
    expect(safeEqualSecret("secret", 42 as unknown as string)).toBe(false);
  });

  it("handles unicode strings correctly", () => {
    expect(safeEqualSecret("你好世界", "你好世界")).toBe(true);
  });

  it("returns false for similar unicode strings", () => {
    expect(safeEqualSecret("你好世界", "你好世畍")).toBe(false);
  });
});
