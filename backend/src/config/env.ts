import { DEFAULT_EXECUTION_MODE, parseExecutionMode, type AppConfig } from "@nexustrade/shared";
import { z } from "zod";

import { loadLocalEnvFile } from "./loadEnvFile.js";
import { createProviderConfig, type ProviderConfig } from "../providers/config/providerConfig.js";

const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development");

const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    NEXUSTRADE_MODE: z.string().optional(),
  })
  .passthrough();

export interface BackendAppConfig extends AppConfig {
  readonly providers: ProviderConfig;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): BackendAppConfig {
  loadLocalEnvFile(env);

  const parsed = envSchema.parse(env);
  const mode = parseExecutionMode(parsed.NEXUSTRADE_MODE ?? DEFAULT_EXECUTION_MODE);

  return {
    appName: "NeXusTrade",
    mode,
    nodeEnv: parsed.NODE_ENV,
    providers: createProviderConfig(env),
  };
}
