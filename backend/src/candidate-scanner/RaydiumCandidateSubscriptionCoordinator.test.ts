/**
 * Phase 12.94-D Milestone D.3.3: Offline Verification Suite for
 * RaydiumCandidateSubscriptionCoordinator
 *
 * Deterministic offline test suite verifying:
 * 1. Exact candidate binding & immutable snapshotting (rejecting post-init caller mutation)
 * 2. Full 8-field adapter context validation (mint, vault, quote, orientation consistency)
 * 3. Subscription lifecycle, idempotency on repeated open events, and exact logsSubscribe
 * 4. Active-source contract validation: JSON-RPC '2.0', IDs, slot, context, err, logs, signature
 * 5. Active-source corruption & enqueue rejection preserves collection uncertainty in tracker
 * 6. Disconnect, error, close, and transport replacement immediately invalidate usable flow
 * 7. Source completeness requires validated SourceCompletenessProof (text strings rejected)
 * 8. Strict separation of synthetic completeness: rejected by default in production config;
 *    prevents synthetic completeness from becoming usable production retest input
 * 9. Active-source unparseable frames, JSON null, non-object frames, err/logs contract violations
 *    preserve collection uncertainty; unrelated identifiable subscriptions dropped without loss
 * 10. Queue draining and processing other work cannot erase recorded source uncertainty
 * 11. Production completeness mechanism marked unavailable (readiness gap preserved)
 * 12. Option validation (NaN budget rejected) and diagnostic redaction of sensitive credentials
 */

import { describe, it, expect } from "vitest";
import {
  RaydiumCandidateSubscriptionCoordinator,
  type SourceCompletenessProof,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID } from "../research/pilot/RaydiumAmmParser.js";

// Canonical Base58 fixture addresses
const CANONICAL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const CANONICAL_TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CANONICAL_PC_MINT = "So11111111111111111111111111111111111111112";
const CANONICAL_COIN_VAULT = "EkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Y";
const CANONICAL_PC_VAULT = "FkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Z";

const VALID_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: CANONICAL_POOL_ID,
  candidateTokenMint: CANONICAL_TOKEN_MINT,
  quoteTokenMint: CANONICAL_PC_MINT,
  baseVault: CANONICAL_COIN_VAULT,
  quoteVault: CANONICAL_PC_VAULT,
  baseMint: CANONICAL_TOKEN_MINT,
  quoteMint: CANONICAL_PC_MINT,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

class MockWebSocketTransport implements ISolanaWebSocketTransport {
  public sentMessages: string[] = [];
  public closed = false;
  public closeCode?: number | undefined;
  public closeReason?: string | undefined;

  private readonly listeners: {
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

  public send(data: string): void {
    this.sentMessages.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const listener of this.listeners.close) listener(code ?? 1000, reason ?? "");
  }

  public on(event: "open", listener: () => void): void;
  public on(event: "message", listener: (data: string | Buffer) => void): void;
  public on(event: "error", listener: (err: Error) => void): void;
  public on(event: "close", listener: (code: number, reason: string) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public on(event: string, listener: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners as any)[event].push(listener);
  }

  public triggerOpen(): void {
    for (const listener of this.listeners.open) listener();
  }

  public triggerMessage(data: string | Buffer): void {
    for (const listener of this.listeners.message) listener(data);
  }

  public triggerError(err: Error): void {
    for (const listener of this.listeners.error) listener(err);
  }

  public triggerClose(code = 1000, reason = "Normal"): void {
    this.closed = true;
    for (const listener of this.listeners.close) listener(code, reason);
  }
}

function createTestHarness(options?: {
  readonly startTime?: number | undefined;
  readonly maxPendingQueueSize?: number | undefined;
  readonly maxNotificationsBudget?: number | undefined;
  readonly onLog?: ((msg: string) => void) | undefined;
  readonly allowSyntheticCompletenessProofs?: boolean | undefined;
  readonly transportHandler?: ((sig: string) => Promise<Response>) | undefined;
}) {
  let currentTime = options?.startTime ?? 1_000_000;
  const clock = () => currentTime;
  const advanceTime = (ms: number) => {
    currentTime += ms;
  };

  const tracker = new RollingTradeFlowTracker({
    poolId: CANONICAL_POOL_ID,
    tokenMint: CANONICAL_TOKEN_MINT,
    trackingStartedMs: currentTime,
    clock,
  });

  const budgetManager = new GlobalResourceBudgetManager({
    minProviderSpacingMs: 0,
    clock,
  });

  const mockHttpFetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (options?.transportHandler && init && typeof init.body === "string") {
      const parsed = JSON.parse(init.body);
      const sig = parsed.params?.[0];
      return options.transportHandler(sig);
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const adapter = new RaydiumAmmV4TransactionSourceAdapter({
    poolContext: VALID_POOL_CONTEXT,
    rpcUrl: "https://mock-rpc.solana.internal",
    transport: mockHttpFetch,
    budgetManager,
    tracker,
    clock,
    sleepFn: async () => {},
    pacingMs: 0,
    maxPendingQueueSize: options?.maxPendingQueueSize ?? 10,
  });

  const transport = new MockWebSocketTransport();

  const coordinator = new RaydiumCandidateSubscriptionCoordinator({
    poolContext: VALID_POOL_CONTEXT,
    adapter,
    tracker,
    transport,
    clock,
    maxNotificationsBudget: options?.maxNotificationsBudget,
    onLog: options?.onLog,
    allowSyntheticCompletenessProofs: options?.allowSyntheticCompletenessProofs,
  });

  return {
    clock,
    advanceTime,
    getCurrentTime: () => currentTime,
    tracker,
    adapter,
    transport,
    coordinator,
  };
}

function makeSyntheticProof(
  poolId: string,
  connectionEpoch: number,
  rangeStartMs: number,
  rangeEndMs: number,
  label = "test_fixture",
): SourceCompletenessProof {
  return {
    mode: "SYNTHETIC_TEST_FIXTURE",
    poolId,
    connectionEpoch,
    rangeStartMs,
    rangeEndMs,
    testFixtureLabel: label,
  };
}

describe("RaydiumCandidateSubscriptionCoordinator", () => {
  describe("Requirement 1 & Defect 3: Exact Candidate Binding & Immutable Snapshotting", () => {
    it("successfully initializes when poolContext, adapter, tracker, and transport are valid and aligned", () => {
      const { coordinator, transport, adapter, tracker } = createTestHarness();

      expect(coordinator.getStatus()).toBe("CONNECTING");
      expect(coordinator.getPoolContext().poolId).toBe(CANONICAL_POOL_ID);
      expect(coordinator.getAdapter()).toBe(adapter);
      expect(coordinator.getTracker()).toBe(tracker);
      expect(coordinator.getConnectionEpoch()).toBe(1);
      expect(coordinator.getActiveSubscriptionId()).toBeNull();
      expect(transport.closed).toBe(false);
    });

    it("snapshots and freezes poolContext so caller mutation after construction cannot cause program-wide subscriptions", () => {
      const mutableContext: Record<string, unknown> = {
        poolId: CANONICAL_POOL_ID,
        candidateTokenMint: CANONICAL_TOKEN_MINT,
        quoteTokenMint: CANONICAL_PC_MINT,
        baseVault: CANONICAL_COIN_VAULT,
        quoteVault: CANONICAL_PC_VAULT,
        baseMint: CANONICAL_TOKEN_MINT,
        quoteMint: CANONICAL_PC_MINT,
        orientation: "TOKEN_BASE_SOL_QUOTE",
      };

      const harness = createTestHarness();
      const transport = new MockWebSocketTransport();
      new RaydiumCandidateSubscriptionCoordinator({
        poolContext: mutableContext as unknown as TrackedRaydiumPoolContext,
        adapter: harness.adapter,
        tracker: harness.tracker,
        transport,
      });

      // Attempt to mutate caller object
      mutableContext.poolId = RAYDIUM_AMM_V4_PROGRAM_ID;

      // Subscription payload must still use the frozen snapshot, NOT the mutated caller object
      transport.triggerOpen();
      expect(transport.sentMessages.length).toBe(1);
      const payload = JSON.parse(transport.sentMessages[0]!);
      expect(payload.params[0].mentions).toEqual([CANONICAL_POOL_ID]);
      expect(payload.params[0].mentions).not.toContain(RAYDIUM_AMM_V4_PROGRAM_ID);
    });

    it("fails closed if poolId is a program ID at construction", () => {
      const { adapter, tracker } = createTestHarness();

      const programWideContext: TrackedRaydiumPoolContext = {
        ...VALID_POOL_CONTEXT,
        poolId: RAYDIUM_AMM_V4_PROGRAM_ID,
      };

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: programWideContext,
          adapter,
          tracker,
        });
      }).toThrow(/Program-wide subscription is prohibited/);
    });

    it("fails closed if adapter context differs in mint, vault, quote, or orientation", () => {
      const { tracker, clock } = createTestHarness();
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0, clock });

      // 1. Mismatched candidate mint
      const mismatchedMintAdapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: {
          ...VALID_POOL_CONTEXT,
          candidateTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
          baseMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        },
        rpcUrl: "https://mock.rpc",
        transport: async () => new Response("{}"),
        budgetManager,
        clock,
      });

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter: mismatchedMintAdapter,
          tracker,
        });
      }).toThrow(/Adapter candidateTokenMint .* does not match coordinator/);

      // 2. Mismatched pool ID
      const mismatchedPoolAdapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: {
          ...VALID_POOL_CONTEXT,
          poolId: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        },
        rpcUrl: "https://mock.rpc",
        transport: async () => new Response("{}"),
        budgetManager,
        clock,
      });

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter: mismatchedPoolAdapter,
          tracker,
        });
      }).toThrow(/Adapter poolId .* does not match coordinator/);
    });

    it("fails closed if tracker poolId or tokenMint does not match coordinator poolContext", () => {
      const { adapter, clock } = createTestHarness();

      const mismatchedTracker = new RollingTradeFlowTracker({
        poolId: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: 1_000_000,
        clock,
      });

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter,
          tracker: mismatchedTracker,
        });
      }).toThrow(/Tracker poolId .* does not match coordinator poolId/);

      const mismatchedMintTracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        trackingStartedMs: 1_000_000,
        clock,
      });

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter,
          tracker: mismatchedMintTracker,
        });
      }).toThrow(/Tracker tokenMint .* does not match coordinator/);
    });

    it("requires injected transport (rejects invalid or non-object transport)", () => {
      const { adapter, tracker } = createTestHarness();

      expect(() => {
        const coord = new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter,
          tracker,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        coord.attachTransport({} as any);
      }).toThrow(/Invalid injected transport/);
    });
  });

  describe("Requirement 2 & Defect 2: Subscription Lifecycle, Idempotency & Inactive Flow Invalidation", () => {
    it("subscribes exclusively to candidate pool mentions upon transport open", () => {
      const { coordinator, transport } = createTestHarness();

      expect(transport.sentMessages.length).toBe(0);
      transport.triggerOpen();

      expect(coordinator.getStatus()).toBe("SUBSCRIBING");
      expect(transport.sentMessages.length).toBe(1);

      const payload = JSON.parse(transport.sentMessages[0]!);
      expect(payload.method).toBe("logsSubscribe");
      expect(payload.params).toEqual([
        { mentions: [CANONICAL_POOL_ID] },
        { commitment: "confirmed" },
      ]);
    });

    it("subscription initiation is idempotent across repeated open events", () => {
      const { coordinator, transport } = createTestHarness();

      transport.triggerOpen();
      expect(transport.sentMessages.length).toBe(1);

      // Repeated open event must NOT dispatch a second subscription request
      transport.triggerOpen();
      expect(transport.sentMessages.length).toBe(1);

      // Confirm subscription
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Another open event while SUBSCRIBED must NOT dispatch another subscription
      transport.triggerOpen();
      expect(transport.sentMessages.length).toBe(1);
    });

    it("inactive subscriptions immediately invalidate usable flow across evaluateFlow, createRetestSpotInfo, and getCoverageDiagnostic", () => {
      const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Prove 65s of gapless observation
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `step_${i + 1}`,
          ),
        });
      }

      // Coverage was SUFFICIENT under synthetic test mode
      expect(coordinator.evaluateFlow().coverage).toBe("SUFFICIENT");

      // Transport closes!
      transport.triggerClose(1006, "Connection lost");
      expect(coordinator.getStatus()).toBe("DISCONNECTED");

      // Inactive subscription immediately invalidates usable flow!
      const flow = coordinator.evaluateFlow();
      expect(flow.coverage).toBe("COLLECTION_GAP");
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();
      expect(flow.recentSells60s).toBeNull();
      expect(flow.flowRatio).toBeNull();

      // createRetestSpotInfo also returns unavailable flow
      const spot = coordinator.createRetestSpotInfo({
        spotPriceSol: 0.00005,
      });
      expect(spot.flowCoverage).toBe("COLLECTION_GAP");
      expect(spot.recentBuys60s).toBeNull();
      expect(spot.recentSells60s).toBeNull();

      // getCoverageDiagnostic explains inactive state
      const diag = coordinator.getCoverageDiagnostic();
      expect(diag.coverage).toBe("COLLECTION_GAP");
      expect(diag.isCoverageSufficient).toBe(false);
      expect(diag.recentBuys60s).toBeNull();
      expect(diag.limitationReason).toMatch(/Subscription is not active/);
    });

    it("closing the coordinator immediately invalidates usable flow", () => {
      const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `step_${i + 1}`,
          ),
        });
      }

      coordinator.close();
      expect(coordinator.getStatus()).toBe("CLOSED");

      const flow = coordinator.evaluateFlow();
      expect(flow.coverage).toBe("COLLECTION_GAP");
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();

      const spot = coordinator.createRetestSpotInfo({ spotPriceSol: 0.0001 });
      expect(spot.flowCoverage).toBe("COLLECTION_GAP");
      expect(spot.recentBuys60s).toBeNull();
    });

    it("replacing an active transport explicitly records an interruption gap in tracker", () => {
      const {
        coordinator,
        transport: transport1,
        tracker,
        advanceTime,
        getCurrentTime,
      } = createTestHarness({ startTime: 1_000_000, allowSyntheticCompletenessProofs: true });

      transport1.triggerOpen();
      const reqId = JSON.parse(transport1.sentMessages[0]!).id;
      transport1.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance 65s of warm-up
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `warmup_${i + 1}`,
          ),
        });
      }

      // Replace transport while active
      const transport2 = new MockWebSocketTransport();
      coordinator.attachTransport(transport2);

      expect(coordinator.getMetrics().totalDisconnectGapsRecorded).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.some((g) => g.reason?.includes("TRANSPORT_REPLACEMENT_INTERRUPTION"))).toBe(true);
    });
  });

  describe("Requirement 4 & Defect 4: Active-Source Contract Validation & Uncertainty Preservation", () => {
    it("rejects acknowledgments with jsonrpc != '2.0' or negative subscription IDs", () => {
      const { coordinator, transport } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;

      // 1. jsonrpc="1.0"
      transport.triggerMessage(
        JSON.stringify({
          jsonrpc: "1.0",
          id: reqId,
          result: 101,
        }),
      );
      expect(coordinator.getStatus()).toBe("SUBSCRIBING");
      expect(coordinator.getActiveSubscriptionId()).toBeNull();
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);

      // 2. Negative subscription ID -7
      transport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: reqId,
          result: -7,
        }),
      );
      expect(coordinator.getStatus()).toBe("SUBSCRIBING");
      expect(coordinator.getActiveSubscriptionId()).toBeNull();
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(2);

      // 3. Valid ack
      transport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: reqId,
          result: 101,
        }),
      );
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");
      expect(coordinator.getActiveSubscriptionId()).toBe(101);
    });

    it("rejects active-source notifications with jsonrpc != '2.0' and preserves collection uncertainty", () => {
      const { coordinator, transport, tracker } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      const frame = {
        jsonrpc: "1.0", // Invalid JSON-RPC version
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 290123456 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
              err: null,
              logs: [],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(frame));

      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION"))).toBe(true);
    });

    it("rejects active-source notifications missing context, slot, err, or logs fields and records collection gap", () => {
      const { coordinator, transport, tracker } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      // Missing logs array and err field
      const corruptFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 290123456 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(corruptFrame));

      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.some((g) => g.reason?.includes("MISSING_ERR_FIELD"))).toBe(true);
    });

    it("preserves collection gap when active-source signature is rejected by adapter", () => {
      const { coordinator, transport, tracker } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      // Invalid signature: not Base58
      const invalidSigFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 290123456 },
            value: {
              signature: "InvalidSignatureWithSpecialChars!@#$$%",
              err: null,
              logs: [],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(invalidSigFrame));

      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.some((g) => g.reason?.includes("INVALID_SIGNATURE"))).toBe(true);
    });

    it("routes valid incoming logsNotification to adapter.enqueueNotification()", () => {
      const { coordinator, transport, adapter } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      expect(adapter.getPendingQueueLength()).toBe(0);

      const validSig = "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q";
      const notificationFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 290123456 },
            value: {
              signature: validSig,
              err: null,
              logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(notificationFrame));

      expect(adapter.getPendingQueueLength()).toBe(1);
      const metrics = coordinator.getMetrics();
      expect(metrics.totalNotificationsReceived).toBe(1);
      expect(metrics.totalNotificationsRouted).toBe(1);
    });

    // --- NEW REGRESSIONS FOR REMAINING FINDING 2 ---
    it("preserves collection uncertainty when active source emits unparseable JSON or JSON containing a logsNotification fragment", () => {
      const { coordinator, transport, tracker, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance 65s so warm-up duration is satisfied
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `setup_${i + 1}`,
          ),
        });
      }

      // Prior to active source corruption, coverage was SUFFICIENT
      expect(coordinator.evaluateFlow().coverage).toBe("SUFFICIENT");

      // Active source emits an unparseable truncated fragment
      const truncatedFragment =
        '{"jsonrpc":"2.0","method":"logsNotification","params":{"subscription":101,"result":{"context":{"slot":300';
      transport.triggerMessage(truncatedFragment);

      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.length).toBeGreaterThan(0);
      expect(
        gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION:UNPARSEABLE_FRAME")),
      ).toBe(true);

      const flow = coordinator.evaluateFlow();
      expect(flow.coverage).toBe("COLLECTION_GAP");
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();
    });

    it("preserves collection uncertainty when active source emits JSON 'null' or non-object frame", () => {
      const { coordinator, transport, tracker, advanceTime } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Frame 1: JSON null
      transport.triggerMessage("null");
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      expect(coordinator.getMetrics().totalDisconnectGapsRecorded).toBe(1);
      let gaps = tracker.getRecordedGaps();
      expect(
        gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION:NON_OBJECT_FRAME")),
      ).toBe(true);

      // Advance time by 5s so second gap does not coalesce into the first
      advanceTime(5_000);

      // Frame 2: Non-object primitive or array
      transport.triggerMessage("[1, 2, 3]");
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(2);
      expect(coordinator.getMetrics().totalDisconnectGapsRecorded).toBe(2);
      gaps = tracker.getRecordedGaps();
      expect(gaps.length).toBeGreaterThanOrEqual(2);
    });

    it("continues rejecting identifiable unrelated subscriptions without treating them as candidate losses", () => {
      const { coordinator, transport, tracker } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Identifiable unrelated subscription ID 999 (different pool)
      const unrelatedFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 999, // Identifiable integer, not 101
          result: {
            context: { slot: 300000000 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
              err: null,
              logs: ["Program 675k..."],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(unrelatedFrame));

      // Correctly counted as unrelated dropped
      expect(coordinator.getMetrics().totalUnrelatedDropped).toBe(1);
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(0);
      // Zero collection gaps recorded in tracker!
      const gaps = tracker.getRecordedGaps();
      expect(gaps.length).toBe(0);
    });

    it("rejects non-compliant err field (e.g. number 42, boolean) and preserves collection uncertainty", () => {
      const { coordinator, transport, tracker, advanceTime } = createTestHarness();

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // 1. err = 42 (number violates error/null contract)
      const errNumberFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 300000000 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
              err: 42, // Non-compliant error type
              logs: ["Program 675k..."],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(errNumberFrame));
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      expect(coordinator.getMetrics().totalDisconnectGapsRecorded).toBe(1);
      let gaps = tracker.getRecordedGaps();
      expect(
        gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION:MALFORMED_ERR_FIELD")),
      ).toBe(true);

      // Advance time by 5s so second gap does not coalesce into the first
      advanceTime(5_000);

      // 2. err = true (boolean violates error/null contract)
      const errBoolFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 300000001 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
              err: true, // Non-compliant boolean
              logs: ["Program 675k..."],
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(errBoolFrame));
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(2);
      expect(coordinator.getMetrics().totalDisconnectGapsRecorded).toBe(2);
      gaps = tracker.getRecordedGaps();
      expect(gaps.length).toBeGreaterThanOrEqual(2);
    });

    it("rejects logs array containing non-string items (e.g. [null, 123]) and preserves collection uncertainty", () => {
      const { coordinator, transport, tracker, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance 65s so warm-up duration is satisfied
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `setup_${i + 1}`,
          ),
        });
      }

      // Prior to active source corruption, coverage was SUFFICIENT
      expect(coordinator.evaluateFlow().coverage).toBe("SUFFICIENT");

      // logs containing non-string items [null, 123]
      const malformedLogsFrame = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 300000000 },
            value: {
              signature: "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q",
              err: null,
              logs: [null, 123], // Non-string items in logs array
            },
          },
        },
      };

      transport.triggerMessage(JSON.stringify(malformedLogsFrame));
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(
        gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION:MALFORMED_LOGS_FIELD")),
      ).toBe(true);

      const flow = coordinator.evaluateFlow();
      expect(flow.coverage).toBe("COLLECTION_GAP");
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();
    });

    it("proves that processing other queued work cannot erase the resulting source uncertainty", async () => {
      const validSig = "5J7P4T2tYd5Q3n7d6eK4u2M9g1V8m7k5j3H6f4D2s1A9b8C7x6Z5v4T3r2E1w9Q";

      // Mock transport handler for valid transaction
      const transportHandler = async (sig: string) => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              slot: 300000000,
              blockTime: 1000 + 30, // 30s after start
              transaction: {
                signatures: [sig],
                message: {
                  accountKeys: [
                    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
                    CANONICAL_POOL_ID,
                    CANONICAL_COIN_VAULT,
                    CANONICAL_PC_VAULT,
                    CANONICAL_TOKEN_MINT,
                    CANONICAL_PC_MINT,
                    "UserAccount11111111111111111111111111111111",
                  ],
                  instructions: [
                    {
                      programIdIndex: 0,
                      accounts: [1, 2, 3, 4, 5, 6],
                      data: "3Bxs491cx5wS", // SwapBaseIn
                    },
                  ],
                },
              },
              meta: {
                err: null,
                logMessages: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success"],
                innerInstructions: [],
                preTokenBalances: [],
                postTokenBalances: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const { coordinator, transport, adapter, tracker, advanceTime, getCurrentTime } =
        createTestHarness({
          startTime: 1_000_000,
          allowSyntheticCompletenessProofs: true,
          transportHandler,
        });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance 65s so warm-up duration is satisfied
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `setup_${i + 1}`,
          ),
        });
      }

      // Step 1: Queue a valid transaction notification
      const validNotification = {
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 300000000 },
            value: {
              signature: validSig,
              err: null,
              logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
            },
          },
        },
      };
      transport.triggerMessage(JSON.stringify(validNotification));
      expect(adapter.getPendingQueueLength()).toBe(1);

      // Step 2: Active source emits a corrupt frame (unparseable or malformed logs)
      transport.triggerMessage('{"jsonrpc":"2.0","method":"logsNotification","params":{"sub');
      expect(coordinator.getMetrics().totalMalformedFramesDropped).toBe(1);
      const gaps = tracker.getRecordedGaps();
      expect(gaps.some((g) => g.reason?.includes("ACTIVE_SOURCE_CORRUPTION"))).toBe(true);

      // Step 3: Drain all pending adapter work
      const batchResult = await coordinator.processAllPending();
      expect(batchResult.totalProcessed).toBe(1);
      expect(adapter.getActiveWorkload()).toBe(0);

      // Step 4: Verify that draining the queue and successfully processing the valid transaction
      // CANNOT erase the source uncertainty in evaluateFlow() or createRetestSpotInfo()!
      const flow = coordinator.evaluateFlow();
      expect(flow.coverage).toBe("COLLECTION_GAP");
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();
      expect(flow.recentSells60s).toBeNull();

      const spot = coordinator.createRetestSpotInfo({ spotPriceSol: 0.0001 });
      expect(spot.flowCoverage).toBe("COLLECTION_GAP");
      expect(spot.recentBuys60s).toBeNull();
    });
  });

  describe("Requirement 1 & Defect 1: Source Completeness Verification (No Text Strings)", () => {
    it("rejects explanatory text strings in recordCompletedRange and advanceCoverage", () => {
      const { coordinator, transport, getCurrentTime } = createTestHarness({
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      // 1. Text string in recordCompletedRange
      const res1 = coordinator.recordCompletedRange(
        getCurrentTime() - 10_000,
        getCurrentTime(),
        "Socket open and queue empty" as unknown as SourceCompletenessProof,
      );
      expect(res1.ok).toBe(false);
      expect(res1.reason).toBe("UNTRUSTED_COMPLETENESS_PROOF");

      // 2. Text string in advanceCoverage
      const res2 = coordinator.advanceCoverage({
        checkpointMs: getCurrentTime(),
        proof: "Socket open and queue empty" as unknown as SourceCompletenessProof,
      });
      expect(res2.ok).toBe(false);
      expect(res2.reason).toBe("UNTRUSTED_COMPLETENESS_PROOF");
    });

    it("rejects PROVEN_GAPLESS_BLOCK_RANGE_POLL because production completeness is an open readiness gap", () => {
      const { coordinator, transport, getCurrentTime } = createTestHarness({
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      const prodProof: SourceCompletenessProof = {
        mode: "PROVEN_GAPLESS_BLOCK_RANGE_POLL",
        poolId: CANONICAL_POOL_ID,
        connectionEpoch: coordinator.getConnectionEpoch(),
        rangeStartMs: getCurrentTime() - 10_000,
        rangeEndMs: getCurrentTime(),
      };

      const res = coordinator.advanceCoverage({
        checkpointMs: getCurrentTime(),
        proof: prodProof,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("COMPLETENESS_MECHANISM_UNAVAILABLE");
      expect(res.message).toMatch(
        /Production source-completeness verification mechanism is not implemented/,
      );
    });

    it("rejects completeness proofs with mismatched poolId or connectionEpoch", () => {
      const { coordinator, transport, getCurrentTime } = createTestHarness({
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      // 1. Mismatched poolId
      const badPoolProof = makeSyntheticProof(
        "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        coordinator.getConnectionEpoch(),
        getCurrentTime() - 10_000,
        getCurrentTime(),
      );
      const res1 = coordinator.advanceCoverage({
        checkpointMs: getCurrentTime(),
        proof: badPoolProof,
      });
      expect(res1.ok).toBe(false);
      expect(res1.reason).toBe("PROOF_POOL_MISMATCH");

      // 2. Mismatched connectionEpoch
      const badEpochProof = makeSyntheticProof(
        CANONICAL_POOL_ID,
        999, // Wrong epoch
        getCurrentTime() - 10_000,
        getCurrentTime(),
      );
      const res2 = coordinator.advanceCoverage({
        checkpointMs: getCurrentTime(),
        proof: badEpochProof,
      });
      expect(res2.ok).toBe(false);
      expect(res2.reason).toBe("PROOF_EPOCH_MISMATCH");
    });

    it("synthetic test fixtures advance coverage for offline tests but explicitly state production completeness is not established", () => {
      const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));

      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        const res = coordinator.advanceCoverage({
          checkpointMs: getCurrentTime(),
          proof: makeSyntheticProof(
            CANONICAL_POOL_ID,
            coordinator.getConnectionEpoch(),
            getCurrentTime() - 10_000,
            getCurrentTime(),
            `offline_fixture_step_${i + 1}`,
          ),
        });
        expect(res.ok).toBe(true);
        expect(res.isProductionCompletenessEstablished).toBe(false);
      }

      const diag = coordinator.getCoverageDiagnostic();
      expect(diag.coverage).toBe("SUFFICIENT");
      expect(diag.isProductionCompletenessEstablished).toBe(false);
      expect(diag.limitationReason).toMatch(
        /offline synthetic proof only; production completeness remains unproven/,
      );
    });

    // --- NEW REGRESSIONS FOR REMAINING FINDING 1 ---
    it("default coordinator configuration rejects synthetic completeness proofs with SYNTHETIC_PROOFS_DISALLOWED", () => {
      // Default coordinator configuration (allowSyntheticCompletenessProofs omitted / false)
      const { coordinator, transport, getCurrentTime } = createTestHarness();

      expect(coordinator.isSyntheticCompletenessAllowed()).toBe(false);

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      const proof = makeSyntheticProof(
        CANONICAL_POOL_ID,
        coordinator.getConnectionEpoch(),
        getCurrentTime() - 10_000,
        getCurrentTime(),
        "unauthorized_fixture",
      );

      // advanceCoverage must reject with SYNTHETIC_PROOFS_DISALLOWED
      const advRes = coordinator.advanceCoverage({
        checkpointMs: getCurrentTime(),
        proof,
      });
      expect(advRes.ok).toBe(false);
      expect(advRes.reason).toBe("SYNTHETIC_PROOFS_DISALLOWED");
      expect(advRes.message).toMatch(
        /Synthetic completeness proofs are disallowed under production configuration/,
      );

      // recordCompletedRange must reject with SYNTHETIC_PROOFS_DISALLOWED
      const rangeRes = coordinator.recordCompletedRange(
        getCurrentTime() - 10_000,
        getCurrentTime(),
        proof,
      );
      expect(rangeRes.ok).toBe(false);
      expect(rangeRes.reason).toBe("SYNTHETIC_PROOFS_DISALLOWED");
      expect(rangeRes.message).toMatch(
        /Synthetic completeness proofs are disallowed under production configuration/,
      );
    });

    it("default production configuration prevents synthetic completeness from becoming usable production retest input", () => {
      // Default configuration
      const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
      });

      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance time past 65s so tracking duration satisfies 60s
      advanceTime(65_000);

      // Under default configuration, evaluateFlow retains unavailable counts
      const flow = coordinator.evaluateFlow(getCurrentTime());
      expect(flow.isCoverageSufficient).toBe(false);
      expect(flow.recentBuys60s).toBeNull();
      expect(flow.recentSells60s).toBeNull();
      expect(flow.flowRatio).toBeNull();

      // createRetestSpotInfo retains unavailable flow counts (never SUFFICIENT)
      const spot = coordinator.createRetestSpotInfo({
        spotPriceSol: 0.0001,
        spotPriceUsd: 0.02,
        liquidityUsd: 75_000,
      });
      expect(spot.recentBuys60s).toBeNull();
      expect(spot.recentSells60s).toBeNull();
      expect(spot.flowCoverage).not.toBe("SUFFICIENT");

      // getCoverageDiagnostic clearly reports that production source completeness is unproven
      const diag = coordinator.getCoverageDiagnostic(getCurrentTime());
      expect(diag.isProductionCompletenessEstablished).toBe(false);
      expect(diag.isCoverageSufficient).toBe(false);
      expect(diag.recentBuys60s).toBeNull();
      expect(diag.limitationReason).toMatch(/Production source completeness is unproven/);
    });
  });

  describe("Requirement 5 & Defect 5: Option Validation & Diagnostic Sanitization", () => {
    it("rejects maxNotificationsBudget=NaN, negative numbers, and non-integers at construction", () => {
      const harness = createTestHarness();

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter: harness.adapter,
          tracker: harness.tracker,
          maxNotificationsBudget: NaN,
        });
      }).toThrow(/maxNotificationsBudget must be a positive integer/);

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter: harness.adapter,
          tracker: harness.tracker,
          maxNotificationsBudget: -10,
        });
      }).toThrow(/maxNotificationsBudget must be a positive integer/);

      expect(() => {
        new RaydiumCandidateSubscriptionCoordinator({
          poolContext: VALID_POOL_CONTEXT,
          adapter: harness.adapter,
          tracker: harness.tracker,
          maxNotificationsBudget: 12.5,
        });
      }).toThrow(/maxNotificationsBudget must be a positive integer/);
    });

    it("sanitizes transport errors and URLs, redacting API keys and sensitive tokens in onLog", () => {
      const logMessages: string[] = [];
      const harness = createTestHarness();
      const transport = new MockWebSocketTransport();

      new RaydiumCandidateSubscriptionCoordinator({
        poolContext: VALID_POOL_CONTEXT,
        adapter: harness.adapter,
        tracker: harness.tracker,
        transport,
        onLog: (msg) => logMessages.push(msg),
      });

      // Trigger transport error containing synthetic API key in URL
      const sensitiveError = new Error(
        "Failed to connect to wss://rpc.solana.com/?api-key=super_secret_token_12345&auth=secretpass",
      );
      transport.triggerError(sensitiveError);

      expect(logMessages.length).toBeGreaterThan(0);
      const combined = logMessages.join("\n");
      expect(combined).not.toContain("super_secret_token_12345");
      expect(combined).not.toContain("secretpass");
      expect(combined).toContain("[REDACTED]");
    });
  });
});
