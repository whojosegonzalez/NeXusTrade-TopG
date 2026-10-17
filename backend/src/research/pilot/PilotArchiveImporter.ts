/**
 * Phase 12.94-D Milestone D.2.4: Pilot Archive Importer
 *
 * Implements safe, isolated import and verification of Fedora/Linux session datasets
 * into the Windows quantitative research environment.
 *
 * Safety & Isolation:
 * - Never imports directly into historical '.tmp/telemetry/sessions/'.
 * - Uses an isolated import root: '.tmp/pilot-imports/sessions/'.
 * - Verifies SHA-256 transfer manifest BEFORE allowing any recovery or staging.
 * - Non-destructive: Rejects existing destination directories by default (D24F-04).
 * - Stages imports in disposable temporary directory; atomically publishes only verified archives.
 * - Requires verified finalized recovery status with 0 torn lines before approval.
 */

import fsSync from "node:fs";
import path from "node:path";
import { verifySessionExportManifest } from "./PilotExportManifest.js";
import type { ManifestVerificationResult, CanonicalSessionStatus } from "./PilotTypes.js";
import { PilotCollectorRunner } from "./PilotCollectorRunner.js";
import {
  auditPilotSessionCompatibility,
  type PilotSessionCompatibilityReport,
} from "./PilotResearchCompatibility.js";

export const DEFAULT_WINDOWS_IMPORT_ROOT = ".tmp/pilot-imports/sessions";

export interface PilotSessionRecoveryResult {
  readonly recovered: boolean;
  readonly status: CanonicalSessionStatus;
  readonly tornLinesIsolated: number;
  readonly diagnostics: string[];
}

export interface PilotImportOptions {
  readonly importRootDir?: string | undefined;
  readonly runRecovery?: boolean | undefined;
  readonly runCompatibilityAudit?: boolean | undefined;
  readonly allowOverwrite?: boolean | undefined;
}

export interface PilotImportResult {
  readonly ok: boolean;
  readonly importedSessionDir: string;
  readonly manifestResult: ManifestVerificationResult;
  readonly recoveryResult: PilotSessionRecoveryResult | null;
  readonly compatibilityReport: PilotSessionCompatibilityReport | null;
  readonly error?: string | undefined;
}

/**
 * Imports a pilot session directory into an isolated Windows research import directory,
 * verifying SHA-256 manifest integrity before permitting recovery or compatibility audits.
 * Staged non-destructively to prevent clobbering existing research data.
 */
export async function importAndVerifyPilotSession(
  sourceSessionDir: string,
  options?: PilotImportOptions,
): Promise<PilotImportResult> {
  const importRootDir = options?.importRootDir ?? path.resolve(DEFAULT_WINDOWS_IMPORT_ROOT);

  // Protected paths check (D24F-04)
  const resolvedImportRoot = path.resolve(importRootDir);
  const resolvedHistoricalTelemetry = path.resolve(".tmp/telemetry/sessions");
  if (resolvedImportRoot.startsWith(resolvedHistoricalTelemetry)) {
    throw new Error(
      `[PROTECTED_PATH_VIOLATION] Import root cannot resolve inside historical telemetry: '${resolvedImportRoot}'`,
    );
  }

  fsSync.mkdirSync(importRootDir, { recursive: true });

  const sessionFolderName = path.basename(sourceSessionDir);
  const targetSessionDir = path.join(importRootDir, sessionFolderName);

  // 1. Destination Collision Protection: Reject existing destination unless explicitly permitted
  const targetExists = fsSync.existsSync(targetSessionDir);
  if (targetExists && !options?.allowOverwrite) {
    return {
      ok: false,
      importedSessionDir: targetSessionDir,
      manifestResult: {
        valid: false,
        missingFiles: [],
        mismatchedFiles: [],
        extraFiles: [],
        errorDetails: `[IMPORT_DESTINATION_EXISTS] Destination directory '${targetSessionDir}' already exists. Overwriting existing imports is prohibited by default.`,
      },
      recoveryResult: null,
      compatibilityReport: null,
      error: `[IMPORT_DESTINATION_EXISTS] Destination directory '${targetSessionDir}' already exists. Overwrite prohibited without explicit allowOverwrite option.`,
    };
  }

  // 2. Mandatory Source Manifest Verification BEFORE touching target or staging
  const sourceManifestResult = await verifySessionExportManifest(sourceSessionDir);
  if (!sourceManifestResult.valid) {
    return {
      ok: false,
      importedSessionDir: targetSessionDir,
      manifestResult: sourceManifestResult,
      recoveryResult: null,
      compatibilityReport: null,
      error: `[SOURCE_MANIFEST_INVALID] Source directory failed manifest verification: missing=${sourceManifestResult.missingFiles.join(",")}, extra=${sourceManifestResult.extraFiles.join(",")}, mismatched=${sourceManifestResult.mismatchedFiles.join(",")}`,
    };
  }

  // If source and target are identical directory, run in-place
  if (path.resolve(sourceSessionDir) === path.resolve(targetSessionDir)) {
    let recoveryResult: PilotSessionRecoveryResult | null = null;
    if (options?.runRecovery !== false) {
      recoveryResult = await PilotCollectorRunner.recoverSession(targetSessionDir);
      if (
        !recoveryResult.recovered ||
        recoveryResult.status !== "FINALIZED" ||
        recoveryResult.tornLinesIsolated > 0
      ) {
        return {
          ok: false,
          importedSessionDir: targetSessionDir,
          manifestResult: sourceManifestResult,
          recoveryResult,
          compatibilityReport: null,
          error: `[RECOVERY_FAILED] In-place recovery resulted in non-finalized or corrupted status: ${recoveryResult.status}, tornLines=${recoveryResult.tornLinesIsolated}`,
        };
      }
    }

    let compatibilityReport: PilotSessionCompatibilityReport | null = null;
    if (options?.runCompatibilityAudit) {
      compatibilityReport = await auditPilotSessionCompatibility(targetSessionDir);
    }

    return {
      ok: true,
      importedSessionDir: targetSessionDir,
      manifestResult: sourceManifestResult,
      recoveryResult,
      compatibilityReport,
    };
  }

  // 3. Stage import in isolated temporary staging directory
  const stagingDir = path.join(
    importRootDir,
    `.staging-${sessionFolderName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  fsSync.mkdirSync(stagingDir, { recursive: true });

  let stagingPublished = false;

  try {
    const entries = fsSync.readdirSync(sourceSessionDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fsSync.copyFileSync(path.join(sourceSessionDir, ent.name), path.join(stagingDir, ent.name));
      }
    }

    // 4. Verify Staging Manifest Integrity
    const stagingManifestResult = await verifySessionExportManifest(stagingDir);
    if (!stagingManifestResult.valid) {
      return {
        ok: false,
        importedSessionDir: targetSessionDir,
        manifestResult: stagingManifestResult,
        recoveryResult: null,
        compatibilityReport: null,
        error: `[STAGING_MANIFEST_INVALID] Staging directory failed manifest verification`,
      };
    }

    // 5. Run Recovery on Staging Dataset and require verified FINALIZED status
    let recoveryResult: PilotSessionRecoveryResult | null = null;
    if (options?.runRecovery !== false) {
      recoveryResult = await PilotCollectorRunner.recoverSession(stagingDir);
      if (
        !recoveryResult.recovered ||
        recoveryResult.status !== "FINALIZED" ||
        recoveryResult.tornLinesIsolated > 0
      ) {
        return {
          ok: false,
          importedSessionDir: targetSessionDir,
          manifestResult: stagingManifestResult,
          recoveryResult,
          compatibilityReport: null,
          error: `[RECOVERY_FAILED] Session recovery in staging resulted in non-finalized or corrupted status: ${recoveryResult.status}, tornLines=${recoveryResult.tornLinesIsolated}`,
        };
      }

      // Re-verify manifest after recovery to ensure recovery did not corrupt or mutate files
      const postRecoveryManifest = await verifySessionExportManifest(stagingDir);
      if (!postRecoveryManifest.valid) {
        return {
          ok: false,
          importedSessionDir: targetSessionDir,
          manifestResult: postRecoveryManifest,
          recoveryResult,
          compatibilityReport: null,
          error: `[RECOVERY_MUTATED_MANIFEST] Session recovery mutated files violating export manifest`,
        };
      }
    }

    // 6. Safe publish verified staging directory to final target directory with failure-safe rollback (D24R2-02)
    let backupDir: string | null = null;
    if (targetExists) {
      backupDir = path.join(
        importRootDir,
        `.backup-${sessionFolderName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      );
      try {
        fsSync.renameSync(targetSessionDir, backupDir);
      } catch {
        // Fallback copy to backup if rename fails
        fsSync.mkdirSync(backupDir, { recursive: true });
        for (const ent of fsSync.readdirSync(targetSessionDir, { withFileTypes: true })) {
          if (ent.isFile()) {
            fsSync.copyFileSync(
              path.join(targetSessionDir, ent.name),
              path.join(backupDir, ent.name),
            );
          }
        }
        fsSync.rmSync(targetSessionDir, { recursive: true, force: true });
      }
    }

    try {
      try {
        fsSync.renameSync(stagingDir, targetSessionDir);
        stagingPublished = true;
      } catch {
        // Fallback copy if cross-device link occurs
        fsSync.mkdirSync(targetSessionDir, { recursive: true });
        const stagedEntries = fsSync.readdirSync(stagingDir, { withFileTypes: true });
        for (const ent of stagedEntries) {
          if (ent.isFile()) {
            fsSync.copyFileSync(
              path.join(stagingDir, ent.name),
              path.join(targetSessionDir, ent.name),
            );
          }
        }
        stagingPublished = true;
      }

      // Publish succeeded: safely clean up temporary backup directory
      if (backupDir && fsSync.existsSync(backupDir)) {
        try {
          fsSync.rmSync(backupDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup
        }
      }
    } catch (publishErr) {
      // D24R2-02: PUBLISH FAILED! ROLL BACK PREVIOUS DATASET FROM BACKUP TO PREVENT DATA LOSS!
      if (fsSync.existsSync(targetSessionDir)) {
        try {
          fsSync.rmSync(targetSessionDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure during rollback
        }
      }
      if (backupDir && fsSync.existsSync(backupDir)) {
        try {
          fsSync.renameSync(backupDir, targetSessionDir);
        } catch {
          fsSync.mkdirSync(targetSessionDir, { recursive: true });
          for (const ent of fsSync.readdirSync(backupDir, { withFileTypes: true })) {
            if (ent.isFile()) {
              fsSync.copyFileSync(
                path.join(backupDir, ent.name),
                path.join(targetSessionDir, ent.name),
              );
            }
          }
          try {
            fsSync.rmSync(backupDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup failure during rollback
          }
        }
      }

      return {
        ok: false,
        importedSessionDir: targetSessionDir,
        manifestResult: stagingManifestResult,
        recoveryResult,
        compatibilityReport: null,
        error: `[PUBLISH_FAILED_ROLLED_BACK] Staging publish failed: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}. Existing destination was safely restored from backup.`,
      };
    }

    let compatibilityReport: PilotSessionCompatibilityReport | null = null;
    if (options?.runCompatibilityAudit) {
      compatibilityReport = await auditPilotSessionCompatibility(targetSessionDir);
    }

    return {
      ok: true,
      importedSessionDir: targetSessionDir,
      manifestResult: stagingManifestResult,
      recoveryResult,
      compatibilityReport,
    };
  } finally {
    if (!stagingPublished && fsSync.existsSync(stagingDir)) {
      try {
        fsSync.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // cleanup ignore
      }
    }
  }
}
