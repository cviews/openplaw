import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoReplyHandler } from "./auto-reply.js";
import type { AutoReplyContext } from "./auto-reply.js";
import type { SessionBindingService } from "../core/routing/session-binding.js";

const mockSendText = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../channels/registry.js", () => ({
  getChannelPlugin: vi.fn().mockImplementation((id: string) => {
    if (id === "test-channel") {
      return {
        id: "test-channel",
        meta: { name: "Test Channel", description: "A test channel" },
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          resolveAccount: vi.fn(),
          resolveAccounts: vi.fn().mockReturnValue([]),
        },
        outbound: {
          sendText: mockSendText,
          sendMention: vi.fn().mockResolvedValue(undefined),
        },
      };
    }
    return null;
  }),
  listChannelPlugins: vi.fn().mockReturnValue([
    {
      id: "test-channel",
      meta: { name: "Test Channel", description: "A test channel" },
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        resolveAccount: vi.fn(),
        resolveAccounts: vi.fn().mockReturnValue([]),
      },
      outbound: {
        sendText: mockSendText,
        sendMention: vi.fn().mockResolvedValue(undefined),
      },
    },
  ]),
}));

vi.mock("../infra/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockSessionBinding(): SessionBindingService {
  return {} as SessionBindingService;
}

describe("AutoReplyHandler", () => {
  let handler: AutoReplyHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new AutoReplyHandler({
      sessionBinding: createMockSessionBinding(),
      botName: "openplaw",
    });
  });

  it('responds to "help" with a help message', async () => {
    const ctx: AutoReplyContext = {
      channel: "test-channel",
      text: "help",
      chatId: "chat1",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(true);
    expect(mockSendText).toHaveBeenCalledOnce();
    const call = mockSendText.mock.calls[0][0];
    expect(call.to).toBe("chat1");
    expect(call.text).toContain("Available bots");
  });

  it('responds to "@openplaw ping" with "pong"', async () => {
    const ctx: AutoReplyContext = {
      channel: "test-channel",
      text: "@openplaw ping",
      chatId: "chat2",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(true);
    expect(mockSendText).toHaveBeenCalledOnce();
    const call = mockSendText.mock.calls[0][0];
    expect(call.text).toBe("pong");
  });

  it("returns false for a random message with no matching pattern", async () => {
    const ctx: AutoReplyContext = {
      channel: "test-channel",
      text: "random message hello",
      chatId: "chat3",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("returns false when channel plugin is not found", async () => {
    const ctx: AutoReplyContext = {
      channel: "unknown-channel",
      text: "help",
      chatId: "chat4",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('responds to "status" with a status message', async () => {
    const ctx: AutoReplyContext = {
      channel: "test-channel",
      text: "status",
      chatId: "chat5",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(true);
    expect(mockSendText).toHaveBeenCalledOnce();
    const call = mockSendText.mock.calls[0][0];
    expect(call.text).toContain("Binding status");
  });

  it("is case-insensitive for pattern matching", async () => {
    const ctx: AutoReplyContext = {
      channel: "test-channel",
      text: "HELP",
      chatId: "chat6",
    };
    const handled = await handler.handle(ctx);
    expect(handled).toBe(true);
  });
});
