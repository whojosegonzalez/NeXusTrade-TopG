/**
 * Phase 12.94-D Milestone D.2.9-B2: Event Discovery Session Evidence Capture & Manifest Sealing
 *
 * Implements immutable evidence sealing for event-driven discovery sessions.
 * Preserves raw WebSocket envelopes, raw getTransaction wire payloads, raw account responses,
 * decoded initialization events, and independent verification reports.
 *
 * Core Guarantees:
 * 1. File Isolation: Writes session-unique directory (e.g. b2-events-session-<timestamp>).
 * 2. Immutable JSONL Streams: Records notifications, transactions, accounts, events, and reports in append-only JSONL.
 * 3. Canonical SHA-256 Manifest: Computes manifestSha256 from sorted 'filename:sha256\n' lines matching B1 standard.
 * 4. Fail-Closed Sealing: Captures and flags interrupted, failed, or budget-exhausted sessions honestly.
 * 5. Strict Authentic Replay: Verifies byte sizes, file counts, and hashes with zero synthetic fallbacks.
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import type {
  DiscoveredPoolInitializationEvent,
  EventDiscoveryMetricsSnapshot,
  VerificationDispatchResult,
} from "./EventDiscoveryContracts.js";
import type { RawRpcInteractionRecord } from "./SolanaRpcLiveObservationClient.js";
import type { RawWebSocketNotificationRecord } from "./SolanaWebSocketSubscriptionClient.js";

export const EXPECTED_B2_EVIDENCE_FILES = [
  "discovered-events.jsonl",
  "raw-accounts.jsonl",
  "raw-notifications.jsonl",
  "raw-transactions.jsonl",
  "session-metadata.json",
  "verification-reports.jsonl",
] as const;

export type B2EvidenceFileName = (typeof EXPECTED_B2_EVIDENCE_FILES)[number];

export interface B2SnapshotManifestFileEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface B2SnapshotManifest {
  readonly manifestVersion: "1.0";
  readonly sessionId: string;
  readonly createdAtIso: string;
  readonly status: "FINALIZED" | "FAILED" | "INTERRUPTED";
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly B2SnapshotManifestFileEntry[];
  readonly manifestSha256: string;
}

export interface EventSessionCaptureInput {
  readonly sessionId?: string | undefined;
  readonly captureBaseDir: string;
  readonly wsUrl?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly endpointFingerprint?: string | undefined;
  readonly endpointHost?: string | undefined;
  readonly commitment?: string | undefined;
  readonly maxEventsBudget?: number | undefined;
  readonly maxTransactionsBudget?: number | undefined;
  readonly forcedStatus?: "FINALIZED" | "FAILED" | "INTERRUPTED" | undefined;
  readonly rawNotifications?: readonly RawWebSocketNotificationRecord[] | undefined;
  readonly rawTransactions?: readonly RawRpcInteractionRecord[] | undefined;
  readonly rawAccounts?: readonly RawRpcInteractionRecord[] | undefined;
  readonly discoveredEvents?: readonly DiscoveredPoolInitializationEvent[] | undefined;
  readonly verificationReports?: readonly VerificationDispatchResult[] | undefined;
  readonly metrics?: EventDiscoveryMetricsSnapshot | undefined;
  readonly error?: string | undefined;
}

export function saveB2EventSession(input: EventSessionCaptureInput): {
  readonly sessionDir: string;
  readonly manifestPath: string;
  readonly status: "FINALIZED" | "FAILED" | "INTERRUPTED";
  readonly manifest: B2SnapshotManifest;
} {
  const timestamp = Date.now();
  const sessionId = input.sessionId ?? `b2-events-session-${timestamp}`;
  const targetDir = path.join(input.captureBaseDir, sessionId);
  fsSync.mkdirSync(targetDir, { recursive: true });

  const status: "FINALIZED" | "FAILED" | "INTERRUPTED" =
    input.forcedStatus ??
    (input.error
      ? "FAILED"
      : (input.verificationReports?.length ?? 0) > 0
        ? "FINALIZED"
        : "FAILED");

  // Helper to write JSONL stream with BigInt serialization support
  const writeJsonl = (filename: B2EvidenceFileName, items: readonly unknown[]): string => {
    const filePath = path.join(targetDir, filename);
    const content =
      items
        .map((item) =>
          JSON.stringify(item, (_key, val) => (typeof val === "bigint" ? val.toString() : val)),
        )
        .join("\n") + (items.length > 0 ? "\n" : "");
    fsSync.writeFileSync(filePath, content, "utf8");
    return filePath;
  };

  // 1. raw-notifications.jsonl
  writeJsonl("raw-notifications.jsonl", input.rawNotifications ?? []);

  // 2. raw-transactions.jsonl
  writeJsonl("raw-transactions.jsonl", input.rawTransactions ?? []);

  // 3. raw-accounts.jsonl
  writeJsonl("raw-accounts.jsonl", input.rawAccounts ?? []);

  // 4. discovered-events.jsonl
  writeJsonl("discovered-events.jsonl", input.discoveredEvents ?? []);

  // 5. verification-reports.jsonl
  writeJsonl("verification-reports.jsonl", input.verificationReports ?? []);

  // 6. session-metadata.json
  const metadata = {
    sessionId,
    createdAtIso: new Date(timestamp).toISOString(),
    createdAtEpochMs: timestamp,
    status,
    wsUrl: input.wsUrl ?? "unknown",
    rpcUrl: input.rpcUrl ?? "unknown",
    endpointHost: input.endpointHost ?? "unknown",
    endpointFingerprint: input.endpointFingerprint ?? "unknown",
    commitment: input.commitment ?? "confirmed",
    maxEventsBudget: input.maxEventsBudget ?? 50,
    maxTransactionsBudget: input.maxTransactionsBudget ?? 25,
    totalNotificationsReceived: input.rawNotifications?.length ?? 0,
    totalTransactionsFetched: input.rawTransactions?.length ?? 0,
    totalEventsDiscovered: input.discoveredEvents?.length ?? 0,
    totalPoolsVerified: (input.verificationReports ?? []).filter((r) => r.verified).length,
    error: input.error ?? null,
    metrics: input.metrics ?? null,
  };
  const metadataFilePath = path.join(targetDir, "session-metadata.json");
  fsSync.writeFileSync(
    metadataFilePath,
    JSON.stringify(metadata, (_key, val) => (typeof val === "bigint" ? val.toString() : val), 2),
    "utf8",
  );

  // 7. Calculate file hashes and generate session-manifest.json
  const fileEntries: B2SnapshotManifestFileEntry[] = [];
  let totalBytes = 0;

  for (const filename of EXPECTED_B2_EVIDENCE_FILES) {
    const filePath = path.join(targetDir, filename);
    const content = fsSync.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    fileEntries.push({
      filename,
      sha256: hash,
      byteSize: content.length,
    });
    totalBytes += content.length;
  }

  // Sort deterministically by filename
  fileEntries.sort((a, b) => a.filename.localeCompare(b.filename));

  const manifestPayload = fileEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const manifestSha256 = crypto.createHash("sha256").update(manifestPayload).digest("hex");

  const manifest: B2SnapshotManifest = {
    manifestVersion: "1.0",
    sessionId,
    createdAtIso: new Date(timestamp).toISOString(),
    status,
    totalFiles: fileEntries.length,
    totalBytes,
    files: fileEntries,
    manifestSha256,
  };

  const manifestFilePath = path.join(targetDir, "session-manifest.json");
  fsSync.writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    sessionDir: targetDir,
    manifestPath: manifestFilePath,
    status,
    manifest,
  };
}

/**
 * Validates sealed B2 session manifest contract and file contents.
 */
export function verifyB2SessionManifest(sessionDir: string): {
  readonly valid: boolean;
  readonly manifest: B2SnapshotManifest;
} {
  const manifestPath = path.join(sessionDir, "session-manifest.json");
  if (!fsSync.existsSync(manifestPath)) {
    throw new Error(`[B2_MANIFEST_MISSING] Manifest not found in ${sessionDir}`);
  }

  const raw = fsSync.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as B2SnapshotManifest;

  if (manifest.files.length !== EXPECTED_B2_EVIDENCE_FILES.length) {
    throw new Error(
      `[B2_MANIFEST_COUNT_MISMATCH] Expected ${EXPECTED_B2_EVIDENCE_FILES.length} files, got ${manifest.files.length}`,
    );
  }

  const seen = new Set<string>();
  let computedBytes = 0;
  for (const entry of manifest.files) {
    if (seen.has(entry.filename)) {
      throw new Error(`[B2_MANIFEST_DUPLICATE_FILE] Duplicate entry: ${entry.filename}`);
    }
    seen.add(entry.filename);
    computedBytes += entry.byteSize;

    const filePath = path.join(sessionDir, entry.filename);
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`[B2_MANIFEST_FILE_MISSING] File missing on disk: ${entry.filename}`);
    }
    const diskBytes = fsSync.readFileSync(filePath);
    if (diskBytes.length !== entry.byteSize) {
      throw new Error(
        `[B2_MANIFEST_SIZE_MISMATCH] ${entry.filename}: expected ${entry.byteSize} bytes, got ${diskBytes.length}`,
      );
    }
    const diskHash = crypto.createHash("sha256").update(diskBytes).digest("hex");
    if (diskHash !== entry.sha256) {
      throw new Error(
        `[B2_MANIFEST_HASH_MISMATCH] ${entry.filename}: expected ${entry.sha256}, got ${diskHash}`,
      );
    }
  }

  for (const expected of EXPECTED_B2_EVIDENCE_FILES) {
    if (!seen.has(expected)) {
      throw new Error(`[B2_MANIFEST_REQUIRED_FILE_MISSING] Missing required file: ${expected}`);
    }
  }

  if (manifest.totalBytes !== computedBytes) {
    throw new Error(
      `[B2_MANIFEST_TOTAL_BYTES_MISMATCH] Declared ${manifest.totalBytes}, sum of entries is ${computedBytes}`,
    );
  }

  const sortedEntries = [...manifest.files].sort((a, b) => a.filename.localeCompare(b.filename));
  const canonicalPayload = sortedEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const canonicalHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
  if (canonicalHash !== manifest.manifestSha256) {
    throw new Error(
      `[B2_MANIFEST_SHA256_MISMATCH] Declared ${manifest.manifestSha256}, computed ${canonicalHash}`,
    );
  }

  return { valid: true, manifest };
}
