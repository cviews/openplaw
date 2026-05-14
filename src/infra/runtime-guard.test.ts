import { describe, it, expect } from "vitest";
import {
  parseSemver,
  isAtLeast,
  detectRuntime,
  isSupportedNodeVersion,
  assertSupportedRuntime,
  type Semver,
} from "./runtime-guard";

describe("parseSemver", () => {
  it("should parse version with leading v", () => {
    expect(parseSemver("v20.11.0")).toEqual({ major: 20, minor: 11, patch: 0 });
  });

  it("should parse version without leading v", () => {
    expect(parseSemver("18.0.0")).toEqual({ major: 18, minor: 0, patch: 0 });
  });

  it("should return null for null input", () => {
    expect(parseSemver(null)).toBeNull();
  });

  it("should return null for invalid version", () => {
    expect(parseSemver("invalid")).toBeNull();
    expect(parseSemver("20")).toBeNull();
    expect(parseSemver("20.11")).toBeNull();
    expect(parseSemver("v20.xx.0")).toBeNull();
  });
});

describe("isAtLeast", () => {
  const minimum: Semver = { major: 18, minor: 0, patch: 0 };

  it("should return true when version is greater than minimum", () => {
    expect(isAtLeast({ major: 20, minor: 11, patch: 0 }, minimum)).toBe(true);
  });

  it("should return true when version equals minimum", () => {
    expect(isAtLeast({ major: 18, minor: 0, patch: 0 }, minimum)).toBe(true);
  });

  it("should return false when version is less than minimum", () => {
    expect(isAtLeast({ major: 16, minor: 0, patch: 0 }, minimum)).toBe(false);
  });

  it("should compare minor version correctly", () => {
    expect(isAtLeast({ major: 18, minor: 5, patch: 0 }, { major: 18, minor: 3, patch: 0 })).toBe(true);
    expect(isAtLeast({ major: 18, minor: 2, patch: 0 }, { major: 18, minor: 3, patch: 0 })).toBe(false);
  });

  it("should return false for null version", () => {
    expect(isAtLeast(null, minimum)).toBe(false);
  });
});

describe("detectRuntime", () => {
  it("should return valid runtime details", () => {
    const runtime = detectRuntime();
    expect(runtime.kind).toBe("node");
    expect(runtime.version).toBeDefined();
    expect(runtime.pathEnv).toBeDefined();
  });
});

describe("isSupportedNodeVersion", () => {
  it("should return true for version >= 18.0.0", () => {
    expect(isSupportedNodeVersion("v20.11.0")).toBe(true);
    expect(isSupportedNodeVersion("v18.0.0")).toBe(true);
    expect(isSupportedNodeVersion("18.0.0")).toBe(true);
  });

  it("should return false for version < 18.0.0", () => {
    expect(isSupportedNodeVersion("v16.0.0")).toBe(false);
    expect(isSupportedNodeVersion("v17.9.9")).toBe(false);
  });
});

describe("assertSupportedRuntime", () => {
  it("should not throw on current Node.js", () => {
    expect(() => assertSupportedRuntime()).not.toThrow();
  });
});
