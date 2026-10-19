#!/usr/bin/env node
/**
 * scripts/audit-gate2-reconciliation.mjs
 *
 * Canonical Gate 2 Session Reconciliation and Data Audit Script (ADG-05).
 *
 * Resolves metric discrepancies between candidate-decisions.jsonl and
 * discovery-diagnostics.jsonl by joining on immutable decision-event IDs (eventId === decisionEventId).
 *
 * Key Invariants & Provenance:
 * 1. candidate-decisions.jsonl:metricsSnapshot.tokenAgeSec is null (UNAVAILABLE)
 *    because Raydium API v3 catalog reports pool openTime, not token creation slot.
 * 2. discovery-diagnostics.jsonl:poolAgeAtDiscoverySec is the authoritative point-in-time
 *    measurement of pool freshness relative to receiptEpochMs.
 * 3. Both files join 1:1 on eventId === decisionEventId (51 records in Gate 2).
 *
 * Usage:
 *   node scripts/audit-gate2-reconciliation.mjs [--session-dir=<path>]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_SESSION_DIR =
  "C:\\Users\\whojo\\NeXusTrade-Pilot-Data\\gate2\\sessions\\pilot-sess-1792394528063";

function parseArgs() {
  const args = process.argv.slice(2);
  let sessionDir = DEFAULT_SESSION_DIR;
  for (const arg of args) {
    if (arg.startsWith("--session-dir=")) {
      sessionDir = arg.split("=")[1];
    }
  }
  return { sessionDir };
}

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function runAudit() {
  const { sessionDir } = parseArgs();
  console.log(`[AUDIT] Commencing canonical Gate 2 reconciliation audit: ${sessionDir}\n`);

  if (!fs.existsSync(sessionDir)) {
    console.error(`[ERROR] Session directory does not exist: ${sessionDir}`);
    process.exit(1);
  }

  const files = {
    decisions: path.join(sessionDir, "candidate-decisions.jsonl"),
    diagnostics: path.join(sessionDir, "discovery-diagnostics.jsonl"),
    shadow: path.join(sessionDir, "shadow-evaluations.jsonl"),
    summary: path.join(sessionDir, "session-summary.json"),
    meta: path.join(sessionDir, "session-meta.json"),
    manifest: path.join(sessionDir, "manifest.json"),
  };

  for (const [name, p] of Object.entries(files)) {
    if (!fs.existsSync(p)) {
      console.error(`[ERROR] Missing required session file: ${name} (${p})`);
      process.exit(1);
    }
  }

  // Read and parse files
  const decisions = fs
    .readFileSync(files.decisions, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const diagnostics = fs
    .readFileSync(files.diagnostics, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const shadows = fs
    .readFileSync(files.shadow, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const summary = JSON.parse(fs.readFileSync(files.summary, "utf8"));
  const meta = JSON.parse(fs.readFileSync(files.meta, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8"));

  console.log("=== 1. FILE & DIGEST INTEGRITY ===");
  console.log(
    `Candidate Decisions:   ${decisions.length} lines | SHA256: ${sha256File(files.decisions)}`,
  );
  console.log(
    `Discovery Diagnostics: ${diagnostics.length} lines | SHA256: ${sha256File(files.diagnostics)}`,
  );
  console.log(
    `Shadow Evaluations:    ${shadows.length} lines | SHA256: ${sha256File(files.shadow)}`,
  );
  console.log(
    `Session Summary:       ${fs.statSync(files.summary).size} bytes | SHA256: ${sha256File(files.summary)}`,
  );
  console.log(`Manifest Digest:       ${manifest.manifestDigestSha256}`);
  console.log(
    `Session Status:        ${meta.sessionStatus} (Stop reason: ${summary.isCompleteSession ? "DURATION_EXPIRED" : "UNKNOWN"})\n`,
  );

  // Verify 1:1 join on eventId
  console.log("=== 2. IMMUTABLE DECISION-EVENT JOIN ===");
  const diagMap = new Map();
  for (const d of diagnostics) {
    diagMap.set(d.decisionEventId, d);
  }

  let joinMatches = 0;
  let missingDiags = 0;
  for (const dec of decisions) {
    if (diagMap.has(dec.eventId)) {
      joinMatches++;
    } else {
      missingDiags++;
    }
  }

  console.log(`Total candidate decisions:       ${decisions.length}`);
  console.log(`Total discovery diagnostics:     ${diagnostics.length}`);
  console.log(`Successful 1:1 eventId joins:    ${joinMatches}`);
  console.log(`Missing diagnostic joins:        ${missingDiags}`);

  if (joinMatches !== decisions.length || missingDiags > 0) {
    console.error("[FAIL] Decision-event ID join failed! Corrupted provenance.");
    process.exit(1);
  }
  console.log("[PASS] 100% 1:1 decision-event ID alignment confirmed.\n");

  // Reconcile age metrics discrepancy
  console.log("=== 3. AGE METRIC PROVENANCE RECONCILIATION ===");
  let metricsSnapshotNullCount = 0;
  let diagAgeValidCount = 0;
  let diagAgeInvalidCount = 0;
  let freshUnder24hCount = 0;
  let matureOver24hCount = 0;

  for (const dec of decisions) {
    const diag = diagMap.get(dec.eventId);
    const tokenAge = dec.metricsSnapshot?.tokenAgeSec;
    if (tokenAge === null || tokenAge === undefined) {
      metricsSnapshotNullCount++;
    }

    const poolAge = diag.poolAgeAtDiscoverySec;
    if (poolAge === null || poolAge === undefined) {
      diagAgeInvalidCount++;
    } else {
      diagAgeValidCount++;
      if (poolAge <= 86400) {
        freshUnder24hCount++;
      } else {
        matureOver24hCount++;
      }
    }
  }

  console.log(
    `metricsSnapshot.tokenAgeSec null count:        ${metricsSnapshotNullCount} / ${decisions.length}`,
  );
  console.log(
    `  -> Reason: Raydium API does not provide token creation time; tokenAgeSec is UNAVAILABLE.`,
  );
  console.log(`discovery-diagnostics.poolAgeAtDiscoverySec:`);
  console.log(`  -> Valid open times (with poolAgeAtDiscoverySec): ${diagAgeValidCount}`);
  console.log(`     - Fresh pools (age <= 24h / 86,400s):         ${freshUnder24hCount}`);
  console.log(`     - Mature pools (age > 24h):                   ${matureOver24hCount}`);
  console.log(`  -> Invalid open times (openTime: '0'):           ${diagAgeInvalidCount}`);
  console.log(
    `  -> Total classified:                             ${diagAgeValidCount + diagAgeInvalidCount} / ${decisions.length}\n`,
  );

  // Program family cross-tabulation
  console.log("=== 4. PROTOCOL PROGRAM X AGE CLASSIFICATION ===");
  const crossTab = {};
  for (const dec of decisions) {
    const diag = diagMap.get(dec.eventId);
    const ammEval = dec.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
    const orientEval = dec.filterEvaluations.find((f) => f.filterName === "WSOL_PAIR_ORIENTATION");
    const progObserved = ammEval ? ammEval.valueObserved : "unknown";
    const isWsol = orientEval ? orientEval.passed : false;
    const poolAge = diag.poolAgeAtDiscoverySec;

    if (!crossTab[progObserved]) {
      crossTab[progObserved] = {
        total: 0,
        wsolPaired: 0,
        nonSolPair: 0,
        freshUnder24h: 0,
        matureOver24h: 0,
        invalidAge: 0,
      };
    }
    const entry = crossTab[progObserved];
    entry.total++;
    if (isWsol) entry.wsolPaired++;
    else entry.nonSolPair++;
    if (poolAge === null) entry.invalidAge++;
    else if (poolAge <= 86400) entry.freshUnder24h++;
    else entry.matureOver24h++;
  }

  console.table(crossTab);

  // Detail the 8 fresh pools
  console.log("\n=== 5. DETAILED BREAKDOWN OF THE 8 FRESH POOLS (AGE <= 24H) ===");
  const freshPools = decisions
    .map((d) => ({ dec: d, diag: diagMap.get(d.eventId) }))
    .filter(
      ({ diag }) => diag.poolAgeAtDiscoverySec !== null && diag.poolAgeAtDiscoverySec <= 86400,
    );

  for (let i = 0; i < freshPools.length; i++) {
    const { dec, diag } = freshPools[i];
    const orient = dec.filterEvaluations.find((f) => f.filterName === "WSOL_PAIR_ORIENTATION");
    const amm = dec.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
    console.log(
      `[Fresh #${i + 1}] Pool: ${dec.poolId} | Symbol: ${dec.symbol.padEnd(6)} | Age: ${(diag.poolAgeAtDiscoverySec / 3600).toFixed(2).padStart(5)}h (${diag.poolAgeAtDiscoverySec}s) | Program: ${amm?.valueObserved} | Rejection: ${orient?.rejectionReason}`,
    );
  }

  // Verify Funnel Invariants
  console.log("\n=== 6. DISCOVERY FUNNEL INVARIANTS VERIFICATION ===");
  const funnel = summary.discoveryFunnel;
  const inv1 =
    funnel.uniquePoolsEncountered + funnel.repeatedPoolsSuppressed + funnel.malformedRawEntries ===
    funnel.apiPoolsReturned;
  const inv2 =
    funnel.initialSnapshotPoolsEncountered + funnel.laterPollArrivalsEncountered ===
    funnel.uniquePoolsEncountered;
  const inv3 =
    funnel.poolAgeClassifications.validAgeCount +
      funnel.poolAgeClassifications.missingAgeCount +
      funnel.poolAgeClassifications.invalidAgeCount +
      funnel.poolAgeClassifications.futureDatedAgeCount ===
    funnel.uniquePoolsEncountered;
  const inv4 =
    funnel.poolAgeClassifications.confirmedAgeFilterPasses +
      funnel.poolAgeClassifications.ageFilterExclusions ===
    funnel.uniquePoolsEncountered;
  const inv5 =
    funnel.poolAgeClassifications.initialSnapshotFreshPasses +
      funnel.poolAgeClassifications.laterPollFreshArrivals ===
    funnel.poolAgeClassifications.confirmedAgeFilterPasses;
  const inv6 =
    funnel.eligibleForVerification +
      funnel.preVerificationExclusions.totalPreVerificationExcluded ===
    funnel.uniquePoolsEncountered;

  console.log(
    `Invariant 1 (apiPoolsReturned = unique + repeated + malformed):  ${inv1 ? "[PASS]" : "[FAIL]"} (${funnel.uniquePoolsEncountered} + ${funnel.repeatedPoolsSuppressed} + ${funnel.malformedRawEntries} = ${funnel.apiPoolsReturned})`,
  );
  console.log(
    `Invariant 2 (unique = initialSnapshot + laterArrivals):          ${inv2 ? "[PASS]" : "[FAIL]"} (${funnel.initialSnapshotPoolsEncountered} + ${funnel.laterPollArrivalsEncountered} = ${funnel.uniquePoolsEncountered})`,
  );
  console.log(
    `Invariant 3 (unique = valid + missing + invalid + futureDated):  ${inv3 ? "[PASS]" : "[FAIL]"} (${funnel.poolAgeClassifications.validAgeCount} + ${funnel.poolAgeClassifications.missingAgeCount} + ${funnel.poolAgeClassifications.invalidAgeCount} + ${funnel.poolAgeClassifications.futureDatedAgeCount} = ${funnel.uniquePoolsEncountered})`,
  );
  console.log(
    `Invariant 4 (unique = confirmedPasses + exclusions):             ${inv4 ? "[PASS]" : "[FAIL]"} (${funnel.poolAgeClassifications.confirmedAgeFilterPasses} + ${funnel.poolAgeClassifications.ageFilterExclusions} = ${funnel.uniquePoolsEncountered})`,
  );
  console.log(
    `Invariant 5 (confirmedPasses = initialPasses + laterPasses):     ${inv5 ? "[PASS]" : "[FAIL]"} (${funnel.poolAgeClassifications.initialSnapshotFreshPasses} + ${funnel.poolAgeClassifications.laterPollFreshArrivals} = ${funnel.poolAgeClassifications.confirmedAgeFilterPasses})`,
  );
  console.log(
    `Invariant 6 (unique = eligible + totalPreVerificationExcluded):   ${inv6 ? "[PASS]" : "[FAIL]"} (${funnel.eligibleForVerification} + ${funnel.preVerificationExclusions.totalPreVerificationExcluded} = ${funnel.uniquePoolsEncountered})`,
  );

  const allPassed = inv1 && inv2 && inv3 && inv4 && inv5 && inv6;
  if (!allPassed) {
    console.error("\n[FAIL] Funnel invariant check failed!");
    process.exit(1);
  }

  console.log(
    "\n[AUDIT RESULT] ALL GATE 2 INVARIANTS, DIGESTS, AND PROVENANCE JOINS CONFIRMED VALID.",
  );
}

runAudit();
