/**
 * Phase 12.94-D Milestone D.2.8: Gate 2 Reconciliation Audit Unit & Negative Tests
 *
 * Verifies the canonical Gate 2 session archive against:
 * 1. Cryptographic manifest verification (SHA-256 digests, file sizes, manifestDigestSha256).
 * 2. Strict two-way 1:1 join between candidate-decisions.jsonl and discovery-diagnostics.jsonl.
 * 3. Identity and provenance matching (poolId, sessionId, generationId).
 * 4. Summary and funnel metric reconciliation.
 * 5. Deterministic negative tests for tampering, orphan records, ID mismatches, and metric discrepancies.
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
  [key: string]: unknown;
}

interface ClonedDecisionRecord {
  eventId: string;
  poolId: string;
  sessionId: string;
  [key: string]: unknown;
}

describe("Milestone D.2.8: Gate 2 Reconciliation Audit & Invariant Suite", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-gate2-audit-test-"));
  });

  afterAll(async () => {
    if (tmpRoot && fsSync.existsSync(tmpRoot)) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * Helper to create an isolated copy of the canonical Gate 2 session.
   */
  async function cloneCanonicalSession(destName: string): Promise<string> {
    const destDir = path.join(tmpRoot, destName);
    await fs.mkdir(destDir, { recursive: true });

    const entries = await fs.readdir(DEFAULT_GATE2_SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const srcFile = path.join(DEFAULT_GATE2_SESSION_DIR, entry.name);
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
  // 1. Positive Golden Run
  // --------------------------------------------------------------------------
  describe("1. Canonical Gate 2 Session Golden Run", () => {
    it("successfully validates the canonical Gate 2 session archive without error", () => {
      expect(fsSync.existsSync(DEFAULT_GATE2_SESSION_DIR)).toBe(true);

      const result = runGate2ReconciliationAudit(DEFAULT_GATE2_SESSION_DIR, { silent: true });

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
  });

  // --------------------------------------------------------------------------
  // 2. Cryptographic Manifest Integrity Negative Tests
  // --------------------------------------------------------------------------
  describe("2. Cryptographic Manifest Negative Tests", () => {
    it("fails when a file content is tampered with (SHA-256 and size mismatch)", async () => {
      const testDir = await cloneCanonicalSession("tampered-file");
      const targetFile = path.join(testDir, "candidate-decisions.jsonl");

      // Append extra data to invalidate hash and size
      await fs.appendFile(targetFile, "\n");

      const result = runGate2ReconciliationAudit(testDir, { silent: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes("SHA256 mismatch"))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("File size mismatch"))).toBe(true);
    });

    it("fails when internal manifestDigestSha256 is tampered with", async () => {
      const testDir = await cloneCanonicalSession("tampered-digest");
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
      const testDir = await cloneCanonicalSession("extra-file");
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
      const testDir = await cloneCanonicalSession("missing-file");
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
      const testDir = await cloneCanonicalSession("orphan-decision");
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
      const testDir = await cloneCanonicalSession("orphan-diagnostic");
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
      const testDir = await cloneCanonicalSession("duplicate-decision-id");
      const decFile = path.join(testDir, "candidate-decisions.jsonl");

      const lines = (await fs.readFile(decFile, "utf8")).trim().split("\n");
      // Duplicate the first line
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
      const testDir = await cloneCanonicalSession("poolid-mismatch");
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
      const testDir = await cloneCanonicalSession("sessionid-mismatch");
      const diagFile = path.join(testDir, "discovery-diagnostics.jsonl");

      const lines = (await fs.readFile(diagFile, "utf8")).trim().split("\n");
      const firstDiag = JSON.parse(lines[0]!) as ClonedDiagnosticRecord;
      firstDiag.sessionId = "pilot-sess-tampered-9999999999999";
      lines[0] = JSON.stringify(firstDiag);
      await fs.writeFile(diagFile, lines.join("\n") + "\n", "utf8");
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
      const testDir = await cloneCanonicalSession("summary-count-mismatch");
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
      const testDir = await cloneCanonicalSession("funnel-pool-mismatch");
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
      const testDir = await cloneCanonicalSession("funnel-inv1-violated");
      const summaryFile = path.join(testDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as {
        discoveryFunnel: { apiPoolsReturned: number; [key: string]: unknown };
        [key: string]: unknown;
      };

      // Invariant 1: unique + repeated + malformed === apiPoolsReturned
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
