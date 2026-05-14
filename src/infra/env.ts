import { logger } from "./logger.js";

export type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

const truthyValues = new Set(["1", "true", "yes", "on"]);

export function isTruthyEnvValue(value?: string): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return truthyValues.has(normalized);
}

export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OPENMO_") && typeof value === "string") {
      process.env[key] = value.trim();
    }
  }
}

export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  const { key, description, value, redact } = option;
  let displayValue = value;
  if (redact && value) {
    if (value.length <= 3) {
      displayValue = "*".repeat(value.length);
    } else {
      const visibleStart = value.slice(0, 3);
      const masked = "*".repeat(Math.max(0, value.length - 3));
      displayValue = `${visibleStart}${masked}`;
    }
  }
  logger.info(`Env: ${key} - ${description}`, { value: displayValue });
}

export function isVitestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST || env.VITEST_WORKER_ID);
}
