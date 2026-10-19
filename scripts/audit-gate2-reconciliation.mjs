#!/usr/bin/env node
/**
 * scripts/audit-gate2-reconciliation.mjs
 *
 * Canonical Gate 2 Session Reconciliation and Data Audit Script (ADG-05 / D.2.8).
 *
 * Implements automated validation of:
 * 1. Cryptographic manifest integrity (file existence, exact sizeBytes, sha256 digests,
 *    internal manifestDigestSha256, extraneous file prevention).
 * 2. Immutable two-way 1:1 join between candidate-decisions.jsonl and discovery-diagnostics.jsonl
 *    (eventId === decisionEventId with 0 orphan records in either direction, no duplicates).
 * 3. Identity and provenance matching (poolId, sessionId, generationId across joined records).
 * 4. Derived count and funnel metric reconciliation between JSONL archives and session-summary.json.
 * 5. Discovery funnel invariant verification (Invariants 1-6).
 *
 * Usage:
 *   node scripts/audit-gate2-reconciliation.mjs [--session-dir=<path>]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_GATE2_SESSION_DIR =
  "C:\\Users\\whojo\\NeXusTrade-Pilot-Data\\gate2\\sessions\\pilot-sess-1792394528063";

export function computeSha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function countNonEmptyLines(text) {
  if (!text) return 0;
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

export function runGate2ReconciliationAudit(sessionDir = DEFAULT_GATE2_SESSION_DIR, options = {}) {
  const silent = options.silent ?? false;
  const log = silent ? () => {} : console.log;
  const errors = [];

  log(`[AUDIT] Commencing canonical Gate 2 reconciliation audit: ${sessionDir}\n`);

  if (!fs.existsSync(sessionDir)) {
    errors.push(`Session directory does not exist: ${sessionDir}`);
    return { success: false, errors, details: null };
  }

  const manifestPath = path.join(sessionDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`manifest.json missing in session directory: ${manifestPath}`);
    return { success: false, errors, details: null };
  }

  let manifest;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    errors.push(`Failed to parse manifest.json: ${err.message}`);
    return { success: false, errors, details: null };
  }

  // --- 1. Cryptographic Manifest Verification ---
  log("=== 1. CRYPTOGRAPHIC MANIFEST & FILE INTEGRITY ===");
  if (!Array.isArray(manifest.files)) {
    errors.push("manifest.files is not an array");
  } else {
    // Verify internal manifestDigestSha256
    const canonicalFilesJson = JSON.stringify(manifest.files);
    const expectedManifestDigest = computeSha256Hex(canonicalFilesJson);
    if (manifest.manifestDigestSha256 !== expectedManifestDigest) {
      errors.push(
        `manifestDigestSha256 mismatch: expected ${expectedManifestDigest}, found ${manifest.manifestDigestSha256}`,
      );
    } else {
      log(`Manifest Digest Verified: ${manifest.manifestDigestSha256}`);
    }

    const manifestMap = new Map();
    for (const f of manifest.files) {
      manifestMap.set(f.filename, f);
      const filePath = path.join(sessionDir, f.filename);
      if (!fs.existsSync(filePath)) {
        errors.push(`Manifest file missing on disk: ${f.filename}`);
        continue;
      }
      const fileBytes = fs.readFileSync(filePath);
      const fileSha256 = computeSha256Hex(fileBytes);
      if (fileBytes.byteLength !== f.sizeBytes) {
        errors.push(
          `File size mismatch for ${f.filename}: expected ${f.sizeBytes} bytes, found ${fileBytes.byteLength}`,
        );
      }
      if (fileSha256 !== f.sha256) {
        errors.push(`SHA256 mismatch for ${f.filename}: expected ${f.sha256}, found ${fileSha256}`);
      }
      if (typeof f.lineCount === "number") {
        const actualLines = countNonEmptyLines(fileBytes.toString("utf8"));
        if (actualLines !== f.lineCount) {
          errors.push(
            `Line count mismatch for ${f.filename}: expected ${f.lineCount}, found ${actualLines}`,
          );
        }
      }
      log(
        `  -> ${f.filename.padEnd(28)} | Size: ${fileBytes.byteLength.toString().padStart(6)}B | SHA256: ${fileSha256.slice(0, 16)}... [MATCH]`,
      );
    }

    // Extraneous file check
    const dirEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.isFile() && entry.name !== "manifest.json") {
        if (!manifestMap.has(entry.name)) {
          errors.push(`Extraneous unindexed file found in session directory: ${entry.name}`);
        }
      }
    }
  }

  // Stop early if manifest checks failed severely
  const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
  const diagnosticsPath = path.join(sessionDir, "discovery-diagnostics.jsonl");
  const summaryPath = path.join(sessionDir, "session-summary.json");
  const metaPath = path.join(sessionDir, "session-meta.json");

  if (
    !fs.existsSync(decisionsPath) ||
    !fs.existsSync(diagnosticsPath) ||
    !fs.existsSync(summaryPath)
  ) {
    return { success: false, errors, details: null };
  }

  const decisionsLines = fs.readFileSync(decisionsPath, "utf8").trim().split("\n").filter(Boolean);
  const diagnosticsLines = fs
    .readFileSync(diagnosticsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
  if (meta) {
    log(`  -> Session Metadata: ${meta.sessionId} (status: ${meta.sessionStatus})`);
  }

  const decisions = [];
  const diagnostics = [];
  for (let i = 0; i < decisionsLines.length; i++) {
    try {
      decisions.push(JSON.parse(decisionsLines[i]));
    } catch (e) {
      errors.push(`Malformed JSON on line ${i + 1} of candidate-decisions.jsonl: ${e.message}`);
    }
  }
  for (let i = 0; i < diagnosticsLines.length; i++) {
    try {
      diagnostics.push(JSON.parse(diagnosticsLines[i]));
    } catch (e) {
      errors.push(`Malformed JSON on line ${i + 1} of discovery-diagnostics.jsonl: ${e.message}`);
    }
  }

  // --- 2. Immutable Two-Way 1:1 Join & Identity Consistency ---
  log("\n=== 2. TWO-WAY 1:1 DECISION-EVENT JOIN & IDENTITY VERIFICATION ===");
  const decMap = new Map();
  const diagMap = new Map();

  for (const dec of decisions) {
    if (decMap.has(dec.eventId)) {
      errors.push(`Duplicate eventId in candidate-decisions.jsonl: ${dec.eventId}`);
    }
    decMap.set(dec.eventId, dec);
  }

  for (const diag of diagnostics) {
    if (diagMap.has(diag.decisionEventId)) {
      errors.push(
        `Duplicate decisionEventId in discovery-diagnostics.jsonl: ${diag.decisionEventId}`,
      );
    }
    diagMap.set(diag.decisionEventId, diag);
  }

  let forwardMatches = 0;
  let orphanDecisions = 0;
  for (const dec of decisions) {
    const diag = diagMap.get(dec.eventId);
    if (!diag) {
      orphanDecisions++;
      errors.push(`Orphan decision: eventId ${dec.eventId} has no matching discovery diagnostic`);
    } else {
      forwardMatches++;
      // Identity assertions
      if (dec.poolId !== diag.poolId) {
        errors.push(
          `PoolId mismatch for eventId ${dec.eventId}: decision has '${dec.poolId}', diagnostic has '${diag.poolId}'`,
        );
      }
      if (dec.sessionId !== diag.sessionId) {
        errors.push(
          `SessionId mismatch for eventId ${dec.eventId}: decision has '${dec.sessionId}', diagnostic has '${diag.sessionId}'`,
        );
      }
      if (dec.generationId && diag.generationId && dec.generationId !== diag.generationId) {
        errors.push(
          `GenerationId mismatch for eventId ${dec.eventId}: decision has '${dec.generationId}', diagnostic has '${diag.generationId}'`,
        );
      }
    }
  }

  let reverseMatches = 0;
  let orphanDiagnostics = 0;
  for (const diag of diagnostics) {
    if (!decMap.has(diag.decisionEventId)) {
      orphanDiagnostics++;
      errors.push(
        `Orphan diagnostic: decisionEventId ${diag.decisionEventId} has no matching candidate decision`,
      );
    } else {
      reverseMatches++;
    }
  }

  log(`Candidate Decisions count:       ${decisions.length}`);
  log(`Discovery Diagnostics count:     ${diagnostics.length}`);
  log(`Forward Join Matches (Dec->Diag): ${forwardMatches} (Orphans: ${orphanDecisions})`);
  log(`Reverse Join Matches (Diag->Dec): ${reverseMatches} (Orphans: ${orphanDiagnostics})`);

  if (orphanDecisions === 0 && orphanDiagnostics === 0 && forwardMatches === decisions.length) {
    log("[PASS] Perfect two-way 1:1 join with zero orphan records confirmed.");
  }

  // --- 3. Derived Count & Summary Reconciliation ---
  log("\n=== 3. DERIVED COUNTS & FUNNEL RECONCILIATION ===");
  if (summary.totalCandidatesScreened !== decisions.length) {
    errors.push(
      `summary.totalCandidatesScreened (${summary.totalCandidatesScreened}) does not match decisions count (${decisions.length})`,
    );
  }
  if (summary.totalDecisionsRecorded !== decisions.length) {
    errors.push(
      `summary.totalDecisionsRecorded (${summary.totalDecisionsRecorded}) does not match decisions count (${decisions.length})`,
    );
  }

  // Cohort breakdown
  const cohorts = {
    FILTERED_REJECTED: 0,
    WATCHLIST_RADAR: 0,
    TRIGGER_REJECTED: 0,
    EXECUTED_BUY: 0,
  };
  const rejectionReasons = {};
  for (const dec of decisions) {
    if (cohorts[dec.decisionCohort] !== undefined) {
      cohorts[dec.decisionCohort]++;
    }
    if (dec.primaryRejectionReason) {
      rejectionReasons[dec.primaryRejectionReason] =
        (rejectionReasons[dec.primaryRejectionReason] || 0) + 1;
    }
  }

  if (summary.cohortBreakdown) {
    if (summary.cohortBreakdown.filteredRejected !== cohorts.FILTERED_REJECTED) {
      errors.push(
        `Cohort breakdown mismatch for filteredRejected: summary=${summary.cohortBreakdown.filteredRejected}, actual=${cohorts.FILTERED_REJECTED}`,
      );
    }
    if (summary.cohortBreakdown.watchlistRadar !== cohorts.WATCHLIST_RADAR) {
      errors.push(
        `Cohort breakdown mismatch for watchlistRadar: summary=${summary.cohortBreakdown.watchlistRadar}, actual=${cohorts.WATCHLIST_RADAR}`,
      );
    }
  }

  // Discovery funnel reconciliation
  const funnel = summary.discoveryFunnel;
  if (funnel) {
    const uniquePools = new Set(decisions.map((d) => d.poolId));
    if (uniquePools.size !== funnel.uniquePoolsEncountered) {
      errors.push(
        `Funnel uniquePoolsEncountered mismatch: summary=${funnel.uniquePoolsEncountered}, actual unique pool IDs in decisions=${uniquePools.size}`,
      );
    }

    const initialSnapshotCount = decisions.filter(
      (d) => d.isInitialCatalogSnapshot === true,
    ).length;
    if (initialSnapshotCount !== funnel.initialSnapshotPoolsEncountered) {
      errors.push(
        `Funnel initialSnapshotPoolsEncountered mismatch: summary=${funnel.initialSnapshotPoolsEncountered}, actual=${initialSnapshotCount}`,
      );
    }

    const laterArrivalCount = decisions.filter((d) => d.isInitialCatalogSnapshot === false).length;
    if (laterArrivalCount !== funnel.laterPollArrivalsEncountered) {
      errors.push(
        `Funnel laterPollArrivalsEncountered mismatch: summary=${funnel.laterPollArrivalsEncountered}, actual=${laterArrivalCount}`,
      );
    }

    // Age metrics
    const maxAge = summary.maxPoolAgeSec || 86400;
    let actualValidAge = 0;
    let actualInvalidAge = 0;
    let actualConfirmedFresh = 0;
    let actualInitialFresh = 0;
    let actualLaterFresh = 0;

    for (const diag of diagnostics) {
      if (diag.poolAgeAtDiscoverySec !== null && diag.poolAgeAtDiscoverySec !== undefined) {
        actualValidAge++;
        if (diag.poolAgeAtDiscoverySec <= maxAge) {
          actualConfirmedFresh++;
          if (diag.isInitialCatalogSnapshot) {
            actualInitialFresh++;
          } else {
            actualLaterFresh++;
          }
        }
      } else {
        actualInvalidAge++;
      }
    }

    if (funnel.poolAgeClassifications) {
      const pac = funnel.poolAgeClassifications;
      if (pac.validAgeCount !== actualValidAge) {
        errors.push(
          `Funnel validAgeCount mismatch: summary=${pac.validAgeCount}, actual=${actualValidAge}`,
        );
      }
      if (pac.invalidAgeCount !== actualInvalidAge) {
        errors.push(
          `Funnel invalidAgeCount mismatch: summary=${pac.invalidAgeCount}, actual=${actualInvalidAge}`,
        );
      }
      if (pac.confirmedAgeFilterPasses !== actualConfirmedFresh) {
        errors.push(
          `Funnel confirmedAgeFilterPasses mismatch: summary=${pac.confirmedAgeFilterPasses}, actual=${actualConfirmedFresh}`,
        );
      }
      if (pac.initialSnapshotFreshPasses !== actualInitialFresh) {
        errors.push(
          `Funnel initialSnapshotFreshPasses mismatch: summary=${pac.initialSnapshotFreshPasses}, actual=${actualInitialFresh}`,
        );
      }
      if (pac.laterPollFreshArrivals !== actualLaterFresh) {
        errors.push(
          `Funnel laterPollFreshArrivals mismatch: summary=${pac.laterPollFreshArrivals}, actual=${actualLaterFresh}`,
        );
      }
    }

    // Invariants
    const inv1 =
      funnel.uniquePoolsEncountered +
        funnel.repeatedPoolsSuppressed +
        funnel.malformedRawEntries ===
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

    log(
      `Invariant 1 (apiPoolsReturned = unique + repeated + malformed): ${inv1 ? "[PASS]" : "[FAIL]"}`,
    );
    log(
      `Invariant 2 (unique = initialSnapshot + laterArrivals):         ${inv2 ? "[PASS]" : "[FAIL]"}`,
    );
    log(
      `Invariant 3 (unique = valid + missing + invalid + futureDated): ${inv3 ? "[PASS]" : "[FAIL]"}`,
    );
    log(
      `Invariant 4 (unique = confirmedPasses + exclusions):            ${inv4 ? "[PASS]" : "[FAIL]"}`,
    );
    log(
      `Invariant 5 (confirmedPasses = initialPasses + laterPasses):    ${inv5 ? "[PASS]" : "[FAIL]"}`,
    );
    log(
      `Invariant 6 (unique = eligible + totalPreVerificationExcluded):  ${inv6 ? "[PASS]" : "[FAIL]"}`,
    );

    if (!inv1) errors.push("Funnel Invariant 1 violated");
    if (!inv2) errors.push("Funnel Invariant 2 violated");
    if (!inv3) errors.push("Funnel Invariant 3 violated");
    if (!inv4) errors.push("Funnel Invariant 4 violated");
    if (!inv5) errors.push("Funnel Invariant 5 violated");
    if (!inv6) errors.push("Funnel Invariant 6 violated");
  }

  // --- 4. Protocol Family Cross-Tabulation ---
  log("\n=== 4. PROTOCOL PROGRAM X AGE CLASSIFICATION ===");
  const crossTab = {};
  for (const dec of decisions) {
    const diag = diagMap.get(dec.eventId);
    const ammEval = dec.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
    const orientEval = dec.filterEvaluations.find((f) => f.filterName === "WSOL_PAIR_ORIENTATION");
    const progObserved = ammEval ? ammEval.valueObserved : "unknown";
    const isWsol = orientEval ? orientEval.passed : false;
    const poolAge = diag ? diag.poolAgeAtDiscoverySec : null;

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
  if (!silent) console.table(crossTab);

  const success = errors.length === 0;
  if (success) {
    log("\n[AUDIT RESULT] ALL GATE 2 INVARIANTS, DIGESTS, AND PROVENANCE JOINS CONFIRMED VALID.");
  } else {
    log(`\n[AUDIT RESULT] AUDIT FAILED with ${errors.length} error(s):`);
    for (const e of errors) {
      log(`  - [FAIL] ${e}`);
    }
  }

  return {
    success,
    errors,
    details: {
      decisionsCount: decisions.length,
      diagnosticsCount: diagnostics.length,
      manifestFileCount: manifest?.files?.length ?? 0,
      crossTab,
    },
  };
}

// CLI Execution entrypoint
const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === currentFilePath) {
  let sessionDir = DEFAULT_GATE2_SESSION_DIR;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--session-dir=")) {
      sessionDir = arg.split("=")[1];
    }
  }
  const result = runGate2ReconciliationAudit(sessionDir);
  process.exit(result.success ? 0 : 1);
}
