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
  --dry-run                    Dry-run plan validation; ZERO network requests (Default)
  --live                       Execute live WebSocket observation probe (Explicit opt-in)
  --pool <poolId>              Target pool ID (Must match reference RAY/WSOL: ${DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId})
  --out-dir <path>             Destination directory (Must reside within data/research/captures/transport-probe/)
  --duration-ms <ms>           Maximum probe duration in milliseconds (1..${MAX_ALLOWED_PROBE_DURATION_MS} ms, default: ${DEFAULT_PROBE_DURATION_MS})
  --max-messages <count>       Maximum inbound WebSocket messages (1..${MAX_INBOUND_MESSAGES_BUDGET}, default: ${MAX_INBOUND_MESSAGES_BUDGET})
  --max-bytes <bytes>          Maximum application payload bytes (1..${MAX_APPLICATION_PAYLOAD_BYTES} bytes [2 MiB], default: ${MAX_APPLICATION_PAYLOAD_BYTES})
  --max-queue-depth <count>    Maximum active queue depth (1..${MAX_QUEUE_DEPTH_LIMIT}, default: ${MAX_QUEUE_DEPTH_LIMIT})
  --max-history-queries <cnt>  Maximum bounded history RPC queries (1..${MAX_HISTORY_QUERIES_LIMIT}, default: ${MAX_HISTORY_QUERIES_LIMIT})
  --max-tx-retrievals <count>  Maximum sampled transaction retrievals (1..${MAX_TRANSACTION_RETRIEVALS_LIMIT}, default: ${MAX_TRANSACTION_RETRIEVALS_LIMIT})
  --transport <native|ws>      WebSocket transport client implementation (native [default] or ws)
  --keepalive <true|false>     Enable/disable RFC 6455 keepalive PING control frames on ws transport (default: true for ws, unsupported on native)
  --disable-keepalive          Disable RFC 6455 keepalive on ws transport
  --ping-interval-ms <ms>      Keepalive PING interval in milliseconds (default: 20000)
  --max-pings <count>          Maximum keepalive PINGs to send (default: 4)
  --pong-timeout-ms <ms>       Missing-PONG timeout in milliseconds (default: 10000)
  --max-control-frames <count> Maximum RFC 6455 control frames budget (default: 50)
  --max-control-bytes <bytes>  Maximum RFC 6455 control frame payload bytes budget (default: 4096)
  --transport-only             Execute transport-only observation; disables HTTP transaction retrieval and history queries
  -h, --help                   Display this help message

SAFETY & CONSTRAINTS:
  - Transport: Exactly 1 public-provider WebSocket connection; zero reconnects or provider fallback.
  - Queues & Retrievals: Max ${MAX_QUEUE_DEPTH_LIMIT} queue depth, at most ${MAX_TRANSACTION_RETRIEVALS_LIMIT} transaction retrievals.
  - Bounded Discovery: At most ${MAX_HISTORY_QUERIES_LIMIT} history queries; max ${MAX_TOTAL_HTTP_ATTEMPTS} HTTP calls total.
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

  const abortController = new AbortController();

  const handleInterrupt = (sig: string) => {
    console.warn(`\nReceived ${sig}. Initiating graceful shutdown and sealing partial evidence...`);
    abortController.abort(new Error(`Interrupted by ${sig}`));
  };

  process.once("SIGINT", () => handleInterrupt("SIGINT"));
  process.once("SIGTERM", () => handleInterrupt("SIGTERM"));

  let result: Awaited<ReturnType<typeof executeTransportObservationProbe>>;
  try {
    result = await executeTransportObservationProbe({
      isLive: args.isLive,
      outDir: args.outDir,
      durationMs: args.durationMs,
      maxMessages: args.maxMessages,
      maxPayloadBytes: args.maxPayloadBytes,
      maxQueueDepth: args.maxQueueDepth,
      maxHistoryQueries: args.maxHistoryQueries,
      maxTransactionRetrievals: args.maxTransactionRetrievals,
      transportType: args.transport,
      keepalive: args.keepalive,
      pingIntervalMs: args.pingIntervalMs,
      maxPings: args.maxPings,
      pongTimeoutMs: args.pongTimeoutMs,
      maxControlFrames: args.maxControlFrames,
      maxControlFrameBytes: args.maxControlFrameBytes,
      transportOnly: args.transportOnly,
      signal: abortController.signal,
    });
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }

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

  if ("manifest" in result) {
    console.log("=== RAYDIUM TRANSPORT OBSERVATION PROBE: EVIDENCE SEALED ===");
    console.log(`Target Directory:         ${result.targetDir}`);
    console.log(`Observation Success:      ${result.observationSuccess}`);
    console.log(`Status:                   ${result.status}`);
    console.log(`Execution Mode:           ${result.metadata.executionMode}`);
    if (result.metadata.transportOnly) {
      console.log(`Transport-Only Mode:      true (zero HTTP RPC dispatches enforced)`);
    }
    console.log(`Termination Reason:       ${result.metadata.terminationReason}`);
    console.log(`Duration (ms):            ${result.metadata.durationMs}`);
    console.log(`Messages Ingested:        ${result.metadata.counts.inboundMessagesCount}`);
    console.log(`Application Bytes:        ${result.metadata.counts.applicationPayloadBytes}`);
    console.log(`Overshoot Bytes:          ${result.metadata.counts.overshootBytes}`);
    console.log(`Peak Queue Depth:         ${result.metadata.counts.peakQueueDepth}`);
    console.log(`Queue Rejections:         ${result.metadata.counts.queueRejectionsCount}`);
    console.log(`Decoded Swaps:            ${result.metadata.counts.decodedSwapsCount}`);
    console.log(
      `Tx Retrievals Attempted:  ${result.metadata.counts.transactionRetrievalsAttempted}`,
    );
    console.log(
      `Tx Retrievals Succeeded:  ${result.metadata.counts.transactionRetrievalsSucceeded}`,
    );
    console.log(`History Queries:          ${result.metadata.counts.historyQueriesAttempted}`);
    console.log(`History Signatures Found: ${result.metadata.counts.historySignaturesDiscovered}`);
    console.log(
      `Common Signatures:        ${result.summary.discrepancyAnalysis.commonSignaturesCount}`,
    );
    console.log(
      `WS-Only Signatures:       ${result.summary.discrepancyAnalysis.wsOnlySignaturesCount}`,
    );
    console.log(
      `History-Only Signatures:  ${result.summary.discrepancyAnalysis.historyOnlySignaturesCount}`,
    );
    console.log(
      `Unretrieved WS Signatures:${result.summary.discrepancyAnalysis.unretrievedSampleSignaturesCount}`,
    );
    console.log(`Completeness Established: ${result.metadata.isProductionCompletenessEstablished}`);
    console.log(`Gate 11 Status:           ${result.metadata.gate11Status}`);
    console.log(`Virtual Wallet:           ${result.metadata.virtualWalletBalanceSol}`);
    console.log(`Manifest File Hash:       ${result.manifest.manifestFileSha256}`);
    console.log(`Entries Digest:           ${result.manifest.entriesDigestSha256}`);

    if (result.metadata.transportDiagnostics) {
      const td = result.metadata.transportDiagnostics;
      console.log(`Connected At (ms):        ${td.connectedAtMs ?? "N/A"}`);
      console.log(
        `Subscription Status:      ${td.subscriptionStatus} (ID: ${td.subscriptionId ?? "N/A"})`,
      );
      if (td.subscriptionError) {
        console.log(`Subscription Error:       ${td.subscriptionError}`);
      }
      console.log(
        `Last Message Received:    ${td.lastMessageReceivedAtMs ? `${td.lastMessageReceivedAtMs} ms` : "None"}`,
      );
      if (td.firstErrorMessage) {
        console.log(`First Transport Error:    ${td.firstErrorMessage}`);
      }
      if (td.firstErrorCode !== null) {
        console.log(`First Error Code:         ${td.firstErrorCode}`);
      }
      if (td.firstErrorCause) {
        console.log(`First Error Cause:        ${td.firstErrorCause}`);
      }
      if (td.closeCode !== null) {
        console.log(`Observed Close Code/Reason: ${td.closeCode} / ${td.closeReason || "None"}`);
      }
      if (td.localCloseCode !== null) {
        console.log(
          `Local Close Code/Reason:    ${td.localCloseCode} / ${td.localCloseReason || "None"}`,
        );
      }
      console.log(`Server Pings Observed:     ${td.serverPingsReceivedCount}`);
      if (td.lastServerPingReceivedAtMs !== null) {
        console.log(`Last Server Ping (ms):     ${td.lastServerPingReceivedAtMs}`);
      }
      console.log(`Transport Client:          ${td.transportClient}`);
      console.log(`Keepalive Enabled:         ${td.keepaliveEnabled}`);
      if (td.keepaliveEnabled) {
        console.log(`Client Pings Sent:         ${td.clientPingsSentCount}`);
        console.log(`Client Pongs Received:     ${td.clientPongsReceivedCount}`);
        console.log(`Matched Client Pongs:      ${td.matchedClientPongsCount}`);
        if (td.unmatchedClientPongsCount > 0) {
          console.log(`Unmatched Client Pongs:    ${td.unmatchedClientPongsCount}`);
        }
        if (td.automaticPongsSentCount > 0) {
          console.log(`Automatic Pongs Sent:      ${td.automaticPongsSentCount}`);
        }
        if (td.lastClientPingSentAtMs !== null) {
          console.log(`Last Ping Sent (ms):       ${td.lastClientPingSentAtMs}`);
        }
        if (td.lastClientPongReceivedAtMs !== null) {
          console.log(`Last Pong Received (ms):   ${td.lastClientPongReceivedAtMs}`);
        }
        if (td.lastPongLatencyMs !== null) {
          console.log(`Last Pong RTT:             ${td.lastPongLatencyMs} ms`);
          console.log(
            `Min/Max Pong RTT:          ${td.minPongLatencyMs} / ${td.maxPongLatencyMs} ms`,
          );
        }
        console.log(`Missing Pong Detected:     ${td.missingPongDetected}`);
        console.log(
          `Control Frames Count:      Sent: ${td.controlFramesSentCount}, Recv: ${td.controlFramesReceivedCount}`,
        );
        console.log(
          `Control Frame Payload:     Sent: ${td.controlFramePayloadBytesSent} B, Recv: ${td.controlFramePayloadBytesReceived} B`,
        );
        console.log(
          `Control Frame Wire:        Sent: ${td.controlFrameWireBytesSent} B, Recv: ${td.controlFrameWireBytesReceived} B`,
        );
      }
      console.log(`Closure Origin:            ${td.observedCloseOrigin}`);
    }

    if (
      !result.observationSuccess ||
      result.status === "TRANSPORT_ERROR" ||
      result.status === "QUEUE_OVERFLOW"
    ) {
      console.error("=== RAYDIUM TRANSPORT OBSERVATION PROBE: TERMINATED WITH ERROR ===");
      console.error(`Termination Reason:       ${result.metadata.terminationReason}`);
      if (result.metadata.transportDiagnostics?.firstErrorMessage) {
        console.error(
          `Error Details:            ${result.metadata.transportDiagnostics.firstErrorMessage}`,
        );
      }
      process.exit(1);
    }

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
