/**
 * Phase 12.94-D Milestone D.2.3: Authoritative Raydium AMM v4 Binary Parser
 *
 * Implements strict, fixture-validated binary decoding for Raydium AMM v4 (752 bytes)
 * and SPL Token Vault accounts (165 bytes) adhering to the official published Raydium SDK layout.
 *
 * Authority: Raydium SDK V2 liquidityStateV4Layout & Raydium SDK V1 pool parsing.
 * Offsets strictly corrected per independent audit finding D23P-01.
 */

import { PublicKey } from "@solana/web3.js";
import { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type {
  D23RaydiumAmmV4State,
  D23ReserveAccounting,
  D23SplTokenVaultState,
  RaydiumPairOrientation,
} from "./PilotTypes.js";

export const RAYDIUM_AMM_V4_LAYOUT_LENGTH = 752;
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Correct Offsets per Raydium SDK liquidityStateV4Layout (D23P-01, D23F-01)
export const RAYDIUM_V4_OFFSETS = {
  STATUS: 0,
  NONCE: 8, // u64 little-endian (offset 8..16) - amm.nonce (authority bump)
  BASE_DECIMAL: 32, // u64 little-endian (offset 32..40)
  QUOTE_DECIMAL: 40, // u64 little-endian (offset 40..48)
  BASE_NEED_TAKE_PNL: 192, // u64 little-endian (offset 192..200)
  QUOTE_NEED_TAKE_PNL: 200, // u64 little-endian (offset 200..208)
  QUOTE_TOTAL_PNL: 208, // u64 little-endian (offset 208..216)
  BASE_TOTAL_PNL: 216, // u64 little-endian (offset 216..224)
  BASE_VAULT: 336, // 32-byte pubkey (offset 336..368)
  QUOTE_VAULT: 368, // 32-byte pubkey (offset 368..400)
  BASE_MINT: 400, // 32-byte pubkey (offset 400..432)
  QUOTE_MINT: 432, // 32-byte pubkey (offset 432..464)
  LP_MINT: 464, // 32-byte pubkey (offset 464..496)
  OPEN_ORDERS: 496, // 32-byte pubkey (offset 496..528)
  MARKET_ID: 528, // 32-byte pubkey (offset 528..560)
  MARKET_PROGRAM_ID: 560, // 32-byte pubkey (offset 560..592)
  TARGET_ORDERS: 592, // 32-byte pubkey (offset 592..624)
  LP_RESERVE: 720, // u64 little-endian (offset 720..728) - amm.lp_amount
} as const;

export const SPL_VAULT_LAYOUT_LENGTH = 165;
export const SPL_VAULT_OFFSETS = {
  MINT: 0, // 32-byte pubkey (offset 0..32)
  OWNER: 32, // 32-byte pubkey (offset 32..64)
  AMOUNT: 64, // u64 little-endian (offset 64..72)
  STATE: 108, // u8 account state (0: Uninitialized, 1: Initialized, 2: Frozen)
} as const;

export type RaydiumParseErrorCategory =
  | "INVALID_BUFFER_LENGTH"
  | "UNAUTHORIZED_OWNER_PROGRAM"
  | "INVALID_DECIMALS"
  | "INVALID_PUBKEY_ENCODING"
  | "CORRUPTED_LAYOUT";

export interface RaydiumAmmParseSuccess {
  readonly ok: true;
  readonly state: D23RaydiumAmmV4State;
  readonly orientation: RaydiumPairOrientation;
}

export interface RaydiumAmmParseFailure {
  readonly ok: false;
  readonly category: RaydiumParseErrorCategory;
  readonly message: string;
}

export type RaydiumAmmParseResult = RaydiumAmmParseSuccess | RaydiumAmmParseFailure;

export interface SplVaultParseSuccess {
  readonly ok: true;
  readonly state: D23SplTokenVaultState;
}

export interface SplVaultParseFailure {
  readonly ok: false;
  readonly category:
    | "INVALID_VAULT_LENGTH"
    | "UNAUTHORIZED_VAULT_OWNER"
    | "UNAUTHORIZED_VAULT_AUTHORITY"
    | "UNINITIALIZED_OR_FROZEN_VAULT"
    | "MINT_MISMATCH";
  readonly message: string;
}

export type SplVaultParseResult = SplVaultParseSuccess | SplVaultParseFailure;

/**
 * Validates that a string is a canonical 32-byte Solana base58 public key.
 * Requires actual 32-byte public-key decoding and canonical round-trip verification.
 */
export function isCanonicalSolanaBase58(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length < 32 || trimmed.length > 44) {
    return false;
  }
  try {
    const pubkey = new PublicKey(value);
    return pubkey.toBytes().length === 32 && pubkey.toBase58() === value;
  } catch {
    return false;
  }
}

/**
 * Parses Raydium AMM v4 752-byte binary account data with exact little-endian u64 reads.
 */
export function parseRaydiumAmmV4Account(
  data: Uint8Array | Buffer,
  poolAddress: string,
  ownerProgramId?: string | undefined,
  accountSlot?: number | undefined,
): RaydiumAmmParseResult {
  if (!data || data.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_BUFFER_LENGTH",
      message: `Expected Raydium AMM v4 buffer of exactly ${RAYDIUM_AMM_V4_LAYOUT_LENGTH} bytes, received ${data?.length ?? 0}`,
    };
  }

  if (ownerProgramId !== undefined && ownerProgramId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_OWNER_PROGRAM",
      message: `Account owner ${ownerProgramId || "MISSING"} does not match canonical Raydium AMM v4 program ${RAYDIUM_AMM_V4_PROGRAM_ID}`,
    };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  try {
    const status = view.getBigUint64(RAYDIUM_V4_OFFSETS.STATUS, true);
    const nonce = view.getBigUint64(RAYDIUM_V4_OFFSETS.NONCE, true);
    const baseDecimal = view.getBigUint64(RAYDIUM_V4_OFFSETS.BASE_DECIMAL, true);
    const quoteDecimal = view.getBigUint64(RAYDIUM_V4_OFFSETS.QUOTE_DECIMAL, true);

    if (baseDecimal > 18n || quoteDecimal > 18n) {
      return {
        ok: false,
        category: "INVALID_DECIMALS",
        message: `Token decimals out of realistic bounds: baseDecimal=${baseDecimal}, quoteDecimal=${quoteDecimal}`,
      };
    }

    const baseVaultBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.BASE_VAULT,
      RAYDIUM_V4_OFFSETS.BASE_VAULT + 32,
    );
    const quoteVaultBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.QUOTE_VAULT,
      RAYDIUM_V4_OFFSETS.QUOTE_VAULT + 32,
    );
    const baseMintBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.BASE_MINT,
      RAYDIUM_V4_OFFSETS.BASE_MINT + 32,
    );
    const quoteMintBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.QUOTE_MINT,
      RAYDIUM_V4_OFFSETS.QUOTE_MINT + 32,
    );
    const lpMintBytes = data.subarray(RAYDIUM_V4_OFFSETS.LP_MINT, RAYDIUM_V4_OFFSETS.LP_MINT + 32);
    const openOrdersBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.OPEN_ORDERS,
      RAYDIUM_V4_OFFSETS.OPEN_ORDERS + 32,
    );
    const marketIdBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.MARKET_ID,
      RAYDIUM_V4_OFFSETS.MARKET_ID + 32,
    );
    const marketProgramIdBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.MARKET_PROGRAM_ID,
      RAYDIUM_V4_OFFSETS.MARKET_PROGRAM_ID + 32,
    );
    const targetOrdersBytes = data.subarray(
      RAYDIUM_V4_OFFSETS.TARGET_ORDERS,
      RAYDIUM_V4_OFFSETS.TARGET_ORDERS + 32,
    );

    const baseVault = encodeBase58(baseVaultBytes);
    const quoteVault = encodeBase58(quoteVaultBytes);
    const baseMint = encodeBase58(baseMintBytes);
    const quoteMint = encodeBase58(quoteMintBytes);
    const lpMint = encodeBase58(lpMintBytes);
    const openOrders = encodeBase58(openOrdersBytes);
    const marketId = encodeBase58(marketIdBytes);
    const marketProgramId = encodeBase58(marketProgramIdBytes);
    const targetOrders = encodeBase58(targetOrdersBytes);

    if (
      !isCanonicalSolanaBase58(baseVault) ||
      !isCanonicalSolanaBase58(quoteVault) ||
      !isCanonicalSolanaBase58(baseMint) ||
      !isCanonicalSolanaBase58(quoteMint)
    ) {
      return {
        ok: false,
        category: "INVALID_PUBKEY_ENCODING",
        message: "Failed to decode base58 public keys from Raydium AMM v4 layout",
      };
    }

    const baseNeedTakePnl = view.getBigUint64(RAYDIUM_V4_OFFSETS.BASE_NEED_TAKE_PNL, true);
    const quoteNeedTakePnl = view.getBigUint64(RAYDIUM_V4_OFFSETS.QUOTE_NEED_TAKE_PNL, true);
    const quoteTotalPnl = view.getBigUint64(RAYDIUM_V4_OFFSETS.QUOTE_TOTAL_PNL, true);
    const baseTotalPnl = view.getBigUint64(RAYDIUM_V4_OFFSETS.BASE_TOTAL_PNL, true);
    const lpReserve = view.getBigUint64(RAYDIUM_V4_OFFSETS.LP_RESERVE, true);

    let orientation: RaydiumPairOrientation = "NON_SOL_PAIR";
    if (quoteMint === WSOL_MINT) {
      orientation = "TOKEN_BASE_SOL_QUOTE";
    } else if (baseMint === WSOL_MINT) {
      orientation = "SOL_BASE_TOKEN_QUOTE";
    }

    const state: D23RaydiumAmmV4State = {
      status,
      nonce,
      baseDecimal,
      quoteDecimal,
      baseVault,
      quoteVault,
      baseMint,
      quoteMint,
      lpMint,
      openOrders,
      marketId,
      marketProgramId,
      targetOrders,
      baseNeedTakePnl,
      quoteNeedTakePnl,
      quoteTotalPnl,
      baseTotalPnl,
      lpReserve,
      poolAddress,
      programId: RAYDIUM_AMM_V4_PROGRAM_ID,
      ...(accountSlot !== undefined ? { accountSlot } : {}),
    };

    return {
      ok: true,
      state,
      orientation,
    };
  } catch (err) {
    return {
      ok: false,
      category: "CORRUPTED_LAYOUT",
      message: `Exception decoding Raydium AMM v4 layout: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Parses an SPL Token Vault Account buffer (165 bytes).
 */
export function parseSplTokenVaultAccount(
  data: Uint8Array | Buffer,
  vaultAddress: string,
  expectedMintAddress?: string | undefined,
  ownerProgramId?: string | undefined,
  accountSlot?: number | undefined,
  expectedAuthorityAddress?: string | undefined,
): SplVaultParseResult {
  if (!data || data.length !== SPL_VAULT_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_VAULT_LENGTH",
      message: `Expected SPL token vault buffer of ${SPL_VAULT_LAYOUT_LENGTH} bytes, received ${data?.length ?? 0}`,
    };
  }

  if (ownerProgramId !== undefined && ownerProgramId !== SPL_TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_OWNER",
      message: `Token vault owner ${ownerProgramId || "MISSING"} does not match canonical SPL Token Program ${SPL_TOKEN_PROGRAM_ID}`,
    };
  }

  const mintBytes = data.subarray(SPL_VAULT_OFFSETS.MINT, SPL_VAULT_OFFSETS.MINT + 32);
  const ownerBytes = data.subarray(SPL_VAULT_OFFSETS.OWNER, SPL_VAULT_OFFSETS.OWNER + 32);
  const mintAddress = encodeBase58(mintBytes);
  const ownerAddress = encodeBase58(ownerBytes);

  if (expectedMintAddress && mintAddress !== expectedMintAddress) {
    return {
      ok: false,
      category: "MINT_MISMATCH",
      message: `Vault mint ${mintAddress} does not match expected pool mint ${expectedMintAddress}`,
    };
  }

  if (expectedAuthorityAddress && ownerAddress !== expectedAuthorityAddress) {
    return {
      ok: false,
      category: "UNAUTHORIZED_VAULT_AUTHORITY",
      message: `Vault authority ${ownerAddress} does not match expected authority ${expectedAuthorityAddress}`,
    };
  }

  // Validate SPL Token AccountState at offset 108 (BREADY-03)
  const accountState = data[SPL_VAULT_OFFSETS.STATE];
  if (accountState !== 1) {
    return {
      ok: false,
      category: "UNINITIALIZED_OR_FROZEN_VAULT",
      message: `Token vault account state is ${accountState === 0 ? "UNINITIALIZED" : accountState === 2 ? "FROZEN" : "INVALID"} (expected 1: INITIALIZED)`,
    };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawAmount = view.getBigUint64(SPL_VAULT_OFFSETS.AMOUNT, true);

  const state: D23SplTokenVaultState = {
    vaultAddress,
    mintAddress,
    ownerAddress,
    rawAmount,
    ...(accountSlot !== undefined ? { slot: accountSlot } : {}),
  };

  return {
    ok: true,
    state,
  };
}

/**
 * Computes reserve accounting and spot pricing based on verified vault balances and pair orientation (D23P-02).
 * Correctly distinguishes vault-only proxy observations from complete AMM accounting.
 */
export function computeReserveAccounting(
  poolState: D23RaydiumAmmV4State,
  baseVaultRaw: bigint,
  quoteVaultRaw: bigint,
  mode: "VAULT_ONLY_PROXY" | "COMPLETE_AMM_ACCOUNTING" = "VAULT_ONLY_PROXY",
): D23ReserveAccounting {
  const isSolQuote = poolState.quoteMint === WSOL_MINT;
  const isSolBase = poolState.baseMint === WSOL_MINT;

  let orientation: RaydiumPairOrientation = "NON_SOL_PAIR";
  let tokenMint = poolState.baseMint;
  let solMint = poolState.quoteMint;
  let tokenDecimals = Number(poolState.baseDecimal);
  let solDecimals = Number(poolState.quoteDecimal);
  let tokenReserveRaw = baseVaultRaw;
  let solReserveRaw = quoteVaultRaw;

  if (isSolQuote) {
    orientation = "TOKEN_BASE_SOL_QUOTE";
    tokenMint = poolState.baseMint;
    solMint = poolState.quoteMint;
    tokenDecimals = Number(poolState.baseDecimal);
    solDecimals = Number(poolState.quoteDecimal);
    tokenReserveRaw = baseVaultRaw;
    solReserveRaw = quoteVaultRaw;
  } else if (isSolBase) {
    orientation = "SOL_BASE_TOKEN_QUOTE";
    tokenMint = poolState.quoteMint;
    solMint = poolState.baseMint;
    tokenDecimals = Number(poolState.quoteDecimal);
    solDecimals = Number(poolState.baseDecimal);
    tokenReserveRaw = quoteVaultRaw;
    solReserveRaw = baseVaultRaw;
  }

  const tokenDivisor = 10 ** tokenDecimals;
  const solDivisor = 10 ** solDecimals;

  const tokenReserveDecimal = Number(tokenReserveRaw) / tokenDivisor;
  const solReserveDecimal = Number(solReserveRaw) / solDivisor;

  let spotPriceSol: number | null = null;
  if (tokenReserveDecimal > 0 && solReserveDecimal >= 0 && orientation !== "NON_SOL_PAIR") {
    spotPriceSol = solReserveDecimal / tokenReserveDecimal;
  }

  // D23P-02: Under VAULT_ONLY_PROXY mode, OpenOrders inventory and takePnL adjustments are absent.
  // Effective reserves and execution feasibility are explicitly marked unavailable.
  const isComplete = mode === "COMPLETE_AMM_ACCOUNTING";

  return {
    mode,
    tokenMint,
    solMint,
    tokenReserveRaw,
    solReserveRaw,
    tokenDecimals,
    solDecimals,
    tokenReserveDecimal,
    solReserveDecimal,
    spotPriceSol,
    orientation,
    effectiveReservesAvailable: isComplete,
    executionFeasible: isComplete && tokenReserveDecimal > 0 && solReserveDecimal > 0,
    unavailabilityReason: isComplete
      ? undefined
      : "VAULT_ONLY_RESERVES_INSUFFICIENT_FOR_FEASIBILITY",
  };
}

export {
  calculateAmmV4LpInaccessibleClaims,
  type AmmV4LpAccountingFailure,
  type AmmV4LpAccountingFailureCategory,
  type AmmV4LpAccountingResult,
  type AmmV4LpAccountingSuccess,
} from "./RaydiumAmmLpAccounting.js";

export {
  deriveRaydiumAmmAuthority,
  validateRaydiumAmmV4Snapshot,
  isValidStrictBase64,
  RAYDIUM_AMM_AUTHORITY_SEED,
  SPL_MINT_LAYOUT_LENGTH,
  type DecodedSplLpMint,
  type DerivedAmmAuthority,
  type EvidenceOrigin,
  type RaydiumAmmV4SnapshotFailureCategory,
  type RaydiumAmmV4SnapshotIdentities,
  type RaydiumAmmV4SnapshotOptions,
  type RaydiumAmmV4SnapshotValidationFailure,
  type RaydiumAmmV4SnapshotValidationResult,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "./RaydiumAmmV4SnapshotValidator.js";

export { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
