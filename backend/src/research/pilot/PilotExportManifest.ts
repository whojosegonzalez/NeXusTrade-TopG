/**
 * Phase 12.94-D Milestone D.2.3: Session Dataset Export Manifest
 *
 * Implements deterministic SHA-256 per-file hashing and directory manifest generation
 * to guarantee complete transfer integrity from Fedora to Windows without claiming
 * asymmetric cryptographic authentication (D23P-04).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ManifestFileEntry,
  ManifestVerificationResult,
  SessionExportManifest,
} from "./PilotTypes.js";

export const MANIFEST_FILENAME = "manifest.json";

/**
 * Computes the SHA-256 hex digest of a Buffer or string.
 */
export function computeSha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Counts non-empty lines in a text string or buffer.
 */
function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.trim().length > 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * Generates an authoritative SHA-256 dataset export manifest for a session directory.
 * Writes `manifest.json` to the directory.
 */
export async function generateSessionExportManifest(
  sessionDir: string,
  sessionId: string,
  generationId: string,
  clockNowEpochMs: number = Date.now(),
): Promise<SessionExportManifest> {
  const dirEntries = await fs.readdir(sessionDir, { withFileTypes: true });
  const fileEntries: ManifestFileEntry[] = [];

  for (const entry of dirEntries) {
    if (!entry.isFile() || entry.name === MANIFEST_FILENAME) {
      continue;
    }

    const filePath = path.join(sessionDir, entry.name);
    const content = await fs.readFile(filePath);
    const sha256 = computeSha256Hex(content);
    const sizeBytes = content.byteLength;

    let lineCount: number | undefined = undefined;
    if (entry.name.endsWith(".jsonl")) {
      lineCount = countLines(content.toString("utf8"));
    }

    fileEntries.push({
      filename: entry.name,
      sizeBytes,
      sha256,
      ...(lineCount !== undefined ? { lineCount } : {}),
    });
  }

  // Sort files deterministically by filename
  fileEntries.sort((a, b) => a.filename.localeCompare(b.filename));

  // Compute canonical digest of the file set
  const canonicalManifestBody = JSON.stringify(fileEntries);
  const manifestDigestSha256 = computeSha256Hex(canonicalManifestBody);

  const manifest: SessionExportManifest = {
    schemaVersion: "1.0.0",
    sessionId,
    generationId,
    exportTimestampUtc: new Date(clockNowEpochMs).toISOString(),
    exportEpochMs: clockNowEpochMs,
    files: fileEntries,
    manifestDigestSha256,
  };

  const manifestPath = path.join(sessionDir, MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return manifest;
}

/**
 * Verifies an exported session directory against its manifest.json.
 * Recalculates all file hashes and identifies any missing, corrupted, or extra files.
 */
export async function verifySessionExportManifest(
  sessionDir: string,
): Promise<ManifestVerificationResult> {
  const manifestPath = path.join(sessionDir, MANIFEST_FILENAME);

  let manifestContent: string;
  try {
    manifestContent = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    return {
      valid: false,
      mismatchedFiles: [],
      missingFiles: [MANIFEST_FILENAME],
      extraFiles: [],
      errorDetails: `Failed to read ${MANIFEST_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let manifest: SessionExportManifest;
  try {
    manifest = JSON.parse(manifestContent) as SessionExportManifest;
  } catch (err) {
    return {
      valid: false,
      mismatchedFiles: [MANIFEST_FILENAME],
      missingFiles: [],
      extraFiles: [],
      errorDetails: `Malformed JSON in ${MANIFEST_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Verify internal manifest digest
  const canonicalBody = JSON.stringify(manifest.files);
  const expectedDigest = computeSha256Hex(canonicalBody);
  if (manifest.manifestDigestSha256 !== expectedDigest) {
    return {
      valid: false,
      mismatchedFiles: [MANIFEST_FILENAME],
      missingFiles: [],
      extraFiles: [],
      errorDetails: `Manifest internal digest mismatch: expected ${expectedDigest}, found ${manifest.manifestDigestSha256}`,
    };
  }

  const dirEntries = await fs.readdir(sessionDir, { withFileTypes: true });
  const actualFilesOnDisk = new Set(
    dirEntries.filter((e) => e.isFile() && e.name !== MANIFEST_FILENAME).map((e) => e.name),
  );

  const missingFiles: string[] = [];
  const mismatchedFiles: string[] = [];
  const manifestFileMap = new Map<string, ManifestFileEntry>();

  for (const entry of manifest.files) {
    manifestFileMap.set(entry.filename, entry);
    if (!actualFilesOnDisk.has(entry.filename)) {
      missingFiles.push(entry.filename);
      continue;
    }

    const filePath = path.join(sessionDir, entry.filename);
    const content = await fs.readFile(filePath);
    const recalculatedSha256 = computeSha256Hex(content);

    if (content.byteLength !== entry.sizeBytes || recalculatedSha256 !== entry.sha256) {
      mismatchedFiles.push(entry.filename);
    }
  }

  const extraFiles: string[] = [];
  for (const filename of actualFilesOnDisk) {
    if (!manifestFileMap.has(filename)) {
      extraFiles.push(filename);
    }
  }

  const valid =
    missingFiles.length === 0 && mismatchedFiles.length === 0 && extraFiles.length === 0;

  return {
    valid,
    mismatchedFiles,
    missingFiles,
    extraFiles,
    ...(valid
      ? {}
      : {
          errorDetails: `Verification failed: ${mismatchedFiles.length} mismatched, ${missingFiles.length} missing, ${extraFiles.length} unexpected files`,
        }),
  };
}
