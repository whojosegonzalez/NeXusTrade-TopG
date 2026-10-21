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
  readonly maxDiskMb?: number | undefined; // Disk budget limit in megabytes (B2-READY-02)
  readonly forcedStatus?: "FINALIZED" | "FAILED" | "INTERRUPTED" | undefined;
  readonly rawNotifications?: readonly RawWebSocketNotificationRecord[] | undefined;
  readonly rawTransactions?: readonly RawRpcInteractionRecord[] | undefined;
  readonly rawAccounts?: readonly RawRpcInteractionRecord[] | undefined;
  readonly discoveredEvents?: readonly DiscoveredPoolInitializationEvent[] | undefined;
  readonly verificationReports?: readonly VerificationDispatchResult[] | undefined;
  readonly metrics?: EventDiscoveryMetricsSnapshot | undefined;
  readonly error?: string | undefined;
}

/**
 * Incremental progressive evidence recorder (B2-READY-05 / B2-READY-02).
 * Progressively persists JSONL frames to disk as they arrive, enforcing disk budget ceilings,
 * ensuring crash-resilient evidence preservation even if interrupted.
 */
export class ProgressiveEvidenceRecorder {
  private readonly targetDir: string;
  private readonly sessionId: string;
  private readonly maxDiskBytes: number;
  private readonly reservedHeadroomBytes: number;
  private readonly streamBudgetBytes: number;
  private totalBytesWritten = 0;
  private isFinalized = false;
  private readonly counts = {
    notifications: 0,
    transactions: 0,
    accounts: 0,
    events: 0,
    reports: 0,
  };

  constructor(options: {
    readonly captureBaseDir: string;
    readonly sessionId?: string | undefined;
    readonly maxDiskMb?: number | undefined;
  }) {
    const timestamp = Date.now();
    this.sessionId = options.sessionId ?? `b2-events-session-${timestamp}`;
    this.targetDir = path.join(options.captureBaseDir, this.sessionId);
    this.maxDiskBytes = (options.maxDiskMb ?? 256) * 1024 * 1024;
    // B2-FINAL-04: Reserve headroom (1MB or at least 4KB if small) specifically for session-metadata.json and session-manifest.json
    this.reservedHeadroomBytes = Math.min(
      1024 * 1024,
      Math.max(4096, Math.floor(this.maxDiskBytes * 0.2)),
    );
    this.streamBudgetBytes = Math.max(512, this.maxDiskBytes - this.reservedHeadroomBytes);
    fsSync.mkdirSync(this.targetDir, { recursive: true });

    // Ensure all 5 JSONL streams exist
    for (const f of EXPECTED_B2_EVIDENCE_FILES) {
      if (f.endsWith(".jsonl")) {
        const fp = path.join(this.targetDir, f);
        if (!fsSync.existsSync(fp)) {
          fsSync.writeFileSync(fp, "", "utf8");
        }
      }
    }
  }

  public getSessionDir(): string {
    return this.targetDir;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  private appendJsonl(filename: B2EvidenceFileName, item: unknown): void {
    if (this.isFinalized) return;
    const line =
      JSON.stringify(item, (_k, val) => (typeof val === "bigint" ? val.toString() : val)) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.totalBytesWritten + lineBytes > this.streamBudgetBytes) {
      throw new Error(
        `[DISK_BUDGET_EXCEEDED] Cannot append to ${filename}: reached streaming disk ceiling (${this.totalBytesWritten + lineBytes} bytes > ${this.streamBudgetBytes} bytes). Headroom reserved for manifest sealing.`,
      );
    }
    const fp = path.join(this.targetDir, filename);
    fsSync.appendFileSync(fp, line, "utf8");
    this.totalBytesWritten += lineBytes;
  }

  public recordNotification(record: RawWebSocketNotificationRecord): void {
    this.appendJsonl("raw-notifications.jsonl", record);
    this.counts.notifications++;
  }

  public recordTransaction(record: RawRpcInteractionRecord): void {
    this.appendJsonl("raw-transactions.jsonl", record);
    this.counts.transactions++;
  }

  public recordAccount(record: RawRpcInteractionRecord): void {
    this.appendJsonl("raw-accounts.jsonl", record);
    this.counts.accounts++;
  }

  public recordEvent(event: DiscoveredPoolInitializationEvent): void {
    this.appendJsonl("discovered-events.jsonl", event);
    this.counts.events++;
  }

  public recordReport(report: VerificationDispatchResult): void {
    this.appendJsonl("verification-reports.jsonl", report);
    this.counts.reports++;
  }

  public finalize(metadataInput: {
    readonly status: "FINALIZED" | "FAILED" | "INTERRUPTED";
    readonly wsUrl?: string | undefined;
    readonly rpcUrl?: string | undefined;
    readonly endpointHost?: string | undefined;
    readonly endpointFingerprint?: string | undefined;
    readonly commitment?: string | undefined;
    readonly maxEventsBudget?: number | undefined;
    readonly maxTransactionsBudget?: number | undefined;
    readonly totalPoolsVerified?: number | undefined;
    readonly error?: string | null | undefined;
    readonly metrics?: EventDiscoveryMetricsSnapshot | null | undefined;
  }): {
    readonly sessionDir: string;
    readonly manifestPath: string;
    readonly status: "FINALIZED" | "FAILED" | "INTERRUPTED";
    readonly manifest: B2SnapshotManifest;
  } {
    this.isFinalized = true;
    const timestamp = Date.now();
    const metadata = {
      sessionId: this.sessionId,
      createdAtIso: new Date(timestamp).toISOString(),
      createdAtEpochMs: timestamp,
      status: metadataInput.status,
      wsUrl: metadataInput.wsUrl ?? "unknown",
      rpcUrl: metadataInput.rpcUrl ?? "unknown",
      endpointHost: metadataInput.endpointHost ?? "unknown",
      endpointFingerprint: metadataInput.endpointFingerprint ?? "unknown",
      commitment: metadataInput.commitment ?? "confirmed",
      maxEventsBudget: metadataInput.maxEventsBudget ?? 50,
      maxTransactionsBudget: metadataInput.maxTransactionsBudget ?? 25,
      totalNotificationsReceived: this.counts.notifications,
      totalTransactionsFetched: this.counts.transactions,
      totalEventsDiscovered: this.counts.events,
      totalPoolsVerified: metadataInput.totalPoolsVerified ?? this.counts.reports,
      error: metadataInput.error ?? null,
      metrics: metadataInput.metrics ?? null,
    };

    const metadataContent = JSON.stringify(
      metadata,
      (_k, val) => (typeof val === "bigint" ? val.toString() : val),
      2,
    );
    const metaBytes = Buffer.byteLength(metadataContent, "utf8");
    if (this.totalBytesWritten + metaBytes > this.maxDiskBytes) {
      throw new Error(
        `[DISK_BUDGET_EXCEEDED] Cannot write session-metadata.json: exceeded disk budget of ${this.maxDiskBytes} bytes`,
      );
    }
    const metaPath = path.join(this.targetDir, "session-metadata.json");
    fsSync.writeFileSync(metaPath, metadataContent, "utf8");
    this.totalBytesWritten += metaBytes;

    // Generate manifest
    const fileEntries: B2SnapshotManifestFileEntry[] = [];
    let totalBytes = 0;
    for (const filename of EXPECTED_B2_EVIDENCE_FILES) {
      const filePath = path.join(this.targetDir, filename);
      const content = fsSync.readFileSync(filePath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      fileEntries.push({
        filename,
        sha256: hash,
        byteSize: content.length,
      });
      totalBytes += content.length;
    }
    fileEntries.sort((a, b) => a.filename.localeCompare(b.filename));

    const manifestPayload = fileEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
    const manifestSha256 = crypto.createHash("sha256").update(manifestPayload).digest("hex");

    const manifest: B2SnapshotManifest = {
      manifestVersion: "1.0",
      sessionId: this.sessionId,
      createdAtIso: new Date(timestamp).toISOString(),
      status: metadataInput.status,
      totalFiles: fileEntries.length,
      totalBytes,
      files: fileEntries,
      manifestSha256,
    };

    const manifestPath = path.join(this.targetDir, "session-manifest.json");
    fsSync.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
      sessionDir: this.targetDir,
      manifestPath,
      status: metadataInput.status,
      manifest,
    };
  }
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
  const maxDiskBytes = (input.maxDiskMb ?? 256) * 1024 * 1024;
  fsSync.mkdirSync(targetDir, { recursive: true });

  let cumulativeBytes = 0;

  // B2-READY-05: Zero-event sessions without error finish safely as FINALIZED
  const status: "FINALIZED" | "FAILED" | "INTERRUPTED" =
    input.forcedStatus ?? (input.error ? "FAILED" : "FINALIZED");

  // Helper to write JSONL stream with BigInt serialization support and disk budget enforcement
  const writeJsonl = (filename: B2EvidenceFileName, items: readonly unknown[]): string => {
    const filePath = path.join(targetDir, filename);
    const content =
      items
        .map((item) =>
          JSON.stringify(item, (_key, val) => (typeof val === "bigint" ? val.toString() : val)),
        )
        .join("\n") + (items.length > 0 ? "\n" : "");
    const fileBytes = Buffer.byteLength(content, "utf8");
    if (cumulativeBytes + fileBytes > maxDiskBytes) {
      throw new Error(
        `[DISK_BUDGET_EXCEEDED] Cannot write ${filename}: reached disk budget ceiling of ${maxDiskBytes} bytes`,
      );
    }
    fsSync.writeFileSync(filePath, content, "utf8");
    cumulativeBytes += fileBytes;
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
  const metadataContent = JSON.stringify(
    metadata,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2,
  );
  const metaBytes = Buffer.byteLength(metadataContent, "utf8");
  if (cumulativeBytes + metaBytes > maxDiskBytes) {
    throw new Error(
      `[DISK_BUDGET_EXCEEDED] Cannot write session-metadata.json: reached disk budget ceiling of ${maxDiskBytes} bytes`,
    );
  }
  const metadataFilePath = path.join(targetDir, "session-metadata.json");
  fsSync.writeFileSync(metadataFilePath, metadataContent, "utf8");
  cumulativeBytes += metaBytes;

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

  // B2-READY-05: Reject extraneous or unlisted evidence files on disk
  const diskEntries = fsSync.readdirSync(sessionDir);
  for (const entry of diskEntries) {
    if (entry !== "session-manifest.json" && !seen.has(entry)) {
      throw new Error(
        `[B2_MANIFEST_EXTRANEOUS_FILE] Extraneous unmanifested file on disk in ${sessionDir}: ${entry}`,
      );
    }
  }

  return { valid: true, manifest };
}
