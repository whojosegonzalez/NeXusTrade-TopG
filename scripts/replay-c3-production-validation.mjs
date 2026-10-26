#!/usr/bin/env node
/**
 * Phase 12.94-D.2.9-C3: Offline Production Replay & Verification
 *
 * Replays the sealed C3 authentic historical ground-truth transactions through
 * the compiled production pipeline:
 *   1. classifyNotificationLogs (log prioritization)
 *   2. SolanaRpcTransactionFetcher.parseTransactionResponse (wire translation)
 *   3. identifyPoolInitializationInstructions (pool initialization decoder)
 *
 * Compares every extracted field against independently established on-chain
 * ground truth (derived directly from raw instruction account vectors) and
 * reports any mismatches.
 *
 * 100% offline and deterministic. Zero live RPC calls.
 * Preserves actual decoded event objects in a separate derived analysis file:
 *   data/research/c3-captures/c3-offline-production-replay.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

// Dynamic imports from compiled dist
const { classifyNotificationLogs } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "EventDiscoveryIngestionEngine.js")).href
);
const { identifyPoolInitializationInstructions } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "PoolInitializationParser.js")).href
);
const { SolanaRpcTransactionFetcher } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "SolanaRpcTransactionFetcher.js")).href
);

export const INDEPENDENT_GROUND_TRUTH = [
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
  },
];

export function runOfflineReplay(options = {}) {
  const captureDir =
    options.captureDir ||
    path.join(rootDir, "data", "research", "c3-captures", "c2-positive-ground-truth-1792927174883");
  const txFilePath = path.join(captureDir, "raw-transactions.jsonl");

  if (!fs.existsSync(txFilePath)) {
    throw new Error(`Sealed raw transactions file not found at: ${txFilePath}`);
  }

  const rawTxRecords = fs
    .readFileSync(txFilePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (rawTxRecords.length !== 2) {
    throw new Error(
      `Expected exactly 2 sealed raw transaction records, found ${rawTxRecords.length}`,
    );
  }

  const replayResults = [];
  const allMismatches = [];

  for (let idx = 0; idx < rawTxRecords.length; idx++) {
    const rawRecord = rawTxRecords[idx];
    const groundTruth = INDEPENDENT_GROUND_TRUTH[idx];
    const rawTx = rawRecord.response.result || rawRecord.response;

    // 1. Re-run classifyNotificationLogs on historical log array
    const logMessages = rawTx.meta?.logMessages || [];
    const logClassification = classifyNotificationLogs(logMessages);

    // 2. Re-run production transaction translation and initialization decoder
    const parsedMetadata = SolanaRpcTransactionFetcher.parseTransactionResponse(
      rawRecord.signature,
      rawRecord.response,
    );

    if (!parsedMetadata) {
      throw new Error(`Failed to parse transaction metadata for signature: ${rawRecord.signature}`);
    }

    const decodeResult = identifyPoolInitializationInstructions(parsedMetadata);

    if (!decodeResult.ok || !decodeResult.events || decodeResult.events.length === 0) {
      throw new Error(
        `Production decoder returned ok: false for authentic candidate: ${rawRecord.signature}`,
      );
    }

    const decodedEvent = decodeResult.events[0];

    // 3. Compare each decoded event field against ground truth
    const fieldComparisons = [
      { field: "protocol", expected: groundTruth.protocol, actual: decodedEvent.protocol },
      { field: "signature", expected: groundTruth.signature, actual: decodedEvent.signature },
      { field: "poolId", expected: groundTruth.poolId, actual: decodedEvent.poolId },
      { field: "token0Mint", expected: groundTruth.token0Mint, actual: decodedEvent.token0Mint },
      { field: "token1Mint", expected: groundTruth.token1Mint, actual: decodedEvent.token1Mint },
      { field: "token0Vault", expected: groundTruth.token0Vault, actual: decodedEvent.token0Vault },
      { field: "token1Vault", expected: groundTruth.token1Vault, actual: decodedEvent.token1Vault },
      { field: "lpMint", expected: groundTruth.lpMint, actual: decodedEvent.lpMint },
      {
        field: "ammConfigOrMarket",
        expected: groundTruth.ammConfigOrMarket,
        actual: decodedEvent.ammConfigOrMarket,
      },
      {
        field: "authorityPda",
        expected: groundTruth.authorityPda,
        actual: decodedEvent.authorityPda,
      },
      {
        field: "creatorWallet",
        expected: groundTruth.creatorWallet,
        actual: decodedEvent.creatorWallet,
      },
      {
        field: "outerInstructionIndex",
        expected: groundTruth.outerInstructionIndex,
        actual: decodedEvent.outerInstructionIndex,
      },
      { field: "slot", expected: groundTruth.slot, actual: decodedEvent.slot },
      {
        field: "blockTimeSec",
        expected: groundTruth.blockTimeSec,
        actual: decodedEvent.blockTimeSec,
      },
      {
        field: "logClassification",
        expected: groundTruth.expectedLogClassification,
        actual: logClassification,
      },
    ];

    const candidateMismatches = [];
    for (const cmp of fieldComparisons) {
      if (cmp.expected !== cmp.actual) {
        candidateMismatches.push({
          candidateId: groundTruth.candidateId,
          signature: groundTruth.signature,
          field: cmp.field,
          expected: cmp.expected,
          actual: cmp.actual,
        });
        allMismatches.push(candidateMismatches[candidateMismatches.length - 1]);
      }
    }

    replayResults.push({
      candidateId: groundTruth.candidateId,
      protocol: groundTruth.protocol,
      signature: groundTruth.signature,
      logMessagesCount: logMessages.length,
      logClassification,
      logClassificationMatch: logClassification === groundTruth.expectedLogClassification,
      decoderOk: decodeResult.ok,
      eventsDiscovered: decodeResult.events.length,
      decodedEvent,
      fieldComparisons,
      mismatchesCount: candidateMismatches.length,
      mismatches: candidateMismatches,
    });
  }

  const analysisReport = {
    replayedAtIso: new Date().toISOString(),
    sessionReplayed: "c2-positive-ground-truth-1792927174883",
    status: allMismatches.length === 0 ? "REPLAY_PERFECT_MATCH" : "REPLAY_MISMATCH_DETECTED",
    totalCandidatesEvaluated: rawTxRecords.length,
    totalMismatchesCount: allMismatches.length,
    allMismatches,
    candidates: replayResults,
  };

  // Preserve derived analysis file
  const outputPath =
    options.outputPath ||
    path.join(rootDir, "data", "research", "c3-captures", "c3-offline-production-replay.json");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(analysisReport, null, 2), "utf8");

  return { analysisReport, outputPath };
}

// Run CLI if called directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log("=== NeXusTrade D.2.9-C3 Offline Production Replay ===");
  try {
    const { analysisReport, outputPath } = runOfflineReplay();
    console.log(`[PASS] Replay completed with status: ${analysisReport.status}`);
    console.log(`[PASS] Total candidates evaluated: ${analysisReport.totalCandidatesEvaluated}`);
    console.log(`[PASS] Total mismatches count: ${analysisReport.totalMismatchesCount}`);
    console.log(`[PASS] Derived analysis file preserved at: ${outputPath}`);

    for (const c of analysisReport.candidates) {
      console.log(`\nCandidate: ${c.candidateId} (${c.protocol})`);
      console.log(`  Signature: ${c.signature}`);
      console.log(
        `  Logs Classification: ${c.logClassification} (expected: PRIORITIZED_INITIALIZATION)`,
      );
      console.log(`  Decoder Status: ok=${c.decoderOk}, events=${c.eventsDiscovered}`);
      console.log(`  Mismatches: ${c.mismatchesCount}`);
      if (c.mismatchesCount > 0) {
        console.error("  MISMATCH DETAILS:", c.mismatches);
      }
    }

    if (analysisReport.totalMismatchesCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("[ERROR] Offline replay failed:", err.message);
    process.exit(1);
  }
}
