/**
 * Phase 12.94-D Milestone D.2.8: Gate 2 Reconciliation Audit Unit & Negative Tests
 *
 * Fully hermetic and CI-portable test suite for Gate 2 session data reconciliation (D28-F5).
 * Generates deterministic in-test session fixtures without depending on local workstation paths.
 *
 * Verifies:
 * 1. Cryptographic manifest verification (SHA-256 digests, file sizes, manifestDigestSha256, unmanifested files).
 * 2. Strict two-way 1:1 join between candidate-decisions.jsonl and discovery-diagnostics.jsonl.
 * 3. Identity and provenance matching (poolId, sessionId, generationId).
 * 4. Summary and funnel metric reconciliation.
 * 5. Deterministic negative tests for tampering, orphan records, ID mismatches, and metric discrepancies.
 * 6. Conditional validation of original workstation archive if present on disk.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  runGate2ReconciliationAudit,
  DEFAULT_GATE2_SESSION_DIR,
  computeSha256Hex,
} from "../../../../scripts/audit-gate2-reconciliation.mjs";

interface ClonedManifestEntry {
  filename: string;
  sizeBytes: number;
  sha256: string;
  lineCount?: number;
}

interface ClonedManifest {
  files: ClonedManifestEntry[];
  manifestDigestSha256: string;
  [key: string]: unknown;
}

interface ClonedDiagnosticRecord {
  decisionEventId: string;
  poolId: string;
  sessionId: string;
  generationId?: string;
  [key: string]: unknown;
}

interface ClonedDecisionRecord {
  eventId: string;
  poolId: string;
  sessionId: string;
  generationId?: string;
  [key: string]: unknown;
}

/**
 * Deterministically generates a hermetic, self-contained Gate 2 session fixture (D28-F5).
 * Mirrors the canonical Gate 2 distribution (51 candidates: 29 AMM v4, 22 CPMM; 8 fresh).
 */
export async function createHermeticGate2SessionFixture(targetDir: string): Promise<string> {
  await fs.mkdir(targetDir, { recursive: true });

  const sessionId = "pilot-sess-hermetic-1792394528063";
  const generationId = "gen1-pilot";
  const startedEpochMs = 1792394528070;
  const closedEpochMs = 1792395128585;

  const decisions: Record<string, unknown>[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const shadows: Record<string, unknown>[] = [];

  // Generate 51 candidates matching canonical Gate 2 distribution:
  // 29 AMM v4 (27 WSOL paired, 2 non-SOL; 0 fresh, 9 mature, 20 invalid age)
  // 22 CPMM (4 WSOL paired, 18 non-SOL; 8 fresh <= 24h, 14 mature, 0 invalid age)
  for (let i = 0; i < 51; i++) {
    const isInitialSnapshot = i < 50; // 50 initial snapshot, 1 later arrival
    const poolId = `PoolAddress${String(i + 1).padStart(3, "0")}1111111111111111111111111111`;
    const mintAddress = `MintAddress${String(i + 1).padStart(3, "0")}1111111111111111111111111111`;
    const eventId = `evt-ray-${poolId.slice(0, 8)}-${startedEpochMs + i}`;
    const symbol = `TKN${i + 1}`;

    let isAmmV4 = false;
    let isWsol = false;
    let poolAgeSec: number | null = null;
    let primaryRejectionReason = "INVALID_OPEN_TIME";

    if (i < 29) {
      // 29 AMM v4 pools
      isAmmV4 = true;
      if (i < 20) {
        // 20 invalid open time
        isWsol = true;
        poolAgeSec = null;
        primaryRejectionReason = "INVALID_OPEN_TIME";
      } else if (i < 27) {
        // 7 mature WSOL pools
        isWsol = true;
        poolAgeSec = 100000;
        primaryRejectionReason = "EXCEEDS_MAX_POOL_AGE";
      } else {
        // 2 mature non-SOL pools
        isWsol = false;
        poolAgeSec = 100000;
        primaryRejectionReason = "NON_SOL_PAIR";
      }
    } else {
      // 22 CPMM pools
      isAmmV4 = false;
      const cpmmIdx = i - 29;
      if (cpmmIdx < 8) {
        // 8 fresh non-SOL pools
        isWsol = false;
        poolAgeSec = 20000; // Fresh (< 86400s)
        primaryRejectionReason = "NON_SOL_PAIR";
      } else if (cpmmIdx < 18) {
        // 10 mature non-SOL pools
        isWsol = false;
        poolAgeSec = 100000;
        primaryRejectionReason = "NON_SOL_PAIR";
      } else {
        // 4 mature WSOL pools
        isWsol = true;
        poolAgeSec = 100000;
        primaryRejectionReason = "EXCEEDS_MAX_POOL_AGE";
      }
    }

    const progId = isAmmV4
      ? "Standard:675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
      : "Standard:CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

    decisions.push({
      eventId,
      sessionId,
      generationId,
      mintAddress,
      poolId,
      symbol,
      sourceTimestampMs: 0,
      ingestionTimestampMs: startedEpochMs + i,
      decisionTimestampMs: startedEpochMs + i + 15,
      firstSeenEpochMs: startedEpochMs + i,
      discoverySource: "raydium",
      discoveryEndpoint: "https://api-v3.raydium.io/pools/info/list",
      discoveryPage: 1,
      discoverySortField: "default",
      discoveryPollCycle: isInitialSnapshot ? 1 : 2,
      isInitialCatalogSnapshot: isInitialSnapshot,
      strategyRevision: "12.94-d2.3-pilot-v1",
      decisionCohort: "FILTERED_REJECTED",
      primaryRejectionReason,
      filterEvaluations: [
        {
          filterName: "WSOL_PAIR_ORIENTATION",
          passed: isWsol,
          valueObserved: isWsol ? "SOL_BASE_TOKEN_QUOTE" : "NON_SOL_PAIR",
          threshold: "TOKEN_BASE_SOL_QUOTE | SOL_BASE_TOKEN_QUOTE",
          rejectionReason: isWsol ? undefined : "Pool is not paired with canonical WSOL",
        },
        {
          filterName: "RAYDIUM_STANDARD_AMM",
          passed: isAmmV4,
          valueObserved: progId,
          threshold: "Standard AMM v4",
          rejectionReason: isAmmV4 ? undefined : "Not canonical AMM v4",
        },
        {
          filterName: "POOL_AGE_FRESHNESS",
          passed: poolAgeSec !== null && poolAgeSec <= 86400,
          valueObserved: poolAgeSec === null ? "INVALID" : `${poolAgeSec}s`,
          threshold: "<=86400s",
          rejectionReason:
            poolAgeSec === null
              ? "INVALID_OPEN_TIME"
              : poolAgeSec > 86400
                ? "EXCEEDS_MAX_POOL_AGE"
                : undefined,
        },
      ],
      metricsSnapshot: {
        tokenAgeSec: null,
        liquidityUsd: null,
        marketCapUsd: null,
        lmcRatio: null,
        lpBurnPct: null,
        spotPriceUsd: null,
        spotPriceSol: null,
        volume5mUsd: null,
        txCount5m: null,
        buys5m: null,
        sells5m: null,
        metricProvenance: {
          tokenAgeSec: "UNAVAILABLE",
          liquidityUsd: "UNAVAILABLE",
          marketCapUsd: "UNAVAILABLE",
          lmcRatio: "UNAVAILABLE",
          lpBurnPct: "UNAVAILABLE",
          spotPriceUsd: "UNAVAILABLE",
          spotPriceSol: "UNAVAILABLE",
          volume5mUsd: "UNAVAILABLE",
          txCount5m: "UNAVAILABLE",
          buys5m: "UNAVAILABLE",
          sells5m: "UNAVAILABLE",
        },
      },
      missingFields: ["sourceTimestampMs"],
      providerIdentity: "raydium_api_v3:STANDARD_POOLS",
    });

    diagnostics.push({
      decisionEventId: eventId,
      sessionId,
      generationId,
      mintAddress,
      poolId,
      symbol,
      discoverySource: "raydium",
      cohortLabel: "FILTERED_REJECTED",
      primaryRejectionReason,
      poolOpenTimeMs: poolAgeSec === null ? null : startedEpochMs - poolAgeSec * 1000,
      poolAgeAtDiscoverySec: poolAgeSec,
      firstSeenEpochMs: startedEpochMs + i,
      decisionEpochMs: startedEpochMs + i + 15,
      sourceTimestampMs: null,
      requestEndpoint: "https://api-v3.raydium.io/pools/info/list",
      requestPage: 1,
      requestSortField: "default",
      requestPageSize: 50,
      discoveryPollCycle: isInitialSnapshot ? 1 : 2,
      isInitialCatalogSnapshot: isInitialSnapshot,
    });

    shadows.push({
      decisionEventId: eventId,
      sessionId,
      generationId,
      mintAddress,
      poolId,
      evaluationTimestampMs: startedEpochMs + i + 20,
    });
  }

  const meta = {
    schemaVersion: "1.0.0",
    sessionId,
    generationId,
    sessionStatus: "FINALIZED",
    startedAtIso: new Date(startedEpochMs).toISOString(),
    closedAtIso: new Date(closedEpochMs).toISOString(),
    discoverySource: "raydium",
    maxPoolAgeSec: 86400,
  };

  const summary = {
    sessionId,
    generationId,
    strategyRevision: "12.94-d2.3-pilot-v1",
    startedAtIso: new Date(startedEpochMs).toISOString(),
    closedAtIso: new Date(closedEpochMs).toISOString(),
    totalCandidatesScreened: 51,
    totalDecisionsRecorded: 51,
    decisionWriteFailures: 0,
    cohortBreakdown: {
      filteredRejected: 51,
      watchlistRadar: 0,
      triggerRejected: 0,
      executedBuy: 0,
    },
    topRejectionReasons: {
      INVALID_OPEN_TIME: 20,
      NON_SOL_PAIR: 20,
      EXCEEDS_MAX_POOL_AGE: 11,
    },
    totalMarketObservationsRecorded: 0,
    totalStratifiedCandidatesTracked: 0,
    missedWinnersCount: 0,
    avoidedRugsCount: 0,
    isCompleteSession: true,
    isInterruptedSession: false,
    discoverySource: "raydium",
    maxPoolAgeSec: 86400,
    discoveryFunnel: {
      apiPoolsReturned: 1450,
      malformedRawEntries: 0,
      uniquePoolsEncountered: 51,
      repeatedPoolsSuppressed: 1399,
      initialSnapshotPoolsEncountered: 50,
      laterPollArrivalsEncountered: 1,
      preVerificationExclusions: {
        nonSolPairs: 20,
        nonStandardAmm: 22,
        missingOpenTime: 0,
        invalidOpenTime: 20,
        futureDatedOpenTime: 0,
        exceedsMaxPoolAge: 21,
        totalPreVerificationExcluded: 51,
      },
      poolAgeClassifications: {
        validAgeCount: 31,
        missingAgeCount: 0,
        invalidAgeCount: 20,
        futureDatedAgeCount: 0,
        confirmedAgeFilterPasses: 8,
        initialSnapshotFreshPasses: 8,
        laterPollFreshArrivals: 0,
        ageFilterExclusions: 43,
      },
      eligibleForVerification: 0,
      verificationAttempts: 0,
      verifiedAmmV4Pools: 0,
      confirmedOnChainIneligible: 0,
      rpcProviderUnavailable: 0,
      rpcRetriesExhausted: 0,
      unreachedCandidatesDueToStopping: 0,
    },
    status: "FINALIZED",
  };

  // Write files
  await fs.writeFile(
    path.join(targetDir, "candidate-decisions.jsonl"),
    decisions.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(targetDir, "discovery-diagnostics.jsonl"),
    diagnostics.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(targetDir, "shadow-evaluations.jsonl"),
    shadows.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(targetDir, "session-meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(targetDir, "session-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  // Compute manifest entries
  const manifestFiles: ClonedManifestEntry[] = [];
  const filenames = [
    "candidate-decisions.jsonl",
    "discovery-diagnostics.jsonl",
    "session-meta.json",
    "session-summary.json",
    "shadow-evaluations.jsonl",
  ];

  for (const filename of filenames) {
    const filePath = path.join(targetDir, filename);
    const content = await fs.readFile(filePath);
    const sizeBytes = content.byteLength;
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const entry: ClonedManifestEntry = {
      filename,
      sizeBytes,
      sha256,
      ...(filename.endsWith(".jsonl") ? { lineCount: 51 } : {}),
    };
    manifestFiles.push(entry);
  }
  manifestFiles.sort((a, b) => a.filename.localeCompare(b.filename));

  const manifest = {
    schemaVersion: "1.0.0",
    sessionId,
    generationId,
    exportTimestampUtc: new Date(closedEpochMs).toISOString(),
    exportEpochMs: closedEpochMs,
    files: manifestFiles,
    manifestDigestSha256: computeSha256Hex(JSON.stringify(manifestFiles)),
  };

  await fs.writeFile(
    path.join(targetDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  return targetDir;
}

describe("Milestone D.2.8: Gate 2 Reconciliation Audit & Invariant Suite (Hermetic & Portable)", () => {
  let tmpRoot: string;
  let canonicalHermeticSessionDir: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-gate2-audit-test-"));
    canonicalHermeticSessionDir = await createHermeticGate2SessionFixture(
      path.join(tmpRoot, "canonical-hermetic-session"),
    );
  });

  afterAll(async () => {
    if (tmpRoot && fsSync.existsSync(tmpRoot)) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * Helper to clone the hermetic session into an isolated directory for destructive tests.
   */
  async function cloneHermeticSession(destName: string): Promise<string> {
    const destDir = path.join(tmpRoot, destName);
    await fs.mkdir(destDir, { recursive: true });

    const entries = await fs.readdir(canonicalHermeticSessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const srcFile = path.join(canonicalHermeticSessionDir, entry.name);
        const dstFile = path.join(destDir, entry.name);
        await fs.copyFile(srcFile, dstFile);
      }
    }
    return destDir;
  }

  /**
   * Helper to re-sign and update manifest.json in a cloned directory.
   */
  async function recomputeAndWriteManifest(targetDir: string): Promise<void> {
    const manifestPath = path.join(targetDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ClonedManifest;

    const newFiles: ClonedManifestEntry[] = [];
    for (const f of manifest.files) {
      const filePath = path.join(targetDir, f.filename);
      if (fsSync.existsSync(filePath)) {
        const content = await fs.readFile(filePath);
        const sha256 = crypto.createHash("sha256").update(content).digest("hex");
        const sizeBytes = content.byteLength;
        const entry: ClonedManifestEntry = {
          filename: f.filename,
          sizeBytes,
          sha256,
        };
        if (f.lineCount !== undefined) {
          entry.lineCount = content
            .toString("utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0).length;
        }
        newFiles.push(entry);
      }
    }
    newFiles.sort((a, b) => a.filename.localeCompare(b.filename));

    manifest.files = newFiles;
    manifest.manifestDigestSha256 = computeSha256Hex(JSON.stringify(newFiles));
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  // --------------------------------------------------------------------------
  // 1. Hermetic Golden Run (CI Portable)
  // --------------------------------------------------------------------------
  describe("1. Canonical Hermetic Session Golden Run (D28-F5)", () => {
    it("successfully validates the hermetic Gate 2 session fixture without error on any platform", () => {
      const result = runGate2ReconciliationAudit(canonicalHermeticSessionDir, { silent: true });

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.details).not.toBeNull();
      if (!result.details) throw new Error("details should not be null");

      expect(result.details.decisionsCount).toBe(51);
      expect(result.details.diagnosticsCount).toBe(51);
      expect(result.details.manifestFileCount).toBe(5);

      // Verify cross-tabulation details
      const crossTab = result.details.crossTab as Record<
        string,
        {
          total: number;
          freshUnder24h: number;
          nonSolPair: number;
          invalidAge: number;
        }
      >;
      const cpmm = crossTab["Standard:CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"];
      expect(cpmm).toBeDefined();
      expect(cpmm?.total).toBe(22);
      expect(cpmm?.freshUnder24h).toBe(8);
      expect(cpmm?.nonSolPair).toBe(18);

      const ammV4 = crossTab["Standard:675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"];
      expect(ammV4).toBeDefined();
      expect(ammV4?.total).toBe(29);
      expect(ammV4?.freshUnder24h).toBe(0);
      expect(ammV4?.invalidAge).toBe(20);
    });

    it.skipIf(!fsSync.existsSync(DEFAULT_GATE2_SESSION_DIR))(
      "successfully validates local workstation Gate 2 session archive if present on disk",
      () => {
        const result = runGate2ReconciliationAudit(DEFAULT_GATE2_SESSION_DIR, { silent: true });
        expect(result.success).toBe(true);
        expect(result.errors).toHaveLength(0);
      },
    );
  });

  // --------------------------------------------------------------------------
  // 2. Cryptographic Manifest Integrity Negative Tests
  // --------------------------------------------------------------------------
  describe("2. Cryptographic Manifest Negative Tests", () => {
    it("fails when a file content is tampered with (SHA-256 and size mismatch)", async () => {
      const testDir = await cloneHermeticSession("tampered-file");
      const targetFile = path.join(testDir, "candidate-decisions.jsonl");

      // Append extra data to invalidate hash and size
      await fs.appendFile(targetFile, "\n");

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("SHA256 mismatch"))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("File size mismatch"))).toBe(true);
    });

    it("fails when internal manifestDigestSha256 is tampered with", async () => {
      const testDir = await cloneHermeticSession("tampered-digest");
      const manifestPath = path.join(testDir, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ClonedManifest;

      manifest.manifestDigestSha256 = "0".repeat(64);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("manifestDigestSha256 mismatch"))).toBe(
        true,
      );
    });

    it("fails when an extraneous unindexed file exists in the session directory", async () => {
      const testDir = await cloneHermeticSession("extra-file");
      const extraFile = path.join(testDir, "unauthorized-dump.bin");
      await fs.writeFile(extraFile, Buffer.from("rogue data"));

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) =>
          e.includes("Extraneous unindexed file found in session directory"),
        ),
      ).toBe(true);
    });

    it("fails when a declared file is missing on disk", async () => {
      const testDir = await cloneHermeticSession("missing-file");
      const targetFile = path.join(testDir, "shadow-evaluations.jsonl");
      await fs.unlink(targetFile);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("Manifest file missing on disk"))).toBe(
        true,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Two-Way 1:1 Join & Identity Negative Tests
  // --------------------------------------------------------------------------
  describe("3. Two-Way 1:1 Join & Identity Negative Tests", () => {
    it("fails when there is an orphan candidate decision (missing diagnostic)", async () => {
      const testDir = await cloneHermeticSession("orphan-decision");
      const diagFile = path.join(testDir, "discovery-diagnostics.jsonl");

      // Remove the first diagnostic line
      const lines = (await fs.readFile(diagFile, "utf8")).trim().split("\n");
      const removedDiag = JSON.parse(lines[0]!) as ClonedDiagnosticRecord;
      await fs.writeFile(diagFile, lines.slice(1).join("\n") + "\n", "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) =>
          e.includes(`Orphan decision: eventId ${removedDiag.decisionEventId}`),
        ),
      ).toBe(true);
    });

    it("fails when there is an orphan discovery diagnostic (missing decision)", async () => {
      const testDir = await cloneHermeticSession("orphan-diagnostic");
      const decFile = path.join(testDir, "candidate-decisions.jsonl");

      // Remove the first decision line
      const lines = (await fs.readFile(decFile, "utf8")).trim().split("\n");
      const removedDec = JSON.parse(lines[0]!) as ClonedDecisionRecord;
      await fs.writeFile(decFile, lines.slice(1).join("\n") + "\n", "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) =>
          e.includes(`Orphan diagnostic: decisionEventId ${removedDec.eventId}`),
        ),
      ).toBe(true);
    });

    it("fails when a duplicate eventId exists in candidate-decisions", async () => {
      const testDir = await cloneHermeticSession("duplicate-decision-id");
      const decFile = path.join(testDir, "candidate-decisions.jsonl");

      const lines = (await fs.readFile(decFile, "utf8")).trim().split("\n");
      lines.push(lines[0]!);
      await fs.writeFile(decFile, lines.join("\n") + "\n", "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) =>
          e.includes("Duplicate eventId in candidate-decisions.jsonl"),
        ),
      ).toBe(true);
    });

    it("fails when poolId differs between joined decision and diagnostic", async () => {
      const testDir = await cloneHermeticSession("poolid-mismatch");
      const diagFile = path.join(testDir, "discovery-diagnostics.jsonl");

      const lines = (await fs.readFile(diagFile, "utf8")).trim().split("\n");
      const firstDiag = JSON.parse(lines[0]!) as ClonedDiagnosticRecord;
      firstDiag.poolId = "MutatedPoolId11111111111111111111111111111111";
      lines[0] = JSON.stringify(firstDiag);
      await fs.writeFile(diagFile, lines.join("\n") + "\n", "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("PoolId mismatch for eventId"))).toBe(
        true,
      );
    });

    it("fails when sessionId differs between joined decision and diagnostic", async () => {
      const testDir = await cloneHermeticSession("sessionid-mismatch");
      const diagFile = path.join(testDir, "discovery-diagnostics.jsonl");

      const lines = (await fs.readFile(diagFile, "utf8")).trim().split("\n");
      const firstDiag = JSON.parse(lines[0]!) as ClonedDiagnosticRecord;
      firstDiag.sessionId = "pilot-sess-tampered-9999999999999";
      lines[0] = JSON.stringify(firstDiag);
      await fs.writeFile(diagFile, lines.join("\n") + "\n", "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("SessionId mismatch for eventId"))).toBe(
        true,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. Derived Metric & Funnel Reconciliation Negative Tests
  // --------------------------------------------------------------------------
  describe("4. Derived Metric & Funnel Reconciliation Negative Tests", () => {
    it("fails when summary totalDecisionsRecorded does not match decision records count", async () => {
      const testDir = await cloneHermeticSession("summary-count-mismatch");
      const summaryFile = path.join(testDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as {
        totalDecisionsRecorded: number;
        [key: string]: unknown;
      };

      summary.totalDecisionsRecorded = 999;
      await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) =>
          e.includes("summary.totalDecisionsRecorded (999) does not match"),
        ),
      ).toBe(true);
    });

    it("fails when funnel uniquePoolsEncountered does not match actual unique pool IDs", async () => {
      const testDir = await cloneHermeticSession("funnel-pool-mismatch");
      const summaryFile = path.join(testDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as {
        discoveryFunnel: { uniquePoolsEncountered: number; [key: string]: unknown };
        [key: string]: unknown;
      };

      summary.discoveryFunnel.uniquePoolsEncountered = 40;
      await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) => e.includes("Funnel uniquePoolsEncountered mismatch")),
      ).toBe(true);
    });

    it("fails when discovery funnel Invariant 1 is violated", async () => {
      const testDir = await cloneHermeticSession("funnel-inv1-violated");
      const summaryFile = path.join(testDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as {
        discoveryFunnel: { apiPoolsReturned: number; [key: string]: unknown };
        [key: string]: unknown;
      };

      summary.discoveryFunnel.apiPoolsReturned = 99999;
      await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");

      await recomputeAndWriteManifest(testDir);

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("Funnel Invariant 1 violated"))).toBe(
        true,
      );
    });

    it("fails gracefully when session directory does not exist", () => {
      const nonExistentDir = path.join(tmpRoot, "non-existent-directory-404");
      const result = runGate2ReconciliationAudit(nonExistentDir, { silent: true });
      expect(result.success).toBe(false);
      expect(
        result.errors.some((e: string) => e.includes("Session directory does not exist")),
      ).toBe(true);
    });
  });
});
