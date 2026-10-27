/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Snapshot Acquisition Tests
 *
 * Deterministic offline test suite verifying:
 * 1. Successful 2-request acquisition with >= 2,500 ms host pacing and LP accounting.
 * 2. Credential non-exposure: transport credentials private in memory; public projection only;
 *    reflected credentials redacted; separate wire and stored digests; zero leakage in files or CLI.
 * 3. Strict argument validation: rejection of unknown options (e.g. --dryRun) and missing values.
 * 4. Strict numeric validation: NaN, Infinity, floats, negative values, minimum 2,500 ms pacing,
 *    and maximum 60,000 ms overall ceiling enforced.
 * 5. Single deadline enforcement: prevents attempt accounting mismatch when budget runs out.
 * 6. Evidence file sealing & separate manifest: exact file SHA-256 and byte sizes verified,
 *    anti-overwrite protection, and mandatory storage success (write failures fail closed).
 * 7. Interrupted acquisition sealing: preserves partial evidence and manifest on failure.
 * 8. Provenance preservation: dry-runs represent a plan with null evidence; injected fixtures
 *    faithfully report SYNTHETIC_FIXTURE without defaulting to CAPTURED_RPC; null timestamps preserved.
 * 9. Bootstrap failures terminating after attempt 1.
 * 10. Transport and RPC error handling.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acquireRaydiumAmmV4Snapshot,
  serializeJsonPreservingBigInts,
  validateNumericConfig,
  type SnapshotAcquisitionConfig,
} from "./RaydiumAmmV4SnapshotAcquisition.js";
import { parseCliArgs, runCli } from "./RaydiumAmmV4SnapshotCli.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplMintBuffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_LP_MINT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";

const CANONICAL_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const CANONICAL_AMM_BUMP = 254;

function createTestBatchAccounts(
  overrides: {
    poolNonce?: bigint;
    lpReserve?: bigint;
    lpSupply?: bigint;
    poolLpMint?: string;
    poolBaseVault?: string;
    poolQuoteVault?: string;
    poolBaseMint?: string;
    poolQuoteMint?: string;
    poolStatus?: bigint;
  } = {},
) {
  const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
    status: overrides.poolStatus ?? 1n,
    nonce: overrides.poolNonce ?? 254n,
    lpReserve: overrides.lpReserve ?? 1_000_000_000n,
    lpMintBase58: overrides.poolLpMint ?? FIXTURE_LP_MINT,
    baseVaultBase58: overrides.poolBaseVault ?? FIXTURE_BASE_VAULT,
    quoteVaultBase58: overrides.poolQuoteVault ?? FIXTURE_QUOTE_VAULT,
    baseMintBase58: overrides.poolBaseMint ?? FIXTURE_MEME_MINT,
    quoteMintBase58: overrides.poolQuoteMint ?? FIXTURE_WSOL_MINT,
  });

  const lpMintBuf = createAuthoritativeSplMintBuffer({
    supply: overrides.lpSupply ?? 49_000_000n,
    mintAuthorityBase58: CANONICAL_AMM_AUTHORITY,
    freezeAuthorityBase58: CANONICAL_AMM_AUTHORITY,
  });

  const baseVaultBuf = createAuthoritativeSplVaultBuffer({
    mintBase58: overrides.poolBaseMint ?? FIXTURE_MEME_MINT,
    ownerBase58: CANONICAL_AMM_AUTHORITY,
    rawAmount: 50_000_000_000n,
    state: 1,
  });

  const quoteVaultBuf = createAuthoritativeSplVaultBuffer({
    mintBase58: overrides.poolQuoteMint ?? FIXTURE_WSOL_MINT,
    ownerBase58: CANONICAL_AMM_AUTHORITY,
    rawAmount: 100_000_000_000n,
    state: 1,
  });

  return [
    { data: poolBuf.toString("base64"), owner: RAYDIUM_AMM_V4_PROGRAM_ID },
    { data: lpMintBuf.toString("base64"), owner: SPL_TOKEN_PROGRAM_ID },
    { data: baseVaultBuf.toString("base64"), owner: SPL_TOKEN_PROGRAM_ID },
    { data: quoteVaultBuf.toString("base64"), owner: SPL_TOKEN_PROGRAM_ID },
  ];
}

function buildRpcResponse(value: unknown, slot: number = 312500100, id: number = 1) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      context: { slot },
      value,
    },
  };
}

describe("Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Snapshot Acquisition", () => {
  it("executes successful 2-request acquisition with >= 2,500 ms host pacing and validates LP accounting", async () => {
    const batchAccounts = createTestBatchAccounts({
      lpReserve: 1_000_000_000n,
      lpSupply: 49_000_000n, // 95.1% inaccessible
    });

    const bootstrapAccountData = batchAccounts[0]!.data;

    let callCount = 0;
    const requestedMethods: string[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      callCount++;
      const bodyStr = String(init?.body);
      const parsedBody = JSON.parse(bodyStr);
      requestedMethods.push(parsedBody.method);

      if (callCount === 1) {
        expect(parsedBody.method).toBe("getAccountInfo");
        expect(parsedBody.params[0]).toBe(FIXTURE_POOL_ADDRESS);
        expect(parsedBody.params[1]).toEqual({ encoding: "base64", commitment: "confirmed" });

        const respObj = buildRpcResponse(
          {
            data: [bootstrapAccountData, "base64"],
            owner: RAYDIUM_AMM_V4_PROGRAM_ID,
            lamports: 1_000_000_000,
            executable: false,
            rentEpoch: 0,
          },
          312500100,
          1,
        );

        return new Response(JSON.stringify(respObj), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (callCount === 2) {
        expect(parsedBody.method).toBe("getMultipleAccounts");
        expect(parsedBody.params[0]).toEqual([
          FIXTURE_POOL_ADDRESS,
          FIXTURE_LP_MINT,
          FIXTURE_BASE_VAULT,
          FIXTURE_QUOTE_VAULT,
        ]);
        expect(parsedBody.params[1]).toEqual({
          encoding: "base64",
          commitment: "confirmed",
          minContextSlot: 312500100,
        });

        const respObj = buildRpcResponse(
          batchAccounts.map((acc) => ({
            data: [acc.data, "base64"],
            owner: acc.owner,
            lamports: 1_000_000_000,
            executable: false,
            rentEpoch: 0,
          })),
          312500105,
          2,
        );

        return new Response(JSON.stringify(respObj), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected HTTP call #${callCount}`);
    };

    const pacedSleeps: number[] = [];
    const mockSleeper = async (ms: number): Promise<void> => {
      pacedSleeps.push(ms);
    };

    let clockTime = 1770000000000;
    const mockClock = (): Date => {
      clockTime += 50;
      return new Date(clockTime);
    };

    const result = await acquireRaydiumAmmV4Snapshot({
      rpcUrl: "https://solana-rpc.example.com/?api-key=SECRET123",
      poolId: FIXTURE_POOL_ADDRESS,
      expectedTokenMint: FIXTURE_MEME_MINT,
      pacingMs: 2500,
      evidenceOrigin: "SYNTHETIC_FIXTURE",
      isSyntheticFixture: true,
      fetch: mockFetch as typeof fetch,
      sleeper: mockSleeper,
      clock: mockClock,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.httpAttempts).toBe(2);
    expect(callCount).toBe(2);
    expect(pacedSleeps).toEqual([2500]);
    expect(requestedMethods).toEqual(["getAccountInfo", "getMultipleAccounts"]);

    const ev = result.evidence;
    expect(ev.endpoint.sanitizedUrl).toBe("https://solana-rpc.example.com/?api-key=[REDACTED]");
    expect(ev.contextSlots.bootstrapSlot).toBe(312500100);
    expect(ev.contextSlots.batchSlot).toBe(312500105);
    expect(ev.contextSlots.minContextSlotEnforced).toBe(true);
    expect(ev.contextSlots.staleSlotDetected).toBe(false);

    expect(ev.outcomes.retrievalOk).toBe(true);
    expect(ev.outcomes.structuralValidationOk).toBe(true);
    expect(ev.outcomes.meetsNinetyPercentThreshold).toBe(true);

    expect(ev.accounting).not.toBeNull();
    expect(ev.accounting?.displayInaccessiblePct).toBe(95.1);
    expect(ev.accounting?.meetsNinetyPercentThreshold).toBe(true);

    expect(ev.payloadDigestSha256).toBeDefined();
    expect(ev.payloadDigestSha256?.length).toBe(64);

    expect(ev.evidenceBoundary.bytecodeEquivalenceVerified).toBe(false);
    expect(ev.evidenceBoundary.completeExecutableReservesVerified).toBe(false);
    expect(ev.evidenceBoundary.generalTokenSafetyVerified).toBe(false);
    expect(ev.evidenceBoundary.strategyGateAdmitted).toBe(false);
  });

  describe("1. Credential Non-Exposure & Redaction", () => {
    it("strictly prevents dummy API keys or credentials from appearing in returned public evidence", async () => {
      const batchAccounts = createTestBatchAccounts();
      const dummyApiKey = "SUPER_SECRET_KEY_999888";
      const dummyUserPass = "alice:topsecretpassword";
      const rpcUrl = `https://${dummyUserPass}@solana-rpc.example.com/v1/?api-key=${dummyApiKey}&other=safe`;

      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                {
                  data: [batchAccounts[0]!.data, "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
                312500100,
                1,
              ),
            ),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              batchAccounts.map((a) => ({ data: [a.data, "base64"], owner: a.owner })),
              312500105,
              2,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl,
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        fetch: mockFetch as typeof fetch,
        sleeper: async () => {},
      });

      expect(result.ok).toBe(true);
      const serializedEvidence = serializeJsonPreservingBigInts(result.evidence);

      // Verify dummy secrets are completely absent from serialized public evidence
      expect(serializedEvidence).not.toContain(dummyApiKey);
      expect(serializedEvidence).not.toContain("alice");
      expect(serializedEvidence).not.toContain("topsecretpassword");
      expect(serializedEvidence).not.toContain(rpcUrl);

      // Verify endpoint projection contains only safe fields
      expect(result.evidence.endpoint).toEqual({
        sanitizedUrl:
          "https://[REDACTED]:[REDACTED]@solana-rpc.example.com/v1/?api-key=[REDACTED]&other=safe",
        host: "solana-rpc.example.com",
        endpointFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      });
      expect(
        (result.evidence.endpoint as unknown as Record<string, unknown>).rawUrl,
      ).toBeUndefined();
      expect(
        (result.evidence.endpoint as unknown as Record<string, unknown>).sensitiveTokens,
      ).toBeUndefined();
    });

    it("redacts reflected credentials from response bodies, labels alteration, and distinguishes digests", async () => {
      const dummySecret = "LEAKY_SECRET_TOKEN_4321";
      const rpcUrl = `https://solana-rpc.example.com/?api-key=${dummySecret}`;

      const mockFetch = async (): Promise<Response> => {
        // Simulate a misconfigured upstream server reflecting the secret token in an error body
        const reflectedBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32602,
            message: `Invalid access with credentials api-key=${dummySecret} for requested method`,
          },
        });
        return new Response(reflectedBody, { status: 200 });
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl,
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);

      const reqRecord = result.evidence.requests[0]!;
      expect(reqRecord.wasRedacted).toBe(true);
      expect(reqRecord.rawResponseBody).not.toContain(dummySecret);
      expect(reqRecord.rawResponseBody).toContain("[REDACTED]");
      expect(reqRecord.error).toBeNull();
      expect(result.evidence.failureReason).not.toContain(dummySecret);
      expect(result.evidence.failureReason).toContain("[REDACTED]");

      // Verify wire digest vs stored digest distinction
      expect(reqRecord.wireResponseSha256).toBeDefined();
      expect(reqRecord.storedResponseSha256).toBeDefined();
      expect(reqRecord.wireResponseSha256).not.toBe(reqRecord.storedResponseSha256);

      // Verify serialized public evidence
      const serialized = serializeJsonPreservingBigInts(result.evidence);
      expect(serialized).not.toContain(dummySecret);
    });

    it("redacts credentials from network/transport error messages", async () => {
      const dummySecret = "TRANSPORT_LEAK_SECRET_9876";
      const rpcUrl = `https://solana-rpc.example.com/?token=${dummySecret}`;

      const mockFetch = async (): Promise<Response> => {
        throw new Error(`Failed to connect to ${rpcUrl}: network reset`);
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl,
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      const reqRecord = result.evidence.requests[0]!;
      expect(reqRecord.error).not.toContain(dummySecret);
      expect(reqRecord.error).toContain("[REDACTED]");
      expect(result.evidence.failureReason).not.toContain(dummySecret);
      expect(result.evidence.failureReason).toContain("[REDACTED]");
    });

    it("redacts credentials when represented by JSON Unicode escapes in response bodies and decoded parsedJson", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raydium-test-redact-unicode-"));
      try {
        const dummySecret = "ALICE_SECRET_KEY_12345";
        const rpcUrl = `https://solana-rpc.example.com/?api-key=${dummySecret}`;

        const mockFetch = async (): Promise<Response> => {
          // Upstream reflects the credential with its first char 'A' encoded as \u0041
          const reflectedWireJson =
            '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid access with credentials api-key=\\u0041LICE_SECRET_KEY_12345 for requested method"}}';
          return new Response(reflectedWireJson, { status: 200 });
        };

        const result = await acquireRaydiumAmmV4Snapshot({
          rpcUrl,
          poolId: FIXTURE_POOL_ADDRESS,
          outDir: tempDir,
          fetch: mockFetch as typeof fetch,
        });

        expect(result.ok).toBe(false);
        expect(result.httpAttempts).toBe(1);

        const reqRecord = result.evidence.requests[0]!;
        expect(reqRecord.wasRedacted).toBe(true);

        // Verify wire digest vs stored digest distinction
        expect(reqRecord.wireResponseSha256).toBeDefined();
        expect(reqRecord.storedResponseSha256).toBeDefined();
        expect(reqRecord.wireResponseSha256).not.toBe(reqRecord.storedResponseSha256);

        // Raw body and decoded parsedJson must not contain secret in plain or escaped form
        expect(reqRecord.rawResponseBody).not.toContain(dummySecret);
        expect(reqRecord.rawResponseBody).not.toContain("\\u0041LICE");
        expect(reqRecord.rawResponseBody).toContain("[REDACTED]");

        const parsedJsonStr = JSON.stringify(reqRecord.parsedJson);
        expect(parsedJsonStr).not.toContain(dummySecret);
        expect(parsedJsonStr).toContain("[REDACTED]");

        expect(result.evidence.failureReason).not.toContain(dummySecret);
        expect(result.evidence.failureReason).toContain("[REDACTED]");

        // Verify serialized public evidence
        const serialized = serializeJsonPreservingBigInts(result.evidence);
        expect(serialized).not.toContain(dummySecret);
        expect(serialized).not.toContain("\\u0041LICE");

        // Verify written evidence file on disk
        const writtenEvidence = await fs.readFile(
          result.evidence.artifacts!.evidenceFilePath,
          "utf8",
        );
        expect(writtenEvidence).not.toContain(dummySecret);
        expect(writtenEvidence).not.toContain("\\u0041LICE");

        // Verify written manifest file on disk
        const writtenManifest = await fs.readFile(
          result.evidence.artifacts!.manifestFilePath,
          "utf8",
        );
        expect(writtenManifest).not.toContain(dummySecret);
        expect(writtenManifest).not.toContain("\\u0041LICE");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("2. Argument & Numeric Configuration Validation", () => {
    it("rejects unknown CLI option spellings (such as --dryRun) with exit code 1 and 0 fetch calls", async () => {
      let fetchCalls = 0;
      const mockFetch = async (): Promise<Response> => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      };

      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch as typeof fetch;
        const exitCode = await runCli(["--dryRun", "--rpc-url=https://solana-rpc.example.com"]);
        expect(exitCode).toBe(1);
        expect(fetchCalls).toBe(0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("rejects missing values or option-flags-as-values in CLI parser", () => {
      expect(() => parseCliArgs(["--rpc-url"])).toThrow("requires a value");
      expect(() => parseCliArgs(["--rpc-url", "--dry-run"])).toThrow("received flag '--dry-run'");
      expect(() => parseCliArgs(["--pacing-ms="])).toThrow("non-empty value");
      expect(() => parseCliArgs(["--unknown-flag"])).toThrow(
        "Unrecognized CLI argument: '--unknown-flag'",
      );
    });

    it("strictly validates numeric configurations across API and CLI", () => {
      // Rejects NaN, negative numbers, floats, and strings with non-digits
      expect(() => validateNumericConfig({ pacingMs: "abc" as unknown as number })).toThrow(
        "positive integer",
      );
      expect(() => validateNumericConfig({ pacingMs: -100 })).toThrow("out of allowed range");
      expect(() => validateNumericConfig({ pacingMs: 1200 })).toThrow("out of allowed range"); // < 2500
      expect(() => validateNumericConfig({ pacingMs: 2500.5 })).toThrow("safe finite integer");
      expect(() => validateNumericConfig({ overallTimeoutMs: 70000 })).toThrow(
        "out of allowed range",
      ); // > 60000
      expect(() => validateNumericConfig({ overallTimeoutMs: 2500, pacingMs: 3000 })).toThrow(
        "cannot be less than pacingMs",
      );

      // Valid configuration parses correctly
      const valid = validateNumericConfig({
        pacingMs: 2500,
        timeoutMs: 5000,
        overallTimeoutMs: 15000,
      });
      expect(valid).toEqual({ pacingMs: 2500, timeoutMs: 5000, overallTimeoutMs: 15000 });
    });
  });

  describe("3. Deadline Enforcement & Attempt Accounting", () => {
    it("terminates without dispatching Request 2 when remaining budget is less than host pacing (prevents 70s accounting mismatch)", async () => {
      const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
      });

      let fetchInvocations = 0;
      const mockFetch = async (): Promise<Response> => {
        fetchInvocations++;
        // Request 1 succeeds
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [poolBuf.toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      let simulatedTime = 1000;

      // Overall ceiling = 3000ms.
      // Request 1 finishes at elapsed = 1000ms (clock advances from 1000 to 2000).
      // Remaining budget before pacing is 1000ms (< 2500ms pacing requirement).
      const config: SnapshotAcquisitionConfig = {
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        pacingMs: 2500,
        overallTimeoutMs: 3000,
        fetch: mockFetch as typeof fetch,
        clock: () => {
          simulatedTime += 500;
          return new Date(simulatedTime);
        },
        sleeper: async () => {},
      };

      const result = await acquireRaydiumAmmV4Snapshot(config);

      expect(result.ok).toBe(false);
      // Crucial requirement: only 1 fetch invocation occurred, so httpAttempts must be strictly 1 (NOT 2)
      expect(result.httpAttempts).toBe(1);
      expect(fetchInvocations).toBe(1);
      expect(result.evidence.requests.length).toBe(1);
      expect(result.evidence.failureReason).toContain("DEADLINE_EXCEEDED");
    });

    it("terminates with 0 attempts if acquisition deadline is reached before Request 1 dispatch", async () => {
      let fetchInvocations = 0;
      const mockFetch = async (): Promise<Response> => {
        fetchInvocations++;
        return new Response("{}", { status: 200 });
      };

      let timeMs = 10000;
      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        overallTimeoutMs: 2500,
        clock: () => {
          timeMs += 3000; // Instantly exceeds deadline
          return new Date(timeMs);
        },
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(0);
      expect(fetchInvocations).toBe(0);
      expect(result.evidence.failureReason).toContain(
        "deadline reached before getAccountInfo dispatch",
      );
    });
  });

  describe("4. Evidence Sealing & Separate Manifest Verification", () => {
    it("writes finalized evidence bytes, records exact SHA-256 and size in manifest, and verifies match", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-seal-test-"));

      try {
        const batchAccounts = createTestBatchAccounts({
          lpReserve: 1_000_000_000n,
          lpSupply: 49_000_000n,
        });

        let callCount = 0;
        const mockFetch = async (): Promise<Response> => {
          callCount++;
          if (callCount === 1) {
            return new Response(
              JSON.stringify(
                buildRpcResponse(
                  {
                    data: [batchAccounts[0]!.data, "base64"],
                    owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  },
                  312500100,
                  1,
                ),
              ),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                batchAccounts.map((a) => ({ data: [a.data, "base64"], owner: a.owner })),
                312500105,
                2,
              ),
            ),
            { status: 200 },
          );
        };

        const result = await acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          expectedTokenMint: FIXTURE_MEME_MINT,
          outDir: tempDir,
          fetch: mockFetch as typeof fetch,
          sleeper: async () => {},
        });

        expect(result.ok).toBe(true);
        expect(result.manifest).toBeDefined();
        expect(result.evidence.artifacts).toBeDefined();

        const artifacts = result.evidence.artifacts!;
        const manifest = result.manifest!;

        // 1. Read the written evidence file independently from disk
        const writtenEvidenceBytes = await fs.readFile(artifacts.evidenceFilePath);
        const actualEvidenceSha256 = crypto
          .createHash("sha256")
          .update(writtenEvidenceBytes)
          .digest("hex");
        const actualEvidenceSize = writtenEvidenceBytes.length;

        // Verify exact match with manifest entries
        expect(actualEvidenceSha256).toBe(manifest.evidenceFileSha256);
        expect(actualEvidenceSha256).toBe(artifacts.evidenceFileSha256);
        expect(actualEvidenceSize).toBe(manifest.evidenceByteSize);
        expect(actualEvidenceSize).toBe(artifacts.evidenceByteSize);

        // 2. Read the written manifest file independently from disk
        const writtenManifestBytes = await fs.readFile(artifacts.manifestFilePath);
        const actualManifestSha256 = crypto
          .createHash("sha256")
          .update(writtenManifestBytes)
          .digest("hex");
        expect(actualManifestSha256).toBe(artifacts.manifestFileSha256);

        // 3. Verify manifest contents
        expect(manifest.manifestVersion).toBe("1.0");
        expect(manifest.manifestType).toBe("RAYDIUM_AMM_V4_SNAPSHOT_MANIFEST");
        expect(manifest.status).toBe("SUCCESS");
        expect(manifest.poolId).toBe(FIXTURE_POOL_ADDRESS);
        expect(manifest.httpAttempts).toBe(2);
        expect(manifest.payloadDigestSha256).toBe(result.evidence.payloadDigestSha256);
        expect(manifest.outcomes.meetsNinetyPercentThreshold).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("seals partial evidence and manifest when acquisition is interrupted on Request 2", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-seal-partial-"));

      try {
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
          baseMintBase58: FIXTURE_MEME_MINT,
          quoteMintBase58: FIXTURE_WSOL_MINT,
        });

        let callCount = 0;
        const mockFetch = async (): Promise<Response> => {
          callCount++;
          if (callCount === 1) {
            return new Response(
              JSON.stringify(
                buildRpcResponse(
                  {
                    data: [poolBuf.toString("base64"), "base64"],
                    owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  },
                  312500100,
                  1,
                ),
              ),
              { status: 200 },
            );
          }
          // Request 2 fails with 503
          return new Response("Service Unavailable", { status: 503 });
        };

        const result = await acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          expectedTokenMint: FIXTURE_MEME_MINT,
          outDir: tempDir,
          fetch: mockFetch as typeof fetch,
          sleeper: async () => {},
        });

        expect(result.ok).toBe(false);
        expect(result.httpAttempts).toBe(2);
        expect(result.manifest).toBeDefined();
        expect(result.manifest?.status).toBe("RETRIEVAL_FAILED");

        // Verify partial evidence file was saved and matches manifest
        const evidenceBytes = await fs.readFile(result.evidence.artifacts!.evidenceFilePath);
        const actualSha256 = crypto.createHash("sha256").update(evidenceBytes).digest("hex");
        expect(actualSha256).toBe(result.manifest?.evidenceFileSha256);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("seals partial evidence and manifest when pacing is interrupted by rejected sleeper", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-seal-pacing-fail-"));

      try {
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
          baseMintBase58: FIXTURE_MEME_MINT,
          quoteMintBase58: FIXTURE_WSOL_MINT,
        });

        let fetchCalls = 0;
        const mockFetch = async (): Promise<Response> => {
          fetchCalls++;
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                {
                  data: [poolBuf.toString("base64"), "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
                312500100,
                1,
              ),
            ),
            { status: 200 },
          );
        };

        const result = await acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          expectedTokenMint: FIXTURE_MEME_MINT,
          outDir: tempDir,
          fetch: mockFetch as typeof fetch,
          sleeper: async () => {
            throw new Error("Pacing aborted: simulated sleeper rejection");
          },
        });

        expect(result.ok).toBe(false);
        // Crucial requirement: only Request 1 was dispatched; Request 2 was never called!
        expect(result.httpAttempts).toBe(1);
        expect(fetchCalls).toBe(1);

        expect(result.evidence.failureReason).toContain("PACING_INTERRUPTED");
        expect(result.evidence.failureReason).toContain("simulated sleeper rejection");
        expect(result.evidence.pacingEnforcedMs).toBeNull();
        expect(result.evidence.requests.length).toBe(1);

        expect(result.manifest).toBeDefined();
        expect(result.manifest?.status).toBe("RETRIEVAL_FAILED");
        expect(result.manifest?.httpAttempts).toBe(1);

        // Independently read and verify evidence file hash and byte size
        const writtenEvidenceBytes = await fs.readFile(result.evidence.artifacts!.evidenceFilePath);
        const actualEvidenceSha256 = crypto
          .createHash("sha256")
          .update(writtenEvidenceBytes)
          .digest("hex");
        expect(actualEvidenceSha256).toBe(result.manifest?.evidenceFileSha256);
        expect(writtenEvidenceBytes.length).toBe(result.manifest?.evidenceByteSize);

        // Independently read and verify manifest file on disk
        const writtenManifestBytes = await fs.readFile(result.evidence.artifacts!.manifestFilePath);
        const actualManifestSha256 = crypto
          .createHash("sha256")
          .update(writtenManifestBytes)
          .digest("hex");
        expect(actualManifestSha256).toBe(result.evidence.artifacts!.manifestFileSha256);
        const parsedManifest = JSON.parse(writtenManifestBytes.toString("utf8"));
        expect(parsedManifest.status).toBe("RETRIEVAL_FAILED");
        expect(parsedManifest.httpAttempts).toBe(1);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("fails closed when storage write fails and sets result.ok to false", async () => {
      // Provide an invalid unwritable path (e.g. attempting to create a file inside an existing file)
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexustrade-seal-fail-"));
      const blockingFile = path.join(tempDir, "blocking-file");
      await fs.writeFile(blockingFile, "not a directory");
      const impossibleOutDir = path.join(blockingFile, "sub-dir");

      try {
        const batchAccounts = createTestBatchAccounts();
        let callCount = 0;
        const mockFetch = async (): Promise<Response> => {
          callCount++;
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                callCount === 1
                  ? { data: [batchAccounts[0]!.data, "base64"], owner: RAYDIUM_AMM_V4_PROGRAM_ID }
                  : batchAccounts.map((a) => ({ data: [a.data, "base64"], owner: a.owner })),
                312500100,
                callCount,
              ),
            ),
            { status: 200 },
          );
        };

        const result = await acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          expectedTokenMint: FIXTURE_MEME_MINT,
          outDir: impossibleOutDir,
          fetch: mockFetch as typeof fetch,
          sleeper: async () => {},
        });

        expect(result.ok).toBe(false);
        expect(result.evidence.failureReason).toContain("EVIDENCE_STORAGE_FAILED");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("5. Provenance Preservation", () => {
    it("dry-run represents a plan with null evidence and null retrieval timestamps", async () => {
      const result = await acquireRaydiumAmmV4Snapshot({
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        dryRun: true,
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.evidence.executionMode).toBe("DRY_RUN");
      expect(result.evidence.evidenceOrigin).toBeNull();
      expect(result.evidence.isSyntheticFixture).toBeNull();
      expect(result.evidence.retrievedAtIso).toBeNull();
      expect(result.evidence.requests.length).toBe(0);
      expect(result.evidence.httpAttempts).toBe(0);
    });

    it("defaults unmarked injected transports to UNKNOWN and null synthetic fixture throughout evidence and diagnostics", async () => {
      const batchAccounts = createTestBatchAccounts();
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              callCount === 1
                ? { data: [batchAccounts[0]!.data, "base64"], owner: RAYDIUM_AMM_V4_PROGRAM_ID }
                : batchAccounts.map((a) => ({ data: [a.data, "base64"], owner: a.owner })),
              312500100,
              callCount,
            ),
          ),
          { status: 200 },
        );
      };

      // Injected transport WITHOUT provenance declarations
      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        fetch: mockFetch as typeof fetch,
        sleeper: async () => {},
      });

      expect(result.ok).toBe(true);
      expect(result.evidence.evidenceOrigin).toBe("UNKNOWN");
      expect(result.evidence.isSyntheticFixture).toBeNull();

      const valDiag = (
        result.evidence.validationResult as {
          ok: true;
          diagnostics: { evidenceOrigin: string; isSyntheticFixture: boolean | null };
        }
      ).diagnostics;
      expect(valDiag.evidenceOrigin).toBe("UNKNOWN");
      expect(valDiag.isSyntheticFixture).toBeNull();
    });

    it("propagates explicit SYNTHETIC_FIXTURE provenance into nested validation diagnostics without defaulting to CAPTURED_RPC", async () => {
      const batchAccounts = createTestBatchAccounts();
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              callCount === 1
                ? { data: [batchAccounts[0]!.data, "base64"], owner: RAYDIUM_AMM_V4_PROGRAM_ID }
                : batchAccounts.map((a) => ({ data: [a.data, "base64"], owner: a.owner })),
              312500100,
              callCount,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        evidenceOrigin: "SYNTHETIC_FIXTURE",
        isSyntheticFixture: true,
        fetch: mockFetch as typeof fetch,
        sleeper: async () => {},
      });

      expect(result.ok).toBe(true);
      expect(result.evidence.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");
      expect(result.evidence.isSyntheticFixture).toBe(true);

      const valDiag = (
        result.evidence.validationResult as {
          ok: true;
          diagnostics: { evidenceOrigin: string; isSyntheticFixture: boolean };
        }
      ).diagnostics;
      expect(valDiag.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");
      expect(valDiag.isSyntheticFixture).toBe(true);
    });

    it("rejects invalid or contradictory provenance declarations before any request dispatch with zero fetch calls", async () => {
      let fetchCalls = 0;
      const mockFetch = async (): Promise<Response> => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      };

      // 1. Invalid origin membership
      await expect(
        acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          evidenceOrigin: "INVALID_ORIGIN" as unknown as "CAPTURED_RPC",
          fetch: mockFetch as typeof fetch,
        }),
      ).rejects.toThrow("INVALID_PROVENANCE_METADATA");
      expect(fetchCalls).toBe(0);

      // 2. Contradiction: CAPTURED_RPC with isSyntheticFixture = true
      await expect(
        acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          evidenceOrigin: "CAPTURED_RPC",
          isSyntheticFixture: true,
          fetch: mockFetch as typeof fetch,
        }),
      ).rejects.toThrow("INVALID_PROVENANCE_METADATA");
      expect(fetchCalls).toBe(0);

      // 3. Contradiction: SYNTHETIC_FIXTURE with isSyntheticFixture = false
      await expect(
        acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          evidenceOrigin: "SYNTHETIC_FIXTURE",
          isSyntheticFixture: false,
          fetch: mockFetch as typeof fetch,
        }),
      ).rejects.toThrow("INVALID_PROVENANCE_METADATA");
      expect(fetchCalls).toBe(0);

      // 4. Contradiction: UNKNOWN with isSyntheticFixture = true
      await expect(
        acquireRaydiumAmmV4Snapshot({
          rpcUrl: "https://solana-rpc.example.com",
          poolId: FIXTURE_POOL_ADDRESS,
          evidenceOrigin: "UNKNOWN",
          isSyntheticFixture: true,
          fetch: mockFetch as typeof fetch,
        }),
      ).rejects.toThrow("INVALID_PROVENANCE_METADATA");
      expect(fetchCalls).toBe(0);
    });

    it("preserves null retrievedAtIso when Request 1 fails before response", async () => {
      const mockFetch = async (): Promise<Response> => {
        throw new Error("DNS resolution failed");
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.evidence.retrievedAtIso).toBeNull();
      expect(result.evidence.completedAtIso).toBeDefined();
    });
  });

  describe("Bootstrap Failure Termination after Attempt 1", () => {
    it("terminates after 1 attempt when bootstrap account is null (not found)", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response(JSON.stringify(buildRpcResponse(null, 312500100, 1)), { status: 200 });
      };

      const pacedSleeps: number[] = [];
      const mockSleeper = async (ms: number) => {
        pacedSleeps.push(ms);
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
        sleeper: mockSleeper,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(pacedSleeps.length).toBe(0);
      expect(result.evidence.outcomes.retrievalOk).toBe(false);
      expect(result.evidence.failureReason).toContain("was not found on-chain");
    });

    it("terminates after 1 attempt when bootstrap account owner is unauthorized", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer();
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [poolBuf.toString("base64"), "base64"],
                owner: "11111111111111111111111111111111",
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("Bootstrap pool account owner mismatch");
    });

    it("terminates after 1 attempt when bootstrap account layout length is corrupted", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const truncatedBuf = Buffer.alloc(500);
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [truncatedBuf.toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("Bootstrap pool layout length mismatch");
    });

    it("terminates after 1 attempt when bootstrap pool is not paired with WSOL", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
          baseMintBase58: FIXTURE_MEME_MINT,
          quoteMintBase58: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        });
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [poolBuf.toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("Bootstrap pool is not paired with WSOL");
    });

    it("terminates after 1 attempt when expected token mint does not match discovered pool token mint", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
          baseMintBase58: FIXTURE_MEME_MINT,
          quoteMintBase58: FIXTURE_WSOL_MINT,
        });
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [poolBuf.toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("Bootstrap token mint mismatch");
    });

    it("terminates after 1 attempt when bootstrap data contains invalid Base64", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer();
        const corruptedBase64 = poolBuf.toString("base64") + "!";
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [corruptedBase64, "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("invalid or non-canonical Base64");
    });

    it("terminates after 1 attempt when bootstrap pool status is 0 (Uninitialized)", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({ status: 0n });
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              {
                data: [poolBuf.toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              },
              312500100,
              1,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("pool status is invalid or uninitialized");
    });
  });

  describe("Slot Integrity and Reference Preservation", () => {
    it("rejects stale final context slot (slot < minContextSlot)", async () => {
      const batchAccounts = createTestBatchAccounts();
      const bootstrapAccountData = batchAccounts[0]!.data;

      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                {
                  data: [bootstrapAccountData, "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
                312500200,
                1,
              ),
            ),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify(
            buildRpcResponse(
              batchAccounts.map((acc) => ({
                data: [acc.data, "base64"],
                owner: acc.owner,
              })),
              312500199,
              2,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        fetch: mockFetch as typeof fetch,
        sleeper: async () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(2);
      expect(result.evidence.contextSlots.staleSlotDetected).toBe(true);
      expect(result.evidence.failureReason).toContain("Stale batch context slot");
    });

    it("rejects batch when pool account in final batch has changed references from bootstrap", async () => {
      const batchAccounts = createTestBatchAccounts();
      const bootstrapAccountData = batchAccounts[0]!.data;

      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify(
              buildRpcResponse(
                {
                  data: [bootstrapAccountData, "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
                312500100,
                1,
              ),
            ),
            { status: 200 },
          );
        }

        const mutatedAccounts = createTestBatchAccounts({
          poolLpMint: "So11111111111111111111111111111111111111114",
        });

        return new Response(
          JSON.stringify(
            buildRpcResponse(
              mutatedAccounts.map((acc) => ({
                data: [acc.data, "base64"],
                owner: acc.owner,
              })),
              312500105,
              2,
            ),
          ),
          { status: 200 },
        );
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        fetch: mockFetch as typeof fetch,
        sleeper: async () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(2);
      expect(result.evidence.outcomes.structuralValidationOk).toBe(false);
      expect(result.evidence.failureReason).toContain("POOL_REFERENCE_MISMATCH");
    });
  });

  describe("Serialization & Authority Derivation", () => {
    it("serializes BigInt values accurately as decimal strings", () => {
      const dataWithBigInts = {
        poolId: FIXTURE_POOL_ADDRESS,
        lpReserve: 316227766016n,
        lpSupply: 49000000n,
        safeSlot: 312500100,
      };

      const serialized = serializeJsonPreservingBigInts(dataWithBigInts);
      expect(serialized).toContain('"lpReserve": "316227766016"');
      expect(serialized).toContain('"lpSupply": "49000000"');
      expect(serialized).toContain('"safeSlot": 312500100');

      const parsed = JSON.parse(serialized);
      expect(parsed.lpReserve).toBe("316227766016");
      expect(parsed.lpSupply).toBe("49000000");
    });

    it("derives canonical AMM authority bump 254 and address", async () => {
      const result = await acquireRaydiumAmmV4Snapshot({
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        dryRun: true,
      });

      expect(result.evidence.canonicalAmmAuthority.address).toBe(CANONICAL_AMM_AUTHORITY);
      expect(result.evidence.canonicalAmmAuthority.bump).toBe(CANONICAL_AMM_BUMP);
    });
  });

  describe("CLI Entrypoint Validation", () => {
    it("runs CLI dry-run successfully and returns exit code 0", async () => {
      const exitCode = await runCli(["--dry-run", `--pool-id=${FIXTURE_POOL_ADDRESS}`]);
      expect(exitCode).toBe(0);
    });

    it("rejects execution without rpc-url when not in dry-run mode and returns exit code 1", async () => {
      const exitCode = await runCli([`--pool-id=${FIXTURE_POOL_ADDRESS}`]);
      expect(exitCode).toBe(1);
    });

    it("displays help and returns exit code 0", async () => {
      const exitCode = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    });
  });
});
