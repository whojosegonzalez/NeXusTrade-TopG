/**
 * Phase 12.94-D Milestone D.2.8: Raydium CPMM Parser & Reserve Accounting Engine
 *
 * Implements strict zero-copy binary deserialization for Raydium Constant Product
 * Market Maker (CPMM) accounts (raydium-cp-swap v0.1.0, #[repr(C, packed)] PoolState,
 * exactly 637 bytes, Anchor discriminator 0xf7ede3f5d7c3de46).
 *
 * Key Architectural Invariants (D28-ADG-01, D28-ADG-02, D28-F1, D28-F2, D28-F3, D28-F4):
 * 1. Pinned Anchor Binary Layout: Exactly 637 bytes. Rejects truncated or oversized buffers.
 * 2. Anchor Discriminator Validation: First 8 bytes must equal sha256("account:PoolState")[0..8].
 * 3. Verified Program Identity vs Binary Decoding: Distinguishes successful binary decoding
 *    from independently verified on-chain owner. Does not fabricate program ownership if missing.
 * 4. Fee Liability Segregation: Effective reserves deduct protocol_fees, fund_fees, AND creator_fees
 *    (matching upstream vault_amount_without_fee()). Fails closed with INSOLVENT_RESERVES if
 *    vault balance is less than total liabilities.
 * 5. Exact BigInt Arithmetic: Raw balances and fee liabilities are stored and subtracted as bigint.
 * 6. Honest Observation Causality: Includes pool account slot and both vault slots in consistency
 *    analysis. Mismatched slots result in SLOT_DISCREPANT tier and nullified spot prices.
 * 7. Quote-Asset Research Taxonomy: Classifies pools into WSOL_NATIVE, STABLECOIN_USD, or
 *    EXOTIC_CROSS cohorts. Uses canonical literal mint addresses for USDC and USDT.
 */

import { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import { isCanonicalSolanaBase58, SPL_TOKEN_PROGRAM_ID, WSOL_MINT } from "./RaydiumAmmParser.js";

export { WSOL_MINT, SPL_TOKEN_PROGRAM_ID };
import type {
  CpmmVerificationTier,
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

// Raydium CPMM Global Vault & LP Mint Authority PDA derived from "vault_and_lp_mint_auth_seed"
export const RAYDIUM_CPMM_AUTHORITY = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";

// Allowed token programs
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ALLOWED_TOKEN_PROGRAMS = new Set([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

// Canonical stablecoin mints for quote cohort classification (D28-F2)
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Historical incorrect USDT address for regression prevention tests
export const HISTORICAL_INCORRECT_USDT_MINT = "Es9vMFrz79aC5CaBpNtuDAkVqhpMtC7S2Re27563dNY7";

/**
 * Offsets within Raydium CPMM PoolState (637 bytes total, #[repr(C, packed)]).
 * Upstream source: raydium-io/raydium-cp-swap/programs/cp-swap/src/states/pool.rs (PR #55/#80)
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
  OPEN_TIME: 373, // 8 bytes u64 LE (offset 373..381) - pool unlock / swap activation Unix seconds
  RECENT_EPOCH: 381, // 8 bytes u64 LE (offset 381..389)
  CREATOR_FEE_ON: 389, // 1 byte u8 (offset 389) (0: BothToken, 1: OnlyToken0, 2: OnlyToken1)
  ENABLE_CREATOR_FEE: 390, // 1 byte bool/u8 (offset 390) (u8 !== 0)
  PADDING_1: 391, // 6 bytes [u8; 6] (offset 391..397)
  CREATOR_FEES_TOKEN_0: 397, // 8 bytes u64 LE (offset 397..405)
  CREATOR_FEES_TOKEN_1: 405, // 8 bytes u64 LE (offset 405..413)
  PADDING: 413, // 224 bytes ([u64; 28]) (offset 413..637)
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
  | "UNAUTHORIZED_VAULT_AUTHORITY"
  | "UNAUTHORIZED_VAULT_TOKEN_PROGRAM"
  | "FEE_OVERFLOW"
  | "INSOLVENT_RESERVES"
  | "ZERO_RESERVES"
  | "DECIMAL_OVERFLOW"
  | "SLOT_DISCREPANCY";

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
 * Vault snapshot input for CPMM reserve accounting.
 */
export interface CpmmVaultSnapshot {
  readonly vaultAddress: string;
  readonly mintAddress: string;
  readonly rawAmount: bigint;
  readonly slot?: number | undefined;
  readonly authority?: string | undefined;
  readonly ownerProgramId?: string | undefined;
}

/**
 * Classifies the quote-asset research cohort based strictly on literal token mint addresses (D28-F2).
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
 *
 * Separates binary decoding from verified on-chain owner (D28-F3):
 * - If ownerProgramId is provided and matches RAYDIUM_CPMM_PROGRAM_ID: ownerVerified=true, programId=RAYDIUM_CPMM_PROGRAM_ID.
 * - If ownerProgramId is provided and does not match: returns UNAUTHORIZED_OWNER_PROGRAM error.
 * - If ownerProgramId is undefined: ownerVerified=false, programId=null (does not fabricate program identity).
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

  // D28-F3: If owner program ID is provided, it must match canonical CPMM program
  let ownerVerified = false;
  let programId: string | null = null;
  if (ownerProgramId !== undefined) {
    if (ownerProgramId !== RAYDIUM_CPMM_PROGRAM_ID) {
      return {
        ok: false,
        category: "UNAUTHORIZED_OWNER_PROGRAM",
        message: `Account owner ${ownerProgramId || "MISSING"} does not match canonical Raydium CPMM program ${RAYDIUM_CPMM_PROGRAM_ID}`,
      };
    }
    ownerVerified = true;
    programId = RAYDIUM_CPMM_PROGRAM_ID;
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

    // Exact little-endian BigInt reads for fees and supply
    const lpSupply = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.LP_SUPPLY, true);
    const protocolFeesToken0 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_0, true);
    const protocolFeesToken1 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_1, true);
    const fundFeesToken0 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_0, true);
    const fundFeesToken1 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_1, true);
    const openTime = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.OPEN_TIME, true);
    const recentEpoch = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.RECENT_EPOCH, true);

    // Creator fee fields (D28-F1)
    const creatorFeeOn = view.getUint8(RAYDIUM_CPMM_OFFSETS.CREATOR_FEE_ON);
    const enableCreatorFee = view.getUint8(RAYDIUM_CPMM_OFFSETS.ENABLE_CREATOR_FEE) !== 0;
    const creatorFeesToken0 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.CREATOR_FEES_TOKEN_0, true);
    const creatorFeesToken1 = view.getBigUint64(RAYDIUM_CPMM_OFFSETS.CREATOR_FEES_TOKEN_1, true);

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
      creatorFeeOn,
      enableCreatorFee,
      creatorFeesToken0,
      creatorFeesToken1,
      recentEpoch,
      swapActivationTimeSec: openTime,
      poolAddress,
      programId,
      ownerVerified,
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
      message: `Exception decoding Raydium CPMM layout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Computes CPMM effective reserves and spot price proxy with fee liability deduction (D28-F1, D28-F3, D28-F4).
 *
 * Implements upstream vault_amount_without_fee() deduction:
 *   effective_reserve_0 = vault_0 - (protocol_fees_0 + fund_fees_0 + creator_fees_0)
 *   effective_reserve_1 = vault_1 - (protocol_fees_1 + fund_fees_1 + creator_fees_1)
 *
 * Enforces causality and verification tiers:
 * - INDEPENDENTLY_COHERENT: All slots present and equal, pool owner verified, vault authorities verified, token programs verified.
 * - PARTIALLY_VERIFIED: Decoded successfully, but lacks complete slot provenance or authority proof. Spot price proxy calculated for observation.
 * - SLOT_DISCREPANT: Slot mismatch detected between vaults or between pool and vaults. Spot prices are nullified to prevent claiming coherent pricing.
 * - UNAVAILABLE: Insolvent vault, zero reserves, or data mismatch.
 */
export function computeCpmmReserveAccounting(
  poolState: D28RaydiumCpmmState,
  vault0State: CpmmVaultSnapshot,
  vault1State: CpmmVaultSnapshot,
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

  // 3. Vault Authority Verification (D28-F3)
  if (vault0State.authority !== undefined && vault0State.authority !== RAYDIUM_CPMM_AUTHORITY) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_AUTHORITY",
      message: `Token 0 vault authority ${vault0State.authority} does not match canonical CPMM authority ${RAYDIUM_CPMM_AUTHORITY}`,
    };
  }
  if (vault1State.authority !== undefined && vault1State.authority !== RAYDIUM_CPMM_AUTHORITY) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_AUTHORITY",
      message: `Token 1 vault authority ${vault1State.authority} does not match canonical CPMM authority ${RAYDIUM_CPMM_AUTHORITY}`,
    };
  }
  const vaultAuthoritiesVerified = Boolean(
    vault0State.authority === RAYDIUM_CPMM_AUTHORITY &&
    vault1State.authority === RAYDIUM_CPMM_AUTHORITY,
  );

  // 4. Vault Token-Program Ownership Verification (D28-F3)
  if (
    vault0State.ownerProgramId !== undefined &&
    vault0State.ownerProgramId !== poolState.token0Program
  ) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_TOKEN_PROGRAM",
      message: `Token 0 vault token program ${vault0State.ownerProgramId} does not match expected pool program ${poolState.token0Program}`,
    };
  }
  if (
    vault1State.ownerProgramId !== undefined &&
    vault1State.ownerProgramId !== poolState.token1Program
  ) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_TOKEN_PROGRAM",
      message: `Token 1 vault token program ${vault1State.ownerProgramId} does not match expected pool program ${poolState.token1Program}`,
    };
  }
  const vaultTokenProgramsVerified = Boolean(
    vault0State.ownerProgramId === poolState.token0Program &&
    vault1State.ownerProgramId === poolState.token1Program,
  );

  // 5. Total Fee Liability Calculation (D28-F1: protocol + fund + creator fees)
  const token0TotalFeesRaw =
    poolState.protocolFeesToken0 + poolState.fundFeesToken0 + poolState.creatorFeesToken0;
  const token1TotalFeesRaw =
    poolState.protocolFeesToken1 + poolState.fundFeesToken1 + poolState.creatorFeesToken1;

  // 6. Invariant: Physical vault balance must satisfy total accrued fees (D28-F1)
  if (vault0State.rawAmount < token0TotalFeesRaw) {
    return {
      ok: false,
      category: "INSOLVENT_RESERVES",
      message: `Token 0 vault balance (${vault0State.rawAmount}) is less than total accrued fee liabilities (${token0TotalFeesRaw} = protocol:${poolState.protocolFeesToken0} + fund:${poolState.fundFeesToken0} + creator:${poolState.creatorFeesToken0})`,
    };
  }
  if (vault1State.rawAmount < token1TotalFeesRaw) {
    return {
      ok: false,
      category: "INSOLVENT_RESERVES",
      message: `Token 1 vault balance (${vault1State.rawAmount}) is less than total accrued fee liabilities (${token1TotalFeesRaw} = protocol:${poolState.protocolFeesToken1} + fund:${poolState.fundFeesToken1} + creator:${poolState.creatorFeesToken1})`,
    };
  }

  // 7. Effective Reserve Derivation
  const effectiveReserve0Raw = vault0State.rawAmount - token0TotalFeesRaw;
  const effectiveReserve1Raw = vault1State.rawAmount - token1TotalFeesRaw;

  // Invariant: Non-zero trading reserves
  if (effectiveReserve0Raw === 0n || effectiveReserve1Raw === 0n) {
    return {
      ok: false,
      category: "ZERO_RESERVES",
      message: `Effective trading reserves are zero after fee deduction: reserve0=${effectiveReserve0Raw}, reserve1=${effectiveReserve1Raw}`,
    };
  }

  // 8. Decimal Normalization
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

  // 9. Observation Causality & Slot Discrepancy Tracking (D28-F4)
  const poolSlot = poolState.accountSlot;
  const vault0Slot = vault0State.slot;
  const vault1Slot = vault1State.slot;

  const hasVaultSlots = vault0Slot !== undefined && vault1Slot !== undefined;
  const hasPoolSlot = poolSlot !== undefined;
  const slotProvenanceComplete = hasVaultSlots && hasPoolSlot;

  // Vault-to-vault slot mismatch
  const vaultSlotMismatch = hasVaultSlots && vault0Slot !== vault1Slot;
  const slotDelta = hasVaultSlots ? Math.abs(vault0Slot - vault1Slot) : undefined;

  // Pool-to-vault slot mismatch
  const poolToVault0Mismatch = hasPoolSlot && vault0Slot !== undefined && poolSlot !== vault0Slot;
  const poolToVault1Mismatch = hasPoolSlot && vault1Slot !== undefined && poolSlot !== vault1Slot;
  const poolVaultMismatch = poolToVault0Mismatch || poolToVault1Mismatch;
  const poolVaultSlotDelta =
    hasPoolSlot && vault0Slot !== undefined ? Math.abs(poolSlot - vault0Slot) : undefined;

  const slotDiscrepancy = Boolean(vaultSlotMismatch || poolVaultMismatch);

  const { cohort: quoteCohort, orientation } = classifyQuoteCohort(
    poolState.token0Mint,
    poolState.token1Mint,
  );

  // 10. Determine Verification Tier (D28-F3, D28-F4)
  let verificationTier: CpmmVerificationTier;
  let isCoherentPointInTime = false;
  let effectiveReservesAvailable = false;
  let spotPrice0Per1: number | null = null;
  let spotPrice1Per0: number | null = null;
  let spotPriceSol: number | null = null;
  let unavailabilityReason: string | undefined = undefined;

  if (slotDiscrepancy) {
    // D28-F4: Do not label a slot-discrepant observation an independently verified coherent price
    verificationTier = "SLOT_DISCREPANT";
    unavailabilityReason = vaultSlotMismatch
      ? `Vault-to-vault slot mismatch: vault0=${vault0Slot}, vault1=${vault1Slot} (delta=${slotDelta})`
      : `Pool-to-vault slot mismatch: pool=${poolSlot}, vault0=${vault0Slot}, vault1=${vault1Slot}`;
    effectiveReservesAvailable = false;
    spotPrice0Per1 = null;
    spotPrice1Per0 = null;
    spotPriceSol = null;
  } else if (
    slotProvenanceComplete &&
    poolState.ownerVerified &&
    vaultAuthoritiesVerified &&
    vaultTokenProgramsVerified
  ) {
    // All 3 slots match exactly, authority verified, pool owner verified, token programs verified
    verificationTier = "INDEPENDENTLY_COHERENT";
    isCoherentPointInTime = true;
    effectiveReservesAvailable = true;
    spotPrice0Per1 = effectiveReserve1Decimal / effectiveReserve0Decimal;
    spotPrice1Per0 = effectiveReserve0Decimal / effectiveReserve1Decimal;

    if (quoteCohort === "WSOL_NATIVE") {
      spotPriceSol = orientation === "TOKEN_BASE_SOL_QUOTE" ? spotPrice0Per1 : spotPrice1Per0;
    }
  } else {
    // Decoded without slot mismatch, but lacks complete slot provenance or authority proof
    verificationTier = "PARTIALLY_VERIFIED";
    isCoherentPointInTime = false;
    effectiveReservesAvailable = true;
    spotPrice0Per1 = effectiveReserve1Decimal / effectiveReserve0Decimal;
    spotPrice1Per0 = effectiveReserve0Decimal / effectiveReserve1Decimal;

    if (quoteCohort === "WSOL_NATIVE") {
      spotPriceSol = orientation === "TOKEN_BASE_SOL_QUOTE" ? spotPrice0Per1 : spotPrice1Per0;
    }
  }

  const accounting: D28CpmmReserveAccounting = {
    poolAddress: poolState.poolAddress,
    token0Mint: poolState.token0Mint,
    token1Mint: poolState.token1Mint,
    token0Decimals: poolState.mint0Decimals,
    token1Decimals: poolState.mint1Decimals,
    token0VaultRaw: vault0State.rawAmount,
    token1VaultRaw: vault1State.rawAmount,
    protocolFeesToken0Raw: poolState.protocolFeesToken0,
    protocolFeesToken1Raw: poolState.protocolFeesToken1,
    fundFeesToken0Raw: poolState.fundFeesToken0,
    fundFeesToken1Raw: poolState.fundFeesToken1,
    creatorFeesToken0Raw: poolState.creatorFeesToken0,
    creatorFeesToken1Raw: poolState.creatorFeesToken1,
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
    effectiveReservesAvailable,
    verificationTier,
    isCoherentPointInTime,
    poolOwnerVerified: poolState.ownerVerified,
    vaultAuthoritiesVerified,
    vaultTokenProgramsVerified,
    slotProvenanceComplete,
    slotDiscrepancy,
    ...(poolSlot !== undefined ? { poolSlot } : {}),
    ...(vault0Slot !== undefined ? { vault0Slot } : {}),
    ...(vault1Slot !== undefined ? { vault1Slot } : {}),
    ...(slotDelta !== undefined ? { slotDelta } : {}),
    ...(poolVaultSlotDelta !== undefined ? { poolVaultSlotDelta } : {}),
    ...(unavailabilityReason !== undefined ? { unavailabilityReason } : {}),
  };

  return {
    ok: true,
    accounting,
  };
}
