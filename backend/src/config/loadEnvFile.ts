import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "..", "..", "..");
let envFileLoaded = false;

export function loadLocalEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  if (env !== process.env || envFileLoaded) {
    return;
  }

  envFileLoaded = true;
  const envPath = path.join(repoRoot, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  process.loadEnvFile(envPath);
}
