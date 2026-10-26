import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

const {
  loadAuthenticHistoricalPositives,
  verifyCaptureDirectoryIntegrity,
  AUTHENTIC_C3_GROUND_TRUTH,
  CANONICAL_C3_MANIFEST_SHA256,
} = await import(
  pathToFileURL(
    path.join(distDir, "research", "pilot", "fixtures", "AuthenticHistoricalFixtures.js"),
  ).href
);

const { classifyNotificationLogs } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "EventDiscoveryIngestionEngine.js")).href
);
const { identifyPoolInitializationInstructions } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "PoolInitializationParser.js")).href
);
const { SolanaRpcTransactionFetcher } = await import(
  pathToFileURL(path.join(distDir, "research", "pilot", "SolanaRpcTransactionFetcher.js")).href
);

test("Authentic Historical Fixtures — Registry & Ground Truth Invariants", () => {
  assert.equal(
    AUTHENTIC_C3_GROUND_TRUTH.length,
    2,
    "Expected exactly 2 sealed ground-truth entries",
  );
  assert.equal(
    CANONICAL_C3_MANIFEST_SHA256,
    "5f137d1ed48bb06637464a1feed7d9a184a004308c4ad3981aae6c2cc81a3952",
  );

  const [ammV4, cpmm] = AUTHENTIC_C3_GROUND_TRUTH;
  assert.equal(ammV4.protocol, "RAYDIUM_AMM_V4");
  assert.equal(ammV4.programId, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  assert.equal(ammV4.discriminatorHex, "01");
  assert.equal(ammV4.outerInstructionIndex, 4);

  assert.equal(cpmm.protocol, "RAYDIUM_CPMM");
  assert.equal(cpmm.programId, "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
  assert.equal(cpmm.discriminatorHex, "afaf6d1f0d989bed");
  assert.equal(cpmm.outerInstructionIndex, 4);
});

test("Authentic Historical Fixtures — Manifest & Hash Cryptographic Verification", () => {
  const captureDir = path.join(
    rootDir,
    "data",
    "research",
    "c3-captures",
    "c2-positive-ground-truth-1792927174883",
  );
  // Verify manifest and hashes without throws
  assert.doesNotThrow(() => {
    verifyCaptureDirectoryIntegrity(captureDir);
  }, "Evidence directory manifest and individual file SHA-256 digests must verify cleanly");
});

test("Authentic Historical Fixtures — Signature & Payload Binding (Non-Positional)", () => {
  const records = loadAuthenticHistoricalPositives({ rootDir });
  assert.equal(records.length, 2, "Must load exactly two authentic records from disk");

  const [rec1, rec2] = records;
  assert.equal(rec1.groundTruth.candidateId, "CANDIDATE-01");
  assert.equal(rec1.rawTransactionRecord.signature, rec1.groundTruth.signature);
  assert.equal(rec1.payloadSha256, rec1.groundTruth.payloadSha256);

  assert.equal(rec2.groundTruth.candidateId, "CANDIDATE-02");
  assert.equal(rec2.rawTransactionRecord.signature, rec2.groundTruth.signature);
  assert.equal(rec2.payloadSha256, rec2.groundTruth.payloadSha256);
});

test("Authentic Historical Fixtures — Production Log Prioritization Replay", () => {
  const records = loadAuthenticHistoricalPositives({ rootDir });

  for (const record of records) {
    const rawTx =
      record.rawTransactionRecord.response.result || record.rawTransactionRecord.response;
    const logMessages = rawTx.meta?.logMessages || [];
    assert.ok(logMessages.length > 0, "Transaction must contain log messages");

    const classification = classifyNotificationLogs(logMessages);
    assert.equal(
      classification,
      record.groundTruth.expectedLogClassification,
      `Logs for ${record.groundTruth.candidateId} must classify as PRIORITIZED_INITIALIZATION`,
    );
  }
});

test("Authentic Historical Fixtures — Production Parser Decoding & Zero Mismatches", () => {
  const records = loadAuthenticHistoricalPositives({ rootDir });

  for (const record of records) {
    const rawRecord = record.rawTransactionRecord;
    const groundTruth = record.groundTruth;

    const parsedMeta = SolanaRpcTransactionFetcher.parseTransactionResponse(
      rawRecord.signature,
      rawRecord.response,
    );
    assert.ok(parsedMeta, `Metadata parsing must succeed for ${groundTruth.candidateId}`);

    const result = identifyPoolInitializationInstructions(parsedMeta);
    assert.equal(result.ok, true, `Decoder must return ok: true for ${groundTruth.candidateId}`);
    assert.equal(
      result.events.length,
      1,
      `Exactly 1 pool event must be emitted for ${groundTruth.candidateId}`,
    );

    const event = result.events[0];
    const fieldsToVerify = [
      "protocol",
      "signature",
      "poolId",
      "token0Mint",
      "token1Mint",
      "token0Vault",
      "token1Vault",
      "lpMint",
      "ammConfigOrMarket",
      "authorityPda",
      "creatorWallet",
      "outerInstructionIndex",
      "slot",
      "blockTimeSec",
    ];

    const mismatches = [];
    for (const field of fieldsToVerify) {
      if (event[field] !== groundTruth[field]) {
        mismatches.push({
          field,
          expected: groundTruth[field],
          actual: event[field],
        });
      }
    }

    assert.equal(
      mismatches.length,
      0,
      `Expected 0 field mismatches for ${groundTruth.candidateId}, found: ${JSON.stringify(mismatches)}`,
    );
  }
});

test("Authentic Historical Fixtures — Fail Closed on Missing Directory or Tampered Manifest", () => {
  assert.throws(
    () => {
      loadAuthenticHistoricalPositives({ customCaptureDir: "/nonexistent/capture/dir" });
    },
    { message: /\[C3_FIXTURE_MANIFEST_MISSING\]/ },
  );
});
