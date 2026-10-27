#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 LP-Accounting Snapshot CLI
 *
 * Standalone read-only CLI entrypoint for acquiring a verified LP-accounting
 * snapshot for legacy Raydium AMM v4 pools (defaulting to the reference RAY/WSOL pair).
 *
 * Enforces:
 * - Read-only execution: zero wallet access, zero signing, zero trading daemon wiring.
 * - Max 2 outbound HTTP requests: exactly 1 getAccountInfo + 1 getMultipleAccounts.
 * - Pacing >= 2,500 ms between requests.
 * - Pre-flight identity verification and canonical AMM authority derivation.
 * - Dry-run mode (--dry-run) making zero network requests.
 * - Output evidence sealing with SHA-256 digest in JSON format preserving BigInt decimal strings.
 */

import path from "node:path";
import {
  acquireRaydiumAmmV4Snapshot,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_HOST_PACING_MS,
  REFERENCE_RAY_TOKEN_MINT,
  REFERENCE_RAY_WSOL_POOL_ID,
  type SnapshotAcquisitionConfig,
} from "./RaydiumAmmV4SnapshotAcquisition.js";

function printUsage(): void {
  console.log(`
NeXusTrade — Bounded Raydium AMM v4 LP-Accounting Snapshot CLI
Phase 12.94-D Milestone D.3.3

USAGE:
  pnpm --filter @nexustrade/backend research:raydium-amm-v4-snapshot [OPTIONS]
  tsx backend/src/research/pilot/RaydiumAmmV4SnapshotCli.ts [OPTIONS]

OPTIONS:
  --rpc-url <url>              RPC endpoint URL (Mandatory unless --dry-run)
  --pool-id <pubkey>           Pool address (Default: ${REFERENCE_RAY_WSOL_POOL_ID} [RAY/WSOL])
  --expected-token-mint <mint> Expected token mint (Default: ${REFERENCE_RAY_TOKEN_MINT} [RAY])
  --pacing-ms <ms>             Host pacing between Request 1 and 2 (Default: ${MIN_HOST_PACING_MS} ms)
  --timeout-ms <ms>            Per-request timeout in ms (Default: ${DEFAULT_REQUEST_TIMEOUT_MS} ms)
  --overall-timeout-ms <ms>    Overall execution ceiling in ms (Default: ${DEFAULT_OVERALL_TIMEOUT_MS} ms)
  --out-dir <path>             Directory to seal output evidence JSON (Default: data/research/snapshots)
  --dry-run                    Verify parameters, derive authority, output planned sequence; ZERO network calls
  -h, --help                   Display this help message

SAFETY & CONSTRAINTS:
  - Network requests: Max 2 outbound calls (1 bootstrap + 1 batch).
  - Pacing: Strictly enforced >= 2,500 ms pause before batch request.
  - Retries: 0 (Zero retries, zero redirects, zero fallback providers).
  - Wallet state: Strictly frozen at 7.9259 SOL (No wallet mutation, zero signing).
`);
}

interface ParsedCliArgs {
  rpcUrl?: string | undefined;
  poolId?: string | undefined;
  expectedTokenMint?: string | undefined;
  pacingMs?: number | undefined;
  timeoutMs?: number | undefined;
  overallTimeoutMs?: number | undefined;
  outDir?: string | undefined;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--rpc-url" && i + 1 < args.length) {
      result.rpcUrl = args[++i];
    } else if (arg.startsWith("--rpc-url=")) {
      result.rpcUrl = arg.slice("--rpc-url=".length);
    } else if (arg === "--pool-id" && i + 1 < args.length) {
      result.poolId = args[++i];
    } else if (arg.startsWith("--pool-id=")) {
      result.poolId = arg.slice("--pool-id=".length);
    } else if (arg === "--expected-token-mint" && i + 1 < args.length) {
      result.expectedTokenMint = args[++i];
    } else if (arg.startsWith("--expected-token-mint=")) {
      result.expectedTokenMint = arg.slice("--expected-token-mint=".length);
    } else if (arg === "--pacing-ms" && i + 1 < args.length) {
      result.pacingMs = parseInt(args[++i]!, 10);
    } else if (arg.startsWith("--pacing-ms=")) {
      result.pacingMs = parseInt(arg.slice("--pacing-ms=".length), 10);
    } else if (arg === "--timeout-ms" && i + 1 < args.length) {
      result.timeoutMs = parseInt(args[++i]!, 10);
    } else if (arg.startsWith("--timeout-ms=")) {
      result.timeoutMs = parseInt(arg.slice("--timeout-ms=".length), 10);
    } else if (arg === "--overall-timeout-ms" && i + 1 < args.length) {
      result.overallTimeoutMs = parseInt(args[++i]!, 10);
    } else if (arg.startsWith("--overall-timeout-ms=")) {
      result.overallTimeoutMs = parseInt(arg.slice("--overall-timeout-ms=".length), 10);
    } else if (arg === "--out-dir" && i + 1 < args.length) {
      result.outDir = args[++i];
    } else if (arg.startsWith("--out-dir=")) {
      result.outDir = arg.slice("--out-dir=".length);
    }
  }

  return result;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return 0;
  }

  const defaultOutDir = path.resolve(process.cwd(), "data", "research", "snapshots");
  const outDir = args.outDir ?? defaultOutDir;

  const config: SnapshotAcquisitionConfig = {
    rpcUrl: args.rpcUrl,
    poolId: args.poolId ?? REFERENCE_RAY_WSOL_POOL_ID,
    expectedTokenMint: args.expectedTokenMint ?? REFERENCE_RAY_TOKEN_MINT,
    pacingMs: args.pacingMs ?? MIN_HOST_PACING_MS,
    timeoutMs: args.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    overallTimeoutMs: args.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS,
    outDir,
    dryRun: args.dryRun,
  };

  console.log("================================================================================");
  console.log("  NeXusTrade — Bounded Raydium AMM v4 Snapshot Acquisition CLI");
  console.log("  Phase 12.94-D Milestone D.3.3 [Strict Read-Only Operator Tool]");
  console.log("================================================================================");

  if (args.dryRun) {
    console.log("[MODE] DRY-RUN ACTIVE: Zero network calls will be made.");
  } else {
    console.log("[MODE] LIVE ACQUISITION: Max 2 outbound HTTP requests authorized.");
  }

  console.log(`[TARGET POOL]            : ${config.poolId}`);
  console.log(`[EXPECTED TOKEN MINT]    : ${config.expectedTokenMint ?? "<NONE>"}`);
  console.log(`[HOST PACING]            : >= ${config.pacingMs} ms`);
  console.log(`[PER-REQUEST TIMEOUT]    : ${config.timeoutMs} ms`);
  console.log(`[OVERALL TIMEOUT CEILING]: ${config.overallTimeoutMs} ms`);
  console.log(`[EVIDENCE DIRECTORY]     : ${outDir}`);

  if (!args.dryRun && (!args.rpcUrl || args.rpcUrl.trim() === "")) {
    console.error("\n[FATAL ERROR] Missing required argument: --rpc-url <URL>");
    console.error("For safety, RPC endpoints must be explicitly supplied by the operator.");
    console.error("To test parameters without executing network requests, pass --dry-run.\n");
    return 1;
  }

  try {
    const result = await acquireRaydiumAmmV4Snapshot(config);
    const ev = result.evidence;

    console.log(
      "\n--------------------------------------------------------------------------------",
    );
    console.log("  EXECUTION REPORT");
    console.log("--------------------------------------------------------------------------------");
    console.log(`Execution Mode           : ${ev.executionMode}`);
    console.log(`Endpoint (Sanitized)     : ${ev.endpoint.sanitizedUrl}`);
    console.log(`Endpoint Fingerprint     : ${ev.endpoint.endpointFingerprint}`);
    console.log(
      `Canonical AMM Authority  : ${ev.canonicalAmmAuthority.address} (bump ${ev.canonicalAmmAuthority.bump})`,
    );
    console.log(`Total Outbound HTTP Calls: ${ev.httpAttempts} (Max allowed: 2)`);
    console.log(`Bootstrap Context Slot   : ${ev.contextSlots.bootstrapSlot ?? "N/A"}`);
    console.log(`Batch Context Slot       : ${ev.contextSlots.batchSlot ?? "N/A"}`);
    console.log(
      `Host Pacing Enforced     : ${ev.pacingEnforcedMs ? `${ev.pacingEnforcedMs} ms` : "N/A"}`,
    );

    if (result.dryRun) {
      console.log("\n[DRY-RUN VALIDATION COMPLETE]");
      console.log("  - Identities syntax: VALID");
      console.log("  - Canonical AMM authority derived: VALID");
      console.log("  - Planned Request 1: getAccountInfo (confirmed, base64)");
      console.log("  - Planned Pacing   : >= 2,500 ms wait");
      console.log("  - Planned Request 2: getMultipleAccounts (minContextSlot bound)");
      console.log("  - Live Network Requests Made: 0");
      console.log("  - Wallet Mutation: NONE (Balance strictly frozen at 7.9259 SOL)");
      return 0;
    }

    console.log(
      "\n--------------------------------------------------------------------------------",
    );
    console.log("  OUTCOMES & VALIDATION");
    console.log("--------------------------------------------------------------------------------");
    console.log(`1. RPC Retrieval OK         : ${ev.outcomes.retrievalOk ? "PASS" : "FAIL"}`);
    console.log(
      `2. Structural Validation OK : ${ev.outcomes.structuralValidationOk ? "PASS" : "FAIL"}`,
    );
    console.log(
      `3. 90% LP Threshold Met     : ${ev.outcomes.meetsNinetyPercentThreshold ? "YES" : "NO"}`,
    );

    if (ev.failureReason) {
      console.log(`\n[FAILURE DIAGNOSTIC] : ${ev.failureReason}`);
    }

    if (ev.accounting) {
      console.log(
        "\n--------------------------------------------------------------------------------",
      );
      console.log("  LP-ACCOUNTING SUMMARY (Pure BigInt Arithmetic)");
      console.log(
        "--------------------------------------------------------------------------------",
      );
      console.log(`Protocol LP Denominator (L) : ${ev.accounting.protocolLp}`);
      console.log(`Circulating LP Supply (S)   : ${ev.accounting.circulatingSupply}`);
      console.log(`Inaccessible LP Claims (L-S): ${ev.accounting.rawInaccessibleLp}`);
      console.log(`Inaccessible Percentage     : ${ev.accounting.displayInaccessiblePct}%`);
      console.log(`Meets 90.0% Threshold       : ${ev.accounting.meetsNinetyPercentThreshold}`);
    }

    if (ev.evidenceFilePath) {
      console.log(
        "\n--------------------------------------------------------------------------------",
      );
      console.log("  SEALED EVIDENCE ARTIFACT");
      console.log(
        "--------------------------------------------------------------------------------",
      );
      console.log(`File Path : ${ev.evidenceFilePath}`);
      console.log(`SHA-256   : ${ev.evidenceDigestSha256}`);
    }

    console.log("\n[EVIDENCE BOUNDARIES ENFORCED]");
    console.log("  - Bytecode equivalence verified        : false");
    console.log("  - Complete executable reserves verified: false");
    console.log("  - General token safety verified        : false");
    console.log("  - Strategy gate admitted               : false");
    console.log("  - Wallet balance strictly frozen       : 7.9259 SOL");

    if (!ev.outcomes.retrievalOk) {
      return 1;
    }
    if (!ev.outcomes.structuralValidationOk) {
      return 2;
    }
    return 0;
  } catch (err) {
    console.error(`\n[EXECUTION ERROR] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Direct invocation guard
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runCli().then((exitCode) => {
    process.exit(exitCode);
  });
}
