/**
 * Phase 12.94-D Milestone D.3.3: Raydium AMM v4 Offline Snapshot Validator Tests
 *
 * Deterministic offline tests verifying:
 * 1. Authority derivation using @solana/web3.js (address + bump) and cache mutation protection.
 * 2. Pool stored nonce binding at byte offset 8 (rejection of inconsistent nonces, acceptance of coherent bump).
 * 3. Provenance preservation: missing provenance represented as UNKNOWN (never defaulted to captured RPC),
 *    missing retrieval timestamps remain null (never substituted), valid timestamps preserved, invalid timestamps rejected.
 * 4. Defensive copying of requested identities against post-validation caller mutation.
 * 5. Rejection of 33-byte public keys ("1".repeat(33)) via canonical 32-byte round-trip checks.
 * 6. Rejection of malformed Base64 data (e.g. valid Base64 with '!' appended) via strict syntax and canonical checks.
 * 7. Rejection of unsafe integer slots (context.slot = Number.MAX_SAFE_INTEGER + 1).
 * 8. Positive control snapshot validation and accounting thresholds (Genesis unminted min vs 95% burned LP).
 * 9. Vault status checks (accountState === 1, rejection of uninitialized or frozen vaults).
 * 10. Strict evidence boundary (all four assurance fields statically false, digests computed).
 */

import { describe, expect, it } from "vitest";
import {
  deriveRaydiumAmmAuthority,
  validateRaydiumAmmV4Snapshot,
  RAYDIUM_AMM_AUTHORITY_SEED,
  type RaydiumAmmV4SnapshotIdentities,
} from "./RaydiumAmmV4SnapshotValidator.js";
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

const STANDARD_IDENTITIES: RaydiumAmmV4SnapshotIdentities = {
  poolId: FIXTURE_POOL_ADDRESS,
  lpMint: FIXTURE_LP_MINT,
  baseVault: FIXTURE_BASE_VAULT,
  quoteVault: FIXTURE_QUOTE_VAULT,
  expectedTokenMint: FIXTURE_MEME_MINT,
};

function buildRpcPayload(
  accounts: ({
    data: string;
    owner: string;
  } | null)[],
  slot: number = 312500123,
) {
  return {
    jsonrpc: "2.0",
    result: {
      context: { slot },
      value: accounts.map((acc) =>
        acc === null
          ? null
          : {
              data: [acc.data, "base64"],
              owner: acc.owner,
              lamports: 1_000_000_000,
              executable: false,
              rentEpoch: 0,
            },
      ),
    },
    id: 1,
  };
}

function createValidBatchAccounts(
  overrides: {
    poolNonce?: bigint;
    lpReserve?: bigint;
    lpSupply?: bigint;
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    baseVaultAmount?: bigint;
    quoteVaultAmount?: bigint;
    baseVaultOwner?: string;
    quoteVaultOwner?: string;
    baseVaultMint?: string;
    quoteVaultMint?: string;
    baseVaultState?: number;
    quoteVaultState?: number;
    poolLpMint?: string;
    poolBaseVault?: string;
    poolQuoteVault?: string;
    poolBaseMint?: string;
    poolQuoteMint?: string;
    poolOwner?: string;
    lpMintOwner?: string;
    baseVaultAccountOwner?: string;
    quoteVaultAccountOwner?: string;
  } = {},
) {
  const poolBuf = createAuthoritativeRaydiumAmmV4Buffer({
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
    mintAuthorityBase58:
      overrides.mintAuthority !== undefined ? overrides.mintAuthority : CANONICAL_AMM_AUTHORITY,
    freezeAuthorityBase58:
      overrides.freezeAuthority !== undefined ? overrides.freezeAuthority : CANONICAL_AMM_AUTHORITY,
  });

  const baseVaultBuf = createAuthoritativeSplVaultBuffer({
    mintBase58: overrides.baseVaultMint ?? overrides.poolBaseMint ?? FIXTURE_MEME_MINT,
    ownerBase58: overrides.baseVaultOwner ?? CANONICAL_AMM_AUTHORITY,
    rawAmount: overrides.baseVaultAmount ?? 50_000_000_000n,
    state: overrides.baseVaultState ?? 1,
  });

  const quoteVaultBuf = createAuthoritativeSplVaultBuffer({
    mintBase58: overrides.quoteVaultMint ?? overrides.poolQuoteMint ?? FIXTURE_WSOL_MINT,
    ownerBase58: overrides.quoteVaultOwner ?? CANONICAL_AMM_AUTHORITY,
    rawAmount: overrides.quoteVaultAmount ?? 100_000_000_000n,
    state: overrides.quoteVaultState ?? 1,
  });

  return [
    { data: poolBuf.toString("base64"), owner: overrides.poolOwner ?? RAYDIUM_AMM_V4_PROGRAM_ID },
    { data: lpMintBuf.toString("base64"), owner: overrides.lpMintOwner ?? SPL_TOKEN_PROGRAM_ID },
    {
      data: baseVaultBuf.toString("base64"),
      owner: overrides.baseVaultAccountOwner ?? SPL_TOKEN_PROGRAM_ID,
    },
    {
      data: quoteVaultBuf.toString("base64"),
      owner: overrides.quoteVaultAccountOwner ?? SPL_TOKEN_PROGRAM_ID,
    },
  ];
}

describe("RaydiumAmmV4SnapshotValidator - Phase 12.94-D Milestone D.3.3", () => {
  describe("1. Authority Derivation & Cache Mutation Protection", () => {
    it("derives the canonical AMM authority address and bump from the program ID", async () => {
      const derived = await deriveRaydiumAmmAuthority(RAYDIUM_AMM_V4_PROGRAM_ID);
      expect(derived.address).toBe(CANONICAL_AMM_AUTHORITY);
      expect(derived.bump).toBe(CANONICAL_AMM_BUMP);
      expect(Object.isFrozen(derived)).toBe(true);
    });

    it("uses 'amm authority' as the canonical seed", () => {
      expect(RAYDIUM_AMM_AUTHORITY_SEED).toBe("amm authority");
    });

    it("protects cached authority from caller mutation", async () => {
      const first = await deriveRaydiumAmmAuthority(RAYDIUM_AMM_V4_PROGRAM_ID);

      // Attempt mutating the returned authority object
      expect(() => {
        // @ts-expect-error - testing caller mutation attempt
        first.address = "HackedAddress1111111111111111111111111111";
      }).toThrow();

      // Subsequent call must return the untouched canonical authority
      const second = await deriveRaydiumAmmAuthority(RAYDIUM_AMM_V4_PROGRAM_ID);
      expect(second.address).toBe(CANONICAL_AMM_AUTHORITY);
      expect(second.bump).toBe(CANONICAL_AMM_BUMP);
    });

    it("ensures returned diagnostics authority cannot be mutated to poison subsequent validations", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(Object.isFrozen(result.diagnostics.derivedAmmAuthority)).toBe(true);
      expect(() => {
        // @ts-expect-error - testing diagnostic mutation attempt
        result.diagnostics.derivedAmmAuthority.address =
          "HackedAddress1111111111111111111111111111";
      }).toThrow();

      // Subsequent validation is unaffected
      const secondResult = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(secondResult.ok).toBe(true);
      if (!secondResult.ok) return;
      expect(secondResult.diagnostics.derivedAmmAuthority.address).toBe(CANONICAL_AMM_AUTHORITY);
    });
  });

  describe("2. Pool Stored Nonce Consistency", () => {
    it("accepts a pool with stored nonce matching the derived AMM authority bump (254)", async () => {
      const accounts = createValidBatchAccounts({ poolNonce: 254n });
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(true);
    });

    it("rejects a pool with an uninitialized or zero stored nonce", async () => {
      const accounts = createValidBatchAccounts({ poolNonce: 0n });
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INCONSISTENT_POOL_NONCE");
      expect(result.message).toContain(
        "Pool stored nonce (0) is inconsistent with derived AMM authority bump (254)",
      );
      expect(result.accountIndex).toBe(0);
      expect(result.accountAddress).toBe(FIXTURE_POOL_ADDRESS);
    });

    it("rejects a pool with a non-canonical bump nonce (e.g. 253)", async () => {
      const accounts = createValidBatchAccounts({ poolNonce: 253n });
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INCONSISTENT_POOL_NONCE");
      expect(result.message).toContain(
        "Pool stored nonce (253) is inconsistent with derived AMM authority bump (254)",
      );
    });
  });

  describe("3. Provenance and Timestamp Integrity", () => {
    it("represents omitted provenance as UNKNOWN and isSyntheticFixture as null (never defaults to captured RPC)", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.evidenceOrigin).toBe("UNKNOWN");
      expect(result.diagnostics.isSyntheticFixture).toBeNull();
      expect(result.diagnostics.retrievedAtIso).toBeNull();
    });

    it("preserves explicit synthetic fixture provenance", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        isSyntheticFixture: true,
        retrievedAtIso: "2026-10-26T21:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");
      expect(result.diagnostics.isSyntheticFixture).toBe(true);
      expect(result.diagnostics.retrievedAtIso).toBe("2026-10-26T21:00:00.000Z");
    });

    it("preserves explicit captured RPC provenance", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        evidenceOrigin: "CAPTURED_RPC",
        retrievedAtIso: "2026-10-26T20:30:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.evidenceOrigin).toBe("CAPTURED_RPC");
      expect(result.diagnostics.isSyntheticFixture).toBe(false);
      expect(result.diagnostics.retrievedAtIso).toBe("2026-10-26T20:30:00.000Z");
    });

    it("leaves missing retrieval timestamp null and does not substitute validation time", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        evidenceOrigin: "CAPTURED_RPC",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.retrievedAtIso).toBeNull();
    });

    it("rejects contradictory provenance fields (e.g. CAPTURED_RPC with isSyntheticFixture=true)", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        evidenceOrigin: "CAPTURED_RPC",
        isSyntheticFixture: true, // Contradicts CAPTURED_RPC!
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
      expect(result.message).toContain("Contradictory provenance options");
    });

    it("rejects contradictory provenance fields (e.g. SYNTHETIC_FIXTURE with isSyntheticFixture=false)", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        evidenceOrigin: "SYNTHETIC_FIXTURE",
        isSyntheticFixture: false, // Contradicts SYNTHETIC_FIXTURE!
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
    });

    it("rejects unsupported evidenceOrigin values at runtime", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        // @ts-expect-error - testing invalid runtime provenance string
        evidenceOrigin: "INVALID",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
      expect(result.message).toContain("Invalid evidenceOrigin: 'INVALID'");
    });

    it("rejects impossible calendar dates (e.g. February 30) that Date.parse normalizes into another month", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        retrievedAtIso: "2026-02-30T21:00:00.000Z", // Impossible date!
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
      expect(result.message).toContain("2026-02-30T21:00:00.000Z");
    });

    it("rejects February 29 in non-leap years (e.g. 2026-02-29)", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        retrievedAtIso: "2026-02-29T21:00:00.000Z", // 2026 is not a leap year!
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
    });

    it("accepts February 29 in leap years (e.g. 2024-02-29)", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        retrievedAtIso: "2024-02-29T21:00:00.000Z", // 2024 is a leap year!
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics.retrievedAtIso).toBe("2024-02-29T21:00:00.000Z");
    });

    it("rejects invalid retrieval timestamps", async () => {
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        retrievedAtIso: "not-a-valid-iso-timestamp",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_PROVENANCE_METADATA");
    });

    it("captures identities at entry so mutating caller object while validation is pending does not affect decoded labels or diagnostics", async () => {
      const mutableIdentities: RaydiumAmmV4SnapshotIdentities = {
        poolId: FIXTURE_POOL_ADDRESS,
        lpMint: FIXTURE_LP_MINT,
        baseVault: FIXTURE_BASE_VAULT,
        quoteVault: FIXTURE_QUOTE_VAULT,
        expectedTokenMint: FIXTURE_MEME_MINT,
      };

      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, 289500100);

      // Start validation asynchronously
      const promise = validateRaydiumAmmV4Snapshot(mutableIdentities, payload);

      // Mutate original object immediately while validation is pending (before awaiting)
      // @ts-expect-error - mutating object for test
      mutableIdentities.baseVault = "MutatedBaseVault111111111111111111111111";
      // @ts-expect-error - mutating object for test
      mutableIdentities.poolId = "MutatedPool11111111111111111111111111111111";

      const result = await promise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Every returned identity and decoded account label must remain consistent with original validated request
      expect(result.diagnostics.requestedIdentities.baseVault).toBe(FIXTURE_BASE_VAULT);
      expect(result.diagnostics.requestedIdentities.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.diagnostics.baseVaultState.vaultAddress).toBe(FIXTURE_BASE_VAULT);
      expect(result.diagnostics.poolState.poolAddress).toBe(FIXTURE_POOL_ADDRESS);
      expect(Object.isFrozen(result.diagnostics.requestedIdentities)).toBe(true);
    });
  });

  describe("4. Rejection of Malformed Identities and Response Data", () => {
    it("rejects 33-byte public keys ('1'.repeat(33)) via canonical 32-byte round-trip verification", async () => {
      const thirtyThreeBytePoolId = "1".repeat(33);
      const malformedIdentities: RaydiumAmmV4SnapshotIdentities = {
        ...STANDARD_IDENTITIES,
        poolId: thirtyThreeBytePoolId,
      };

      const result = await validateRaydiumAmmV4Snapshot(malformedIdentities, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_IDENTITIES");
    });

    it("rejects Base64 account strings with '!' appended before decoding", async () => {
      const accounts = createValidBatchAccounts();
      // Append '!' to the pool account's Base64 data string
      accounts[0] = {
        data: `${accounts[0]!.data}!`,
        owner: RAYDIUM_AMM_V4_PROGRAM_ID,
      };

      const payload = buildRpcPayload(accounts, 289500100);
      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("ACCOUNT_BUFFER_EXTRACTION_FAILED");
      expect(result.accountIndex).toBe(0);
    });

    it("rejects unsafe integer context slots (slot = Number.MAX_SAFE_INTEGER + 1)", async () => {
      const unsafeSlot = Number.MAX_SAFE_INTEGER + 1; // 9007199254740992
      const accounts = createValidBatchAccounts();
      const payload = buildRpcPayload(accounts, unsafeSlot);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_CONTEXT_SLOT");
      expect(result.message).toContain("expected positive safe integer");
    });
  });

  describe("5. Positive Control Snapshot & Threshold Accounting", () => {
    it("validates a control snapshot with >= 90% inaccessible LP (95.1% burn)", async () => {
      const accounts = createValidBatchAccounts({
        lpReserve: 1_000_000_000n,
        lpSupply: 49_000_000n,
      });
      const payload = buildRpcPayload(accounts, 289500100);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload, {
        isSyntheticFixture: true,
        retrievedAtIso: "2026-10-26T21:00:00.000Z",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Accounting outcome
      expect(result.accounting.ok).toBe(true);
      expect(result.accounting.protocolLp).toBe(1_000_000_000n);
      expect(result.accounting.circulatingSupply).toBe(49_000_000n);
      expect(result.accounting.rawInaccessibleLp).toBe(951_000_000n);
      expect(result.accounting.meetsNinetyPercentThreshold).toBe(true);
      expect(result.accounting.displayInaccessiblePct).toBe(95.1);

      // Decoded account states
      expect(result.diagnostics.poolState.poolAddress).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.diagnostics.lpMintState.supply).toBe(49_000_000n);
      expect(result.diagnostics.lpMintState.decimals).toBe(6);
      expect(result.diagnostics.lpMintState.isInitialized).toBe(true);
      expect(result.diagnostics.baseVaultState.rawAmount).toBe(50_000_000_000n);
      expect(result.diagnostics.quoteVaultState.rawAmount).toBe(100_000_000_000n);

      // SHA-256 digests
      expect(result.diagnostics.accountDigests.poolSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.diagnostics.accountDigests.lpMintSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.diagnostics.accountDigests.baseVaultSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.diagnostics.accountDigests.quoteVaultSha256).toMatch(/^[a-f0-9]{64}$/);

      // Strict evidence boundary
      expect(result.evidenceBoundary.bytecodeEquivalenceVerified).toBe(false);
      expect(result.evidenceBoundary.completeExecutableReservesVerified).toBe(false);
      expect(result.evidenceBoundary.generalTokenSafetyVerified).toBe(false);
      expect(result.evidenceBoundary.strategyGateAdmitted).toBe(false);
    });

    it("validates a snapshot with renounced LP mint authority (null)", async () => {
      const accounts = createValidBatchAccounts({
        lpReserve: 1_000_000_000n,
        lpSupply: 49_000_000n,
        mintAuthority: null,
        freezeAuthority: null,
      });
      const payload = buildRpcPayload(accounts, 289500101);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.lpMintState.mintAuthority).toBeNull();
      expect(result.diagnostics.lpMintState.freezeAuthority).toBeNull();
      expect(result.accounting.meetsNinetyPercentThreshold).toBe(true);
    });

    it("correctly identifies unprotected pool at Genesis unminted min (< 90% threshold)", async () => {
      const accounts = createValidBatchAccounts({
        lpReserve: 316_227_766_016n,
        lpSupply: 316_226_766_016n, // diff = 1_000_000n unminted minimum
      });
      const payload = buildRpcPayload(accounts, 289500102);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.meetsNinetyPercentThreshold).toBe(false);
      expect(result.accounting.displayInaccessiblePct).toBeCloseTo(0.000316, 6);
    });

    it("validates an inverted SOL_BASE_TOKEN_QUOTE pair", async () => {
      const accounts = createValidBatchAccounts({
        poolBaseMint: FIXTURE_WSOL_MINT,
        poolQuoteMint: FIXTURE_MEME_MINT,
        baseVaultMint: FIXTURE_WSOL_MINT,
        quoteVaultMint: FIXTURE_MEME_MINT,
      });
      const payload = buildRpcPayload(accounts, 289500103);

      const invertedIdentities: RaydiumAmmV4SnapshotIdentities = {
        ...STANDARD_IDENTITIES,
        expectedTokenMint: FIXTURE_MEME_MINT,
      };

      const result = await validateRaydiumAmmV4Snapshot(invertedIdentities, payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.diagnostics.poolState.baseMint).toBe(FIXTURE_WSOL_MINT);
      expect(result.diagnostics.poolState.quoteMint).toBe(FIXTURE_MEME_MINT);
    });
  });

  describe("6. Negative Structural and Account Validations", () => {
    it("rejects non-object or error JSON-RPC payloads", async () => {
      const errorPayload = {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: 1,
      };
      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, errorPayload);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_RPC_PAYLOAD");
    });

    it("rejects missing, zero, or non-positive context slots", async () => {
      const zeroSlotPayload = buildRpcPayload(createValidBatchAccounts(), 0);
      const resultZero = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, zeroSlotPayload);

      expect(resultZero.ok).toBe(false);
      if (resultZero.ok) return;
      expect(resultZero.category).toBe("INVALID_CONTEXT_SLOT");

      const negativeSlotPayload = buildRpcPayload(createValidBatchAccounts(), -100);
      const resultNeg = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        negativeSlotPayload,
      );

      expect(resultNeg.ok).toBe(false);
      if (resultNeg.ok) return;
      expect(resultNeg.category).toBe("INVALID_CONTEXT_SLOT");
    });

    it("rejects incomplete account batches (fewer or more than 4 accounts)", async () => {
      const accounts = createValidBatchAccounts();
      const incompletePayload = buildRpcPayload(accounts.slice(0, 3), 312500123);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, incompletePayload);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INCOMPLETE_ACCOUNT_BATCH");
      expect(result.slot).toBe(312500123);
    });

    it("rejects missing / null account in batch", async () => {
      const accounts = createValidBatchAccounts();
      const accountsWithNull = [accounts[0]!, accounts[1]!, null, accounts[3]!];
      const payload = buildRpcPayload(accountsWithNull, 312500123);

      const result = await validateRaydiumAmmV4Snapshot(STANDARD_IDENTITIES, payload);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("ACCOUNT_NOT_FOUND");
      expect(result.accountIndex).toBe(2);
      expect(result.accountAddress).toBe(FIXTURE_BASE_VAULT);
    });

    it("rejects unauthorized program owners", async () => {
      // Non-Raydium pool owner
      const badPoolAccounts = createValidBatchAccounts({
        poolOwner: SPL_TOKEN_PROGRAM_ID,
      });
      const resultPool = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(badPoolAccounts),
      );
      expect(resultPool.ok).toBe(false);
      if (!resultPool.ok) {
        expect(resultPool.category).toBe("UNAUTHORIZED_PROGRAM_OWNER");
        expect(resultPool.accountIndex).toBe(0);
      }

      // Non-SPL LP mint owner
      const badMintAccounts = createValidBatchAccounts({
        lpMintOwner: RAYDIUM_AMM_V4_PROGRAM_ID,
      });
      const resultMint = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(badMintAccounts),
      );
      expect(resultMint.ok).toBe(false);
      if (!resultMint.ok) {
        expect(resultMint.category).toBe("UNAUTHORIZED_PROGRAM_OWNER");
        expect(resultMint.accountIndex).toBe(1);
      }
    });

    it("rejects invalid buffer lengths for pool, mint, or vaults", async () => {
      const corruptPoolBuf = Buffer.alloc(500);
      const accounts = createValidBatchAccounts();
      accounts[0] = { data: corruptPoolBuf.toString("base64"), owner: RAYDIUM_AMM_V4_PROGRAM_ID };

      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_ACCOUNT_LAYOUT");
      expect(result.accountIndex).toBe(0);
    });

    it("rejects pool references not matching requested identities", async () => {
      const mismatchedAccounts = createValidBatchAccounts({
        poolLpMint: "So11111111111111111111111111111111111111119",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(mismatchedAccounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("POOL_REFERENCE_MISMATCH");
    });

    it("rejects non-SOL pairs", async () => {
      const nonSolAccounts = createValidBatchAccounts({
        poolBaseMint: FIXTURE_MEME_MINT,
        poolQuoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        quoteVaultMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(nonSolAccounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("NON_SOL_PAIR");
    });

    it("rejects expected token mint mismatch", async () => {
      const accounts = createValidBatchAccounts();
      const mismatchedIdentities: RaydiumAmmV4SnapshotIdentities = {
        ...STANDARD_IDENTITIES,
        expectedTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      };
      const result = await validateRaydiumAmmV4Snapshot(
        mismatchedIdentities,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("TOKEN_MINT_MISMATCH");
    });

    it("rejects uninitialized LP mint", async () => {
      const accounts = createValidBatchAccounts();
      const uninitMintBuf = createAuthoritativeSplMintBuffer({
        isInitialized: false,
      });
      accounts[1] = { data: uninitMintBuf.toString("base64"), owner: SPL_TOKEN_PROGRAM_ID };

      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("UNINITIALIZED_LP_MINT");
    });

    it("rejects unauthorized LP mint authority not matching AMM authority", async () => {
      const accounts = createValidBatchAccounts({
        mintAuthority: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("UNAUTHORIZED_LP_AUTHORITY");
      expect(result.message).toContain("LP mint authority");
    });

    it("rejects unauthorized LP freeze authority not matching AMM authority or null", async () => {
      const accounts = createValidBatchAccounts({
        freezeAuthority: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("UNAUTHORIZED_LP_AUTHORITY");
      expect(result.message).toContain("LP freeze authority");
    });

    it("rejects vault authority not matching derived AMM authority", async () => {
      const accounts = createValidBatchAccounts({
        baseVaultOwner: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("UNAUTHORIZED_VAULT_AUTHORITY");
    });

    it("rejects vault mint mismatch", async () => {
      const accounts = createValidBatchAccounts({
        baseVaultMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("VAULT_MINT_MISMATCH");
    });

    it("rejects uninitialized or frozen vaults (accountState !== 1)", async () => {
      // Uninitialized vault (0)
      const uninitVaultAccounts = createValidBatchAccounts({
        baseVaultState: 0,
      });
      const resultUninit = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(uninitVaultAccounts),
      );
      expect(resultUninit.ok).toBe(false);
      if (!resultUninit.ok) {
        expect(resultUninit.category).toBe("VAULT_STATE_INVALID");
      }

      // Frozen vault (2)
      const frozenVaultAccounts = createValidBatchAccounts({
        quoteVaultState: 2,
      });
      const resultFrozen = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(frozenVaultAccounts),
      );
      expect(resultFrozen.ok).toBe(false);
      if (!resultFrozen.ok) {
        expect(resultFrozen.category).toBe("VAULT_STATE_INVALID");
      }
    });

    it("rejects mathematical LP calculation failure when circulating supply exceeds protocol LP (S > L)", async () => {
      const accounts = createValidBatchAccounts({
        lpReserve: 100_000_000n,
        lpSupply: 120_000_000n,
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("LP_ACCOUNTING_CALCULATION_FAILED");
      expect(result.message).toContain("SUPPLY_EXCEEDS_PROTOCOL_LP");
    });

    it("rejects mathematical LP calculation failure when protocol LP is zero (L = 0)", async () => {
      const accounts = createValidBatchAccounts({
        lpReserve: 0n,
        lpSupply: 0n,
      });
      const result = await validateRaydiumAmmV4Snapshot(
        STANDARD_IDENTITIES,
        buildRpcPayload(accounts),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("LP_ACCOUNTING_CALCULATION_FAILED");
      expect(result.message).toContain("ZERO_PROTOCOL_LP");
    });
  });
});
