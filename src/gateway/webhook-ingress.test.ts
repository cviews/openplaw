import { describe, it, expect, afterEach } from "vitest";
import { WebhookIngress } from "./webhook-ingress.js";
import type { ChannelRouteMount } from "./webhook-ingress.js";
import * as http from "node:http";

async function fetchFromServer(
  port: number,
  path: string,
  method: string = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path, method },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("WebhookIngress", () => {
  let ingress: WebhookIngress | null = null;
  let port: number = 0;

  afterEach(async () => {
    if (ingress) {
      await ingress.stop();
      ingress = null;
    }
  });

  it("should start on ephemeral port and respond to mounted routes", async () => {
    const mounts: ChannelRouteMount[] = [
      {
        channelId: "feishu:bot1",
        pathPrefix: "/webhook/feishu/bot1",
        routes: [
          {
            path: "/webhook/feishu/bot1/event",
            handler: async (_req, res) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, bot: "bot1" }));
            },
          },
          {
            path: "/webhook/feishu/bot1/card",
            handler: async (_req, res) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, bot: "bot1", type: "card" }));
            },
          },
        ],
      },
    ];

    ingress = new WebhookIngress({ port: 0, mounts });
    const runtime = await ingress.start();
    port = runtime.port;

    const result = await fetchFromServer(port, "/webhook/feishu/bot1/event");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, bot: "bot1" });
  });

  it("should return 404 for unmatched paths", async () => {
    ingress = new WebhookIngress({ port: 0, mounts: [] });
    const runtime = await ingress.start();
    port = runtime.port;

    const result = await fetchFromServer(port, "/webhook/unknown");
    expect(result.status).toBe(404);
  });

  it("should support dynamic mount/unmount", async () => {
    ingress = new WebhookIngress({ port: 0, mounts: [] });
    const runtime = await ingress.start();
    port = runtime.port;

    // Before mount: 404
    const before = await fetchFromServer(port, "/webhook/feishu/bot2/event");
    expect(before.status).toBe(404);

    // Mount
    ingress.registerChannelHandlers("feishu:bot2", "/webhook/feishu/bot2", {
      eventHandler: async (_req, res) => {
        res.writeHead(200);
        res.end("event-ok");
      },
      cardHandler: async (_req, res) => {
        res.writeHead(200);
        res.end("card-ok");
      },
    });

    // After mount: 200
    const afterMount = await fetchFromServer(port, "/webhook/feishu/bot2/event");
    expect(afterMount.status).toBe(200);
    expect(afterMount.body).toBe("event-ok");

    // Unmount
    ingress.unmount("/webhook/feishu/bot2");

    // After unmount: 404
    const afterUnmount = await fetchFromServer(port, "/webhook/feishu/bot2/event");
    expect(afterUnmount.status).toBe(404);
  });

  it("should handle POST requests with body", async () => {
    const mounts: ChannelRouteMount[] = [
      {
        channelId: "test",
        pathPrefix: "/webhook/test",
        routes: [
          {
            path: "/webhook/test/event",
            handler: async (req, res) => {
              let body = "";
              for await (const chunk of req) body += chunk;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ received: JSON.parse(body) }));
            },
          },
        ],
      },
    ];

    ingress = new WebhookIngress({ port: 0, mounts });
    const runtime = await ingress.start();
    port = runtime.port;

    const payload = JSON.stringify({ challenge: "test_challenge" });
    const result = await fetchFromServer(
      port,
      "/webhook/test/event",
      "POST",
      payload,
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).received).toEqual({ challenge: "test_challenge" });
  });
});