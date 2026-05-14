import { describe, it, expect } from "vitest";
import { mergeConfig, injectPlugins } from "./merger.js";
import type { LoadedConfigs } from "./loader.js";

function makeLoadedConfigs(
  overrides?: Partial<LoadedConfigs>,
): LoadedConfigs {
  return {
    openplaw: overrides?.openplaw ?? {},
    opencode: overrides?.opencode ?? {},
    omo: overrides?.omo ?? {},
    openplawDir: overrides?.openplawDir ?? "/home/.openplaw",
  };
}

describe("mergeConfig", () => {
  it("adds both plugins to empty opencode config", () => {
    const configs = makeLoadedConfigs({ opencode: {} });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "oh-my-opencode",
      "openplaw",
    ]);
  });

  it("adds both plugins when plugin array is absent", () => {
    const configs = makeLoadedConfigs({
      opencode: { model: "gpt-4" },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "oh-my-opencode",
      "openplaw",
    ]);
    expect(result.opencodeConfig.model).toBe("gpt-4");
  });

  it("deduplicates and appends to existing plugins", () => {
    const configs = makeLoadedConfigs({
      opencode: { plugin: ["my-plugin", "other-plugin"] },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "my-plugin",
      "other-plugin",
      "oh-my-opencode",
      "openplaw",
    ]);
  });

  it("does not duplicate oh-my-opencode if already present", () => {
    const configs = makeLoadedConfigs({
      opencode: { plugin: ["oh-my-opencode", "my-plugin"] },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "oh-my-opencode",
      "my-plugin",
      "openplaw",
    ]);
  });

  it("does not duplicate openplaw if already present", () => {
    const configs = makeLoadedConfigs({
      opencode: { plugin: ["openplaw", "my-plugin"] },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "openplaw",
      "my-plugin",
      "oh-my-opencode",
    ]);
  });

  it("does not duplicate either plugin if both already present", () => {
    const configs = makeLoadedConfigs({
      opencode: { plugin: ["oh-my-opencode", "openplaw", "my-plugin"] },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      "oh-my-opencode",
      "openplaw",
      "my-plugin",
    ]);
  });

  it("preserves tuple-style plugins and appends plain strings", () => {
    const configs = makeLoadedConfigs({
      opencode: {
        plugin: [
          ["some-plugin", { option: true }],
          "plain-plugin",
        ],
      } as unknown as Record<string, unknown> & {
        plugin?: Array<string | [string, Record<string, unknown>]>;
      },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      ["some-plugin", { option: true }],
      "plain-plugin",
      "oh-my-opencode",
      "openplaw",
    ]);
  });

  it("deduplicates by name when tuple-style oh-my-opencode exists", () => {
    const configs = makeLoadedConfigs({
      opencode: {
        plugin: [["oh-my-opencode", { custom: true }]],
      } as unknown as Record<string, unknown> & {
        plugin?: Array<string | [string, Record<string, unknown>]>;
      },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.plugin).toEqual([
      ["oh-my-opencode", { custom: true }],
      "openplaw",
    ]);
  });

  it("returns openplawConfig as pass-through", () => {
    const openplawConfig = {
      channels: { feishu: { appId: "x" } },
      agents: { directory: "/agents" },
    };
    const configs = makeLoadedConfigs({ openplaw: openplawConfig });
    const result = mergeConfig(configs);

    expect(result.openplawConfig).toEqual(openplawConfig);
  });

  it("preserves other opencode config fields", () => {
    const configs = makeLoadedConfigs({
      opencode: {
        model: "gpt-4",
        small_model: "gpt-3.5-turbo",
        theme: "dark",
        logLevel: "DEBUG",
        username: "test-user",
      },
    });
    const result = mergeConfig(configs);

    expect(result.opencodeConfig.model).toBe("gpt-4");
    expect(result.opencodeConfig.small_model).toBe("gpt-3.5-turbo");
    expect(result.opencodeConfig.theme).toBe("dark");
    expect(result.opencodeConfig.logLevel).toBe("DEBUG");
    expect(result.opencodeConfig.username).toBe("test-user");
    expect(result.opencodeConfig.plugin).toEqual([
      "oh-my-opencode",
      "openplaw",
    ]);
  });
});

describe("injectPlugins", () => {
  it("injects plugins into config without existing plugin array", () => {
    const result = injectPlugins({ model: "gpt-4" }, ["plugin-a"]);
    expect(result.plugin).toEqual(["plugin-a"]);
    expect(result.model).toBe("gpt-4");
  });

  it("deduplicates and appends to existing plugins", () => {
    const result = injectPlugins(
      { plugin: ["existing"] },
      ["existing", "new"],
    );
    expect(result.plugin).toEqual(["existing", "new"]);
  });

  it("returns config without plugin key when both existing and to-add are empty", () => {
    const result = injectPlugins({}, []);
    expect(result.plugin).toBeUndefined();
  });

  it("handles tuple-style entries and deduplicates by name", () => {
    const result = injectPlugins(
      {
        plugin: [
          ["my-plugin", { key: "value" }],
        ],
      } as Record<string, unknown> & {
        plugin?: Array<string | [string, Record<string, unknown>]>;
      },
      ["my-plugin"],
    );
    expect(result.plugin).toEqual([["my-plugin", { key: "value" }]]);
  });
});
