/**
 * Phase 12.94-D Milestone D.2.8: Authoritative Raydium CPMM Binary Parser
 *
 * Implements strict, fixture-validated binary decoding for Raydium Constant Product Market Maker (CPMM)
 * accounts (637 bytes Anchor layout) and fee-segregated reserve accounting.
 *
 * Upstream Reference:
 *   Repository: raydium-io/raydium-cp-swap (crates.io / GitHub)
 *   Version: v0.1.0 (Anchor zero_copy layout `PoolState`, `#[repr(C, packed)]`)
 *   Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 *   Account Discriminator: 0xf7ede3f5d7c3de46 (sha256("account:PoolState")[0..8])
 *
 * Safety & Precision:
 * - 100% offline, read-only.
 * - Exact BigInt little-endian reads for all u64 reserves, fee liabilities, and supply.
 * - Segregates protocol and fund fee liabilities from physical vault balances to derive effective reserves.
 * - Decimal-normalized spot price proxy calculation with safe float bounds.
 * - Classifies quote-asset cohorts: WSOL_NATIVE, STABLECOIN_USD, EXOTIC_CROSS.
 */

import { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import { isCanonicalSolanaBase58, SPL_TOKEN_PROGRAM_ID, WSOL_MINT } from "./RaydiumAmmParser.js";

export { WSOL_MINT, SPL_TOKEN_PROGRAM_ID };
import type {
  D23SplTokenVaultState,
  D28CpmmReserveAccounting,
  D28RaydiumCpmmState,
  QuoteAssetCohort,
  RaydiumPairOrientation,
} from "./PilotTypes.js";

export const RAYDIUM_CPMM_LAYOUT_LENGTH = 637;
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

// Anchor discriminator: sha256("account:PoolState")[0..8] = 0xf7ede3f5d7c3de46
export const RAYDIUM_CPMM_ANCHOR_DISCRIMINATOR = Object.freeze([
  0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46,
]);

// Allowed token programs
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ALLOWED_TOKEN_PROGRAMS = new Set([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

// Canonical stablecoin mints for quote cohort classification
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrz79aC5CaBpNtuDAkVqhpMtC7S2Re27563dNY7";

/**
 * Offsets within Raydium CPMM PoolState (637 bytes total, packed C representation).
 */
export const RAYDIUM_CPMM_OFFSETS = {
  DISCRIMINATOR: 0, // 8 bytes (0..8)
  AMM_CONFIG: 8, // 32 bytes (8..40)
  POOL_CREATOR: 40, // 32 bytes (40..72)
  TOKEN_0_VAULT: 72, // 32 bytes (72..104)
  TOKEN_1_VAULT: 104, // 32 bytes (104..136)
  LP_MINT: 136, // 32 bytes (136..168)
  TOKEN_0_MINT: 168, // 32 bytes (168..200)
  TOKEN_1_MINT: 200, // 32 bytes (200..232)
  TOKEN_0_PROGRAM: 232, // 32 bytes (232..264)
  TOKEN_1_PROGRAM: 264, // 32 bytes (264..296)
  OBSERVATION_KEY: 296, // 32 bytes (296..328)
  AUTH_BUMP: 328, // 1 byte u8 (offset 328)
  STATUS: 329, // 1 byte u8 (offset 329)
  LP_MINT_DECIMALS: 330, // 1 byte u8 (offset 330)
  MINT_0_DECIMALS: 331, // 1 byte u8 (offset 331)
  MINT_1_DECIMALS: 332, // 1 byte u8 (offset 332)
  LP_SUPPLY: 333, // 8 bytes u64 LE (offset 333..341)
  PROTOCOL_FEES_TOKEN_0: 341, // 8 bytes u64 LE (offset 341..349)
  PROTOCOL_FEES_TOKEN_1: 349, // 8 bytes u64 LE (offset 349..357)
  FUND_FEES_TOKEN_0: 357, // 8 bytes u64 LE (offset 357..365)
  FUND_FEES_TOKEN_1: 365, // 8 bytes u64 LE (offset 365..373)
  OPEN_TIME: 373, // 8 bytes u64 LE (offset 373..381) - swap activation Unix seconds
  PADDING: 381, // 256 bytes (32 * u64) (offset 381..637)
} as const;

export type RaydiumCpmmParseErrorCategory =
  | "INVALID_BUFFER_LENGTH"
  | "UNAUTHORIZED_OWNER_PROGRAM"
  | "INVALID_ANCHOR_DISCRIMINATOR"
  | "UNSUPPORTED_TOKEN_PROGRAM"
  | "CONTRADICTORY_MINTS"
  | "CONTRADICTORY_VAULTS"
  | "INVALID_DECIMALS"
  | "INVALID_PUBKEY_ENCODING"
  | "CORRUPTED_LAYOUT";

export interface RaydiumCpmmParseSuccess {
  readonly ok: true;
  readonly state: D28RaydiumCpmmState;
  readonly quoteCohort: QuoteAssetCohort;
  readonly orientation: RaydiumPairOrientation;
}

export interface RaydiumCpmmParseFailure {
  readonly ok: false;
  readonly category: RaydiumCpmmParseErrorCategory;
  readonly message: string;
}

export type RaydiumCpmmParseResult = RaydiumCpmmParseSuccess | RaydiumCpmmParseFailure;

export type CpmmReserveAccountingErrorCategory =
  | "VAULT_ADDRESS_MISMATCH"
  | "VAULT_MINT_MISMATCH"
  | "INSOLVENT_RESERVES"
  | "ZERO_RESERVES"
  | "DECIMAL_OVERFLOW";

export interface CpmmReserveAccountingSuccess {
  readonly ok: true;
  readonly accounting: D28CpmmReserveAccounting;
}

export interface CpmmReserveAccountingFailure {
  readonly ok: false;
  readonly category: CpmmReserveAccountingErrorCategory;
  readonly message: string;
}

export type CpmmReserveAccountingResult =
  | CpmmReserveAccountingSuccess
  | CpmmReserveAccountingFailure;

/**
 * Classifies the quote-asset research cohort based on token mints.
 */
export function classifyQuoteCohort(
  mint0: string,
  mint1: string,
): { cohort: QuoteAssetCohort; orientation: RaydiumPairOrientation } {
  if (mint1 === WSOL_MINT) {
    return { cohort: "WSOL_NATIVE", orientation: "TOKEN_BASE_SOL_QUOTE" };
  }
  if (mint0 === WSOL_MINT) {
    return { cohort: "WSOL_NATIVE", orientation: "SOL_BASE_TOKEN_QUOTE" };
  }
  if (mint0 === USDC_MINT || mint1 === USDC_MINT || mint0 === USDT_MINT || mint1 === USDT_MINT) {
    return { cohort: "STABLECOIN_USD", orientation: "NON_SOL_PAIR" };
  }
  return { cohort: "EXOTIC_CROSS", orientation: "NON_SOL_PAIR" };
}

/**
 * Parses Raydium CPMM binary account data (637 bytes Anchor layout: raydium-cp-swap v0.1.0).
 */
export function parseRaydiumCpmmAccount(
  data: Uint8Array | Buffer,
  poolAddress: string,
  ownerProgramId?: string | undefined,
  accountSlot?: number | undefined,
): RaydiumCpmmParseResult {
  if (!data || data.length !== RAYDIUM_CPMM_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_BUFFER_LENGTH",
      message: `Expected Raydium CPMM buffer of exactly ${RAYDIUM_CPMM_LAYOUT_LENGTH} bytes, received ${data?.length ?? 0}`,
    };
  }

  if (ownerProgramId !== undefined && ownerProgramId !== RAYDIUM_CPMM_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_OWNER_PROGRAM",
      message: `Account owner ${ownerProgramId || "MISSING"} does not match canonical Raydium CPMM program ${RAYDIUM_CPMM_PROGRAM_ID}`,
    };
  }

  // Verify 8-byte Anchor discriminator: sha256("account:PoolState")[0..8]
  for (let i = 0; i < 8; i++) {
    if (data[i] !== RAYDIUM_CPMM_ANCHOR_DISCRIMINATOR[i]) {
      return {
        ok: false,
        category: "INVALID_ANCHOR_DISCRIMINATOR",
        message: `Account discriminator at bytes 0..8 does not match Anchor PoolState discriminator (0xf7ede3f5d7c3de46)`,
      };
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  try {
    const ammConfig = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.AMM_CONFIG, RAYDIUM_CPMM_OFFSETS.AMM_CONFIG + 32),
    );
    const poolCreator = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.POOL_CREATOR, RAYDIUM_CPMM_OFFSETS.POOL_CREATOR + 32),
    );
    const token0Vault = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.TOKEN_0_VAULT, RAYDIUM_CPMM_OFFSETS.TOKEN_0_VAULT + 32),
    );
    const token1Vault = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.TOKEN_1_VAULT, RAYDIUM_CPMM_OFFSETS.TOKEN_1_VAULT + 32),
    );
    const lpMint = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.LP_MINT, RAYDIUM_CPMM_OFFSETS.LP_MINT + 32),
    );
    const token0Mint = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.TOKEN_0_MINT, RAYDIUM_CPMM_OFFSETS.TOKEN_0_MINT + 32),
    );
    const token1Mint = encodeBase58(
      data.subarray(RAYDIUM_CPMM_OFFSETS.TOKEN_1_MINT, RAYDIUM_CPMM_OFFSETS.TOKEN_1_MINT + 32),
    );
    const token0Program = encodeBase58(
      data.subarray(
        RAYDIUM_CPMM_OFFSETS.TOKEN_0_PROGRAM,
        RAYDIUM_CPMM_OFFSETS.TOKEN_0_PROGRAM + 32,
      ),
    );
    const token1Program = encodeBase58(
      data.subarray(
        RAYDIUM_CPMM_OFFSETS.TOKEN_1_PROGRAM,
        RAYDIUM_CPMM_OFFSETS.TOKEN_1_PROGRAM + 32,
      ),
    );
    const observationKey = encodeBase58(
      data.subarray(
        RAYDIUM_CPMM_OFFSETS.OBSERVATION_KEY,
        RAYDIUM_CPMM_OFFSETS.OBSERVATION_KEY + 32,
      ),
    );

    // Validate pubkey encodings
    const pubkeys = [
      ammConfig,
      poolCreator,
      token0Vault,
      token1Vault,
      lpMint,
      token0Mint,
      token1Mint,
      token0Program,
      token1Program,
      observationKey,
    ];
    for (const pk of pubkeys) {
      if (!isCanonicalSolanaBase58(pk)) {
        return {
          ok: false,
          category: "INVALID_PUBKEY_ENCODING",
          message: `Decoded field contains invalid Solana base58 public key: ${pk}`,
        };
      }
    }

    // Validate supported token programs (SPL Token or Token-2022)
    if (!ALLOWED_TOKEN_PROGRAMS.has(token0Program)) {
      return {
        ok: false,
        category: "UNSUPPORTED_TOKEN_PROGRAM",
        message: `Token 0 program ${token0Program} is not an approved SPL Token or Token-2022 program`,
      };
    }
    if (!ALLOWED_TOKEN_PROGRAMS.has(token1Program)) {
      return {
        ok: false,
        category: "UNSUPPORTED_TOKEN_PROGRAM",
        message: `Token 1 program ${token1Program} is not an approved SPL Token or Token-2022 program`,
      };
    }

    // Invariant: token0Mint and token1Mint cannot be identical
    if (token0Mint === token1Mint) {
      return {
        ok: false,
        category: "CONTRADICTORY_MINTS",
        message: `Pool token_0_mint and token_1_mint are identical (${token0Mint})`,
      };
    }

    // Invariant: token0Vault and token1Vault cannot be identical
    if (token0Vault === token1Vault) {
      return {
        ok: false,
        category: "CONTRADICTORY_VAULTS",
        message: `Pool token_0_vault and token_1_vault are identical (${token0Vault})`,
      };
    }

    const authBump = view.getUint8(RAYDIUM_CPMM_OFFSETS.AUTH_BUMP);
    const status = view.getUint8(RAYDIUM_CPMM_OFFSETS.STATUS);
    const lpMintDecimals = view.getUint8(RAYDIUM_CPMM_OFFSETS.LP_MINT_DECIMALS);
    const mint0Decimals = view.getUint8(RAYDIUM_CPMM_OFFSETS.MINT_0_DECIMALS);
    const mint1Decimals = view.getUint8(RAYDIUM_CPMM_OFFSETS.MINT_1_DECIMALS);

    if (mint0Decimals > 18 || mint1Decimals > 18 || lpMintDecimals > 18) {
      return {
        ok: false,
        category: "INVALID_DECIMALS",
        message: `Unreasonable decimal values in CPMM pool: mint0=${mint0Decimals}, mint1=${mint1Decimals}, lp=${lpMintDecimals}`,
      };
    }

    // Exact little-endian BigInt reads
    const lpSupply = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.LP_SUPPLY, true);
    const protocolFeesToken0 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_0, true);
    const protocolFeesToken1 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_1, true);
    const fundFeesToken0 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_0, true);
    const fundFeesToken1 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_1, true);
    const openTime = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.OPEN_TIME, true);

    const state: D28RaydiumCpmmState = {
      ammConfig,
      poolCreator,
      token0Vault,
      token1Vault,
      lpMint,
      token0Mint,
      token1Mint,
      token0Program,
      token1Program,
      observationKey,
      authBump,
      status,
      lpMintDecimals,
      mint0Decimals,
      mint1Decimals,
      lpSupply,
      protocolFeesToken0,
      protocolFeesToken1,
      fundFeesToken0,
      fundFeesToken1,
      swapActivationTimeSec: openTime,
      poolAddress,
      programId: ownerProgramId ?? RAYDIUM_CPMM_PROGRAM_ID,
      ...(accountSlot !== undefined ? { accountSlot } : {}),
    };

    const { cohort: quoteCohort, orientation } = classifyQuoteCohort(token0Mint, token1Mint);

    return {
      ok: true,
      state,
      quoteCohort,
      orientation,
    };
  } catch (err) {
    return {
      ok: false,
      category: "CORRUPTED_LAYOUT",
      message: `Failed to decode Raydium CPMM binary layout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Derives effective reserves and reserve-derived spot price proxy for a parsed CPMM pool
 * by segregating protocol and fund fee liabilities from vault balances.
 *
 * Math Reference (raydium-cp-swap):
 *   effective_reserve_0 = vault_balance_0 - (protocol_fees_0 + fund_fees_0)
 *   effective_reserve_1 = vault_balance_1 - (protocol_fees_1 + fund_fees_1)
 */
export function computeCpmmReserveAccounting(
  poolState: D28RaydiumCpmmState,
  vault0State: D23SplTokenVaultState,
  vault1State: D23SplTokenVaultState,
): CpmmReserveAccountingResult {
  // 1. Vault Address Matching
  if (vault0State.vaultAddress !== poolState.token0Vault) {
    return {
      ok: false,
      category: "VAULT_ADDRESS_MISMATCH",
      message: `Token 0 vault address mismatch: expected ${poolState.token0Vault}, received ${vault0State.vaultAddress}`,
    };
  }
  if (vault1State.vaultAddress !== poolState.token1Vault) {
    return {
      ok: false,
      category: "VAULT_ADDRESS_MISMATCH",
      message: `Token 1 vault address mismatch: expected ${poolState.token1Vault}, received ${vault1State.vaultAddress}`,
    };
  }

  // 2. Vault Mint Matching
  if (vault0State.mintAddress !== poolState.token0Mint) {
    return {
      ok: false,
      category: "VAULT_MINT_MISMATCH",
      message: `Token 0 vault mint mismatch: expected ${poolState.token0Mint}, received ${vault0State.mintAddress}`,
    };
  }
  if (vault1State.mintAddress !== poolState.token1Mint) {
    return {
      ok: false,
      category: "VAULT_MINT_MISMATCH",
      message: `Token 1 vault mint mismatch: expected ${poolState.token1Mint}, received ${vault1State.mintAddress}`,
    };
  }

  // 3. Fee Liability Calculation
  const token0TotalFeesRaw = poolState.protocolFeesToken0 + poolState.fundFeesToken0;
  const token1TotalFeesRaw = poolState.protocolFeesToken1 + poolState.fundFeesToken1;

  // 4. Invariant: Physical vault balance must satisfy accrued fees
  if (vault0State.rawAmount < token0TotalFeesRaw) {
    return {
      ok: false,
      category: "INSOLVENT_RESERVES",
      message: `Token 0 vault balance (${vault0State.rawAmount}) is less than accrued fee liabilities (${token0TotalFeesRaw})`,
    };
  }
  if (vault1State.rawAmount < token1TotalFeesRaw) {
    return {
      ok: false,
      category: "INSOLVENT_RESERVES",
      message: `Token 1 vault balance (${vault1State.rawAmount}) is less than accrued fee liabilities (${token1TotalFeesRaw})`,
    };
  }

  // 5. Effective Reserve Derivation
  const effectiveReserve0Raw = vault0State.rawAmount - token0TotalFeesRaw;
  const effectiveReserve1Raw = vault1State.rawAmount - token1TotalFeesRaw;

  // Invariant: Non-zero trading reserves
  if (effectiveReserve0Raw === 0n || effectiveReserve1Raw === 0n) {
    return {
      ok: false,
      category: "ZERO_RESERVES",
      message: `Effective trading reserves are zero: reserve0=${effectiveReserve0Raw}, reserve1=${effectiveReserve1Raw}`,
    };
  }

  // 6. Decimal Normalization
  const effectiveReserve0Decimal =
    Number(effectiveReserve0Raw) / Math.pow(10, poolState.mint0Decimals);
  const effectiveReserve1Decimal =
    Number(effectiveReserve1Raw) / Math.pow(10, poolState.mint1Decimals);

  if (
    !Number.isFinite(effectiveReserve0Decimal) ||
    !Number.isFinite(effectiveReserve1Decimal) ||
    effectiveReserve0Decimal <= 0 ||
    effectiveReserve1Decimal <= 0
  ) {
    return {
      ok: false,
      category: "DECIMAL_OVERFLOW",
      message: `Decimal-normalized reserves produced non-finite or non-positive value`,
    };
  }

  // 7. Spot Price Proxy (Note: read-only proxy, not an executable quote)
  // Spot Price 0 in terms of 1: Amount of Token 1 per 1 unit of Token 0
  const spotPrice0Per1 = effectiveReserve1Decimal / effectiveReserve0Decimal;
  // Spot Price 1 in terms of 0: Amount of Token 0 per 1 unit of Token 1
  const spotPrice1Per0 = effectiveReserve0Decimal / effectiveReserve1Decimal;

  const { cohort: quoteCohort, orientation } = classifyQuoteCohort(
    poolState.token0Mint,
    poolState.token1Mint,
  );

  let spotPriceSol: number | null = null;
  if (quoteCohort === "WSOL_NATIVE") {
    // If Token 1 is WSOL, Price of Token 0 is in SOL per token
    if (orientation === "TOKEN_BASE_SOL_QUOTE") {
      spotPriceSol = spotPrice0Per1;
    } else if (orientation === "SOL_BASE_TOKEN_QUOTE") {
      // If Token 0 is WSOL, Price of Token 1 is in SOL per token
      spotPriceSol = spotPrice1Per0;
    }
  }

  // Slot Discrepancy Tracking
  const slotDiscrepancy = Boolean(
    vault0State.slot !== undefined &&
    vault1State.slot !== undefined &&
    vault0State.slot !== vault1State.slot,
  );
  const slotDelta =
    vault0State.slot !== undefined && vault1State.slot !== undefined
      ? Math.abs(vault0State.slot - vault1State.slot)
      : undefined;

  const accounting: D28CpmmReserveAccounting = {
    poolAddress: poolState.poolAddress,
    token0Mint: poolState.token0Mint,
    token1Mint: poolState.token1Mint,
    token0Decimals: poolState.mint0Decimals,
    token1Decimals: poolState.mint1Decimals,
    token0VaultRaw: vault0State.rawAmount,
    token1VaultRaw: vault1State.rawAmount,
    token0TotalFeesRaw,
    token1TotalFeesRaw,
    effectiveReserve0Raw,
    effectiveReserve1Raw,
    effectiveReserve0Decimal,
    effectiveReserve1Decimal,
    spotPrice0Per1,
    spotPrice1Per0,
    spotPriceSol,
    quoteCohort,
    orientation,
    effectiveReservesAvailable: true,
    slotDiscrepancy,
    ...(slotDelta !== undefined ? { slotDelta } : {}),
  };

  return {
    ok: true,
    accounting,
  };
}
