import type { ExecutionMode } from "./modes.js";

export interface AppConfig {
  readonly appName: "NeXusTrade";
  readonly mode: ExecutionMode;
  readonly nodeEnv: "development" | "test" | "production";
}
