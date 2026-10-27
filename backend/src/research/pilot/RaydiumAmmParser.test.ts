/**
 * Phase 12.94-D Milestone D.2.3: Raydium AMM v4 Parser Tests
 *
 * Verifies exact little-endian SDK layout offsets (D23P-01), asset orientation,
 * SPL token vault decoding, and vault-only proxy reserve accounting (D23P-02).
 */

import { describe, expect, it } from "vitest";
import {
  computeReserveAccounting,
  isCanonicalSolanaBase58,
  parseRaydiumAmmV4Account,
  parseSplTokenVaultAccount,
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  SPL_VAULT_LAYOUT_LENGTH,
  WSOL_MINT,
} from "./RaydiumAmmParser.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  decodeBase58To32Bytes,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";

describe("RaydiumAmmParser - D23P-01 / D23P-02", () => {
  describe("Base58 Validation", () => {
    it("accepts valid Solana base58 addresses", () => {
      expect(isCanonicalSolanaBase58(WSOL_MINT)).toBe(true);
      expect(isCanonicalSolanaBase58(RAYDIUM_AMM_V4_PROGRAM_ID)).toBe(true);
      expect(isCanonicalSolanaBase58(FIXTURE_MEME_MINT)).toBe(true);
    });

    it("rejects non-base58 or empty strings", () => {
      expect(isCanonicalSolanaBase58("")).toBe(false);
      expect(isCanonicalSolanaBase58("invalid_0OIl_address")).toBe(false); // 0, O, I, l are invalid in base58
      expect(isCanonicalSolanaBase58("short")).toBe(false);
    });
  });

  describe("Raydium AMM v4 Binary Decoder", () => {
    it("successfully decodes a standard Raydium AMM v4 pool buffer (TOKEN_BASE_SOL_QUOTE)", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseDecimal: 6n,
        quoteDecimal: 9n,
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
      });

      expect(buffer.length).toBe(RAYDIUM_AMM_V4_LAYOUT_LENGTH);

      const result = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        289100200,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
      expect(result.state.baseDecimal).toBe(6n);
      expect(result.state.quoteDecimal).toBe(9n);
      expect(result.state.poolAddress).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.state.programId).toBe(RAYDIUM_AMM_V4_PROGRAM_ID);
      expect(result.state.accountSlot).toBe(289100200);
      expect(result.state.baseMint).toBe(FIXTURE_MEME_MINT);
      expect(result.state.quoteMint).toBe(FIXTURE_WSOL_MINT);
      expect(result.state.baseVault).toBe(FIXTURE_BASE_VAULT);
      expect(result.state.quoteVault).toBe(FIXTURE_QUOTE_VAULT);
      expect(result.state.lpReserve).toBe(0n);
    });

    it("successfully decodes protocol-tracked lpReserve at offset 720", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer({
        lpReserve: 5_000_000_000_000n,
      });

      const result = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.state.lpReserve).toBe(5_000_000_000_000n);
    });

    it("successfully decodes an inverted Raydium AMM v4 pool buffer (SOL_BASE_TOKEN_QUOTE)", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseDecimal: 9n,
        quoteDecimal: 6n,
        baseMintBase58: FIXTURE_WSOL_MINT,
        quoteMintBase58: FIXTURE_MEME_MINT,
      });

      const result = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.orientation).toBe("SOL_BASE_TOKEN_QUOTE");
      expect(result.state.baseMint).toBe(FIXTURE_WSOL_MINT);
      expect(result.state.quoteMint).toBe(FIXTURE_MEME_MINT);
    });

    it("fails closed on corrupted buffer length (not 752 bytes)", () => {
      const truncated = createAuthoritativeRaydiumAmmV4Buffer({ customBufferLength: 750 });
      const result = parseRaydiumAmmV4Account(truncated, FIXTURE_POOL_ADDRESS);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_BUFFER_LENGTH");
    });

    it("fails closed on unauthorized owner program", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer();
      const result = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        "WrongProgram11111111111111111111111111111111",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("UNAUTHORIZED_OWNER_PROGRAM");
    });

    it("fails closed on unrealistic decimals (> 18)", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer({ baseDecimal: 25n });
      const result = parseRaydiumAmmV4Account(buffer, FIXTURE_POOL_ADDRESS);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_DECIMALS");
    });

    it("D23F-01: independently decodes Raydium secondary layout using hardcoded literal byte indices", () => {
      // Build a 752-byte buffer with hardcoded literal offsets without referencing RAYDIUM_V4_OFFSETS
      const raw = Buffer.alloc(752);
      // Status at 0
      raw.writeBigUInt64LE(1n, 0);
      // Base decimals at 32, quote decimals at 40
      raw.writeBigUInt64LE(6n, 32);
      raw.writeBigUInt64LE(9n, 40);
      // baseNeedTakePnl at 192 (u64)
      raw.writeBigUInt64LE(123456n, 192);
      // quoteNeedTakePnl at 200 (u64)
      raw.writeBigUInt64LE(654321n, 200);
      // quoteTotalPnl at 208 (u64)
      raw.writeBigUInt64LE(111222n, 208);
      // baseTotalPnl at 216 (u64)
      raw.writeBigUInt64LE(333444n, 216);
      // baseVault at 336 (32 bytes)
      raw.set(decodeBase58To32Bytes(FIXTURE_BASE_VAULT), 336);
      // quoteVault at 368 (32 bytes)
      raw.set(decodeBase58To32Bytes(FIXTURE_QUOTE_VAULT), 368);
      // baseMint at 400 (32 bytes)
      raw.set(decodeBase58To32Bytes(FIXTURE_MEME_MINT), 400);
      // quoteMint at 432 (32 bytes)
      raw.set(decodeBase58To32Bytes(FIXTURE_WSOL_MINT), 432);
      // lpMint at 464 (32 bytes)
      const lpMint58 = "So11111111111111111111111111111111111111113";
      raw.set(decodeBase58To32Bytes(lpMint58), 464);
      // openOrders at 496 (32 bytes)
      const openOrders58 = "So11111111111111111111111111111111111111114";
      raw.set(decodeBase58To32Bytes(openOrders58), 496);
      // marketId at 528 (32 bytes)
      const marketId58 = "So11111111111111111111111111111111111111115";
      raw.set(decodeBase58To32Bytes(marketId58), 528);

      const parsed = parseRaydiumAmmV4Account(raw, FIXTURE_POOL_ADDRESS, RAYDIUM_AMM_V4_PROGRAM_ID);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.state.baseNeedTakePnl).toBe(123456n);
      expect(parsed.state.quoteNeedTakePnl).toBe(654321n);
      expect(parsed.state.quoteTotalPnl).toBe(111222n);
      expect(parsed.state.baseTotalPnl).toBe(333444n);
      expect(parsed.state.lpMint).toBe(lpMint58);
      expect(parsed.state.openOrders).toBe(openOrders58);
      expect(parsed.state.marketId).toBe(marketId58);
      expect(parsed.state.baseVault).toBe(FIXTURE_BASE_VAULT);
      expect(parsed.state.quoteVault).toBe(FIXTURE_QUOTE_VAULT);
    });

    it("D23F-01: rejects missing or unauthorized owner program strictly", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer();
      // Empty string owner
      const resEmpty = parseRaydiumAmmV4Account(buffer, FIXTURE_POOL_ADDRESS, "");
      expect(resEmpty.ok).toBe(false);
      if (!resEmpty.ok) {
        expect(resEmpty.category).toBe("UNAUTHORIZED_OWNER_PROGRAM");
      }

      // Wrong program owner
      const resWrong = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        "Wrong11111111111111111111111111111111111111",
      );
      expect(resWrong.ok).toBe(false);
      if (!resWrong.ok) {
        expect(resWrong.category).toBe("UNAUTHORIZED_OWNER_PROGRAM");
      }
    });
  });

  describe("SPL Token Vault Account Parser", () => {
    it("successfully decodes a 165-byte SPL token vault account", () => {
      const rawAmount = 50_000_000_000_000n; // 50,000 SOL (9 decimals) or 50M tokens (6 decimals)
      const buffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        rawAmount,
      });

      expect(buffer.length).toBe(SPL_VAULT_LAYOUT_LENGTH);

      const result = parseSplTokenVaultAccount(
        buffer,
        FIXTURE_BASE_VAULT,
        FIXTURE_MEME_MINT,
        SPL_TOKEN_PROGRAM_ID,
        289100200,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.state.vaultAddress).toBe(FIXTURE_BASE_VAULT);
      expect(result.state.mintAddress).toBe(FIXTURE_MEME_MINT);
      expect(result.state.rawAmount).toBe(rawAmount);
      expect(result.state.slot).toBe(289100200);
    });

    it("fails closed when vault buffer length is not 165 bytes", () => {
      const buffer = createAuthoritativeSplVaultBuffer({ customBufferLength: 100 });
      const result = parseSplTokenVaultAccount(buffer, FIXTURE_BASE_VAULT);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("INVALID_VAULT_LENGTH");
    });

    it("fails closed on vault mint mismatch", () => {
      const buffer = createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT });
      const result = parseSplTokenVaultAccount(
        buffer,
        FIXTURE_BASE_VAULT,
        "DifferentMint111111111111111111111111111111",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("MINT_MISMATCH");
    });
  });

  describe("Reserve Accounting & Proxy Classification (D23P-02)", () => {
    it("correctly classifies VAULT_ONLY_PROXY mode as executionFeasible=false", () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseDecimal: 6n,
        quoteDecimal: 9n,
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
      });

      const parseResult = parseRaydiumAmmV4Account(poolBuffer, FIXTURE_POOL_ADDRESS);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const tokenAmount = 100_000_000_000_000n; // 100,000,000 tokens (6 decimals)
      const solAmount = 50_000_000_000n; // 50 SOL (9 decimals)

      const acct = computeReserveAccounting(
        parseResult.state,
        tokenAmount,
        solAmount,
        "VAULT_ONLY_PROXY",
      );

      expect(acct.mode).toBe("VAULT_ONLY_PROXY");
      expect(acct.tokenDecimals).toBe(6);
      expect(acct.solDecimals).toBe(9);
      expect(acct.tokenReserveDecimal).toBe(100_000_000);
      expect(acct.solReserveDecimal).toBe(50);
      expect(acct.spotPriceSol).toBe(50 / 100_000_000);

      // In VAULT_ONLY_PROXY mode, effective reserves and execution feasibility are explicitly false (D23P-02)
      expect(acct.effectiveReservesAvailable).toBe(false);
      expect(acct.executionFeasible).toBe(false);
      expect(acct.unavailabilityReason).toBe("VAULT_ONLY_RESERVES_INSUFFICIENT_FOR_FEASIBILITY");
    });

    it("correctly computes reserves for inverted pool (SOL_BASE_TOKEN_QUOTE)", () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseDecimal: 9n,
        quoteDecimal: 6n,
        baseMintBase58: FIXTURE_WSOL_MINT,
        quoteMintBase58: FIXTURE_MEME_MINT,
      });

      const parseResult = parseRaydiumAmmV4Account(poolBuffer, FIXTURE_POOL_ADDRESS);
      expect(parseResult.ok).toBe(true);
      if (!parseResult.ok) return;

      const solAmount = 25_000_000_000n; // 25 SOL (9 decimals) in baseVault
      const tokenAmount = 50_000_000_000_000n; // 50,000,000 tokens (6 decimals) in quoteVault

      const acct = computeReserveAccounting(
        parseResult.state,
        solAmount,
        tokenAmount,
        "VAULT_ONLY_PROXY",
      );

      expect(acct.orientation).toBe("SOL_BASE_TOKEN_QUOTE");
      expect(acct.tokenReserveDecimal).toBe(50_000_000);
      expect(acct.solReserveDecimal).toBe(25);
      expect(acct.spotPriceSol).toBe(25 / 50_000_000);
    });
  });
});
