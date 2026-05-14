export type HeartbeatConfig = {
  intervalMs: number;
  enabled: boolean;
};

export type HeartbeatRunner = {
  stop: () => void;
};

export function startHeartbeatRunner(
  config: HeartbeatConfig,
  callback: () => Promise<void> | void
): HeartbeatRunner {
  if (!config.enabled) {
    return { stop: () => {} };
  }

  const intervalId = setInterval(async () => {
    try {
      await callback();
    } catch (error) {
      // Prevent interval from dying on error
      console.error("Heartbeat callback error:", error);
    }
  }, config.intervalMs);

  return {
    stop: () => {
      clearInterval(intervalId);
    },
  };
}

export async function runHeartbeatOnce(
  callback: () => Promise<void> | void
): Promise<void> {
  try {
    await callback();
  } catch (error) {
    console.error("Heartbeat once callback error:", error);
    throw error;
  }
}
