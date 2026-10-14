import { execSync } from "node:child_process";

let cachedRevision: string | null = null;

/**
 * Resolves the immutable strategy / build revision.
 * Priority:
 * 1. Process environment (GIT_COMMIT, VITE_GIT_COMMIT)
 * 2. Git HEAD short hash (cached in memory)
 * 3. Fallback "UNKNOWN_REVISION"
 */
export function resolveStrategyRevision(): string {
  if (cachedRevision) {
    return cachedRevision;
  }

  const envCommit = process.env.GIT_COMMIT || process.env.VITE_GIT_COMMIT;
  if (envCommit && envCommit.trim().length > 0) {
    cachedRevision = envCommit.trim();
    return cachedRevision;
  }

  try {
    const gitOutput = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const trimmed = gitOutput.trim();
    if (trimmed.length > 0) {
      cachedRevision = trimmed;
      return cachedRevision;
    }
  } catch {
    // Git unavailable or execution failed
  }

  cachedRevision = "UNKNOWN_REVISION";
  return cachedRevision;
}

/**
 * Resets the cached revision (primarily for testing purposes).
 */
export function resetCachedStrategyRevision(): void {
  cachedRevision = null;
}
