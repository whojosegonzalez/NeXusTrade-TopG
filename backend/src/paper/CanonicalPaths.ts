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
