import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { applyBasicWebhookRequestGuards } from "./request-guards.js";
import { createFixedWindowRateLimiter } from "./rate-limiter.js";

function mockReq(
  overrides: Partial<http.IncomingMessage> = {},
): http.IncomingMessage {
  return Object.create(http.IncomingMessage.prototype, {
    method: { value: overrides.method ?? "POST", writable: true },
    headers: { value: overrides.headers ?? { "content-type": "application/json" } },
  }) as http.IncomingMessage;
}

function mockRes() {
  const state = { statusCode: 200, body: "" };
  const res = {
    writeHead(code: number) {
      state.statusCode = code;
    },
    end(data?: string) {
      state.body = data ?? "";
    },
  } as unknown as http.ServerResponse;
  return { res, state };
}

describe("applyBasicWebhookRequestGuards", () => {
  it("allows valid POST with json content-type", () => {
    const req = mockReq();
    const { res } = mockRes();
    expect(applyBasicWebhookRequestGuards({ req, res })).toBe(true);
  });

  it("rejects disallowed method with 405", () => {
    const req = mockReq({ method: "GET" });
    const { res, state } = mockRes();
    expect(applyBasicWebhookRequestGuards({ req, res })).toBe(false);
    expect(state.statusCode).toBe(405);
  });

  it("allows custom allowMethods", () => {
    const req = mockReq({ method: "PUT" });
    const { res } = mockRes();
    expect(applyBasicWebhookRequestGuards({ req, res, allowMethods: ["PUT"] })).toBe(true);
  });

  it("rejects non-json content-type with 415 when requireJsonContentType is true", () => {
    const req = mockReq({ headers: { "content-type": "text/plain" } });
    const { res, state } = mockRes();
    expect(
      applyBasicWebhookRequestGuards({ req, res, requireJsonContentType: true }),
    ).toBe(false);
    expect(state.statusCode).toBe(415);
  });

  it("allows non-json content-type when requireJsonContentType is false", () => {
    const req = mockReq({ headers: { "content-type": "text/plain" } });
    const { res } = mockRes();
    expect(
      applyBasicWebhookRequestGuards({ req, res, requireJsonContentType: false }),
    ).toBe(true);
  });

  it("rejects rate-limited key with 429", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60000, maxRequests: 1 });
    limiter.isRateLimited("limited-key");
    const req = mockReq();
    const { res, state } = mockRes();
    expect(
      applyBasicWebhookRequestGuards({ req, res, rateLimiter: limiter, rateLimitKey: "limited-key" }),
    ).toBe(false);
    expect(state.statusCode).toBe(429);
  });

  it("allows request when rate limiter is provided but not limited", () => {
    const limiter = createFixedWindowRateLimiter({ windowMs: 60000, maxRequests: 100 });
    const req = mockReq();
    const { res } = mockRes();
    expect(
      applyBasicWebhookRequestGuards({ req, res, rateLimiter: limiter, rateLimitKey: "ok-key" }),
    ).toBe(true);
  });

  it("skips rate limit check when rateLimiter is not provided", () => {
    const req = mockReq();
    const { res } = mockRes();
    expect(applyBasicWebhookRequestGuards({ req, res })).toBe(true);
  });
});
