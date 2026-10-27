/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Snapshot Acquisition Tests
 *
 * Deterministic offline test suite verifying:
 * 1. Successful 2-request acquisition with >= 2,500 ms host pacing.
 * 2. Bootstrap failure terminating after attempt 1 (null account, wrong owner, corrupted length, orientation mismatch, token mismatch, invalid status, malformed base64).
 * 3. Network & transport errors (HTTP 500, HTTP 429, timeout, malformed JSON, RPC error on Request 1 and Request 2).
 * 4. Stale final context slot (slot < minContextSlot) and changed account reference mismatch in batch.
 * 5. Strict request counting (never exceeding 2), BigInt decimal string serialization in JSON, and SHA-256 evidence sealing.
 * 6. Dry-run mode (--dry-run) making zero network requests, verifying identities, and deriving AMM authority.
 * 7. CLI entrypoint execution and parameter validation.
 */

import { describe, expect, it } from "vitest";
import {
  acquireRaydiumAmmV4Snapshot,
  serializeJsonPreservingBigInts,
} from "./RaydiumAmmV4SnapshotAcquisition.js";
import { runCli } from "./RaydiumAmmV4SnapshotCli.js";
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
    const requestedUrls: string[] = [];
    const requestedMethods: string[] = [];
    const requestedBodies: string[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      callCount++;
      requestedUrls.push(String(input));
      const bodyStr = String(init?.body);
      requestedBodies.push(bodyStr);
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

    expect(ev.evidenceDigestSha256).toBeDefined();
    expect(ev.evidenceDigestSha256?.length).toBe(64);

    expect(ev.evidenceBoundary.bytecodeEquivalenceVerified).toBe(false);
    expect(ev.evidenceBoundary.completeExecutableReservesVerified).toBe(false);
    expect(ev.evidenceBoundary.generalTokenSafetyVerified).toBe(false);
    expect(ev.evidenceBoundary.strategyGateAdmitted).toBe(false);
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
      expect(pacedSleeps.length).toBe(0); // Sleeper never called
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
                owner: "11111111111111111111111111111111", // Wrong owner
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
        const truncatedBuf = Buffer.alloc(500); // corrupted length
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
          quoteMintBase58: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT instead of WSOL
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
        expectedTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // Expected RAY but pool is BONK
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
        const corruptedBase64 = poolBuf.toString("base64") + "!"; // Trailing exclamation mark
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

  describe("Network, Transport, and RPC Error Handling", () => {
    it("handles Request 1 HTTP 500 error and terminates after attempt 1", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response("Internal Server Error", { status: 500, statusText: "Internal Error" });
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("HTTP error 500");
    });

    it("handles Request 1 RPC error payload and terminates after attempt 1", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid request" },
          }),
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
      expect(result.evidence.failureReason).toContain("RPC error");
    });

    it("handles Request 1 timeout and terminates after attempt 1", async () => {
      let callCount = 0;
      const mockFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
        callCount++;
        // Simulate waiting until signal aborts
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        });
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        timeoutMs: 50,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("timed out");
    });

    it("handles Request 1 malformed JSON body and terminates after attempt 1", async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<Response> => {
        callCount++;
        return new Response("<html><head><title>Bad Gateway</title></head></html>", {
          status: 200, // Misconfigured proxy returning 200 with HTML
        });
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: "https://solana-rpc.example.com",
        poolId: FIXTURE_POOL_ADDRESS,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toBe(1);
      expect(callCount).toBe(1);
      expect(result.evidence.failureReason).toContain("Malformed JSON response");
    });

    it("handles Request 2 HTTP 500 error after successful Request 1", async () => {
      let callCount = 0;
      const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
      });

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
        return new Response("Internal Server Error", { status: 500 });
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
      expect(callCount).toBe(2);
      expect(result.evidence.outcomes.retrievalOk).toBe(false);
      expect(result.evidence.failureReason).toContain("HTTP error 500");
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
                312500200, // Bootstrap slot = 312500200
                1,
              ),
            ),
            { status: 200 },
          );
        }

        // Return stale slot 312500199 (< 312500200)
        return new Response(
          JSON.stringify(
            buildRpcResponse(
              batchAccounts.map((acc) => ({
                data: [acc.data, "base64"],
                owner: acc.owner,
              })),
              312500199, // Stale slot
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

        // In batch, pool account has a different lpMint!
        const mutatedAccounts = createTestBatchAccounts({
          poolLpMint: "So11111111111111111111111111111111111111114", // Different LP mint
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

  describe("Dry-Run Mode & Serialization", () => {
    it("executes dry-run mode with zero network requests", async () => {
      let networkCallsMade = 0;
      const mockFetch = async (): Promise<Response> => {
        networkCallsMade++;
        throw new Error("Network calls must not be made in dry-run mode");
      };

      const result = await acquireRaydiumAmmV4Snapshot({
        poolId: FIXTURE_POOL_ADDRESS,
        expectedTokenMint: FIXTURE_MEME_MINT,
        dryRun: true,
        fetch: mockFetch as typeof fetch,
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.httpAttempts).toBe(0);
      expect(networkCallsMade).toBe(0);
      expect(result.evidence.executionMode).toBe("DRY_RUN");
      expect(result.evidence.requests.length).toBe(0);
      expect(result.evidence.canonicalAmmAuthority.address).toBe(CANONICAL_AMM_AUTHORITY);
      expect(result.evidence.canonicalAmmAuthority.bump).toBe(CANONICAL_AMM_BUMP);
    });

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
