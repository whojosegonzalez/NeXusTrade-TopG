#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.3.3: One-Shot Solana Tracker Bundlers Capture CLI
 *
 * Standalone operator CLI for acquiring one-shot bundler evidence for an explicitly
 * provided token mint from Solana Tracker's documented Data API endpoint.
 *
 * Safety & Constraints:
 * - Read-only execution: zero wallet access, zero signing, zero trading daemon wiring.
 * - Dry-run by default (--dry-run or omitted --live): zero network requests, no API key needed.
 * - Live execution requires explicit --live flag and SOLANA_TRACKER_API_KEY env var.
 * - Exactly one HTTP request; zero retries, zero redirects, zero auto-discovery.
 * - Credential hygiene: API key is never printed, logged, or saved to disk.
 * - Evidence sealed to disk with cryptographic SHA-256 manifest and separate wire digest.
 */

import {
  captureSolanaTrackerBundlers,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_ALLOWED_RESPONSE_BYTES,
  MAX_REQUEST_TIMEOUT_MS,
  parseBundlerCaptureArgs,
  SOLANA_TRACKER_API_KEY_ENV_VAR,
} from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { loadLocalEnvFile } from "../config/loadEnvFile.js";

function printUsage(): void {
  console.log(`
NeXusTrade — Solana Tracker Bundlers Operator Capture Tool
Phase 12.94-D Milestone D.3.3

USAGE:
  pnpm --filter @nexustrade/backend capture:solana-tracker-bundlers --mint <MINT_ADDRESS> [OPTIONS]
  tsx backend/src/scripts/capture-solana-tracker-bundlers.ts --mint <MINT_ADDRESS> [OPTIONS]

OPTIONS:
  --mint <address>         Target token mint (Canonical 32-byte Solana base58; Mandatory)
  --dry-run                Dry-run plan validation; ZERO network requests (Default)
  --live                   Execute single live HTTP GET request (Requires ${SOLANA_TRACKER_API_KEY_ENV_VAR})
  --out-dir <path>         Destination directory to seal evidence (Default: data/research/captures/solana-tracker-bundler/<timestamp>_<mint>)
  --timeout-ms <ms>        Request timeout in milliseconds (Default: ${DEFAULT_REQUEST_TIMEOUT_MS} ms, max: ${MAX_REQUEST_TIMEOUT_MS})
  --max-bytes <bytes>      Maximum response body size in bytes (Default: ${DEFAULT_MAX_RESPONSE_BYTES} bytes [2 MB], max: ${MAX_ALLOWED_RESPONSE_BYTES})
  -h, --help               Display this help message

SAFETY & CONSTRAINTS:
  - Network requests: At most 1 outbound HTTP GET request to fixed HTTPS endpoint.
  - Zero retries, zero redirects, zero auto-polling, zero fallback providers.
  - API Key Hygiene: Loaded from ${SOLANA_TRACKER_API_KEY_ENV_VAR} only in live mode. Never printed, logged, or saved.
  - Wallet state: Strictly frozen at 7.9259 SOL (No wallet mutation, zero signing).
  - Evidence: Stored inside project with separate wire digest and file-level cryptographic manifest.
  - Strategy Isolation: Provider data remains unverified; does not alter Gate 11 or admit candidates.
`);
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseBundlerCaptureArgs>;
  try {
    args = parseBundlerCaptureArgs(process.argv.slice(2));
  } catch (argErr: unknown) {
    console.error(`Error: ${argErr instanceof Error ? argErr.message : String(argErr)}`);
    printUsage();
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.mint) {
    console.error("Error: --mint <MINT_ADDRESS> is required.");
    printUsage();
    process.exit(1);
  }

  if (args.isLive) {
    loadLocalEnvFile();
  }

  const result = await captureSolanaTrackerBundlers({
    mint: args.mint,
    isLive: args.isLive,
    outDir: args.outDir,
    timeoutMs: args.timeoutMs,
    maxResponseSizeBytes: args.maxResponseSizeBytes,
  });

  if (result.dryRun) {
    if (result.success) {
      console.log("=== SOLANA TRACKER BUNDLERS CAPTURE: DRY-RUN PLAN ===");
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } else {
      console.error("=== SOLANA TRACKER BUNDLERS CAPTURE: DRY-RUN FAILED ===");
      console.error(`Status:           ${result.status}`);
      console.error(`Message:          ${result.message}`);
      process.exit(1);
    }
  }

  if (result.success) {
    console.log("=== SOLANA TRACKER BUNDLERS CAPTURE: SUCCESS ===");
    console.log(`Target Directory:     ${result.targetDir}`);
    console.log(`HTTP Status:          ${result.metadata.httpStatus}`);
    console.log(`Duration:             ${result.metadata.executionDurationMs} ms`);
    console.log(`Received Wire SHA256: ${result.metadata.receivedWireSha256 ?? "UNAVAILABLE"}`);
    console.log(`Retained Prefix SHA:  ${result.metadata.retainedPrefixSha256 ?? "UNAVAILABLE"}`);
    console.log(`Saved Evidence SHA256:${result.metadata.savedEvidenceSha256}`);
    console.log(`Entries Digest:       ${result.manifest.entriesDigestSha256}`);
    console.log(`Manifest File SHA256: ${result.manifest.manifestFileSha256}`);
    console.log(`Bytes Retained:       ${result.metadata.retainedBytesCount} bytes`);
    console.log(`Wire Bytes Observed:  ${result.metadata.receivedBytesCount} bytes`);
    console.log(
      `Files Sealed:         ${result.manifest.totalFiles} files (${result.manifest.totalBytes} bytes)`,
    );
    console.log(`Parser Status:        ${result.parserResult.success ? "VALID" : "INVALID"}`);
    process.exit(0);
  } else {
    console.error("=== SOLANA TRACKER BUNDLERS CAPTURE: FAILED ===");
    console.error(`Status:           ${result.status}`);
    console.error(`Message:          ${result.message}`);
    if (result.metadata) {
      console.error(`Bytes Retained:   ${result.metadata.retainedBytesCount} bytes`);
      console.error(`Bytes Observed:   ${result.metadata.receivedBytesCount} bytes`);
    }
    if (result.targetDir) {
      console.error(`Evidence Dir:     ${result.targetDir}`);
    }
    if (result.manifest) {
      console.error(`Manifest File SHA256: ${result.manifest.manifestFileSha256}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled execution error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
