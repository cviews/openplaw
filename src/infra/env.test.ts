import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isTruthyEnvValue,
  normalizeEnv,
  logAcceptedEnvOption,
  isVitestRuntimeEnv,
  type AcceptedEnvOption,
} from "./env.js";
import { logger } from "./logger.js";

describe("env", () => {
  describe("isTruthyEnvValue", () => {
    it("returns false for undefined", () => {
      expect(isTruthyEnvValue(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTruthyEnvValue("")).toBe(false);
    });

    it("returns true for truthy values case-insensitive", () => {
      expect(isTruthyEnvValue("1")).toBe(true);
      expect(isTruthyEnvValue("true")).toBe(true);
      expect(isTruthyEnvValue("yes")).toBe(true);
      expect(isTruthyEnvValue("on")).toBe(true);
      expect(isTruthyEnvValue("TRUE")).toBe(true);
      expect(isTruthyEnvValue("Yes")).toBe(true);
      expect(isTruthyEnvValue("  On  ")).toBe(true);
    });

    it("returns false for non-truthy values", () => {
      expect(isTruthyEnvValue("0")).toBe(false);
      expect(isTruthyEnvValue("false")).toBe(false);
      expect(isTruthyEnvValue("no")).toBe(false);
      expect(isTruthyEnvValue("off")).toBe(false);
      expect(isTruthyEnvValue("random")).toBe(false);
    });
  });

  describe("normalizeEnv", () => {
    beforeEach(() => {
      process.env.OPENMO_TEST = "  value-with-spaces  ";
      process.env.OPENMO_TEST_EMPTY = "  ";
      process.env.NOT_OPENMO = "  should-not-change  ";
    });

    it("trims whitespace from OPENMO_ prefixed env vars", () => {
      normalizeEnv();
      expect(process.env.OPENMO_TEST).toBe("value-with-spaces");
      expect(process.env.OPENMO_TEST_EMPTY).toBe("");
      expect(process.env.NOT_OPENMO).toBe("  should-not-change  ");
    });
  });

  describe("logAcceptedEnvOption", () => {
    it("logs without redaction when redact is false", () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
      const option: AcceptedEnvOption = {
        key: "OPENMO_TEST",
        description: "Test option",
        value: "test-value",
        redact: false,
      };
      logAcceptedEnvOption(option);
      expect(infoSpy).toHaveBeenCalledWith(
        "Env: OPENMO_TEST - Test option",
        { value: "test-value" }
      );
      infoSpy.mockRestore();
    });

    it("redacts short values completely", () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
      const option: AcceptedEnvOption = {
        key: "OPENMO_SECRET",
        description: "Secret option",
        value: "12",
        redact: true,
      };
      logAcceptedEnvOption(option);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.any(String),
        { value: "**" }
      );
      infoSpy.mockRestore();
    });

    it("redacts long values showing first 3 characters", () => {
      const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
      const option: AcceptedEnvOption = {
        key: "OPENMO_SECRET",
        description: "Secret option",
        value: "secret-12345",
        redact: true,
      };
      logAcceptedEnvOption(option);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.any(String),
        { value: "sec*********" }
      );
      infoSpy.mockRestore();
    });
  });

  describe("isVitestRuntimeEnv", () => {
    it("returns true when VITEST is set", () => {
      expect(isVitestRuntimeEnv({ VITEST: "true" })).toBe(true);
    });

    it("returns true when VITEST_WORKER_ID is set", () => {
      expect(isVitestRuntimeEnv({ VITEST_WORKER_ID: "1" })).toBe(true);
    });

    it("returns false when neither is set", () => {
      expect(isVitestRuntimeEnv({})).toBe(false);
    });
  });
});
