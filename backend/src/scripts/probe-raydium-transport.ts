#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium Transport Observation Probe CLI
 *
 * Standalone operator CLI for empirical characterization of live Solana WebSocket
 * streaming and bounded RPC reconciliation on the reference Raydium pool context.
 *
 * SAFETY & CONSTRAINTS:
 * - Read-only execution: zero wallet access, zero signing, zero trading daemon wiring.
 * - Dry-run by default (--dry-run or omitted --live): zero network requests.
 * - Live execution requires explicit --live flag.
 * - Exactly one public-provider WebSocket connection; zero reconnects or automatic provider fallback.
 * - Strict limits: max 5 minutes runtime, 500 messages, 2 MiB application bytes,
 *   10 queue depth, 7 HTTP attempts (at most 2 history, 5 transaction retrievals), >= 2,500 ms pacing.
 * - Spending ceiling: $0.00.
 * - Evidence sealed to disk with cryptographic SHA-256 manifest and discrepancy reporting.
 * - Preserves isProductionCompletenessEstablished = false, Gate 11 fail-closed, and 7.9259 SOL virtual wallet.
 */

import {
  executeTransportObservationProbe,
  parseTransportProbeArgs,
  DEFAULT_PROBE_DURATION_MS,
  MAX_ALLOWED_PROBE_DURATION_MS,
  MAX_INBOUND_MESSAGES_BUDGET,
  MAX_APPLICATION_PAYLOAD_BYTES,
  MAX_QUEUE_DEPTH_LIMIT,
  MAX_HISTORY_QUERIES_LIMIT,
  MAX_TRANSACTION_RETRIEVALS_LIMIT,
  MAX_TOTAL_HTTP_ATTEMPTS,
  PROBE_MIN_PROVIDER_SPACING_MS,
  DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
} from "../candidate-scanner/RaydiumTransportObservationProbe.js";

function printUsage(): void {
  console.log(`
NeXusTrade — Bounded Raydium Transport Observation Probe
Phase 12.94-D Milestone D.3.3

USAGE:
  pnpm --filter @nexustrade/backend probe:raydium-transport [OPTIONS]
  tsx backend/src/scripts/probe-raydium-transport.ts [OPTIONS]

OPTIONS:
  --dry-run                Dry-run plan validation; ZERO network requests (Default)
  --live                   Execute live WebSocket observation probe (Explicit opt-in)
  --pool <poolId>          Target pool ID (Default: ${DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId} [RAY/WSOL])
  --out-dir <path>         Destination directory to seal evidence (Default: data/research/captures/transport-probe/<timestamp>_<poolId>)
  --duration-ms <ms>       Maximum probe duration in milliseconds (Default: ${DEFAULT_PROBE_DURATION_MS} ms, max: ${MAX_ALLOWED_PROBE_DURATION_MS})
  --max-messages <count>   Maximum inbound WebSocket messages (Default: ${MAX_INBOUND_MESSAGES_BUDGET}, max: ${MAX_INBOUND_MESSAGES_BUDGET})
  --max-bytes <bytes>      Maximum application payload bytes (Default: ${MAX_APPLICATION_PAYLOAD_BYTES} bytes [2 MiB], max: ${MAX_APPLICATION_PAYLOAD_BYTES})
  -h, --help               Display this help message

SAFETY & CONSTRAINTS:
  - Transport: Exactly 1 public-provider WebSocket connection; zero reconnects or provider fallback.
  - Queues & Retrievals: Max ${MAX_QUEUE_DEPTH_LIMIT} queue depth, at most ${MAX_TRANSACTION_RETRIEVALS_LIMIT} transaction retrievals.
  - Bounded Reconciliation: At most ${MAX_HISTORY_QUERIES_LIMIT} history queries; max ${MAX_TOTAL_HTTP_ATTEMPTS} HTTP calls total.
  - Provider Pacing: Retains >= ${PROBE_MIN_PROVIDER_SPACING_MS} ms spacing via GlobalResourceBudgetManager.
  - Spending Ceiling: $0.00.
  - Wallet state: Strictly frozen at 7.9259 SOL (No wallet mutation, zero signing).
  - Coverage Safeguards: isProductionCompletenessEstablished remains false; Gate 11 remains fail-closed.
`);
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseTransportProbeArgs>;
  try {
    args = parseTransportProbeArgs(process.argv.slice(2));
  } catch (argErr: unknown) {
    console.error(`Error: ${argErr instanceof Error ? argErr.message : String(argErr)}`);
    printUsage();
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const result = await executeTransportObservationProbe({
    isLive: args.isLive,
    outDir: args.outDir,
    durationMs: args.durationMs,
    maxMessages: args.maxMessages,
    maxPayloadBytes: args.maxPayloadBytes,
  });

  if (result.dryRun) {
    if (result.success) {
      console.log("=== RAYDIUM TRANSPORT OBSERVATION PROBE: DRY-RUN PLAN ===");
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } else {
      console.error("=== RAYDIUM TRANSPORT OBSERVATION PROBE: DRY-RUN FAILED ===");
      console.error(`Status:           ${(result as { status: string }).status}`);
      console.error(`Message:          ${(result as { message: string }).message}`);
      process.exit(1);
    }
  }

  if (result.success) {
    console.log("=== RAYDIUM TRANSPORT OBSERVATION PROBE: COMPLETE ===");
    console.log(`Target Directory:         ${result.targetDir}`);
    console.log(`Status:                   ${result.status}`);
    console.log(`Termination Reason:       ${result.metadata.terminationReason}`);
    console.log(`Duration (ms):            ${result.metadata.durationMs}`);
    console.log(`Messages Ingested:        ${result.metadata.counts.inboundMessagesCount}`);
    console.log(`Application Bytes:        ${result.metadata.counts.applicationPayloadBytes}`);
    console.log(`Overshoot Bytes:          ${result.metadata.counts.overshootBytes}`);
    console.log(`Peak Queue Depth:         ${result.metadata.counts.peakQueueDepth}`);
    console.log(`Decoded Swaps:            ${result.metadata.counts.decodedSwapsCount}`);
    console.log(
      `Tx Retrievals Attempted:  ${result.metadata.counts.transactionRetrievalsAttempted}`,
    );
    console.log(
      `Tx Retrievals Succeeded:  ${result.metadata.counts.transactionRetrievalsSucceeded}`,
    );
    console.log(`History Queries:          ${result.metadata.counts.historyQueriesAttempted}`);
    console.log(
      `Common Signatures:        ${result.summary.discrepancyAnalysis.commonSignaturesCount}`,
    );
    console.log(
      `WS-Only Signatures:       ${result.summary.discrepancyAnalysis.wsOnlySignaturesCount}`,
    );
    console.log(
      `History-Only Signatures:  ${result.summary.discrepancyAnalysis.historyOnlySignaturesCount}`,
    );
    console.log(`Completeness Established: ${result.metadata.isProductionCompletenessEstablished}`);
    console.log(`Gate 11 Status:           ${result.metadata.gate11Status}`);
    console.log(`Virtual Wallet:           ${result.metadata.virtualWalletBalanceSol}`);
    console.log(`Manifest File Hash:       ${result.manifest.manifestFileSha256}`);
    console.log(`Entries Digest:           ${result.manifest.entriesDigestSha256}`);
    process.exit(0);
  } else {
    console.error("=== RAYDIUM TRANSPORT OBSERVATION PROBE: FAILED ===");
    console.error(`Status:           ${result.status}`);
    console.error(`Message:          ${result.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Unexpected fatal probe error:", err);
  process.exit(1);
});
