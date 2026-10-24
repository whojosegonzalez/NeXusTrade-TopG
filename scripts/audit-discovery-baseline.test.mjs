/**
 * Phase 12.94-D.2.9-C1: Automated Regression Test for Discovery Baseline & Ground Truth Auditor
 *
 * Verifies that the discovery baseline auditor:
 * 1. Evaluates all authentic Class 1 notifications (574 total) with 0 false prioritizations.
 * 2. Evaluates all authentic Class 1 transactions (6 total) with 0 false positive pool detections.
 * 3. Evaluates all synthetic Class 3 fixtures (11 total) with 100% pass rate.
 * 4. Correctly reconciles Class 2 uninspected signatures and failed on-chain transactions.
 * 5. Runs offline without network calls and exits cleanly with code 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runDiscoveryBaselineAudit } from "./audit-discovery-baseline.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(rootDir, "scripts", "audit-discovery-baseline.mjs");

test("D.2.9-C1: Discovery baseline audit runs and returns exact metrics", () => {
  const result = runDiscoveryBaselineAudit();

  assert.ok(result, "Audit result must be defined");

  // Class 1 checks
  assert.strictEqual(
    result.class1.totalNotifications,
    574,
    "Must audit exactly 574 notifications (74 B2-1 + 500 B2-2)",
  );
  assert.strictEqual(
    result.class1.prioritized,
    0,
    "Must have exactly 0 prioritized notifications across negatives",
  );
  assert.strictEqual(
    result.class1.fetchedTxs,
    6,
    "Must audit exactly 6 authentic fetched transactions (1 B2-1 + 5 B2-2)",
  );
  assert.strictEqual(
    result.class1.falsePositives,
    0,
    "Must have exactly 0 false positive pool initializations",
  );
  assert.strictEqual(
    result.class1.trueNegatives,
    6,
    "Must identify all 6 authentic non-init transactions as negatives",
  );

  // Class 2 checks
  assert.strictEqual(
    result.class2.b2Unfetched,
    377,
    "Must reconcile 377 uninspected valid signatures in B2-2",
  );
  assert.strictEqual(
    result.class2.b2FailedOnChain,
    116,
    "Must identify 116 on-chain failed transactions in B2-2",
  );
  assert.strictEqual(
    result.class2.b1FailedOnChain,
    22,
    "Must identify 22 on-chain failed transactions in B2-1",
  );

  // Class 3 checks
  assert.strictEqual(
    result.class3.syntheticPassed,
    11,
    "Must pass all 11 synthetic regression fixtures",
  );
  assert.strictEqual(
    result.class3.syntheticTotal,
    11,
    "Must execute all 11 synthetic regression fixtures",
  );
});

test("D.2.9-C1: CLI execution completes with code 0 and logs required headings", () => {
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
    proc.stdout.includes("Authentic Positive Initializations in Local Archives: 0"),
    "Must state 0 authentic positives locally",
  );
  assert.ok(
    proc.stdout.includes("Specificity on Authentic Negatives: 100.00%"),
    "Must report 100% specificity",
  );
  assert.ok(
    proc.stdout.includes("Real-world Empirical Recall (True Positive Rate) = UNMEASURABLE"),
    "Must state recall is unmeasurable",
  );
  assert.ok(
    proc.stdout.includes("Audit Complete. All evidence verified strictly offline."),
    "Completion message must be present",
  );
});
