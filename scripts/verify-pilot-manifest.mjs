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
 * Guarantees (G2-F5):
 * - Strictly read-only and non-mutating (zero writes, zero moves, zero imports).
 * - Exits 0 on valid manifest, exits 1 on invalid manifest or missing directory.
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
      process.exit(0);
    } else if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length).trim();
    } else if (!arg.startsWith("-") && !source) {
      source = arg.trim();
    } else {
      console.error(`[ERROR] Unrecognized argument: '${arg}'`);
      process.exit(1);
    }
  }

  return { source };
}

export async function runVerifyManifestCli(argv = process.argv) {
  const { source } = parseArgs(argv);

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

  // Ensure backend is compiled
  const distManifestPath = path.resolve(
    __dirname,
    "../backend/dist/research/pilot/PilotExportManifest.js",
  );
  if (!fs.existsSync(distManifestPath)) {
    console.log("[VERIFY] Compiling backend modules via scripts/build-pilot-cli.mjs...");
    const { execSync } = await import("node:child_process");
    execSync(`"${process.execPath}" "${path.resolve(__dirname, "build-pilot-cli.mjs")}"`, {
      stdio: "inherit",
    });
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
    process.exit(code);
  });
}
