/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium Transport Observation Probe Test Suite
 *
 * Verifies the standalone transport observation probe:
 * - Dry-run plan validation and parameter rejection bounds
 * - Runtime duration bound (max 5 minutes)
 * - Message budget ceiling (max 500 messages)
 * - Application payload byte ceiling (max 2 MiB) with overshoot disclosure
 * - Queue depth tracking (max 10 queued/in-flight)
 * - HTTP request ceilings (at most 2 history queries, 5 transaction retrievals, 7 total)
 * - Shared budget manager pacing (>= 2,500 ms) and forward reservation preservation
 * - Witness discrepancy calculation and comparison limit disclosures
 * - Strict preservation of production completeness = false, Gate 11 fail-closed, and 7.9259 SOL wallet
 * - Cryptographic manifest sealing and evidence integrity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  executeTransportObservationProbe,
  parseTransportProbeArgs,
  DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT,
  MAX_TOTAL_HTTP_ATTEMPTS,
} from "./RaydiumTransportObservationProbe.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import type { HistoryPageFetcher, HistorySignatureRecord } from "./ExactPoolHistoryEnumerator.js";

// Canonical Base58 Ed25519 64-byte signatures
const SIG_ANCHOR =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc";
const SIG_B =
  "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3vB";
const SIG_C =
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6C";
const SIG_D =
  "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2";

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

describe("RaydiumTransportObservationProbe", () => {
  const testOutputDir = path.join(
    process.cwd(),
    "data",
    "research",
    "captures",
    "transport-probe",
    "unit-test-probe",
  );

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
  // 1. Dry-Run Plan Validation
  // ==========================================================================
  describe("Dry-Run Plan Validation", () => {
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
        expect(result.limits.maxTotalHttpAttempts).toBe(7);
        expect(result.limits.minProviderSpacingMs).toBe(2500);
        expect(result.limits.spendingCeiling).toBe("$0.00");
        expect(result.message).toMatch(/Zero network requests/);
      }

      // Verify no directory was created on dry run
      expect(fsSync.existsSync(testOutputDir)).toBe(false);
    });

    it("rejects invalid input options fail-closed", async () => {
      // 1. Exceeds max allowed duration (5 minutes)
      const res1 = await executeTransportObservationProbe({
        durationMs: 300_001,
      });
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.status).toBe("INVALID_INPUT");
        expect(res1.message).toMatch(/Invalid durationMs/);
      }

      // 2. Exceeds max allowed messages (500)
      const res2 = await executeTransportObservationProbe({
        maxMessages: 501,
      });
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.status).toBe("INVALID_INPUT");
        expect(res2.message).toMatch(/Invalid maxMessages/);
      }

      // 3. Exceeds max allowed payload bytes (2 MiB)
      const res3 = await executeTransportObservationProbe({
        maxPayloadBytes: 2 * 1024 * 1024 + 1,
      });
      expect(res3.success).toBe(false);
      if (!res3.success) {
        expect(res3.status).toBe("INVALID_INPUT");
        expect(res3.message).toMatch(/Invalid maxPayloadBytes/);
      }

      // 4. Invalid pool context
      const res4 = await executeTransportObservationProbe({
        poolContext: { ...DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT, poolId: "invalid-base58" },
      });
      expect(res4.success).toBe(false);
      if (!res4.success) {
        expect(res4.status).toBe("INVALID_INPUT");
        expect(res4.message).toMatch(/Invalid poolContext/);
      }
    });

    it("parses CLI arguments correctly", () => {
      const args1 = parseTransportProbeArgs(["--dry-run", "--max-messages", "100"]);
      expect(args1.dryRun).toBe(true);
      expect(args1.isLive).toBe(false);
      expect(args1.maxMessages).toBe(100);

      const args2 = parseTransportProbeArgs(["--live", "--duration-ms", "60000"]);
      expect(args2.isLive).toBe(true);
      expect(args2.dryRun).toBe(false);
      expect(args2.durationMs).toBe(60000);

      expect(() => parseTransportProbeArgs(["--unrecognized"])).toThrow(/Unrecognized argument/);
      expect(() => parseTransportProbeArgs(["--duration-ms", "not-a-number"])).toThrow(
        /must be a positive integer/,
      );
    });
  });

  // ==========================================================================
  // 2. Message Count and Payload Byte Ceilings
  // ==========================================================================
  describe("Streaming Limits and Overshoot Disclosure", () => {
    it("terminates immediately when message count reaches ceiling and closes socket", async () => {
      const mockTransport = new MockWebSocketTransport();
      const now = 1_000_000;
      const clock = () => now;

      // Start probe with maxMessages = 3
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxMessages: 3,
        transport: mockTransport,
        clock,
      });

      // Socket opens
      mockTransport.triggerOpen();

      // Send 3 subscription messages
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_ANCHOR,
                slot: 100,
                err: null,
                logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
              },
            },
            subscription: 1,
          },
        }),
      );

      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_B,
                slot: 101,
                err: null,
                logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
              },
            },
            subscription: 1,
          },
        }),
      );

      // 3rd message reaches ceiling
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_C,
                slot: 102,
                err: null,
                logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
              },
            },
            subscription: 1,
          },
        }),
      );

      // Verify socket close was triggered
      expect(mockTransport.isClosed).toBe(true);

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        expect(result.metadata.terminationReason).toBe("MESSAGE_LIMIT_REACHED");
        expect(result.metadata.isCapTerminated).toBe(true);
        expect(result.metadata.counts.inboundMessagesCount).toBe(3);
      }
    });

    it("terminates when payload bytes exceed threshold and discloses overshoot bytes", async () => {
      const mockTransport = new MockWebSocketTransport();
      const clock = () => 1_000_000;

      // Small 100-byte payload limit
      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxPayloadBytes: 100,
        transport: mockTransport,
        clock,
      });

      mockTransport.triggerOpen();

      // Send a 120-byte payload (overshoot = 20 bytes)
      const payload120 = JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: { result: { value: { signature: SIG_ANCHOR, slot: 100, err: null, logs: [] } } },
      });
      const byteLen = Buffer.byteLength(payload120, "utf8");
      expect(byteLen).toBeGreaterThan(100);

      mockTransport.triggerMessage(payload120);

      expect(mockTransport.isClosed).toBe(true);

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        expect(result.metadata.terminationReason).toBe("PAYLOAD_LIMIT_REACHED");
        expect(result.metadata.counts.overshootBytes).toBe(byteLen - 100);
        expect(result.summary.streamingTelemetry.overshootBytes).toBe(byteLen - 100);
      }
    });
  });

  // ==========================================================================
  // 3. HTTP Budget Ceilings & Pacing
  // ==========================================================================
  describe("HTTP Budget and Pacing Bounds", () => {
    it("enforces maximum 2 history queries and caps total HTTP requests to 7", async () => {
      const mockTransport = new MockWebSocketTransport();
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
        maxMessages: 1,
        maxHistoryQueries: 2,
        transport: mockTransport,
        historyPageFetcher: mockHistoryFetcher,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_ANCHOR,
                slot: 100,
                err: null,
                logs: [],
              },
            },
            subscription: 1,
          },
        }),
      );

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        expect(historyCalls).toBeLessThanOrEqual(2);
        expect(result.metadata.counts.historyQueriesAttempted).toBeLessThanOrEqual(2);
        expect(result.metadata.budgetStatus.totalRequests).toBeLessThanOrEqual(
          MAX_TOTAL_HTTP_ATTEMPTS,
        );
      }
    });
  });

  // ==========================================================================
  // 4. Witness Discrepancies and Comparison Limits Disclosure
  // ==========================================================================
  describe("Witness Discrepancy Reporting", () => {
    it("calculates common, WS-only, and history-only signatures with explicit disclaimer", async () => {
      const mockTransport = new MockWebSocketTransport();

      // WS will witness SIG_ANCHOR and SIG_C
      // History will witness SIG_ANCHOR and SIG_D
      const mockHistoryFetcher: HistoryPageFetcher = {
        fetchPage: async () => [
          {
            signature: SIG_D,
            slot: 105,
            err: null,
            blockTime: null, // Discovered signature with null blockTime
          },
          {
            signature: SIG_ANCHOR,
            slot: 100,
            err: null,
            blockTime: null, // Test explicit null blockTime handling
          },
        ],
      };

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxMessages: 5,
        transport: mockTransport,
        historyPageFetcher: mockHistoryFetcher,
      });

      mockTransport.triggerOpen();
      // Acknowledge logsSubscribe subscription
      const reqId = JSON.parse(mockTransport.sentMessages[0]!).id;
      mockTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 1 }));

      // Send 2 valid logs notifications
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 100 },
              value: {
                signature: SIG_ANCHOR,
                err: null,
                logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
              },
            },
          },
        }),
      );
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 102 },
              value: {
                signature: SIG_C,
                err: null,
                logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
              },
            },
          },
        }),
      );

      // Close mock transport to end probe
      mockTransport.close(1000, "Test complete");

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        const discrepancies = result.summary.discrepancyAnalysis;
        expect(discrepancies.commonSignaturesCount).toBe(1); // SIG_ANCHOR
        expect(discrepancies.wsOnlySignaturesCount).toBe(1); // SIG_C
        expect(discrepancies.historyOnlySignaturesCount).toBe(1); // SIG_D

        // Disclose explicit comparison limits notice
        expect(discrepancies.comparisonLimitsNotice).toMatch(
          /does NOT represent a true total network notification-loss percentage/,
        );

        // Explicit null blockTime count
        expect(result.metadata.counts.nullBlockTimeCount).toBe(1);
      }
    });
  });

  // ==========================================================================
  // 5. Invariant & Safeguard Preservation
  // ==========================================================================
  describe("Safeguard and Invariant Preservation", () => {
    it("preserves production completeness = false, Gate 11 fail-closed, and 7.9259 SOL wallet", async () => {
      const mockTransport = new MockWebSocketTransport();

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxMessages: 1,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_ANCHOR,
                slot: 100,
                err: null,
                logs: [],
              },
            },
            subscription: 1,
          },
        }),
      );

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        // Invariants
        expect(result.metadata.isProductionCompletenessEstablished).toBe(false);
        expect(result.summary.tradeFlowTelemetry.isProductionCompletenessEstablished).toBe(false);
        expect(result.metadata.gate11Status).toBe("UNAFFECTED_FAIL_CLOSED");
        expect(result.metadata.virtualWalletBalanceSol).toBe("7.9259 SOL");
        expect(result.metadata.spendingCeiling).toBe("$0.00");
      }
    });

    it("writes all evidence files and seals cryptographic manifest with valid SHA-256", async () => {
      const mockTransport = new MockWebSocketTransport();

      const probePromise = executeTransportObservationProbe({
        isLive: true,
        outDir: testOutputDir,
        maxMessages: 1,
        transport: mockTransport,
      });

      mockTransport.triggerOpen();
      mockTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              value: {
                signature: SIG_ANCHOR,
                slot: 100,
                err: null,
                logs: [],
              },
            },
            subscription: 1,
          },
        }),
      );

      const result = await probePromise;
      expect(result.success).toBe(true);
      if (result.success && !result.dryRun) {
        const manifestPath = path.join(testOutputDir, "capture-manifest.json");
        expect(fsSync.existsSync(manifestPath)).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "capture-metadata.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "probe-summary.json"))).toBe(true);
        expect(fsSync.existsSync(path.join(testOutputDir, "witnessed-signatures.json"))).toBe(true);

        const manifestData = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
        expect(manifestData.totalFiles).toBe(3);
        expect(manifestData.files.length).toBe(3);

        // Verify SHA-256 of each file against manifest entry
        for (const fileEntry of manifestData.files) {
          const content = fsSync.readFileSync(path.join(testOutputDir, fileEntry.filename));
          const computedHash = crypto.createHash("sha256").update(content).digest("hex");
          expect(computedHash).toBe(fileEntry.sha256);
          expect(content.length).toBe(fileEntry.byteSize);
        }

        // Verify entriesDigestSha256
        const sortedLines = manifestData.files
          .map((f: { filename: string; sha256: string }) => `${f.filename}:${f.sha256}`)
          .join("\n");
        const computedDigest = crypto.createHash("sha256").update(sortedLines).digest("hex");
        expect(computedDigest).toBe(manifestData.entriesDigestSha256);
      }
    });
  });
});
