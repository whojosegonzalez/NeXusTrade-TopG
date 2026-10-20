/**
 * Phase 12.94-D Milestone D.2.8: Raydium CPMM Parser Unit & Regression Tests
 *
 * Comprehensive offline verification of:
 * 1. RaydiumCpmmParser account decoding (637 bytes Anchor PoolState layout).
 * 2. Anchor discriminator enforcement (0xf7ede3f5d7c3de46).
 * 3. Separation of binary decoding from verified on-chain owner (D28-F3).
 * 4. Token-2022 and SPL Token program validation.
 * 5. Layout invariant checks (non-identical mints, non-identical vaults, decimal sanity <= 18).
 * 6. Literal-address quote cohort classification: canonical WSOL, USDC, USDT, and historical typo rejection (D28-F2).
 * 7. Fee liability deduction including creator fees (protocol + fund + creator) matching upstream vault_amount_without_fee() (D28-F1).
 * 8. Insolvent/zero reserve detection with creator fees (D28-F1).
 * 9. Honest observation causality: vault-to-vault mismatch, pool-to-vault mismatch, missing provenance, and authority verification (D28-F3, D28-F4).
 * 10. Independent hardcoded layout verification (D28-F1 requirement 7).
 *
 * 100% offline, zero network requests, deterministic synthetic fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  computeCpmmReserveAccounting,
  HISTORICAL_INCORRECT_USDT_MINT,
  parseRaydiumCpmmAccount,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_OFFSETS,
  RAYDIUM_CPMM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  USDC_MINT,
  USDT_MINT,
} from "./RaydiumCpmmParser.js";
import {
  createAuthoritativeRaydiumCpmmBuffer,
  createIndependentHardcodedCpmmBuffer,
  FIXTURE_CPMM_AMM_CONFIG,
  FIXTURE_CPMM_CREATOR,
  FIXTURE_CPMM_MEME_MINT_2,
  FIXTURE_CPMM_OBSERVATION,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { SPL_TOKEN_PROGRAM_ID, WSOL_MINT } from "./RaydiumAmmParser.js";
import type { CpmmVaultSnapshot } from "./RaydiumCpmmParser.js";

describe("Milestone D.2.8: Raydium CPMM Binary Parser & Reserve Accounting Tests", () => {
  // --------------------------------------------------------------------------
  // 1. Binary Layout Parsing & Owner Verification Separation (D28-F1, D28-F3)
  // --------------------------------------------------------------------------
  describe("1. PoolState Binary Layout Parsing & Owner Separation", () => {
    it("successfully decodes authoritative 637-byte CPMM buffer with creator fees and verified owner", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        mint0Decimals: 6,
        mint1Decimals: 9,
        openTime: 1792370123n,
        recentEpoch: 651n,
        protocolFeesToken0: 500n,
        fundFeesToken0: 250n,
        protocolFeesToken1: 1000n,
        fundFeesToken1: 500n,
        creatorFeeOn: 0,
        enableCreatorFee: true,
        creatorFeesToken0: 125n,
        creatorFeesToken1: 250n,
      });

      expect(buffer.length).toBe(RAYDIUM_CPMM_LAYOUT_LENGTH);

      const result = parseRaydiumCpmmAccount(
        buffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        300000001,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("WSOL_NATIVE");
      expect(result.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
      expect(result.state.poolAddress).toBe(FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.state.programId).toBe(RAYDIUM_CPMM_PROGRAM_ID);
      expect(result.state.ownerVerified).toBe(true);
      expect(result.state.ammConfig).toBe(FIXTURE_CPMM_AMM_CONFIG);
      expect(result.state.poolCreator).toBe(FIXTURE_CPMM_CREATOR);
      expect(result.state.token0Vault).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
      expect(result.state.token1Vault).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
      expect(result.state.token0Mint).toBe(FIXTURE_CPMM_TOKEN_0_MINT);
      expect(result.state.token1Mint).toBe(FIXTURE_CPMM_TOKEN_1_MINT);
      expect(result.state.token0Program).toBe(SPL_TOKEN_PROGRAM_ID);
      expect(result.state.token1Program).toBe(SPL_TOKEN_PROGRAM_ID);
      expect(result.state.observationKey).toBe(FIXTURE_CPMM_OBSERVATION);
      expect(result.state.authBump).toBe(254);
      expect(result.state.status).toBe(0);
      expect(result.state.mint0Decimals).toBe(6);
      expect(result.state.mint1Decimals).toBe(9);
      expect(result.state.protocolFeesToken0).toBe(500n);
      expect(result.state.fundFeesToken0).toBe(250n);
      expect(result.state.protocolFeesToken1).toBe(1000n);
      expect(result.state.fundFeesToken1).toBe(500n);
      expect(result.state.creatorFeeOn).toBe(0);
      expect(result.state.enableCreatorFee).toBe(true);
      expect(result.state.creatorFeesToken0).toBe(125n);
      expect(result.state.creatorFeesToken1).toBe(250n);
      expect(result.state.recentEpoch).toBe(651n);
      expect(result.state.swapActivationTimeSec).toBe(1792370123n);
      expect(result.state.accountSlot).toBe(300000001);
    });

    it("separates binary decoding from owner proof: missing owner leaves programId null and ownerVerified false (D28-F3)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer();

      // No ownerProgramId passed
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.state.ownerVerified).toBe(false);
      expect(result.state.programId).toBeNull();
    });

    it("rejects unauthorized program owner (D28-F3)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer();
      const result = parseRaydiumCpmmAccount(
        buffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNAUTHORIZED_OWNER_PROGRAM");
    });

    it("accepts Token-2022 program as valid token program", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0ProgramBase58: TOKEN_2022_PROGRAM_ID,
      });

      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.state.token0Program).toBe(TOKEN_2022_PROGRAM_ID);
    });

    it("rejects truncated buffer length (< 637 bytes)", () => {
      const truncated = Buffer.alloc(636);
      const result = parseRaydiumCpmmAccount(truncated, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INVALID_BUFFER_LENGTH");
    });

    it("rejects oversized buffer length (> 637 bytes)", () => {
      const oversized = Buffer.alloc(752); // AMM v4 size
      const result = parseRaydiumCpmmAccount(oversized, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INVALID_BUFFER_LENGTH");
    });

    it("rejects invalid Anchor discriminator", () => {
      const corrupt = createAuthoritativeRaydiumCpmmBuffer({
        discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
      });
      const result = parseRaydiumCpmmAccount(corrupt, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INVALID_ANCHOR_DISCRIMINATOR");
    });

    it("rejects contradictory identical mints (token0 === token1)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("CONTRADICTORY_MINTS");
    });

    it("rejects contradictory identical vaults (vault0 === vault1)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("CONTRADICTORY_VAULTS");
    });

    it("rejects invalid decimals exceeding 18", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        mint0Decimals: 19,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INVALID_DECIMALS");
    });

    it("rejects unsupported token program (neither SPL Token nor Token-2022)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0ProgramBase58: "11111111111111111111111111111111", // System program
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNSUPPORTED_TOKEN_PROGRAM");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Canonical Token Mint Identities & Literal Address Regression (D28-F2)
  // --------------------------------------------------------------------------
  describe("2. Canonical Token Mint Identities & Literal Address Regression", () => {
    it("recognizes canonical USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: USDC_MINT,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("STABLECOIN_USD");
      expect(result.orientation).toBe("NON_SOL_PAIR");
    });

    it("recognizes canonical Solana Mainnet USDT (Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: USDT_MINT,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("STABLECOIN_USD");
      expect(result.orientation).toBe("NON_SOL_PAIR");
    });

    it("rejects historical incorrect USDT address from STABLECOIN_USD cohort (D28-F2)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: HISTORICAL_INCORRECT_USDT_MINT,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Must be classified as EXOTIC_CROSS, NOT STABLECOIN_USD!
      expect(result.quoteCohort).toBe("EXOTIC_CROSS");
      expect(result.quoteCohort).not.toBe("STABLECOIN_USD");
    });

    it("does not admit unknown tokens with stablecoin-like symbols into STABLECOIN_USD (literal address equality)", () => {
      // Fake stablecoin address mimicking USDC
      const fakeUsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt99";
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: fakeUsdcMint,
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("EXOTIC_CROSS");
      expect(result.quoteCohort).not.toBe("STABLECOIN_USD");
    });

    it("correctly classifies inverted SOL_BASE_TOKEN_QUOTE orientation when token0 is WSOL", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: WSOL_MINT,
        token1MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        mint0Decimals: 9,
        mint1Decimals: 6,
      });

      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("WSOL_NATIVE");
      expect(result.orientation).toBe("SOL_BASE_TOKEN_QUOTE");
    });

    it("correctly classifies EXOTIC_CROSS quote cohort for meme-to-meme pairs", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_MEME_MINT_2,
        mint0Decimals: 6,
        mint1Decimals: 6,
      });

      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("EXOTIC_CROSS");
      expect(result.orientation).toBe("NON_SOL_PAIR");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Creator-Fee Accounting & Liability Segregation (D28-F1)
  // --------------------------------------------------------------------------
  describe("3. Creator-Fee Accounting & Liability Segregation", () => {
    it("deducts protocol, fund, AND creator fees from vault balances to derive effective reserves (D28-F1)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        mint0Decimals: 6,
        mint1Decimals: 9,
        protocolFeesToken0: 10_000n,
        fundFeesToken0: 5_000n,
        creatorFeesToken0: 2_500n, // Creator fee
        protocolFeesToken1: 20_000_000n,
        fundFeesToken1: 10_000_000n,
        creatorFeesToken1: 5_000_000n, // Creator fee
      });

      const parsedPool = parseRaydiumCpmmAccount(
        poolBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        300000001,
      );
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 100_017_500n, // 100,000,000 effective + 17,500 total fees (10k + 5k + 2.5k)
        slot: 300000001,
        authority: RAYDIUM_CPMM_AUTHORITY,
        ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      };

      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 50_035_000_000n, // 50 SOL effective + 35,000,000 total fees (20M + 10M + 5M)
        slot: 300000001,
        authority: RAYDIUM_CPMM_AUTHORITY,
        ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      };

      const accountingResult = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(accountingResult.ok).toBe(true);
      if (!accountingResult.ok) return;

      const acct = accountingResult.accounting;
      expect(acct.protocolFeesToken0Raw).toBe(10_000n);
      expect(acct.fundFeesToken0Raw).toBe(5_000n);
      expect(acct.creatorFeesToken0Raw).toBe(2_500n);
      expect(acct.token0TotalFeesRaw).toBe(17_500n);

      expect(acct.protocolFeesToken1Raw).toBe(20_000_000n);
      expect(acct.fundFeesToken1Raw).toBe(10_000_000n);
      expect(acct.creatorFeesToken1Raw).toBe(5_000_000n);
      expect(acct.token1TotalFeesRaw).toBe(35_000_000n);

      expect(acct.effectiveReserve0Raw).toBe(100_000_000n); // 100 token units (at 6 decimals)
      expect(acct.effectiveReserve1Raw).toBe(50_000_000_000n); // 50 SOL (at 9 decimals)
      expect(acct.effectiveReserve0Decimal).toBe(100);
      expect(acct.effectiveReserve1Decimal).toBe(50);

      // Spot Price: 50 SOL / 100 Tokens = 0.5 SOL/token
      expect(acct.spotPrice0Per1).toBe(0.5);
      expect(acct.spotPriceSol).toBe(0.5);
      expect(acct.spotPrice1Per0).toBe(2.0);
      expect(acct.verificationTier).toBe("INDEPENDENTLY_COHERENT");
      expect(acct.isCoherentPointInTime).toBe(true);
    });

    it("fails closed with INSOLVENT_RESERVES when ignoring creator fees would produce positive reserve, but including them causes insolvency (D28-F1)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        protocolFeesToken0: 5_000n,
        fundFeesToken0: 5_000n, // sum = 10,000
        creatorFeesToken0: 20_000n, // total liabilities = 30,000
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      // Vault has 15,000.
      // If creator fees were ignored: 15,000 - 10,000 = +5,000 (falsely solvent!)
      // With creator fees included: 15,000 < 30,000 (insolvent!)
      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 15_000n,
      };

      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INSOLVENT_RESERVES");
      expect(result.message).toContain("total accrued fee liabilities (30000");
    });

    it("fails closed with ZERO_RESERVES when ignoring creator fees would produce positive reserve, but including them leaves 0 effective reserve (D28-F1)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        protocolFeesToken0: 10_000n,
        fundFeesToken0: 0n,
        creatorFeesToken0: 5_000n, // total = 15,000
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      // Vault has 15,000.
      // If creator fees ignored: 15,000 - 10,000 = 5,000 (falsely non-zero!)
      // With creator fees included: 15,000 - 15,000 = 0 (zero reserves!)
      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 15_000n,
      };

      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("ZERO_RESERVES");
    });

    it("strictly sets spotPriceSol to null for non-WSOL pairs (fail-closed pricing)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: USDC_MINT,
        mint0Decimals: 6,
        mint1Decimals: 6,
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 10_000_000n,
      };

      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: USDC_MINT,
        rawAmount: 20_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.quoteCohort).toBe("STABLECOIN_USD");
      expect(result.accounting.spotPrice0Per1).toBe(2.0); // 2.0 USDC per Token 0
      expect(result.accounting.spotPriceSol).toBeNull(); // Fail-closed
    });
  });

  // --------------------------------------------------------------------------
  // 4. Honest Reserve Causality & Verification Tiers (D28-F3, D28-F4)
  // --------------------------------------------------------------------------
  describe("4. Honest Reserve Causality & Verification Tiers", () => {
    it("flags vault-to-vault slot mismatch as SLOT_DISCREPANT and nullifies spot prices (D28-F4)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(
        poolBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        300000000,
      );
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
        slot: 300000005, // 5 slots ahead!
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.slotDiscrepancy).toBe(true);
      expect(result.accounting.slotDelta).toBe(5);
      expect(result.accounting.verificationTier).toBe("SLOT_DISCREPANT");
      expect(result.accounting.isCoherentPointInTime).toBe(false);
      expect(result.accounting.effectiveReservesAvailable).toBe(false);
      expect(result.accounting.spotPrice0Per1).toBeNull();
      expect(result.accounting.spotPriceSol).toBeNull();
      expect(result.accounting.unavailabilityReason).toContain("Vault-to-vault slot mismatch");
    });

    it("flags pool-to-vault slot mismatch as SLOT_DISCREPANT and nullifies spot prices (D28-F4)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(
        poolBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        300000010, // Pool slot is 300000010
      );
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000, // Vault slots are 300000000
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.slotDiscrepancy).toBe(true);
      expect(result.accounting.verificationTier).toBe("SLOT_DISCREPANT");
      expect(result.accounting.isCoherentPointInTime).toBe(false);
      expect(result.accounting.effectiveReservesAvailable).toBe(false);
      expect(result.accounting.spotPrice0Per1).toBeNull();
      expect(result.accounting.unavailabilityReason).toContain("Pool-to-vault slot mismatch");
    });

    it("classifies snapshot as PARTIALLY_VERIFIED when slot provenance is incomplete (D28-F4)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      // No pool account slot
      const parsedPool = parseRaydiumCpmmAccount(
        poolBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
      );
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.slotDiscrepancy).toBe(false);
      expect(result.accounting.slotProvenanceComplete).toBe(false);
      expect(result.accounting.verificationTier).toBe("PARTIALLY_VERIFIED");
      expect(result.accounting.isCoherentPointInTime).toBe(false);
      // Reserves are available as an exploratory proxy
      expect(result.accounting.effectiveReservesAvailable).toBe(true);
      expect(result.accounting.spotPriceSol).not.toBeNull();
    });

    it("rejects unauthorized vault authority (D28-F3)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const rogueVault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        authority: "11111111111111111111111111111111", // Not RAYDIUM_CPMM_AUTHORITY!
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, rogueVault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNAUTHORIZED_VAULT_AUTHORITY");
    });

    it("rejects unauthorized vault token program (D28-F3)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        token0ProgramBase58: SPL_TOKEN_PROGRAM_ID,
      });
      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const rogueVault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        ownerProgramId: TOKEN_2022_PROGRAM_ID, // Mismatch with pool's SPL_TOKEN_PROGRAM_ID
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, rogueVault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNAUTHORIZED_VAULT_TOKEN_PROGRAM");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Independent Layout & Offset Cross-Check (D28-F1 requirement 7, D28-F6)
  // --------------------------------------------------------------------------
  describe("5. Independent Layout & Offset Cross-Check", () => {
    it("successfully parses independently generated buffer built with hardcoded literal offsets", () => {
      const independentBuffer = createIndependentHardcodedCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: WSOL_MINT,
        token0VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1VaultBase58: FIXTURE_CPMM_TOKEN_1_VAULT,
        mint0Decimals: 6,
        mint1Decimals: 9,
        protocolFeesToken0: 100n,
        protocolFeesToken1: 200n,
        fundFeesToken0: 50n,
        fundFeesToken1: 75n,
        creatorFeesToken0: 25n,
        creatorFeesToken1: 50n,
        creatorFeeOn: 0,
        enableCreatorFee: true,
        openTime: 1792375000n,
        recentEpoch: 652n,
      });

      expect(independentBuffer.length).toBe(637);

      const parsed = parseRaydiumCpmmAccount(
        independentBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.state.creatorFeesToken0).toBe(25n);
      expect(parsed.state.creatorFeesToken1).toBe(50n);
      expect(parsed.state.enableCreatorFee).toBe(true);
      expect(parsed.state.recentEpoch).toBe(652n);
      expect(parsed.state.swapActivationTimeSec).toBe(1792375000n);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Minor Integration Risks & Strict Literal Regressions (D29-A7)
  // --------------------------------------------------------------------------
  describe("6. Minor Integration Risks & Strict Literal Regressions (D29-A7)", () => {
    it("asserts canonical mint constants match independent literal addresses", () => {
      // Independent literal strings asserting constants haven't drifted
      expect(WSOL_MINT).toBe("So11111111111111111111111111111111111111112");
      expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(USDT_MINT).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
      expect(HISTORICAL_INCORRECT_USDT_MINT).toBe("Es9vMFrz79aC5CaBpNtuDAkVqhpMtC7S2Re27563dNY7");
    });

    it("fails closed with MALFORMED_CREATOR_FEE_FLAG when enable_creator_fee byte > 1", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer();
      // Set enable_creator_fee to 2 (invalid bool in Rust repr(C))
      buffer[RAYDIUM_CPMM_OFFSETS.ENABLE_CREATOR_FEE] = 2;

      const parsed = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;

      expect(parsed.category).toBe("MALFORMED_CREATOR_FEE_FLAG");
      expect(parsed.message).toContain("Invalid boolean representation for enable_creator_fee");
    });

    it("fails closed with MALFORMED_CREATOR_FEE_FLAG when creator_fee_on enum byte > 2", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer();
      // Set creator_fee_on to 3 (invalid enum in upstream pool.rs)
      buffer[RAYDIUM_CPMM_OFFSETS.CREATOR_FEE_ON] = 3;

      const parsed = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;

      expect(parsed.category).toBe("MALFORMED_CREATOR_FEE_FLAG");
      expect(parsed.message).toContain("Invalid enum representation for creator_fee_on");
    });

    it("strictly isolates PARTIALLY_VERIFIED and SLOT_DISCREPANT states from verified admission", () => {
      // When slot discrepancy exists, effective reserves are marked unavailable and spot price is null
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(
        poolBuffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        300000000,
      );
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };
      const vault1: CpmmVaultSnapshot = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        rawAmount: 1_000_000n,
        slot: 300000001, // Mismatch
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Invariant: SLOT_DISCREPANT must never produce usable spot price for trading or execution feasibility
      expect(result.accounting.verificationTier).toBe("SLOT_DISCREPANT");
      expect(result.accounting.effectiveReservesAvailable).toBe(false);
      expect(result.accounting.spotPriceSol).toBeNull();
      expect(result.accounting.spotPrice0Per1).toBeNull();
    });
  });
});
