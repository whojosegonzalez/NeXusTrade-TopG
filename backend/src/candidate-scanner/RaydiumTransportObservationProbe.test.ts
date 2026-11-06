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
import {
  executeTransportObservationProbe,
  parseTransportProbeArgs,
  createBoundedFetchTransport,
  readBoundedStream,
  boundedCancel,
  DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
  MAX_TOTAL_HTTP_ATTEMPTS,
  resolveProjectRoot,
  type TransportProbeSuccessResult,
} from "./RaydiumTransportObservationProbe.js";
import { decodeRaydiumTransactionSwaps } from "./RaydiumAmmV4SwapDecoder.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import type { HistoryPageFetcher, HistorySignatureRecord } from "./ExactPoolHistoryEnumerator.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";

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
    for (const listener of this.listeners.close) {
      listener(this.closeCode, this.closeReason);
    }
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

function createSyntheticBuyPayload(signature: string, blockTime = Math.floor(Date.now() / 1000)) {
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
    slot: 280_000_100,
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

      const mockFetch: typeof fetch = async () => {
        dispatchesCount++;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: createSyntheticBuyPayload(SIG_C),
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
  });
});
