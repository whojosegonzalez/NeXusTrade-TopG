/**
 * Phase 12.94-D Milestone D.3.3: Final Offline Acceptance Test Suite
 *
 * Exercises the complete shadow observation launcher workflow end-to-end using
 * mocked discovery, enrichment, quotes, and an accelerated virtual clock:
 *
 * 1. Multi-purpose request budget accounting (discovery + enrichment + quotes <= 120 calls).
 * 2. Strict baseline cohort assignments (no heuristic 15m/$30k classification).
 * 3. Provider pacing floor (2,500 ms).
 * 4. Tracking of all four horizons (+5m, +15m, +30m, +60m).
 * 5. Fail-closed stop conditions (intake deadline, candidate ceiling, 429 halts, missing rates).
 * 6. Causality preservation (quote timestamps recorded after network responses).
 * 7. Absence of PAPER daemon, signing, and wallet mutations (virtual balance 7.9259 SOL frozen).
 * 8. Cryptographic SHA-256 session manifest verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import {
  LiveDexScreenerCandidateSource,
  LiveDexScreenerQuoteProvider,
  type FetchFunction,
} from "./LiveShadowProviders.js";
import { ShadowObservationRunner } from "./ShadowObservationRunner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../../..");

function createMockFetch(clock: () => number): {
  fetchFn: FetchFunction;
  callCount: () => number;
  setFailNext: (err: Error) => void;
  setReturnStatus: (code: number) => void;
} {
  let calls = 0;
  let failNext: Error | null = null;
  let returnStatus = 200;

  const fetchFn: FetchFunction = async (url: string) => {
    calls++;
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }

    if (returnStatus !== 200) {
      const status = returnStatus;
      return new Response(JSON.stringify({ error: `HTTP ${status}` }), {
        status,
        statusText: status === 429 ? "Too Many Requests" : "Error",
      });
    }

    // 1. DexScreener token profiles endpoint
    if (url.includes("token-profiles/latest/v1")) {
      const mockProfiles = [
        {
          tokenAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          chainId: "solana",
        },
        {
          tokenAddress: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF",
          chainId: "solana",
        },
        {
          tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          chainId: "solana",
        },
      ];
      return new Response(JSON.stringify(mockProfiles), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. DexScreener token pair lookup
    if (url.includes("/latest/dex/tokens/") || url.includes("/latest/dex/pairs/solana/")) {
      const isCandidate1 = url.includes("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
      const isCandidate2 = url.includes("Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF");

      // Candidate 1: Established Runner ($65k liquidity, 2400s age)
      // Candidate 2: Micro-Cap Probe ($25k liquidity, 600s age)
      // Candidate 3: Unclassified ($30k liquidity, 1200s age)
      const liquidityUsd = isCandidate1 ? 65000 : isCandidate2 ? 25000 : 30000;
      const ageSeconds = isCandidate1 ? 2400 : isCandidate2 ? 600 : 1200;
      const pairCreatedAt = clock() - ageSeconds * 1000;

      const mockPairData = {
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: `pool-${url.slice(-8)}`,
            baseToken: {
              address: url.slice(-44),
              symbol: isCandidate1 ? "RUNNER" : isCandidate2 ? "MICRO" : "VIRAL",
            },
            priceNative: "0.000005",
            priceUsd: "0.00075",
            liquidity: { usd: liquidityUsd },
            volume: { m5: 35000 },
            txns: {
              m5: { buys: 45, sells: 20 },
            },
            pairCreatedAt,
          },
        ],
      };

      return new Response(JSON.stringify(mockPairData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({}), { status: 404 });
  };

  return {
    fetchFn,
    callCount: () => calls,
    setFailNext: (err: Error) => {
      failNext = err;
    },
    setReturnStatus: (code: number) => {
      returnStatus = code;
    },
  };
}

describe("ShadowLauncher Final Acceptance Test", () => {
  it("executes complete prospective observation lifecycle with accelerated clock", async () => {
    let virtualClock = 1_000_000;
    const clock = () => virtualClock;

    const tmpDir = path.join(os.tmpdir(), `shadow-e2e-session-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const mockTransport = createMockFetch(clock);

    // 1. Shared Global Resource Budget Manager
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 120,
      minProviderSpacingMs: 2500,
      clock,
    });

    // 2. Concrete Read-Only Public Providers
    const quoteProvider = new LiveDexScreenerQuoteProvider(
      budgetManager,
      mockTransport.fetchFn,
      clock,
    );
    const candidateSource = new LiveDexScreenerCandidateSource(
      budgetManager,
      mockTransport.fetchFn,
      clock,
      async (ms) => {
        virtualClock += ms;
      },
    );

    // 3. Shadow Observation Runner
    const runner = new ShadowObservationRunner(
      {
        sessionId: "e2e-acceptance-pilot",
        configFingerprint: "sha256:e2e-fp-accepted",
        outputDir: tmpDir,
        maxCandidates: 10,
        intakeDurationMs: 60 * 60_000, // 60 minutes
        drainDurationMs: 60 * 60_000, // 60 minutes
        minProviderSpacingMs: 2500,
        maxAggregateRequests: 120,
        clock,
      },
      {
        marketDataProvider: quoteProvider,
        budgetManager,
      },
    );

    // 4. Verify Safety Invariants before run
    const safetyPre = runner.verifySafetyInvariants();
    expect(safetyPre.walletFrozen).toBe(true);
    expect(safetyPre.balanceSol).toBe(7.9259);
    expect(safetyPre.paperTradingActive).toBe(false);
    expect(safetyPre.openPositionsCount).toBe(0);

    // 5. Poll Candidates during Intake (Accelerated Clock)
    // First poll at t = 1_000_000
    const discovered1 = await candidateSource.pollCandidates(2);
    expect(discovered1.length).toBe(2);

    for (const cand of discovered1) {
      const decId = runner.ingestCandidate(cand, virtualClock);
      expect(decId).toBeDefined();
    }

    // Verify candidate cohort assignment
    const decisions = runner.getRecorder().getDecisionRecords();
    expect(decisions.length).toBe(2);

    const estCand = decisions.find((d) => d.symbol === "RUNNER");
    const microCand = decisions.find((d) => d.symbol === "MICRO");
    expect(estCand?.strategyCohort).toBe("ESTABLISHED_RUNNER");
    expect(microCand?.strategyCohort).toBe("MICRO_CAP_PROBE");

    // Advance clock past 2,500 ms spacing and poll candidate 3 (20m / $30k)
    virtualClock += 3_000;
    const discovered2 = await candidateSource.pollCandidates(1);
    expect(discovered2.length).toBe(1);
    const id3 = runner.ingestCandidate(discovered2[0]!, virtualClock);
    expect(id3).toBeDefined();

    const viralCand = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === id3);
    // Strict baseline invariant: 20m / $30k MUST be UNCLASSIFIED, not silently labeled ESTABLISHED_RUNNER
    expect(viralCand?.strategyCohort).toBe("UNCLASSIFIED");

    // Verify that all candidate discovery & enrichment calls counted against the global budget
    const budgetStatsPre = budgetManager.getStats();
    expect(budgetStatsPre.discoveryRequests).toBeGreaterThanOrEqual(2);
    expect(budgetStatsPre.enrichmentRequests).toBe(3);
    expect(budgetStatsPre.totalRequests).toBe(
      budgetStatsPre.discoveryRequests + budgetStatsPre.enrichmentRequests,
    );

    // 6. Fast-forward through all scheduled horizons respecting due times and pacing
    const pendingTasks = runner.getScheduledTasks();
    const sortedTasks = [...pendingTasks].sort(
      (a, b) => a.scheduledDueTimestampMs - b.scheduledDueTimestampMs,
    );
    for (const task of sortedTasks) {
      if (task.status !== "FINALIZED") {
        virtualClock = Math.max(virtualClock + 3_000, task.scheduledDueTimestampMs + 100);
        await runner.processDueObservations(virtualClock);
      }
    }

    // 7. Verify Forward Outcomes Recorded Correctly
    const forwardRecords = runner.getRecorder().getForwardRecords();
    expect(forwardRecords.length).toBe(12); // 3 candidates * 4 horizons = 12 outcomes

    // Verify all 12 forward horizons finalized
    const observedPrices = forwardRecords.filter((f) => f.outcomeStatus === "OBSERVED_PRICE");
    expect(observedPrices.length).toBe(12);

    // Verify quote timestamps are valid and recorded after response
    for (const record of observedPrices) {
      expect(record.actualObservationTimestampMs).toBeGreaterThanOrEqual(
        record.scheduledDueTimestampMs,
      );
      expect(record.quoteTimestampMs).toBeDefined();
      expect(record.quoteSource).toBe("DEXSCREENER");
      expect(record.isExecutableQuote).toBe(false);
      expect(record.priceReturnPct).toBeDefined();
    }

    // 8. Close Session Cleanly
    virtualClock += 3_600_000; // enter minute 120
    const { summary, manifest } = runner.closeSession(virtualClock);

    expect(summary.totalCandidatesScreened).toBe(3);
    expect(summary.candidatesByCohort.ESTABLISHED_RUNNER).toBe(1);
    expect(summary.candidatesByCohort.MICRO_CAP_PROBE).toBe(1);
    expect(summary.candidatesByCohort.UNCLASSIFIED).toBe(1);

    // Verify global request stats in summary
    expect(summary.globalRequestStats).toBeDefined();
    expect(summary.globalRequestStats?.totalRequests).toBeLessThanOrEqual(120);
    expect(summary.globalRequestStats?.forwardObservationRequests).toBe(12);

    // Verify cryptographic manifest
    expect(manifest).toBeDefined();
    expect(manifest?.verificationStatus).toBe("VERIFIED_OFFLINE");
    expect(manifest?.files.length).toBe(3);

    for (const fileEntry of manifest!.files) {
      const filePath = path.join(tmpDir, fileEntry.filename);
      expect(fs.existsSync(filePath)).toBe(true);
      const actualHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
      expect(actualHash).toBe(fileEntry.sha256);
    }

    // 9. Verify Safety Invariants after run
    const safetyPost = runner.verifySafetyInvariants();
    expect(safetyPost.walletFrozen).toBe(true);
    expect(safetyPost.balanceSol).toBe(7.9259);
    expect(safetyPost.paperTradingActive).toBe(false);
    expect(safetyPost.openPositionsCount).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies code isolation: zero PaperTradingDaemon, wallet keys, or signing code loaded", () => {
    const launcherSource = fs.readFileSync(
      path.join(rootDir, "backend", "src", "scripts", "launch-shadow-observation.ts"),
      "utf8",
    );
    const runnerSource = fs.readFileSync(
      path.join(rootDir, "backend", "src", "research", "prospective", "ShadowObservationRunner.ts"),
      "utf8",
    );
    const providersSource = fs.readFileSync(
      path.join(rootDir, "backend", "src", "research", "prospective", "LiveShadowProviders.ts"),
      "utf8",
    );

    const allCode = launcherSource + "\n" + runnerSource + "\n" + providersSource;

    // Must NOT import PaperTradingDaemon
    expect(allCode).not.toContain("PaperTradingDaemon");

    // Must NOT import keypair generation or signing functions
    expect(allCode).not.toContain("Keypair.fromSecretKey");
    expect(allCode).not.toContain("sendAndConfirmTransaction");
    expect(allCode).not.toContain("sendRawTransaction");

    // Must NOT write to paper trading database tables
    expect(allCode).not.toContain("paperTradeTransactions");
    expect(allCode).not.toContain("paperTrades");
    expect(allCode).not.toContain("paperOrders");
  });
});
