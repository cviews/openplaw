import { logger } from "../infra/logger.js";
import { pushLogEntry } from "../web/routes/log-routes.js";

export function bridgeLoggerToWeb(): void {
  logger.addListener((level, message, meta) => {
    pushLogEntry({
      timestamp: new Date().toISOString(),
      level,
      message,
      meta,
      source: logger.prefix,
    });
  });
}