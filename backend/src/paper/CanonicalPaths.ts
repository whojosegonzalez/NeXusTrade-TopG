import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Finds the authoritative repository / workspace root by walking up from startDir.
 * Looks for pnpm-workspace.yaml, .git, or root package.json with name 'nexustrade-otis'.
 */
export function findWorkspaceRoot(
  startDir: string = process.cwd(),
  failIfNotFound: boolean = true,
  stopAtDir?: string,
): string {
  let cur = path.resolve(startDir);
  const stopResolved = stopAtDir ? path.resolve(stopAtDir) : undefined;
  while (true) {
    if (existsSync(path.join(cur, "pnpm-workspace.yaml")) || existsSync(path.join(cur, ".git"))) {
      return cur;
    }
    const pkgJson = path.join(cur, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
        if (parsed.name === "nexustrade-otis") {
          return cur;
        }
      } catch {
        // ignore parse error
      }
    }
    if (stopResolved && cur === stopResolved) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (failIfNotFound) {
    throw new Error(
      `[CanonicalPaths] [FATAL_ROOT] Could not locate workspace root marker (pnpm-workspace.yaml, .git, or nexustrade-otis package.json) walking up from ${startDir}. Execution halted to prevent unanchored state writes.`,
    );
  }
  return path.resolve(startDir);
}

/**
 * Authoritative Canonical Paths anchored to the workspace root (.tmp directory).
 */
export function getCanonicalTmpDir(workspaceRoot?: string): string {
  const root = workspaceRoot ?? findWorkspaceRoot();
  return path.resolve(root, ".tmp");
}

export function getCanonicalWalletPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "virtual-wallet.json");
}

export function getCanonicalJournalPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "settlement-journal.json");
}

export function getCanonicalActiveSessionPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "paper-session-active.json");
}

export function getCanonicalPastSessionsPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "past-sessions.json");
}

export function getCanonicalSessionsDir(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "sessions");
}

export function getCanonicalSessionFilePath(sessionId: string, workspaceRoot?: string): string {
  return path.resolve(getCanonicalSessionsDir(workspaceRoot), `${sessionId}.json`);
}

export function getCanonicalLockPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "paper-process.lock");
}

export function getCanonicalObservationReportPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "session-paper-observation-report.json");
}

export function getCanonicalReconciliationAuditPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "reconciliation-audit.jsonl");
}

export function getCanonicalReconciliationIntentPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "reconciliation-intent.json");
}

/**
 * Enforces canonical, safe session identifier format.
 * Rejects path traversal, slashes, backslashes, colons, percent-encoding, and non-conforming IDs.
 */
export function validateSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`[CanonicalPaths] [FATAL_PATH] Session ID must be a non-empty string.`);
  }
  if (
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..") ||
    sessionId.includes(":") ||
    sessionId.includes("%")
  ) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Session ID '${sessionId}' contains forbidden characters or path separators. Path traversal rejected.`,
    );
  }
  const VALID_SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (!VALID_SESSION_ID_REGEX.test(sessionId)) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Invalid session ID '${sessionId}'. Session IDs must be 1-128 alphanumeric characters, dots, underscores, or hyphens.`,
    );
  }
  return sessionId;
}

export function getCanonicalTelemetryDir(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "telemetry");
}

export function getCanonicalTelemetryRegistryPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTelemetryDir(workspaceRoot), "registry.json");
}

export function getCanonicalTelemetrySessionsDir(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTelemetryDir(workspaceRoot), "sessions");
}

export function getCanonicalTelemetrySessionDir(sessionId: string, workspaceRoot?: string): string {
  const validId = validateSessionId(sessionId);
  const baseDir = getCanonicalTelemetrySessionsDir(workspaceRoot);
  const resolvedDir = path.resolve(baseDir, validId);
  const rel = path.relative(baseDir, resolvedDir);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "" || rel !== validId) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Telemetry session dir '${resolvedDir}' escapes canonical telemetry sessions base '${baseDir}'.`,
    );
  }
  return resolvedDir;
}

export function getCanonicalCandidateDecisionsPath(
  sessionId: string,
  workspaceRoot?: string,
): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "candidate-decisions.jsonl",
  );
}

export function getCanonicalMarketObservationsPath(
  sessionId: string,
  workspaceRoot?: string,
): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "market-observations.jsonl",
  );
}

export function getCanonicalStratifiedSamplesPath(
  sessionId: string,
  workspaceRoot?: string,
): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "stratified-samples.jsonl",
  );
}

export function getCanonicalSessionTelemetrySummaryPath(
  sessionId: string,
  workspaceRoot?: string,
): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "session-summary.json",
  );
}

export function getCanonicalSessionMetaPath(sessionId: string, workspaceRoot?: string): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "session-meta.json",
  );
}

export function getCanonicalExecutionQuotesPath(sessionId: string, workspaceRoot?: string): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "execution-quotes.jsonl",
  );
}

export function getCanonicalSimulatedFillsPath(sessionId: string, workspaceRoot?: string): string {
  return path.resolve(
    getCanonicalTelemetrySessionDir(sessionId, workspaceRoot),
    "simulated-fills.jsonl",
  );
}

/**
 * Enforces canonical, portable single-segment generation identifier format.
 * Rejects path traversal, slashes, backslashes, colons, percent-encoding, and non-conforming IDs.
 */
export function validateGenerationId(generationId: string): string {
  if (typeof generationId !== "string" || generationId.length === 0) {
    throw new Error(`[CanonicalPaths] [FATAL_PATH] Generation ID must be a non-empty string.`);
  }
  if (
    generationId.includes("/") ||
    generationId.includes("\\") ||
    generationId.includes("..") ||
    generationId.includes(":") ||
    generationId.includes("%")
  ) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Generation ID '${generationId}' contains forbidden characters or path separators. Path traversal rejected.`,
    );
  }
  // Portable single-segment identifier: 1-64 lowercase alphanumeric and internal hyphens
  const VALID_GEN_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
  if (!VALID_GEN_ID_REGEX.test(generationId)) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Invalid generation ID '${generationId}'. Generation IDs must be 1-64 lowercase alphanumeric characters and internal hyphens (regex: /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/).`,
    );
  }
  return generationId;
}

export function getCanonicalGenerationsDir(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "generations");
}

export function getCanonicalGenerationsRegistryPath(workspaceRoot?: string): string {
  return path.resolve(getCanonicalTmpDir(workspaceRoot), "generations-registry.json");
}

export function getCanonicalGenerationDir(generationId: string, workspaceRoot?: string): string {
  const validId = validateGenerationId(generationId);
  const baseDir = getCanonicalGenerationsDir(workspaceRoot);
  const resolvedDir = path.resolve(baseDir, validId);
  const rel = path.relative(baseDir, resolvedDir);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "" || rel !== validId) {
    throw new Error(
      `[CanonicalPaths] [FATAL_PATH] Generation dir '${resolvedDir}' escapes canonical generations base '${baseDir}'.`,
    );
  }
  return resolvedDir;
}

export function getGenerationWalletPath(generationId: string, workspaceRoot?: string): string {
  return path.resolve(
    getCanonicalGenerationDir(generationId, workspaceRoot),
    "virtual-wallet.json",
  );
}

export function getGenerationPastSessionsPath(
  generationId: string,
  workspaceRoot?: string,
): string {
  return path.resolve(getCanonicalGenerationDir(generationId, workspaceRoot), "past-sessions.json");
}

export function getGenerationSessionsDir(generationId: string, workspaceRoot?: string): string {
  return path.resolve(getCanonicalGenerationDir(generationId, workspaceRoot), "sessions");
}

/**
 * Checks for divergence between canonical file and legacy backend/.tmp mirror file.
 * Throws a fatal Error if divergent content is found, if legacy exists without canonical,
 * or if either file cannot be read, preventing silent desynchronization or split-brain state.
 */
export function checkLegacyConflict(
  canonicalPath: string,
  legacyRelativePath: string,
  fileLabel: string,
  workspaceRoot?: string,
): void {
  const root = workspaceRoot ?? findWorkspaceRoot();
  const legacyPath = path.resolve(root, legacyRelativePath);
  if (path.resolve(canonicalPath) === legacyPath) return;

  if (existsSync(canonicalPath) && existsSync(legacyPath)) {
    try {
      const cRaw = readFileSync(canonicalPath, "utf8").trim();
      const lRaw = readFileSync(legacyPath, "utf8").trim();
      if (canonicalPath.endsWith(".json") || legacyPath.endsWith(".json")) {
        try {
          JSON.parse(cRaw);
          JSON.parse(lRaw);
        } catch (parseErr) {
          throw new Error(
            `[CanonicalPaths] [FATAL_CONFLICT] Failed reading legacy/canonical ${fileLabel} during conflict verification: ${String(parseErr)}. Execution halted.`,
          );
        }
      }
      if (cRaw !== lRaw) {
        throw new Error(
          `[CanonicalPaths] [FATAL_CONFLICT] Detected divergence between canonical ${fileLabel} (${canonicalPath}) and legacy file (${legacyPath}). Manual operator reconciliation required. Execution halted to preserve ledger integrity.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("[FATAL_CONFLICT]")) throw err;
      throw new Error(
        `[CanonicalPaths] [FATAL_CONFLICT] Failed reading legacy/canonical ${fileLabel} during conflict verification: ${String(err)}. Execution halted.`,
      );
    }
  } else if (!existsSync(canonicalPath) && existsSync(legacyPath)) {
    throw new Error(
      `[CanonicalPaths] [FATAL_CONFLICT] Canonical ${fileLabel} missing at ${canonicalPath}, but legacy file exists at ${legacyPath}. Automatic migration is disabled; manual operator review required.`,
    );
  }
}
