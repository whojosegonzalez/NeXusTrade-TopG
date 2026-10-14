import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  BASE_NETWORK_FEE_LAMPORTS,
  calculateEntryFees,
  calculateExitFees,
  computePriorityFeeLamports,
  DEFAULT_COMPUTE_UNITS,
  DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU,
  DEFAULT_RAYDIUM_AMM_FEE_RATE,
  LAMPORTS_PER_SOL,
} from "./ExecutionFeeModel.js";
import {
  calculateAmmBuyQuote,
  calculateAmmSellQuote,
  createDeterministicAmmQuote,
  simulateFill,
  validateMintDecimals,
  validateQuoteExpiration,
  validateQuoteLookahead,
  verifyRoutePlanPool,
  WSOL_MINT,
} from "./QuoteExecutionEngine.js";
import { computeRealizedExitReturn, evaluateSellability } from "./SellabilityValidator.js";
import { analyzeCapacityCurve } from "./CapacityCurveAnalyzer.js";
import {
  ExecutionStorageManager,
  verifySessionCrossFileConsistency,
} from "./ExecutionStorageManager.js";
import type { RoutePlanStep } from "./ExecutionTypes.js";

describe("Phase 12.94-C: Quote-Aware Execution Realism Test Suite", () => {
  // Test Pool State: Standard Raydium Pool with 100 SOL and 1,000,000 Tokens (Base Price = 0.0001 SOL)
  const TEST_POOL_ID = "RaydiumPoolTest11111111111111111111111111111";
  const TEST_MINT = "TokenMintTest1111111111111111111111111111111";
  const BASE_RESERVE_TOKENS = 1_000_000;
  const QUOTE_RESERVE_SOL = 100;
  const TOKEN_DECIMALS = 6;

  describe("Fixture F1: Liquid Direct Route (0.5 SOL Buy and Sell)", () => {
    it("accurately computes entry fees, LP fee, price impact, and net tokens", () => {
      const tradeSizeSol = 0.5;
      const sizeLamports = tradeSizeSol * LAMPORTS_PER_SOL;

      // 1. Fee Breakdown Check
      const fees = calculateEntryFees({
        sizeLamports,
        dexFeeRate: DEFAULT_RAYDIUM_AMM_FEE_RATE,
        isNewAta: false,
        computeUnits: DEFAULT_COMPUTE_UNITS,
        microLamportsPerCu: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU,
      });

      expect(fees.baseFeeLamports).toBe(BASE_NETWORK_FEE_LAMPORTS); // 5,000
      expect(fees.priorityFeeLamports).toBe(10_000); // 200k CU * 50k microLamports / 1M = 10,000
      expect(fees.dexFeeLamports).toBe(1_250_000); // 0.5 SOL * 0.25% = 0.00125 SOL = 1,250,000 lamports
      expect(fees.ataCreationRentLamports).toBe(0);
      expect(fees.totalFeeLamports).toBe(5000 + 10000 + 1250000);

      // 2. Buy Quote Check
      const buyQuote = calculateAmmBuyQuote({
        inputSol: tradeSizeSol,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
      });

      // Price impact = 0.5 / (100 + 0.5) = 0.5 / 100.5 ≈ 0.004975 (0.4975%)
      expect(buyQuote.priceImpactPct).toBeCloseTo(0.004975, 4);
      // Effective input = 0.5 * (1 - 0.0025) = 0.49875 SOL
      // Tokens = 1,000,000 * 0.49875 / (100 + 0.49875) ≈ 4962.75
      expect(buyQuote.tokensGross).toBeCloseTo(4962.75, 1);
      expect(buyQuote.effectivePriceSol).toBeCloseTo(0.5 / 4962.75, 6);

      // 3. Full Quote Record & Simulation
      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f1",
        generationId: "gen-1",
        decisionEventId: "decision-f1",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: tradeSizeSol,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
      });

      expect(quote.routeType).toBe("DIRECT_TRACKED_POOL");
      expect(quote.inputMint).toBe(WSOL_MINT);
      expect(quote.outputMint).toBe(TEST_MINT);

      const fill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        executionDelayMs: 100,
      });

      expect(fill.side).toBe("BUY");
      expect(fill.filledSizeSol).toBe(0.5);
      expect(fill.filledTokens).toBeCloseTo(4962.75, 1);
      expect(fill.sellabilityStatus).toBe("FULLY_SELLABLE");
      expect(fill.fillSlot).toBe(101); // 100 + floor(100/400) + 1
    });

    it("accurately computes exit fees and net SOL proceeds on sell leg", () => {
      const tokensToSell = 4962.8;

      const sellQuote = calculateAmmSellQuote({
        inputTokens: tokensToSell,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
      });

      expect(sellQuote.solGross).toBeCloseTo(0.4914, 2);

      const exitFees = calculateExitFees({
        grossSolProceedsLamports: Math.round(sellQuote.solGross * LAMPORTS_PER_SOL),
      });
      expect(exitFees.baseFeeLamports).toBe(BASE_NETWORK_FEE_LAMPORTS);
      expect(exitFees.dexFeeLamports).toBeGreaterThan(0);

      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f1",
        generationId: "gen-1",
        decisionEventId: "decision-f1-sell",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "SELL",
        tradeSizeSolOrTokens: tokensToSell,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 20_000,
        contextSlot: 120,
      });

      const fill = simulateFill(quote, {
        decisionTimestampMs: 20_000,
        decisionSlot: 120,
      });

      expect(fill.side).toBe("SELL");
      expect(fill.netProceedsSol).toBeGreaterThan(0.48);
      expect(fill.sellabilityStatus).toBe("FULLY_SELLABLE");
    });
  });

  describe("Fixture F2: Size Scaling and Capital Capacity Curves", () => {
    it("demonstrates monotonic increase in price impact across 0.1, 0.5, 2.0, 10.0 SOL tiers", () => {
      const curve = analyzeCapacityCurve({
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        exitPriceMultiplier: 1.05, // +5% price increase at exit
      });

      expect(curve.sweeps).toHaveLength(4);
      const [t1, t2, t3, t4] = curve.sweeps;

      // Price impacts must monotonically increase
      expect(t1!.priceImpactBps).toBeLessThan(t2!.priceImpactBps);
      expect(t2!.priceImpactBps).toBeLessThan(t3!.priceImpactBps);
      expect(t3!.priceImpactBps).toBeLessThan(t4!.priceImpactBps);

      // Effective purchase price must increase with trade size
      expect(t1!.effectivePriceSol).toBeLessThan(t2!.effectivePriceSol);
      expect(t2!.effectivePriceSol).toBeLessThan(t3!.effectivePriceSol);
      expect(t3!.effectivePriceSol).toBeLessThan(t4!.effectivePriceSol);

      // Check optimal size S* and extinction threshold S_extinct
      expect(curve.isEconomicallyViable).toBe(true);
      expect(curve.optimalSizeSol).toBeDefined();
    });

    it("identifies alpha extinction threshold when price impact extinguishes positive expectancy", () => {
      // Very illiquid pool: 5 SOL reserve
      const illiquidCurve = analyzeCapacityCurve({
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        baseReserveTokens: 50_000,
        quoteReserveSol: 5,
        tokenDecimals: TOKEN_DECIMALS,
        exitPriceMultiplier: 1.02, // slight +2% gain wiped out by impact
      });

      // Large trade on 5 SOL pool will extinguish alpha
      expect(illiquidCurve.alphaExtinctionThresholdSol).toBeDefined();
      expect(illiquidCurve.alphaExtinctionThresholdSol).toBeLessThan(5.0);
    });
  });

  describe("Fixture F3: Unsellable Honeypot / Zero Route / Rug Drain Accounting", () => {
    it("evaluates no-route condition as -100% total loss", () => {
      const evaluation = evaluateSellability({ hasRoute: false });
      expect(evaluation.status).toBe("UNSELLABLE_NO_ROUTE");
      expect(evaluation.isSellable).toBe(false);

      const realized = computeRealizedExitReturn(0.5, 0.8, evaluation.status);
      expect(realized.netPnlSol).toBe(-0.5);
      expect(realized.netReturnPct).toBe(-100.0);
    });

    it("evaluates honeypot simulation error as -100% total loss", () => {
      const evaluation = evaluateSellability({
        hasRoute: true,
        simulationError: "custom program error: 0x117 (HoneypotTransferRestricted)",
      });
      expect(evaluation.status).toBe("UNSELLABLE_TRANSFER_RESTRICTION");
      expect(evaluation.isSellable).toBe(false);

      const realized = computeRealizedExitReturn(0.5, 1.2, evaluation.status);
      expect(realized.netPnlSol).toBe(-0.5);
      expect(realized.netReturnPct).toBe(-100.0);
    });

    it("evaluates active freeze authority as -100% total loss", () => {
      const evaluation = evaluateSellability({
        hasRoute: true,
        freezeAuthorityActive: true,
      });
      expect(evaluation.status).toBe("UNSELLABLE_TRANSFER_RESTRICTION");
      expect(evaluation.isSellable).toBe(false);

      const realized = computeRealizedExitReturn(0.5, 0.7, evaluation.status);
      expect(realized.netReturnPct).toBe(-100.0);
    });

    it("evaluates reserve collapse rug pull as -100% total loss", () => {
      const evaluation = evaluateSellability({
        hasRoute: true,
        initialBaseReserve: 1_000_000,
        currentBaseReserve: 50_000, // 95% drained
      });
      expect(evaluation.status).toBe("UNSELLABLE_LIQUIDITY_DRAINED");
      expect(evaluation.isSellable).toBe(false);

      const realized = computeRealizedExitReturn(0.5, 0.1, evaluation.status);
      expect(realized.netReturnPct).toBe(-100.0);
    });

    it("evaluates catastrophic price impact (>30%) as -100% loss", () => {
      const evaluation = evaluateSellability({
        hasRoute: true,
        priceImpactPct: 0.35, // 35% impact
      });
      expect(evaluation.status).toBe("UNSELLABLE_EXCESSIVE_IMPACT");
      expect(evaluation.isSellable).toBe(false);

      const realized = computeRealizedExitReturn(0.5, 0.3, evaluation.status);
      expect(realized.netReturnPct).toBe(-100.0);
    });
  });

  describe("Fixture F4: Cross-Pool Contamination Attempt (Fail Closed)", () => {
    it("rejects route quote when primary AMM key mismatches candidate tracked pool", () => {
      const mismatchedRoutePlan: readonly RoutePlanStep[] = [
        {
          ammKey: "DifferentPool9999999999999999999999999999999",
          label: "Raydium V4",
          inputMint: WSOL_MINT,
          outputMint: TEST_MINT,
          feePct: 0.0025,
        },
      ];

      const verification = verifyRoutePlanPool(mismatchedRoutePlan, TEST_POOL_ID);
      expect(verification.valid).toBe(false);
      expect(verification.routeType).toBe("CROSS_POOL_DIVERGENCE");

      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f4",
        generationId: "gen-1",
        decisionEventId: "decision-f4",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: 0.5,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
        simulatedRoutePlan: mismatchedRoutePlan,
      });

      expect(quote.routeType).toBe("CROSS_POOL_DIVERGENCE");

      // Filling this quote must fail closed with [CROSS_POOL_CONTAMINATION]
      expect(() =>
        simulateFill(quote, {
          decisionTimestampMs: 10_000,
          decisionSlot: 100,
        }),
      ).toThrow(/CROSS_POOL_CONTAMINATION/);
    });
  });

  describe("Fixture F5: Quote Expiration and Stale Slot Lookahead Enforcement", () => {
    it("fails closed when quote is initiated prior to decision timestamp", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f5",
        generationId: "gen-1",
        decisionEventId: "decision-f5-lookahead",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: 0.5,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 9_000, // initiated at 9s
        contextSlot: 99,
      });

      // Decision event is at 10s: quote at 9s has lookahead bias
      const lookaheadCheck = validateQuoteLookahead(quote, 10_000, 100);
      expect(lookaheadCheck.valid).toBe(false);

      expect(() =>
        simulateFill(quote, {
          decisionTimestampMs: 10_000,
          decisionSlot: 100,
        }),
      ).toThrow(/LOOKAHEAD_VIOLATION/);
    });

    it("fails closed when quote context slot is prior to decision slot", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f5",
        generationId: "gen-1",
        decisionEventId: "decision-f5-stale-slot",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: 0.5,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 95, // slot 95 vs decision slot 100
      });

      const slotCheck = validateQuoteLookahead(quote, 10_000, 100);
      expect(slotCheck.valid).toBe(false);

      expect(() =>
        simulateFill(quote, {
          decisionTimestampMs: 10_000,
          decisionSlot: 100,
        }),
      ).toThrow(/STALE_SLOT_VIOLATION/);
    });

    it("fails closed when quote has expired past TTL before fill execution", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-test-f5",
        generationId: "gen-1",
        decisionEventId: "decision-f5-expired",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: 0.5,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
        ttlMs: 5_000, // 5s TTL -> expires at ~15,025ms
      });

      expect(validateQuoteExpiration(quote, 20_000)).toBe(false);
      expect(validateQuoteExpiration(quote, 12_000)).toBe(true);

      // Attempt fill 10 seconds later (delay 10,000ms)
      expect(() =>
        simulateFill(quote, {
          decisionTimestampMs: 10_000,
          decisionSlot: 100,
          executionDelayMs: 10_000,
        }),
      ).toThrow(/QUOTE_EXPIRED/);
    });
  });

  describe("Fixture F6: Priority Fee Congestion Spike Modeling", () => {
    it("models high priority fee drag during network congestion (500,000 micro-lamports/CU)", () => {
      const normalPrio = computePriorityFeeLamports({
        computeUnits: 200_000,
        microLamportsPerCu: 50_000,
      });
      expect(normalPrio).toBe(10_000); // 0.00001 SOL

      const congestedPrio = computePriorityFeeLamports({
        computeUnits: 200_000,
        microLamportsPerCu: 500_000,
      });
      expect(congestedPrio).toBe(100_000); // 0.0001 SOL (10x increase)

      const entryFeesCongested = calculateEntryFees({
        sizeLamports: 0.1 * LAMPORTS_PER_SOL, // small 0.1 SOL trade
        microLamportsPerCu: 500_000,
      });

      // Total fee on 0.1 SOL includes 5000 base + 100000 prio + 250000 DEX fee = 355000 lamports = 0.000355 SOL
      expect(entryFeesCongested.totalFeeLamports).toBe(355_000);
      expect(entryFeesCongested.priorityFeeLamports).toBe(100_000);
    });
  });

  describe("Fixture F7: End-to-End Session Consistency Validator", () => {
    it("verifies clean consistent session files pass validation", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f7-clean-"));
      try {
        const meta = {
          sessionId: "session-f7-clean",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
          isInterruptedSession: false,
        };
        const summary = {
          sessionId: "session-f7-clean",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          closedAtIso: "2026-10-14T11:00:00.000Z",
          totalCandidatesScreened: 1,
          totalDecisionsRecorded: 1,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 1,
            watchlistRadar: 0,
            triggerRejected: 0,
            executedBuy: 0,
          },
          topRejectionReasons: {},
          totalMarketObservationsRecorded: 0,
          totalStratifiedCandidatesTracked: 0,
          missedWinnersCount: 0,
          avoidedRugsCount: 0,
          isCompleteSession: true,
          isInterruptedSession: false,
        };

        fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify(meta), "utf8");
        fs.writeFileSync(
          path.join(tempDir, "session-summary.json"),
          JSON.stringify(summary),
          "utf8",
        );
        fs.writeFileSync(
          path.join(tempDir, "candidate-decisions.jsonl"),
          JSON.stringify({ eventId: "ev-1", sessionId: "session-f7-clean" }) + "\n",
          "utf8",
        );

        const result = verifySessionCrossFileConsistency(tempDir);
        expect(result.valid).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed on generation ID mismatch between meta and summary", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f7-mismatch-"));
      try {
        const meta = {
          sessionId: "session-f7-mismatch",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
        };
        const summary = {
          sessionId: "session-f7-mismatch",
          generationId: "gen-2", // mismatched generation ID!
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          closedAtIso: "2026-10-14T11:00:00.000Z",
          totalCandidatesScreened: 0,
          totalDecisionsRecorded: 0,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 0,
            watchlistRadar: 0,
            triggerRejected: 0,
            executedBuy: 0,
          },
          topRejectionReasons: {},
          totalMarketObservationsRecorded: 0,
          totalStratifiedCandidatesTracked: 0,
          missedWinnersCount: 0,
          avoidedRugsCount: 0,
        };

        fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify(meta), "utf8");
        fs.writeFileSync(
          path.join(tempDir, "session-summary.json"),
          JSON.stringify(summary),
          "utf8",
        );

        const result = verifySessionCrossFileConsistency(tempDir);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("Generation ID mismatch");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed when interrupted session is falsely marked as complete in summary", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "f7-interrupted-"));
      try {
        const meta = {
          sessionId: "session-f7-interrupted",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
          isInterruptedSession: true,
        };
        const summary = {
          sessionId: "session-f7-interrupted",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          closedAtIso: "2026-10-14T11:00:00.000Z",
          totalCandidatesScreened: 0,
          totalDecisionsRecorded: 0,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 0,
            watchlistRadar: 0,
            triggerRejected: 0,
            executedBuy: 0,
          },
          topRejectionReasons: {},
          totalMarketObservationsRecorded: 0,
          totalStratifiedCandidatesTracked: 0,
          missedWinnersCount: 0,
          avoidedRugsCount: 0,
          isCompleteSession: true, // Invalid: marked complete while interrupted!
          isInterruptedSession: true,
        };

        fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify(meta), "utf8");
        fs.writeFileSync(
          path.join(tempDir, "session-summary.json"),
          JSON.stringify(summary),
          "utf8",
        );

        const result = verifySessionCrossFileConsistency(tempDir);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("interrupted session marked as complete");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Mint Decimals Validation", () => {
    it("accepts valid integer decimals 0 through 18", () => {
      expect(validateMintDecimals(6)).toBe(6);
      expect(validateMintDecimals(9)).toBe(9);
      expect(validateMintDecimals(0)).toBe(0);
      expect(validateMintDecimals(18)).toBe(18);
    });

    it("fails closed on non-integer, negative, or excessive decimals", () => {
      expect(() => validateMintDecimals(null)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(undefined)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(6.5)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(-1)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(19)).toThrow(/INVALID_DECIMALS/);
    });
  });

  describe("Execution Storage Append and Read", () => {
    it("appends and reads quotes with atomic fsync durability", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-storage-test-"));
      try {
        const storage = new ExecutionStorageManager(tempDir);
        const quote = createDeterministicAmmQuote({
          sessionId: "session-storage-1",
          generationId: "gen-1",
          decisionEventId: "ev-storage-1",
          mintAddress: TEST_MINT,
          poolId: TEST_POOL_ID,
          side: "BUY",
          tradeSizeSolOrTokens: 0.5,
          baseReserveTokens: BASE_RESERVE_TOKENS,
          quoteReserveSol: QUOTE_RESERVE_SOL,
          tokenDecimals: TOKEN_DECIMALS,
          quoteInitiatedMs: 10_000,
          contextSlot: 100,
        });

        storage.recordQuote(quote);
        const quotes = storage.getQuotesForSession("session-storage-1");
        expect(quotes).toHaveLength(1);
        expect(quotes[0]!.quoteId).toBe(quote.quoteId);
        expect(quotes[0]!.inAmountUi).toBe(0.5);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
