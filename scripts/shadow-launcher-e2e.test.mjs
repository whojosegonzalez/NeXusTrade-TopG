/**
 * Phase 12.94-D Milestone D.3.3: Final Offline Acceptance Test Suite (Node.js)
 *
 * Exercises the complete shadow observation launcher workflow end-to-end under node:test.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

const { GlobalResourceBudgetManager } = await import(
  `file://${path.join(distDir, "research", "prospective", "GlobalResourceBudgetManager.js").replace(/\\/g, "/")}`
);

const { LiveDexScreenerCandidateSource, LiveDexScreenerQuoteProvider } = await import(
  `file://${path.join(distDir, "research", "prospective", "LiveShadowProviders.js").replace(/\\/g, "/")}`
);

const { ShadowObservationRunner } = await import(
  `file://${path.join(distDir, "research", "prospective", "ShadowObservationRunner.js").replace(/\\/g, "/")}`
);

function createMockFetch(clock) {
  let calls = 0;
  let failNext = null;
  let returnStatus = 200;

  const fetchFn = async (url) => {
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

    if (url.includes("token-profiles/latest/v1")) {
      const mockProfiles = [
        { tokenAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", chainId: "solana" },
        { tokenAddress: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF", chainId: "solana" },
        { tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chainId: "solana" },
      ];
      return new Response(JSON.stringify(mockProfiles), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/latest/dex/tokens/") || url.includes("/latest/dex/pairs/solana/")) {
      const isCandidate1 =
        url.includes("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU") || url.includes("pool-runner");
      const isCandidate2 =
        url.includes("Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF") || url.includes("pool-micro");

      const tokenAddress = isCandidate1
        ? "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
        : isCandidate2
          ? "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF"
          : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

      const poolAddress = isCandidate1
        ? "pool-runner-7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZ"
        : isCandidate2
          ? "pool-micro-Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLff"
          : "pool-viral-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGG";

      const liquidityUsd = isCandidate1 ? 65000 : isCandidate2 ? 25000 : 30000;
      const ageSeconds = isCandidate1 ? 2400 : isCandidate2 ? 600 : 1200;
      const pairCreatedAt = clock() - ageSeconds * 1000;

      const mockPairData = {
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: poolAddress,
            baseToken: {
              address: tokenAddress,
              symbol: isCandidate1 ? "RUNNER" : isCandidate2 ? "MICRO" : "VIRAL",
            },
            quoteToken: {
              address: "So11111111111111111111111111111111111111112",
              symbol: "WSOL",
            },
            priceNative: "0.000005",
            priceUsd: "0.00075",
            liquidity: { usd: liquidityUsd },
            marketCap: liquidityUsd * 3,
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
    setFailNext: (err) => {
      failNext = err;
    },
    setReturnStatus: (code) => {
      returnStatus = code;
    },
  };
}

test("Final Acceptance Test — Full E2E Accelerated Observation Lifecycle", async () => {
  let virtualClock = 10_000_000;
  const clock = () => virtualClock;

  const tmpDir = path.join(os.tmpdir(), `shadow-e2e-node-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const mockTransport = createMockFetch(clock);

  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 120,
    minProviderSpacingMs: 2500,
    clock,
  });

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

  const runner = new ShadowObservationRunner(
    {
      sessionId: "e2e-acceptance-node",
      configFingerprint: "sha256:e2e-fp-node",
      outputDir: tmpDir,
      maxCandidates: 10,
      intakeDurationMs: 60 * 60_000,
      drainDurationMs: 60 * 60_000,
      minProviderSpacingMs: 2500,
      maxAggregateRequests: 120,
      clock,
    },
    {
      marketDataProvider: quoteProvider,
      budgetManager,
    },
  );

  // Safety checks
  const safetyPre = runner.verifySafetyInvariants();
  assert.equal(safetyPre.walletFrozen, true);
  assert.equal(safetyPre.balanceSol, 7.9259);
  assert.equal(safetyPre.paperTradingActive, false);
  assert.equal(safetyPre.openPositionsCount, 0);

  // Intake candidates
  const discovered1 = await candidateSource.pollCandidates(2);
  assert.equal(discovered1.length, 2);

  for (const cand of discovered1) {
    runner.ingestCandidate(cand, virtualClock);
  }

  virtualClock += 3_000;
  const discovered2 = await candidateSource.pollCandidates(1);
  assert.equal(discovered2.length, 1);
  runner.ingestCandidate(discovered2[0], virtualClock);

  const decisions = runner.getRecorder().getDecisionRecords();
  assert.equal(decisions.length, 3);
  assert.equal(decisions.find((d) => d.symbol === "RUNNER")?.strategyCohort, "ESTABLISHED_RUNNER");
  assert.equal(decisions.find((d) => d.symbol === "MICRO")?.strategyCohort, "MICRO_CAP_PROBE");
  assert.equal(decisions.find((d) => d.symbol === "VIRAL")?.strategyCohort, "UNCLASSIFIED");

  // Fast-forward through all scheduled horizons respecting due times and pacing
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

  const forwardRecords = runner.getRecorder().getForwardRecords();
  assert.equal(forwardRecords.length, 12);
  assert.equal(
    forwardRecords.every((f) => f.outcomeStatus === "OBSERVED_PRICE"),
    true,
  );

  virtualClock += 3_600_000;
  const { summary, manifest } = runner.closeSession(virtualClock);

  assert.equal(summary.totalCandidatesScreened, 3);
  assert.equal(summary.candidatesByCohort.ESTABLISHED_RUNNER, 1);
  assert.equal(summary.candidatesByCohort.MICRO_CAP_PROBE, 1);
  assert.equal(summary.candidatesByCohort.UNCLASSIFIED, 1);
  assert.ok(summary.globalRequestStats.totalRequests <= 120);

  assert.ok(manifest);
  assert.equal(manifest.verificationStatus, "VERIFIED_OFFLINE");
  assert.equal(manifest.files.length, 3);

  for (const fileEntry of manifest.files) {
    const filePath = path.join(tmpDir, fileEntry.filename);
    assert.ok(fs.existsSync(filePath));
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    assert.equal(actualHash, fileEntry.sha256);
  }

  const safetyPost = runner.verifySafetyInvariants();
  assert.equal(safetyPost.walletFrozen, true);
  assert.equal(safetyPost.balanceSol, 7.9259);
  assert.equal(safetyPost.paperTradingActive, false);
  assert.equal(safetyPost.openPositionsCount, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Final Acceptance Test — Safety Code Isolation Verification", () => {
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

  assert.equal(allCode.includes("PaperTradingDaemon"), false);
  assert.equal(allCode.includes("Keypair.fromSecretKey"), false);
  assert.equal(allCode.includes("sendAndConfirmTransaction"), false);
  assert.equal(allCode.includes("sendRawTransaction"), false);
  assert.equal(allCode.includes("paperTradeTransactions"), false);
  assert.equal(allCode.includes("paperTrades"), false);
  assert.equal(allCode.includes("paperOrders"), false);
});
