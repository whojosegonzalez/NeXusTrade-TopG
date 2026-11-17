/**
 * Isolated Pure Raydium CPMM Pool-State Adapter
 *
 * Implements strict, offline verification and normalization of Raydium Constant-Product
 * Market Maker (CPMM) on-chain pool states (Anchor zero_copy PoolState, 637 bytes total /
 * 629 bytes packed struct, #[repr(C, packed)]) and their corresponding SPL Token vaults (165 bytes).
 *
 * Requirements (§8.38.17):
 * 1. Protocol fields:
 *    - creator_fee_on values: 0 (BothToken), 1 (OnlyToken0), 2 (OnlyToken1). Values > 2 refused.
 *    - enable_creator_fee: encoded 0 or 1. Values > 1 refused.
 *    - status: decoded as a bitmask (0..7). Statuses 0-3 allow swaps; 4-7 disable swaps.
 *      Returns poolStatus (number) and swapEnabledByStatus (boolean). Higher bits refused.
 *    - No zero-padding requirement (arbitrary padding bytes accepted).
 *    - Structural success describes only the supplied snapshot; it is NOT strategy admission
 *      or proof that swapActivationTimeSec has passed. Freshness and deployed bytecode remain unverified.
 * 2. Identity & Anti-Manufacturing:
 *    - Supplied account addresses validated independently against target and pool-recorded vaults.
 *    - Canonical address validation allows PDAs (does not require addresses to be on-curve).
 *    - Target candidate mint must differ from WSOL.
 *    - Exactly one pool mint must be WSOL, and the other must match candidateMint.
 *    - Canonical byte ordering token_0_mint < token_1_mint enforced.
 *    - Duplicate mints rejected fail-closed with IDENTICAL_MINTS.
 * 3. Reviewed boundaries:
 *    - Canonical SPL Token only (Token-2022 strictly rejected).
 *    - Authority bump must equal canonical bump 253 (0xfd).
 *    - Initialized vaults (account state 1), verified owners, mints, and canonical authority.
 *    - Mandatory valid equal slots (safe non-negative integers).
 *    - Authoritative BigInt reserves, fees, and activation time; approximate numeric values labelled Approx.
 *    - WSOL recorded decimals must equal exactly 9.
 *    - LP supply remains pool-reported metadata, with no burn/lock claim.
 */

import {
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_OFFSETS,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
  parseCpmmVaultAccount,
  parseRaydiumCpmmAccount,
} from "../research/pilot/RaydiumCpmmParser.js";
import { isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";

export { RAYDIUM_CPMM_LAYOUT_LENGTH, RAYDIUM_CPMM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, WSOL_MINT };

export const CANONICAL_CPMM_AUTH_BUMP = 253;

export interface RaydiumCpmmPoolTarget {
  readonly poolAddress: string;
  readonly candidateMint: string;
}

export interface RaydiumCpmmRawAccount {
  readonly address: string;
  readonly data: Uint8Array | Buffer;
  readonly ownerProgramId: string;
  readonly slot: number;
}

export interface RaydiumCpmmPoolStateInput {
  readonly target: RaydiumCpmmPoolTarget;
  readonly poolAccount: RaydiumCpmmRawAccount;
  readonly vault0Account: RaydiumCpmmRawAccount;
  readonly vault1Account: RaydiumCpmmRawAccount;
}

export type RaydiumCpmmPairOrientation =
  | "TOKEN_0_BASE_WSOL_QUOTE" // token_0 is candidate, token_1 is WSOL
  | "TOKEN_1_BASE_WSOL_QUOTE"; // token_1 is candidate, token_0 is WSOL

export interface RaydiumCpmmPoolStateSuccess {
  readonly ok: true;
  readonly poolAddress: string;
  readonly candidateMint: string;
  readonly wsolMint: string;
  readonly orientation: RaydiumCpmmPairOrientation;
  readonly baseDecimals: number;
  readonly quoteDecimals: number; // Exactly 9
  readonly baseVaultAddress: string;
  readonly quoteVaultAddress: string;
  readonly baseVaultRaw: bigint;
  readonly quoteVaultRaw: bigint;
  readonly baseTotalFeesRaw: bigint;
  readonly quoteTotalFeesRaw: bigint;
  readonly baseEffectiveReserveRaw: bigint;
  readonly quoteEffectiveReserveRaw: bigint;
  readonly baseEffectiveReserveApproxDecimal: number;
  readonly quoteEffectiveReserveApproxDecimal: number;
  readonly spotPriceSolApprox: number;
  readonly swapActivationTimeSec: bigint;
  readonly poolStatus: number;
  readonly swapEnabledByStatus: boolean;
  readonly lpMint: string;
  readonly lpSupply: bigint;
  readonly verification: {
    readonly ownerVerified: true;
    readonly vaultAuthoritiesVerified: true;
    readonly tokenProgramsVerified: true;
    readonly authBumpVerified: true;
    readonly slotProvenance: {
      readonly poolSlot: number;
      readonly vault0Slot: number;
      readonly vault1Slot: number;
      readonly consistentSlot: number;
    };
  };
}

export type RaydiumCpmmPoolStateRefusalCode =
  | "ADDRESS_MALFORMED"
  | "POOL_BUFFER_INVALID_LENGTH"
  | "POOL_DISCRIMINATOR_MISMATCH"
  | "POOL_OWNER_UNAUTHORIZED"
  | "POOL_ADDRESS_MISMATCH"
  | "CANDIDATE_MINT_IS_WSOL"
  | "CANDIDATE_MINT_MISMATCH"
  | "NON_WSOL_PAIR"
  | "IDENTICAL_MINTS"
  | "CANONICAL_MINT_ORDER_VIOLATED"
  | "CONTRADICTORY_VAULTS"
  | "AUTH_BUMP_INVALID"
  | "INVALID_STATUS"
  | "MALFORMED_CREATOR_FEE_FLAG"
  | "CORRUPTED_LAYOUT"
  | "UNSUPPORTED_TOKEN_PROGRAM"
  | "INVALID_DECIMALS"
  | "WSOL_DECIMALS_INVALID"
  | "VAULT_BUFFER_INVALID_LENGTH"
  | "VAULT_ADDRESS_MISMATCH"
  | "VAULT_OWNER_UNAUTHORIZED"
  | "VAULT_MINT_MISMATCH"
  | "VAULT_AUTHORITY_UNAUTHORIZED"
  | "VAULT_STATE_NOT_INITIALIZED"
  | "INSOLVENT_RESERVES"
  | "ZERO_EFFECTIVE_RESERVES"
  | "SLOT_PROVENANCE_MISSING_OR_INVALID"
  | "SLOT_DISCREPANCY";

export interface RaydiumCpmmPoolStateFailure {
  readonly ok: false;
  readonly refusalCode: RaydiumCpmmPoolStateRefusalCode;
  readonly message: string;
}

export type RaydiumCpmmPoolStateResult = RaydiumCpmmPoolStateSuccess | RaydiumCpmmPoolStateFailure;

function isValidSlot(slot: unknown): slot is number {
  return typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0;
}

function mapVaultFailure(category: string, message: string): RaydiumCpmmPoolStateFailure {
  switch (category) {
    case "VAULT_ADDRESS_MISMATCH":
      return { ok: false, refusalCode: "VAULT_ADDRESS_MISMATCH", message };
    case "UNSUPPORTED_TOKEN_2022":
    case "UNAUTHORIZED_VAULT_OWNER":
      return { ok: false, refusalCode: "VAULT_OWNER_UNAUTHORIZED", message };
    case "INVALID_VAULT_LENGTH":
      return { ok: false, refusalCode: "VAULT_BUFFER_INVALID_LENGTH", message };
    case "VAULT_MINT_MISMATCH":
      return { ok: false, refusalCode: "VAULT_MINT_MISMATCH", message };
    case "UNAUTHORIZED_VAULT_AUTHORITY":
      return { ok: false, refusalCode: "VAULT_AUTHORITY_UNAUTHORIZED", message };
    case "UNINITIALIZED_OR_FROZEN_VAULT":
      return { ok: false, refusalCode: "VAULT_STATE_NOT_INITIALIZED", message };
    default:
      return { ok: false, refusalCode: "CORRUPTED_LAYOUT", message };
  }
}

export function adaptRaydiumCpmmPoolState(
  input: RaydiumCpmmPoolStateInput,
): RaydiumCpmmPoolStateResult {
  const { target, poolAccount, vault0Account, vault1Account } = input;

  // 1. Validate addresses (allow PDAs, base58 check without on-curve requirement)
  const addressesToValidate = [
    { label: "target.poolAddress", value: target?.poolAddress },
    { label: "target.candidateMint", value: target?.candidateMint },
    { label: "poolAccount.address", value: poolAccount?.address },
    { label: "vault0Account.address", value: vault0Account?.address },
    { label: "vault1Account.address", value: vault1Account?.address },
  ];

  for (const { label, value } of addressesToValidate) {
    if (!isCanonicalSolanaBase58(value)) {
      return {
        ok: false,
        refusalCode: "ADDRESS_MALFORMED",
        message: `Field ${label} contains malformed Solana public key: ${String(value)}`,
      };
    }
  }

  // 2. Candidate mint cannot be WSOL
  if (target.candidateMint === WSOL_MINT) {
    return {
      ok: false,
      refusalCode: "CANDIDATE_MINT_IS_WSOL",
      message: `Target candidateMint cannot be canonical WSOL (${WSOL_MINT})`,
    };
  }

  // 3. Target pool address binding
  if (poolAccount.address !== target.poolAddress) {
    return {
      ok: false,
      refusalCode: "POOL_ADDRESS_MISMATCH",
      message: `Supplied poolAccount address ${poolAccount.address} does not match target poolAddress ${target.poolAddress}`,
    };
  }

  // 4. Strict slot provenance and consistency policy
  if (
    !isValidSlot(poolAccount.slot) ||
    !isValidSlot(vault0Account.slot) ||
    !isValidSlot(vault1Account.slot)
  ) {
    return {
      ok: false,
      refusalCode: "SLOT_PROVENANCE_MISSING_OR_INVALID",
      message: `Account slots must be defined, non-negative safe integers. Got pool: ${poolAccount.slot}, vault0: ${vault0Account.slot}, vault1: ${vault1Account.slot}`,
    };
  }

  if (poolAccount.slot !== vault0Account.slot || vault0Account.slot !== vault1Account.slot) {
    return {
      ok: false,
      refusalCode: "SLOT_DISCREPANCY",
      message: `Discrepancy detected across account slots: pool=${poolAccount.slot}, vault0=${vault0Account.slot}, vault1=${vault1Account.slot}`,
    };
  }
  const consistentSlot = poolAccount.slot;

  // 5. Pool buffer length check
  if (!poolAccount.data || poolAccount.data.length !== RAYDIUM_CPMM_LAYOUT_LENGTH) {
    return {
      ok: false,
      refusalCode: "POOL_BUFFER_INVALID_LENGTH",
      message: `Expected pool buffer length of exactly ${RAYDIUM_CPMM_LAYOUT_LENGTH} bytes, received ${poolAccount.data?.length ?? 0}`,
    };
  }

  // 6. Pool account owner check
  if (poolAccount.ownerProgramId !== RAYDIUM_CPMM_PROGRAM_ID) {
    return {
      ok: false,
      refusalCode: "POOL_OWNER_UNAUTHORIZED",
      message: `Pool owner program ${poolAccount.ownerProgramId} does not match canonical CPMM program ${RAYDIUM_CPMM_PROGRAM_ID}`,
    };
  }

  // 7. Decode pool account
  const parseResult = parseRaydiumCpmmAccount(
    poolAccount.data,
    poolAccount.address,
    poolAccount.ownerProgramId,
    poolAccount.slot,
  );

  if (!parseResult.ok) {
    switch (parseResult.category) {
      case "INVALID_BUFFER_LENGTH":
        return {
          ok: false,
          refusalCode: "POOL_BUFFER_INVALID_LENGTH",
          message: parseResult.message,
        };
      case "INVALID_ANCHOR_DISCRIMINATOR":
        return {
          ok: false,
          refusalCode: "POOL_DISCRIMINATOR_MISMATCH",
          message: parseResult.message,
        };
      case "UNAUTHORIZED_OWNER_PROGRAM":
        return { ok: false, refusalCode: "POOL_OWNER_UNAUTHORIZED", message: parseResult.message };
      case "UNSUPPORTED_TOKEN_PROGRAM":
        return {
          ok: false,
          refusalCode: "UNSUPPORTED_TOKEN_PROGRAM",
          message: parseResult.message,
        };
      case "CONTRADICTORY_MINTS":
        return { ok: false, refusalCode: "IDENTICAL_MINTS", message: parseResult.message };
      case "CONTRADICTORY_VAULTS":
        return { ok: false, refusalCode: "CONTRADICTORY_VAULTS", message: parseResult.message };
      case "INVALID_DECIMALS":
        return { ok: false, refusalCode: "INVALID_DECIMALS", message: parseResult.message };
      case "INVALID_PUBKEY_ENCODING":
        return { ok: false, refusalCode: "ADDRESS_MALFORMED", message: parseResult.message };
      case "MALFORMED_CREATOR_FEE_FLAG":
        return {
          ok: false,
          refusalCode: "MALFORMED_CREATOR_FEE_FLAG",
          message: parseResult.message,
        };
      case "CORRUPTED_LAYOUT":
      default:
        return { ok: false, refusalCode: "CORRUPTED_LAYOUT", message: parseResult.message };
    }
  }

  const { state } = parseResult;

  // 8. Strict canonical SPL token program enforcement (reject Token-2022)
  if (
    state.token0Program !== SPL_TOKEN_PROGRAM_ID ||
    state.token1Program !== SPL_TOKEN_PROGRAM_ID
  ) {
    return {
      ok: false,
      refusalCode: "UNSUPPORTED_TOKEN_PROGRAM",
      message: `Token programs must be canonical SPL Token (${SPL_TOKEN_PROGRAM_ID}). Received token0=${state.token0Program}, token1=${state.token1Program}`,
    };
  }

  // 9. Canonical authority bump check (must be 253)
  if (state.authBump !== CANONICAL_CPMM_AUTH_BUMP) {
    return {
      ok: false,
      refusalCode: "AUTH_BUMP_INVALID",
      message: `Pool auth_bump ${state.authBump} does not match canonical bump ${CANONICAL_CPMM_AUTH_BUMP}`,
    };
  }

  // 10. Status bitmask check (statuses 0-3 allow swaps; 4-7 disable swaps; > 7 refused)
  if (state.status > 7) {
    return {
      ok: false,
      refusalCode: "INVALID_STATUS",
      message: `Pool status ${state.status} exceeds known 3-bit status mask (0..7)`,
    };
  }
  const poolStatus = state.status;
  const swapEnabledByStatus = (state.status & 4) === 0;

  // 11. Canonical byte ordering token_0_mint < token_1_mint
  const poolBytes = Buffer.isBuffer(poolAccount.data)
    ? poolAccount.data
    : Buffer.from(poolAccount.data);
  const mint0Bytes = poolBytes.subarray(
    RAYDIUM_CPMM_OFFSETS.TOKEN_0_MINT,
    RAYDIUM_CPMM_OFFSETS.TOKEN_0_MINT + 32,
  );
  const mint1Bytes = poolBytes.subarray(
    RAYDIUM_CPMM_OFFSETS.TOKEN_1_MINT,
    RAYDIUM_CPMM_OFFSETS.TOKEN_1_MINT + 32,
  );

  const mintCmp = Buffer.compare(mint0Bytes, mint1Bytes);
  if (mintCmp === 0) {
    return {
      ok: false,
      refusalCode: "IDENTICAL_MINTS",
      message: `Pool token_0_mint and token_1_mint are identical (${state.token0Mint})`,
    };
  }
  if (mintCmp > 0) {
    return {
      ok: false,
      refusalCode: "CANONICAL_MINT_ORDER_VIOLATED",
      message: `Pool token_0_mint (${state.token0Mint}) must be canonically less than token_1_mint (${state.token1Mint})`,
    };
  }

  // 12. Contradictory vaults check
  if (state.token0Vault === state.token1Vault) {
    return {
      ok: false,
      refusalCode: "CONTRADICTORY_VAULTS",
      message: `Pool token_0_vault and token_1_vault are identical (${state.token0Vault})`,
    };
  }

  // 13. Pair matching & orientation resolution
  let orientation: RaydiumCpmmPairOrientation;
  let baseDecimals: number;
  let quoteDecimals: number;

  if (state.token1Mint === WSOL_MINT) {
    if (state.token0Mint !== target.candidateMint) {
      return {
        ok: false,
        refusalCode: "CANDIDATE_MINT_MISMATCH",
        message: `Pool base mint ${state.token0Mint} does not match target candidateMint ${target.candidateMint}`,
      };
    }
    orientation = "TOKEN_0_BASE_WSOL_QUOTE";
    baseDecimals = state.mint0Decimals;
    quoteDecimals = state.mint1Decimals;
  } else if (state.token0Mint === WSOL_MINT) {
    if (state.token1Mint !== target.candidateMint) {
      return {
        ok: false,
        refusalCode: "CANDIDATE_MINT_MISMATCH",
        message: `Pool base mint ${state.token1Mint} does not match target candidateMint ${target.candidateMint}`,
      };
    }
    orientation = "TOKEN_1_BASE_WSOL_QUOTE";
    baseDecimals = state.mint1Decimals;
    quoteDecimals = state.mint0Decimals;
  } else {
    return {
      ok: false,
      refusalCode: "NON_WSOL_PAIR",
      message: `Pool does not contain canonical WSOL (${WSOL_MINT}) on either side: mint0=${state.token0Mint}, mint1=${state.token1Mint}`,
    };
  }

  // 14. Decimals validation
  if (quoteDecimals !== 9) {
    return {
      ok: false,
      refusalCode: "WSOL_DECIMALS_INVALID",
      message: `WSOL recorded decimals in pool state must be exactly 9, received ${quoteDecimals}`,
    };
  }
  if (baseDecimals > 18 || state.lpMintDecimals > 18) {
    return {
      ok: false,
      refusalCode: "INVALID_DECIMALS",
      message: `Token decimals out of bounds: base=${baseDecimals}, lp=${state.lpMintDecimals}`,
    };
  }

  // 15. Vault 0 verification
  if (vault0Account.address !== state.token0Vault) {
    return {
      ok: false,
      refusalCode: "VAULT_ADDRESS_MISMATCH",
      message: `Supplied vault0Account address ${vault0Account.address} does not match pool token_0_vault ${state.token0Vault}`,
    };
  }
  const vault0Parse = parseCpmmVaultAccount(
    vault0Account.data,
    vault0Account.address,
    state.token0Vault,
    state.token0Mint,
    state.token0Program,
    vault0Account.ownerProgramId,
    vault0Account.slot,
  );
  if (!vault0Parse.ok) {
    return mapVaultFailure(vault0Parse.category, vault0Parse.message);
  }

  // 16. Vault 1 verification
  if (vault1Account.address !== state.token1Vault) {
    return {
      ok: false,
      refusalCode: "VAULT_ADDRESS_MISMATCH",
      message: `Supplied vault1Account address ${vault1Account.address} does not match pool token_1_vault ${state.token1Vault}`,
    };
  }
  const vault1Parse = parseCpmmVaultAccount(
    vault1Account.data,
    vault1Account.address,
    state.token1Vault,
    state.token1Mint,
    state.token1Program,
    vault1Account.ownerProgramId,
    vault1Account.slot,
  );
  if (!vault1Parse.ok) {
    return mapVaultFailure(vault1Parse.category, vault1Parse.message);
  }

  // 17. Fee liability deduction and reserve insolvency check
  const vault0Raw = vault0Parse.snapshot.rawAmount;
  const vault1Raw = vault1Parse.snapshot.rawAmount;

  const totalFees0 = state.protocolFeesToken0 + state.fundFeesToken0 + state.creatorFeesToken0;
  const totalFees1 = state.protocolFeesToken1 + state.fundFeesToken1 + state.creatorFeesToken1;

  if (vault0Raw < totalFees0 || vault1Raw < totalFees1) {
    return {
      ok: false,
      refusalCode: "INSOLVENT_RESERVES",
      message: `Vault balance less than accrued fee liabilities: vault0=${vault0Raw} < fees0=${totalFees0} or vault1=${vault1Raw} < fees1=${totalFees1}`,
    };
  }

  const effectiveReserve0 = vault0Raw - totalFees0;
  const effectiveReserve1 = vault1Raw - totalFees1;

  if (effectiveReserve0 === 0n || effectiveReserve1 === 0n) {
    return {
      ok: false,
      refusalCode: "ZERO_EFFECTIVE_RESERVES",
      message: `Effective reserve after fee deduction is zero: reserve0=${effectiveReserve0}, reserve1=${effectiveReserve1}`,
    };
  }

  // 18. Map to canonical base / quote fields
  const baseVaultAddress =
    orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? state.token0Vault : state.token1Vault;
  const quoteVaultAddress =
    orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? state.token1Vault : state.token0Vault;
  const baseVaultRaw = orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? vault0Raw : vault1Raw;
  const quoteVaultRaw = orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? vault1Raw : vault0Raw;
  const baseTotalFeesRaw = orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? totalFees0 : totalFees1;
  const quoteTotalFeesRaw = orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? totalFees1 : totalFees0;
  const baseEffectiveReserveRaw =
    orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? effectiveReserve0 : effectiveReserve1;
  const quoteEffectiveReserveRaw =
    orientation === "TOKEN_0_BASE_WSOL_QUOTE" ? effectiveReserve1 : effectiveReserve0;

  const baseEffectiveReserveApproxDecimal =
    Number(baseEffectiveReserveRaw) / Math.pow(10, baseDecimals);
  const quoteEffectiveReserveApproxDecimal =
    Number(quoteEffectiveReserveRaw) / Math.pow(10, quoteDecimals);
  const spotPriceSolApprox = quoteEffectiveReserveApproxDecimal / baseEffectiveReserveApproxDecimal;

  return {
    ok: true,
    poolAddress: state.poolAddress,
    candidateMint: target.candidateMint,
    wsolMint: WSOL_MINT,
    orientation,
    baseDecimals,
    quoteDecimals,
    baseVaultAddress,
    quoteVaultAddress,
    baseVaultRaw,
    quoteVaultRaw,
    baseTotalFeesRaw,
    quoteTotalFeesRaw,
    baseEffectiveReserveRaw,
    quoteEffectiveReserveRaw,
    baseEffectiveReserveApproxDecimal,
    quoteEffectiveReserveApproxDecimal,
    spotPriceSolApprox,
    swapActivationTimeSec: state.swapActivationTimeSec,
    poolStatus,
    swapEnabledByStatus,
    lpMint: state.lpMint,
    lpSupply: state.lpSupply,
    verification: {
      ownerVerified: true,
      vaultAuthoritiesVerified: true,
      tokenProgramsVerified: true,
      authBumpVerified: true,
      slotProvenance: {
        poolSlot: poolAccount.slot,
        vault0Slot: vault0Account.slot,
        vault1Slot: vault1Account.slot,
        consistentSlot,
      },
    },
  };
}
