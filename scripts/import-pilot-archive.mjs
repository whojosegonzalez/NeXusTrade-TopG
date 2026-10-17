#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.2.4: Pilot Archive Import & Verification Script
 *
 * Implements isolated, safe import of Linux/Fedora pilot session archives into
 * the Windows research environment.
 *
 * Security & Integrity Guarantees (D24F-04 & D24R2-02):
 * - Delegates directly to canonical importAndVerifyPilotSession.
 * - Enforces full canonical verifySessionExportManifest including internal manifestDigestSha256.
 * - Executes canonical session recovery requiring recovered=true, status=FINALIZED, tornLines=0.
 * - Truthfully executes or skips auditPilotSessionCompatibility based on --no-compatibility flag.
 * - Non-Destructive: Rejects existing destination directories by default; requires unique destination.
 * - Failure-Safe Overwrite: If --overwrite is passed, utilizes verified backup-and-rollback so
 *   existing files are never lost if publish fails.
 * - Prohibits import into protected historical telemetry paths.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_IMPORT_ROOT = ".tmp/pilot-imports/sessions";

export function parseArgs(argv) {
  let source = null;
  let targetRoot = DEFAULT_IMPORT_ROOT;
  let runCompatibility = true;
  let allowOverwrite = false;

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      console.log(`NeXusTrade Pilot Archive Importer (Phase 12.94-D.2.4)
Usage: node scripts/import-pilot-archive.mjs --source=<path> [options]

Options:
  --source=<path>         Path to exported pilot session archive (required)
  --target-root=<path>    Target directory for research import (default: ${DEFAULT_IMPORT_ROOT})
  --no-compatibility      Skip D.1 research compatibility and hypothesis readiness audit
  --overwrite             Authorize replacement of existing destination using safe backup-and-rollback
  --help, -h              Display this help message
`);
      process.exit(0);
    } else if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length);
    } else if (arg.startsWith("--target-root=")) {
      targetRoot = arg.slice("--target-root=".length);
    } else if (arg === "--no-compatibility") {
      runCompatibility = false;
    } else if (arg === "--overwrite") {
      allowOverwrite = true;
    } else {
      console.error(`[ERROR] Unrecognized CLI argument: '${arg}'`);
      process.exit(1);
    }
  }

  return { source, targetRoot, runCompatibility, allowOverwrite };
}

export async function runImportCli(argv = process.argv) {
  const { source, targetRoot, runCompatibility, allowOverwrite } = parseArgs(argv);

  if (!source) {
    console.error("[ERROR] Missing required --source argument.");
    console.error(
      "Usage: node scripts/import-pilot-archive.mjs --source=<path-to-session-dir> [--target-root=<dir>] [--overwrite]",
    );
    return 1;
  }

  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`[ERROR] Source path does not exist: ${resolvedSource}`);
    return 1;
  }

  // Load canonical import module from backend/dist (auto-compile if needed)
  const distImporterPath = path.resolve(
    __dirname,
    "../backend/dist/research/pilot/PilotArchiveImporter.js",
  );
  if (!fs.existsSync(distImporterPath)) {
    console.log("[IMPORT] Compiling backend modules via scripts/build-pilot-cli.mjs...");
    const { execSync } = await import("node:child_process");
    execSync(`"${process.execPath}" "${path.resolve(__dirname, "build-pilot-cli.mjs")}"`, {
      stdio: "inherit",
    });
  }

  const { importAndVerifyPilotSession } =
    await import("../backend/dist/research/pilot/PilotArchiveImporter.js");

  console.log(`[IMPORT] Initiating canonical import & verification: ${resolvedSource}`);
  console.log(`  Target Root: ${path.resolve(targetRoot)}`);
  console.log(`  Overwrite Permitted: ${allowOverwrite}`);
  console.log(`  Compatibility Audit: ${runCompatibility ? "ENABLED" : "DISABLED"}`);

  const result = await importAndVerifyPilotSession(resolvedSource, {
    importRootDir: path.resolve(targetRoot),
    allowOverwrite,
    runRecovery: true,
    runCompatibilityAudit: runCompatibility,
  });

  if (!result.ok) {
    console.error(`[ERROR] Import failed: ${result.error}`);
    if (result.manifestResult && !result.manifestResult.valid) {
      console.error(`  Manifest Error: ${result.manifestResult.errorDetails}`);
      if (result.manifestResult.missingFiles?.length) {
        console.error(`  Missing files: ${result.manifestResult.missingFiles.join(", ")}`);
      }
      if (result.manifestResult.mismatchedFiles?.length) {
        console.error(`  Mismatched files: ${result.manifestResult.mismatchedFiles.join(", ")}`);
      }
      if (result.manifestResult.extraFiles?.length) {
        console.error(`  Unexpected extra files: ${result.manifestResult.extraFiles.join(", ")}`);
      }
    }
    return 1;
  }

  console.log(`[IMPORT_SUCCESS] Successfully imported and canonically verified session:`);
  console.log(`  Destination: ${result.importedSessionDir}`);
  console.log(`  Manifest: VALID (Canonical SHA-256 Digest Verified)`);
  if (result.recoveryResult) {
    console.log(
      `  Recovery Status: ${result.recoveryResult.status} (Torn lines isolated: ${result.recoveryResult.tornLinesIsolated})`,
    );
  }
  if (result.compatibilityReport) {
    console.log(`  Compatibility Audit: ${result.compatibilityReport.auditReport.readinessStatus}`);
  } else if (!runCompatibility) {
    console.log(`  Compatibility Audit: SKIPPED (--no-compatibility)`);
  }

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runImportCli(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`[FATAL] Import script failed: ${err}`);
      process.exit(1);
    });
}
