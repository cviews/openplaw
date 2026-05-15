import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("returns all defaults when input is empty", () => {
    const config = resolveConfig({});
    expect(config.bots).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(config.channels).toEqual({});
    expect(config.agents.directory).toEqual([path.join(os.homedir(), ".config", "openplaw", "agents")]);
    expect(config.agents.botAgentMap).toEqual({});
    expect(config.mcp.servers).toEqual({});
    expect(config.mcp.autoRegister).toBe(true);
    expect(config.gateway.port).toBe(3000);
    expect(config.gateway.host).toBe("0.0.0.0");
    expect(config.bindings.dir).toBe(path.join(os.homedir(), ".openplaw", "bindings"));
    expect(config.bindings.file).toBe("current-conversations.json");
    expect(config.bindings.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.verbose).toBe(false);
    expect(config.configDir).toBe(path.join(os.homedir(), ".config", "openplaw"));
  });

  it("returns all defaults when input is undefined", () => {
    const config = resolveConfig(undefined);
    expect(config.bots).toEqual([]);
    expect(config.channels).toEqual({});
    expect(config.agents.directory).toEqual([path.join(os.homedir(), ".config", "openplaw", "agents")]);
    expect(config.verbose).toBe(false);
    expect(config.configDir).toBe(path.join(os.homedir(), ".config", "openplaw"));
  });

  it("fills defaults for partial input", () => {
    const config = resolveConfig({
      channels: { feishu: { appId: "x", appSecret: "y" } },
      agents: { directory: "/custom/agents" },
    });
    expect(config.bots.length).toBe(1);
    expect(config.bots[0].appId).toBe("x");
    expect(config.bots[0].appSecret).toBe("y");
    expect(config.groups.length).toBe(1);
    expect((config.channels.feishu as Record<string, unknown>).appId).toBe("x");
    expect((config.channels.feishu as Record<string, unknown>).appSecret).toBe("y");
    expect(config.agents.directory).toEqual(["/custom/agents"]);
    expect(config.agents.botAgentMap).toEqual({ main: "main" });
    expect(config.mcp.servers).toEqual({});
    expect(config.mcp.autoRegister).toBe(true);
    expect(config.gateway.port).toBe(3000);
    expect(config.verbose).toBe(false);
  });

  it("preserves full input without overriding", () => {
    const input = {
      channels: { dingtalk: { token: "abc" } },
      agents: { directory: "/my/agents", botAgentMap: { bot1: "agent1" } },
      mcp: { servers: { myserver: { command: "node" } }, autoRegister: false },
    };
    const config = resolveConfig(input);
    expect(config.channels).toEqual({});
    expect(config.agents.directory).toEqual(["/my/agents"]);
    expect(config.agents.botAgentMap).toEqual({ bot1: "agent1" });
    expect(config.mcp.servers).toEqual({ myserver: { command: "node" } });
    expect(config.mcp.autoRegister).toBe(false);
  });

  it("always fills gateway and bindings even when not provided", () => {
    const config = resolveConfig({});
    expect(config.gateway).toEqual({ port: 3000, host: "0.0.0.0" });
    expect(config.bindings.file).toBe("current-conversations.json");
    expect(config.bindings.ttlMs).toBe(86400000);
  });

  it("fills default ports when not provided", () => {
    const config = resolveConfig({});
    expect(config.ports).toEqual({
      health: 9090,
      opencode: 4096,
      hub: 4097,
      web: 4098,
    });
  });

  it("reads all ports from config", () => {
    const config = resolveConfig({
      ports: {
        gateway: 8080,
        gatewayHost: "127.0.0.1",
        health: 8081,
        opencode: 5000,
        hub: 5001,
        web: 5002,
      },
    });
    expect(config.ports.health).toBe(8081);
    expect(config.ports.opencode).toBe(5000);
    expect(config.ports.hub).toBe(5001);
    expect(config.ports.web).toBe(5002);
    expect(config.gateway.port).toBe(8080);
    expect(config.gateway.host).toBe("127.0.0.1");
  });

  it("reads gateway port from ports.gateway with backward compat", () => {
    const config = resolveConfig({
      ports: { gateway: 9000 },
    });
    expect(config.gateway.port).toBe(9000);
  });

  it("falls back to gateway.port when ports.gateway is not set", () => {
    const config = resolveConfig({
      gateway: { port: 7000 },
    });
    expect(config.gateway.port).toBe(7000);
    expect(config.ports.health).toBe(9090);
  });

  it("ports.gateway takes precedence over gateway.port", () => {
    const config = resolveConfig({
      ports: { gateway: 9000 },
      gateway: { port: 7000 },
    });
    expect(config.gateway.port).toBe(9000);
  });

  it("fills partial ports with defaults", () => {
    const config = resolveConfig({
      ports: { opencode: 5000 },
    });
    expect(config.ports.opencode).toBe(5000);
    expect(config.ports.health).toBe(9090);
    expect(config.ports.hub).toBe(4097);
    expect(config.ports.web).toBe(4098);
    expect(config.gateway.port).toBe(3000);
  });

  it("reads gateway port and host from config", () => {
    const config = resolveConfig({
      gateway: { port: 8080, host: "127.0.0.1" },
    });
    expect(config.gateway.port).toBe(8080);
    expect(config.gateway.host).toBe("127.0.0.1");
  });

  it("fills default gateway host when only port is provided", () => {
    const config = resolveConfig({
      gateway: { port: 5000 },
    });
    expect(config.gateway.port).toBe(5000);
    expect(config.gateway.host).toBe("0.0.0.0");
  });

  it("uses bots/groups when provided (new format takes precedence)", () => {
    const config = resolveConfig({
      bots: [
        {
          id: "sisyphus",
          agent: "sisyphus",
          appId: "cli_123",
          appSecret: "secret",
          verificationToken: "vt",
          encryptKey: "ek",
          botName: "SisyphusBot",
        },
      ],
      groups: [
        { id: "team-alpha", chatId: "oc_xxx", name: "研发部群", bots: ["sisyphus"] },
      ],
    });
    expect(config.bots.length).toBe(1);
    expect(config.bots[0].id).toBe("sisyphus");
    expect(config.groups.length).toBe(1);
    expect(config.groups[0].id).toBe("team-alpha");
    expect(config.groups[0].chatId).toBe("oc_xxx");
  });

  it("derives channels.feishu from single bot config", () => {
    const config = resolveConfig({
      bots: [
        {
          id: "bot-a",
          agent: "main",
          appId: "cli_456",
          appSecret: "sec",
          verificationToken: "vt2",
          encryptKey: "ek2",
          botName: "MyBot",
        },
      ],
    });
    expect(config.channels.feishu).toEqual({
      appId: "cli_456",
      appSecret: "sec",
      verificationToken: "vt2",
      encryptKey: "ek2",
      botName: "MyBot",
    });
  });

  it("derives botAgentMap from bots", () => {
    const config = resolveConfig({
      bots: [
        { id: "bot-a", agent: "oracle", appId: "a", appSecret: "s", verificationToken: "v", encryptKey: "e", botName: "OracleBot" },
        { id: "bot-b", agent: "explore", appId: "b", appSecret: "s2", verificationToken: "v2", encryptKey: "e2", botName: "ExploreBot" },
      ],
    });
    expect(config.agents.botAgentMap).toEqual({
      "bot-a": "OracleBot",
      oracle: "OracleBot",
      "bot-b": "ExploreBot",
      explore: "ExploreBot",
    });
  });

  it("auto-converts channels.feishu to bots and groups", () => {
    const config = resolveConfig({
      channels: {
        feishu: {
          appId: "cli_legacy",
          appSecret: "sec_legacy",
          verificationToken: "vt_legacy",
          encryptKey: "ek_legacy",
          botName: "LegacyBot",
        },
      },
    });
    expect(config.bots.length).toBe(1);
    expect(config.bots[0].id).toBe("LegacyBot");
    expect(config.bots[0].appId).toBe("cli_legacy");
    expect(config.groups.length).toBe(1);
    expect(config.groups[0].id).toBe("default");
    expect(config.groups[0].chatId).toBe("");
    expect(config.groups[0].bots).toEqual(["LegacyBot"]);
  });

  it("new format takes precedence over legacy channels", () => {
    const config = resolveConfig({
      bots: [
        { id: "new-bot", agent: "main", appId: "new", appSecret: "s", verificationToken: "v", encryptKey: "e", botName: "NewBot" },
      ],
      groups: [
        { id: "new-group", chatId: "oc_new", name: "New Group", bots: ["new-bot"] },
      ],
      channels: {
        feishu: { appId: "old", appSecret: "old_s" },
      },
    });
    expect(config.bots[0].appId).toBe("new");
    expect(config.groups[0].id).toBe("new-group");
  });

  it("merges legacy botAgentMap entries not covered by bots", () => {
    const config = resolveConfig({
      bots: [
        { id: "bot-a", agent: "oracle", appId: "a", appSecret: "s", verificationToken: "v", encryptKey: "e", botName: "OracleBot" },
      ],
      agents: { botAgentMap: { custom: "CustomBot" } },
    });
    expect(config.agents.botAgentMap["custom"]).toBe("CustomBot");
    expect(config.agents.botAgentMap["bot-a"]).toBe("OracleBot");
  });

  it("normalizes agents.directory string to array", () => {
    const config = resolveConfig({
      agents: { directory: "/single/path" },
    });
    expect(config.agents.directory).toEqual(["/single/path"]);
  });

  it("preserves agents.directory array", () => {
    const config = resolveConfig({
      agents: { directory: ["~/.config/openplaw/agents", "./agents"] },
    });
    expect(config.agents.directory).toEqual(["~/.config/openplaw/agents", "./agents"]);
  });

  it("defaults agents.directory to [configDir/agents]", () => {
    const config = resolveConfig({});
    expect(config.agents.directory).toEqual([path.join(os.homedir(), ".config", "openplaw", "agents")]);
    expect(config.agents.directory.length).toBe(1);
  });
});
