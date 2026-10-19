/**
 * Phase 12.94-D Milestone D.2.8: Raydium CPMM Parser Unit & Regression Tests
 *
 * Comprehensive offline verification of:
 * 1. RaydiumCpmmParser account decoding (637 bytes Anchor PoolState layout).
 * 2. Anchor discriminator enforcement (0xf7ede3f5d7c3de46).
 * 3. Canonical program ownership (CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C).
 * 4. Token-2022 and SPL Token program validation.
 * 5. Layout invariant checks (non-identical mints, non-identical vaults, decimal sanity <= 18).
 * 6. Quote cohort classification (WSOL_NATIVE, STABLECOIN_USD, EXOTIC_CROSS).
 * 7. Fee liability subtraction from physical vault balances for effective trading reserves.
 * 8. Decimal normalization and spot price proxy derivation.
 * 9. Fail-closed behavior on insolvent, zero, or mismatched reserves.
 *
 * 100% offline, zero network requests, deterministic synthetic fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  computeCpmmReserveAccounting,
  parseRaydiumCpmmAccount,
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./RaydiumCpmmParser.js";
import {
  createAuthoritativeRaydiumCpmmBuffer,
  FIXTURE_CPMM_AMM_CONFIG,
  FIXTURE_CPMM_CREATOR,
  FIXTURE_CPMM_MEME_MINT_2,
  FIXTURE_CPMM_OBSERVATION,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  FIXTURE_CPMM_USDC_MINT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { SPL_TOKEN_PROGRAM_ID, WSOL_MINT } from "./RaydiumAmmParser.js";
import type { D23SplTokenVaultState } from "./PilotTypes.js";

describe("Milestone D.2.8: Raydium CPMM Binary Parser & Reserve Accounting Tests", () => {
  describe("1. PoolState Binary Layout Parsing", () => {
    it("successfully decodes authoritative 637-byte CPMM buffer with WSOL_NATIVE quote cohort", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        mint0Decimals: 6,
        mint1Decimals: 9,
        openTime: 1792370123n,
        protocolFeesToken0: 500n,
        fundFeesToken0: 250n,
        protocolFeesToken1: 1000n,
        fundFeesToken1: 500n,
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
      expect(result.state.swapActivationTimeSec).toBe(1792370123n);
      expect(result.state.accountSlot).toBe(300000001);
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

    it("correctly classifies STABLECOIN_USD quote cohort when paired with USDC", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_USDC_MINT,
        mint0Decimals: 6,
        mint1Decimals: 6,
      });

      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.quoteCohort).toBe("STABLECOIN_USD");
      expect(result.orientation).toBe("NON_SOL_PAIR");
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

    it("accepts Token-2022 program as valid token program", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0ProgramBase58: TOKEN_2022_PROGRAM_ID,
      });

      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.state.token0Program).toBe(TOKEN_2022_PROGRAM_ID);
    });

    it("rejects truncated buffer length", () => {
      const truncated = Buffer.alloc(636);
      const result = parseRaydiumCpmmAccount(truncated, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INVALID_BUFFER_LENGTH");
    });

    it("rejects oversized buffer length", () => {
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

    it("rejects unauthorized program owner", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer();
      const result = parseRaydiumCpmmAccount(
        buffer,
        FIXTURE_CPMM_POOL_ADDRESS,
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNAUTHORIZED_OWNER_PROGRAM");
    });

    it("rejects contradictory identical mints (token0 === token1)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_TOKEN_0_MINT, // identical!
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("CONTRADICTORY_MINTS");
    });

    it("rejects contradictory identical vaults (vault0 === vault1)", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT, // identical!
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

    it("rejects unsupported token program", () => {
      const buffer = createAuthoritativeRaydiumCpmmBuffer({
        token0ProgramBase58: "11111111111111111111111111111111", // System program
      });
      const result = parseRaydiumCpmmAccount(buffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("UNSUPPORTED_TOKEN_PROGRAM");
    });
  });

  describe("2. Reserve Accounting & Fee Liability Segregation", () => {
    it("deducts protocol and fund fees from vault balances to derive effective reserves", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        mint0Decimals: 6,
        mint1Decimals: 9,
        protocolFeesToken0: 10_000n,
        fundFeesToken0: 5_000n,
        protocolFeesToken1: 20_000_000n,
        fundFeesToken1: 10_000_000n,
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 100_015_000n, // 100,000,000 effective + 15,000 fees
        slot: 300000001,
      };

      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 50_030_000_000n, // 50,000,000,000 effective (50 SOL) + 30,000,000 fees (0.03 SOL)
        slot: 300000001,
      };

      const accountingResult = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(accountingResult.ok).toBe(true);
      if (!accountingResult.ok) return;

      const acct = accountingResult.accounting;
      expect(acct.token0TotalFeesRaw).toBe(15_000n);
      expect(acct.token1TotalFeesRaw).toBe(30_000_000n);
      expect(acct.effectiveReserve0Raw).toBe(100_000_000n); // 100 token units (at 6 decimals)
      expect(acct.effectiveReserve1Raw).toBe(50_000_000_000n); // 50 SOL (at 9 decimals)
      expect(acct.effectiveReserve0Decimal).toBe(100);
      expect(acct.effectiveReserve1Decimal).toBe(50);

      // Spot Price: 50 SOL / 100 Tokens = 0.5 SOL/token
      expect(acct.spotPrice0Per1).toBe(0.5);
      expect(acct.spotPriceSol).toBe(0.5);
      expect(acct.spotPrice1Per0).toBe(2.0); // 2 tokens per SOL
      expect(acct.quoteCohort).toBe("WSOL_NATIVE");
      expect(acct.slotDiscrepancy).toBe(false);
    });

    it("rejects when vault balance is less than accrued fees (insolvent reserves)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        protocolFeesToken0: 50_000n,
        fundFeesToken0: 50_000n, // total fees: 100,000
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const insolventVault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 90_000n, // Less than 100,000 fees!
      };

      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, insolventVault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("INSOLVENT_RESERVES");
    });

    it("rejects when effective reserve is zero", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        protocolFeesToken0: 10_000n,
        fundFeesToken0: 0n,
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const zeroVault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 10_000n, // exactly equal to fees -> effective reserve 0
      };

      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, zeroVault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("ZERO_RESERVES");
    });

    it("strictly sets spotPriceSol to null for non-WSOL pairs (fail-closed pricing)", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
        token1MintBase58: FIXTURE_CPMM_USDC_MINT,
        mint0Decimals: 6,
        mint1Decimals: 6,
      });

      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 10_000_000n,
      };

      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_USDC_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 20_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.quoteCohort).toBe("STABLECOIN_USD");
      expect(result.accounting.spotPrice0Per1).toBe(2.0); // 2.0 USDC per Token 0
      expect(result.accounting.spotPriceSol).toBeNull(); // Fail-closed: No unanchored conversion to SOL
    });

    it("rejects vault address mismatch", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const wrongVault0: D23SplTokenVaultState = {
        vaultAddress: "11111111111111111111111111111111", // wrong address
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
      };
      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, wrongVault0, vault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("VAULT_ADDRESS_MISMATCH");
    });

    it("rejects vault mint mismatch", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
      };
      const wrongVault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_USDC_MINT, // mismatch (expected WSOL)
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, wrongVault1);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.category).toBe("VAULT_MINT_MISMATCH");
    });

    it("detects and flags slot discrepancies between vault observations", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const parsedPool = parseRaydiumCpmmAccount(poolBuffer, FIXTURE_CPMM_POOL_ADDRESS);
      expect(parsedPool.ok).toBe(true);
      if (!parsedPool.ok) return;

      const vault0: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_0_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_0_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
        slot: 300000000,
      };
      const vault1: D23SplTokenVaultState = {
        vaultAddress: FIXTURE_CPMM_TOKEN_1_VAULT,
        mintAddress: FIXTURE_CPMM_TOKEN_1_MINT,
        ownerAddress: FIXTURE_CPMM_POOL_ADDRESS,
        rawAmount: 1_000_000n,
        slot: 300000005, // 5 slots ahead!
      };

      const result = computeCpmmReserveAccounting(parsedPool.state, vault0, vault1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.accounting.slotDiscrepancy).toBe(true);
      expect(result.accounting.slotDelta).toBe(5);
    });
  });
});
