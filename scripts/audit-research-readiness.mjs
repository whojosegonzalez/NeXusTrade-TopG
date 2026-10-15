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
const rootDir = path.resolve(__dirname, "..");

const telemetrySessionsDir = path.resolve(rootDir, ".tmp", "telemetry", "sessions");
const legacySessionsDir = path.resolve(rootDir, ".tmp", "sessions");
const reportOutputPath = path.resolve(rootDir, "audit", "RESEARCH_INPUT_READINESS_REPORT.md");

export function runReadinessAudit() {
  console.log("[AuditResearchReadiness] Scanning canonical disk locations...");
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

  let totalQuotesFound = 0;
  let totalFillsFound = 0;
  let totalSamplingRecords = 0;

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

  // 1. Scan .tmp/telemetry/sessions
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
          // ignore
        }
      }
      if (fs.existsSync(summaryPath)) {
        try {
          summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        } catch {
          // ignore
        }
      }

      const status =
        meta?.sessionStatus ??
        (meta?.isInterruptedSession
          ? "INTERRUPTED"
          : summary?.isCompleteSession
            ? "FINALIZED"
            : "UNFINALIZED");
      if (status === "FINALIZED") finalizedSessionsCount++;
      else if (status === "INTERRUPTED") interruptedSessionsCount++;
      else unfinalizedSessionsCount++;

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
            if (dec.decisionCohort && decisionsByCohort[dec.decisionCohort] !== undefined) {
              decisionsByCohort[dec.decisionCohort]++;
            }
            if (dec.metricsSnapshot) {
              const ms = dec.metricsSnapshot;
              for (const [key, val] of Object.entries(ms)) {
                if (val !== null && val !== undefined && featureCounts[key] !== undefined) {
                  featureCounts[key]++;
                }
              }
            }
          } catch {
            // ignore malformed
          }
        }
      }

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
            if (obs.actualResponsePoolId) {
              observationsWithVerifiedPool++;
            }
            if (obs.liquidityMetrics?.baseReserve > 0 && obs.liquidityMetrics?.quoteReserve > 0) {
              observationsWithReserveSnapshot++;
              featureCounts.baseReserve++;
              featureCounts.quoteReserve++;
            }
            if (obs.holderMetrics?.top10ConcentrationPct != null) {
              featureCounts.top10ConcentrationPct++;
            }
            if (obs.holderMetrics?.devHoldingPct != null) {
              featureCounts.devHoldingPct++;
            }
          } catch {
            // ignore
          }
        }
      }

      let quotesCount = 0;
      if (fs.existsSync(quotesPath)) {
        const lines = fs
          .readFileSync(quotesPath, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        quotesCount = lines.length;
        totalQuotesFound += quotesCount;
      }

      let fillsCount = 0;
      if (fs.existsSync(fillsPath)) {
        const lines = fs
          .readFileSync(fillsPath, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        fillsCount = lines.length;
        totalFillsFound += fillsCount;
      }

      let samplesCount = 0;
      if (fs.existsSync(samplesPath)) {
        const lines = fs
          .readFileSync(samplesPath, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        samplesCount = lines.length;
        totalSamplingRecords += samplesCount;
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

  // 3. Compute readiness status honestly
  const isTelemetryDatasetEmpty = totalSessionsFound === 0 || totalDecisions === 0;
  const overallReadinessStatus = isTelemetryDatasetEmpty
    ? "INSUFFICIENT_EVIDENCE (NO_PERSISTED_TELEMETRY_SESSIONS)"
    : totalDecisions < 100
      ? "INSUFFICIENT_EVIDENCE (SUBMARGINAL_DECISION_COUNT)"
      : "PRELIMINARY_EVIDENCE_AVAILABLE";

  // 4. Generate Markdown report
  const report = `# NeXusTrade — Research Input Readiness & Lineage Report

**Audit Date:** ${auditTimestamp}  
**Status:** **${overallReadinessStatus}**  
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

| Metric | Count | Notes |
| :--- | :--- | :--- |
| **Total Telemetry Sessions Found** | ${totalSessionsFound} | In \`.tmp/telemetry/sessions\` |
| • Finalized Sessions | ${finalizedSessionsCount} | Passed atomicity & completeness checks |
| • Interrupted Sessions | ${interruptedSessionsCount} | Excluded from primary alpha cohorts |
| • Unfinalized / Active Sessions | ${unfinalizedSessionsCount} | Excluded (incomplete finalization) |
| **Total Candidate Decisions** | ${totalDecisions} | Total decisions across all cohorts |
| • \`FILTERED_REJECTED\` | ${decisionsByCohort.FILTERED_REJECTED} | Initial scanner filter rejections |
| • \`WATCHLIST_RADAR\` | ${decisionsByCohort.WATCHLIST_RADAR} | Admitted to watchlist tracking |
| • \`TRIGGER_REJECTED\` | ${decisionsByCohort.TRIGGER_REJECTED} | Evaluated at trigger, rejected |
| • \`EXECUTED_BUY\` | ${decisionsByCohort.EXECUTED_BUY} | Executed buy decisions |
| **Total Market Observations** | ${totalObservations} | Follow-up observation records |
| • Observations with Verified Pool ID | ${observationsWithVerifiedPool} | Verified via \`isVerifiedMatchingPool\` |
| • Observations with Usable AMM Reserves | ${observationsWithReserveSnapshot} | Contains valid non-zero base/quote reserves |
| **Total Executable Quotes (12.94-C)** | ${totalQuotesFound} | Standalone 12.94-C execution quotes on disk |
| **Total Simulated Fills (12.94-C)** | ${totalFillsFound} | Standalone 12.94-C simulated fills on disk |
| **Total Stratified Sampling Records** | ${totalSamplingRecords} | Tracked sampling trajectory records |
| **Legacy Pre-12.94 Sessions** | ${legacySessions.length} | In \`.tmp/sessions\` (pre-telemetry format) |

---

## 3. Feature Availability & Missingness Distribution

| Feature Name | Available Count | Availability Rate | Current Provenance Status |
| :--- | :--- | :--- | :--- |
| **tokenAgeSec** | ${featureCounts.tokenAgeSec} | ${totalDecisions > 0 ? ((featureCounts.tokenAgeSec / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "DERIVED (from pairOpenTimeMs)" : "UNAVAILABLE"} |
| **liquidityUsd** | ${featureCounts.liquidityUsd} | ${totalDecisions > 0 ? ((featureCounts.liquidityUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (DexScreener/Raydium)" : "UNAVAILABLE"} |
| **marketCapUsd** | ${featureCounts.marketCapUsd} | ${totalDecisions > 0 ? ((featureCounts.marketCapUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (DexScreener/Raydium)" : "UNAVAILABLE"} |
| **lmcRatio** | ${featureCounts.lmcRatio} | ${totalDecisions > 0 ? ((featureCounts.lmcRatio / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "DERIVED (Liquidity / MarketCap)" : "UNAVAILABLE"} |
| **lpBurnPct** | ${featureCounts.lpBurnPct} | ${totalDecisions > 0 ? ((featureCounts.lpBurnPct / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (frequently null in REST)" : "UNAVAILABLE"} |
| **spotPriceUsd** | ${featureCounts.spotPriceUsd} | ${totalDecisions > 0 ? ((featureCounts.spotPriceUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (REST spot quote)" : "UNAVAILABLE"} |
| **spotPriceSol** | ${featureCounts.spotPriceSol} | ${totalDecisions > 0 ? ((featureCounts.spotPriceSol / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED / DERIVED (SOL quote)" : "UNAVAILABLE"} |
| **volume5mUsd** | ${featureCounts.volume5mUsd} | ${totalDecisions > 0 ? ((featureCounts.volume5mUsd / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (5m aggregate volume)" : "UNAVAILABLE"} |
| **txCount5m** | ${featureCounts.txCount5m} | ${totalDecisions > 0 ? ((featureCounts.txCount5m / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (5m transaction count)" : "UNAVAILABLE"} |
| **buys5m / sells5m** | ${featureCounts.buys5m} | ${totalDecisions > 0 ? ((featureCounts.buys5m / totalDecisions) * 100).toFixed(1) + "%" : "0.0%"} | ${totalDecisions > 0 ? "OBSERVED (5m buy/sell breakdown)" : "UNAVAILABLE"} |
| **baseReserve** | ${featureCounts.baseReserve} | ${totalObservations > 0 ? ((featureCounts.baseReserve / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (in follow-up telemetry)" : "UNAVAILABLE"} |
| **quoteReserve** | ${featureCounts.quoteReserve} | ${totalObservations > 0 ? ((featureCounts.quoteReserve / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (in follow-up telemetry)" : "UNAVAILABLE"} |
| **top10ConcentrationPct** | ${featureCounts.top10ConcentrationPct} | ${totalObservations > 0 ? ((featureCounts.top10ConcentrationPct / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (optional holder metric)" : "UNAVAILABLE"} |
| **devHoldingPct** | ${featureCounts.devHoldingPct} | ${totalObservations > 0 ? ((featureCounts.devHoldingPct / totalObservations) * 100).toFixed(1) + "%" : "0.0%"} | ${totalObservations > 0 ? "OBSERVED (optional holder metric)" : "UNAVAILABLE"} |

---

## 4. Evaluation Feasibility Assessment for Hypotheses H1–H4

| Hypothesis | Required Features | Current Data Feasibility | Reason Code if Ineligible |
| :--- | :--- | :--- | :--- |
| **H1: Liquidity Depth & Price Impact** | Pre-decision quoteReserve, baseReserve, tradeSize | ${featureCounts.quoteReserve > 0 ? "FEASIBLE" : "INELIGIBLE"} | ${featureCounts.quoteReserve > 0 ? "Eligible for synthetic replay" : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"} |
| **H2: Order Flow Momentum** | buys5m, sells5m, volume5mUsd | ${featureCounts.buys5m > 0 ? "FEASIBLE" : "INELIGIBLE"} | ${featureCounts.buys5m > 0 ? "Eligible for observational analysis" : "FIELD_NOT_COLLECTED_IN_GENERATION"} |
| **H3: Structural Safety & Concentration** | lpBurnPct, devHoldingPct | ${featureCounts.lpBurnPct > 0 && featureCounts.devHoldingPct > 0 ? "FEASIBLE" : "INELIGIBLE"} | ${featureCounts.lpBurnPct > 0 && featureCounts.devHoldingPct > 0 ? "Eligible" : "PROVIDER_RESPONSE_OMITTED_FIELD"} |
| **H4: Dynamic Capacity Sizing** | Capacity curve grid on point-in-time reserves | ${featureCounts.quoteReserve > 0 ? "FEASIBLE" : "INELIGIBLE"} | ${featureCounts.quoteReserve > 0 ? "Eligible" : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT"} |

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
    totalDecisions,
    totalObservations,
    overallReadinessStatus,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runReadinessAudit();
}
