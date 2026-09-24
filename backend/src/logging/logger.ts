export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  readonly debug: (message: string, meta?: unknown) => void;
  readonly info: (message: string, meta?: unknown) => void;
  readonly warn: (message: string, meta?: unknown) => void;
  readonly error: (message: string, meta?: unknown) => void;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) {
    return "";
  }

  if (typeof meta === "string") {
    return ` ${meta}`;
  }

  return ` ${JSON.stringify(meta)}`;
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] [${scope}] ${message}${formatMeta(meta)}`;

  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => writeLog("debug", scope, message, meta),
    info: (message, meta) => writeLog("info", scope, message, meta),
    warn: (message, meta) => writeLog("warn", scope, message, meta),
    error: (message, meta) => writeLog("error", scope, message, meta),
  };
}
