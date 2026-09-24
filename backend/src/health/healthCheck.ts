import type { AppConfig, ExecutionMode } from "@nexustrade/shared";

export interface HealthCheck {
  readonly app: "NeXusTrade";
  readonly mode: ExecutionMode;
  readonly nodeVersion: string;
  readonly status: "ok";
}

export function getHealthCheck(config: Pick<AppConfig, "appName" | "mode">): HealthCheck {
  return {
    app: config.appName,
    mode: config.mode,
    nodeVersion: process.version,
    status: "ok",
  };
}
