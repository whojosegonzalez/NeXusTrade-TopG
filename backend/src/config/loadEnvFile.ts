import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "..", "..", "..");
let envFileLoaded = false;

export function loadLocalEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  customEnvPath?: string,
): void {
  if (env !== process.env || (!customEnvPath && envFileLoaded)) {
    return;
  }

  if (!customEnvPath) {
    envFileLoaded = true;
  }
  const envPath = customEnvPath ?? path.join(repoRoot, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  process.loadEnvFile(envPath);
}

export function resetEnvFileLoadedForTesting(): void {
  envFileLoaded = false;
}
