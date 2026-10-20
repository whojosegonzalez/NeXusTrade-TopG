/**
 * Phase 12.94-D Milestone D.2.9-A: Verification Dispatch Service Unit & Invariant Tests
 *
 * Verifies protocol-segregated routing of discovered pool initialization candidates:
 * 1. AMM v4 dispatch -> RaydiumAmmParser (owner 675k..., SPL vaults).
 * 2. CPMM dispatch -> RaydiumCpmmParser (owner CPMMoo..., authority PDA, fee math).
 * 3. Strict anti-fallback invariant: zero fallback or substitution between parsers.
 * 4. Exact owner assertions: rejects rogue or spoofed owner program IDs.
 * 5. Slot provenance & causality: vault-to-vault or pool-to-vault mismatch sets SLOT_DISCREPANT
 *    and nullifies spot prices.
 * 6. Protection against price elevation: PARTIALLY_VERIFIED / SLOT_DISCREPANT prices
 *    are never elevated to verified measurements.
 */

import { describe, expect, it } from "vitest";
import type { DiscoveredPoolInitializationEvent } from "./EventDiscoveryContracts.js";
import {
  createAmmV4InitTransactionFixture,
  createCpmmInitTransactionFixture,
  MockOnChainAccountFetcher,
} from "./fixtures/AuthoritativeEventFixtures.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import {
  createAuthoritativeRaydiumCpmmBuffer,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { identifyPoolInitializationInstruction } from "./PoolInitializationParser.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";
import { dispatchPoolVerification } from "./VerificationDispatchService.js";

describe("Milestone D.2.9-A: Verification Dispatch Service Tests", () => {
  // --------------------------------------------------------------------------
  // 1. Raydium AMM v4 Dispatch (D29-A3)
  // --------------------------------------------------------------------------
  describe("1. Raydium AMM v4 Verification Dispatch", () => {
    it("successfully dispatches and verifies canonical AMM v4 candidate with SPL vaults", async () => {
      const tx = createAmmV4InitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher(300000100);

      // Setup valid AMM v4 pool account
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
        baseVaultBase58: FIXTURE_BASE_VAULT,
        quoteVaultBase58: FIXTURE_QUOTE_VAULT,
      });
      fetcher.setAccount(FIXTURE_POOL_ADDRESS, RAYDIUM_AMM_V4_PROGRAM_ID, poolBuffer, 300000100);

      // Setup valid SPL vaults
      const v0Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        rawAmount: 50_000_000_000n,
      });
      const v1Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        rawAmount: 100_000_000_000n,
      });
      fetcher.setAccount(FIXTURE_BASE_VAULT, SPL_TOKEN_PROGRAM_ID, v0Buffer, 300000100);
      fetcher.setAccount(FIXTURE_QUOTE_VAULT, SPL_TOKEN_PROGRAM_ID, v1Buffer, 300000100);

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(true);
      expect(result.verificationTier).toBe("VERIFIED_AMM_V4");
      expect(result.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.slotDiscrepancy).toBe(false);
      expect(result.slotDelta).toBe(0);
      expect(result.quoteCohort).toBe("WSOL_NATIVE");
      expect(result.decodedAmmState).toBeDefined();
    });

    it("fails verification if pool account owner mismatches RAYDIUM_AMM_V4_PROGRAM_ID", async () => {
      const tx = createAmmV4InitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      // Rogue program owner
      fetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        "RogueProgram1111111111111111111111111111111",
        poolBuffer,
      );
      fetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      fetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(false);
      expect(result.verificationTier).toBe("REJECTED");
      expect(result.rejectionReason).toContain("Owner mismatch");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Raydium CPMM Dispatch (D29-A3)
  // --------------------------------------------------------------------------
  describe("2. Raydium CPMM Verification Dispatch", () => {
    it("successfully dispatches and verifies canonical CPMM candidate with fee liabilities", async () => {
      const tx = createCpmmInitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher(300000200);

      // Setup CPMM pool with fees
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
        token0VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1VaultBase58: FIXTURE_CPMM_TOKEN_1_VAULT,
        mint0Decimals: 6,
        mint1Decimals: 9,
        protocolFeesToken0: 1_000n,
        protocolFeesToken1: 2_000n,
        fundFeesToken0: 500n,
        fundFeesToken1: 1_000n,
        creatorFeesToken0: 500n,
        creatorFeesToken1: 1_000n,
      });
      fetcher.setAccount(FIXTURE_CPMM_POOL_ADDRESS, RAYDIUM_CPMM_PROGRAM_ID, poolBuffer, 300000200);

      // Setup vaults with positive balances exceeding total fees
      const v0Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 10_000_000n,
      });
      const v1Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 20_000_000n,
      });
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_0_VAULT, SPL_TOKEN_PROGRAM_ID, v0Buffer, 300000200);
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_1_VAULT, SPL_TOKEN_PROGRAM_ID, v1Buffer, 300000200);

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(true);
      expect(result.verificationTier).toBe("INDEPENDENTLY_COHERENT");
      expect(result.protocol).toBe("RAYDIUM_CPMM");
      expect(result.poolId).toBe(FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.slotDiscrepancy).toBe(false);
      expect(result.effectiveReservesAvailable).toBe(true);
      expect(result.spotPriceSol).not.toBeNull();
      expect(result.spotPrice0Per1).not.toBeNull();
      expect(result.quoteCohort).toBe("WSOL_NATIVE");
      expect(result.cpmmReserveAccounting).toBeDefined();
    });

    it("fails verification if pool account owner mismatches RAYDIUM_CPMM_PROGRAM_ID", async () => {
      const tx = createCpmmInitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      // Rogue program owner
      fetcher.setAccount(
        FIXTURE_CPMM_POOL_ADDRESS,
        "RogueProgram1111111111111111111111111111111",
        poolBuffer,
      );
      fetcher.setAccount(
        FIXTURE_CPMM_TOKEN_0_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
      );
      fetcher.setAccount(
        FIXTURE_CPMM_TOKEN_1_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
      );

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(false);
      expect(result.verificationTier).toBe("REJECTED");
      expect(result.rejectionReason).toContain("Owner mismatch");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Strict Anti-Fallback & Anti-Substitution Invariant (D29-A3)
  // --------------------------------------------------------------------------
  describe("3. Strict Anti-Fallback & Anti-Substitution Invariant", () => {
    it("never routes AMM v4 candidate to CPMM parser (fails closed on buffer mismatch)", async () => {
      const tx = createAmmV4InitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      // Put a CPMM buffer (637 bytes) into an AMM v4 address
      const cpmmBuffer = createAuthoritativeRaydiumCpmmBuffer();
      fetcher.setAccount(FIXTURE_POOL_ADDRESS, RAYDIUM_AMM_V4_PROGRAM_ID, cpmmBuffer);
      fetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      fetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      // Must fail closed because 637 bytes != 752 bytes for AMM v4
      expect(result.verified).toBe(false);
      expect(result.rejectionReason).toContain("INVALID_BUFFER_LENGTH");
    });

    it("never routes CPMM candidate to AMM v4 parser (fails closed on buffer mismatch)", async () => {
      const tx = createCpmmInitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      // Put an AMM v4 buffer (752 bytes) into a CPMM address
      const ammBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      fetcher.setAccount(FIXTURE_CPMM_POOL_ADDRESS, RAYDIUM_CPMM_PROGRAM_ID, ammBuffer);
      fetcher.setAccount(
        FIXTURE_CPMM_TOKEN_0_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
      );
      fetcher.setAccount(
        FIXTURE_CPMM_TOKEN_1_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
      );

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      // Must fail closed because 752 bytes != 637 bytes for CPMM
      expect(result.verified).toBe(false);
      expect(result.rejectionReason).toContain("INVALID_BUFFER_LENGTH");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Reserve Observation Causality & Price Elevation Protection (D29-A3, D29-A7)
  // --------------------------------------------------------------------------
  describe("4. Reserve Observation Causality & Price Elevation Protection", () => {
    it("flags vault-to-vault slot discrepancy as SLOT_DISCREPANT and nullifies spot prices", async () => {
      const tx = createCpmmInitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      fetcher.setAccount(FIXTURE_CPMM_POOL_ADDRESS, RAYDIUM_CPMM_PROGRAM_ID, poolBuffer, 300000200);

      const v0Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 10_000_000n,
      });
      const v1Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 20_000_000n,
      });
      // Slot mismatch between vaults: 300000200 vs 300000205
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_0_VAULT, SPL_TOKEN_PROGRAM_ID, v0Buffer, 300000200);
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_1_VAULT, SPL_TOKEN_PROGRAM_ID, v1Buffer, 300000205);

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(false); // Invariant: slot discrepancy is NOT verified
      expect(result.verificationTier).toBe("SLOT_DISCREPANT");
      expect(result.slotDiscrepancy).toBe(true);
      expect(result.effectiveReservesAvailable).toBe(false);
      expect(result.spotPriceSol).toBeNull();
      expect(result.spotPrice0Per1).toBeNull();
    });

    it("flags pool-to-vault slot discrepancy as SLOT_DISCREPANT and nullifies spot prices", async () => {
      const tx = createCpmmInitTransactionFixture();
      const parseResult = identifyPoolInitializationInstruction(tx);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const fetcher = new MockOnChainAccountFetcher();
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      // Pool slot is 300000210, vault slots are 300000200
      fetcher.setAccount(FIXTURE_CPMM_POOL_ADDRESS, RAYDIUM_CPMM_PROGRAM_ID, poolBuffer, 300000210);

      const v0Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 10_000_000n,
      });
      const v1Buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 20_000_000n,
      });
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_0_VAULT, SPL_TOKEN_PROGRAM_ID, v0Buffer, 300000200);
      fetcher.setAccount(FIXTURE_CPMM_TOKEN_1_VAULT, SPL_TOKEN_PROGRAM_ID, v1Buffer, 300000200);

      const result = await dispatchPoolVerification(parseResult.event, fetcher);

      expect(result.verified).toBe(false);
      expect(result.verificationTier).toBe("SLOT_DISCREPANT");
      expect(result.slotDiscrepancy).toBe(true);
      expect(result.effectiveReservesAvailable).toBe(false);
      expect(result.spotPriceSol).toBeNull();
    });

    it("rejects immediately without RPC query when protocol is UNSUPPORTED_PROTOCOL", async () => {
      const unsupportedEvent: DiscoveredPoolInitializationEvent = {
        eventId: "sig:0",
        signature: "sig",
        instructionIndex: 0,
        slot: 300000100,
        blockTimeSec: 1792375000,
        firstSeenTimestampMs: 1792375000000,
        poolOpenTimeSec: 1792375000,
        protocol: "UNSUPPORTED_PROTOCOL",
        unsupportedReason: "ORCA_WHIRLPOOL",
        poolId: "whirlpool11111111111111111111111111111111",
        token0Mint: FIXTURE_MEME_MINT,
        token1Mint: FIXTURE_WSOL_MINT,
        token0Vault: FIXTURE_BASE_VAULT,
        token1Vault: FIXTURE_QUOTE_VAULT,
      };

      const fetcher = new MockOnChainAccountFetcher();
      const result = await dispatchPoolVerification(unsupportedEvent, fetcher);

      expect(result.verified).toBe(false);
      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.rejectionReason).toBe("ORCA_WHIRLPOOL");
      expect(result.verificationTier).toBe("REJECTED");
    });
  });
});
