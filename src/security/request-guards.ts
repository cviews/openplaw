import * as http from "node:http";
import { createFixedWindowRateLimiter } from "./rate-limiter.js";

export type ApplyBasicWebhookRequestGuardsParams = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  allowMethods?: string[];
  requireJsonContentType?: boolean;
  rateLimiter?: ReturnType<typeof createFixedWindowRateLimiter>;
  rateLimitKey?: string;
};

export function applyBasicWebhookRequestGuards(params: ApplyBasicWebhookRequestGuardsParams): boolean {
  const { req, res, allowMethods = ["POST"], requireJsonContentType = false, rateLimiter, rateLimitKey } = params;

  const method = req.method?.toUpperCase() ?? "";
  if (!allowMethods.includes(method)) {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return false;
  }

  if (requireJsonContentType) {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unsupported Media Type" }));
      return false;
    }
  }

  if (rateLimiter != null && rateLimitKey != null) {
    if (rateLimiter.isRateLimited(rateLimitKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too Many Requests" }));
      return false;
    }
  }

  return true;
}
