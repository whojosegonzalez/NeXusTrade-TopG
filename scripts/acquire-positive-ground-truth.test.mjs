import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateIndependentGroundTruth,
  PositiveGroundTruthAcquisitionCollector,
  RAYDIUM_AMM_V4_INIT2_TAG,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_INIT_DISCRIMINATOR,
  RAYDIUM_CPMM_PROGRAM_ID,
  runAcquisitionCli,
  verifyC2SessionManifest,
} from "./acquire-positive-ground-truth.mjs";
import { runVerifyManifestCli } from "./verify-pilot-manifest.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { encodeBase58 } = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "backend",
      "dist",
      "providers",
      "solana-rpc",
      "SolanaRpcMintAccountParser.js",
    ),
  ).href
);

/**
 * Creates a synthetic mock transaction for testing.
 */
function createMockTx({
  signature = "mock-sig-111",
  slot = 300000000,
  err = null,
  programId = RAYDIUM_AMM_V4_PROGRAM_ID,
  poolAddress = "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
  isAmmV4Init = false,
  isCpmmInit = false,
  isSwap = false,
}) {
  const actualProgramId = isCpmmInit
    ? RAYDIUM_CPMM_PROGRAM_ID
    : isAmmV4Init || isSwap
      ? RAYDIUM_AMM_V4_PROGRAM_ID
      : programId;

  const staticKeys = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // 0: SPL Token
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // 1: ATA
    "11111111111111111111111111111111", // 2: System Program
    "SysvarRent111111111111111111111111111111111", // 3: Rent
    poolAddress, // 4: Pool State
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // 5: Authority
    "open-orders-account", // 6
    "lp-mint-account", // 7
    "So11111111111111111111111111111111111111112", // 8: Token 0 (WSOL)
    "TokenMintAccount111111111111111111111111111", // 9: Token 1
    "token-0-vault-account", // 10
    "token-1-vault-account", // 11
    "target-orders-account", // 12
    "amm-config-account", // 13
    "fee-dest-account", // 14
    "market-program-id", // 15
    "market-account", // 16
    "creator-wallet-signer", // 17
    "user-coin-ata", // 18
    "user-pc-ata", // 19
    "user-lp-ata", // 20
    actualProgramId, // 21
  ];

  let instructionData;
  let accountKeyIndexes;

  if (isAmmV4Init) {
    // 26-byte initialize2 payload (byte 0 is 1)
    const buf = Buffer.alloc(26);
    buf.writeUInt8(RAYDIUM_AMM_V4_INIT2_TAG, 0);
    buf.writeUInt8(254, 1); // nonce
    buf.writeBigUInt64LE(1700000000n, 2); // open_time
    buf.writeBigUInt64LE(1000000000n, 10);
    buf.writeBigUInt64LE(5000000000n, 18);
    instructionData = encodeBase58(buf);
    accountKeyIndexes = Array.from({ length: 21 }, (_, i) => i);
  } else if (isCpmmInit) {
    // 32-byte Anchor initialize payload
    const buf = Buffer.alloc(32);
    for (let d = 0; d < 8; d++) {
      buf.writeUInt8(RAYDIUM_CPMM_INIT_DISCRIMINATOR[d], d);
    }
    buf.writeBigUInt64LE(1000000000n, 8);
    buf.writeBigUInt64LE(2000000000n, 16);
    buf.writeBigUInt64LE(1700000000n, 24);
    instructionData = encodeBase58(buf);
    // CPMM order: 3 is pool_state, 4 is mint0, 5 is mint1, 10 is vault0, 11 is vault1
    accountKeyIndexes = [17, 13, 5, 4, 8, 9, 7, 18, 19, 20, 10, 11, 14, 6, 0, 0, 0, 1, 2, 3];
  } else if (isSwap) {
    // AMM v4 swap (tag 9)
    const buf = Buffer.alloc(17);
    buf.writeUInt8(9, 0);
    instructionData = encodeBase58(buf);
    accountKeyIndexes = [0, 4, 5, 10, 11, 8, 9, 18, 19, 17];
  } else {
    instructionData = encodeBase58(Buffer.alloc(8));
    accountKeyIndexes = [0, 1, 2];
  }

  return {
    slot,
    blockTime: 1700000000,
    meta: {
      err,
      logMessages: isAmmV4Init
        ? [
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
            "Program log: initialize2: InitializeInstruction2",
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
          ]
        : isCpmmInit
          ? [
              "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
              "Program log: Instruction: Initialize",
              "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
            ]
          : [
              "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
              "Program log: ray_log: A9lj5H8...",
              "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
            ],
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: staticKeys,
        instructions: [
          {
            programIdIndex: 21,
            accountKeyIndexes,
            data: instructionData,
          },
        ],
      },
    },
  };
}

test("C2 Execution Readiness: Operator Authorization and Network Gates fail closed", async () => {
  // Missing both flags
  const code1 = await runAcquisitionCli(["node", "script.mjs"]);
  assert.equal(code1, 1, "Must exit with 1 when unauthorized");

  // Missing network flag
  const code2 = await runAcquisitionCli(["node", "script.mjs", "--authorize-c2-acquisition"]);
  assert.equal(code2, 1, "Must exit with 1 when network flag missing");

  // Missing authorize flag
  const code3 = await runAcquisitionCli(["node", "script.mjs", "--network=enabled"]);
  assert.equal(code3, 1, "Must exit with 1 when authorization flag missing");
});

test("Correction 1 (Version Support): getTransaction uses maxSupportedTransactionVersion: 1", async () => {
  let capturedVersion = null;

  const mockTransport = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      return { result: [{ signature: "sig-test-v1", slot: 100 }] };
    }
    if (method === "getTransaction") {
      capturedVersion = params[1]?.maxSupportedTransactionVersion;
      return { result: createMockTx({ signature: "sig-test-v1", isAmmV4Init: true }) };
    }
    return { result: null };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-v1-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 1,
  });

  await collector.runAcquisition([
    {
      poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
      symbol: "TEST_V1",
      protocol: "RAYDIUM_AMM_V4",
    },
  ]);

  assert.equal(capturedVersion, 1, "Must specify maxSupportedTransactionVersion: 1 for v1 support");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Correction 2 (Creation-Signature Identification): Incomplete history within budget marks UNRESOLVED_GENESIS_NOT_REACHED", async () => {
  // Page 1 returns 100 signatures; Page 2 returns 100 signatures (history continues beyond 200)
  // Oldest candidate is a swap, not an initialization
  const mockTransport = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      const page = [];
      for (let i = 0; i < 100; i++) {
        page.push({ signature: `sig-page-${params[1]?.before ? "2" : "1"}-${i}`, slot: 200 - i });
      }
      return { result: page };
    }
    if (method === "getTransaction") {
      // Returns routine swap, NOT initialization
      return { result: createMockTx({ signature: params[0], isSwap: true }) };
    }
    return { result: null };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-creation-sig-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 1,
  });

  await collector.runAcquisition([
    {
      poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
      symbol: "TEST_DEEP",
      protocol: "RAYDIUM_AMM_V4",
    },
  ]);

  assert.equal(collector.positiveRegistry.length, 0, "No positive ground truth invented");
  const summary = collector.evaluatedSeeds[0];
  assert.ok(
    summary.status.includes("UNRESOLVED_GENESIS_NOT_REACHED"),
    `Must mark UNRESOLVED_GENESIS_NOT_REACHED, got ${summary.status}`,
  );
  assert.equal(summary.historyTruncated, true, "Must flag that history was truncated");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Correction 3 (Independent Ground Truth): Labels authentic positives independently of production parser and without requiring SystemProgram.createAccount", async () => {
  const ammV4Tx = createMockTx({
    signature: "amm-v4-genesis",
    poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
    isAmmV4Init: true,
  });
  const cpmmTx = createMockTx({
    signature: "cpmm-genesis",
    poolAddress: "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp",
    isCpmmInit: true,
  });

  const ammV4Eval = evaluateIndependentGroundTruth(
    ammV4Tx,
    "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
    "RAYDIUM_AMM_V4",
  );
  assert.equal(ammV4Eval.isPositive, true, "AMM v4 initialize2 must be independently positive");
  assert.equal(ammV4Eval.instructionType, "initialize2");
  assert.equal(ammV4Eval.poolAddress, "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp");

  const cpmmEval = evaluateIndependentGroundTruth(
    cpmmTx,
    "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp",
    "RAYDIUM_CPMM",
  );
  assert.equal(cpmmEval.isPositive, true, "CPMM initialize must be independently positive");
  assert.equal(cpmmEval.instructionType, "initialize");
  assert.equal(cpmmEval.poolAddress, "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp");

  // Failed on-chain transaction must be rejected
  const failedTx = createMockTx({ isAmmV4Init: true, err: { InstructionError: [0, "Custom"] } });
  const failedEval = evaluateIndependentGroundTruth(
    failedTx,
    ammV4Tx.poolAddress,
    "RAYDIUM_AMM_V4",
  );
  assert.equal(failedEval.isPositive, false, "Failed tx must not be accepted as positive");
  assert.equal(failedEval.reason, "TRANSACTION_FAILED_ON_CHAIN");
});

test("Correction 4 (Unavailable History): getTransaction null is classified as UNAVAILABLE", async () => {
  const mockTransport = async (method) => {
    if (method === "getSignaturesForAddress") {
      return { result: [{ signature: "pruned-candidate-sig", slot: 100 }] };
    }
    if (method === "getTransaction") {
      return { result: null };
    }
    return { result: null };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-null-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 1,
  });

  await collector.runAcquisition([
    {
      poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
      symbol: "TEST_NULL",
      protocol: "RAYDIUM_AMM_V4",
    },
  ]);

  assert.equal(collector.evaluatedSeeds[0].status, "UNAVAILABLE");
  assert.equal(collector.positiveRegistry.length, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Resource Ceilings: Enforces 12 seeds, 24 history, 20 transaction, 10 account, and 54 total calls limits", async () => {
  const mockTransport = async (method) => {
    if (method === "getSignaturesForAddress") {
      // Return 100 to force page 2
      const res = [];
      for (let i = 0; i < 100; i++) res.push({ signature: `sig-${i}`, slot: 100 });
      return { result: res };
    }
    if (method === "getTransaction") {
      return { result: createMockTx({ isSwap: true }) };
    }
    return { result: null };
  };

  // Provide 20 seeds to test the 12-seed and 54-call limits
  const seeds = [];
  for (let s = 0; s < 20; s++) {
    seeds.push({
      poolAddress: `pool-${s}`,
      symbol: `SYM_${s}`,
      protocol: s % 2 === 0 ? "RAYDIUM_AMM_V4" : "RAYDIUM_CPMM",
    });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-ceilings-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 12,
    maxHistoryCalls: 24,
    maxTransactionCalls: 20,
    maxAccountCalls: 10,
    maxTotalRpcCalls: 54,
  });

  await collector.runAcquisition(seeds);

  assert.ok(
    collector.evaluatedSeeds.length <= 12,
    `Evaluated seeds must be <= 12, got ${collector.evaluatedSeeds.length}`,
  );
  assert.ok(
    collector.historyCallsExecuted <= 24,
    `History calls must be <= 24, got ${collector.historyCallsExecuted}`,
  );
  assert.ok(
    collector.transactionCallsExecuted <= 20,
    `Transaction calls must be <= 20, got ${collector.transactionCallsExecuted}`,
  );
  assert.ok(
    collector.totalRpcCallsExecuted <= 54,
    `Total calls must be <= 54, got ${collector.totalRpcCallsExecuted}`,
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Retries Count Toward All Applicable Ceilings: 429 retries increment method and total counters", async () => {
  let callCount = 0;
  const mockTransport = async () => {
    callCount++;
    if (callCount <= 2) {
      // Return HTTP 429 for first 2 attempts
      const err = new Error("HTTP_429_TOO_MANY_REQUESTS");
      throw err;
    }
    return { result: [{ signature: "sig-recovered", slot: 100 }] };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-retry-ceiling-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 1,
    maxHistoryCalls: 24,
    maxTotalRpcCalls: 54,
    maxRetriesPerCall: 2,
  });

  // Call getSignaturesForAddress via executeRpcCall
  const resp = await collector.executeRpcCall("getSignaturesForAddress", ["test-pool"], "history");

  assert.equal(
    collector.historyCallsExecuted,
    3,
    "Each attempt and retry must increment history count",
  );
  assert.equal(
    collector.totalRpcCallsExecuted,
    3,
    "Each attempt and retry must increment total count",
  );
  assert.equal(resp.result[0].signature, "sig-recovered");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Early Termination: Stops when target yields are achieved before exhausting budget with 10 distinct pools", async () => {
  let seedIdx = 0;
  const mockTransport = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      return { result: [{ signature: `sig-${params[0]}`, slot: 100 }] };
    }
    if (method === "getTransaction") {
      const isAmm = seedIdx < 5;
      const poolAddr = isAmm ? `amm-pool-${seedIdx}` : `cpmm-pool-${seedIdx - 5}`;
      seedIdx++;
      return {
        result: createMockTx({
          signature: params[0],
          isAmmV4Init: isAmm,
          isCpmmInit: !isAmm,
          poolAddress: poolAddr,
        }),
      };
    }
    return { result: null };
  };

  const seeds = [];
  for (let i = 0; i < 5; i++) {
    seeds.push({ poolAddress: `amm-pool-${i}`, symbol: `AMM_${i}`, protocol: "RAYDIUM_AMM_V4" });
  }
  for (let j = 0; j < 5; j++) {
    seeds.push({ poolAddress: `cpmm-pool-${j}`, symbol: `CPMM_${j}`, protocol: "RAYDIUM_CPMM" });
  }
  // Extra seeds that should not be touched
  for (let k = 0; k < 5; k++) {
    seeds.push({
      poolAddress: `extra-pool-${k}`,
      symbol: `EXTRA_${k}`,
      protocol: "RAYDIUM_AMM_V4",
    });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-early-term-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 15,
    targetAmmV4: 5,
    targetCpmm: 5,
  });

  const result = await collector.runAcquisition(seeds);

  assert.equal(result.positivesCount, 10, "Target yield of 10 reached");
  assert.equal(result.ammV4Count, 5, "5 AMM v4 confirmed");
  assert.equal(result.cpmmCount, 5, "5 CPMM confirmed");
  assert.ok(
    result.stopReason.startsWith("TARGET_YIELD_REACHED"),
    `Expected TARGET_YIELD_REACHED, got ${result.stopReason}`,
  );
  assert.equal(collector.evaluatedSeeds.length, 10, "Extra seeds were not evaluated");

  // Verify all 10 accepted positives represent 10 distinct pools and 10 distinct signatures (C2-LAUNCH-02)
  const poolSet = new Set(collector.positiveRegistry.map((p) => p.poolAddress));
  const sigSet = new Set(collector.positiveRegistry.map((p) => p.signature));
  assert.equal(poolSet.size, 10, "Must contain 10 distinct pool identities");
  assert.equal(sigSet.size, 10, "Must contain 10 distinct transaction signatures");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("C2-LAUNCH-02: Repeated pool identities or duplicate signatures cannot inflate benchmark counts", async () => {
  let poolACalls = 0;
  const mockTransport = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      if (params[0] === "pool-A") {
        poolACalls++;
        const sig = poolACalls === 1 ? "sig-1" : "sig-2";
        return { result: [{ signature: sig, slot: 100 }] };
      }
      if (params[0] === "pool-B") {
        return { result: [{ signature: "sig-1", slot: 100 }] };
      }
    }
    if (method === "getTransaction") {
      const sig = params[0];
      if (sig === "sig-1") {
        const currentPool = poolACalls === 1 ? "pool-A" : "pool-B";
        return {
          result: createMockTx({
            signature: "sig-1",
            isAmmV4Init: true,
            poolAddress: currentPool,
          }),
        };
      }
      if (sig === "sig-2") {
        return {
          result: createMockTx({
            signature: "sig-2",
            isAmmV4Init: true,
            poolAddress: "pool-A", // Duplicate pool identity
          }),
        };
      }
    }
    return { result: null };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-dedup-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 5,
  });

  const seeds = [
    { poolAddress: "pool-A", symbol: "SEED_1", protocol: "RAYDIUM_AMM_V4" },
    { poolAddress: "pool-A", symbol: "SEED_2", protocol: "RAYDIUM_AMM_V4" },
    { poolAddress: "pool-B", symbol: "SEED_3", protocol: "RAYDIUM_AMM_V4" },
  ];

  await collector.runAcquisition(seeds);

  // Seed 1 accepted; Seed 2 rejected as duplicate pool; Seed 3 rejected as duplicate signature
  assert.equal(collector.positiveRegistry.length, 1, "Only first unique positive accepted");
  assert.equal(collector.discoveredAmmV4Count, 1, "Count must not be inflated");
  assert.equal(collector.evaluatedSeeds[1].status, "DUPLICATE_POOL_IDENTITY");
  assert.equal(collector.evaluatedSeeds[2].status, "DUPLICATE_POSITIVE_SIGNATURE");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("C2-LAUNCH-01: Overall session deadline halts collection cleanly and seals partial evidence", async () => {
  let callCount = 0;
  const mockTransport = async (method, params) => {
    callCount++;
    if (method === "getSignaturesForAddress") {
      return { result: [{ signature: `sig-deadline-${callCount}`, slot: 100 }] };
    }
    if (method === "getTransaction") {
      return {
        result: createMockTx({
          signature: params[0],
          isAmmV4Init: true,
          poolAddress: `pool-deadline-${callCount}`,
        }),
      };
    }
    return { result: null };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-deadline-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 10,
    maxSessionDurationSec: 1, // 1-second deadline
  });

  // Inject a small sleep in transport to exceed 1s deadline
  const slowTransport = async (method, params) => {
    await new Promise((r) => setTimeout(r, 600)); // Two calls = 1200ms > 1000ms deadline
    return mockTransport(method, params);
  };
  collector.customTransport = slowTransport;

  const seeds = [];
  for (let s = 0; s < 5; s++) {
    seeds.push({
      poolAddress: `pool-deadline-${s}`,
      symbol: `DEAD_${s}`,
      protocol: "RAYDIUM_AMM_V4",
    });
  }

  const result = await collector.runAcquisition(seeds);

  assert.ok(
    result.stopReason.includes("SESSION_DEADLINE_EXCEEDED"),
    `Expected stopReason SESSION_DEADLINE_EXCEEDED, got ${result.stopReason}`,
  );
  // Verify that partial session was sealed and passes manifest validation
  const manifestResult = verifyC2SessionManifest(result.targetDir);
  assert.equal(manifestResult.valid, true, "Partial session manifest must be valid");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Circuit Breaker: Halts session when 3 consecutive RPC errors occur", async () => {
  const mockTransport = async () => {
    throw new Error("RPC_HTTP_503_SERVICE_UNAVAILABLE");
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-test-circuit-breaker-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempDir,
    maxSeeds: 5,
    maxRetriesPerCall: 0,
    circuitBreakerConsecutiveErrors: 3,
  });

  const seeds = [
    { poolAddress: "p1", symbol: "S1", protocol: "RAYDIUM_AMM_V4" },
    { poolAddress: "p2", symbol: "S2", protocol: "RAYDIUM_AMM_V4" },
    { poolAddress: "p3", symbol: "S3", protocol: "RAYDIUM_AMM_V4" },
    { poolAddress: "p4", symbol: "S4", protocol: "RAYDIUM_AMM_V4" },
  ];

  const result = await collector.runAcquisition(seeds);

  assert.ok(
    result.stopReason.startsWith("CIRCUIT_BREAKER_TRIGGERED"),
    `Expected CIRCUIT_BREAKER_TRIGGERED, got ${result.stopReason}`,
  );
  assert.equal(collector.totalRpcCallsExecuted, 3, "Stopped after 3 errors");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Manifest Integrity: Generated C2 session passes verifyC2SessionManifest and verify-pilot-manifest.mjs", async () => {
  const mockTransport = async (method) => {
    if (method === "getSignaturesForAddress") {
      return { result: [{ signature: "sig-manifest-test", slot: 100 }] };
    }
    if (method === "getTransaction") {
      return {
        result: createMockTx({
          signature: "sig-manifest-test",
          isAmmV4Init: true,
          poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
        }),
      };
    }
    return { result: null };
  };

  const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-manifest-test-"));
  const collector = new PositiveGroundTruthAcquisitionCollector({
    transport: mockTransport,
    minRequestIntervalMs: 0,
    outputDir: tempBaseDir,
    maxSeeds: 1,
    targetAmmV4: 1,
    targetCpmm: 0,
  });

  const result = await collector.runAcquisition([
    {
      poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
      symbol: "TEST_MANIFEST",
      protocol: "RAYDIUM_AMM_V4",
    },
  ]);

  // 1. Direct verifyC2SessionManifest test
  const verifyResult = verifyC2SessionManifest(result.targetDir);
  assert.equal(verifyResult.valid, true, "Manifest must be cryptographically valid");
  assert.equal(verifyResult.manifest.manifestSha256, result.manifestSha256);

  // 2. Integration with verify-pilot-manifest.mjs
  const cliCode = await runVerifyManifestCli([
    "node",
    "verify-pilot-manifest.mjs",
    `--source=${result.targetDir}`,
  ]);
  assert.equal(cliCode, 0, "verify-pilot-manifest.mjs must accept valid C2 session");

  // 3. Tampering test: modify a file and assert verification fails
  const rawTxPath = path.join(result.targetDir, "raw-transactions.jsonl");
  fs.appendFileSync(rawTxPath, '{"tampered": true}\n');
  assert.throws(
    () => verifyC2SessionManifest(result.targetDir),
    /\[C2_MANIFEST_SIZE_MISMATCH\]|\[C2_MANIFEST_HASH_MISMATCH\]/,
    "Must fail closed on tampered file",
  );

  fs.rmSync(tempBaseDir, { recursive: true, force: true });
});
