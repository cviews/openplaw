import { describe, it, expect, afterEach } from "vitest";
import { HealthCheckServer } from "./health-server.js";

describe("HealthCheckServer", () => {
  let server: HealthCheckServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("should start and stop without error", async () => {
    server = new HealthCheckServer({ port: 9876 });
    await expect(server.start()).resolves.not.toThrow();
    await expect(server.stop()).resolves.not.toThrow();
  });

  it("should return valid health JSON response", async () => {
    server = new HealthCheckServer({
      port: 9877,
      providers: {
        getGatewayStatus: async () => ({ running: true, port: 8080 }),
        getChannelCount: () => 5,
        getBindingsCount: () => 10,
      },
    });
    await server.start();

    const response = await fetch("http://127.0.0.1:9877/health");
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.uptime).toBeGreaterThanOrEqual(0);
    expect(data.gateway).toEqual({ running: true, port: 8080 });
    expect(data.channels).toBe(5);
    expect(data.bindings).toBe(10);
    expect(data.timestamp).toBeDefined();
    expect(new Date(data.timestamp).isValid()).toBe(true);
  });

  it("should work with no providers", async () => {
    server = new HealthCheckServer({ port: 9878 });
    await server.start();

    const response = await fetch("http://127.0.0.1:9878/health");
    const data = await response.json();
    
    expect(data.status).toBe("ok");
    expect(data.gateway).toBeNull();
    expect(data.channels).toBe(0);
    expect(data.bindings).toBe(0);
  });
});

// Helper for date validation
declare global {
  interface Date {
    isValid(): boolean;
  }
}

Date.prototype.isValid = function () {
  return !isNaN(this.getTime());
};
