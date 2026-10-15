#!/usr/bin/env node
/**
 * Phase 12.94-D: Research Input Readiness & Lineage Audit Script
 *
 * Scans canonical telemetry directories and historical session logs on disk.
 * Generates audit/RESEARCH_INPUT_READINESS_REPORT.md reporting full denominators,
 * feature availability distributions, verified pool coverage, sampling metadata,
 * ambiguous trajectories, and an honest readiness assessment without fabricating data.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "..");

/**
 * Normalizes and verifies whether a provider's actual response pool ID matches
 * an expected tracked pool ID (strips 'dexscreener-' prefix, trims, lowercases).
 * Fails closed (returns false) if actualResponsePoolId is missing, empty, or not a string.
 */
export function isVerifiedMatchingPool(actualResponsePoolId, expectedPoolId) {
  if (
    !actualResponsePoolId ||
    typeof actualResponsePoolId !== "string" ||
    !expectedPoolId ||
    typeof expectedPoolId !== "string"
  ) {
    return false;
  }
  const normActual = actualResponsePoolId
    .trim()
    .toLowerCase()
    .replace(/^dexscreener-/, "");
  const normExpected = expectedPoolId
    .trim()
    .toLowerCase()
    .replace(/^dexscreener-/, "");
  return normActual.length > 0 && normActual === normExpected;
}

export function runReadinessAudit(customOptions = {}) {
  const rootDir = customOptions.rootDir ?? defaultRootDir;
  const telemetrySessionsDir =
    customOptions.telemetrySessionsDir ?? path.resolve(rootDir, ".tmp", "telemetry", "sessions");
  const legacySessionsDir =
    customOptions.legacySessionsDir ?? path.resolve(rootDir, ".tmp", "sessions");
  const reportOutputPath =
    customOptions.reportOutputPath ??
    path.resolve(rootDir, "audit", "RESEARCH_INPUT_READINESS_REPORT.md");

  console.log("[AuditResearchReadiness] Scanning disk locations...");
  console.log(`  Telemetry Sessions Dir: ${telemetrySessionsDir}`);
  console.log(`  Legacy Sessions Dir: ${legacySessionsDir}`);

  const auditTimestamp = new Date().toISOString();
  let totalSessionsFound = 0;
  let finalizedSessionsCount = 0;
  let interruptedSessionsCount = 0;
  let unfinalizedSessionsCount = 0;

  let totalDecisions = 0;
  const decisionsByCohort = {
    FILTERED_REJECTED: 0,
    WATCHLIST_RADAR: 0,
    TRIGGER_REJECTED: 0,
    EXECUTED_BUY: 0,
  };

  let totalObservations = 0;
  let observationsWithVerifiedPool = 0;
  let observationsWithReserveSnapshot = 0;
  let observationsWithDevHolding = 0;

  let decisionsWithUsablePreDecisionReserves = 0;
  let decisionsWithCoOccurringH2Features = 0;
  let decisionsWithLpBurn = 0;

  let totalQuotesFound = 0;
  let totalFillsFound = 0;
  let totalSamplingRecords = 0;

  let malformedDecisionsCount = 0;
  let malformedObservationsCount = 0;
  let malformedQuotesCount = 0;
  let malformedFillsCount = 0;
  let malformedSamplesCount = 0;

  const featureCounts = {
    tokenAgeSec: 0,
    liquidityUsd: 0,
    marketCapUsd: 0,
    lmcRatio: 0,
    lpBurnPct: 0,
    spotPriceUsd: 0,
    spotPriceSol: 0,
    volume5mUsd: 0,
    txCount5m: 0,
    buys5m: 0,
    sells5m: 0,
    baseReserve: 0,
    quoteReserve: 0,
    top10ConcentrationPct: 0,
    devHoldingPct: 0,
  };

  const sessionsScanned = [];

  // 1. Scan telemetry sessions
  if (fs.existsSync(telemetrySessionsDir)) {
    const sessionEntries = fs.readdirSync(telemetrySessionsDir, { withFileTypes: true });
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue;
      totalSessionsFound++;
      const sessionId = entry.name;
      const sessionPath = path.join(telemetrySessionsDir, sessionId);

      const metaPath = path.join(sessionPath, "session-meta.json");
      const summaryPath = path.join(sessionPath, "session-summary.json");
      const decisionsPath = path.join(sessionPath, "candidate-decisions.jsonl");
      const observationsPath = path.join(sessionPath, "market-observations.jsonl");
      const quotesPath = path.join(sessionPath, "execution-quotes.jsonl");
      const fillsPath = path.join(sessionPath, "simulated-fills.jsonl");
      const samplesPath = path.join(sessionPath, "stratified-samples.jsonl");

      let meta = null;
      let summary = null;
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch {
          // malformed meta
        }
      }
      if (fs.existsSync(summaryPath)) {
        try {
          summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        } catch {
          // malformed summary
        }
      }

      // Check session finality using authoritative meta + summary cross-file consistency
      let status = "UNFINALIZED";
      const isInterrupted =
        Boolean(meta?.isInterruptedSession) ||
        meta?.sessionStatus === "INTERRUPTED" ||
        Boolean(summary?.isInterruptedSession);

      if (isInterrupted) {
        status = "INTERRUPTED";
        interruptedSessionsCount++;
      } else if (
        meta &&
        summary &&
        meta.sessionId === summary.sessionId &&
        meta.generationId === summary.generationId &&
        meta.strategyRevision === summary.strategyRevision &&
        summary.isCompleteSession === true &&
        summary.closedAtIso
      ) {
        status = "FINALIZED";
        finalizedSessionsCount++;
      } else {
        status = "UNFINALIZED";
        unfinalizedSessionsCount++;
      }

      const sessionDecisionsList = [];
      let sessionDecisions = 0;
      if (fs.existsSync(decisionsPath)) {
        const lines = fs.readFileSync(decisionsPath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const dec = JSON.parse(trimmed);
            totalDecisions++;
            sessionDecisions++;
            sessionDecisionsList.push(dec);
            if (dec.decisionCohort && decisionsByCohort[dec.decisionCohort] !== undefined) {
              decisionsByCohort[dec.decisionCohort]++;
            }
            if (dec.metricsSnapshot) {
              const ms = dec.metricsSnapshot;
              const p = ms.metricProvenance ?? {};
              for (const [key, val] of Object.entries(ms)) {
                if (
                  val !== null &&
                  val !== undefined &&
                  typeof val === "number" &&
                  Number.isFinite(val) &&
                  val >= 0 &&
                  p[key] !== "PLACEHOLDER" &&
                  p[key] !== "UNAVAILABLE" &&
                  featureCounts[key] !== undefined
                ) {
                  featureCounts[key]++;
                }
              }

              // Check H2 co-occurrence on the same candidate decision
              const hasBuys =
                ms.buys5m != null &&
                Number.isFinite(ms.buys5m) &&
                ms.buys5m >= 0 &&
                p["buys5m"] !== "PLACEHOLDER" &&
                p["buys5m"] !== "UNAVAILABLE";
              const hasSells =
                ms.sells5m != null &&
                Number.isFinite(ms.sells5m) &&
                ms.sells5m >= 0 &&
                p["sells5m"] !== "PLACEHOLDER" &&
                p["sells5m"] !== "UNAVAILABLE";
              const hasVol =
                ms.volume5mUsd != null &&
                Number.isFinite(ms.volume5mUsd) &&
                ms.volume5mUsd >= 0 &&
                p["volume5mUsd"] !== "PLACEHOLDER" &&
                p["volume5mUsd"] !== "UNAVAILABLE";
              if (hasBuys && hasSells && hasVol) {
                decisionsWithCoOccurringH2Features++;
              }

              // Check H3 lpBurn on decision
              const hasLpBurn =
                ms.lpBurnPct != null &&
                Number.isFinite(ms.lpBurnPct) &&
                ms.lpBurnPct >= 0 &&
                p["lpBurnPct"] !== "PLACEHOLDER" &&
                p["lpBurnPct"] !== "UNAVAILABLE";
              if (hasLpBurn) {
                decisionsWithLpBurn++;
              }
            }
          } catch {
            malformedDecisionsCount++;
          }
        }
      }

      const sessionObservationsList = [];
      let sessionObservations = 0;
      if (fs.existsSync(observationsPath)) {
        const lines = fs.readFileSync(observationsPath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obs = JSON.parse(trimmed);
            totalObservations++;
            sessionObservations++;
            sessionObservationsList.push(obs);

            const isVerifiedPool = isVerifiedMatchingPool(obs.actualResponsePoolId, obs.poolId);
            if (isVerifiedPool) {
              observationsWithVerifiedPool++;
            }
            if (
              isVerifiedPool &&
              obs.liquidityMetrics?.baseReserve > 0 &&
              obs.liquidityMetrics?.quoteReserve > 0
            ) {
              observationsWithReserveSnapshot++;
              featureCounts.baseReserve++;
              featureCounts.quoteReserve++;
            }
            if (
              obs.holderMetrics?.top10ConcentrationPct != null &&
              Number.isFinite(obs.holderMetrics.top10ConcentrationPct)
            ) {
              featureCounts.top10ConcentrationPct++;
            }
            if (
              obs.holderMetrics?.devHoldingPct != null &&
              Number.isFinite(obs.holderMetrics.devHoldingPct)
            ) {
              featureCounts.devHoldingPct++;
              observationsWithDevHolding++;
            }
          } catch {
            malformedObservationsCount++;
          }
        }
      }

      // Check pre-decision reserve feasibility for candidate decisions in this session
      for (const dec of sessionDecisionsList) {
        const tDec = dec.decisionTimestampMs;
        const matchingPreDecisionObs = sessionObservationsList.find((obs) => {
          const recv = obs.responseReceivedMs ?? obs.ingestionTimestampMs;
          return (
            obs.poolId === dec.poolId &&
            isVerifiedMatchingPool(obs.actualResponsePoolId, dec.poolId) &&
            obs.sourceTimestampMs <= tDec &&
            obs.ingestionTimestampMs <= tDec &&
            recv <= tDec &&
            obs.liquidityMetrics?.baseReserve > 0 &&
            obs.liquidityMetrics?.quoteReserve > 0
          );
        });
        if (matchingPreDecisionObs) {
          decisionsWithUsablePreDecisionReserves++;
        }
      }

      let quotesCount = 0;
      if (fs.existsSync(quotesPath)) {
        const lines = fs.readFileSync(quotesPath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed);
            quotesCount++;
            totalQuotesFound++;
          } catch {
            malformedQuotesCount++;
          }
        }
      }

      let fillsCount = 0;
      if (fs.existsSync(fillsPath)) {
        const lines = fs.readFileSync(fillsPath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed);
            fillsCount++;
            totalFillsFound++;
          } catch {
            malformedFillsCount++;
          }
        }
      }

      let samplesCount = 0;
      if (fs.existsSync(samplesPath)) {
        const lines = fs.readFileSync(samplesPath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            JSON.parse(trimmed);
            samplesCount++;
            totalSamplingRecords++;
          } catch {
            malformedSamplesCount++;
          }
        }
      }

      sessionsScanned.push({
        sessionId,
        status,
        decisions: sessionDecisions,
        observations: sessionObservations,
        quotes: quotesCount,
        fills: fillsCount,
        samples: samplesCount,
      });
    }
  }

  // 2. Scan legacy sessions if any
  const legacySessions = [];
  if (fs.existsSync(legacySessionsDir)) {
    const entries = fs.readdirSync(legacySessionsDir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        legacySessions.push(entry);
      }
    }
  }

  const totalMalformedRecordsCount =
    malformedDecisionsCount +
    malformedObservationsCount +
    malformedQuotesCount +
    malformedFillsCount +
    malformedSamplesCount;

  // 3. Compute readiness status honestly
  const isTelemetryDatasetEmpty = totalSessionsFound === 0 || totalDecisions === 0;
  let overallReadinessStatus = "PRELIMINARY_EVIDENCE_AVAILABLE";
  if (totalSessionsFound === 0) {
    overallReadinessStatus = "INSUFFICIENT_EVIDENCE (NO_PERSISTED_TELEMETRY_SESSIONS)";
  } else if (totalDecisions === 0) {
    overallReadinessStatus = "INSUFFICIENT_EVIDENCE (NO_CANDIDATE_DECISIONS)";
  } else if (finalizedSessionsCount === 0) {
    overallReadinessStatus = "INSUFFICIENT_EVIDENCE (NO_FINALIZED_SESSIONS)";
  } else if (totalDecisions < 100) {
    overallReadinessStatus = "INSUFFICIENT_EVIDENCE (SUBMARGINAL_DECISION_COUNT)";
  }

  // Hypothesis feasibility strictly requires verified, co-occurring data
  const h1Feasible = decisionsWithUsablePreDecisionReserves > 0;
  const h2Feasible = decisionsWithCoOccurringH2Features > 0;
  const h3Feasible = decisionsWithLpBurn > 0 && observationsWithDevHolding > 0;
  const h4Feasible = decisionsWithUsablePreDecisionReserves > 0;

  // 4. Generate Markdown report
  const report = `# NeXusTrade — Research Input Readiness & Lineage Report

**Audit Date:** ${auditTimestamp}<br/>
**Status:** **${overallReadinessStatus}**<br/>
**Milestone:** Phase 12.94-D Milestone D.1 — Telemetry Data Feasibility & Lineage Audit

---

## 1. Executive Summary & Inventory Findings

This report documents the empirical audit of historical telemetry and execution files currently persisted on disk in canonical workspace locations (\`.tmp/telemetry/sessions\` and \`.tmp/sessions\`).

In strict compliance with Independent Architecture Review v1 (Finding D-01 and D-07 Safeguards):
- **Zero data fabrication**: Missing sessions, records, or features are honestly reported as zero / unavailable.
- **Honest Provenance**: No non-existent quotes, fills, or reserves are assumed or inferred.
- **Readiness Conclusion**: ${isTelemetryDatasetEmpty ? "No live or archived 12.94-B telemetry sessions currently exist in the canonical `.tmp/telemetry/sessions` path. Prior test suites executed inside `.tmp/isolated/...` sandbox environments. Consequently, the workspace is currently classified as **`INSUFFICIENT_EVIDENCE`** for quantitative hypothesis evaluation." : "Telemetry sessions discovered; readiness metrics reported below."}

---

## 2. Session & Decision Denominators

| Metric                                  | Count | Notes                                               |
| :-------------------------------------- | :---- | :-------------------------------------------------- |
| **Total Telemetry Sessions Found**      | ${totalSessionsFound} | In \`.tmp/telemetry/sessions\`                      |
| • Finalized Sessions                    | ${finalizedSessionsCount} | Passed atomicity & completeness checks              |
| • Interrupted Sessions                  | ${interruptedSessionsCount} | Excluded from primary alpha cohorts                 |
| • Unfinalized / Active Sessions         | ${unfinalizedSessionsCount} | Excluded (incomplete finalization)                  |
| **Total Candidate Decisions**           | ${totalDecisions} | Total decisions across all cohorts                  |
| • \`FILTERED_REJECTED\`                   | ${decisionsByCohort.FILTERED_REJECTED} | Initial scanner filter rejections                   |
| • \`WATCHLIST_RADAR\`                     | ${decisionsByCohort.WATCHLIST_RADAR} | Admitted to watchlist tracking                      |
| • \`TRIGGER_REJECTED\`                    | ${decisionsByCohort.TRIGGER_REJECTED} | Evaluated at trigger, rejected                      |
| • \`EXECUTED_BUY\`                        | ${decisionsByCohort.EXECUTED_BUY} | Executed buy decisions                              |
| **Total Market Observations**           | ${totalObservations} | Follow-up observation records                       |
| • Observations with Verified Pool ID    | ${observationsWithVerifiedPool} | Verified via \`isVerifiedMatchingPool\`               |
| • Observations with Valid AMM Reserves  | ${observationsWithReserveSnapshot} | Verified pool observations with base/quote reserves |
| • Usable Pre-Decision Reserve Snapshots | ${decisionsWithUsablePreDecisionReserves} | Verified pre-decision point-in-time AMM reserves    |
| **Total Executable Quotes (12.94-C)**   | ${totalQuotesFound} | Standalone 12.94-C execution quotes on disk         |
| **Total Simulated Fills (12.94-C)**     | ${totalFillsFound} | Standalone 12.94-C simulated fills on disk          |
| **Total Stratified Sampling Records**   | ${totalSamplingRecords} | Tracked sampling trajectory records                 |
| **Total Malformed / Corrupted Records** | ${totalMalformedRecordsCount} | Invalid JSON records quarantined                    |
| **Legacy Pre-12.94 Sessions**           | ${legacySessions.length} | In \`.tmp/sessions\` (pre-telemetry format)         |

---

## 3. Feature Availability & Missingness Distribution

| Feature Name             | Available Count                          | Availability Rate                                                                                        | Current Provenance Status                                    |
| :----------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| **tokenAgeSec**          | ${featureCounts.tokenAgeSec}             | ${totalDecisions > 0 ? ((featureCounts.tokenAgeSec / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}   | ${totalDecisions > 0 ? "DERIVED (from pairOpenTimeMs)" : "UNAVAILABLE"} |
| **liquidityUsd**         | ${featureCounts.liquidityUsd}            | ${totalDecisions > 0 ? ((featureCounts.liquidityUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}  | ${totalDecisions > 0 ? "OBSERVED (DexScreener/Raydium)" : "UNAVAILABLE"} |
| **marketCapUsd**         | ${featureCounts.marketCapUsd}            | ${totalDecisions > 0 ? ((featureCounts.marketCapUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}  | ${totalDecisions > 0 ? "OBSERVED (DexScreener/Raydium)" : "UNAVAILABLE"} |
| **lmcRatio**             | ${featureCounts.lmcRatio}                | ${totalDecisions > 0 ? ((featureCounts.lmcRatio / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}      | ${totalDecisions > 0 ? "DERIVED (Liquidity / MarketCap)" : "UNAVAILABLE"} |
| **lpBurnPct**            | ${featureCounts.lpBurnPct}               | ${totalDecisions > 0 ? ((featureCounts.lpBurnPct / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}     | ${totalDecisions > 0 ? "OBSERVED (frequently null in REST)" : "UNAVAILABLE"} |
| **spotPriceUsd**         | ${featureCounts.spotPriceUsd}            | ${totalDecisions > 0 ? ((featureCounts.spotPriceUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}  | ${totalDecisions > 0 ? "OBSERVED (REST spot quote)" : "UNAVAILABLE"} |
| **spotPriceSol**         | ${featureCounts.spotPriceSol}            | ${totalDecisions > 0 ? ((featureCounts.spotPriceSol / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}  | ${totalDecisions > 0 ? "OBSERVED / DERIVED (SOL quote)" : "UNAVAILABLE"} |
| **volume5mUsd**          | ${featureCounts.volume5mUsd}             | ${totalDecisions > 0 ? ((featureCounts.volume5mUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}   | ${totalDecisions > 0 ? "OBSERVED (5m aggregate volume)" : "UNAVAILABLE"} |
| **txCount5m**            | ${featureCounts.txCount5m}               | ${totalDecisions > 0 ? ((featureCounts.txCount5m / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}     | ${totalDecisions > 0 ? "OBSERVED (5m transaction count)" : "UNAVAILABLE"} |
| **buys5m / sells5m**     | ${featureCounts.buys5m}                  | ${totalDecisions > 0 ? ((featureCounts.buys5m / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"}        | ${totalDecisions > 0 ? "OBSERVED (5m buy/sell breakdown)" : "UNAVAILABLE"} |
| **baseReserve**          | ${featureCounts.baseReserve}             | ${totalObservations > 0 ? ((featureCounts.baseReserve / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (in follow-up telemetry)" : "UNAVAILABLE"} |
| **quoteReserve**         | ${featureCounts.quoteReserve}            | ${totalObservations > 0 ? ((featureCounts.quoteReserve / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (in follow-up telemetry)" : "UNAVAILABLE"} |
| **top10ConcentrationPct** | ${featureCounts.top10ConcentrationPct}   | ${totalObservations > 0 ? ((featureCounts.top10ConcentrationPct / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (optional holder metric)" : "UNAVAILABLE"} |
| **devHoldingPct**        | ${featureCounts.devHoldingPct}           | ${totalObservations > 0 ? ((featureCounts.devHoldingPct / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (optional holder metric)" : "UNAVAILABLE"} |

---

## 4. Evaluation Feasibility Assessment for Hypotheses H1–H4

| Hypothesis                                | Required Features                                            | Current Data Feasibility | Reason Code if Ineligible             |
| :---------------------------------------- | :----------------------------------------------------------- | :----------------------- | :------------------------------------ |
| **H1: Liquidity Depth & Price Impact**    | Pre-decision quoteReserve, baseReserve, tradeSize            | ${h1Feasible ? "FEASIBLE" : "INELIGIBLE"} | ${h1Feasible ? "Eligible for synthetic replay" : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"} |
| **H2: Order Flow Momentum**               | buys5m, sells5m, volume5mUsd (co-occurring on same decision) | ${h2Feasible ? "FEASIBLE" : "INELIGIBLE"} | ${h2Feasible ? "Eligible for observational analysis" : "FIELD_NOT_COLLECTED_IN_GENERATION"} |
| **H3: Structural Safety & Concentration** | lpBurnPct, devHoldingPct                                     | ${h3Feasible ? "FEASIBLE" : "INELIGIBLE"} | ${h3Feasible ? "Eligible" : "PROVIDER_RESPONSE_OMITTED_FIELD"} |
| **H4: Dynamic Capacity Sizing**           | Capacity curve grid on point-in-time reserves                | ${h4Feasible ? "FEASIBLE" : "INELIGIBLE"} | ${h4Feasible ? "Eligible" : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"} |

---

## 5. Milestone D.1 Readiness Conclusion

1. **Dataset Adequacy**: ${isTelemetryDatasetEmpty ? "The disk telemetry directory currently contains zero recorded sessions. This is expected given that Windows PAPER trading has remained paused and prior tests ran in isolated sandbox environments." : "Telemetry sessions found on disk."}
2. **Defensible Action**:
   - Do **NOT** fabricate synthetic sessions or backtest results to simulate a profitable edge.
   - Deploy \`TelemetryExecutionJoinEngine\` and \`ResearchEligibilityGate\` with full regression test coverage on deterministic fixtures.
   - When new telemetry is gathered in future approved phases, this readiness audit will automatically evaluate live session eligibility against preregistered criteria.
`;

  fs.mkdirSync(path.dirname(reportOutputPath), { recursive: true });
  fs.writeFileSync(reportOutputPath, report, "utf8");
  console.log(`[AuditResearchReadiness] Report written to: ${reportOutputPath}`);
  console.log(`  Readiness Status: ${overallReadinessStatus}`);
  return {
    totalSessionsFound,
    finalizedSessionsCount,
    interruptedSessionsCount,
    unfinalizedSessionsCount,
    totalDecisions,
    totalObservations,
    observationsWithVerifiedPool,
    observationsWithReserveSnapshot,
    decisionsWithUsablePreDecisionReserves,
    totalQuotesFound,
    totalFillsFound,
    totalSamplingRecords,
    totalMalformedRecordsCount,
    h1Feasible,
    h2Feasible,
    h3Feasible,
    h4Feasible,
    overallReadinessStatus,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runReadinessAudit();
}
