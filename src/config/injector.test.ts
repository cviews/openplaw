import { describe, it, expect, vi } from "vitest";

import { serializeConfig, injectConfig } from "./injector.js";
import type { LoadedConfigs } from "./loader.js";
import type { MergedConfigResult } from "./merger.js";
import type { OpencodeConfig } from "./types.js";

vi.mock("../config/loader.js", () => ({
  resolveConfigDir: vi.fn(() => "/home/user/.config/openplaw"),
}));
vi.mock("../infra/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("serializeConfig", () => {
  it("produces valid JSON string from a Config object", () => {
    const config: OpencodeConfig = { plugin: ["oh-my-opencode", "openplaw"] };
    const result = serializeConfig(config);

    expect(result).toBe('{"plugin":["oh-my-opencode","openplaw"]}');
    expect(JSON.parse(result)).toEqual(config);
  });

  it("serializes empty config to empty JSON object", () => {
    const config: OpencodeConfig = {};
    const result = serializeConfig(config);

    expect(result).toBe("{}");
    expect(JSON.parse(result)).toEqual({});
  });

  it("round-trips complex config through JSON parse", () => {
    const config: OpencodeConfig = {
      plugin: ["oh-my-opencode", "openplaw"],
      model: "gpt-4",
    };
    const result = serializeConfig(config);

    expect(JSON.parse(result)).toEqual(config);
  });
});

describe("injectConfig", () => {
  it("returns configContent string and opencodeConfigDir", async () => {
    const configs: LoadedConfigs = {
      openplaw: { channels: {} },
      opencode: {},
      omo: { theme: "dark" },
      openplawDir: "/home/user/.openplaw",
      configDir: "/home/user/.config/openplaw",
      externalMcps: { discovered: [], errors: [] },
    };
    const merged: MergedConfigResult = {
      opencodeConfig: { plugin: ["oh-my-opencode"] } as OpencodeConfig,
      openplawConfig: { channels: {} },
    };

    const result = await injectConfig(configs, merged);

    expect(result.configContent).toBe('{"plugin":["oh-my-opencode"]}');
    expect(result.opencodeConfigDir).toBe("/home/user/.config/openplaw");
  });
});