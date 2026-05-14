import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";

import { serializeConfig, writeOmoConfig, injectConfig } from "./injector.js";
import type { LoadedConfigs, OmoFileConfig } from "./loader.js";
import type { MergedConfigResult } from "./merger.js";
import type { OpencodeConfig } from "./types.js";

vi.mock("node:fs");
vi.mock("node:fs/promises");
vi.mock("../utils/path.js", () => ({
  resolveConfigDir: vi.fn(() => "/home/user/.config/opencode"),
}));
vi.mock("../infra/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockUnlink = vi.mocked(unlink);

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

describe("writeOmoConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates directory and writes file atomically", async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const omoConfig: OmoFileConfig = { theme: "dark", maxTokens: 4096 };
    await writeOmoConfig(omoConfig, "/home/user/.config/opencode");

    expect(mockMkdir).toHaveBeenCalledWith("/home/user/.config/opencode", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/home/user/.config/opencode/oh-my-opencode.json.tmp",
      JSON.stringify(omoConfig, null, 2) + "\n",
      "utf-8",
    );
    expect(mockRename).toHaveBeenCalledWith(
      "/home/user/.config/opencode/oh-my-opencode.json.tmp",
      "/home/user/.config/opencode/oh-my-opencode.json",
    );
  });

  it("handles existing directory without failing", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const omoConfig: OmoFileConfig = { key: "value" };
    await writeOmoConfig(omoConfig, "/existing/dir");

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockRename).toHaveBeenCalled();
  });

  it("overwrites existing oh-my-opencode.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const omoConfig: OmoFileConfig = { newKey: "newValue" };
    await writeOmoConfig(omoConfig, "/existing/dir");

    const expectedContent = JSON.stringify(omoConfig, null, 2) + "\n";
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/existing/dir/oh-my-opencode.json.tmp",
      expectedContent,
      "utf-8",
    );
    expect(mockRename).toHaveBeenCalledWith(
      "/existing/dir/oh-my-opencode.json.tmp",
      "/existing/dir/oh-my-opencode.json",
    );
  });

  it("cleans up tmp file on write failure", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockRejectedValue(new Error("disk full"));

    const omoConfig: OmoFileConfig = { key: "value" };

    await expect(writeOmoConfig(omoConfig, "/some/dir")).rejects.toThrow("disk full");
    expect(mockUnlink).toHaveBeenCalledWith("/some/dir/oh-my-opencode.json.tmp");
  });

  it("cleans up tmp file on rename failure", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockRejectedValue(new Error("rename failed"));

    const omoConfig: OmoFileConfig = { key: "value" };

    await expect(writeOmoConfig(omoConfig, "/some/dir")).rejects.toThrow("rename failed");
    expect(mockUnlink).toHaveBeenCalledWith("/some/dir/oh-my-opencode.json.tmp");
  });

  it("throws descriptive error on permission denied", async () => {
    mockExistsSync.mockReturnValue(true);
    const permError = new Error("EACCES") as NodeJS.ErrnoException;
    permError.code = "EACCES";
    mockWriteFile.mockRejectedValue(permError);

    const omoConfig: OmoFileConfig = { key: "value" };

    await expect(writeOmoConfig(omoConfig, "/locked/dir")).rejects.toThrow(
      "Permission denied writing config file: /locked/dir/oh-my-opencode.json",
    );
  });
});

describe("injectConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns configContent string and opencodeConfigDir", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const configs: LoadedConfigs = {
      openplaw: { channels: {} },
      opencode: {},
      omo: { theme: "dark" },
      openplawDir: "/home/user/.openplaw",
    };
    const merged: MergedConfigResult = {
      opencodeConfig: { plugin: ["oh-my-opencode"] } as OpencodeConfig,
      openplawConfig: { channels: {} },
    };

    const result = await injectConfig(configs, merged);

    expect(result.configContent).toBe('{"plugin":["oh-my-opencode"]}');
    expect(result.opencodeConfigDir).toBe("/home/user/.config/opencode");
  });

  it("writes omo config to the resolved opencode config dir", async () => {
    mockExistsSync.mockReturnValue(true);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    const omoConfig: OmoFileConfig = { theme: "light", fontSize: 14 };
    const configs: LoadedConfigs = {
      openplaw: {},
      opencode: {},
      omo: omoConfig,
      openplawDir: "/home/user/.openplaw",
    };
    const merged: MergedConfigResult = {
      opencodeConfig: {} as OpencodeConfig,
      openplawConfig: {},
    };

    await injectConfig(configs, merged);

    const expectedContent = JSON.stringify(omoConfig, null, 2) + "\n";
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/home/user/.config/opencode/oh-my-opencode.json.tmp",
      expectedContent,
      "utf-8",
    );
  });
});
