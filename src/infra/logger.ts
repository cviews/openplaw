export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogListener = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LoggerOptions = {
  level?: LogLevel;
  prefix?: string;
};

export class Logger {
  private level: LogLevel;
  prefix: string;
  private listeners: LogListener[] = [];

  constructor(options?: LoggerOptions) {
    this.level = options?.level ?? "info";
    this.prefix = options?.prefix ?? "openplaw";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  addListener(listener: LogListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: LogListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  child(prefix: string): Logger {
    return new Logger({
      level: this.level,
      prefix: `${this.prefix}:${prefix}`,
    });
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const parts = [`[${timestamp}]`, `[${this.prefix}]`, `[${level}]`, message];

    if (meta && Object.keys(meta).length > 0) {
      parts.push(JSON.stringify(meta));
    }

    const output = parts.join(" ");

    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }

    for (const listener of this.listeners) {
      listener(level, message, meta);
    }
  }
}

export const logger = new Logger();
