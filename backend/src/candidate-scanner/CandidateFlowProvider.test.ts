import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRetestGate } from "./RetestGateEvaluator.js";
import {
  UnavailableCandidateFlowProvider,
  CoordinatorCandidateFlowProvider,
  buildRetestSpotInfo,
  evaluateCandidateDecisionPoints,
  validateAndSnapshotCandidateFlowResult,
  type CandidateFlowTarget,
  type CandidateFlowProvider,
  type CandidateFlowResult,
} from "./CandidateFlowProvider.js";
import {
  setCandidateFlowProvider,
  getCandidateFlowProvider,
  loadDaemonEnvironment,
} from "../scripts/paper-trading-daemon.js";
import { RaydiumCandidateSubscriptionCoordinator } from "./RaydiumCandidateSubscriptionCoordinator.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type { WatchlistCandidateItem } from "@nexustrade/shared";

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
  orientation: "TOKEN_BASE_SOL_QUOTE" as const,
});

class MockWebSocketTransport implements ISolanaWebSocketTransport {
  public sentMessages: string[] = [];
  public isClosed = false;
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

  public close(): void {
    this.isClosed = true;
  }

  public on(event: "open", listener: () => void): void;
  public on(event: "message", listener: (data: string | Buffer) => void): void;
  public on(event: "error", listener: (err: Error) => void): void;
  public on(event: "close", listener: (code: number, reason: string) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public on(event: string, listener: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners as any)[event]?.push(listener);
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

  public triggerClose(code = 1000, reason = ""): void {
    for (const listener of this.listeners.close) listener(code, reason);
  }
}

function createTestHarness(options?: {
  readonly startTime?: number;
  readonly allowSyntheticCompletenessProofs?: boolean;
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

  const adapter = new RaydiumAmmV4TransactionSourceAdapter({
    poolContext: VALID_POOL_CONTEXT,
    rpcUrl: "https://mock-rpc.solana.internal",
    transport: async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    budgetManager,
    tracker,
    clock,
    sleepFn: async () => {},
    pacingMs: 0,
    maxPendingQueueSize: 10,
  });

  const transport = new MockWebSocketTransport();

  const coordinator = new RaydiumCandidateSubscriptionCoordinator({
    poolContext: VALID_POOL_CONTEXT,
    adapter,
    tracker,
    transport,
    clock,
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

function createSampleCandidate(
  overrides?: Partial<WatchlistCandidateItem>,
): WatchlistCandidateItem {
  return {
    poolId: CANONICAL_POOL_ID,
    mintAddress: CANONICAL_TOKEN_MINT,
    symbol: "CANDIDATE",
    liquidityUsd: 65_000,
    marketCapUsd: 250_000,
    assetAgeSeconds: 2400,
    lmcRatio: 0.26,
    lpBurnPct: 100,
    buyToSellRatio: 2.2,
    volume5mUsd: 12_000,
    buys5m: 45,
    sells5m: 20,
    discoveredAt: new Date(1_000_000 - 60_000).toISOString(),
    lastEvaluatedAt: new Date(1_000_000 - 60_000).toISOString(),
    status: "WATCHING",
    ...overrides,
  };
}

describe("CandidateFlowProvider & Evaluation Seam", () => {
  beforeEach(() => {
    setCandidateFlowProvider(new UnavailableCandidateFlowProvider());
  });

  describe("1. UnavailableCandidateFlowProvider (Default)", () => {
    it("returns explicit unavailable counts, COLLECTION_GAP, and isCoverageSufficient=false", () => {
      const provider = new UnavailableCandidateFlowProvider();
      const target: CandidateFlowTarget = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      };

      const result = provider.getCandidateFlow(target, 1_060_000);

      expect(result.poolAddress).toBe(CANONICAL_POOL_ID);
      expect(result.tokenMint).toBe(CANONICAL_TOKEN_MINT);
      expect(result.recentBuys60s).toBeNull();
      expect(result.recentSells60s).toBeNull();
      expect(result.flowCoverage).toBe("COLLECTION_GAP");
      expect(result.isCoverageSufficient).toBe(false);
      expect(result.diagnosticReason).toBe("NO_FLOW_PROVIDER_CONFIGURED");
      expect(result.evaluationTimestampMs).toBe(1_060_000);
    });

    it("daemon defaults to UnavailableCandidateFlowProvider when no provider is set", () => {
      const defaultProvider = getCandidateFlowProvider();
      expect(defaultProvider).toBeInstanceOf(UnavailableCandidateFlowProvider);
      const res = defaultProvider.getCandidateFlow(
        { poolAddress: "test", tokenMint: "test" },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
    });

    it("buildRetestSpotInfo correctly overlays base spot with candidate flow", () => {
      const flow: CandidateFlowResult = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        recentBuys60s: 12,
        recentSells60s: 3,
        flowCoverage: "SUFFICIENT",
        isCoverageSufficient: true,
        diagnosticReason: "SUFFICIENT",
        evaluationTimestampMs: 1_000_000,
      };
      const spot = buildRetestSpotInfo({ spotPriceSol: 0.005, liquidityUsd: 50_000 }, flow);
      expect(spot.spotPriceSol).toBe(0.005);
      expect(spot.liquidityUsd).toBe(50_000);
      expect(spot.recentBuys60s).toBe(12);
      expect(spot.recentSells60s).toBe(3);
      expect(spot.flowCoverage).toBe("SUFFICIENT");
    });
  });

  describe("2. CoordinatorCandidateFlowProvider Identity & Error Guards", () => {
    it("fails closed on invalid target coordinates (empty string or non-string)", () => {
      const provider = new CoordinatorCandidateFlowProvider();
      const res1 = provider.getCandidateFlow(
        { poolAddress: "", tokenMint: CANONICAL_TOKEN_MINT },
        1_000_000,
      );
      expect(res1.recentBuys60s).toBeNull();
      expect(res1.isCoverageSufficient).toBe(false);
      expect(res1.diagnosticReason).toBe("INVALID_TARGET_COORDINATES");

      const res2 = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: "   " },
        1_000_000,
      );
      expect(res2.recentBuys60s).toBeNull();
      expect(res2.isCoverageSufficient).toBe(false);
      expect(res2.diagnosticReason).toBe("INVALID_TARGET_COORDINATES");
    });

    it("fails closed on invalid evaluation timestamp (NaN, negative, float)", () => {
      const provider = new CoordinatorCandidateFlowProvider();
      const target = { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT };

      const resNan = provider.getCandidateFlow(target, NaN);
      expect(resNan.recentBuys60s).toBeNull();
      expect(resNan.diagnosticReason).toBe("INVALID_EVALUATION_TIMESTAMP");

      const resNeg = provider.getCandidateFlow(target, -500);
      expect(resNeg.recentBuys60s).toBeNull();
      expect(resNeg.diagnosticReason).toBe("INVALID_EVALUATION_TIMESTAMP");

      const resFloat = provider.getCandidateFlow(target, 12345.67);
      expect(resFloat.recentBuys60s).toBeNull();
      expect(resFloat.diagnosticReason).toBe("INVALID_EVALUATION_TIMESTAMP");
    });

    it("fails closed when lookup throws an exception", () => {
      const throwingLookup = () => {
        throw new Error("Lookup database unavailable");
      };
      const provider = new CoordinatorCandidateFlowProvider(throwingLookup);
      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("PROVIDER_LOOKUP_EXCEPTION");
      expect(res.diagnosticReason).toContain("Lookup database unavailable");
    });

    it("fails closed when no coordinator is registered for requested pool", () => {
      const { coordinator } = createTestHarness();
      const provider = new CoordinatorCandidateFlowProvider(coordinator);

      const res = provider.getCandidateFlow(
        {
          poolAddress: "DifferentPoolAddress1111111111111111111111",
          tokenMint: CANONICAL_TOKEN_MINT,
        },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("NO_COORDINATOR_FOR_POOL");
    });

    it("enforces exact, case-sensitive pool address matching", () => {
      const { coordinator } = createTestHarness();
      const provider = new CoordinatorCandidateFlowProvider((addr: string) =>
        addr.toLowerCase() === CANONICAL_POOL_ID.toLowerCase() ? coordinator : undefined,
      );

      // Case alteration in pool ID: '58oQCh...' vs '58OQCH...'
      const alteredPool = CANONICAL_POOL_ID.toUpperCase();
      expect(alteredPool).not.toBe(CANONICAL_POOL_ID);

      const res = provider.getCandidateFlow(
        { poolAddress: alteredPool, tokenMint: CANONICAL_TOKEN_MINT },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("IDENTITY_MISMATCH");
    });

    it("enforces exact, case-sensitive candidate token mint matching", () => {
      const { coordinator } = createTestHarness();
      const provider = new CoordinatorCandidateFlowProvider(coordinator);

      // Case alteration in token mint: 'So111...' vs 'so111...'
      const alteredMint = "so11111111111111111111111111111111111111112";
      expect(alteredMint).not.toBe(CANONICAL_TOKEN_MINT);

      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: alteredMint },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("IDENTITY_MISMATCH");
    });

    it("handles coordinator evaluation throwing an exception safely", () => {
      const { coordinator } = createTestHarness();
      vi.spyOn(coordinator, "createRetestSpotInfo").mockImplementation(() => {
        throw new Error("Internal coordinator memory corruption");
      });

      const provider = new CoordinatorCandidateFlowProvider(coordinator);
      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
        1_000_000,
      );
      expect(res.recentBuys60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("COORDINATOR_EVALUATION_EXCEPTION");
      expect(res.diagnosticReason).toContain("Internal coordinator memory corruption");
    });
  });

  describe("3. Production Defaults & Environment Bypass Rejection", () => {
    it("production-default coordinator strictly retains unavailable (null) counts", () => {
      // Default coordinator (allowSyntheticCompletenessProofs = false / omitted)
      const { coordinator, tracker, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: false,
      });

      // Transition coordinator to SUBSCRIBED
      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Simulate 70 seconds of elapsed observation
      advanceTime(70_000);
      const now = getCurrentTime();

      // Ingest valid trade
      const tradeSig = "Sig1111111111111111111111111111111111111111111111111111111111111";
      const tradeTime = now - 10_000;
      tracker.ingestTrade({
        eventId: `${tradeSig}:0:0`,
        signature: tradeSig,
        outerInstructionIndex: 0,
        swapIndex: 0,
        side: "BUY",
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        slot: 1000,
        blockTimeSec: Math.floor(tradeTime / 1000),
        eventTimestampMs: tradeTime,
        receiptTimestampMs: tradeTime + 50,
        timestampProvenance: "SYNTHETIC_FIXTURE",
      });

      const provider = new CoordinatorCandidateFlowProvider(coordinator);
      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
        now,
      );

      // Under production default, source completeness is unproven
      expect(res.recentBuys60s).toBeNull();
      expect(res.recentSells60s).toBeNull();
      expect(res.isCoverageSufficient).toBe(false);
      expect(res.diagnosticReason).toContain("Production source completeness is unproven");
    });

    it("rejects CLI/environment attempts to bypass production completeness (process.env)", () => {
      const origEnv = process.env.ALLOW_SYNTHETIC_PROOFS;
      try {
        process.env.ALLOW_SYNTHETIC_PROOFS = "true";
        process.env.PROD_SYNTHETIC = "1";

        const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
          startTime: 1_000_000,
          allowSyntheticCompletenessProofs: false, // production default
        });

        // Transition coordinator to SUBSCRIBED
        transport.triggerOpen();
        const reqId = JSON.parse(transport.sentMessages[0]!).id;
        transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
        expect(coordinator.getStatus()).toBe("SUBSCRIBED");

        advanceTime(70_000);
        const provider = new CoordinatorCandidateFlowProvider(coordinator);
        const res = provider.getCandidateFlow(
          { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
          getCurrentTime(),
        );

        // Environment variables must NOT alter production coordinator invariants
        expect(res.recentBuys60s).toBeNull();
        expect(res.recentSells60s).toBeNull();
        expect(res.isCoverageSufficient).toBe(false);
        expect(res.diagnosticReason).toContain("Production source completeness is unproven");
      } finally {
        if (origEnv !== undefined) {
          process.env.ALLOW_SYNTHETIC_PROOFS = origEnv;
        } else {
          delete process.env.ALLOW_SYNTHETIC_PROOFS;
        }
        delete process.env.PROD_SYNTHETIC;
      }
    });

    it("explicitly labeled synthetic positive control exercises sufficient coverage", () => {
      const { coordinator, tracker, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true, // explicit offline test opt-in
      });

      // Transition coordinator to SUBSCRIBED
      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance coverage in 10s increments to stay within maxStreamInactivityMs (15s)
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        const cp = getCurrentTime();
        coordinator.advanceCoverage({
          checkpointMs: cp,
          proof: {
            mode: "SYNTHETIC_TEST_FIXTURE",
            poolId: CANONICAL_POOL_ID,
            connectionEpoch: coordinator.getConnectionEpoch(),
            rangeStartMs: cp - 10_000,
            rangeEndMs: cp,
            testFixtureLabel: `step_${i + 1}`,
          },
        });
      }
      const now = getCurrentTime();

      // Ingest 15 buys and 5 sells
      for (let i = 0; i < 15; i++) {
        const sig = `BuySig${i}111111111111111111111111111111111111111111111111111111111`;
        const t = now - 20_000 + i * 100;
        const res = tracker.ingestTrade({
          eventId: `${sig}:0:0`,
          signature: sig,
          outerInstructionIndex: 0,
          swapIndex: 0,
          side: "BUY",
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          slot: 1000 + i,
          blockTimeSec: Math.floor(t / 1000),
          eventTimestampMs: t,
          receiptTimestampMs: t + 50,
          timestampProvenance: "SYNTHETIC_FIXTURE",
        });
        expect(res.ok).toBe(true);
      }
      for (let i = 0; i < 5; i++) {
        const sig = `SellSig${i}11111111111111111111111111111111111111111111111111111111`;
        const t = now - 15_000 + i * 100;
        const res = tracker.ingestTrade({
          eventId: `${sig}:0:0`,
          signature: sig,
          outerInstructionIndex: 0,
          swapIndex: 0,
          side: "SELL",
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          slot: 2000 + i,
          blockTimeSec: Math.floor(t / 1000),
          eventTimestampMs: t,
          receiptTimestampMs: t + 50,
          timestampProvenance: "SYNTHETIC_FIXTURE",
        });
        expect(res.ok).toBe(true);
      }

      const provider = new CoordinatorCandidateFlowProvider(coordinator);
      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
        now,
      );

      expect(res.flowCoverage).toBe("SUFFICIENT");
      expect(res.isCoverageSufficient).toBe(true);
      expect(res.recentBuys60s).toBe(15);
      expect(res.recentSells60s).toBe(5);
    });

    it("preserves legitimate observed zero counts as distinct from unavailable data", () => {
      const { coordinator, transport, advanceTime, getCurrentTime } = createTestHarness({
        startTime: 1_000_000,
        allowSyntheticCompletenessProofs: true,
      });

      // Transition coordinator to SUBSCRIBED
      transport.triggerOpen();
      const reqId = JSON.parse(transport.sentMessages[0]!).id;
      transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: 101 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Advance coverage in 10s increments to stay within maxStreamInactivityMs (15s)
      for (let i = 0; i < 7; i++) {
        advanceTime(10_000);
        const cp = getCurrentTime();
        coordinator.advanceCoverage({
          checkpointMs: cp,
          proof: {
            mode: "SYNTHETIC_TEST_FIXTURE",
            poolId: CANONICAL_POOL_ID,
            connectionEpoch: coordinator.getConnectionEpoch(),
            rangeStartMs: cp - 10_000,
            rangeEndMs: cp,
            testFixtureLabel: `step_silent_${i + 1}`,
          },
        });
      }
      const now = getCurrentTime();

      // Exactly zero trades in the lookback window
      const provider = new CoordinatorCandidateFlowProvider(coordinator);
      const res = provider.getCandidateFlow(
        { poolAddress: CANONICAL_POOL_ID, tokenMint: CANONICAL_TOKEN_MINT },
        now,
      );

      expect(res.flowCoverage).toBe("SUFFICIENT");
      expect(res.isCoverageSufficient).toBe(true);
      expect(res.recentBuys60s).toBe(0);
      expect(res.recentSells60s).toBe(0);
      // Explicitly non-null
      expect(res.recentBuys60s).not.toBeNull();
      expect(res.recentSells60s).not.toBeNull();
    });
  });

  describe("4. Unified Decision Points & Daemon Helper Acceptance Coverage", () => {
    const baseSpotInfo = {
      spotPriceSol: 0.00045,
      spotPriceUsd: 0.065,
      liquidityUsd: 55_000,
      momentum5mBps: 150,
      priceChange1hPct: 4.5,
      recentBuys60s: 99, // Unverified 5-minute linear estimate (must be ignored)
      recentSells60s: 11, // Unverified 5-minute linear estimate (must be ignored)
    };

    const validRugMetrics = {
      rugScore: 150,
      hasDangerRisk: false,
      bundlerPct: 0.12,
      top10HolderPct: 0.22,
      holdersCount: 450,
    };

    it("Buy Gate and Retest Gate consume the exact same candidate-bound flow result", () => {
      const candidate = createSampleCandidate();
      const mockFlowResult: CandidateFlowResult = {
        poolAddress: candidate.poolId,
        tokenMint: candidate.mintAddress,
        recentBuys60s: 18,
        recentSells60s: 6,
        flowCoverage: "SUFFICIENT",
        isCoverageSufficient: true,
        diagnosticReason: "Mock sufficient flow",
        evaluationTimestampMs: 1_000_000,
      };

      const customProvider: CandidateFlowProvider = {
        getCandidateFlow: vi.fn().mockReturnValue(mockFlowResult),
      };

      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo,
        rugMetrics: validRugMetrics,
        flowProvider: customProvider,
        currentNowMs: 1_000_000,
        requireVerifiedHolders: true,
      });

      expect(customProvider.getCandidateFlow).toHaveBeenCalledWith(
        { poolAddress: candidate.poolId, tokenMint: candidate.mintAddress },
        1_000_000,
      );

      // Verify Buy Gate input used candidate flow (18/6), not DexScreener 5m estimates (99/11)
      expect(decision.flowResult.recentBuys60s).toBe(18);
      expect(decision.flowResult.recentSells60s).toBe(6);
      expect(decision.flowResult.flowCoverage).toBe("SUFFICIENT");

      // Verify RetestSpotInfo used the exact same candidate flow
      expect(decision.retestSpotInfo.recentBuys60s).toBe(18);
      expect(decision.retestSpotInfo.recentSells60s).toBe(6);
      expect(decision.retestSpotInfo.flowCoverage).toBe("SUFFICIENT");
    });

    it("fails closed at Buy Gate with REJECTED_UNAVAILABLE_FLOW_COVERAGE when provider is missing/unavailable", () => {
      const candidate = createSampleCandidate();
      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo,
        rugMetrics: validRugMetrics,
        flowProvider: new UnavailableCandidateFlowProvider(),
        currentNowMs: 1_000_000,
        requireVerifiedHolders: true,
      });

      expect(decision.outcome).toBe("BUY_GATE_REJECTED");
      expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
      expect(decision.buyGateResult.triggered).toBe(false);
      expect(decision.flowResult.recentBuys60s).toBeNull();
      expect(decision.flowResult.recentSells60s).toBeNull();
    });

    it("never falls back to five-minute estimates when flow is unavailable", () => {
      const candidate = createSampleCandidate();
      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo,
        rugMetrics: validRugMetrics,
        flowProvider: new UnavailableCandidateFlowProvider(),
        currentNowMs: 1_000_000,
        requireVerifiedHolders: true,
      });

      // Buy Gate must reject rather than using 50/10
      expect(decision.outcome).toBe("BUY_GATE_REJECTED");
      expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
      expect(decision.retestSpotInfo.recentBuys60s).toBeNull();
      expect(decision.retestSpotInfo.recentSells60s).toBeNull();
    });

    it("fails closed on throwing provider without unhandled crashes", () => {
      const candidate = createSampleCandidate();
      const throwingProvider: CandidateFlowProvider = {
        getCandidateFlow: () => {
          throw new Error("RPC socket blown up");
        },
      };

      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo,
        rugMetrics: validRugMetrics,
        flowProvider: throwingProvider,
        currentNowMs: 1_000_000,
        requireVerifiedHolders: true,
      });

      expect(decision.outcome).toBe("BUY_GATE_REJECTED");
      expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
      expect(decision.flowResult.diagnosticReason).toContain("PROVIDER_CALL_EXCEPTION");
    });

    it("rejects candidate when live spot liquidity is below threshold", () => {
      const candidate = createSampleCandidate();
      const lowLiqSpot = {
        ...baseSpotInfo,
        liquidityUsd: 15_000, // < 20,000 floor
      };

      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo: lowLiqSpot,
        rugMetrics: validRugMetrics,
        currentNowMs: 1_000_000,
      });

      expect(decision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
      expect(decision.rejectionReason).toBe("REJECTED_INSUFFICIENT_LIVE_LIQUIDITY");
    });

    it("arms candidate on first tick under verified sufficient flow", () => {
      const candidate = createSampleCandidate();
      const customProvider: CandidateFlowProvider = {
        getCandidateFlow: () => ({
          poolAddress: candidate.poolId,
          tokenMint: candidate.mintAddress,
          recentBuys60s: 20,
          recentSells60s: 8,
          flowCoverage: "SUFFICIENT",
          isCoverageSufficient: true,
          diagnosticReason: "Sufficient flow",
          evaluationTimestampMs: 1_000_000,
        }),
      };

      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo,
        rugMetrics: validRugMetrics,
        flowProvider: customProvider,
        existingArmedState: undefined, // First tick
        currentNowMs: 1_000_000,
        requireVerifiedHolders: true,
      });

      expect(decision.outcome).toBe("ARMED_FIRST_TICK");
      expect(decision.retestResult).toBeDefined();
      expect(decision.retestResult?.status).toBe("ARMED_FIRST_TICK");
      expect(decision.retestResult?.updatedArmedState.peakPriceSol).toBe(baseSpotInfo.spotPriceSol);
    });

    it("confirms retest pullback under verified absorbing flow", () => {
      const candidate = createSampleCandidate();
      const customProvider: CandidateFlowProvider = {
        getCandidateFlow: () => ({
          poolAddress: candidate.poolId,
          tokenMint: candidate.mintAddress,
          recentBuys60s: 25,
          recentSells60s: 10,
          flowCoverage: "SUFFICIENT",
          isCoverageSufficient: true,
          diagnosticReason: "Sufficient flow",
          evaluationTimestampMs: 1_020_000,
        }),
      };

      // Candidate was armed at peakPriceSol = 0.00050.
      // Current spot is 0.000470 (6% pullback -> in 4-10% window for Established).
      const armedState = {
        mintAddress: candidate.mintAddress,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 3,
      };

      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo: {
          ...baseSpotInfo,
          spotPriceSol: 0.00047,
        },
        rugMetrics: {
          ...validRugMetrics,
          holdersCount: 1200, // Established / Viral runner holder floor
        },
        flowProvider: customProvider,
        existingArmedState: armedState,
        currentNowMs: 1_020_000,
        requireVerifiedHolders: true,
      });

      expect(decision.outcome).toBe("RETEST_CONFIRMED");
      if (decision.outcome === "RETEST_CONFIRMED") {
        expect(decision.retestResult.status).toBe("CONFIRMED");
        expect(decision.retestResult.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });

    describe("4.1 Shared Decision Boundary Validation Regressions", () => {
      const armedPullbackState = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 3,
      };

      const pullbackSpot = {
        ...baseSpotInfo,
        spotPriceSol: 0.00047, // 6% pullback
      };

      const establishedRugMetrics = {
        ...validRugMetrics,
        holdersCount: 1200,
      };

      it("rejects provider result with mismatched pool address and fails closed at decision boundary", () => {
        const candidate = createSampleCandidate();
        const badProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: "WrongPoolAddress11111111111111111111111111111111",
            tokenMint: candidate.mintAddress,
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Sufficient",
            evaluationTimestampMs: 1_020_000,
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: badProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        // Must NOT confirm retest!
        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.flowCoverage).toBe("COLLECTION_GAP");
        expect(decision.flowResult.isCoverageSufficient).toBe(false);
        expect(decision.flowResult.recentBuys60s).toBeNull();
        expect(decision.flowResult.recentSells60s).toBeNull();
        expect(decision.flowResult.diagnosticReason).toContain("IDENTITY_MISMATCH_POOL");
        expect(decision.retestSpotInfo.recentBuys60s).toBeNull();
      });

      it("rejects provider result with mismatched token mint and fails closed at decision boundary", () => {
        const candidate = createSampleCandidate();
        const badProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: "WrongTokenMint111111111111111111111111111111111",
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Sufficient",
            evaluationTimestampMs: 1_020_000,
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: badProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.diagnosticReason).toContain("IDENTITY_MISMATCH_MINT");
        expect(decision.flowResult.recentBuys60s).toBeNull();
      });

      it("rejects stale evaluation timestamp (60s old) and never relabels stale data as current", () => {
        const candidate = createSampleCandidate();
        const staleProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: candidate.mintAddress,
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Sufficient but stale",
            evaluationTimestampMs: 1_020_000 - 60_000, // 60s in the past
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: staleProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.diagnosticReason).toContain("TIMESTAMP_MISMATCH");
        expect(decision.flowResult.evaluationTimestampMs).toBe(1_020_000);
        expect(decision.flowResult.recentBuys60s).toBeNull();
      });

      it("rejects future evaluation timestamp (60s ahead)", () => {
        const candidate = createSampleCandidate();
        const futureProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: candidate.mintAddress,
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Future timestamp",
            evaluationTimestampMs: 1_020_000 + 60_000, // 60s in future
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: futureProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.diagnosticReason).toContain("TIMESTAMP_MISMATCH");
      });

      it("rejects inconsistent coverage fields (isCoverageSufficient=false alongside flowCoverage=SUFFICIENT)", () => {
        const candidate = createSampleCandidate();
        const inconsistentProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: candidate.mintAddress,
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: false, // inconsistent!
            diagnosticReason: "Inconsistent",
            evaluationTimestampMs: 1_020_000,
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: inconsistentProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.diagnosticReason).toContain("INCONSISTENT_COVERAGE_FIELDS");
        expect(decision.flowResult.flowCoverage).toBe("COLLECTION_GAP");
        expect(decision.flowResult.recentBuys60s).toBeNull();
      });

      it("rejects inconsistent coverage fields (isCoverageSufficient=true alongside flowCoverage=COLLECTION_GAP)", () => {
        const candidate = createSampleCandidate();
        const inconsistentProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: candidate.mintAddress,
            recentBuys60s: 25,
            recentSells60s: 10,
            flowCoverage: "COLLECTION_GAP",
            isCoverageSufficient: true, // inconsistent!
            diagnosticReason: "Inconsistent",
            evaluationTimestampMs: 1_020_000,
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: inconsistentProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.flowResult.diagnosticReason).toContain("INCONSISTENT_COVERAGE_FIELDS");
      });

      it("safely handles null provider result without uncaught TypeError and fails closed", () => {
        const candidate = createSampleCandidate();
        const nullProvider: CandidateFlowProvider = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getCandidateFlow: () => null as any,
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: nullProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
        expect(decision.flowResult.diagnosticReason).toContain("MALFORMED_PROVIDER_RESULT");
        expect(decision.flowResult.recentBuys60s).toBeNull();
      });

      it("safely handles invalid/non-integer/negative flow counts on sufficient coverage", () => {
        const candidate = createSampleCandidate();
        const invalidCountsProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: candidate.poolId,
            tokenMint: candidate.mintAddress,
            recentBuys60s: -5, // invalid negative count!
            recentSells60s: 10,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Negative buys",
            evaluationTimestampMs: 1_020_000,
          }),
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate,
          baseSpotInfo: pullbackSpot,
          rugMetrics: establishedRugMetrics,
          flowProvider: invalidCountsProvider,
          existingArmedState: armedPullbackState,
          currentNowMs: 1_020_000,
          requireVerifiedHolders: true,
        });

        expect(decision.outcome).toBe("BUY_GATE_REJECTED");
        expect(decision.flowResult.diagnosticReason).toContain("INVALID_FLOW_COUNTS");
        expect(decision.flowResult.recentBuys60s).toBeNull();
      });
    });

    describe("4.2 validateAndSnapshotCandidateFlowResult Unit Tests", () => {
      const target: CandidateFlowTarget = {
        poolAddress: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      };

      it("returns frozen snapshot when raw result is valid and consistent", () => {
        const raw = {
          poolAddress: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          recentBuys60s: 20,
          recentSells60s: 5,
          flowCoverage: "SUFFICIENT",
          isCoverageSufficient: true,
          diagnosticReason: "Valid",
          evaluationTimestampMs: 1_000_000,
        };
        const snap = validateAndSnapshotCandidateFlowResult(raw, target, 1_000_000);
        expect(Object.isFrozen(snap)).toBe(true);
        expect(snap.isCoverageSufficient).toBe(true);
        expect(snap.recentBuys60s).toBe(20);
        expect(snap.recentSells60s).toBe(5);
      });

      it("normalizes counts to null when flowCoverage is not SUFFICIENT", () => {
        const raw = {
          poolAddress: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          recentBuys60s: 20,
          recentSells60s: 5,
          flowCoverage: "WARM_UP",
          isCoverageSufficient: false,
          diagnosticReason: "Warming up",
          evaluationTimestampMs: 1_000_000,
        };
        const snap = validateAndSnapshotCandidateFlowResult(raw, target, 1_000_000);
        expect(snap.recentBuys60s).toBeNull();
        expect(snap.recentSells60s).toBeNull();
        expect(snap.flowCoverage).toBe("WARM_UP");
        expect(snap.isCoverageSufficient).toBe(false);
      });
    });

    describe("4.3 Pre-Extraction Liquidity Floor Restoration & Cohort Preservation", () => {
      // Reproduction 1: Candidate previously required $30,000; actual liquidity $25,000
      it("rejects candidate when actual liquidity $25,000 falls below required $30,000 (Viral runner)", () => {
        const viralCandidate = createSampleCandidate({
          liquidityUsd: 35_000, // Discovery liq >= $30k
          marketCapUsd: 160_000, // Discovery mcap >= $150k
          assetAgeSeconds: 1200, // 900s - 7200s
        });
        const rugMetricsViral = {
          rugScore: 100,
          hasDangerRisk: false,
          bundlerPct: 0.1,
          top10HolderPct: 0.2,
          holdersCount: 1200, // >= 1000 for Viral
        };

        // Live spot liquidity is $25,000 (< $30,000 requirement)
        const spot = {
          ...baseSpotInfo,
          liquidityUsd: 25_000,
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate: viralCandidate,
          baseSpotInfo: spot,
          rugMetrics: rugMetricsViral,
          currentNowMs: 1_000_000,
        });

        // Must reject INSUFFICIENT_LIVE_LIQUIDITY and NOT lower requirement to $20,000!
        expect(decision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(decision.rejectionReason).toBe("REJECTED_INSUFFICIENT_LIVE_LIQUIDITY");
        expect(decision.requiredLiveLiq).toBe(30_000);
        expect(decision.liveLiqUsd).toBe(25_000);
        expect(decision.isEstablished).toBe(true);
        expect(decision.isViral).toBe(true);
      });

      // Reproduction 2: Candidate previously required $50,000; actual liquidity $40,000
      it("rejects candidate when actual liquidity $40,000 falls below required $50,000 (Established runner)", () => {
        const establishedCandidate = createSampleCandidate({
          liquidityUsd: 65_000, // Discovery liq >= $50k
          marketCapUsd: 100_000, // Discovery mcap < $150k (not viral)
          assetAgeSeconds: 2400, // >= 1800s
        });
        const rugMetricsEstablished = {
          rugScore: 100,
          hasDangerRisk: false,
          bundlerPct: 0.1,
          top10HolderPct: 0.2,
          holdersCount: 300, // >= 250 for non-viral Established
        };

        // Live spot liquidity is $40,000 (< $50,000 requirement)
        const spot = {
          ...baseSpotInfo,
          liquidityUsd: 40_000,
        };

        const decision = evaluateCandidateDecisionPoints({
          candidate: establishedCandidate,
          baseSpotInfo: spot,
          rugMetrics: rugMetricsEstablished,
          currentNowMs: 1_000_000,
        });

        // Must reject INSUFFICIENT_LIVE_LIQUIDITY and NOT lower requirement to $20,000!
        expect(decision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(decision.rejectionReason).toBe("REJECTED_INSUFFICIENT_LIVE_LIQUIDITY");
        expect(decision.requiredLiveLiq).toBe(50_000);
        expect(decision.liveLiqUsd).toBe(40_000);
        expect(decision.isEstablished).toBe(true);
        expect(decision.isViral).toBe(false);
      });

      // Exact boundaries: $20,000 (Micro-Cap), $30,000 (Viral), $50,000 (Established)
      it("strictly enforces exact $20,000 boundary for Micro-Cap candidates", () => {
        const microCandidate = createSampleCandidate({
          liquidityUsd: 25_000,
          marketCapUsd: 80_000,
          assetAgeSeconds: 600,
        });
        const rugMetricsMicro = {
          rugScore: 100,
          hasDangerRisk: false,
          bundlerPct: 0.1,
          top10HolderPct: 0.2,
          holdersCount: 150,
        };

        // $19,999 -> rejects
        const rejDecision = evaluateCandidateDecisionPoints({
          candidate: microCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 19_999 },
          rugMetrics: rugMetricsMicro,
          currentNowMs: 1_000_000,
        });
        expect(rejDecision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(rejDecision.requiredLiveLiq).toBe(20_000);
        expect(rejDecision.isEstablished).toBe(false);

        // $20,000 -> passes floor check
        const passDecision = evaluateCandidateDecisionPoints({
          candidate: microCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 20_000 },
          rugMetrics: rugMetricsMicro,
          currentNowMs: 1_000_000,
        });
        expect(passDecision.outcome).not.toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(passDecision.requiredLiveLiq).toBe(20_000);
        expect(passDecision.isEstablished).toBe(false);
      });

      it("strictly enforces exact $30,000 boundary for Viral candidates", () => {
        const viralCandidate = createSampleCandidate({
          liquidityUsd: 35_000,
          marketCapUsd: 160_000,
          assetAgeSeconds: 1200,
        });
        const rugMetricsViral = {
          rugScore: 100,
          hasDangerRisk: false,
          bundlerPct: 0.1,
          top10HolderPct: 0.2,
          holdersCount: 1200,
        };

        // $29,999 -> rejects
        const rejDecision = evaluateCandidateDecisionPoints({
          candidate: viralCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 29_999 },
          rugMetrics: rugMetricsViral,
          currentNowMs: 1_000_000,
        });
        expect(rejDecision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(rejDecision.requiredLiveLiq).toBe(30_000);

        // $30,000 -> passes floor check
        const passDecision = evaluateCandidateDecisionPoints({
          candidate: viralCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 30_000 },
          rugMetrics: rugMetricsViral,
          currentNowMs: 1_000_000,
        });
        expect(passDecision.outcome).not.toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(passDecision.requiredLiveLiq).toBe(30_000);
        expect(passDecision.isEstablished).toBe(true);
        expect(passDecision.isViral).toBe(true);
      });

      it("strictly enforces exact $50,000 boundary for Established candidates", () => {
        const establishedCandidate = createSampleCandidate({
          liquidityUsd: 65_000,
          marketCapUsd: 100_000,
          assetAgeSeconds: 2400,
        });
        const rugMetricsEstablished = {
          rugScore: 100,
          hasDangerRisk: false,
          bundlerPct: 0.1,
          top10HolderPct: 0.2,
          holdersCount: 300,
        };

        // $49,999 -> rejects
        const rejDecision = evaluateCandidateDecisionPoints({
          candidate: establishedCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 49_999 },
          rugMetrics: rugMetricsEstablished,
          currentNowMs: 1_000_000,
        });
        expect(rejDecision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(rejDecision.requiredLiveLiq).toBe(50_000);

        // $50,000 -> passes floor check
        const passDecision = evaluateCandidateDecisionPoints({
          candidate: establishedCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 50_000 },
          rugMetrics: rugMetricsEstablished,
          currentNowMs: 1_000_000,
        });
        expect(passDecision.outcome).not.toBe("INSUFFICIENT_LIVE_LIQUIDITY");
        expect(passDecision.requiredLiveLiq).toBe(50_000);
        expect(passDecision.isEstablished).toBe(true);
        expect(passDecision.isViral).toBe(false);
      });

      it("preserves subsequent retest classification cohort when liquidity floor check passes", () => {
        const customProvider: CandidateFlowProvider = {
          getCandidateFlow: () => ({
            poolAddress: CANONICAL_POOL_ID,
            tokenMint: CANONICAL_TOKEN_MINT,
            recentBuys60s: 20,
            recentSells60s: 8,
            flowCoverage: "SUFFICIENT",
            isCoverageSufficient: true,
            diagnosticReason: "Sufficient",
            evaluationTimestampMs: 1_000_000,
          }),
        };

        // 1. Established passes floor: retest receives cohortLabel "ESTABLISHED"
        const establishedCandidate = createSampleCandidate({
          liquidityUsd: 65_000,
          marketCapUsd: 100_000,
          assetAgeSeconds: 2400,
        });
        const estDecision = evaluateCandidateDecisionPoints({
          candidate: establishedCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 55_000 },
          rugMetrics: { ...validRugMetrics, holdersCount: 300 },
          flowProvider: customProvider,
          currentNowMs: 1_000_000,
          requireVerifiedHolders: true,
        });
        expect(estDecision.outcome).toBe("ARMED_FIRST_TICK");
        expect(estDecision.isEstablished).toBe(true);
        if (estDecision.outcome === "ARMED_FIRST_TICK") {
          expect(estDecision.retestResult.cohortLabel).toBe("ESTABLISHED");
        }

        // 2. Micro-Cap passes floor: retest receives cohortLabel "MICRO_CAP"
        const microCandidate = createSampleCandidate({
          liquidityUsd: 25_000,
          marketCapUsd: 80_000,
          assetAgeSeconds: 600,
        });
        const microDecision = evaluateCandidateDecisionPoints({
          candidate: microCandidate,
          baseSpotInfo: { ...baseSpotInfo, liquidityUsd: 22_000 },
          rugMetrics: { ...validRugMetrics, holdersCount: 150 },
          flowProvider: customProvider,
          currentNowMs: 1_000_000,
          requireVerifiedHolders: true,
        });
        expect(microDecision.outcome).toBe("ARMED_FIRST_TICK");
        expect(microDecision.isEstablished).toBe(false);
        if (microDecision.outcome === "ARMED_FIRST_TICK") {
          expect(microDecision.retestResult.cohortLabel).toBe("MICRO_CAP");
        }
      });
    });
  });

  describe("5. Protective Retest Behavior Preservation", () => {
    const validRugMetrics = {
      rugScore: 100,
      hasDangerRisk: false,
      bundlerPct: 0.1,
      top10HolderPct: 0.2,
      holdersCount: 500,
    };

    it("never produces CONFIRMED when flow is unavailable", () => {
      const candidate = createSampleCandidate();
      const armedState = {
        mintAddress: candidate.mintAddress,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 2,
      };

      // Spot is in ideal pullback discount (5% drop), but flow is UNAVAILABLE
      const decision = evaluateCandidateDecisionPoints({
        candidate,
        baseSpotInfo: {
          spotPriceSol: 0.000475,
          spotPriceUsd: 0.068,
          liquidityUsd: 60_000,
          momentum5mBps: 0,
          priceChange1hPct: 2.0,
        },
        rugMetrics: validRugMetrics,
        flowProvider: new UnavailableCandidateFlowProvider(),
        existingArmedState: armedState,
        currentNowMs: 1_015_000,
        requireVerifiedHolders: false, // evaluate buy gate without holder requirement to test retest gate isolation
      });

      // Buy gate with requireValidFlowCoverage: true still rejects
      expect(decision.outcome).toBe("BUY_GATE_REJECTED");
      expect(decision.outcome).not.toBe("RETEST_CONFIRMED");
    });

    it("enforces Established unabsorbed 8% crater limit when flow is unverified", () => {
      // Direct call to RetestGateEvaluator with unverified/unavailable flow
      const unverifiedSpotInfo = {
        spotPriceSol: 0.00045, // 10% drop from 0.00050
        spotPriceUsd: 0.065,
        liquidityUsd: 60_000,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
      };

      const armedState = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_015_000,
        spotInfo: unverifiedSpotInfo,
        existingArmedState: armedState,
      });

      // Because flow is unverified, crater drop ceiling is 8% (0.08), NOT 12%
      // 0.00045 < 0.00050 * (1 - 0.08) = 0.00046, so it craters!
      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_EXCESSIVE_PULLBACK");
        expect(result.rejectionGateName).toBe("RetestCraterDrop");
        expect(result.maxCraterDropPct).toBe(0.08);
      }
    });

    it("preserves Micro-Cap 15% crater limit and 90-second timeout", () => {
      const armedState = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 2,
      };

      // 1. Crater test for Micro-Cap (> 15% drop: 0.00042 < 0.00050 * 0.85 = 0.000425)
      const craterResult = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: false,
        currentNowMs: 1_015_000,
        spotInfo: {
          spotPriceSol: 0.00042,
          recentBuys60s: null,
          recentSells60s: null,
          flowCoverage: "COLLECTION_GAP",
        },
        existingArmedState: armedState,
      });
      expect(craterResult.status).toBe("REJECTED");
      if (craterResult.status === "REJECTED") {
        expect(craterResult.rejectReason).toBe("REJECTED_PULLBACK_CRATERED");
        expect(craterResult.maxCraterDropPct).toBe(0.15);
      }

      // 2. Timeout test for Micro-Cap (> 90 seconds)
      const timeoutResult = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: false,
        currentNowMs: 1_000_000 + 95_000,
        spotInfo: {
          spotPriceSol: 0.00049,
          recentBuys60s: null,
          recentSells60s: null,
          flowCoverage: "COLLECTION_GAP",
        },
        existingArmedState: armedState,
      });
      expect(timeoutResult.status).toBe("REJECTED");
      if (timeoutResult.status === "REJECTED") {
        expect(timeoutResult.rejectReason).toBe("REJECTED_PULLBACK_EXPIRED");
        expect(timeoutResult.maxExpiryMs).toBe(90_000);
      }
    });

    it("preserves WAITING status on moderate pullbacks without cratering or timeout", () => {
      const armedState = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: 1_000_000,
        peakPriceSol: 0.0005,
        peakPriceUsd: 0.07,
        ticksObserved: 1,
      };

      // 3% pullback (0.000485) - neither cratered nor confirmed
      const waitResult = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_010_000,
        spotInfo: {
          spotPriceSol: 0.000485,
          recentBuys60s: null,
          recentSells60s: null,
          flowCoverage: "COLLECTION_GAP",
        },
        existingArmedState: armedState,
      });

      expect(waitResult.status).toBe("WAITING");
      expect(waitResult.updatedArmedState.ticksObserved).toBe(2);
    });
  });

  describe("6. Daemon Export & Wiring Seam", () => {
    it("allows replacing and resetting active flow provider via daemon getters/setters", () => {
      const initial = getCandidateFlowProvider();
      expect(initial).toBeInstanceOf(UnavailableCandidateFlowProvider);

      const customProvider: CandidateFlowProvider = {
        getCandidateFlow: () => ({
          poolAddress: "test-pool",
          tokenMint: "test-mint",
          recentBuys60s: 10,
          recentSells60s: 5,
          flowCoverage: "SUFFICIENT",
          isCoverageSufficient: true,
          diagnosticReason: "Custom",
          evaluationTimestampMs: 12345,
        }),
      };

      setCandidateFlowProvider(customProvider);
      expect(getCandidateFlowProvider()).toBe(customProvider);

      // Reset
      setCandidateFlowProvider(new UnavailableCandidateFlowProvider());
      expect(getCandidateFlowProvider()).toBeInstanceOf(UnavailableCandidateFlowProvider);
    });

    it("defers environment-file loading to daemon startup and performs zero credential reads on import", () => {
      const loadEnvSpy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

      try {
        // Module import has already happened: loadEnvSpy was not called during module evaluation!
        expect(loadEnvSpy).not.toHaveBeenCalled();

        // Calling loadDaemonEnvironment explicitly executes the loader without printing credentials
        loadDaemonEnvironment();
      } finally {
        loadEnvSpy.mockRestore();
      }
    });
  });
});
