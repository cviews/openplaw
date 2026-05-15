import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { loadOpenmoConfigs, resolveOpenmoDir, resolveConfigDir, loadCredentials, mergeCredentialsIntoOpenmoConfig } from "./loader.js";
import type { OpenmoFileConfig } from "./loader.js";
import type { ChannelCredentials } from "./types.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: vi.fn(() => "/fake/home"),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("../infra/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock("../mcp/external/mcp-loader.js", () => ({
  loadExternalMcpConfigs: vi.fn(() => ({ discovered: [], errors: [] })),
}));

const FAKE_HOME = "/fake/home";
const FAKE_OPENMO_DIR = path.join(FAKE_HOME, ".openplaw");
const FAKE_CONFIG_DIR = path.join(FAKE_HOME, ".config", "openplaw");

describe("resolveOpenmoDir", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("defaults to ~/.openplaw/ when OPENMO_HOME not set", () => {
    delete process.env["OPENMO_HOME"];
    expect(resolveOpenmoDir()).toBe(path.join(FAKE_HOME, ".openplaw"));
  });

  it("uses OPENMO_HOME env var when set", () => {
    process.env["OPENMO_HOME"] = "/custom/openplaw";
    expect(resolveOpenmoDir()).toBe("/custom/openplaw");
  });
});

describe("resolveConfigDir", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("defaults to ~/.config/openplaw/ when no env vars set", () => {
    delete process.env["OPENMO_HOME"];
    delete process.env["OPENMO_CONFIG_HOME"];
    expect(resolveConfigDir()).toBe(path.join(FAKE_HOME, ".config", "openplaw"));
  });

  it("uses OPENMO_CONFIG_HOME when set", () => {
    process.env["OPENMO_CONFIG_HOME"] = "/custom/config";
    expect(resolveConfigDir()).toBe("/custom/config");
  });

  it("falls back to OPENMO_HOME when OPENMO_CONFIG_HOME not set", () => {
    delete process.env["OPENMO_CONFIG_HOME"];
    process.env["OPENMO_HOME"] = "/custom/openplaw";
    expect(resolveConfigDir()).toBe("/custom/openplaw");
  });

  it("OPENMO_CONFIG_HOME takes precedence over OPENMO_HOME", () => {
    process.env["OPENMO_CONFIG_HOME"] = "/custom/config";
    process.env["OPENMO_HOME"] = "/custom/openplaw";
    expect(resolveConfigDir()).toBe("/custom/config");
  });
});

describe("loadOpenmoConfigs", () => {
  let readFileMock: ReturnType<typeof vi.fn>;
  let readdirMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsPromises = await import("node:fs/promises");
    readFileMock = vi.mocked(fsPromises.readFile) as ReturnType<typeof vi.fn>;
    readdirMock = vi.mocked(fsPromises.readdir) as ReturnType<typeof vi.fn>;
    const nodeFs = await import("node:fs");
    existsSyncMock = vi.mocked(nodeFs.existsSync) as ReturnType<typeof vi.fn>;
    delete process.env["OPENMO_HOME"];
    existsSyncMock.mockImplementation((filePath: string) => {
      return !filePath.includes("credentials");
    });
    readdirMock.mockResolvedValue([]);
  });

  it("returns empty objects when no config files exist", async () => {
    existsSyncMock.mockReturnValue(false);

    const result = await loadOpenmoConfigs();

    expect(result).toEqual({
      openplaw: {},
      opencode: {},
      omo: {},
      openplawDir: FAKE_OPENMO_DIR,
      configDir: FAKE_CONFIG_DIR,
      externalMcps: { discovered: [], errors: [] },
    });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns parsed content when all three files exist", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve(
          JSON.stringify({
            channels: { feishu: { appId: "x" } },
            agents: { directory: "/agents" },
          }),
        );
      }
      if (name === "opencode.json") {
        return Promise.resolve(
          JSON.stringify({
            plugin: ["foo", ["bar", { key: "val" }]],
            model: "gpt-4",
          }),
        );
      }
      if (name === "omo.json" || name === "oh-my-openagent.json") {
        return Promise.resolve(
          JSON.stringify({ agent_definitions: ["a.md", "b.md"] }),
        );
      }
      return Promise.reject(new Error(`Unexpected file: ${filePath}`));
    });

    const result = await loadOpenmoConfigs();

    expect(result.openplaw.channels).toEqual({ feishu: { appId: "x" } });
    expect(result.openplaw.agents).toEqual({ directory: "/agents" });
    expect(result.openplaw.bots).toEqual([
      { id: "main", agent: "main", appId: "x", appSecret: "", verificationToken: "", encryptKey: "", botName: "main" },
    ]);
    expect(result.openplaw.groups).toEqual([
      { id: "default", chatId: "", name: "default", bots: ["main"] },
    ]);
    expect(result.opencode).toEqual({
      plugin: ["foo", ["bar", { key: "val" }]],
      model: "gpt-4",
    });
    expect(result.omo).toEqual({ agent_definitions: ["a.md", "b.md"] });
    expect(result.openplawDir).toBe(FAKE_OPENMO_DIR);
  });

  it("returns partial content when only some files exist", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      return name === "openplaw.json";
    });
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve(JSON.stringify({ channels: { feishu: {} } }));
      }
      return Promise.reject(new Error("Unexpected read"));
    });

    const result = await loadOpenmoConfigs();

    expect(result.openplaw.channels).toEqual({ feishu: {} });
    expect(result.openplaw.bots).toEqual([
      { id: "main", agent: "main", appId: "", appSecret: "", verificationToken: "", encryptKey: "", botName: "main" },
    ]);
    expect(result.openplaw.groups).toEqual([
      { id: "default", chatId: "", name: "default", bots: ["main"] },
    ]);
    expect(result.opencode).toEqual({});
    expect(result.omo).toEqual({});
  });

  it("throws clear error on corrupt JSON in openplaw.json", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve("{ invalid json !!!");
      }
      return Promise.resolve("{}");
    });

    await expect(loadOpenmoConfigs()).rejects.toThrow(
      `Corrupt JSON in config file ${path.join(FAKE_CONFIG_DIR, "openplaw.json")}`,
    );
  });

  it("throws clear error on corrupt JSON in opencode.json", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "opencode.json") {
        return Promise.resolve("{ bad");
      }
      return Promise.resolve("{}");
    });

    await expect(loadOpenmoConfigs()).rejects.toThrow(
      `Corrupt JSON in config file ${path.join(FAKE_CONFIG_DIR, "opencode.json")}`,
    );
  });

  it("throws clear error on corrupt JSON in omo.json", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "omo.json" || name === "oh-my-openagent.json") {
        return Promise.resolve("not json at all");
      }
      return Promise.resolve("{}");
    });

    await expect(loadOpenmoConfigs()).rejects.toThrow(
      `Corrupt JSON in config file ${path.join(FAKE_CONFIG_DIR, "oh-my-openagent.json")}`,
    );
  });

  it("handles JSONC files (with comments)", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve(`{
  // this is a comment
  "channels": { "feishu": {} }
}`);
      }
      if (name === "opencode.json") {
        return Promise.resolve(`{
  // SDK config
  "model": "gpt-4"
}`);
      }
      if (name === "omo.json" || name === "oh-my-openagent.json") {
        return Promise.resolve(`{
  // agent defs
  "agent_definitions": ["a.md"]
}`);
      }
      return Promise.resolve("{}");
    });

    const result = await loadOpenmoConfigs();

    expect(result.openplaw.channels).toEqual({ feishu: {} });
    expect(result.openplaw.bots).toEqual([
      { id: "main", agent: "main", appId: "", appSecret: "", verificationToken: "", encryptKey: "", botName: "main" },
    ]);
    expect(result.openplaw.groups).toEqual([
      { id: "default", chatId: "", name: "default", bots: ["main"] },
    ]);
    expect(result.opencode).toEqual({ model: "gpt-4" });
    expect(result.omo).toEqual({ agent_definitions: ["a.md"] });
  });

  it("uses OPENMO_HOME env var for directory resolution", async () => {
    process.env["OPENMO_HOME"] = "/custom/dir";
    existsSyncMock.mockReturnValue(false);

    const result = await loadOpenmoConfigs();

    expect(result.openplawDir).toBe("/custom/dir");
    expect(result.configDir).toBe("/custom/dir");
    expect(existsSyncMock).toHaveBeenCalledWith(path.join("/custom/dir", "openplaw.json"));
  });

  it("auto-converts legacy channels.feishu to bots and groups", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve(JSON.stringify({
          channels: {
            feishu: {
              appId: "cli_auto",
              appSecret: "sec_auto",
              verificationToken: "vt_auto",
              encryptKey: "ek_auto",
              botName: "AutoBot",
            },
          },
        }));
      }
      return Promise.resolve("{}");
    });

    const result = await loadOpenmoConfigs();

    expect(result.openplaw.bots).toEqual([
      {
        id: "AutoBot",
        agent: "AutoBot",
        appId: "cli_auto",
        appSecret: "sec_auto",
        verificationToken: "vt_auto",
        encryptKey: "ek_auto",
        botName: "AutoBot",
      },
    ]);
    expect(result.openplaw.groups).toEqual([
      { id: "default", chatId: "", name: "default", bots: ["AutoBot"] },
    ]);
  });

  it("does not auto-convert when bots are already provided", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "openplaw.json") {
        return Promise.resolve(JSON.stringify({
          bots: [
            { id: "existing-bot", agent: "main", appId: "a", appSecret: "s", verificationToken: "v", encryptKey: "e", botName: "ExistingBot" },
          ],
          channels: { feishu: { appId: "old" } },
        }));
      }
      return Promise.resolve("{}");
    });

    const result = await loadOpenmoConfigs();

    expect(result.openplaw.bots!.length).toBe(1);
    expect(result.openplaw.bots![0].id).toBe("existing-bot");
  });
});

describe("loadCredentials", () => {
  let readFileMock: ReturnType<typeof vi.fn>;
  let readdirMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;

  const CREDENTIALS_DIR = path.join(FAKE_CONFIG_DIR, "credentials");

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsPromises = await import("node:fs/promises");
    readFileMock = vi.mocked(fsPromises.readFile) as ReturnType<typeof vi.fn>;
    readdirMock = vi.mocked(fsPromises.readdir) as ReturnType<typeof vi.fn>;
    const nodeFs = await import("node:fs");
    existsSyncMock = vi.mocked(nodeFs.existsSync) as ReturnType<typeof vi.fn>;
    delete process.env["OPENMO_HOME"];
    delete process.env["OPENMO_CONFIG_HOME"];
  });

  it("returns empty Map when credentials/ directory doesn't exist", async () => {
    existsSyncMock.mockReturnValue(false);

    const result = await loadCredentials(FAKE_CONFIG_DIR);

    expect(result).toEqual(new Map());
  });

  it("returns empty Map when credentials/ directory is empty", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      return filePath === CREDENTIALS_DIR;
    });
    readdirMock.mockResolvedValue([]);

    const result = await loadCredentials(FAKE_CONFIG_DIR);

    expect(result).toEqual(new Map());
  });

  it("loads credential files and returns Map keyed by channelId", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      return filePath === CREDENTIALS_DIR;
    });
    readdirMock.mockResolvedValue(["feishu.json", "dingtalk.json"]);
    readFileMock.mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      if (name === "feishu.json") {
        return Promise.resolve(JSON.stringify({ channelId: "feishu", appId: "cli_xxx", appSecret: "secret" }));
      }
      if (name === "dingtalk.json") {
        return Promise.resolve(JSON.stringify({ channelId: "dingtalk", token: "tok123" }));
      }
      return Promise.reject(new Error(`Unexpected file: ${filePath}`));
    });

    const result = await loadCredentials(FAKE_CONFIG_DIR);

    expect(result.size).toBe(2);
    expect(result.get("feishu")).toEqual({ channelId: "feishu", appId: "cli_xxx", appSecret: "secret" });
    expect(result.get("dingtalk")).toEqual({ channelId: "dingtalk", token: "tok123" });
  });

  it("throws clear error when channelId field is missing", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      return filePath === CREDENTIALS_DIR;
    });
    readdirMock.mockResolvedValue(["bad.json"]);
    readFileMock.mockResolvedValue(JSON.stringify({ appId: "cli_xxx" }));

    await expect(loadCredentials(FAKE_CONFIG_DIR)).rejects.toThrow(
      `Missing channelId in credentials file ${path.join(CREDENTIALS_DIR, "bad.json")}`,
    );
  });

  it("throws clear error when channelId is not a string", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      return filePath === CREDENTIALS_DIR;
    });
    readdirMock.mockResolvedValue(["bad.json"]);
    readFileMock.mockResolvedValue(JSON.stringify({ channelId: 123 }));

    await expect(loadCredentials(FAKE_CONFIG_DIR)).rejects.toThrow(
      `channelId is not a string in credentials file ${path.join(CREDENTIALS_DIR, "bad.json")}`,
    );
  });

  it("handles corrupt JSON in credentials file", async () => {
    existsSyncMock.mockImplementation((filePath: string) => {
      return filePath === CREDENTIALS_DIR;
    });
    readdirMock.mockResolvedValue(["broken.json"]);
    readFileMock.mockResolvedValue("{ invalid json !!!");

    await expect(loadCredentials(FAKE_CONFIG_DIR)).rejects.toThrow(
      `Corrupt JSON in credentials file ${path.join(CREDENTIALS_DIR, "broken.json")}`,
    );
  });
});

describe("mergeCredentialsIntoOpenmoConfig", () => {
  it("merges credentials into existing channel config", () => {
    const config: OpenmoFileConfig = {
      channels: { feishu: { botName: "my-bot" } },
    };
    const credentials = new Map<string, ChannelCredentials>([
      ["feishu", { channelId: "feishu", appId: "cli_xxx", appSecret: "secret" }],
    ]);

    mergeCredentialsIntoOpenmoConfig(config, credentials);

    expect(config.channels?.["feishu"]).toEqual({
      botName: "my-bot",
      appId: "cli_xxx",
      appSecret: "secret",
    });
  });

  it("creates channel entry when channel doesn't exist in openplaw.json", () => {
    const config: OpenmoFileConfig = { channels: {} };
    const credentials = new Map<string, ChannelCredentials>([
      ["feishu", { channelId: "feishu", appId: "cli_xxx" }],
    ]);

    mergeCredentialsIntoOpenmoConfig(config, credentials);

    expect(config.channels?.["feishu"]).toEqual({ appId: "cli_xxx" });
  });

  it("creates channels object if it doesn't exist", () => {
    const config: OpenmoFileConfig = {};
    const credentials = new Map<string, ChannelCredentials>([
      ["feishu", { channelId: "feishu", appId: "cli_xxx" }],
    ]);

    mergeCredentialsIntoOpenmoConfig(config, credentials);

    expect(config.channels?.["feishu"]).toEqual({ appId: "cli_xxx" });
  });

  it("preserves existing channel config fields when merging credentials", () => {
    const config: OpenmoFileConfig = {
      channels: {
        feishu: { botName: "my-bot", webhook: "https://..." },
        dingtalk: { agent: "default" },
      },
    };
    const credentials = new Map<string, ChannelCredentials>([
      ["feishu", { channelId: "feishu", appId: "cli_xxx" }],
    ]);

    mergeCredentialsIntoOpenmoConfig(config, credentials);

    expect(config.channels?.["feishu"]).toEqual({
      botName: "my-bot",
      webhook: "https://...",
      appId: "cli_xxx",
    });
    expect(config.channels?.["dingtalk"]).toEqual({ agent: "default" });
  });

  it("does not include channelId in merged output", () => {
    const config: OpenmoFileConfig = { channels: { feishu: { botName: "bot" } } };
    const credentials = new Map<string, ChannelCredentials>([
      ["feishu", { channelId: "feishu", appId: "cli_xxx" }],
    ]);

    mergeCredentialsIntoOpenmoConfig(config, credentials);

    const merged = config.channels?.["feishu"] as Record<string, unknown>;
    expect("channelId" in merged).toBe(false);
  });
});
