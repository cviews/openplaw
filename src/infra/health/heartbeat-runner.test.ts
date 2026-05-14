import { describe, it, expect, vi, afterEach } from "vitest";
import { startHeartbeatRunner, runHeartbeatOnce } from "./heartbeat-runner.js";

describe("heartbeat-runner", () => {
  let runner: { stop: () => void } | null = null;

  afterEach(() => {
    if (runner) {
      runner.stop();
      runner = null;
    }
  });

  it("startHeartbeatRunner should call callback periodically", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    
    runner = startHeartbeatRunner(
      { intervalMs: 50, enabled: true },
      callback
    );

    // Wait for at least one call
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(callback).toHaveBeenCalledTimes(1);

    // Wait for another call
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("startHeartbeatRunner should not call callback when disabled", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    
    runner = startHeartbeatRunner(
      { intervalMs: 10, enabled: false },
      callback
    );

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(callback).not.toHaveBeenCalled();
  });

  it("startHeartbeatRunner should stop calling after stop()", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    
    runner = startHeartbeatRunner(
      { intervalMs: 50, enabled: true },
      callback
    );

    await new Promise(resolve => setTimeout(resolve, 60));
    const callCount = callback.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);

    runner.stop();
    await new Promise(resolve => setTimeout(resolve, 70));
    
    // Should not have added more calls after stop
    expect(callback).toHaveBeenCalledTimes(callCount);
  });

  it("runHeartbeatOnce should call callback once", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    
    await runHeartbeatOnce(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runHeartbeatOnce should propagate error", async () => {
    const error = new Error("Test error");
    const callback = vi.fn().mockRejectedValue(error);
    
    await expect(runHeartbeatOnce(callback)).rejects.toThrow(error);
  });

  it("startHeartbeatRunner should continue on error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    
    const callback = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("First call error");
      }
      return Promise.resolve();
    });
    
    runner = startHeartbeatRunner(
      { intervalMs: 50, enabled: true },
      callback
    );

    await new Promise(resolve => setTimeout(resolve, 110));
    expect(callCount).toBeGreaterThan(1); // Should have made second call even after error
    expect(consoleErrorSpy).toHaveBeenCalled();
    
    consoleErrorSpy.mockRestore();
  });
});
