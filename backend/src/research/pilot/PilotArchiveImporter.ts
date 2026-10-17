/**
 * Phase 12.94-D Milestone D.2.4: Pilot Archive Importer
 *
 * Implements safe, isolated import and verification of Fedora/Linux session datasets
 * into the Windows quantitative research environment.
 *
 * Safety & Isolation:
 * - Never imports directly into historical '.tmp/telemetry/sessions/'.
 * - Uses an isolated import root: '.tmp/pilot-imports/sessions/'.
 * - Verifies SHA-256 transfer manifest BEFORE allowing any recovery or analysis.
 * - Prevents mutating repairs on invalid, tampered, or corrupted archives.
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
 */
export async function importAndVerifyPilotSession(
  sourceSessionDir: string,
  options?: {
    importRootDir?: string | undefined;
    runRecovery?: boolean | undefined;
    runCompatibilityAudit?: boolean | undefined;
  },
): Promise<PilotImportResult> {
  const importRootDir = options?.importRootDir ?? path.resolve(DEFAULT_WINDOWS_IMPORT_ROOT);
  fsSync.mkdirSync(importRootDir, { recursive: true });

  const sessionFolderName = path.basename(sourceSessionDir);
  const targetSessionDir = path.join(importRootDir, sessionFolderName);

  // If importing from external path to target directory, copy files safely
  if (path.resolve(sourceSessionDir) !== path.resolve(targetSessionDir)) {
    if (fsSync.existsSync(targetSessionDir)) {
      fsSync.rmSync(targetSessionDir, { recursive: true, force: true });
    }
    fsSync.mkdirSync(targetSessionDir, { recursive: true });

    const entries = fsSync.readdirSync(sourceSessionDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fsSync.copyFileSync(
          path.join(sourceSessionDir, ent.name),
          path.join(targetSessionDir, ent.name),
        );
      }
    }
  }

  // 1. Mandatory Manifest Integrity Verification
  const manifestResult = await verifySessionExportManifest(targetSessionDir);
  if (!manifestResult.valid) {
    return {
      ok: false,
      importedSessionDir: targetSessionDir,
      manifestResult,
      recoveryResult: null,
      compatibilityReport: null,
      error: `[MANIFEST_VERIFICATION_FAILED] Imported session failed manifest integrity: missing=${manifestResult.missingFiles.join(",")}, extra=${manifestResult.extraFiles.join(",")}, mismatched=${manifestResult.mismatchedFiles.join(",")}`,
    };
  }

  let recoveryResult: PilotSessionRecoveryResult | null = null;
  if (options?.runRecovery !== false) {
    recoveryResult = await PilotCollectorRunner.recoverSession(targetSessionDir);
  }

  let compatibilityReport: PilotSessionCompatibilityReport | null = null;
  if (options?.runCompatibilityAudit) {
    compatibilityReport = await auditPilotSessionCompatibility(targetSessionDir);
  }

  return {
    ok: true,
    importedSessionDir: targetSessionDir,
    manifestResult,
    recoveryResult,
    compatibilityReport,
  };
}
