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
  validateFeeRate,
} from "./ExecutionFeeModel.js";
import {
  atomicToUiNumber,
  calculateAmmBuyQuote,
  calculateAmmSellQuote,
  createDeterministicAmmQuote,
  simulateFill,
  toAtomicUnitsString,
  validateMintDecimals,
  validateQuoteExpiration,
  validateQuoteLookahead,
  validateSlippageBps,
  verifyRoutePlanPool,
  WSOL_MINT,
} from "./QuoteExecutionEngine.js";
import {
  computeRealizedExitReturn,
  estimateConservativeValuation,
  evaluateSellability,
} from "./SellabilityValidator.js";
import { analyzeCapacityCurve } from "./CapacityCurveAnalyzer.js";
import {
  ExecutionStorageManager,
  verifySessionCrossFileConsistency,
} from "./ExecutionStorageManager.js";
import type { RoutePlanStep } from "./ExecutionTypes.js";

describe("Phase 12.94-C: Quote-Aware Execution Realism Test Suite (Refined)", () => {
  const TEST_POOL_ID = "RaydiumPoolTest11111111111111111111111111111";
  const TEST_MINT = "TokenMintTest1111111111111111111111111111111";
  const BASE_RESERVE_TOKENS = 1_000_000;
  const QUOTE_RESERVE_SOL = 100;
  const TOKEN_DECIMALS = 6;

  describe("RF-1: Conserved-Value Round-Trip (Finding C1: No Double-Counted LP Fees)", () => {
    it("internalizes the LP fee inside AMM curve and debits wallet cash only for external network fees", () => {
      const tradeSizeSol = 0.5;
      const sizeLamports = tradeSizeSol * LAMPORTS_PER_SOL;

      // 1. Fee Breakdown Check: dexFeeLamports is recorded for info, NOT debited from wallet
      const entryFees = calculateEntryFees({
        sizeLamports,
        dexFeeRate: DEFAULT_RAYDIUM_AMM_FEE_RATE, // 0.0025
        isNewAta: false,
        computeUnits: DEFAULT_COMPUTE_UNITS,
        microLamportsPerCu: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU,
      });

      expect(entryFees.baseNetworkFeeLamports).toBe(BASE_NETWORK_FEE_LAMPORTS); // 5,000
      expect(entryFees.priorityFeeLamports).toBe(10_000); // 10,000
      expect(entryFees.externalNetworkFeeLamports).toBe(15_000); // 0.000015 SOL
      expect(entryFees.poolInternalFeeLamports).toBe(1_250_000); // 0.00125 SOL (internal)
      // Assert: Out-of-pocket wallet debit contains ONLY external network fee, NO LP fee!
      expect(entryFees.totalOutOfPocketFeeLamports).toBe(15_000);
      expect(entryFees.totalOutOfPocketFeeSol).toBe(0.000015);

      // 2. Buy Leg
      const buyQuote = calculateAmmBuyQuote({
        inputSol: tradeSizeSol,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        dexFeeRate: 0.0025,
      });

      // Expected tokens bought: 1,000,000 * 0.49875 / 100.49875 ≈ 4962.748293
      expect(buyQuote.tokensGross).toBeCloseTo(4962.748293, 4);

      // 3. State-Conserving Sell Leg back into the exact post-buy pool state:
      // R_sol,1 = 100 + 0.5 = 100.5 SOL
      // R_token,1 = 1,000,000 - 4962.748293 = 995,037.251707 tokens
      const postBuyReserveSol = 100.5;
      const postBuyReserveTokens = BASE_RESERVE_TOKENS - buyQuote.tokensGross;

      const sellQuote = calculateAmmSellQuote({
        inputTokens: buyQuote.tokensGross,
        baseReserveTokens: postBuyReserveTokens,
        quoteReserveSol: postBuyReserveSol,
        tokenDecimals: TOKEN_DECIMALS,
        dexFeeRate: 0.0025,
      });

      // Independent mathematical prediction:
      // Effective tokens sold: 4962.748293 * (1 - 0.0025) = 4950.341422
      // Gross SOL returned: 100.5 * 4950.341422 / (995,037.251707 + 4950.341422) ≈ 0.4975154862 SOL
      expect(sellQuote.solGross).toBeCloseTo(0.4975154862, 6);

      // 4. Exit Fee Check
      const exitFees = calculateExitFees({
        grossSolProceedsLamports: Math.round(sellQuote.solGross * LAMPORTS_PER_SOL),
        dexFeeRate: 0.0025,
        closeAta: false,
        computeUnits: DEFAULT_COMPUTE_UNITS,
        microLamportsPerCu: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS_PER_CU,
      });

      expect(exitFees.totalOutOfPocketFeeLamports).toBe(15_000);
      expect(exitFees.totalOutOfPocketFeeSol).toBe(0.000015);

      // Net round-trip wallet proceeds: Gross SOL - external exit network fee
      const netExitProceedsSol = sellQuote.solGross - exitFees.totalOutOfPocketFeeSol;
      expect(netExitProceedsSol).toBeCloseTo(0.4975154862 - 0.000015, 6);

      // Total round-trip cost = initial input (0.5) + entry network fee (0.000015)
      const totalEntryCostSol = 0.5 + entryFees.totalOutOfPocketFeeSol;
      const roundTripPnlSol = netExitProceedsSol - totalEntryCostSol;

      // The only round-trip loss is the 2x 25-bps LP swap fee (~0.0024845 SOL) + 2x network fee (0.000030 SOL)
      expect(roundTripPnlSol).toBeCloseTo(0.4975004862 - 0.500015, 6);
      expect(roundTripPnlSol).toBeGreaterThan(-0.003); // Total drag < 0.003 SOL
    });

    it("computes priority fees deterministically from compute units and price", () => {
      expect(
        computePriorityFeeLamports({ computeUnits: 200_000, microLamportsPerCu: 50_000 }),
      ).toBe(10_000);
    });
  });

  describe("RF-2: State-Conserving Pool Transition in Capacity Analysis (Finding C2)", () => {
    it("updates pool reserve state post-buy and executes exit on coherent reserve state", () => {
      const curve = analyzeCapacityCurve({
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        exitPriceMultiplier: 1.0, // Neutral roundtrip
      });

      expect(curve.sweeps).toHaveLength(4);
      const sweep05 = curve.sweeps.find((s) => Math.abs(s.tierSizeSol - 0.5) < 0.01)!;

      // Verify post-buy reserves reflect the buy addition and token extraction
      expect(sweep05.postBuyReserveSol).toBe(100.5);
      expect(sweep05.postBuyReserveTokens).toBeCloseTo(1_000_000 - 4962.748293, 4);

      // Verify gross exit proceeds match the exact state-conserving 0.497515 SOL
      expect(sweep05.grossExitProceedsSol).toBeCloseTo(0.497515, 4);

      // In a neutral roundtrip, PnL is negative strictly due to pool fees + network fees
      expect(sweep05.netPnlSol).toBeLessThan(0);
      expect(sweep05.netReturnPct).toBeCloseTo(-0.5029, 2); // ~ -0.50% drag
    });

    it("coherently models exogenous price appreciation and identifies alpha extinction threshold", () => {
      // Small 5 SOL pool with +5% gain but 10% reserve withdrawal by other traders
      const illiquidCurve = analyzeCapacityCurve({
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        baseReserveTokens: 50_000,
        quoteReserveSol: 5,
        tokenDecimals: TOKEN_DECIMALS,
        exitPriceMultiplier: 1.05,
        reserveWithdrawalRatio: 0.1,
      });

      expect(illiquidCurve.alphaExtinctionThresholdSol).toBeDefined();
      expect(illiquidCurve.alphaExtinctionThresholdSol).not.toBeNull();
      expect(illiquidCurve.alphaExtinctionThresholdSol!).toBeGreaterThan(0.05);
      expect(illiquidCurve.alphaExtinctionThresholdSol!).toBeLessThan(5.0);
    });
  });

  describe("RF-3: Failed Execution vs Failed Quote & Inventory Preservation (Finding C3)", () => {
    it("preserves unsold inventory and charges zero network fee on NO_ROUTE_REJECTED", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-rf3-1",
        generationId: "gen-1",
        decisionEventId: "ev-rf3-1",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "SELL",
        tradeSizeSolOrTokens: 1000,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
      });

      const fill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        sellabilityStatus: "UNSELLABLE_NO_ROUTE",
        priorEntryCostSol: 0.1,
      });

      expect(fill.executionOutcome).toBe("NO_ROUTE_REJECTED");
      expect(fill.filledTokens).toBe(0); // No tokens liquidated
      expect(fill.remainingTokens).toBe(1000); // 1000 tokens preserved in wallet!
      expect(fill.grossProceedsSol).toBe(0);
      expect(fill.netProceedsSol).toBe(0);
      expect(fill.networkFeeLamports).toBe(0); // No on-chain submission
      expect(fill.conservativeWriteDownSol).toBe(0.1); // Impairment stress metric
      expect(fill.realizedPnlSol).toBeUndefined(); // No realized loss fabricated!
    });

    it("preserves unsold inventory and charges zero network fee on PREFLIGHT_SIMULATION_REJECTED (Honeypot)", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-rf3-2",
        generationId: "gen-1",
        decisionEventId: "ev-rf3-2",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "SELL",
        tradeSizeSolOrTokens: 1000,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
      });

      const fill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        sellabilityStatus: "UNSELLABLE_TRANSFER_RESTRICTION",
        priorEntryCostSol: 0.1,
      });

      expect(fill.executionOutcome).toBe("PREFLIGHT_SIMULATION_REJECTED");
      expect(fill.filledTokens).toBe(0);
      expect(fill.remainingTokens).toBe(1000); // Inventory preserved
      expect(fill.networkFeeLamports).toBe(0);
    });

    it("preserves unsold inventory but debits on-chain network fee on SUBMITTED_TRANSACTION_FAILED (Pool Drain Rug)", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-rf3-3",
        generationId: "gen-1",
        decisionEventId: "ev-rf3-3",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "SELL",
        tradeSizeSolOrTokens: 1000,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
      });

      const fill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        sellabilityStatus: "UNSELLABLE_LIQUIDITY_DRAINED",
        priorEntryCostSol: 0.1,
      });

      expect(fill.executionOutcome).toBe("SUBMITTED_TRANSACTION_FAILED");
      expect(fill.filledTokens).toBe(0);
      expect(fill.remainingTokens).toBe(1000); // Unsold tokens preserved
      expect(fill.networkFeeLamports).toBe(15_000); // Failed on-chain transaction burns gas!
    });

    it("differentiates confirmed realized liquidation from conservative valuation impairment", () => {
      // Confirmed liquidation
      const realized = computeRealizedExitReturn(0.5, 0.6);
      expect(realized.netPnlSol).toBe(0.1);
      expect(realized.netReturnPct).toBe(20.0);

      // Conservative valuation write-down on unliquidatable token
      const valuation = estimateConservativeValuation(0.5, "UNSELLABLE_TRANSFER_RESTRICTION");
      expect(valuation.estimatedValueSol).toBe(0);
      expect(valuation.writeDownPct).toBe(100.0);
      expect(valuation.isImpaired).toBe(true);
    });

    it("evaluates multi-factor sellability criteria", () => {
      expect(evaluateSellability({ hasRoute: false }).status).toBe("UNSELLABLE_NO_ROUTE");
      expect(evaluateSellability({ hasRoute: true, freezeAuthorityActive: true }).status).toBe(
        "UNSELLABLE_TRANSFER_RESTRICTION",
      );
      expect(
        evaluateSellability({
          hasRoute: true,
          initialBaseReserve: 1000,
          currentBaseReserve: 50,
        }).status,
      ).toBe("UNSELLABLE_LIQUIDITY_DRAINED");
      expect(evaluateSellability({ hasRoute: true, priceImpactPct: 0.35 }).status).toBe(
        "UNSELLABLE_EXCESSIVE_IMPACT",
      );
      expect(evaluateSellability({ hasRoute: true, priceImpactPct: 0.05 }).status).toBe(
        "FULLY_SELLABLE",
      );
    });
  });

  describe("RF-4: Complete Route Mint & Sequence Continuity (Finding C4)", () => {
    it("rejects route when initial input mint does not match expected input mint", () => {
      const badInputRoute: readonly RoutePlanStep[] = [
        {
          ammKey: TEST_POOL_ID,
          label: "Raydium V4",
          inputMint: "WrongMint11111111111111111111111111111111111", // Wrong!
          outputMint: TEST_MINT,
          feePct: 0.0025,
        },
      ];

      const res = verifyRoutePlanPool({
        routePlan: badInputRoute,
        expectedPoolId: TEST_POOL_ID,
        side: "BUY",
        targetMintAddress: TEST_MINT,
      });

      expect(res.valid).toBe(false);
      expect(res.routeType).toBe("CROSS_POOL_DIVERGENCE");
      expect(res.reason).toContain("Route initial input mint");
    });

    it("rejects route when terminal output mint does not match expected output mint", () => {
      const badOutputRoute: readonly RoutePlanStep[] = [
        {
          ammKey: TEST_POOL_ID,
          label: "Raydium V4",
          inputMint: WSOL_MINT,
          outputMint: "WrongOutput1111111111111111111111111111111111", // Wrong!
          feePct: 0.0025,
        },
      ];

      const res = verifyRoutePlanPool({
        routePlan: badOutputRoute,
        expectedPoolId: TEST_POOL_ID,
        side: "BUY",
        targetMintAddress: TEST_MINT,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Route terminal output mint");
    });

    it("rejects multi-hop route when intermediate sequence is disconnected", () => {
      const INTERMEDIATE_MINT = "IntermediateToken11111111111111111111111111";
      const disconnectedRoute: readonly RoutePlanStep[] = [
        {
          ammKey: "Hop1Pool11111111111111111111111111111111111",
          label: "Raydium",
          inputMint: WSOL_MINT,
          outputMint: INTERMEDIATE_MINT,
          feePct: 0.0025,
        },
        {
          ammKey: TEST_POOL_ID,
          label: "Raydium",
          inputMint: "DifferentIntermediate11111111111111111111", // Disconnected!
          outputMint: TEST_MINT,
          feePct: 0.0025,
        },
      ];

      const res = verifyRoutePlanPool({
        routePlan: disconnectedRoute,
        expectedPoolId: TEST_POOL_ID,
        side: "BUY",
        targetMintAddress: TEST_MINT,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toContain("Disconnected multi-hop sequence");
    });

    it("accepts valid connected multi-hop route containing tracked pool", () => {
      const INTERMEDIATE_MINT = "IntermediateToken11111111111111111111111111";
      const validMultiHop: readonly RoutePlanStep[] = [
        {
          ammKey: "Hop1Pool11111111111111111111111111111111111",
          label: "Raydium",
          inputMint: WSOL_MINT,
          outputMint: INTERMEDIATE_MINT,
          feePct: 0.0025,
        },
        {
          ammKey: TEST_POOL_ID,
          label: "Raydium",
          inputMint: INTERMEDIATE_MINT,
          outputMint: TEST_MINT,
          feePct: 0.0025,
        },
      ];

      const res = verifyRoutePlanPool({
        routePlan: validMultiHop,
        expectedPoolId: TEST_POOL_ID,
        side: "BUY",
        targetMintAddress: TEST_MINT,
      });

      expect(res.valid).toBe(true);
      expect(res.routeType).toBe("MULTI_HOP");
    });
  });

  describe("RF-5: Slippage Tolerance vs Realized Arrival Slippage (Finding C5)", () => {
    it("separates expected output, minimum output, and actual arrival fill", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-rf5",
        generationId: "gen-1",
        decisionEventId: "ev-rf5",
        mintAddress: TEST_MINT,
        poolId: TEST_POOL_ID,
        side: "BUY",
        tradeSizeSolOrTokens: 0.5,
        baseReserveTokens: BASE_RESERVE_TOKENS,
        quoteReserveSol: QUOTE_RESERVE_SOL,
        tokenDecimals: TOKEN_DECIMALS,
        quoteInitiatedMs: 10_000,
        contextSlot: 100,
        maxSlippageBps: 3000, // 30% slippage tolerance
      });

      // Expected output without slippage
      expect(quote.expectedOutAmountUi).toBeCloseTo(4962.748293, 4);
      // Minimum out under 30% tolerance = 4962.748293 * 0.70 = 3473.923805
      expect(quote.minimumOutAmountUi).toBeCloseTo(3473.923805, 4);

      // 1. Fill with neutral 0 bps arrival slippage: fills at full expected amount
      const neutralFill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        arrivalSlippageBps: 0,
      });
      expect(neutralFill.executionOutcome).toBe("FILLED");
      expect(neutralFill.filledTokens).toBeCloseTo(4962.748293, 4);
      expect(neutralFill.realizedSlippageBps).toBe(0);

      // 2. Fill with 500 bps (5%) adverse arrival move: fills at 95% of expected
      const adverseFill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        arrivalSlippageBps: 500,
      });
      expect(adverseFill.executionOutcome).toBe("FILLED");
      expect(adverseFill.filledTokens).toBeCloseTo(4962.748293 * 0.95, 4);
      expect(adverseFill.realizedSlippageBps).toBe(500);

      // 3. Fill where arrival move exceeds 3000 bps tolerance (e.g. 3500 bps): aborts with breach!
      const breachedFill = simulateFill(quote, {
        decisionTimestampMs: 10_000,
        decisionSlot: 100,
        arrivalSlippageBps: 3500,
      });
      expect(breachedFill.executionOutcome).toBe("SLIPPAGE_BREACH_REJECTED");
      expect(breachedFill.filledTokens).toBe(0);
      expect(breachedFill.networkFeeLamports).toBe(0);
    });

    it("validates quote TTL expiration and zero-lookahead checks", () => {
      const quote = createDeterministicAmmQuote({
        sessionId: "session-rf5-ttl",
        generationId: "gen-1",
        decisionEventId: "ev-rf5-ttl",
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

      // TTL check
      expect(validateQuoteExpiration(quote, quote.quoteReceivedMs + 1000)).toBe(true);
      expect(validateQuoteExpiration(quote, quote.validUntilMs + 1)).toBe(false);

      // Lookahead check
      expect(validateQuoteLookahead(quote, 10_000, 100).valid).toBe(true);
      expect(validateQuoteLookahead(quote, 10_001, 100).valid).toBe(false);
      expect(validateQuoteLookahead(quote, 10_000, 101).valid).toBe(false);
    });
  });

  describe("RF-6: BigInt Atomic Units & Economic Input Guarding (Finding C7)", () => {
    it("converts 6, 9, and 18-decimal amounts to exact integer strings without scientific notation", () => {
      // 6 decimals
      expect(toAtomicUnitsString(4962.748293, 6)).toBe("4962748293");
      // 9 decimals
      expect(toAtomicUnitsString(0.5, 9)).toBe("500000000");

      // 18 decimals with large amount: string conversion must never produce scientific notation '...e+21'
      const large18 = toAtomicUnitsString("9.87648209114087", 18);
      expect(large18).toBe("9876482091140870000");
      expect(large18).not.toContain("e");
      expect(large18).not.toContain("E");

      // Test reverse atomicToUiNumber
      expect(atomicToUiNumber("500000000", 9)).toBe(0.5);
      expect(atomicToUiNumber("4962748293", 6)).toBeCloseTo(4962.748293, 6);
    });

    it("rejects invalid economic parameters (negative fees, negative slippage, NaN, Infinity)", () => {
      expect(() => validateFeeRate(-0.01)).toThrow(/INVALID_FEE_RATE/);
      expect(() => validateFeeRate(1.05)).toThrow(/INVALID_FEE_RATE/);
      expect(() => validateFeeRate(NaN)).toThrow(/INVALID_FEE_RATE/);
      expect(() => validateFeeRate(Infinity)).toThrow(/INVALID_FEE_RATE/);

      expect(() => validateSlippageBps(-1)).toThrow(/INVALID_SLIPPAGE/);
      expect(() => validateSlippageBps(10001)).toThrow(/INVALID_SLIPPAGE/);
      expect(() => validateSlippageBps(NaN)).toThrow(/INVALID_SLIPPAGE/);

      expect(() => validateMintDecimals(-1)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(19)).toThrow(/INVALID_DECIMALS/);
      expect(() => validateMintDecimals(6.5)).toThrow(/INVALID_DECIMALS/);
    });
  });

  describe("RF-7: Crash Repair-Before-Append & Strict Reconciliation (Finding C8)", () => {
    it("quarantines crash-damaged tail before appending and recovers clean boundary", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf7-crash-append-"));
      try {
        const sessionId = "session-rf7-crash";
        const sessionDir = path.join(tempDir, ".tmp", "telemetry", "sessions", sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });

        const quotesPath = path.join(sessionDir, "execution-quotes.jsonl");

        // Write 1 valid quote line followed by an unterminated crash tail
        const validQuote = { quoteId: "q-1", sessionId, generationId: "gen-1" };
        fs.writeFileSync(
          quotesPath,
          JSON.stringify(validQuote) + "\n" + '{"quoteId":"q-corrupt-tail"',
          "utf8",
        );

        const storage = new ExecutionStorageManager(tempDir);

        // Record a new quote: must run repairAndQuarantineDamagedTail BEFORE appending
        const newQuote = createDeterministicAmmQuote({
          sessionId,
          generationId: "gen-1",
          decisionEventId: "ev-rf7-new",
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

        storage.recordQuote(newQuote);

        // Reread quotes: must contain exactly 2 valid quotes, with corrupt tail quarantined
        const quotes = storage.getQuotesForSession(sessionId);
        expect(quotes).toHaveLength(2);
        expect(quotes[0]!.quoteId).toBe("q-1");
        expect(quotes[1]!.quoteId).toBe(newQuote.quoteId);

        // Verify quarantine file exists
        const files = fs.readdirSync(sessionDir);
        const quarantineFile = files.find((f) => f.includes("corrupt-"));
        expect(quarantineFile).toBeDefined();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed when summary reports positive decisions but candidate-decisions.jsonl is missing", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf7-missing-file-"));
      try {
        const meta = {
          sessionId: "session-rf7-missing",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
        };
        const summary = {
          sessionId: "session-rf7-missing",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          closedAtIso: "2026-10-14T11:00:00.000Z",
          totalCandidatesScreened: 5,
          totalDecisionsRecorded: 5, // Summary claims 5 decisions recorded!
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 5,
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
        // candidate-decisions.jsonl is intentionally NOT created!

        const res = verifySessionCrossFileConsistency(tempDir);
        expect(res.valid).toBe(false);
        expect(res.reason).toContain("Missing candidate-decisions.jsonl");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed when simulated fill references a non-existent quote ID", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf7-orphan-fill-"));
      try {
        const meta = {
          sessionId: "session-rf7-orphan",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
        };
        const summary = {
          sessionId: "session-rf7-orphan",
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
        };

        fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify(meta), "utf8");
        fs.writeFileSync(
          path.join(tempDir, "session-summary.json"),
          JSON.stringify(summary),
          "utf8",
        );

        // Write a quote with quoteId "q-valid"
        fs.writeFileSync(
          path.join(tempDir, "execution-quotes.jsonl"),
          JSON.stringify({
            quoteId: "q-valid",
            sessionId: "session-rf7-orphan",
            generationId: "gen-1",
          }) + "\n",
          "utf8",
        );

        // Write a fill with an orphaned quoteId "q-non-existent"
        fs.writeFileSync(
          path.join(tempDir, "simulated-fills.jsonl"),
          JSON.stringify({ fillId: "fill-1", quoteId: "q-non-existent" }) + "\n",
          "utf8",
        );

        const res = verifySessionCrossFileConsistency(tempDir);
        expect(res.valid).toBe(false);
        expect(res.reason).toContain("references non-existent quote ID");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed on quote record session ID mismatch in execution-quotes.jsonl", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf7-quote-mismatch-"));
      try {
        const meta = {
          sessionId: "session-rf7-quote-mismatch",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
        };
        const summary = {
          sessionId: "session-rf7-quote-mismatch",
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
        };

        fs.writeFileSync(path.join(tempDir, "session-meta.json"), JSON.stringify(meta), "utf8");
        fs.writeFileSync(
          path.join(tempDir, "session-summary.json"),
          JSON.stringify(summary),
          "utf8",
        );

        // Write a quote with mismatched sessionId "different-session"
        fs.writeFileSync(
          path.join(tempDir, "execution-quotes.jsonl"),
          JSON.stringify({
            quoteId: "q-1",
            sessionId: "different-session",
            generationId: "gen-1",
          }) + "\n",
          "utf8",
        );

        const res = verifySessionCrossFileConsistency(tempDir);
        expect(res.valid).toBe(false);
        expect(res.reason).toContain("mismatched session ID");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("verifies clean consistent session files pass validation", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf7-clean-"));
      try {
        const meta = {
          sessionId: "session-rf7-clean",
          generationId: "gen-1",
          strategyRevision: "rev-12.94c",
          startedAtIso: "2026-10-14T10:00:00.000Z",
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "win32", nodeVersion: "v22" },
          isInterruptedSession: false,
        };
        const summary = {
          sessionId: "session-rf7-clean",
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
          JSON.stringify({ eventId: "ev-1", sessionId: "session-rf7-clean" }) + "\n",
          "utf8",
        );

        const res = verifySessionCrossFileConsistency(tempDir);
        expect(res.valid).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
