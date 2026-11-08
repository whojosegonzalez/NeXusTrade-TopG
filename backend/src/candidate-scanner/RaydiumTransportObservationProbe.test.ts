/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium Transport Observation Probe Test Suite
 *
 * Verifies the standalone transport observation probe:
 * 1. Single overall network deadline and settled shutdown (zero post-deadline dispatches)
 * 2. Bounded and protected HTTP paths (redirect rejection, body size limits, JSON-RPC validation)
 * 3. Queue and payload accounting (queue overflow stop, overshoot disclosure, oversized frame blocking)
 * 4. Outcomes and evidence accuracy (transport error classification, partial evidence preservation,
 *    anchor slot/blockTime preservation, known valid swap-decoding positive control)
 * 5. Input validation (unsupported pool rejection, ceiling bounds checking, outDir boundary enforcement)
 * 6. Strict preservation of production completeness = false, Gate 11 fail-closed, and 7.9259 SOL wallet
 * 7. Cryptographic manifest sealing and evidence integrity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as diagnostics_channel from "node:diagnostics_channel";
import { WebSocketServer, type WebSocket } from "ws";
import {
  executeTransportObservationProbe,
  parseTransportProbeArgs,
  createBoundedFetchTransport,
  readBoundedStream,
  boundedCancel,
  MeteredWebSocketTransport,
  DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
  DEFAULT_RECONCILIATION_PROBE_DURATION_MS,
  MAX_TOTAL_HTTP_ATTEMPTS,
  resolveProjectRoot,
  acquireSourceCutoff,
  type SourceCutoffAuditRecord,
  type TransportProbeSuccessResult,
  type TransportProbeDryRunResult,
} from "./RaydiumTransportObservationProbe.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { SourceCutoffEvidence } from "./ExactPoolWindowReconciliationEvaluator.js";
import { UnavailableCandidateFlowProvider } from "./CandidateFlowProvider.js";
import { decodeRaydiumTransactionSwaps } from "./RaydiumAmmV4SwapDecoder.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import type { HistoryPageFetcher, HistorySignatureRecord } from "./ExactPoolHistoryEnumerator.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";

// Canonical Base58 Ed25519 64-byte signatures
const SIG_ANCHOR =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc";
const SIG_B =
  "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3vB";
const SIG_C =
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6C";

class MockWebSocketTransport implements ISolanaWebSocketTransport {
  public sentMessages: string[] = [];
  public isClosed = false;
  public closeCode: number | null = null;
  public closeReason: string | null = null;

  private listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.isClosed = true;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? "Normal closure";
  }

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: string | Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
  on(
    event: "open" | "message" | "error" | "close",
    listener: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): void {
    this.listeners[event].push(listener);
  }

  triggerOpen(): void {
    for (const listener of this.listeners.open) listener();
  }

  triggerMessage(data: string | Buffer): void {
    for (const listener of this.listeners.message) listener(data);
  }

  triggerError(err: Error): void {
    for (const listener of this.listeners.error) listener(err);
  }

  triggerClose(code: number, reason: string): void {
    for (const listener of this.listeners.close) listener(code, reason);
  }
}

function makeSwapBaseInV2Data(amountIn: bigint, minimumOut: bigint): number[] {
  const buf = new Uint8Array(17);
  buf[0] = 16; // SwapBaseInV2 tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, minimumOut, true);
  return Array.from(buf);
}

function createSyntheticBuyPayload(
  signature: string,
  blockTime = Math.floor(Date.now() / 1000),
  slot = 280_000_100,
) {
  const ctx = DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT;
  const authority = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const userSource = "UserSourceTokenAccount1111111111111111111111";
  const userDest = "UserDestTokenAccount111111111111111111111111";
  const userWallet = "UserWalletOwner1111111111111111111111111111";

  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    ctx.poolId, // 1
    authority, // 2
    ctx.baseVault, // 3
    ctx.quoteVault, // 4
    userSource, // 5
    userDest, // 6
    userWallet, // 7
    RAYDIUM_AMM_V4_PROGRAM_ID, // 8
  ];

  const amountInLamports = 50_000_000n;
  const amountOutTokens = 25_000_000_000n;

  return {
    slot,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: accounts,
        instructions: [
          {
            programIdIndex: 8,
            accounts: [0, 1, 2, 3, 4, 5, 6, 7],
            data: makeSwapBaseInV2Data(amountInLamports, amountOutTokens),
          },
        ],
      },
    },
    meta: {
      err: null,
      logMessages: [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ],
      preTokenBalances: [
        {
          accountIndex: 4,
          mint: ctx.quoteTokenMint,
          uiTokenAmount: { amount: "1000000000", decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: ctx.candidateTokenMint,
          uiTokenAmount: { amount: "500000000000", decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 4,
          mint: ctx.quoteTokenMint,
          uiTokenAmount: { amount: (1_000_000_000n + amountInLamports).toString(), decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: ctx.candidateTokenMint,
          uiTokenAmount: { amount: (500_000_000_000n - amountOutTokens).toString(), decimals: 6 },
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [5, 4, 7],
              data: [
                3,
                ...Array.from(new Uint8Array(new BigUint64Array([amountInLamports]).buffer)),
              ],
            },
            {
              programIdIndex: 0,
              accounts: [3, 6, 2],
              data: [
                3,
                ...Array.from(new Uint8Array(new BigUint64Array([amountOutTokens]).buffer)),
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("RaydiumTransportObservationProbe", () => {
  const baseCapturesDir = path.resolve(
    resolveProjectRoot(),
    "data",
    "research",
    "captures",
    "transport-probe",
  );
  const testOutputDir = path.join(baseCapturesDir, "unit-test-probe");

  beforeEach(() => {
    if (fsSync.existsSync(testOutputDir)) {
      fsSync.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fsSync.existsSync(testOutputDir)) {
      fsSync.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. Dry-Run Plan Validation & Input Boundaries
  // ==========================================================================
  describe("Dry-Run Plan Validation & Input Boundaries", () => {
    it("returns DRY_RUN status and executes zero network calls when isLive is omitted or false", async () => {
      const result = await executeTransportObservationProbe({
        isLive: false,
        outDir: testOutputDir,
      });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      if (result.dryRun && result.success) {
        expect(result.status).toBe("DRY_RUN");
        expect(result.targetPoolId).toBe(DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId);
        expect(result.candidateTokenMint).toBe(
          DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.candidateTokenMint,
        );
        expect(result.limits.durationMs).toBe(300_000);
        expect(result.limits.maxMessages).toBe(500);
        expect(result.limits.maxPayloadBytes).toBe(2 * 1024 * 1024);
        expect(result.limits.maxQueueDepth).toBe(10);
        expect(result.limits.maxHistoryQueries).toBe(2);
        expect(result.limits.maxTransactionRetrievals).toBe(5);
        expect(result.limits.maxTotalHttpAttempts).toBe(MAX_TOTAL_HTTP_ATTEMPTS);
        expect(result.limits.spendingCeiling).toBe("$0.00");
        expect(result.budgetStats.totalRequests).toBe(0);
        expect(result.budgetStats.enrichmentRequests).toBe(0);
      }
    });

    it("rejects unsupported pool override with INVALID_INPUT", async () => {
      // 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2 is a valid Base58 public key, but not the reference pool
      const badPool = {
        ...DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
        poolId: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      };
      const result = await executeTransportObservationProbe({
        isLive: false,
        poolContext: badPool,
        outDir: testOutputDir,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("INVALID_INPUT");
      if ("message" in result) {
        expect(result.message).toContain("Unsupported pool");
      }
    });

    it("rejects invalid configurable ceilings (queue depth, history queries, tx retrievals) with INVALID_INPUT", async () => {
      // maxQueueDepth > 10
      const resQueue = await executeTransportObservationProbe({
        isLive: false,
        maxQueueDepth: 99,
        outDir: testOutputDir,
      });
      expect(resQueue.success).toBe(false);
      expect(resQueue.status).toBe("INVALID_INPUT");

      // maxHistoryQueries > 2
      const resHist = await executeTransportObservationProbe({
        isLive: false,
        maxHistoryQueries: 99,
        outDir: testOutputDir,
      });
      expect(resHist.success).toBe(false);
      expect(resHist.status).toBe("INVALID_INPUT");

      // maxTransactionRetrievals > 5
      const resTx = await executeTransportObservationProbe({
        isLive: false,
        maxTransactionRetrievals: 99,
        outDir: testOutputDir,
      });
      expect(resTx.success).toBe(false);
      expect(resTx.status).toBe("INVALID_INPUT");
    });

    it("rejects outDir outside data/research/captures/transport-probe/ boundary", async () => {
      const escapedDir = path.resolve(resolveProjectRoot(), "outside-escaped-evidence");
      const res = await executeTransportObservationProbe({
        isLive: false,
        outDir: escapedDir,
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("INVALID_INPUT");
      if ("message" in res) {
        expect(res.message).toContain("must reside within the documented captures directory");
      }
    });

    it("parses valid CLI arguments and rejects invalid values", () => {
      const parsed = parseTransportProbeArgs([
        "--live",
        "--duration-ms",
        "10000",
        "--max-messages",
        "200",
        "--max-bytes",
        "1048576",
        "--max-queue-depth",
        "8",
        "--max-history-queries",
        "2",
        "--max-tx-retrievals",
        "4",
      ]);

      expect(parsed.isLive).toBe(true);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.durationMs).toBe(10000);
      expect(parsed.maxMessages).toBe(200);
      expect(parsed.maxPayloadBytes).toBe(1048576);
      expect(parsed.maxQueueDepth).toBe(8);
      expect(parsed.maxHistoryQueries).toBe(2);
      expect(parsed.maxTransactionRetrievals).toBe(4);

      // Rejects unsupported pool in CLI
      expect(() =>
        parseTransportProbeArgs(["--pool", "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"]),
      ).toThrow("Unsupported pool");

      // Rejects ceiling violation in CLI
      expect(() => parseTransportProbeArgs(["--max-queue-depth", "99"])).toThrow(
        "--max-queue-depth must be an integer between 1 and 10",
      );
      expect(() => parseTransportProbeArgs(["--max-history-queries", "99"])).toThrow(
        "--max-history-queries must be an integer between 1 and 2",
      );
      expect(() => parseTransportProbeArgs(["--max-tx-retrievals", "99"])).toThrow(
        "--max-tx-retrievals must be an integer between 1 and 5",
      );
    });
  });

  // ==========================================================================
  // 2. Single Overall Network Deadline and Settled Shutdown
  // ==========================================================================
  describe("Overall Network Deadline & Settled Shutdown", () => {
    it("enforces overall network deadline (25 ms) and settles workers with zero post-deadline dispatches", async () => {
      const mockTransport = new MockWebSocketTransport();
      let dispatchesAfterReturn = 0;
      let dispatchesDuringProbe = 0;
      let probeReturned = false;

      const mockFetch: typeof fetch = async () => {
        if (probeReturned) {
          dispatchesAfterReturn++;
        }
        dispatchesDuringProbe++;
        // Simulate slight network delay
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      };

      const startTime = Date.now();
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 25, // 25 ms short deadline test
        transport: mockTransport,
        fetchTransport: mockFetch,
      });

      mockTransport.triggerOpen();
      // Send subscription ack
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      // Send a notification with subscription id
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      probeReturned = true;

      // Wait an additional 50 ms to verify no trailing background worker dispatches occur
      await new Promise((r) => setTimeout(r, 50));

      expect(dispatchesAfterReturn).toBe(0);
      expect(dispatchesDuringProbe).toBeGreaterThanOrEqual(0);
      expect(result.dryRun).toBe(false);

      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.metadata.terminationReason).toBe("DURATION_EXPIRED");
        expect(Date.now() - startTime).toBeGreaterThanOrEqual(24);
        // History discovery must NOT be dispatched post-expiration
        expect(succ.summary.historyDiscoveryTelemetry.discoveryOutcome).toMatch(
          /OPERATION_DEADLINE_EXCEEDED|OPERATION_CANCELLED|NOT_ATTEMPTED/,
        );
      }
    });
  });

  // ==========================================================================
  // 3. Bounded and Protected HTTP Paths
  // ==========================================================================
  describe("Bounded and Protected HTTP Paths", () => {
    it("rejects HTTP redirects with HTTP_REDIRECT_REJECTED and zero follow-ups", async () => {
      const redirectMockFetch: typeof fetch = async () => {
        return new Response(null, {
          status: 301,
          statusText: "Moved Permanently",
          headers: { Location: "https://attacker.example.com" },
        });
      };

      const boundedFetch = createBoundedFetchTransport(redirectMockFetch);
      await expect(boundedFetch("https://api.mainnet-beta.solana.com")).rejects.toThrow(
        "HTTP_REDIRECT_REJECTED",
      );
    });

    it("enforces body size limit and throws RESPONSE_TOO_LARGE on oversized response body", async () => {
      const maxLimit = 128; // 128 bytes limit
      const oversizedData = Buffer.alloc(512, "x");

      let readerCancelled = false;
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedData);
          // Stream kept open so cancel triggers underlying handler
        },
        cancel() {
          readerCancelled = true;
        },
      });

      const res = await readBoundedStream(mockStream, maxLimit);
      expect(res.overflow).toBe(true);
      expect(res.totalObservedBytes).toBe(512);
      expect(res.bytes.length).toBe(maxLimit);
      expect(readerCancelled).toBe(true);
    });

    it("validates history JSON-RPC errors and does not swallow them as empty arrays", async () => {
      const mockTransport = new MockWebSocketTransport();
      let fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const sleepFn = async (ms: number) => {
        if (ms >= 100) {
          fakeNow += ms;
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      };

      const errorJsonRpcFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid request payload" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 60_000,
        streamingDurationMs: 10,
        transport: mockTransport,
        fetchTransport: errorJsonRpcFetch,
        clock,
        sleepFn,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        // History discovery must capture JSON_RPC_ERROR rather than swallowing as empty
        expect(succ.summary.historyDiscoveryTelemetry.discoveryOutcome).toContain("JSON_RPC_ERROR");
      }
    });
  });

  // ==========================================================================
  // 4. Queue and Payload Accounting
  // ==========================================================================
  describe("Queue and Payload Accounting", () => {
    it("halts on queue overflow, sets queueLimitExceeded, preserves collection gap, and reports rejections", async () => {
      const mockTransport = new MockWebSocketTransport();
      // Set maxQueueDepth = 1 so second pending notification overflows
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxQueueDepth: 1,
        durationMs: 5000,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Send 1st notification (fills queue to limit 1)
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 101 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      // Send 2nd notification (causes queue overflow)
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 102 },
              value: { signature: SIG_B, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.terminationReason).toBe("QUEUE_LIMIT_EXCEEDED");
        expect(succ.summary.queueTelemetry.queueLimitExceeded).toBe(true);
        expect(succ.summary.queueTelemetry.queueRejectionsCount).toBeGreaterThanOrEqual(1);
        expect(succ.metadata.counts.queueRejectionsCount).toBeGreaterThanOrEqual(1);
      }
    });

    it("calculates payload overshoot independently of winning termination reason and halts oversized message propagation", async () => {
      const mockTransport = new MockWebSocketTransport();
      // 100 bytes limit
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxPayloadBytes: 100,
        durationMs: 5000,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Large message: 250 bytes
      const bigMessage = JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 101 },
            value: {
              signature: SIG_ANCHOR,
              logs: new Array(5).fill("0123456789ABCDEF"),
              err: null,
            },
          },
        },
      });

      mockTransport.triggerMessage(bigMessage);

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.terminationReason).toBe("PAYLOAD_LIMIT_REACHED");
        expect(succ.metadata.counts.overshootBytes).toBeGreaterThan(0);
        expect(succ.summary.streamingTelemetry.overshootBytes).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // 5. Outcomes & Evidence Accuracy
  // ==========================================================================
  describe("Outcomes & Evidence Accuracy", () => {
    it("classifies unexpected transport disconnect or error as TRANSPORT_ERROR while sealing partial evidence", async () => {
      const mockTransport = new MockWebSocketTransport();
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 5000,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerError(new Error("Connection reset by peer"));

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.observationSuccess).toBe(false);
        expect(succ.status).toBe("TRANSPORT_ERROR");
        expect(succ.manifestSealed).toBe(true);

        // Verify sealed files exist on disk despite transport error
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "probe-summary.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-metadata.json"))).toBe(true);
      }
    });

    it("preserves anchor observed slot and blockTime from history page rather than replacing with 0 and null", async () => {
      const mockTransport = new MockWebSocketTransport();
      let fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const sleepFn = async (ms: number) => {
        if (ms >= 100) {
          fakeNow += ms;
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      };

      const mockHistoryFetcher: HistoryPageFetcher = {
        fetchPage: async (): Promise<readonly HistorySignatureRecord[]> => {
          return [
            {
              signature: SIG_B,
              slot: 280_000_105,
              err: null,
              blockTime: 1_700_000_050,
            },
            {
              signature: SIG_ANCHOR,
              slot: 280_000_100, // Authentic slot
              err: null,
              blockTime: 1_700_000_000, // Authentic blockTime
            },
          ];
        },
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 60_000,
        streamingDurationMs: 10,
        transport: mockTransport,
        historyPageFetcher: mockHistoryFetcher,
        clock,
        sleepFn,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 280_000_100 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.summary.historyDiscoveryTelemetry.anchorWitnessed).toBe(true);
        expect(succ.summary.historyDiscoveryTelemetry.anchorSlot).toBe(280_000_100);
        expect(succ.summary.historyDiscoveryTelemetry.anchorBlockTime).toBe(1_700_000_000);

        // Verify witnessed-signatures.json on disk preserved slot and blockTime
        const witnessedFile = JSON.parse(
          fsSync.readFileSync(path.join(testOutputDir, "witnessed-signatures.json"), "utf8"),
        );
        const historyAnchor = witnessedFile.historyWitnessed.find(
          (r: { signature: string }) => r.signature === SIG_ANCHOR,
        );
        expect(historyAnchor).toBeDefined();
        expect(historyAnchor.slot).toBe(280_000_100);
        expect(historyAnchor.blockTime).toBe(1_700_000_000);
      }
    });

    it("known valid swap-decoding positive control: acknowledges subscription, fetches transaction, decodes swap, and records audited diagnostics", async () => {
      const mockTransport = new MockWebSocketTransport();
      const syntheticBuy = createSyntheticBuyPayload(SIG_C);

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: syntheticBuy,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 280_000_100 },
              value: { signature: SIG_C, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.counts.decodedSwapsCount).toBe(1);
        expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(1);
        expect(succ.metadata.counts.transactionRetrievalsSucceeded).toBe(1);
        expect(succ.summary.sampledTransactionAudits.length).toBe(1);
        expect(succ.summary.sampledTransactionAudits[0]?.outcome).toBe("SUCCESS");
        expect(succ.summary.sampledTransactionAudits[0]?.decodedEventsCount).toBe(1);
      }
    });

    it("enforces maximum 2 history queries with positive WebSocket anchor and pacing", async () => {
      const mockTransport = new MockWebSocketTransport();
      let fakeNow = 1_700_000_000_000;
      let sleepPacingCalls = 0;
      const clock = () => fakeNow;
      const sleepFn = async (ms: number) => {
        sleepPacingCalls++;
        fakeNow += ms;
      };

      let historyCalls = 0;

      const mockHistoryFetcher: HistoryPageFetcher = {
        fetchPage: async (): Promise<readonly HistorySignatureRecord[]> => {
          historyCalls++;
          return [
            {
              signature: SIG_B,
              slot: 101,
              err: null,
              blockTime: 1768000000,
            },
            {
              signature: SIG_ANCHOR,
              slot: 100,
              err: null,
              blockTime: 1767999900,
            },
          ];
        },
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 60_000,
        streamingDurationMs: 10,
        maxHistoryQueries: 2,
        maxTransactionRetrievals: 5,
        transport: mockTransport,
        historyPageFetcher: mockHistoryFetcher,
        clock,
        sleepFn,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      if (!result.dryRun && "manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(historyCalls).toBe(1);
        expect(sleepPacingCalls).toBeGreaterThanOrEqual(1);
        expect(succ.metadata.counts.historyQueriesAttempted).toBe(1);
        expect(succ.summary.budgetAccounting.maxHttpAttemptsLimit).toBe(MAX_TOTAL_HTTP_ATTEMPTS);
      }
    });
  });

  // ==========================================================================
  // 6. Safeguards and Manifest Sealing
  // ==========================================================================
  describe("Safeguards and Manifest Sealing", () => {
    it("strictly preserves production completeness = false, Gate 11 fail-closed, and 7.9259 SOL virtual wallet", async () => {
      const mockTransport = new MockWebSocketTransport();
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 100,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.isProductionCompletenessEstablished).toBe(false);
        expect(succ.metadata.gate11Status).toBe("UNAFFECTED_FAIL_CLOSED");
        expect(succ.metadata.virtualWalletBalanceSol).toBe("7.9259 SOL");
        expect(succ.metadata.spendingCeiling).toBe("$0.00");
      }
    });

    it("creates sealed manifest with authentic SHA-256 digests and entries digest", async () => {
      const mockTransport = new MockWebSocketTransport();
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 100,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);

        const manifestPath = path.join(testOutputDir, "capture-manifest.json");
        expect(fsSync.existsSync(manifestPath)).toBe(true);

        const manifestRaw = fsSync.readFileSync(manifestPath);
        const computedManifestSha = crypto.createHash("sha256").update(manifestRaw).digest("hex");
        expect(succ.manifest.manifestFileSha256).toBe(computedManifestSha);
        expect(succ.manifest.files.length).toBe(4); // probe-summary, capture-metadata, witnessed-signatures, sampled-transactions
        const manifestFilenames = succ.manifest.files.map((f) => f.filename);
        expect(manifestFilenames).toContain("capture-metadata.json");
        expect(manifestFilenames).toContain("probe-summary.json");
        expect(manifestFilenames).toContain("witnessed-signatures.json");
        expect(manifestFilenames).toContain("sampled-transactions.json");
      }
    });
  });

  // ==========================================================================
  // 7. Worker Settlement, Interruption & Post-Finalization Invariants
  // ==========================================================================
  describe("Worker Settlement, Interruption & Post-Finalization Invariants", () => {
    it("enforces transaction cap under concurrent phase transition", async () => {
      const mockTransport = new MockWebSocketTransport();
      let dispatchesCount = 0;
      let fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const sleepFn = async (ms: number) => {
        if (ms >= 100) {
          fakeNow += ms;
        } else {
          await new Promise((r) => setTimeout(r, ms));
        }
      };

      const mockFetch: typeof fetch = async (_input, init) => {
        dispatchesCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as { params?: unknown[] }) : {};
        const reqSig =
          Array.isArray(body?.params) && typeof body.params[0] === "string"
            ? body.params[0]
            : SIG_C;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: createSyntheticBuyPayload(reqSig),
          }),
        );
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 15_000,
        streamingDurationMs: 20, // Overlapping phase transition while worker is active
        maxTransactionRetrievals: 2,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
        sleepFn,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Send 4 notifications
      for (let i = 0; i < 4; i++) {
        mockTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: 1,
              result: {
                context: { slot: 100 + i },
                value: {
                  signature: `5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU${i}`,
                  logs: [],
                  err: null,
                },
              },
            },
          }),
        );
      }

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      expect(dispatchesCount).toBe(2);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(2);
        expect(succ.metadata.terminationReason).toBe("TRANSACTION_LIMIT_REACHED");
        expect(succ.status).toBe("CAP_LIMITED");
      }
    });

    it("discards delayed transport completion after cancellation", async () => {
      const mockTransport = new MockWebSocketTransport();

      const mockFetch: typeof fetch = async (_input, init) => {
        // Return a promise that only resolves after abort
        return new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            // Delay resolution past cancellation
            setTimeout(() => {
              resolve(
                new Response(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: createSyntheticBuyPayload(SIG_C),
                  }),
                ),
              );
            }, 20);
          });
        });
      };

      const abortController = new AbortController();
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 5000,
        signal: abortController.signal,
        transport: mockTransport,
        fetchTransport: mockFetch,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: { signature: SIG_C, logs: [], err: null },
            },
          },
        }),
      );

      // Wait 10ms for dispatch, then abort
      await new Promise((r) => setTimeout(r, 10));
      abortController.abort(new Error("Manual abort"));

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.terminationReason).toBe("MANUAL_CANCEL");
        expect(succ.metadata.counts.transactionRetrievalsSucceeded).toBe(0);
        expect(succ.summary.sampledTransactionAudits.length).toBe(0);
      }
    });

    it("interrupts pending body read on abort including late EOF", async () => {
      // 1. Pending read interrupted by abort
      let streamCancelled = false;
      const abortController = new AbortController();

      const pendingStream = new ReadableStream<Uint8Array>({
        start() {},
        pull() {
          // Never resolves spontaneously
          return new Promise(() => {});
        },
        cancel() {
          streamCancelled = true;
        },
      });

      const readPromise = readBoundedStream(pendingStream, 1024, abortController.signal);
      abortController.abort(new Error("Test abort"));

      await expect(readPromise).rejects.toThrow("Operation aborted");
      expect(streamCancelled).toBe(true);

      // 2. Late EOF arriving after abort
      const eofStream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Close immediately upon pull
          controller.close();
        },
      });

      const alreadyAborted = AbortSignal.abort(new Error("Pre-aborted"));
      await expect(readBoundedStream(eofStream, 1024, alreadyAborted)).rejects.toThrow(
        "Operation aborted",
      );
    });

    it("cancels redirect response body on 301/302", async () => {
      let bodyCancelled = false;
      const mockRedirectFetch: typeof fetch = async () => {
        const mockStream = new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(mockStream, {
          status: 302,
          headers: { Location: "https://redirect.example.com" },
        });
      };

      const boundedFetch = createBoundedFetchTransport(mockRedirectFetch, 1024);
      await expect(boundedFetch("https://api.example.com/rpc")).rejects.toThrow(
        "HTTP_REDIRECT_REJECTED",
      );
      expect(bodyCancelled).toBe(true);
    });

    it("records failed history queries in audit log and prevents post-finalization audit mutations", async () => {
      const mockTransport = new MockWebSocketTransport();
      let fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const sleepFn = async (ms: number) => {
        if (ms >= 100) {
          fakeNow += ms;
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      };

      const mockFetch: typeof fetch = async (_input, init) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        if (bodyStr.includes("getSignaturesForAddress")) {
          // Simulate HTTP 500 error
          return new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Error",
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: createSyntheticBuyPayload(SIG_ANCHOR, Math.floor(fakeNow / 1000)),
          }),
        );
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 60_000,
        streamingDurationMs: 10,
        maxHistoryQueries: 1,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
        sleepFn,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: { signature: SIG_ANCHOR, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        // Verify failed history query was audited in historyQueryAudits
        expect(succ.summary.historyQueryAudits.length).toBe(1);
        const audit = succ.summary.historyQueryAudits[0]!;
        expect(audit.httpStatus).toBe(500);
        expect(audit.error).toContain("HTTP 500");
        expect(typeof audit.requestSentAtMs).toBe("number");
        expect(typeof audit.headersReceivedAtMs).toBe("number");
        expect(audit.responseReceivedAtMs).toBe(null);

        // Verify array immutability (frozen)
        expect(Object.isFrozen(succ.summary.sampledTransactionAudits)).toBe(true);
        expect(Object.isFrozen(succ.summary.historyQueryAudits)).toBe(true);

        // Verify sampled-transactions.json on disk matches returned summary
        const sampledTxPath = path.join(testOutputDir, "sampled-transactions.json");
        expect(fsSync.existsSync(sampledTxPath)).toBe(true);
        const sampledTxData = JSON.parse(fsSync.readFileSync(sampledTxPath, "utf8"));
        expect(sampledTxData).toEqual(succ.summary.sampledTransactionAudits);
      }
    });

    it("rejects cancellation before transport construction: pre-aborted signal returns OPERATION_CANCELLED with zero sockets and zero HTTP calls", async () => {
      let httpCalls = 0;
      const mockFetch: typeof fetch = async () => {
        httpCalls++;
        return new Response("ok");
      };

      const abortedSignal = AbortSignal.abort();
      const nonExistentDir = path.join(testOutputDir, "pre-aborted-dir");

      const result = await executeTransportObservationProbe({
        isLive: true,
        outDir: nonExistentDir,
        durationMs: 5000,
        signal: abortedSignal,
        fetchTransport: mockFetch,
      });

      expect(result.success).toBe(false);
      expect("message" in result).toBe(true);
      if ("message" in result) {
        expect(result.status).toBe("OPERATION_CANCELLED");
        expect(result.message).toContain("caller signal already aborted");
      }
      expect(httpCalls).toBe(0);
      expect(fsSync.existsSync(nonExistentDir)).toBe(false);
    });

    it("bounds header latency and honors cancellation promptly when headers are slow", async () => {
      const slowFetch: typeof fetch = async () => {
        // Slow headers: takes 300ms to arrive
        await new Promise((resolve) => setTimeout(resolve, 300));
        return new Response("delayed response", { status: 200 });
      };

      const boundedFetch = createBoundedFetchTransport(slowFetch, 1024 * 1024);
      const controller = new AbortController();

      // Trigger abort after 30ms
      setTimeout(() => controller.abort(), 30);

      const startTime = Date.now();
      await expect(
        boundedFetch("https://mock-rpc.solana.com", { signal: controller.signal }),
      ).rejects.toThrow(/aborted/i);
      const elapsed = Date.now() - startTime;

      // Must abort promptly (well under 300ms, typically 30-80ms)
      expect(elapsed).toBeLessThan(200);
    });

    it("boundedCancel terminates within timeout bound when stream cancel never settles", async () => {
      let cancelCalled = false;
      const neverResolvingTarget = {
        cancel: async () => {
          cancelCalled = true;
          return new Promise(() => {}); // Never resolves
        },
      };

      const startMs = Date.now();
      await boundedCancel(neverResolvingTarget, new Error("timeout test"), 50);
      const elapsed = Date.now() - startMs;

      expect(cancelCalled).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(300);
    });

    it("audits cancelled attempts in final accounting without retaining cancelled payloads as successful data", async () => {
      const mockTransport = new MockWebSocketTransport();
      const controller = new AbortController();

      const mockFetch: typeof fetch = async (_input, init) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        if (bodyStr.includes("getTransaction")) {
          // Abort caller controller directly while getTransaction is in flight
          controller.abort();
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              // Late response after abort
              resolve(
                new Response(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: createSyntheticBuyPayload(SIG_C),
                  }),
                  { status: 200 },
                ),
              );
            }, 50);
          });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 5000,
        signal: controller.signal,
        transport: mockTransport,
        fetchTransport: mockFetch,
        maxTransactionRetrievals: 1,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 280_000_100 },
              value: { signature: SIG_C, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      expect(result.dryRun).toBe(false);
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(1);
        expect(succ.metadata.counts.transactionRetrievalsSucceeded).toBe(0);
        expect(succ.summary.sampledTransactionAudits.length).toBe(1);

        const audit = succ.summary.sampledTransactionAudits[0]!;
        expect(audit.outcome).toBe("REQUEST_TIMEOUT");
        expect(audit.decodedEventsCount).toBe(0);
        expect(audit.ingestedCount).toBe(0);
        expect(audit.responseReceivedAtMs).toBe(null);
        expect(audit.responseSha256).toBe(null);
        expect(audit.isCompletePayload).toBe(false);
      }
    });

    it("replays a sampled transaction whose response exceeds 2,048 characters using retained complete body", async () => {
      const mockTransport = new MockWebSocketTransport();

      // Create a large synthetic payload > 2,048 bytes
      const syntheticBuy = createSyntheticBuyPayload(SIG_C);
      // Pad logs so the JSON payload exceeds 2,048 bytes
      const largeLogs = [
        ...syntheticBuy.meta.logMessages,
        ...Array.from(
          { length: 50 },
          (_, i) => `Program log: synthetic padding log line #${i} ${"x".repeat(50)}`,
        ),
      ];
      syntheticBuy.meta.logMessages = largeLogs;

      const fullResponseBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: syntheticBuy,
      });
      expect(fullResponseBody.length).toBeGreaterThan(2048);

      const expectedSha256 = crypto.createHash("sha256").update(fullResponseBody).digest("hex");

      const mockFetch: typeof fetch = async () => {
        return new Response(fullResponseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        maxTransactionRetrievals: 1,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 280_000_100 },
              value: { signature: SIG_C, logs: [], err: null },
            },
          },
        }),
      );

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.summary.sampledTransactionAudits.length).toBe(1);
        const audit = succ.summary.sampledTransactionAudits[0]!;

        // 1. Verify snippet is bounded to 2,048
        expect(audit.responseSnippet?.length).toBeLessThanOrEqual(2048);

        // 2. Verify complete body is retained and exceeds 2,048
        expect(audit.responseBody).toBeDefined();
        expect(audit.responseBody?.length).toBeGreaterThan(2048);
        expect(audit.isCompletePayload).toBe(true);

        // 3. Verify SHA-256 equivalence
        expect(audit.responseSha256).toBe(expectedSha256);
        const computedSha256 = crypto
          .createHash("sha256")
          .update(audit.responseBody!)
          .digest("hex");
        expect(computedSha256).toBe(audit.responseSha256);

        // 4. Offline Replay: Parse the saved body and decode through Raydium decoder
        const parsed = JSON.parse(audit.responseBody!);
        const replayResult = decodeRaydiumTransactionSwaps(
          parsed.result,
          DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
        );
        expect(replayResult.ok).toBe(true);
        if (replayResult.ok) {
          expect(replayResult.events.length).toBe(1);
          expect(replayResult.events[0]?.signature).toBe(SIG_C);
          expect(replayResult.events[0]?.side).toBe("BUY");
        }
      }
    });

    it("records connection open timing, subscription acknowledgement, and last message timestamp", async () => {
      const mockTransport = new MockWebSocketTransport();
      let fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        streamingDurationMs: 50,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      fakeNow += 15;
      mockTransport.triggerOpen();

      fakeNow += 10;
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 888 }));

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        const td = succ.metadata.transportDiagnostics;
        expect(td.connectedAtMs).toBe(1_700_000_000_015);
        expect(td.connectDurationMs).toBe(15);
        expect(td.subscriptionStatus).toBe("ACKNOWLEDGED");
        expect(td.subscriptionId).toBe(888);
        expect(td.subscriptionAcknowledgedAtMs).toBe(1_700_000_000_025);
        expect(td.lastMessageReceivedAtMs).toBe(1_700_000_000_025);
        expect(td.intentionalShutdownInitiated).toBe(true);
        expect(td.isUpstreamClosure).toBe(false);

        // Verify matches summary
        expect(succ.summary.transportDiagnostics).toEqual(td);
      }
    });

    it("captures upstream transport error and cause with synthetic secret redaction", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;

      const mockFetch: typeof fetch = async () => {
        return new Response("ok");
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const syntheticError = new Error(
        "Connection reset while querying endpoint api-key=supersecrettoken12345",
        { cause: "Underlying TLS failure auth=sensitivepassword999" },
      );
      mockTransport.triggerError(syntheticError);

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        const td = succ.metadata.transportDiagnostics;
        expect(td.isUpstreamClosure).toBe(true);
        expect(td.closeCode).toBeNull();
        expect(td.localCloseCode).toBe(1000);
        expect(td.firstErrorMessage).toContain("api-key=[REDACTED]");
        expect(td.firstErrorMessage).not.toContain("supersecrettoken12345");
        expect(td.firstErrorCause).toContain("auth=[REDACTED]");
        expect(td.firstErrorCause).not.toContain("sensitivepassword999");

        // Verify written disk files are redacted
        const metaJson = fsSync.readFileSync(
          path.join(testOutputDir, "capture-metadata.json"),
          "utf8",
        );
        expect(metaJson).not.toContain("supersecrettoken12345");
        expect(metaJson).not.toContain("sensitivepassword999");
        expect(metaJson).toContain("[REDACTED]");
      }
    });

    it("captures upstream close code and reason with synthetic secret redaction", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;

      const mockFetch: typeof fetch = async () => {
        return new Response("ok");
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Upstream close with secret in reason
      mockTransport.triggerClose(1006, "Abnormal termination upstream token=secretbearertoken777");

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        const td = succ.metadata.transportDiagnostics;
        expect(td.closeCode).toBe(1006);
        expect(td.closeReason).toContain("token=[REDACTED]");
        expect(td.closeReason).not.toContain("secretbearertoken777");
        expect(td.isUpstreamClosure).toBe(true);

        const summaryJson = fsSync.readFileSync(
          path.join(testOutputDir, "probe-summary.json"),
          "utf8",
        );
        expect(summaryJson).not.toContain("secretbearertoken777");
      }
    });

    it("captures subscription rejection error with synthetic secret redaction", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;

      const mockFetch: typeof fetch = async () => {
        return new Response("ok");
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        streamingDurationMs: 50,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      // Provider returns JSON-RPC error with sensitive query string
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32600,
            message: "Subscription rejected for api-key=verysecretapikey999",
          },
        }),
      );

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        const td = succ.metadata.transportDiagnostics;
        expect(td.subscriptionStatus).toBe("REJECTED");
        expect(td.subscriptionError).toContain("api-key=[REDACTED]");
        expect(td.subscriptionError).not.toContain("verysecretapikey999");
      }
    });

    it("counts each incoming application message and bytes exactly once with two or more consumers", () => {
      const mockTransport = new MockWebSocketTransport();
      let interceptCount = 0;
      let interceptBytes = 0;
      const metered = new MeteredWebSocketTransport(mockTransport, 1024, (count, bytes) => {
        interceptCount = count;
        interceptBytes = bytes;
      });

      let c1Calls = 0;
      let c2Calls = 0;
      let c3Calls = 0;
      metered.on("message", () => {
        c1Calls++;
      });
      metered.on("message", () => {
        c2Calls++;
      });
      metered.on("message", () => {
        c3Calls++;
      });

      const frame37 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 });
      const expectedByteLen = Buffer.byteLength(frame37, "utf8");

      mockTransport.triggerMessage(frame37);

      // Verify each consumer received the frame exactly once
      expect(c1Calls).toBe(1);
      expect(c2Calls).toBe(1);
      expect(c3Calls).toBe(1);

      // Ingress metering must count exactly 1 message and byte length despite 3 consumers
      expect(metered.getMessageCount()).toBe(1);
      expect(metered.getApplicationPayloadBytes()).toBe(expectedByteLen);
      expect(interceptCount).toBe(1);
      expect(interceptBytes).toBe(expectedByteLen);
    });

    it("enforces message cap correctly under multiple listeners without early termination", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;

      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        maxMessages: 2,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();

      // Send 1st frame: 37-byte subscription acknowledgement
      const frame1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 });
      mockTransport.triggerMessage(frame1);

      // Give event loop a tick to process
      await new Promise((r) => setTimeout(r, 10));

      // In the buggy version, frame 1 produced count=2, immediately terminating probe with MESSAGE_LIMIT_REACHED.
      // With ingress metering, probe must still be active and await frame 2.
      const frame2 = JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: { result: { value: { logs: [], signature: SIG_ANCHOR } }, subscription: 1 },
      });
      mockTransport.triggerMessage(frame2);

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.metadata.terminationReason).toBe("MESSAGE_LIMIT_REACHED");
        expect(succ.metadata.counts.inboundMessagesCount).toBe(2);
        const expectedBytes = Buffer.byteLength(frame1, "utf8") + Buffer.byteLength(frame2, "utf8");
        expect(succ.metadata.counts.applicationPayloadBytes).toBe(expectedBytes);
      }
    });

    it("sanitizes nested JSON credential fields before serialization and verifies sealed artifacts", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const syntheticApiKey = "synthetic-nested-secret-apiKey-112233";
      const syntheticClientSecret = "synthetic-deep-clientSecret-445566";

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        streamingDurationMs: 50,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32602,
            message: "Authentication failure on cluster endpoint",
            data: {
              apiKey: syntheticApiKey,
              details: {
                clientSecret: syntheticClientSecret,
                safeClusterId: "mainnet-beta-node-4",
              },
            },
          },
        }),
      );

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        const td = succ.metadata.transportDiagnostics;
        expect(td.subscriptionStatus).toBe("REJECTED");
        expect(td.subscriptionError).toContain("[REDACTED]");
        expect(td.subscriptionError).not.toContain(syntheticApiKey);
        expect(td.subscriptionError).not.toContain(syntheticClientSecret);
        expect(td.subscriptionError).toContain("safeClusterId");

        // Verify sealed disk evidence contains NO unredacted secrets
        const metaPath = path.join(testOutputDir, "capture-metadata.json");
        const summaryPath = path.join(testOutputDir, "probe-summary.json");
        const metaContent = fsSync.readFileSync(metaPath, "utf8");
        const summaryContent = fsSync.readFileSync(summaryPath, "utf8");

        expect(metaContent).not.toContain(syntheticApiKey);
        expect(metaContent).not.toContain(syntheticClientSecret);
        expect(summaryContent).not.toContain(syntheticApiKey);
        expect(summaryContent).not.toContain(syntheticClientSecret);
        expect(metaContent).toContain("[REDACTED]");
        expect(summaryContent).toContain("[REDACTED]");
      }
    });

    it("separates upstream error from subsequent local close(1000) and preserves error code & cause chain", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const nestedCause = new Error("TLS handshake aborted", {
        cause: { code: "ERR_TLS_RESET", detail: "Remote server dropped connection" },
      });
      const topError = new Error("WebSocket transport encountered a fatal socket error", {
        cause: nestedCause,
      });
      (topError as unknown as { code: string }).code = "ECONNRESET";

      mockTransport.triggerError(topError);

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        const td = succ.metadata.transportDiagnostics;

        // Upstream failure details
        expect(td.isUpstreamClosure).toBe(true);
        expect(td.intentionalShutdownInitiated).toBe(false);
        expect(td.firstErrorMessage).toContain(
          "WebSocket transport encountered a fatal socket error",
        );
        expect(td.firstErrorCode).toBe("ECONNRESET");
        expect(td.firstErrorCause).toContain("TLS handshake aborted");
        expect(td.firstErrorCause).toContain("ERR_TLS_RESET");
        expect(td.firstErrorCause).toContain("Remote server dropped connection");

        // Code 1000 from local teardown close request must NOT be attributed to upstream failure
        expect(td.closeCode).toBeNull();
        expect(td.closeReason).toBeNull();
        expect(td.localCloseCode).toBe(1000);
        expect(td.localCloseReason).toContain("WebSocket error:");
      }
    });

    it("retains genuine upstream closure code and reason without overwrite by local teardown", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Genuine upstream close event with abnormal code 1006
      mockTransport.triggerClose(1006, "Connection dropped by upstream cluster gateway");

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        const td = succ.metadata.transportDiagnostics;

        // Upstream closure code & reason strictly preserved
        expect(td.isUpstreamClosure).toBe(true);
        expect(td.intentionalShutdownInitiated).toBe(false);
        expect(td.closeCode).toBe(1006);
        expect(td.closeReason).toBe("Connection dropped by upstream cluster gateway");

        // Local teardown requested close code
        expect(td.localCloseCode).toBe(1000);
        expect(td.localCloseReason).toContain(
          "WebSocket closed: Connection dropped by upstream cluster gateway",
        );
      }
    });

    it("preserves native Undici error-then-close(1006) sequence retaining both error cause and 1006 close code", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // 1. Native Undici emits TypeError first on socket drop
      const nativeTypeError = new TypeError("");
      const transportError = new Error("WebSocket transport error", { cause: nativeTypeError });
      mockTransport.triggerError(transportError);

      // 2. Native Undici immediately follows with close(1006, "")
      mockTransport.triggerClose(1006, "");

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        const td = succ.metadata.transportDiagnostics;

        // Preserves both the upstream error cause AND the subsequent observed 1006 code
        expect(td.isUpstreamClosure).toBe(true);
        expect(td.firstErrorMessage).toBe("WebSocket transport error");
        expect(td.firstErrorCause).toBe("TypeError: ");
        expect(td.closeCode).toBe(1006);
        expect(td.localCloseCode).toBe(1000);
        expect(td.observedCloseOrigin).toBe("UPSTREAM");
      }
    });

    it("marks close origin as UNCERTAIN when intentional local close(1000) encounters abnormal transport close(1006)", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        maxMessages: 1, // Intentional message cap reached
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      // Frame 1 triggers MESSAGE_LIMIT_REACHED, requesting local close(1000)
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Instead of clean close 1000, remote transport abruptly terminates with 1006
      mockTransport.triggerClose(1006, "Abnormal socket reset during teardown");

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        const td = succ.metadata.transportDiagnostics;

        expect(td.localCloseCode).toBe(1000);
        expect(td.closeCode).toBe(1006);
        expect(td.observedCloseOrigin).toBe("UNCERTAIN");
      }
    });

    it("records server PING and PONG frames via scoped diagnostics_channel without generating network traffic", async () => {
      const mockTransport = new MockWebSocketTransport();
      const fakeWs = {};
      (mockTransport as unknown as { getUnderlyingSocket: () => unknown }).getUnderlyingSocket =
        () => fakeWs;

      const fakeNow = 1_700_000_000_000;
      const clock = () => fakeNow;
      const mockFetch: typeof fetch = async () => new Response("ok");

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        durationMs: 500,
        streamingDurationMs: 50,
        transport: mockTransport,
        fetchTransport: mockFetch,
        clock,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Publish ping on diagnostics_channel for this fakeWs
      diagnostics_channel.channel("undici:websocket:ping").publish({
        websocket: fakeWs,
        payload: Buffer.from("PING"),
      });

      // Publish pong on diagnostics_channel for this fakeWs
      diagnostics_channel.channel("undici:websocket:pong").publish({
        websocket: fakeWs,
        payload: Buffer.from("PONG"),
      });

      // Publish ping on diagnostics_channel for an unrelated websocket (must NOT be counted)
      diagnostics_channel.channel("undici:websocket:ping").publish({
        websocket: {},
        payload: Buffer.from("UNRELATED"),
      });

      const result = await probePromise;
      if ("manifest" in result) {
        const succ = result as TransportProbeSuccessResult;
        const td = succ.metadata.transportDiagnostics;

        expect(td.serverPingsReceivedCount).toBe(1);
        expect(td.lastServerPingReceivedAtMs).toBe(fakeNow);
        expect(td.serverPongsReceivedCount).toBe(1);
        expect(td.lastServerPongReceivedAtMs).toBe(fakeNow);
      }
    });

    describe("Optional RFC 6455 Keepalive Transport", () => {
      async function createTestWebSocketServer(
        onConnection?: (socket: WebSocket) => void,
      ): Promise<{ server: WebSocketServer; port: number; close: () => Promise<void> }> {
        return new Promise((resolve) => {
          const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
            const port = (server.address() as { port: number }).port;
            if (onConnection) {
              server.on("connection", onConnection);
            }
            resolve({
              server,
              port,
              close: async () => {
                for (const client of server.clients) {
                  try {
                    client.terminate();
                  } catch {
                    // ignore
                  }
                }
                await new Promise<void>((r) => server.close(() => r()));
              },
            });
          });
        });
      }

      it("exchanges authentic RFC 6455 PING and PONG control frames on ws transport", async () => {
        let pingsObservedAtServer = 0;
        let lastServerPingPayload: Buffer | null = null;

        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 12345 }));

          socket.on("ping", (data: Buffer) => {
            pingsObservedAtServer++;
            lastServerPingPayload = data;
          });
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 50,
          maxPings: 2,
          pongTimeoutMs: 1000,
          durationMs: 350,
          streamingDurationMs: 250,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        expect(result.dryRun).toBe(false);
        expect("manifest" in result).toBe(true);
        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          expect(succ.observationSuccess).toBe(true);
          const td = succ.metadata.transportDiagnostics;

          expect(td.transportClient).toBe("ws");
          expect(td.keepaliveEnabled).toBe(true);
          expect(td.clientPingsSentCount).toBeGreaterThanOrEqual(1);
          expect(td.clientPongsReceivedCount).toBeGreaterThanOrEqual(1);
          expect(pingsObservedAtServer).toBeGreaterThanOrEqual(1);
          expect(lastServerPingPayload).not.toBeNull();
          expect(lastServerPingPayload!.length).toBe(8);
          expect(td.controlFrameBytesSent).toBeGreaterThanOrEqual(8);
          expect(td.controlFrameBytesReceived).toBeGreaterThanOrEqual(8);
          expect(td.lastPongLatencyMs).not.toBeNull();
          expect(td.minPongLatencyMs).not.toBeNull();
          expect(td.maxPongLatencyMs).not.toBeNull();
          expect(td.missingPongDetected).toBe(false);
        }
      });

      it("terminates probe with TRANSPORT_ERROR when server fails to respond to PING within pongTimeoutMs", async () => {
        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          // Suppress automatic pong replies so client detects missing pong
          socket.pong = () => {};
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 30,
          pongTimeoutMs: 60,
          durationMs: 500,
          streamingDurationMs: 400,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        expect("manifest" in result).toBe(true);
        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          expect(succ.status).toBe("TRANSPORT_ERROR");
          expect(succ.observationSuccess).toBe(false);
          const td = succ.metadata.transportDiagnostics;

          expect(td.transportClient).toBe("ws");
          expect(td.keepaliveEnabled).toBe(true);
          expect(td.clientPingsSentCount).toBe(1);
          expect(td.clientPongsReceivedCount).toBe(0);
          expect(td.missingPongDetected).toBe(true);
          expect(td.firstErrorMessage).toContain("Missing WebSocket keepalive PONG");
        }
      });

      it("decouples client from heartbeat by allowing keepalive to be disabled on ws transport", async () => {
        let pingsObservedAtServer = 0;

        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          socket.on("ping", () => {
            pingsObservedAtServer++;
          });
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: false,
          durationMs: 200,
          streamingDurationMs: 100,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          const td = succ.metadata.transportDiagnostics;

          expect(td.transportClient).toBe("ws");
          expect(td.keepaliveEnabled).toBe(false);
          expect(td.clientPingsSentCount).toBe(0);
          expect(td.clientPongsReceivedCount).toBe(0);
          expect(td.controlFrameBytesSent).toBe(0);
          expect(pingsObservedAtServer).toBe(0);
        }
      });

      it("ensures strict socket destruction, listener removal, and timer cleanup within 5-second deadline", async () => {
        let serverSocketClosed = false;

        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          socket.on("close", () => {
            serverSocketClosed = true;
          });
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const startTime = Date.now();
        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 25,
          maxPings: 2,
          pongTimeoutMs: 500,
          durationMs: 150,
          streamingDurationMs: 80,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        const elapsedMs = Date.now() - startTime;

        // Give loopback transport a brief tick to process closure frame
        if (!serverSocketClosed) {
          await new Promise((r) => setTimeout(r, 50));
        }

        await testWs.close();

        expect(elapsedMs).toBeLessThan(5000);
        expect(result.dryRun).toBe(false);
        expect(serverSocketClosed).toBe(true);
      });

      it("rejects --keepalive true on native transport as INVALID_INPUT", async () => {
        const result = await executeTransportObservationProbe({
          isLive: false,
          transportType: "native",
          keepalive: true,
        });

        expect(result.dryRun).toBe(true);
        expect(result.status).toBe("INVALID_INPUT");
        expect(result.success).toBe(false);
        expect((result as { message: string }).message).toContain(
          "keepalive is not supported on native WebSocket transport",
        );
      });

      it("reports keepalive limits accurately in dry-run mode without network execution", async () => {
        const result = await executeTransportObservationProbe({
          isLive: false,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 20_000,
          maxPings: 4,
          pongTimeoutMs: 10_000,
          durationMs: 90_000,
        });

        expect(result.dryRun).toBe(true);
        expect(result.status).toBe("DRY_RUN");
        expect(result.success).toBe(true);
        if (result.dryRun && result.success) {
          expect(result.limits.transportType).toBe("ws");
          expect(result.limits.keepaliveEnabled).toBe(true);
          expect(result.limits.pingIntervalMs).toBe(20_000);
          expect(result.limits.maxPings).toBe(4);
          expect(result.limits.pongTimeoutMs).toBe(10_000);
          expect(result.limits.maxControlFrames).toBe(50);
          expect(result.limits.maxControlFrameBytes).toBe(4096);
        }
      });

      it("parses CLI flags for keepalive experiment correctly", () => {
        const args1 = parseTransportProbeArgs([
          "--transport",
          "ws",
          "--keepalive",
          "true",
          "--ping-interval-ms",
          "15000",
          "--max-pings",
          "3",
          "--pong-timeout-ms",
          "8000",
          "--max-control-frames",
          "30",
          "--max-control-bytes",
          "2048",
        ]);
        expect(args1.transport).toBe("ws");
        expect(args1.keepalive).toBe(true);
        expect(args1.pingIntervalMs).toBe(15000);
        expect(args1.maxPings).toBe(3);
        expect(args1.pongTimeoutMs).toBe(8000);
        expect(args1.maxControlFrames).toBe(30);
        expect(args1.maxControlFrameBytes).toBe(2048);

        const args2 = parseTransportProbeArgs(["--transport", "ws", "--disable-keepalive"]);
        expect(args2.transport).toBe("ws");
        expect(args2.keepalive).toBe(false);

        const args3 = parseTransportProbeArgs(["--transport", "native"]);
        expect(args3.transport).toBe("native");
        expect(args3.keepalive).toBeUndefined();

        expect(() => parseTransportProbeArgs(["--transport", "invalid"])).toThrow(
          "--transport must be 'native' or 'ws'",
        );
        expect(() => parseTransportProbeArgs(["--keepalive", "notabool"])).toThrow(
          "--keepalive must be 'true' or 'false'",
        );
      });

      it("rejects wrong-payload PONGs, preserves missing-PONG timeout, and records unmatched count", async () => {
        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          const originalPong = socket.pong.bind(socket);
          // Override pong: send mismatched payload instead of echoed payload
          socket.pong = () => {
            originalPong(Buffer.from("mismatched-payload-bytes"));
          };
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 30,
          pongTimeoutMs: 70,
          durationMs: 400,
          streamingDurationMs: 300,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          expect(succ.status).toBe("TRANSPORT_ERROR");
          expect(succ.observationSuccess).toBe(false);
          const td = succ.metadata.transportDiagnostics;

          expect(td.clientPingsSentCount).toBe(1);
          expect(td.clientPongsReceivedCount).toBeGreaterThanOrEqual(1);
          expect(td.matchedClientPongsCount).toBe(0);
          expect(td.unmatchedClientPongsCount).toBeGreaterThanOrEqual(1);
          expect(td.missingPongDetected).toBe(true);
          expect(td.firstErrorMessage).toContain("Missing WebSocket keepalive PONG");
        }
      });

      it("ignores unsolicited and duplicate PONGs without scheduling extra PINGs or resetting send interval", async () => {
        let pingsReceivedAtServer = 0;
        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          // Send 2 unsolicited pongs before client sends any ping
          socket.pong(Buffer.from("unsolicited-1"));
          socket.pong(Buffer.from("unsolicited-2"));

          socket.on("ping", () => {
            pingsReceivedAtServer++;
            // Send additional duplicate pong
            socket.pong(Buffer.from("duplicate-pong"));
          });
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 50,
          maxPings: 2,
          pongTimeoutMs: 500,
          durationMs: 140,
          streamingDurationMs: 120,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          const td = succ.metadata.transportDiagnostics;

          expect(succ.observationSuccess).toBe(true);
          expect(pingsReceivedAtServer).toBeLessThanOrEqual(2);
          expect(td.unmatchedClientPongsCount).toBeGreaterThanOrEqual(2);
          expect(td.matchedClientPongsCount).toBeGreaterThanOrEqual(1);
        }
      });

      it("disposes keepalive before intentional socket closure during streaming completion with pending transaction retrieval", async () => {
        let serverClosed = false;
        let pingsAfterClose = 0;
        let activeSocket: WebSocket | undefined;

        const testWs = await createTestWebSocketServer((socket) => {
          activeSocket = socket;
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          socket.on("ping", () => {
            if (serverClosed) pingsAfterClose++;
          });
          socket.on("close", () => {
            serverClosed = true;
          });
        });

        let fetchDispatched = false;
        const mockFetch: typeof fetch = async () => {
          fetchDispatched = true;
          await new Promise((r) => setTimeout(r, 60));
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: createSyntheticBuyPayload(SIG_C) }),
          );
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 20,
          pongTimeoutMs: 200,
          durationMs: 300,
          streamingDurationMs: 40,
          maxTransactionRetrievals: 1,
          fetchTransport: mockFetch,
        });

        setTimeout(() => {
          activeSocket?.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                subscription: 1,
                result: {
                  context: { slot: 100 },
                  value: {
                    signature: SIG_C,
                    logs: [],
                    err: null,
                  },
                },
              },
            }),
          );
        }, 10);

        const result = await probePromise;
        await testWs.close();

        expect(result.dryRun).toBe(false);
        expect(fetchDispatched).toBe(true);
        expect(pingsAfterClose).toBe(0);
        expect(result.status).not.toBe("TRANSPORT_ERROR");
        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          expect(succ.observationSuccess).toBe(true);
          expect(succ.metadata.transportDiagnostics.intentionalShutdownInitiated).toBe(true);
          expect(succ.metadata.transportDiagnostics.missingPongDetected).toBe(false);
          expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(1);
        }
      });

      it("accurately accounts for server PINGs and automatic PONG replies in payload and wire byte metrics", async () => {
        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          setTimeout(() => {
            try {
              socket.ping(Buffer.from("0123456789"));
            } catch {
              // ignore
            }
          }, 25);
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          pingIntervalMs: 50,
          maxPings: 1,
          pongTimeoutMs: 500,
          durationMs: 200,
          streamingDurationMs: 120,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          const td = succ.metadata.transportDiagnostics;

          expect(td.serverPingsReceivedCount).toBeGreaterThanOrEqual(1);
          expect(td.automaticPongsSentCount).toBeGreaterThanOrEqual(1);
          expect(td.controlFramesReceivedCount).toBeGreaterThanOrEqual(2);
          expect(td.controlFramesSentCount).toBeGreaterThanOrEqual(2);
          expect(td.controlFramePayloadBytesReceived).toBeGreaterThanOrEqual(18);
          expect(td.controlFramePayloadBytesSent).toBeGreaterThanOrEqual(18);
          expect(td.controlFrameWireBytesSent).toBeGreaterThanOrEqual(30);
          expect(td.controlFrameWireBytesReceived).toBeGreaterThanOrEqual(22);
        }
      });

      it("enforces bounded control-frame traffic ceiling by terminating with CONTROL_LIMIT_REACHED", async () => {
        const testWs = await createTestWebSocketServer((socket) => {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          const floodInterval = setInterval(() => {
            try {
              socket.ping(Buffer.alloc(20));
            } catch {
              clearInterval(floodInterval);
            }
          }, 10);
          socket.on("close", () => clearInterval(floodInterval));
        });

        const mockFetch: typeof fetch = async () => new Response("ok");

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          wsUrl: `ws://127.0.0.1:${testWs.port}`,
          transportType: "ws",
          keepalive: true,
          maxControlFrames: 4,
          pingIntervalMs: 100,
          maxPings: 2,
          pongTimeoutMs: 500,
          durationMs: 500,
          streamingDurationMs: 400,
          fetchTransport: mockFetch,
        });

        const result = await probePromise;
        await testWs.close();

        if ("manifest" in result) {
          const succ = result as TransportProbeSuccessResult;
          expect(succ.metadata.terminationReason).toBe("CONTROL_LIMIT_REACHED");
          expect(succ.status).toBe("CAP_LIMITED");
          expect(succ.observationSuccess).toBe(true);
        }
      });

      describe("Transport-Only Mode Isolation (--transport-only)", () => {
        it("parses CLI flags and reports dry-run limits accurately for --transport-only", async () => {
          const parsed1 = parseTransportProbeArgs(["--transport-only"]);
          expect(parsed1.transportOnly).toBe(true);

          const parsed2 = parseTransportProbeArgs(["--transport-only", "--no-transport-only"]);
          expect(parsed2.transportOnly).toBe(false);

          const parsed3 = parseTransportProbeArgs(["--transport", "ws"]);
          expect(parsed3.transportOnly).toBeUndefined();

          const dryRunRes = await executeTransportObservationProbe({
            isLive: false,
            transportOnly: true,
          });
          expect(dryRunRes.dryRun).toBe(true);
          expect(dryRunRes.success).toBe(true);
          if (dryRunRes.dryRun && dryRunRes.success) {
            expect(dryRunRes.limits.transportOnly).toBe(true);
          }
        });

        it("does NOT overflow or terminate transport-only observation on notification bursts exceeding queue capacity, and maintains strictly zero HTTP dispatches", async () => {
          let httpDispatchAttempts = 0;
          const mockFetch: typeof fetch = async () => {
            httpDispatchAttempts++;
            throw new Error("HTTP dispatches are strictly prohibited in transport-only mode");
          };

          let activeSocket: WebSocket | undefined;
          const testWs = await createTestWebSocketServer((socket) => {
            activeSocket = socket;
            // Send subscription acknowledgement
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          });

          const probePromise = executeTransportObservationProbe({
            isLive: true,
            outDir: testOutputDir,
            wsUrl: `ws://127.0.0.1:${testWs.port}`,
            transportType: "ws",
            transportOnly: true,
            maxQueueDepth: 3, // Very low queue limit: 3
            durationMs: 300,
            streamingDurationMs: 150,
            fetchTransport: mockFetch,
          });

          // Rapidly burst 12 notifications (far exceeding maxQueueDepth: 3)
          setTimeout(() => {
            for (let i = 0; i < 12; i++) {
              const sig = encodeBase58(Buffer.alloc(64, i + 1));
              activeSocket?.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "logsNotification",
                  params: {
                    subscription: 1,
                    result: {
                      context: { slot: 1000 + i },
                      value: {
                        signature: sig,
                        logs: ["Program log: Instruction: Swap"],
                        err: null,
                      },
                    },
                  },
                }),
              );
            }
          }, 20);

          const result = await probePromise;
          await testWs.close();

          expect(result.dryRun).toBe(false);
          expect(httpDispatchAttempts).toBe(0);

          if ("manifest" in result) {
            const succ = result as TransportProbeSuccessResult;
            expect(succ.status).toBe("SUCCESS");
            expect(succ.observationSuccess).toBe(true);
            expect(succ.metadata.executionMode).toBe("TRANSPORT_ONLY");
            expect(succ.metadata.transportOnly).toBe(true);
            expect(succ.metadata.zeroHttpDispatchesEnforced).toBe(true);
            expect(succ.metadata.counts.peakQueueDepth).toBe(0);
            expect(succ.metadata.counts.queueRejectionsCount).toBe(0);
            expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(0);
            expect(succ.metadata.counts.transactionRetrievalsSucceeded).toBe(0);
            expect(succ.metadata.counts.historyQueriesAttempted).toBe(0);
            expect(succ.metadata.counts.decodedSwapsCount).toBe(0);
            expect(succ.summary.queueTelemetry.queueLimitExceeded).toBe(false);
            expect(succ.summary.tradeFlowTelemetry.flowCoverageStatus).toBe(
              "NOT_EVALUATED_TRANSPORT_ONLY",
            );
            expect(succ.summary.tradeFlowTelemetry.recentBuys).toBeNull();
            expect(succ.summary.tradeFlowTelemetry.recentSells).toBeNull();
            expect(succ.summary.historyDiscoveryTelemetry.discoveryOutcome).toBe(
              "NOT_ATTEMPTED_TRANSPORT_ONLY",
            );
            expect(succ.summary.discrepancyAnalysis.totalWsWitnessedSignatures).toBe(12);
            expect(succ.summary.discrepancyAnalysis.totalHistoryWitnessedSignatures).toBe(0);
            expect(succ.summary.budgetAccounting.totalHttpRequests).toBe(0);
          }
        });

        it("continues heartbeat exchanges for full configured observation duration without terminating early from empty retrieval queue", async () => {
          let pingsReceivedAtServer = 0;
          let activeSocket: WebSocket | undefined;

          const testWs = await createTestWebSocketServer((socket) => {
            activeSocket = socket;
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
            socket.on("ping", () => {
              pingsReceivedAtServer++;
            });
          });

          let httpAttempts = 0;
          const mockFetch: typeof fetch = async () => {
            httpAttempts++;
            return new Response("ok");
          };

          const startTime = Date.now();
          const probePromise = executeTransportObservationProbe({
            isLive: true,
            outDir: testOutputDir,
            wsUrl: `ws://127.0.0.1:${testWs.port}`,
            transportType: "ws",
            keepalive: true,
            transportOnly: true,
            pingIntervalMs: 35,
            maxPings: 2,
            pongTimeoutMs: 300,
            durationMs: 200,
            streamingDurationMs: 140,
            fetchTransport: mockFetch,
          });

          // Send 1 notification during observation
          setTimeout(() => {
            activeSocket?.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 1,
                  result: {
                    context: { slot: 500 },
                    value: {
                      signature: SIG_B,
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
          }, 15);

          const result = await probePromise;
          const elapsedMs = Date.now() - startTime;
          await testWs.close();

          expect(elapsedMs).toBeGreaterThanOrEqual(120); // Ran for streaming duration, did NOT exit early at t=0
          expect(httpAttempts).toBe(0);

          if ("manifest" in result) {
            const succ = result as TransportProbeSuccessResult;
            expect(succ.observationSuccess).toBe(true);
            expect(succ.status).toBe("SUCCESS");
            const td = succ.metadata.transportDiagnostics;
            expect(td.clientPingsSentCount).toBeGreaterThanOrEqual(2);
            expect(td.matchedClientPongsCount).toBeGreaterThanOrEqual(2);
            expect(td.missingPongDetected).toBe(false);
            expect(pingsReceivedAtServer).toBeGreaterThanOrEqual(2);
          }
        });

        it("enforces missing-PONG detection and control limits fail-closed in transport-only mode", async () => {
          // Sub-test 1: Missing-PONG timeout still triggers TRANSPORT_ERROR in transport-only mode
          const testWs1 = await createTestWebSocketServer((socket) => {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
            // Drop incoming pings: do not pong
            socket.pong = () => {};
          });

          const mockFetch: typeof fetch = async () => new Response("ok");

          const missingPongRes = await executeTransportObservationProbe({
            isLive: true,
            outDir: testOutputDir,
            wsUrl: `ws://127.0.0.1:${testWs1.port}`,
            transportType: "ws",
            keepalive: true,
            transportOnly: true,
            pingIntervalMs: 25,
            pongTimeoutMs: 50,
            durationMs: 300,
            streamingDurationMs: 200,
            fetchTransport: mockFetch,
          });
          await testWs1.close();

          if ("manifest" in missingPongRes) {
            const succ = missingPongRes as TransportProbeSuccessResult;
            expect(succ.status).toBe("TRANSPORT_ERROR");
            expect(succ.observationSuccess).toBe(false);
            expect(succ.metadata.terminationReason).toBe("TRANSPORT_ERROR");
            expect(succ.metadata.transportDiagnostics.missingPongDetected).toBe(true);
          }

          // Clean testOutputDir for next sub-test
          fsSync.rmSync(testOutputDir, { recursive: true, force: true });

          // Sub-test 2: Inbound message limit still terminates probe in transport-only mode
          let activeSocket2: WebSocket | undefined;
          const testWs2 = await createTestWebSocketServer((socket) => {
            activeSocket2 = socket;
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
          });

          const msgLimitPromise = executeTransportObservationProbe({
            isLive: true,
            outDir: testOutputDir,
            wsUrl: `ws://127.0.0.1:${testWs2.port}`,
            transportType: "ws",
            transportOnly: true,
            maxMessages: 3,
            durationMs: 400,
            streamingDurationMs: 300,
            fetchTransport: mockFetch,
          });

          setTimeout(() => {
            for (let i = 0; i < 4; i++) {
              activeSocket2?.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "logsNotification",
                  params: {
                    subscription: 1,
                    result: {
                      context: { slot: 200 + i },
                      value: {
                        signature: SIG_B,
                        logs: [],
                        err: null,
                      },
                    },
                  },
                }),
              );
            }
          }, 20);

          const msgLimitRes = await msgLimitPromise;
          await testWs2.close();

          if ("manifest" in msgLimitRes) {
            const succ = msgLimitRes as TransportProbeSuccessResult;
            expect(succ.status).toBe("CAP_LIMITED");
            expect(succ.metadata.terminationReason).toBe("MESSAGE_LIMIT_REACHED");
            expect(succ.metadata.counts.inboundMessagesCount).toBeGreaterThanOrEqual(3);
          }
        });
      });
    });

    describe("Bounded Window Reconciliation Diagnostic Mode (--reconcile)", () => {
      it("parses CLI flags and produces valid dry-run plan with bounded request allocation", async () => {
        const parsed = parseTransportProbeArgs(["--reconcile", "--dry-run"]);
        expect(parsed.reconcile).toBe(true);
        expect(parsed.dryRun).toBe(true);

        const parsedWindow = parseTransportProbeArgs(["--reconcile-window"]);
        expect(parsedWindow.reconcile).toBe(true);

        const dryRunRes = (await executeTransportObservationProbe({
          isLive: false,
          reconcile: true,
        })) as TransportProbeDryRunResult;

        expect(dryRunRes.dryRun).toBe(true);
        expect(dryRunRes.status).toBe("DRY_RUN");
        expect(dryRunRes.targetPoolId).toBe(DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId);
        expect(dryRunRes.candidateTokenMint).toBe(
          DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.candidateTokenMint,
        );
        expect(dryRunRes.limits.durationMs).toBe(DEFAULT_RECONCILIATION_PROBE_DURATION_MS);
        expect(dryRunRes.limits.durationMs).toBe(90_000);
        expect(dryRunRes.limits.maxHistoryQueries).toBe(2);
        expect(dryRunRes.limits.reconcile).toBe(true);
        expect(dryRunRes.limits.plannedRequestAllocation).toEqual({
          anchorBootstrap: 1,
          slotAcquisition: 1,
          blockTimeAcquisition: 1,
          historyPagination: 1,
          transactionRetrievals: 3,
          maxTotalHttpAttempts: MAX_TOTAL_HTTP_ATTEMPTS,
          minProviderSpacingMs: 2500,
        });
        expect(dryRunRes.budgetStats.totalRequests).toBe(0);
      });

      it("reconciles cutoff-anchored window with positive trade flow and seals evidence manifest", async () => {
        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const mockTransport = new MockWebSocketTransport();

        const cutoffBlockTimeSec = Math.floor((fakeNow - 5_000) / 1000);
        const cutoffTimestampMs = cutoffBlockTimeSec * 1000;
        const mockCutoff: SourceCutoffEvidence = {
          sourceMethod: "getBlockTime",
          responseField: "result",
          commitment: "confirmed",
          provenance: "ON_CHAIN_BLOCK_TIME",
          slot: 280_000_100,
          cutoffTimestampMs,
          retrievedAtMs: fakeNow - 4_000,
          responsePayload: { jsonrpc: "2.0", id: 1, result: cutoffBlockTimeSec },
          requestContext: { slot: 280_000_100 },
        };

        const mockHistoryFetcher: HistoryPageFetcher = {
          fetchPage: async () => [
            {
              signature: SIG_B,
              slot: 280_000_100,
              blockTime: cutoffBlockTimeSec - 10,
              err: null,
            },
            {
              signature: SIG_ANCHOR,
              slot: 280_000_000,
              blockTime: cutoffBlockTimeSec - 70,
              err: null,
            },
          ],
        };

        const mockFetch: typeof fetch = async (input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);
          if (parsed.method === "getTransaction") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(SIG_B, cutoffBlockTimeSec - 10),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 40,
          observationStartMs: 1_700_000_000_000,
          sourceCutoff: mockCutoff,
          historyPageFetcher: mockHistoryFetcher,
          knownAnchorSignature: SIG_ANCHOR,
          fetchTransport: mockFetch,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.observationSuccess).toBe(true);
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(true);
        expect(succ.reconciliationResult).toBeDefined();
        const recon = succ.reconciliationResult!;

        expect(recon.status).toBe("RECONCILED");
        expect(recon.flowCoverage).toBe("SUFFICIENT");
        expect(recon.flowCounts.recentBuys60s).toBe(1);
        expect(recon.flowCounts.recentSells60s).toBe(0);
        expect(recon.flowCounts.flowRatio).toBe(1);
        expect(recon.isCoverageSufficient).toBe(true);
        expect(recon.underlyingOutcomes.anchorWitnessed).toBe(true);

        // Verify evidence files on disk and inside manifest
        const reconFilePath = path.join(testOutputDir, "reconciliation-result.json");
        expect(fsSync.existsSync(reconFilePath)).toBe(true);
        const reconContent = fsSync.readFileSync(reconFilePath, "utf8");
        const reconParsed = JSON.parse(reconContent);
        expect(reconParsed.status).toBe("RECONCILED");

        const manifestEntry = succ.manifest.files.find(
          (f) => f.filename === "reconciliation-result.json",
        );
        expect(manifestEntry).toBeDefined();
        const diskSha256 = crypto.createHash("sha256").update(reconContent).digest("hex");
        expect(manifestEntry!.sha256).toBe(diskSha256);
      });

      it("handles subscription notifications and duplicate resolution limitation fail-closed to UNRESOLVED_TRANSACTIONS", async () => {
        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const mockTransport = new MockWebSocketTransport();

        const cutoffBlockTimeSec = Math.floor((fakeNow - 5_000) / 1000);
        const cutoffTimestampMs = cutoffBlockTimeSec * 1000;
        const mockCutoff: SourceCutoffEvidence = {
          sourceMethod: "getBlockTime",
          responseField: "result",
          commitment: "confirmed",
          provenance: "ON_CHAIN_BLOCK_TIME",
          slot: 280_000_100,
          cutoffTimestampMs,
          retrievedAtMs: fakeNow - 4_000,
          responsePayload: { jsonrpc: "2.0", id: 1, result: cutoffBlockTimeSec },
          requestContext: { slot: 280_000_100 },
        };

        const mockHistoryFetcher: HistoryPageFetcher = {
          fetchPage: async () => [
            {
              signature: SIG_B,
              slot: 280_000_100,
              blockTime: cutoffBlockTimeSec - 10,
              err: null,
            },
            {
              signature: SIG_ANCHOR,
              slot: 280_000_000,
              blockTime: cutoffBlockTimeSec - 70,
              err: null,
            },
          ],
        };

        const mockFetch: typeof fetch = async (input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);
          if (parsed.method === "getTransaction") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(SIG_B, cutoffBlockTimeSec - 10),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 40,
          observationStartMs: 1_700_000_000_000,
          sourceCutoff: mockCutoff,
          historyPageFetcher: mockHistoryFetcher,
          knownAnchorSignature: SIG_ANCHOR,
          fetchTransport: mockFetch,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
        // Trigger notification for SIG_B during streaming phase
        mockTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: 1,
              result: {
                context: { slot: 280_000_100 },
                value: {
                  signature: SIG_B,
                  logs: [],
                  err: null,
                },
              },
            },
          }),
        );

        const result = await probePromise;

        // Observation execution succeeded and manifest is sealed, but duplicate resolution limitation fails closed
        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.observationSuccess).toBe(true);
        expect(succ.manifestSealed).toBe(true);

        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult).toBeDefined();
        expect(succ.reconciliationResult!.status).toBe("UNRESOLVED_TRANSACTIONS");
        expect(succ.reconciliationResult!.isCoverageSufficient).toBe(false);

        // Evidence file was sealed into manifest despite incomplete reconciliation
        expect(succ.manifest.files.some((f) => f.filename === "reconciliation-result.json")).toBe(
          true,
        );
      });

      it("rejects stale cutoff evidence with STALE_DATA and seals partial manifest", async () => {
        const mockTransport = new MockWebSocketTransport();

        const now = Date.now();
        // 25 seconds in the past -> exceeds 15-second research freshness limit
        const staleBlockTimeSec = Math.floor((now - 25_000) / 1000);
        const staleCutoff: SourceCutoffEvidence = {
          sourceMethod: "getBlockTime",
          responseField: "result",
          commitment: "confirmed",
          provenance: "ON_CHAIN_BLOCK_TIME",
          slot: 280_000_100,
          cutoffTimestampMs: staleBlockTimeSec * 1000,
          retrievedAtMs: now,
          responsePayload: { jsonrpc: "2.0", id: 1, result: staleBlockTimeSec },
          requestContext: { slot: 280_000_100 },
        };

        const mockHistoryFetcher: HistoryPageFetcher = {
          fetchPage: async () => [],
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          reconcile: true,
          durationMs: 300,
          streamingDurationMs: 20,
          observationStartMs: now - 70_000,
          sourceCutoff: staleCutoff,
          historyPageFetcher: mockHistoryFetcher,
          knownAnchorSignature: SIG_ANCHOR,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult?.status).toBe("STALE_DATA");
        expect(succ.reconciliationResult?.isCoverageSufficient).toBe(false);
      });

      it("strictly isolates production flow and preserves frozen virtual wallet invariant", async () => {
        const dryRunRes = (await executeTransportObservationProbe({
          isLive: false,
          reconcile: true,
        })) as TransportProbeDryRunResult;

        expect(dryRunRes.targetPoolId).toBe(DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId);
        expect(dryRunRes.candidateTokenMint).toBe(
          DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.candidateTokenMint,
        );
        expect(dryRunRes.limits.spendingCeiling).toBe("$0.00");

        // Verify production candidate flow provider returns strictly unavailable
        const prodFlowProvider = new UnavailableCandidateFlowProvider();
        const prodFlow = prodFlowProvider.getCandidateFlow(
          {
            poolAddress: DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId,
            tokenMint: DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.candidateTokenMint,
          },
          Date.now(),
        );
        expect(prodFlow.recentBuys60s).toBeNull();
        expect(prodFlow.recentSells60s).toBeNull();
        expect(prodFlow.flowCoverage).toBe("COLLECTION_GAP");
        expect(prodFlow.isCoverageSufficient).toBe(false);

        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const mockTransport = new MockWebSocketTransport();

        const cutoffBlockTimeSec = Math.floor((fakeNow - 5_000) / 1000);
        const cutoffTimestampMs = cutoffBlockTimeSec * 1000;
        const mockCutoff: SourceCutoffEvidence = {
          sourceMethod: "getBlockTime",
          responseField: "result",
          commitment: "confirmed",
          provenance: "ON_CHAIN_BLOCK_TIME",
          slot: 280_000_100,
          cutoffTimestampMs,
          retrievedAtMs: fakeNow - 4_000,
          responsePayload: { jsonrpc: "2.0", id: 1, result: cutoffBlockTimeSec },
          requestContext: { slot: 280_000_100 },
        };

        const mockHistoryFetcher: HistoryPageFetcher = {
          fetchPage: async () => [
            {
              signature: SIG_ANCHOR,
              slot: 280_000_000,
              blockTime: cutoffBlockTimeSec - 70,
              err: null,
            },
          ],
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 40,
          observationStartMs: 1_700_000_000_000,
          sourceCutoff: mockCutoff,
          historyPageFetcher: mockHistoryFetcher,
          knownAnchorSignature: SIG_ANCHOR,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        const succ = result as TransportProbeSuccessResult;
        // Production completeness permanently false
        expect(succ.summary.tradeFlowTelemetry.isProductionCompletenessEstablished).toBe(false);

        // Virtual wallet invariants
        expect(succ.metadata.isProductionCompletenessEstablished).toBe(false);
        expect(succ.metadata.gate11Status).toBe("UNAFFECTED_FAIL_CLOSED");
        expect(succ.metadata.virtualWalletBalanceSol).toBe("7.9259 SOL");
        expect(succ.metadata.spendingCeiling).toBe("$0.00");
      });

      it("handles empty acknowledged stream without anchor fail-closed, closing transport and sealing manifest", async () => {
        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const errorMockFetch: typeof fetch = async () => {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "RPC unavailable" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        const mockTransport = new MockWebSocketTransport();

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: errorMockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        // Injected subscription ACK with 0 transaction notifications
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(mockTransport.isClosed).toBe(true);

        expect(succ.reconciliationResult).toBeDefined();
        const recon = succ.reconciliationResult!;
        expect(recon.status).toBe("MISSING_SOURCE_CUTOFF");
        expect(recon.flowCoverage).toBe("COLLECTION_GAP");
        expect(recon.isCoverageSufficient).toBe(false);
        expect(recon.flowCounts.recentBuys60s).toBeNull();
        expect(recon.flowCounts.recentSells60s).toBeNull();
        expect(succ.summary.reconciliationTelemetry.anchorWitnessed).toBe(false);
        expect(succ.summary.reconciliationTelemetry.anchorSignature).toBeNull();

        // Verify sealed files
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "reconciliation-result.json"))).toBe(
          true,
        );
      });

      it("handles transport failure before first signature, closing transport and sealing partial manifest", async () => {
        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const errorMockFetch: typeof fetch = async () => {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "RPC unavailable" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        };

        const mockTransport = new MockWebSocketTransport();

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: errorMockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 50,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerError(new Error("ECONNRESET: Connection reset by peer"));

        const result = await probePromise;

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.status).toBe("TRANSPORT_ERROR");
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(mockTransport.isClosed).toBe(true);
        expect(succ.reconciliationResult).toBeDefined();
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "reconciliation-result.json"))).toBe(
          true,
        );
      });

      it("handles cutoff acquisition failure without replacing missing source time with wall-clock time", async () => {
        let fakeNow = 1_700_000_070_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 1));
        };

        const mockTransport = new MockWebSocketTransport();

        // fetchTransport fails for getBlockTime
        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = bodyStr ? JSON.parse(bodyStr) : {};
          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result: 280_000_100 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id ?? 1,
              error: { code: -32000, message: "Slot not confirmed" },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
        mockTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: 1,
              result: {
                context: { slot: 280_000_100 },
                value: { signature: SIG_ANCHOR, logs: [], err: null },
              },
            },
          }),
        );

        const result = await probePromise;

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult).toBeDefined();
        expect(succ.reconciliationResult!.status).toBe("MISSING_SOURCE_CUTOFF");
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(succ.reconciliationResult!.isCoverageSufficient).toBe(false);
        expect(succ.summary.cutoffAcquisitionAudit).toBeDefined();
        expect(succ.summary.cutoffAcquisitionAudit?.error).toContain("Slot not confirmed");
      });

      it("timing injection: acquireSourceCutoff records retrievedAtMs after completed body consumption", async () => {
        let fakeNow = 10_000;
        const clock = () => fakeNow;
        const budget = new GlobalResourceBudgetManager();

        const fakeFetch: typeof fetch = async () => {
          const res = {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => {
              fakeNow = 15_000;
              return JSON.stringify({ jsonrpc: "2.0", id: 1, result: 12345 });
            },
          } as unknown as Response;
          return res;
        };

        let capturedAudit: SourceCutoffAuditRecord | null = null;
        const evidence = await acquireSourceCutoff(
          "https://api.mainnet-beta.solana.com",
          100,
          budget,
          undefined,
          fakeFetch,
          clock,
          async () => {},
          (rec) => {
            capturedAudit = rec;
          },
        );

        expect(evidence.retrievedAtMs).toBe(15_000);
        expect(evidence.cutoffTimestampMs).toBe(12345 * 1000);
        expect(capturedAudit).toBeDefined();
        expect(capturedAudit!.requestSentAtMs).toBe(10_000);
        expect(capturedAudit!.headersReceivedAtMs).toBe(10_000);
        expect(capturedAudit!.responseReceivedAtMs).toBe(15_000);
        expect(capturedAudit!.durationMs).toBe(5_000);
        expect(capturedAudit!.httpStatus).toBe(200);
        expect(capturedAudit!.responseSha256).toBeDefined();
        expect(capturedAudit!.error).toBeUndefined();
      });

      it("exercises genuine CLI acquisition path without prebuilt overrides", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };
        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: 280_000_000,
                      blockTime: baseEpochSec,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_B,
                    slot: 280_000_100,
                    blockTime: fixedCutoffSec - 10,
                    err: null,
                  },
                  { signature: SIG_ANCHOR, slot: 280_000_000, blockTime: baseEpochSec, err: null },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getTransaction") {
            const reqSig = parsed.params?.[0] ?? SIG_B;
            const reqSlot = reqSig === SIG_ANCHOR ? 280_000_000 : 280_000_100;
            const reqBlockTime = reqSig === SIG_ANCHOR ? baseEpochSec : fixedCutoffSec - 10;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(reqSig, reqBlockTime, reqSlot),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(true);
        expect(succ.reconciliationResult).toBeDefined();
        const recon = succ.reconciliationResult!;
        expect(recon.status).toBe("RECONCILED");
        expect(recon.flowCoverage).toBe("SUFFICIENT");
        expect(recon.flowCounts.recentBuys60s).toBe(1);
        expect(recon.flowCounts.recentSells60s).toBe(0);
        expect(succ.summary.cutoffAcquisitionAudit).toBeDefined();
        expect(succ.summary.cutoffAcquisitionAudit?.httpStatus).toBe(200);
      });

      it("fails closed with UNWITNESSED_PRIOR_ANCHOR when earliest stream signature is inside window", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };
        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              // Bootstrap query at T_0: returns empty to force stream anchor fallback
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: [] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_ANCHOR,
                    slot: 280_000_100,
                    blockTime: fixedCutoffSec - 10,
                    err: null,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getTransaction") {
            const reqSig = parsed.params?.[0] ?? SIG_ANCHOR;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(reqSig, fixedCutoffSec - 10, 280_000_100),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
        mockTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: 1,
              result: {
                context: { slot: 280_000_100 },
                value: { signature: SIG_ANCHOR, logs: [], err: null },
              },
            },
          }),
        );

        const result = await probePromise;

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult).toBeDefined();
        expect(succ.reconciliationResult!.status).toBe("UNWITNESSED_PRIOR_ANCHOR");
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(succ.reconciliationResult!.isCoverageSufficient).toBe(false);
      });

      it("reconciles silent WebSocket stream with independently acquired RPC evidence", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };

        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              // Bootstrap query at T_0: returns prior anchor older than window
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: 280_000_000,
                      blockTime: baseEpochSec,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Enumeration query post-streaming: returns window trade and witnesses anchor
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_B,
                    slot: 280_000_100,
                    blockTime: fixedCutoffSec - 10,
                    err: null,
                  },
                  { signature: SIG_ANCHOR, slot: 280_000_000, blockTime: baseEpochSec, err: null },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getTransaction") {
            const reqSig = parsed.params?.[0] ?? SIG_B;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(reqSig, fixedCutoffSec - 10, 280_000_100),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        // Acknowledged stream with ZERO transaction notifications
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(true);
        expect(succ.reconciliationResult).toBeDefined();
        const recon = succ.reconciliationResult!;
        expect(recon.status).toBe("RECONCILED");
        expect(recon.flowCoverage).toBe("SUFFICIENT");
        expect(recon.flowCounts.recentBuys60s).toBe(1);
        expect(recon.flowCounts.recentSells60s).toBe(0);
        expect(succ.summary.slotAcquisitionAudit).toBeDefined();
        expect(succ.summary.slotAcquisitionAudit?.acquiredSlot).toBe(280_000_100);
        expect(succ.summary.cutoffAcquisitionAudit).toBeDefined();
        expect(succ.summary.cutoffAcquisitionAudit?.httpStatus).toBe(200);
        expect(succ.summary.reconciliationTelemetry.anchorWitnessed).toBe(true);
        expect(succ.summary.reconciliationTelemetry.anchorSignature).toBe(SIG_ANCHOR);
        // Shared 7-request ceiling: 1 bootstrap + 1 slot + 1 cutoff + 1 enum + 1 tx = 5
        expect(succ.summary.budgetAccounting.totalHttpRequests).toBe(5);
        expect(succ.summary.budgetAccounting.totalHttpRequests).toBeLessThanOrEqual(7);
      });

      it("fails closed to UNWITNESSED_PRIOR_ANCHOR when bootstrap evidence is empty", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };

        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        // Bootstrap returns empty array
        const mockFetchEmpty: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getSignaturesForAddress") {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetchEmpty,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(succ.summary.reconciliationTelemetry.anchorWitnessed).toBe(false);
        expect(succ.summary.reconciliationTelemetry.anchorSignature).toBeNull();
      });

      it("fails closed when final bounded history page does not witness bootstrap anchor", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };

        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: 280_000_000,
                      blockTime: baseEpochSec,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Enumeration returns a page of transactions that DO NOT contain SIG_ANCHOR (maxPages: 1 exhausted)
            const otherSignatures = Array.from({ length: 5 }, (_, i) => ({
              signature: `3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz${String(i).padStart(2, "1")}B`,
              slot: 280_000_100,
              blockTime: fixedCutoffSec - 5,
              err: null,
            }));
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: otherSignatures }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(succ.summary.reconciliationTelemetry.anchorWitnessed).toBe(false);
      });

      it("fails closed to MISSING_SOURCE_CUTOFF when getBlockTime returns null", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 0));
        };

        const baseEpochSec = Math.floor(fakeNow / 1000);

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getBlockTime") {
            // Null block time
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: null }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (parsed.method === "getSignaturesForAddress") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  { signature: SIG_ANCHOR, slot: 280_000_000, blockTime: baseEpochSec, err: null },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const result = await executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          clock,
          sleepFn,
        });

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult!.status).toBe("MISSING_SOURCE_CUTOFF");
      });

      it("enforces shared transaction allowance across streaming and reconciliation", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();

        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const SIG_STREAM_1 = encodeBase58(Buffer.alloc(64, 1));
        const SIG_STREAM_2 = encodeBase58(Buffer.alloc(64, 2));
        const SIG_HIST_1 = encodeBase58(Buffer.alloc(64, 3));
        const SIG_HIST_2 = encodeBase58(Buffer.alloc(64, 4));

        let stream1Sent = false;
        let stream2Sent = false;

        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            if (fakeNow >= (baseEpochSec + 45) * 1000 && !stream1Sent) {
              stream1Sent = true;
              mockTransport.triggerMessage(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "logsNotification",
                  params: {
                    subscription: 1,
                    result: {
                      context: { slot: 280_000_050 },
                      value: { signature: SIG_STREAM_1, logs: [], err: null },
                    },
                  },
                }),
              );
            }
            if (fakeNow >= (baseEpochSec + 50) * 1000 && !stream2Sent) {
              stream2Sent = true;
              mockTransport.triggerMessage(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "logsNotification",
                  params: {
                    subscription: 1,
                    result: {
                      context: { slot: 280_000_050 },
                      value: { signature: SIG_STREAM_2, logs: [], err: null },
                    },
                  },
                }),
              );
            }
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: "UnrelatedSig1111111111111111111111111111111111",
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };

        let txRetrievalCount = 0;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: 280_000_000,
                      blockTime: baseEpochSec,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Discovers 2 new un-ingested window transactions + the 2 already ingested from stream + anchor
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_HIST_1,
                    slot: 280_000_100,
                    blockTime: baseEpochSec + 60,
                    err: null,
                  },
                  {
                    signature: SIG_HIST_2,
                    slot: 280_000_100,
                    blockTime: baseEpochSec + 57,
                    err: null,
                  },
                  {
                    signature: SIG_STREAM_1,
                    slot: 280_000_050,
                    blockTime: baseEpochSec + 45,
                    err: null,
                  },
                  {
                    signature: SIG_STREAM_2,
                    slot: 280_000_050,
                    blockTime: baseEpochSec + 50,
                    err: null,
                  },
                  { signature: SIG_ANCHOR, slot: 280_000_000, blockTime: baseEpochSec, err: null },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (parsed.method === "getTransaction") {
            txRetrievalCount++;
            const reqSig = parsed.params?.[0] ?? "unknown";
            let txTime = fixedCutoffSec - 10;
            if (reqSig === SIG_HIST_1) txTime = baseEpochSec + 60;
            else if (reqSig === SIG_HIST_2) txTime = baseEpochSec + 57;
            else if (reqSig === SIG_STREAM_1) txTime = baseEpochSec + 45;
            else if (reqSig === SIG_STREAM_2) txTime = baseEpochSec + 50;
            const reqSlot =
              reqSig === SIG_STREAM_1 || reqSig === SIG_STREAM_2 ? 280_000_050 : 280_000_100;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(reqSig, txTime, reqSlot),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          maxTransactionRetrievals: 3, // Total shared ceiling = 3
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        // Total getTransaction calls must NOT exceed 3
        expect(txRetrievalCount).toBeLessThanOrEqual(3);
        // Because 2 stream transactions consumed allowance, only 1 was left for bridge.
        // HistSig2 could not be processed, so reconciliation fails closed to UNRESOLVED_TRANSACTIONS
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult!.status).toBe("UNRESOLVED_TRANSACTIONS");
        expect(succ.reconciliationResult!.isCoverageSufficient).toBe(false);
      });

      it("preserves independent acquisition and binds bootstrap anchor when streaming exhausts transaction cap", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 0));
        };

        const mockTransport = new MockWebSocketTransport();
        const baseEpochSec = Math.floor(fakeNow / 1000);
        const BOOTSTRAP_SLOT = 466_788_444;
        const STREAM_SLOT = 466_789_012;
        const CONFIRMED_RPC_SLOT = 466_789_500;
        const CUTOFF_SEC = baseEpochSec + 40;

        let totalHttpRequests = 0;
        let bootstrapQueriesCount = 0;
        let getSlotCount = 0;
        let getBlockTimeCount = 0;
        let historyEnumCount = 0;
        let txRetrievalCount = 0;

        const SIG_S1 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ11";
        const SIG_S2 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ12";
        const SIG_S3 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ13";
        const SIG_S4 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ14";
        const SIG_S5 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ15";
        const SIG_S6 =
          "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQ16";

        const mockFetch: typeof fetch = async (_input, init) => {
          totalHttpRequests++;
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              bootstrapQueriesCount++;
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: BOOTSTRAP_SLOT,
                      blockTime: baseEpochSec - 100,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Final bounded history enumeration query
            historyEnumCount++;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_S1,
                    slot: STREAM_SLOT,
                    blockTime: baseEpochSec + 10,
                    err: null,
                  },
                  {
                    signature: SIG_ANCHOR,
                    slot: BOOTSTRAP_SLOT,
                    blockTime: baseEpochSec - 100,
                    err: null,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSlot") {
            getSlotCount++;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: CONFIRMED_RPC_SLOT,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            getBlockTimeCount++;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: CUTOFF_SEC,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getTransaction") {
            txRetrievalCount++;
            const reqSig = parsed.params?.[0] ?? "unknown";
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: createSyntheticBuyPayload(reqSig, baseEpochSec + 10, STREAM_SLOT),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          maxTransactionRetrievals: 3, // Global 3 transaction cap
          durationMs: 90_000,
          streamingDurationMs: 50_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        // Emit a burst of 6 stream notifications (identical to operator capture)
        const burstSigs = [SIG_S1, SIG_S2, SIG_S3, SIG_S4, SIG_S5, SIG_S6];
        for (const sig of burstSigs) {
          mockTransport.triggerMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                subscription: 1,
                result: {
                  context: { slot: STREAM_SLOT },
                  value: { signature: sig, logs: [], err: null },
                },
              },
            }),
          );
        }

        const result = await probePromise;
        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;

        // 1. Evidence manifest must be sealed with all files
        expect(succ.manifestSealed).toBe(true);

        // 2. Transaction attempts must strictly equal 3 (no overshoot from 0 remaining allowance)
        expect(txRetrievalCount).toBe(3);
        expect(succ.metadata.counts.transactionRetrievalsAttempted).toBe(3);

        // 3. Independent acquisition path must execute: 1 bootstrap, 1 getSlot, 1 getBlockTime, 1 history enum
        expect(bootstrapQueriesCount).toBe(1);
        expect(getSlotCount).toBe(1);
        expect(getBlockTimeCount).toBe(1);
        expect(historyEnumCount).toBe(1);
        expect(totalHttpRequests).toBe(7); // <= 7 global ceiling

        // 4. Anchor telemetry must bind strictly to the T0 bootstrap record, NOT first stream notification slot
        expect(succ.summary.reconciliationTelemetry.anchorWitnessed).toBe(true);
        expect(succ.summary.reconciliationTelemetry.anchorSignature).toBe(SIG_ANCHOR);
        expect(succ.summary.reconciliationTelemetry.anchorSlot).toBe(BOOTSTRAP_SLOT);
        expect(succ.summary.reconciliationTelemetry.anchorBlockTime).toBe(baseEpochSec - 100);

        // 5. Status must be CAP_LIMITED due to transaction limit reached during streaming
        expect(succ.status).toBe("CAP_LIMITED");
        expect(succ.metadata.terminationReason).toBe("TRANSACTION_LIMIT_REACHED");
        expect(succ.metadata.isCapTerminated).toBe(true);

        // 6. Fail-closed: pending un-retrieved notifications keep coverage insufficient and counts null
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult!.isCoverageSufficient).toBe(false);
        expect(succ.reconciliationResult!.flowCounts.recentBuys60s).toBeNull();
        expect(succ.reconciliationResult!.flowCounts.recentSells60s).toBeNull();

        // 7. Reporting fields: outcome is ANCHOR_WITNESSED (not NOT_ATTEMPTED) and counts are distinguished
        expect(succ.summary.reconciliationTelemetry.enumeratorOutcome).toBe("ANCHOR_WITNESSED");
        expect(succ.summary.reconciliationTelemetry.rawHistoryRecordsReturned).toBe(3);
        expect(succ.summary.reconciliationTelemetry.bootstrapHistoryRecordsReturned).toBe(1);
        expect(succ.summary.reconciliationTelemetry.finalPageHistoryRecordsReturned).toBe(2);
        expect(succ.summary.reconciliationTelemetry.uniqueHistorySignaturesWitnessed).toBe(2);
        expect(succ.summary.reconciliationTelemetry.signaturesSinceAnchor).toBe(1);
        expect(succ.summary.reconciliationTelemetry.signaturesInWindow).toBeNull();
        expect(succ.metadata.counts.signaturesInWindow).toBeNull();
        expect(succ.summary.reconciliationTelemetry.wholeProbeHttpRequests).toBe(7);
        expect(succ.summary.reconciliationTelemetry.reconciliationReceiptHttpRequests).toBeNull();
      });

      it("distinguishes raw RPC history, signatures since anchor, and signatures in window on quiet stream", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 0));
        };

        const mockTransport = new MockWebSocketTransport();
        const baseEpochSec = Math.floor(fakeNow / 1000);
        const BOOTSTRAP_SLOT = 466_792_838;
        const CONFIRMED_RPC_SLOT = 466_795_911;
        const CUTOFF_SEC = baseEpochSec + 60;
        const ANCHOR_SEC = baseEpochSec - 500;

        let totalHttpRequests = 0;
        const mockFetch: typeof fetch = async (_input, init) => {
          totalHttpRequests++;
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: BOOTSTRAP_SLOT,
                      blockTime: ANCHOR_SEC,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Return 20 records starting with SIG_ANCHOR (anchor is record 0)
            const records = [
              { signature: SIG_ANCHOR, slot: BOOTSTRAP_SLOT, blockTime: ANCHOR_SEC, err: null },
            ];
            for (let i = 1; i < 20; i++) {
              records.push({
                signature: encodeBase58(Buffer.alloc(64, i + 10)),
                slot: BOOTSTRAP_SLOT - i * 10,
                blockTime: ANCHOR_SEC - i * 10,
                err: null,
              });
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: records,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: CONFIRMED_RPC_SLOT,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: CUTOFF_SEC,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const succ = result as TransportProbeSuccessResult;

        // Verify correct reporting:
        // 1. Enumerator outcome must be ANCHOR_WITNESSED (not NOT_ATTEMPTED)
        expect(succ.summary.reconciliationTelemetry.enumeratorOutcome).toBe("ANCHOR_WITNESSED");
        expect(succ.summary.historyDiscoveryTelemetry.discoveryOutcome).toBe("ANCHOR_WITNESSED");

        // 2. Whole-probe vs reconciliation requests must be separated
        expect(totalHttpRequests).toBe(4);
        expect(succ.summary.budgetAccounting.totalHttpRequests).toBe(4);
        expect(succ.summary.reconciliationTelemetry.wholeProbeHttpRequests).toBe(4);
        expect(succ.summary.reconciliationTelemetry.reconciliationReceiptHttpRequests).toBe(1);
        expect(succ.reconciliationResult!.resourceMetrics.actualRequestsDispatched).toBe(1);

        // 3. Raw RPC history (21) vs bootstrap (1) vs final page (20) vs unique witnessed (20) vs records since anchor (0) vs unevaluated window (null)
        expect(succ.summary.reconciliationTelemetry.rawHistoryRecordsReturned).toBe(21);
        expect(succ.summary.reconciliationTelemetry.bootstrapHistoryRecordsReturned).toBe(1);
        expect(succ.summary.reconciliationTelemetry.finalPageHistoryRecordsReturned).toBe(20);
        expect(succ.summary.reconciliationTelemetry.uniqueHistorySignaturesWitnessed).toBe(20);
        expect(succ.summary.reconciliationTelemetry.signaturesSinceAnchor).toBe(0);
        expect(succ.summary.reconciliationTelemetry.signaturesInWindow).toBeNull();
        expect(succ.metadata.counts.signaturesInWindow).toBeNull();
        expect(succ.summary.reconciliationTelemetry.historyRecordsDiscovered).toBe(0);
        expect(succ.reconciliationResult!.underlyingOutcomes.totalDiscoveredSignatures).toBe(0);
        expect(succ.reconciliationResult!.underlyingOutcomes.windowSignaturesCount).toBe(0);

        // 4. Counts preserved as unavailable rather than invented
        expect(succ.reconciliationResult!.flowCounts.recentBuys60s).toBeNull();
        expect(succ.reconciliationResult!.flowCounts.recentSells60s).toBeNull();
        expect(succ.reconciliationResult!.flowCounts.flowRatio).toBeNull();
        expect(succ.reconciliationResult!.status).toBe("STREAM_GAP");
        expect(succ.reconciliationResult!.flowCoverage).toBe("COLLECTION_GAP");
        expect(succ.reconciliationResult!.diagnosticReason).toContain(
          "STREAM_INACTIVITY_AT_EVALUATION",
        );
      });

      it("reports established numeric zero counts and RECONCILED status on verified quiet window", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const VALID_UNRELATED_SIG = encodeBase58(Buffer.alloc(64, 77));
        const sleepFn = async (ms: number) => {
          const step = 2_000;
          let remaining = ms;
          while (remaining > 0) {
            const chunk = Math.min(remaining, step);
            fakeNow += chunk;
            remaining -= chunk;
            mockTransport.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "logsNotification",
                params: {
                  subscription: 999999,
                  result: {
                    context: { slot: 280_000_100 },
                    value: {
                      signature: VALID_UNRELATED_SIG,
                      logs: [],
                      err: null,
                    },
                  },
                },
              }),
            );
            await new Promise((r) => setTimeout(r, 0));
          }
        };

        const baseEpochSec = Math.floor(fakeNow / 1000);
        const fixedCutoffSec = baseEpochSec + 65;

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSlot") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 280_000_100 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getBlockTime") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: fixedCutoffSec }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (parsed.method === "getSignaturesForAddress") {
            if (parsed.params?.[1]?.limit === 1) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: [
                    {
                      signature: SIG_ANCHOR,
                      slot: 280_000_000,
                      blockTime: baseEpochSec,
                      err: null,
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
            // Return 20 records where all records predate window start (baseEpochSec + 5s)
            const records = [
              { signature: SIG_ANCHOR, slot: 280_000_000, blockTime: baseEpochSec, err: null },
            ];
            for (let i = 1; i < 20; i++) {
              records.push({
                signature: encodeBase58(Buffer.alloc(64, i + 10)),
                slot: 280_000_000 - i * 10,
                blockTime: baseEpochSec - i * 10,
                err: null,
              });
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: records,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 90_000,
          streamingDurationMs: 65_000,
          clock,
          sleepFn,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const succ = result as TransportProbeSuccessResult;

        expect(succ.manifestSealed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(true);
        expect(succ.reconciliationResult).toBeDefined();

        const recon = succ.reconciliationResult!;
        expect(recon.status).toBe("RECONCILED");
        expect(recon.flowCoverage).toBe("SUFFICIENT");
        expect(recon.flowCounts.recentBuys60s).toBe(0);
        expect(recon.flowCounts.recentSells60s).toBe(0);
        expect(recon.flowCounts.flowRatio).toBe(1.0);

        // Established zeros verified across summary and metadata
        expect(succ.summary.reconciliationTelemetry.rawHistoryRecordsReturned).toBe(21);
        expect(succ.summary.reconciliationTelemetry.bootstrapHistoryRecordsReturned).toBe(1);
        expect(succ.summary.reconciliationTelemetry.finalPageHistoryRecordsReturned).toBe(20);
        expect(succ.summary.reconciliationTelemetry.uniqueHistorySignaturesWitnessed).toBe(20);
        expect(succ.summary.reconciliationTelemetry.signaturesSinceAnchor).toBe(0);
        expect(succ.summary.reconciliationTelemetry.signaturesInWindow).toBe(0);
        expect(succ.metadata.counts.signaturesInWindow).toBe(0);
        expect(succ.summary.reconciliationTelemetry.reconciliationReceiptHttpRequests).toBe(1);
      });

      it("aborts in-flight independent RPC work promptly on signal and cleanly seals partial evidence", async () => {
        let fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;
        const mockTransport = new MockWebSocketTransport();
        const sleepFn = async (ms: number) => {
          fakeNow += ms;
          await new Promise((r) => setTimeout(r, 0));
        };

        const abortCtrl = new AbortController();

        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);

          if (parsed.method === "getSignaturesForAddress") {
            // Trigger abort while bootstrap query is in-flight
            abortCtrl.abort(new Error("Caller cancellation during bootstrap"));
            // Simulate aborted fetch
            const abortErr = new Error("This operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const result = await executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          signal: abortCtrl.signal,
          reconcile: true,
          durationMs: 90_000,
          clock,
          sleepFn,
        });

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.status).toBe("TRANSPORT_ERROR");
        expect(succ.metadata.terminationReason).toBe("MANUAL_CANCEL");
        expect(mockTransport.isClosed).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
      });

      it("cancels hanging bootstrap headers automatically at overall deadline without caller abort", async () => {
        const mockTransport = new MockWebSocketTransport();
        const fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;

        // Bootstrap query hangs indefinitely on headers until aborted
        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);
          if (parsed.method === "getSignaturesForAddress" && parsed.params?.[1]?.limit === 1) {
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  const err = new Error("Operation aborted");
                  err.name = "AbortError";
                  reject(err);
                },
                { once: true },
              );
            });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const testStartTime = Date.now();
        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 80,
          clock,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const elapsedRealMs = Date.now() - testStartTime;

        expect(elapsedRealMs).toBeGreaterThanOrEqual(65);
        expect(elapsedRealMs).toBeLessThan(350);

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.metadata.terminationReason).toBe("DURATION_EXPIRED");
        expect(mockTransport.isClosed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult?.status).toBe("MISSING_SOURCE_CUTOFF");
        expect(succ.reconciliationResult?.sourceCutoff).toBeNull();
        expect(succ.reconciliationResult?.resourceMetrics.actualRequestsDispatched).toBeNull();
        expect(succ.summary.reconciliationTelemetry.reconciliationReceiptHttpRequests).toBeNull();
        expect(succ.summary.reconciliationTelemetry.signaturesInWindow).toBeNull();
        expect(succ.metadata.counts.signaturesInWindow).toBeNull();
        expect(succ.summary.reconciliationTelemetry.rawHistoryRecordsReturned).toBeNull();
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "reconciliation-result.json"))).toBe(
          true,
        );
      });

      it("cancels hanging bootstrap response body automatically at overall deadline without caller abort", async () => {
        const mockTransport = new MockWebSocketTransport();
        const fakeNow = 1_700_000_000_000;
        const clock = () => fakeNow;

        // Headers return immediately, but response body ReadableStream stalls indefinitely
        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);
          if (parsed.method === "getSignaturesForAddress" && parsed.params?.[1]?.limit === 1) {
            const hangingStream = new ReadableStream<Uint8Array>({
              start() {
                // Never enqueues any chunks or closes
              },
            });
            return new Response(hangingStream, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const testStartTime = Date.now();
        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 80,
          clock,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const elapsedRealMs = Date.now() - testStartTime;

        expect(elapsedRealMs).toBeGreaterThanOrEqual(65);
        expect(elapsedRealMs).toBeLessThan(350);

        expect(result.dryRun).toBe(false);
        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.metadata.terminationReason).toBe("DURATION_EXPIRED");
        expect(mockTransport.isClosed).toBe(true);
        expect(succ.reconciliationSuccess).toBe(false);
        expect(succ.reconciliationResult?.status).toBe("MISSING_SOURCE_CUTOFF");
        expect(succ.reconciliationResult?.sourceCutoff).toBeNull();
        expect(succ.reconciliationResult?.resourceMetrics.actualRequestsDispatched).toBeNull();
        expect(succ.summary.reconciliationTelemetry.reconciliationReceiptHttpRequests).toBeNull();
        expect(succ.summary.reconciliationTelemetry.signaturesInWindow).toBeNull();
        expect(succ.metadata.counts.signaturesInWindow).toBeNull();
        expect(succ.summary.reconciliationTelemetry.rawHistoryRecordsReturned).toBeNull();
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "reconciliation-result.json"))).toBe(
          true,
        );
      });

      it("enforces absolute deadline when slow successful bootstrap consumes existing overall allowance", async () => {
        const mockTransport = new MockWebSocketTransport();
        const startEpoch = 1_700_000_000_000;
        let fakeNow = startEpoch;
        const clock = () => fakeNow;
        const baseEpochSec = Math.floor(startEpoch / 1000);

        // Bootstrap takes 50ms of a 70ms overall duration, then returns valid anchor
        const mockFetch: typeof fetch = async (_input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr);
          if (parsed.method === "getSignaturesForAddress" && parsed.params?.[1]?.limit === 1) {
            await new Promise((r) => setTimeout(r, 50));
            fakeNow += 50;
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: [
                  {
                    signature: SIG_ANCHOR,
                    slot: 280_000_000,
                    blockTime: baseEpochSec - 100,
                    err: null,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
        };

        const testStartTime = Date.now();
        const probePromise = executeTransportObservationProbe({
          isLive: true,
          outDir: testOutputDir,
          transport: mockTransport,
          fetchTransport: mockFetch,
          reconcile: true,
          durationMs: 70, // Total 70ms duration
          clock,
        });

        mockTransport.triggerOpen();
        mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

        const result = await probePromise;
        const elapsedRealMs = Date.now() - testStartTime;

        // Total elapsed time must be bounded by original duration (~70-130ms, NOT restarted to 140ms+)
        expect(elapsedRealMs).toBeGreaterThanOrEqual(55);
        expect(elapsedRealMs).toBeLessThan(250);

        const succ = result as TransportProbeSuccessResult;
        expect(succ.manifestSealed).toBe(true);
        expect(succ.metadata.terminationReason).toBe("DURATION_EXPIRED");
        expect(mockTransport.isClosed).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-manifest.json"))).toBe(true);
      });
    });
  });
});
