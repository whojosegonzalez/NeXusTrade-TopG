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
  DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
  MAX_TOTAL_HTTP_ATTEMPTS,
  resolveProjectRoot,
  type TransportProbeSuccessResult,
} from "./RaydiumTransportObservationProbe.js";
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
        expect(succ.manifest.files.length).toBe(3); // probe-summary, capture-metadata, witnessed-signatures
      }
    });
  });
});
