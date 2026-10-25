#!/usr/bin/env node
/**
 * Phase 12.94-D.2.6: Read-Only Standalone Pilot Session Manifest Verifier
 *
 * Verifies the integrity of a sealed pilot session directory by validating:
 * 1. manifest.json existence and JSON syntax.
 * 2. Internal manifestDigestSha256 cryptographic attestation.
 * 3. File presence: all declared files exist with exact size and SHA-256 match.
 * 4. Extraneous file detection: no unsealed/extraneous files exist in the session directory.
 *
 * Guarantees (G2-F5, G2-F8):
 * - Strictly read-only and non-mutating (zero writes, zero moves, zero builds, zero file modifications).
 * - Exits 0 on valid manifest, exits 1 on invalid manifest, missing directory, or missing dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function parseArgs(argv) {
  let source = null;

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      console.log(`NeXusTrade Standalone Pilot Manifest Verifier (Phase 12.94-D.2.6)
Usage: node scripts/verify-pilot-manifest.mjs [--source=<dir> | <dir>]

Options:
  --source=<path>    Path to pilot session directory containing manifest.json
  --help, -h         Display this help message
`);
      return { source: null, help: true };
    } else if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length).trim();
    } else if (!arg.startsWith("-") && !source) {
      source = arg.trim();
    } else {
      console.error(`[ERROR] Unrecognized argument: '${arg}'`);
      return { source: null, help: false, error: `Unrecognized argument: '${arg}'` };
    }
  }

  return { source, help: false };
}

export async function runVerifyManifestCli(argv = process.argv) {
  const { source, help, error } = parseArgs(argv);

  if (help) {
    return 0;
  }
  if (error) {
    return 1;
  }

  if (!source) {
    console.error("[ERROR] Missing session directory path.");
    console.error("Usage: node scripts/verify-pilot-manifest.mjs --source=<path-to-session-dir>");
    return 1;
  }

  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`[ERROR] Specified path does not exist: ${resolvedSource}`);
    return 1;
  }

  const stat = fs.statSync(resolvedSource);
  if (!stat.isDirectory()) {
    console.error(`[ERROR] Specified path is not a directory: ${resolvedSource}`);
    return 1;
  }

  // Check session type: B2 Event Discovery, CPMM Snapshot, or D.2.6 Pilot Export
  const b2ManifestPath = path.join(resolvedSource, "session-manifest.json");
  const cpmmManifestPath = path.join(resolvedSource, "cpmm-snapshot-manifest.json");

  if (fs.existsSync(b2ManifestPath)) {
    try {
      const manifestRaw = JSON.parse(fs.readFileSync(b2ManifestPath, "utf8"));
      if (
        manifestRaw.manifestType === "C2_GROUND_TRUTH" ||
        (typeof manifestRaw.sessionId === "string" && manifestRaw.sessionId.startsWith("c2-"))
      ) {
        const { verifyC2SessionManifest } = await import("./acquire-positive-ground-truth.mjs");
        console.log(`[VERIFY] Checking C2 ground truth session manifest: ${resolvedSource}`);
        const result = verifyC2SessionManifest(resolvedSource);
        if (result.valid) {
          console.log(`[VALID] C2 ground truth session manifest verified successfully.`);
          console.log(`  Directory: ${resolvedSource}`);
          console.log(`  Manifest Status: VALID (${result.manifest.status})`);
          console.log(`  Files: ${result.manifest.totalFiles}`);
          console.log(`  Canonical SHA-256: ${result.manifest.manifestSha256}`);
          return 0;
        }
      }
    } catch (checkErr) {
      // If C2 check error is specific, report it; otherwise fall through to standard verifier
      if (checkErr.message?.startsWith("[C2_MANIFEST_")) {
        console.error(`[INVALID] C2 ground truth session manifest verification FAILED.`);
        console.error(`  Directory: ${resolvedSource}`);
        console.error(`  Error details: ${checkErr.message}`);
        return 1;
      }
    }

    const distB2Path = path.resolve(
      __dirname,
      "../backend/dist/research/pilot/EventSessionEvidenceCapture.js",
    );
    if (!fs.existsSync(distB2Path)) {
      console.error(
        `[ERROR] Required compiled backend module is missing: ${distB2Path}\n` +
          `The manifest verifier is strictly read-only and will not compile code automatically.\n` +
          `Please build the backend first by running: node scripts/build-pilot-cli.mjs`,
      );
      return 1;
    }

    const { verifyB2SessionManifest } =
      await import("../backend/dist/research/pilot/EventSessionEvidenceCapture.js");

    console.log(`[VERIFY] Checking B2 event discovery session manifest: ${resolvedSource}`);
    try {
      const result = verifyB2SessionManifest(resolvedSource);
      if (result.valid) {
        console.log(`[VALID] B2 session manifest verified successfully.`);
        console.log(`  Directory: ${resolvedSource}`);
        console.log(`  Manifest Status: VALID (${result.manifest.status})`);
        console.log(`  Files: ${result.manifest.totalFiles}`);
        console.log(`  Canonical SHA-256: ${result.manifest.manifestSha256}`);
        return 0;
      }
    } catch (err) {
      console.error(`[INVALID] B2 session manifest verification FAILED.`);
      console.error(`  Directory: ${resolvedSource}`);
      console.error(`  Error details: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (fs.existsSync(cpmmManifestPath)) {
    const distCpmmPath = path.resolve(
      __dirname,
      "../backend/dist/research/pilot/RaydiumCpmmParser.js",
    );
    if (!fs.existsSync(distCpmmPath)) {
      console.error(
        `[ERROR] Required compiled backend module is missing: ${distCpmmPath}\n` +
          `Please build the backend first by running: node scripts/build-pilot-cli.mjs`,
      );
      return 1;
    }

    const { verifyCpmmSnapshotManifest } =
      await import("../backend/dist/research/pilot/RaydiumCpmmParser.js");

    console.log(`[VERIFY] Checking CPMM snapshot manifest: ${resolvedSource}`);
    try {
      const result = verifyCpmmSnapshotManifest(resolvedSource);
      if (result.valid) {
        console.log(`[VALID] CPMM snapshot manifest verified successfully.`);
        console.log(`  Directory: ${resolvedSource}`);
        console.log(`  Canonical SHA-256: ${result.manifestSha256}`);
        return 0;
      }
    } catch (err) {
      console.error(`[INVALID] CPMM snapshot manifest verification FAILED.`);
      console.error(`  Directory: ${resolvedSource}`);
      console.error(`  Error details: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Strictly read-only check for compiled backend dependencies (G2-F8)
  const distManifestPath = path.resolve(
    __dirname,
    "../backend/dist/research/pilot/PilotExportManifest.js",
  );
  if (!fs.existsSync(distManifestPath)) {
    console.error(
      `[ERROR] Required compiled backend module is missing: ${distManifestPath}\n` +
        `The manifest verifier is strictly read-only and will not compile code automatically.\n` +
        `Please build the backend first by running: node scripts/build-pilot-cli.mjs`,
    );
    return 1;
  }

  const { verifySessionExportManifest } =
    await import("../backend/dist/research/pilot/PilotExportManifest.js");

  console.log(`[VERIFY] Checking session export manifest: ${resolvedSource}`);
  const result = await verifySessionExportManifest(resolvedSource);

  if (result.valid) {
    console.log(`[VALID] Session export manifest verified successfully.`);
    console.log(`  Directory: ${resolvedSource}`);
    console.log(`  Manifest Status: VALID`);
    return 0;
  } else {
    console.error(`[INVALID] Session export manifest verification FAILED.`);
    console.error(`  Directory: ${resolvedSource}`);
    if (result.missingFiles.length > 0) {
      console.error(`  Missing files: ${result.missingFiles.join(", ")}`);
    }
    if (result.mismatchedFiles.length > 0) {
      console.error(`  Mismatched files: ${result.mismatchedFiles.join(", ")}`);
    }
    if (result.extraFiles.length > 0) {
      console.error(`  Extraneous unmanifested files: ${result.extraFiles.join(", ")}`);
    }
    if (result.errorDetails) {
      console.error(`  Error details: ${result.errorDetails}`);
    }
    return 1;
  }
}

// Auto-run when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runVerifyManifestCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
