/**
 * Phase 12.94-D Milestone D.2.9-C3: Authentic Historical Regression Fixtures
 *
 * Provides deterministic, offline read-only references to authentic on-chain
 * pool initialization transactions captured from Solana mainnet-beta and verified
 * against genesis instruction account vectors.
 *
 * ARCHITECTURAL SEPARATION:
 *   - Class 1 (Authentic Historical Fixtures): Defined in THIS module. Sealed on-chain
 *     captures from Milestone D.2.9-C3 (session c2-positive-ground-truth-1792927174883).
 *     Ground truth is established independently from on-chain account vectors.
 *   - Class 3 (Synthetic Test Fixtures): Defined in AuthoritativeEventFixtures.ts.
 *     Programmatically generated synthetic transactions and mock envelopes.
 *
 * CRYPTOGRAPHIC INTEGRITY:
 *   The loader verifies session-manifest.json, individual file SHA-256 digests,
 *   canonical manifest SHA-256, and binds each fixture to its exact transaction
 *   signature and payload SHA-256 rather than relying on positional array ordering.
 *
 * 100% OFFLINE. Zero network requests.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AuthenticPositiveGroundTruth {
  candidateId: string;
  protocol: "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM";
  programId: string;
  signature: string;
  poolId: string;
  token0Mint: string;
  token1Mint: string;
  token0Vault: string;
  token1Vault: string;
  lpMint: string;
  ammConfigOrMarket: string;
  authorityPda: string;
  creatorWallet: string;
  outerInstructionIndex: number;
  slot: number;
  blockTimeSec: number;
  discriminatorHex: string;
  expectedLogClassification: string;
  curationSource: string;
  payloadSha256: string;
}

export interface AuthenticHistoricalFixtureRecord {
  groundTruth: AuthenticPositiveGroundTruth;
  rawTransactionRecord: {
    protocol: string;
    signature: string;
    response: Record<string, unknown>;
    capturedAtEpochMs: number;
  };
  payloadSha256: string;
}

/**
 * Expected ground truth for the two sealed C3 authentic initializations.
 * Derived independently from Solana mainnet instruction account vectors.
 */
export const AUTHENTIC_C3_GROUND_TRUTH: readonly AuthenticPositiveGroundTruth[] = Object.freeze([
  {
    candidateId: "CANDIDATE-01",
    protocol: "RAYDIUM_AMM_V4",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    signature:
      "2YY7BM9NMH8fbSgNsy6YhWg6hEvnbpau4kNdmTXYcqs7UHo6NxY8MuZZH7qJke71vuNvmQmUUDA8LdkdgqYyrFP9",
    poolId: "J2sANvUT6up2u7pg3N1rkPBNmKG8KrUyqRCG7JDXM19Q",
    token0Mint: "5AdmE1AE2wkhvYXoGaEbZcXbwcoyHPFzbTgaBEP1MdFm",
    token1Mint: "So11111111111111111111111111111111111111112",
    token0Vault: "6Eg9P5R6sYYwXm7qxNGTucqcKkxWeKxLK56ZMYVTm9sh",
    token1Vault: "68mXSL3e2LecbnuD8oNCFrrgLVbAFTZLi8xFLpg3Qvp2",
    lpMint: "2QDB1dKrUVXhHhrSAvsj8jRHapibgsXrq1ucEAnBeN5b",
    ammConfigOrMarket: "E7Tof57tWNuM2ftdvMqusMPY9YtobCwcXtJzwJzrpiMr",
    authorityPda: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    creatorWallet: "9AzYyKRzHWvRVe6pch2wPGVCFbQr8BCChxhcsra2sERQ",
    outerInstructionIndex: 4,
    slot: 282300300,
    blockTimeSec: 1723112946,
    discriminatorHex: "01",
    expectedLogClassification: "PRIORITIZED_INITIALIZATION",
    curationSource: "https://www.soldev.cn/topics/71",
    payloadSha256: "1c243d45734274c8e14287a3a3f1e798f1a89e247c672d6192483d532521c984",
  },
  {
    candidateId: "CANDIDATE-02",
    protocol: "RAYDIUM_CPMM",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    signature:
      "25mwtoditp55vn7kQtqs4RmEfhvEZ4x4AxGFS68M62vnCSwbeQ7Efg9j4ovMen1XwvLVZNFyMPYBjxdVaTgBSkJv",
    poolId: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF",
    token0Mint: "So11111111111111111111111111111111111111112",
    token1Mint: "4fFS8haXMKTWfcSWjve5dxN1TX5bM1qTaxbKREhhxLa3",
    token0Vault: "4gc8LotGoQuCEYuCeNWvdhRCVmA88BQm3BptfP78pDSi",
    token1Vault: "AoFuGQ1gxQYmKkiWxpMMzGB5o33iYaBiFbmqWk4Rdjsa",
    lpMint: "CwMA1e8KN1UYKhaoZ3GyYyejUzLmU88rXDszwCVrR7pi",
    ammConfigOrMarket: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
    authorityPda: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    creatorWallet: "Ftd9Z5Nnc3mtaT5GmgJJwW9Ra5mtHpVFYwyaPd4LoBy8",
    outerInstructionIndex: 4,
    slot: 393939397,
    blockTimeSec: 1768589612,
    discriminatorHex: "afaf6d1f0d989bed",
    expectedLogClassification: "PRIORITIZED_INITIALIZATION",
    curationSource:
      "https://solscan.io/tx/25mwtoditp55vn7kQtqs4RmEfhvEZ4x4AxGFS68M62vnCSwbeQ7Efg9j4ovMen1XwvLVZNFyMPYBjxdVaTgBSkJv",
    payloadSha256: "f897c69afd45f286777608b164818d9afe98cc78211a7509d4ff91497a05aa50",
  },
]);

export const CANONICAL_C3_MANIFEST_SHA256 =
  "5f137d1ed48bb06637464a1feed7d9a184a004308c4ad3981aae6c2cc81a3952";

/**
 * Verifies the integrity of the sealed C3 capture session manifest and files on disk.
 * Throws fail-closed on missing files, size mismatches, hash mismatches, or canonical digest mismatch.
 */
export function verifyCaptureDirectoryIntegrity(captureDir: string): void {
  const manifestPath = path.join(captureDir, "session-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[C3_FIXTURE_MANIFEST_MISSING] Manifest not found at: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(
      `[C3_FIXTURE_MANIFEST_INVALID] Manifest has no files declared: ${manifestPath}`,
    );
  }

  let totalBytesComputed = 0;
  for (const entry of manifest.files) {
    const entryPath = path.join(captureDir, entry.filename);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`[C3_FIXTURE_FILE_MISSING] File missing on disk: ${entry.filename}`);
    }
    const diskBuf = fs.readFileSync(entryPath);
    if (diskBuf.length !== entry.byteSize) {
      throw new Error(
        `[C3_FIXTURE_SIZE_MISMATCH] ${entry.filename}: expected ${entry.byteSize} bytes, got ${diskBuf.length}`,
      );
    }
    const diskHash = crypto.createHash("sha256").update(diskBuf).digest("hex");
    if (diskHash !== entry.sha256) {
      throw new Error(
        `[C3_FIXTURE_HASH_MISMATCH] ${entry.filename}: expected ${entry.sha256}, got ${diskHash}`,
      );
    }
    totalBytesComputed += entry.byteSize;
  }

  if (manifest.totalBytes && manifest.totalBytes !== totalBytesComputed) {
    throw new Error(
      `[C3_FIXTURE_TOTAL_BYTES_MISMATCH] Declared ${manifest.totalBytes}, computed ${totalBytesComputed}`,
    );
  }

  const sortedFiles = [...manifest.files].sort((a, b) => a.filename.localeCompare(b.filename));
  const canonicalPayload = sortedFiles.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const computedCanonicalSha256 = crypto
    .createHash("sha256")
    .update(canonicalPayload)
    .digest("hex");

  if (computedCanonicalSha256 !== CANONICAL_C3_MANIFEST_SHA256) {
    throw new Error(
      `[C3_FIXTURE_CANONICAL_HASH_MISMATCH] Expected ${CANONICAL_C3_MANIFEST_SHA256}, computed ${computedCanonicalSha256}`,
    );
  }
}

/**
 * Loads authentic historical positive transactions from preserved evidence on disk.
 *
 * Rigorous guarantees:
 * 1. Cryptographically verifies session-manifest.json and all individual file hashes on disk.
 * 2. Binds each fixture directly by transaction signature and verified wire payload hash,
 *    not relying on positional array order.
 * 3. 100% offline and deterministic.
 */
export function loadAuthenticHistoricalPositives(
  options: {
    rootDir?: string;
    customCaptureDir?: string;
  } = {},
): AuthenticHistoricalFixtureRecord[] {
  let captureDir = options.customCaptureDir;

  if (!captureDir) {
    const baseDir =
      options.rootDir ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

    // Look in workspace data location first, then agent brain fallback
    const primaryPath = path.join(
      baseDir,
      "data",
      "research",
      "c3-captures",
      "c2-positive-ground-truth-1792927174883",
    );
    const tmpPath = path.join(
      baseDir,
      ".tmp",
      "c3-positive-verification",
      "c2-positive-ground-truth-1792927174883",
    );

    if (fs.existsSync(primaryPath)) {
      captureDir = primaryPath;
    } else if (fs.existsSync(tmpPath)) {
      captureDir = tmpPath;
    } else {
      captureDir = primaryPath;
    }
  }

  // 1. Verify directory manifest and hashes
  verifyCaptureDirectoryIntegrity(captureDir);

  // 2. Read raw transactions
  const rawTxPath = path.join(captureDir, "raw-transactions.jsonl");
  const lines = fs
    .readFileSync(rawTxPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // 3. Index raw transactions by signature (not positional order)
  const txBySignature = new Map<
    string,
    {
      protocol: string;
      signature: string;
      response: Record<string, unknown>;
      capturedAtEpochMs: number;
    }
  >();
  for (const rawTx of lines) {
    if (typeof rawTx.signature === "string") {
      txBySignature.set(rawTx.signature, rawTx);
    }
  }

  // 4. Bind each ground truth candidate to its matching signature and verify payload hash
  const boundFixtures: AuthenticHistoricalFixtureRecord[] = [];

  for (const groundTruth of AUTHENTIC_C3_GROUND_TRUTH) {
    const rawTxRecord = txBySignature.get(groundTruth.signature);
    if (!rawTxRecord) {
      throw new Error(
        `[C3_FIXTURE_SIGNATURE_NOT_FOUND] Ground-truth signature ${groundTruth.signature} (${groundTruth.candidateId}) was not found in raw transactions.`,
      );
    }

    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(rawTxRecord.response))
      .digest("hex");

    if (payloadHash !== groundTruth.payloadSha256) {
      throw new Error(
        `[C3_FIXTURE_PAYLOAD_HASH_MISMATCH] Candidate ${groundTruth.candidateId} payload hash mismatch. Expected ${groundTruth.payloadSha256}, got ${payloadHash}`,
      );
    }

    boundFixtures.push({
      groundTruth,
      rawTransactionRecord: rawTxRecord,
      payloadSha256: payloadHash,
    });
  }

  return boundFixtures;
}
