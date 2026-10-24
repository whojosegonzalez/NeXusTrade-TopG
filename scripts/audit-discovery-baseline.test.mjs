/**
 * Phase 12.94-D.2.9-C1: Automated Regression Tests for Discovery Baseline & Ground Truth Auditor
 *
 * Verifies:
 * 1. Provenance check: Validates B2-1 and B2-2 manifests before processing raw evidence.
 * 2. Fail-closed behavior on missing or tampered archived evidence.
 * 3. Separate reporting of notification priority trigger frequency (0 / 574) without
 *    treating uninspected notifications as confirmed negatives.
 * 4. Manually labeled negative reference set (6 transactions) with signature-keyed ground-truth matching.
 * 5. Reconciled historical accounting for Diagnostic 1 (7 mutually exclusive categories) and Diagnostic 2.
 * 6. Synthetic parser suite verification (11 / 11 passed) kept strictly distinct from live recall.
 * 7. Correct calculation of dynamic metrics without hardcoded strings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runDiscoveryBaselineAudit,
  INDEPENDENT_GROUND_TRUTH_NEGATIVE_REGISTRY,
} from "./audit-discovery-baseline.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(rootDir, "scripts", "audit-discovery-baseline.mjs");

test("D.2.9-C1: Baseline audit verifies provenance and returns exact reconciled metrics", async () => {
  const result = await runDiscoveryBaselineAudit();

  assert.ok(result, "Audit result must be returned");

  // Provenance verification
  assert.strictEqual(result.provenance.b1Verified, true, "B2-1 manifest must be verified");
  assert.strictEqual(result.provenance.b2Verified, true, "B2-2 manifest must be verified");

  // Notification observation metrics (not confirmed negatives)
  assert.strictEqual(
    result.notifications.total,
    574,
    "Must audit exactly 574 authentic notifications",
  );
  assert.strictEqual(
    result.notifications.prioritized,
    0,
    "Observed priority trigger count must be exactly 0",
  );
  assert.strictEqual(
    result.notifications.priorityTriggerPct,
    "0.00",
    "Priority trigger rate must be 0.00%",
  );
  assert.strictEqual(
    result.notifications.deprioritized,
    190,
    "Deprioritized routine swaps must be 190",
  );
  assert.strictEqual(
    result.notifications.ambiguous,
    384,
    "Ambiguous fallback notifications must be 384",
  );

  // Confirmed negative transactions (signature-keyed reference set)
  assert.strictEqual(
    result.transactions.totalLabeledNegatives,
    6,
    "Must evaluate exactly 6 confirmed negative transactions",
  );
  assert.strictEqual(
    result.transactions.trueNegatives,
    6,
    "Parser must identify all 6 labeled negatives as non-inits",
  );
  assert.strictEqual(
    result.transactions.falsePositives,
    0,
    "Parser must have 0 false positives on labeled negatives",
  );
  assert.strictEqual(
    result.transactions.specificityPct,
    "100.00",
    "Specificity on confirmed negatives must be 100.00%",
  );
  assert.strictEqual(
    result.transactions.fprPct,
    "0.00",
    "False positive rate on confirmed negatives must be 0.00%",
  );
  assert.strictEqual(
    result.transactions.positiveRecall,
    "UNDEFINED",
    "Positive recall must be explicitly UNDEFINED",
  );

  // Diagnostic 1 Historical Accounting (7 mutually exclusive categories)
  const b1 = result.historicalAccounting.b1;
  assert.strictEqual(b1.uniqueSignatures, 74, "B2-1 unique signatures must be 74");
  assert.strictEqual(b1.failedOnChain, 22, "B2-1 failed on-chain must be 22");
  assert.strictEqual(b1.uniqueValidSignatures, 52, "B2-1 valid unique signatures must be 52");
  assert.strictEqual(b1.rpcAttempts, 25, "B2-1 total RPC attempts must be 25");
  assert.strictEqual(b1.successfulFetches, 1, "B2-1 successful fetches must be 1");
  assert.strictEqual(b1.erroredAttempts, 24, "B2-1 errored attempts must be 24");
  assert.strictEqual(b1.versionErrors, 9, "B2-1 version errors must be 9");
  assert.strictEqual(b1.rateLimitErrors, 15, "B2-1 rate limit errors must be 15");
  assert.strictEqual(b1.neverRequestedValid, 27, "B2-1 never requested valid must be 27");
  assert.strictEqual(b1.notInspectedValid, 51, "B2-1 not successfully inspected valid must be 51");
  assert.strictEqual(b1.durationSec, 2.711, "B2-1 duration must be 2.711s");

  // Mutually exclusive reconciliation invariant for B2-1:
  assert.strictEqual(
    b1.successfulFetches + b1.erroredAttempts + b1.neverRequestedValid,
    b1.uniqueValidSignatures,
    "B2-1 valid signature partitions must sum to total valid signatures",
  );
  assert.strictEqual(
    b1.uniqueValidSignatures + b1.failedOnChain,
    b1.uniqueSignatures,
    "B2-1 valid + failed must sum to total unique signatures",
  );

  // Diagnostic 2 Historical Accounting
  const b2 = result.historicalAccounting.b2;
  assert.strictEqual(b2.totalNotifications, 500, "B2-2 notifications must be 500");
  assert.strictEqual(b2.uniqueSignatures, 498, "B2-2 unique signatures must be 498");
  assert.strictEqual(b2.duplicates, 2, "B2-2 duplicate notifications must be 2");
  assert.strictEqual(b2.failedOnChain, 116, "B2-2 failed on-chain must be 116");
  assert.strictEqual(b2.uniqueValidSignatures, 382, "B2-2 valid unique signatures must be 382");
  assert.strictEqual(b2.successfulFetches, 5, "B2-2 successful fetches must be 5");
  assert.strictEqual(b2.unfetchedValid, 377, "B2-2 unfetched valid must be 377");
  assert.strictEqual(b2.durationSec, 37.453, "B2-2 actual elapsed duration must be 37.453s");

  // Invariant for B2-2:
  assert.strictEqual(
    b2.successfulFetches + b2.unfetchedValid,
    b2.uniqueValidSignatures,
    "B2-2 fetched + unfetched must sum to valid unique signatures",
  );

  // Synthetic suite
  assert.strictEqual(result.synthetic.passed, 11, "Must pass all 11 synthetic regression fixtures");
  assert.strictEqual(
    result.synthetic.total,
    11,
    "Must execute all 11 synthetic regression fixtures",
  );
  assert.strictEqual(result.synthetic.passPct, "100.00", "Synthetic pass rate must be 100.00%");
});

test("D.2.9-C1: Signature-keyed annotation registry contains all 6 fetched transactions with independent evidence", () => {
  const keys = Object.keys(INDEPENDENT_GROUND_TRUTH_NEGATIVE_REGISTRY);
  assert.strictEqual(keys.length, 6, "Registry must contain exactly 6 signatures");

  for (const sig of keys) {
    const entry = INDEPENDENT_GROUND_TRUTH_NEGATIVE_REGISTRY[sig];
    assert.ok(entry.signature, "Must have signature");
    assert.ok(entry.session, "Must have session");
    assert.ok(entry.independentLabel, "Must have independent label");
    assert.ok(entry.independentRole, "Must have independent role description");
    assert.ok(entry.invokedProgramId, "Must have invoked program ID");
    assert.ok(entry.supportingEvidence, "Must have supporting evidence trace");
    assert.ok(
      entry.independentLabel === "AUTHENTIC_NEGATIVE_SWAP" ||
        entry.independentLabel === "AUTHENTIC_NEGATIVE_BUY",
      "Label must be authentic negative swap or buy",
    );
  }
});

test("D.2.9-C1: Missing archived evidence fails closed without silent substitution", async () => {
  const nonexistentDir = path.join(rootDir, ".tmp", "nonexistent-session-dir-12345");

  await assert.rejects(
    async () => {
      await runDiscoveryBaselineAudit({ b1Dir: nonexistentDir });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("[AUDIT_FAIL] Missing B2-1 capture directory"));
      return true;
    },
    "Must throw explicit audit error when capture directory is missing",
  );
});

test("D.2.9-C1: Tampered session manifest fails closed", async () => {
  // Create a temporary mock directory with a tampered manifest
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tampered-b2-session-"));
  try {
    const mockManifest = {
      manifestVersion: "1.0",
      sessionId: "mock-tampered",
      status: "FINALIZED",
      totalFiles: 1,
      totalBytes: 10,
      files: [{ filename: "test.json", sha256: "0000000000000000", byteSize: 10 }],
      manifestSha256: "ffffffffffffffff",
    };
    fs.writeFileSync(path.join(tempDir, "session-manifest.json"), JSON.stringify(mockManifest));
    fs.writeFileSync(path.join(tempDir, "test.json"), "tampered12");

    await assert.rejects(
      async () => {
        await runDiscoveryBaselineAudit({ b1Dir: tempDir });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("[AUDIT_FAIL] Manifest verification FAILED"));
        return true;
      },
      "Must throw explicit audit failure when manifest validation fails",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("D.2.9-C1: CLI execution completes with code 0 and logs required methodology sections", () => {
  const proc = spawnSync(process.execPath, [scriptPath], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.strictEqual(proc.status, 0, `CLI process must exit 0. stderr: ${proc.stderr}`);
  assert.ok(
    proc.stdout.includes(
      "NeXusTrade — Phase 12.94-D.2.9-C1 Discovery Baseline & Ground Truth Audit",
    ),
    "Header must be present",
  );
  assert.ok(
    proc.stdout.includes("B2-1 and B2-2 session manifests verified successfully"),
    "Manifest verification must pass",
  );
  assert.ok(
    proc.stdout.includes("Observed Priority Trigger Frequency: 0 / 574 (0.00%)"),
    "Must report priority trigger rate separately",
  );
  assert.ok(
    proc.stdout.includes(
      "Uninspected notifications are classified as authentic observations of unknown",
    ),
    "Must note uninspected status",
  );
  assert.ok(
    proc.stdout.includes(
      "Evaluating Manually Labeled Negative Reference Set (6 confirmed negatives)",
    ),
    "Must audit 6 labeled negatives",
  );
  assert.ok(
    proc.stdout.includes("Specificity on Confirmed Negative Transactions: 100.00%"),
    "Must report specificity on confirmed negatives",
  );
  assert.ok(
    proc.stdout.includes(
      "Real-world Empirical Recall (True Positive Rate) = UNMEASURABLE / UNDEFINED ($0/0$)",
    ),
    "Must state recall is undefined",
  );
  assert.ok(
    proc.stdout.includes(
      "Audit Complete. All evidence verified strictly offline with provenance check.",
    ),
    "Completion message must be present",
  );
});
