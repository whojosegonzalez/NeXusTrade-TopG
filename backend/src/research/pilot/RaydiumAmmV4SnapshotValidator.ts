/**
 * Phase 12.94-D Milestone D.3.3: Raydium AMM v4 Offline Snapshot Validator
 *
 * Implements strict offline validation of coherent JSON-RPC batch responses
 * for legacy Raydium AMM v4 pools and SPL token accounts:
 *   [poolId, lpMint, baseVault, quoteVault]
 *
 * Validates:
 * 1. Positive safe integer context slot (slot > 0 and Number.isSafeInteger(slot)).
 * 2. Complete, correctly ordered 4 account results.
 * 3. Exact 32-byte public-key canonical round-trip validation for all identities.
 * 4. Strict Base64 syntax and canonical encoding verification before decoding.
 * 5. Exact pool identity, expected token/WSOL pair, canonical program ownership:
 *    - RAYDIUM_AMM_V4_PROGRAM_ID (675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)
 *    - SPL_TOKEN_PROGRAM_ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
 *    - Supported account layouts: 752B pool, 82B mint, 165B vaults.
 * 6. Pool references matching requested LP mint, base vault, quote vault.
 * 7. Pool stored nonce at byte offset 8 matching derived AMM authority bump.
 * 8. Initialized legacy SPL LP mint, correctly decoded supply, decimals, and authority fields.
 * 9. Source-backed AMM authority derivation with mutation-protected cache:
 *    PublicKey.findProgramAddress([Buffer.from("amm authority")], programId) -> 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1, bump 254.
 * 10. Vault owners and LP mint authority matching derived AMM authority (or LP mint authority null/renounced).
 * 11. Correct vault mints and initialized, unfrozen vault accounts (accountState === 1).
 * 12. Pure mathematical BigInt LP calculation via calculateAmmV4LpInaccessibleClaims.
 *
 * Strict Evidence Boundary:
 * Preserves evidence without inventing provenance: missing provenance is represented
 * as UNKNOWN (not defaulted to captured RPC). Missing retrieval timestamps remain null
 * (validation time is never substituted). Requested identities are defensibly copied.
 * Statically guarantees evidenceBoundary assertions are false.
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_V4_OFFSETS,
  SPL_TOKEN_PROGRAM_ID,
  SPL_VAULT_LAYOUT_LENGTH,
  WSOL_MINT,
  isCanonicalSolanaBase58,
  parseRaydiumAmmV4Account,
  parseSplTokenVaultAccount,
} from "./RaydiumAmmParser.js";
import {
  calculateAmmV4LpInaccessibleClaims,
  type AmmV4LpAccountingSuccess,
} from "./RaydiumAmmLpAccounting.js";
import { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type { D23RaydiumAmmV4State, D23SplTokenVaultState } from "./PilotTypes.js";

export const SPL_MINT_LAYOUT_LENGTH = 82;
export const RAYDIUM_AMM_AUTHORITY_SEED = "amm authority";

export type EvidenceOrigin = "SYNTHETIC_FIXTURE" | "CAPTURED_RPC" | "UNKNOWN";

export interface RaydiumAmmV4SnapshotIdentities {
  readonly poolId: string;
  readonly lpMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly expectedTokenMint?: string | undefined;
}

export interface RaydiumAmmV4SnapshotOptions {
  readonly isSyntheticFixture?: boolean | undefined;
  readonly evidenceOrigin?: EvidenceOrigin | undefined;
  readonly retrievedAtIso?: string | null | undefined;
  readonly programId?: string | undefined;
}

export interface DecodedSplLpMint {
  readonly mintAddress: string;
  readonly mintAuthority: string | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthority: string | null;
}

export interface DerivedAmmAuthority {
  readonly address: string;
  readonly bump: number;
}

export type RaydiumAmmV4SnapshotFailureCategory =
  | "INVALID_IDENTITIES"
  | "INVALID_RPC_PAYLOAD"
  | "INVALID_CONTEXT_SLOT"
  | "INVALID_PROVENANCE_METADATA"
  | "INCOMPLETE_ACCOUNT_BATCH"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_BUFFER_EXTRACTION_FAILED"
  | "UNAUTHORIZED_PROGRAM_OWNER"
  | "INVALID_ACCOUNT_LAYOUT"
  | "INCONSISTENT_POOL_NONCE"
  | "POOL_REFERENCE_MISMATCH"
  | "NON_SOL_PAIR"
  | "TOKEN_MINT_MISMATCH"
  | "UNINITIALIZED_LP_MINT"
  | "UNAUTHORIZED_LP_AUTHORITY"
  | "UNAUTHORIZED_VAULT_AUTHORITY"
  | "VAULT_STATE_INVALID"
  | "VAULT_MINT_MISMATCH"
  | "LP_ACCOUNTING_CALCULATION_FAILED";

export interface RaydiumAmmV4SnapshotValidationSuccess {
  readonly ok: true;
  /** Pure mathematical LP claim accounting outcome */
  readonly accounting: AmmV4LpAccountingSuccess;
  /** Comprehensive evidence, provenance, and decoded state diagnostics */
  readonly diagnostics: {
    readonly slot: number;
    readonly evidenceOrigin: EvidenceOrigin;
    readonly isSyntheticFixture: boolean | null;
    readonly retrievedAtIso: string | null;
    readonly requestedIdentities: RaydiumAmmV4SnapshotIdentities;
    readonly poolState: D23RaydiumAmmV4State;
    readonly lpMintState: DecodedSplLpMint;
    readonly baseVaultState: D23SplTokenVaultState;
    readonly quoteVaultState: D23SplTokenVaultState;
    readonly derivedAmmAuthority: DerivedAmmAuthority;
    readonly accountDigests: {
      readonly poolSha256: string;
      readonly lpMintSha256: string;
      readonly baseVaultSha256: string;
      readonly quoteVaultSha256: string;
    };
  };
  /**
   * Explicit evidence boundary declarations.
   * Statically constrained to false: this validator explicitly does not certify
   * bytecode equivalence, complete executable reserves, token safety, or strategy gate admission.
   */
  readonly evidenceBoundary: {
    readonly bytecodeEquivalenceVerified: false;
    readonly completeExecutableReservesVerified: false;
    readonly generalTokenSafetyVerified: false;
    readonly strategyGateAdmitted: false;
  };
}

export interface RaydiumAmmV4SnapshotValidationFailure {
  readonly ok: false;
  readonly category: RaydiumAmmV4SnapshotFailureCategory;
  readonly message: string;
  readonly slot?: number | undefined;
  readonly accountIndex?: number | undefined;
  readonly accountAddress?: string | undefined;
}

export type RaydiumAmmV4SnapshotValidationResult =
  | RaydiumAmmV4SnapshotValidationSuccess
  | RaydiumAmmV4SnapshotValidationFailure;

const ammAuthorityCache = new Map<string, DerivedAmmAuthority>();

/**
 * Derives the canonical Raydium AMM authority PDA using official Solana tooling:
 * PublicKey.findProgramAddress([Buffer.from("amm authority")], programId).
 *
 * For canonical program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8,
 * this returns address 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 with bump 254.
 *
 * Returns an immutable, frozen defensive copy to prevent caller mutation of internal cache.
 */
export async function deriveRaydiumAmmAuthority(
  programId: string = RAYDIUM_AMM_V4_PROGRAM_ID,
): Promise<DerivedAmmAuthority> {
  const cached = ammAuthorityCache.get(programId);
  if (cached) {
    return Object.freeze({ address: cached.address, bump: cached.bump });
  }

  try {
    const programPubkey = new PublicKey(programId);
    const [pda, bump] = await PublicKey.findProgramAddress(
      [Buffer.from(RAYDIUM_AMM_AUTHORITY_SEED)],
      programPubkey,
    );
    const result: DerivedAmmAuthority = Object.freeze({ address: pda.toBase58(), bump });
    ammAuthorityCache.set(programId, result);
    return Object.freeze({ address: result.address, bump: result.bump });
  } catch (err) {
    throw new Error(
      `Failed to derive Raydium AMM authority for programId '${programId}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Strictly validates Base64 syntax and canonical encoding before decoding.
 * Prevents Node.js Buffer from silently accepting malformed characters (e.g. trailing '!').
 */
export function isValidStrictBase64(str: unknown): boolean {
  if (typeof str !== "string" || str.length === 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) {
    return false;
  }
  if (str.length % 4 !== 0) {
    return false;
  }
  try {
    const buf = Buffer.from(str, "base64");
    return buf.toString("base64") === str;
  } catch {
    return false;
  }
}

/**
 * Strictly validates that a string is a valid ISO 8601 timestamp representing an actual calendar date.
 * Rejects impossible dates (e.g. February 30) that Date.parse normalizes into another month.
 */
export function isValidIsoCalendarTimestamp(ts: unknown): boolean {
  if (typeof ts !== "string" || ts.trim() !== ts) {
    return false;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!match) {
    return false;
  }
  const [, yearStr, monthStr, dayStr, hourStr, minStr, secStr] = match;
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10);
  const day = parseInt(dayStr!, 10);
  const hour = parseInt(hourStr!, 10);
  const min = parseInt(minStr!, 10);
  const sec = parseInt(secStr!, 10);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return false;
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonths = [0, 31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonths[month]!) {
    return false;
  }

  return !Number.isNaN(Date.parse(ts));
}

/**
 * Validates a coherent offline snapshot batch response for a legacy Raydium AMM v4 pool.
 *
 * Expects the raw getMultipleAccounts response corresponding to requested identities:
 *   [poolId, lpMint, baseVault, quoteVault]
 */
export async function validateRaydiumAmmV4Snapshot(
  callerIdentities: RaydiumAmmV4SnapshotIdentities,
  payload: unknown,
  options?: RaydiumAmmV4SnapshotOptions,
): Promise<RaydiumAmmV4SnapshotValidationResult> {
  // Capture an immutable, frozen identity snapshot at entry before any asynchronous suspension
  const identities: RaydiumAmmV4SnapshotIdentities = Object.freeze({
    poolId: callerIdentities?.poolId,
    lpMint: callerIdentities?.lpMint,
    baseVault: callerIdentities?.baseVault,
    quoteVault: callerIdentities?.quoteVault,
    ...(callerIdentities?.expectedTokenMint !== undefined
      ? { expectedTokenMint: callerIdentities.expectedTokenMint }
      : {}),
  });

  // 1. Validate requested identities: actual 32-byte public-key decoding and canonical round-trip
  if (
    !isCanonicalSolanaBase58(identities.poolId) ||
    !isCanonicalSolanaBase58(identities.lpMint) ||
    !isCanonicalSolanaBase58(identities.baseVault) ||
    !isCanonicalSolanaBase58(identities.quoteVault) ||
    (identities.expectedTokenMint !== undefined &&
      !isCanonicalSolanaBase58(identities.expectedTokenMint))
  ) {
    return {
      ok: false,
      category: "INVALID_IDENTITIES",
      message: "One or more requested account identities are not valid Solana base58 public keys",
    };
  }

  const effectiveProgramId = options?.programId ?? RAYDIUM_AMM_V4_PROGRAM_ID;
  if (!isCanonicalSolanaBase58(effectiveProgramId)) {
    return {
      ok: false,
      category: "INVALID_IDENTITIES",
      message: `Invalid AMM programId: '${effectiveProgramId}' is not valid Solana base58`,
    };
  }

  // 2. Validate provenance options consistently without inventing evidence
  const ALLOWED_EVIDENCE_ORIGINS = new Set(["SYNTHETIC_FIXTURE", "CAPTURED_RPC", "UNKNOWN"]);

  if (
    options?.evidenceOrigin !== undefined &&
    !ALLOWED_EVIDENCE_ORIGINS.has(options.evidenceOrigin)
  ) {
    return {
      ok: false,
      category: "INVALID_PROVENANCE_METADATA",
      message: `Invalid evidenceOrigin: '${options.evidenceOrigin}' is not a supported provenance origin`,
    };
  }

  // Check contradiction between evidenceOrigin and isSyntheticFixture
  if (options?.evidenceOrigin !== undefined && options?.isSyntheticFixture !== undefined) {
    if (
      (options.evidenceOrigin === "SYNTHETIC_FIXTURE" && options.isSyntheticFixture !== true) ||
      (options.evidenceOrigin === "CAPTURED_RPC" && options.isSyntheticFixture !== false) ||
      (options.evidenceOrigin === "UNKNOWN" && options.isSyntheticFixture !== undefined)
    ) {
      return {
        ok: false,
        category: "INVALID_PROVENANCE_METADATA",
        message: `Contradictory provenance options: evidenceOrigin is '${options.evidenceOrigin}' but isSyntheticFixture is ${options.isSyntheticFixture}`,
      };
    }
  }

  let evidenceOrigin: EvidenceOrigin = "UNKNOWN";
  let isSyntheticFixture: boolean | null = null;

  if (options?.evidenceOrigin !== undefined) {
    evidenceOrigin = options.evidenceOrigin;
    isSyntheticFixture =
      evidenceOrigin === "SYNTHETIC_FIXTURE"
        ? true
        : evidenceOrigin === "CAPTURED_RPC"
          ? false
          : null;
  } else if (options?.isSyntheticFixture !== undefined) {
    if (typeof options.isSyntheticFixture !== "boolean") {
      return {
        ok: false,
        category: "INVALID_PROVENANCE_METADATA",
        message: `Invalid isSyntheticFixture: expected boolean, received ${typeof options.isSyntheticFixture}`,
      };
    }
    evidenceOrigin = options.isSyntheticFixture ? "SYNTHETIC_FIXTURE" : "CAPTURED_RPC";
    isSyntheticFixture = options.isSyntheticFixture;
  }

  // Validate retrievedAtIso timestamp: must be null if omitted, or a valid ISO 8601 calendar string if supplied
  let retrievedAtIso: string | null = null;
  if (options?.retrievedAtIso !== undefined && options?.retrievedAtIso !== null) {
    const ts = options.retrievedAtIso;
    if (!isValidIsoCalendarTimestamp(ts)) {
      return {
        ok: false,
        category: "INVALID_PROVENANCE_METADATA",
        message: `Invalid retrievedAtIso timestamp: '${ts}' is not a valid ISO 8601 calendar date`,
      };
    }
    retrievedAtIso = ts;
  }

  // 3. Extract context slot and account value array from JSON-RPC payload
  const extracted = extractRpcValueAndSlot(payload);
  if (extracted.error || extracted.value === null) {
    return {
      ok: false,
      category: "INVALID_RPC_PAYLOAD",
      message: extracted.error ?? "Failed to parse JSON-RPC payload",
      ...(extracted.slot !== null && typeof extracted.slot === "number"
        ? { slot: extracted.slot }
        : {}),
    };
  }

  const { slot, value } = extracted;

  // Validate context slot: strictly positive safe integer
  if (slot === null || typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
    return {
      ok: false,
      category: "INVALID_CONTEXT_SLOT",
      message: `Invalid RPC response context slot: expected positive safe integer, received ${slot ?? "null"}`,
      ...(slot !== null && typeof slot === "number" ? { slot } : {}),
    };
  }

  // Validate batch completeness: exactly 4 accounts
  if (value.length !== 4) {
    return {
      ok: false,
      category: "INCOMPLETE_ACCOUNT_BATCH",
      message: `Expected exactly 4 account entries in getMultipleAccounts response [pool, lpMint, baseVault, quoteVault], received ${value.length}`,
      slot,
    };
  }

  const accountKeys = [
    { name: "pool", address: identities.poolId },
    { name: "lpMint", address: identities.lpMint },
    { name: "baseVault", address: identities.baseVault },
    { name: "quoteVault", address: identities.quoteVault },
  ] as const;

  // 4. Extract raw account buffers with strict Base64 verification
  const rawBuffers: Buffer[] = [];
  const rawOwners: string[] = [];

  for (let idx = 0; idx < 4; idx++) {
    const rawAccount = value[idx] as Record<string, unknown> | null | undefined;
    const keyInfo = accountKeys[idx]!;

    if (!rawAccount || typeof rawAccount !== "object") {
      return {
        ok: false,
        category: "ACCOUNT_NOT_FOUND",
        message: `Account at index ${idx} (${keyInfo.name}: ${keyInfo.address}) was not found on-chain (null account value)`,
        slot,
        accountIndex: idx,
        accountAddress: keyInfo.address,
      };
    }

    if (typeof rawAccount.owner !== "string" || rawAccount.owner.trim() === "") {
      return {
        ok: false,
        category: "UNAUTHORIZED_PROGRAM_OWNER",
        message: `Account at index ${idx} (${keyInfo.name}: ${keyInfo.address}) is missing program owner metadata`,
        slot,
        accountIndex: idx,
        accountAddress: keyInfo.address,
      };
    }

    const buffer = extractAccountBuffer(rawAccount.data);
    if (!buffer) {
      return {
        ok: false,
        category: "ACCOUNT_BUFFER_EXTRACTION_FAILED",
        message: `Failed to extract binary account buffer at index ${idx} (${keyInfo.name}: ${keyInfo.address})`,
        slot,
        accountIndex: idx,
        accountAddress: keyInfo.address,
      };
    }

    rawBuffers.push(buffer);
    rawOwners.push(rawAccount.owner.trim());
  }

  const [poolBuffer, lpMintBuffer, baseVaultBuffer, quoteVaultBuffer] = rawBuffers as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  const [poolOwner, lpMintOwner, baseVaultOwner, quoteVaultOwner] = rawOwners as [
    string,
    string,
    string,
    string,
  ];

  // 5. Validate Account 0: Pool (`poolId`)
  if (poolOwner !== effectiveProgramId) {
    return {
      ok: false,
      category: "UNAUTHORIZED_PROGRAM_OWNER",
      message: `Pool account owner '${poolOwner}' does not match expected Raydium AMM program '${effectiveProgramId}'`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  if (poolBuffer.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Expected Raydium AMM v4 pool buffer of exactly ${RAYDIUM_AMM_V4_LAYOUT_LENGTH} bytes, received ${poolBuffer.length}`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  const poolParse = parseRaydiumAmmV4Account(poolBuffer, identities.poolId, poolOwner, slot);
  if (!poolParse.ok) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Raydium AMM v4 pool layout decode failed [${poolParse.category}]: ${poolParse.message}`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  const poolState = poolParse.state;

  // Verify pool references match requested identities
  if (poolState.lpMint !== identities.lpMint) {
    return {
      ok: false,
      category: "POOL_REFERENCE_MISMATCH",
      message: `Pool on-chain lpMint '${poolState.lpMint}' does not match requested lpMint '${identities.lpMint}'`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  if (poolState.baseVault !== identities.baseVault) {
    return {
      ok: false,
      category: "POOL_REFERENCE_MISMATCH",
      message: `Pool on-chain baseVault '${poolState.baseVault}' does not match requested baseVault '${identities.baseVault}'`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  if (poolState.quoteVault !== identities.quoteVault) {
    return {
      ok: false,
      category: "POOL_REFERENCE_MISMATCH",
      message: `Pool on-chain quoteVault '${poolState.quoteVault}' does not match requested quoteVault '${identities.quoteVault}'`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  // Verify WSOL pair orientation
  if (
    poolParse.orientation !== "TOKEN_BASE_SOL_QUOTE" &&
    poolParse.orientation !== "SOL_BASE_TOKEN_QUOTE"
  ) {
    return {
      ok: false,
      category: "NON_SOL_PAIR",
      message: `Pool pair (base: ${poolState.baseMint}, quote: ${poolState.quoteMint}) is not paired with WSOL (${WSOL_MINT})`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  // Verify expected token mint if specified by caller
  if (identities.expectedTokenMint !== undefined) {
    const observedTokenMint =
      poolParse.orientation === "TOKEN_BASE_SOL_QUOTE" ? poolState.baseMint : poolState.quoteMint;
    if (observedTokenMint !== identities.expectedTokenMint) {
      return {
        ok: false,
        category: "TOKEN_MINT_MISMATCH",
        message: `Pool observed token mint '${observedTokenMint}' does not match requested expectedTokenMint '${identities.expectedTokenMint}'`,
        slot,
        accountIndex: 0,
        accountAddress: identities.poolId,
      };
    }
  }

  // 6. Derive canonical AMM authority PDA
  let derivedAmmAuthority: DerivedAmmAuthority;
  try {
    derivedAmmAuthority = await deriveRaydiumAmmAuthority(effectiveProgramId);
  } catch (err) {
    return {
      ok: false,
      category: "INVALID_IDENTITIES",
      message: `Failed to derive canonical AMM authority: ${err instanceof Error ? err.message : String(err)}`,
      slot,
    };
  }

  // 7. Bind authority validation to pool state: decode pool's stored nonce at offset 8 and verify consistency
  const poolNonce = poolBuffer.readBigUInt64LE(RAYDIUM_V4_OFFSETS.NONCE);
  if (poolNonce !== BigInt(derivedAmmAuthority.bump)) {
    return {
      ok: false,
      category: "INCONSISTENT_POOL_NONCE",
      message: `Pool stored nonce (${poolNonce}) is inconsistent with derived AMM authority bump (${derivedAmmAuthority.bump})`,
      slot,
      accountIndex: 0,
      accountAddress: identities.poolId,
    };
  }

  // 8. Validate Account 1: LP Mint (`lpMint`)
  if (lpMintOwner !== SPL_TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_PROGRAM_OWNER",
      message: `LP mint owner '${lpMintOwner}' does not match canonical SPL Token Program '${SPL_TOKEN_PROGRAM_ID}'`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  if (lpMintBuffer.length !== SPL_MINT_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Expected SPL Token mint buffer of exactly ${SPL_MINT_LAYOUT_LENGTH} bytes, received ${lpMintBuffer.length}`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  const mintView = new DataView(
    lpMintBuffer.buffer,
    lpMintBuffer.byteOffset,
    lpMintBuffer.byteLength,
  );
  const mintAuthOption = mintView.getUint32(0, true);
  let mintAuthority: string | null = null;
  if (mintAuthOption === 1) {
    mintAuthority = encodeBase58(lpMintBuffer.subarray(4, 36));
  } else if (mintAuthOption !== 0) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Malformed LP mint layout: invalid mintAuthority COption tag ${mintAuthOption} (expected 0 or 1)`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  const supply = mintView.getBigUint64(36, true);
  const decimals = lpMintBuffer[44]!;
  const isInitialized = lpMintBuffer[45] === 1;

  if (!isInitialized) {
    return {
      ok: false,
      category: "UNINITIALIZED_LP_MINT",
      message: "LP mint account is uninitialized (byte 45 isInitialized !== 1)",
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  const freezeAuthOption = mintView.getUint32(46, true);
  let freezeAuthority: string | null = null;
  if (freezeAuthOption === 1) {
    freezeAuthority = encodeBase58(lpMintBuffer.subarray(50, 82));
  } else if (freezeAuthOption !== 0) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Malformed LP mint layout: invalid freezeAuthority COption tag ${freezeAuthOption} (expected 0 or 1)`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  // Validate LP Mint authority: must be derived AMM authority OR renounced (null)
  if (mintAuthority !== null && mintAuthority !== derivedAmmAuthority.address) {
    return {
      ok: false,
      category: "UNAUTHORIZED_LP_AUTHORITY",
      message: `LP mint authority '${mintAuthority}' does not match derived AMM authority '${derivedAmmAuthority.address}' and is not renounced (null)`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  // Validate LP Freeze authority: must be derived AMM authority OR null
  if (freezeAuthority !== null && freezeAuthority !== derivedAmmAuthority.address) {
    return {
      ok: false,
      category: "UNAUTHORIZED_LP_AUTHORITY",
      message: `LP freeze authority '${freezeAuthority}' does not match derived AMM authority '${derivedAmmAuthority.address}' and is not null`,
      slot,
      accountIndex: 1,
      accountAddress: identities.lpMint,
    };
  }

  const lpMintState: DecodedSplLpMint = {
    mintAddress: identities.lpMint,
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthority,
  };

  // 9. Validate Account 2: Base Vault (`baseVault`)
  if (baseVaultOwner !== SPL_TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_PROGRAM_OWNER",
      message: `Base vault owner '${baseVaultOwner}' does not match canonical SPL Token Program '${SPL_TOKEN_PROGRAM_ID}'`,
      slot,
      accountIndex: 2,
      accountAddress: identities.baseVault,
    };
  }

  if (baseVaultBuffer.length !== SPL_VAULT_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Expected SPL token vault buffer of exactly ${SPL_VAULT_LAYOUT_LENGTH} bytes for base vault, received ${baseVaultBuffer.length}`,
      slot,
      accountIndex: 2,
      accountAddress: identities.baseVault,
    };
  }

  const baseVaultParse = parseSplTokenVaultAccount(
    baseVaultBuffer,
    identities.baseVault,
    poolState.baseMint,
    SPL_TOKEN_PROGRAM_ID,
    slot,
    derivedAmmAuthority.address,
  );
  if (!baseVaultParse.ok) {
    const category: RaydiumAmmV4SnapshotFailureCategory =
      baseVaultParse.category === "MINT_MISMATCH"
        ? "VAULT_MINT_MISMATCH"
        : baseVaultParse.category === "UNAUTHORIZED_VAULT_AUTHORITY"
          ? "UNAUTHORIZED_VAULT_AUTHORITY"
          : baseVaultParse.category === "UNINITIALIZED_OR_FROZEN_VAULT"
            ? "VAULT_STATE_INVALID"
            : "INVALID_ACCOUNT_LAYOUT";

    return {
      ok: false,
      category,
      message: `Base vault validation failed [${baseVaultParse.category}]: ${baseVaultParse.message}`,
      slot,
      accountIndex: 2,
      accountAddress: identities.baseVault,
    };
  }

  // 10. Validate Account 3: Quote Vault (`quoteVault`)
  if (quoteVaultOwner !== SPL_TOKEN_PROGRAM_ID) {
    return {
      ok: false,
      category: "UNAUTHORIZED_PROGRAM_OWNER",
      message: `Quote vault owner '${quoteVaultOwner}' does not match canonical SPL Token Program '${SPL_TOKEN_PROGRAM_ID}'`,
      slot,
      accountIndex: 3,
      accountAddress: identities.quoteVault,
    };
  }

  if (quoteVaultBuffer.length !== SPL_VAULT_LAYOUT_LENGTH) {
    return {
      ok: false,
      category: "INVALID_ACCOUNT_LAYOUT",
      message: `Expected SPL token vault buffer of exactly ${SPL_VAULT_LAYOUT_LENGTH} bytes for quote vault, received ${quoteVaultBuffer.length}`,
      slot,
      accountIndex: 3,
      accountAddress: identities.quoteVault,
    };
  }

  const quoteVaultParse = parseSplTokenVaultAccount(
    quoteVaultBuffer,
    identities.quoteVault,
    poolState.quoteMint,
    SPL_TOKEN_PROGRAM_ID,
    slot,
    derivedAmmAuthority.address,
  );
  if (!quoteVaultParse.ok) {
    const category: RaydiumAmmV4SnapshotFailureCategory =
      quoteVaultParse.category === "MINT_MISMATCH"
        ? "VAULT_MINT_MISMATCH"
        : quoteVaultParse.category === "UNAUTHORIZED_VAULT_AUTHORITY"
          ? "UNAUTHORIZED_VAULT_AUTHORITY"
          : quoteVaultParse.category === "UNINITIALIZED_OR_FROZEN_VAULT"
            ? "VAULT_STATE_INVALID"
            : "INVALID_ACCOUNT_LAYOUT";

    return {
      ok: false,
      category,
      message: `Quote vault validation failed [${quoteVaultParse.category}]: ${quoteVaultParse.message}`,
      slot,
      accountIndex: 3,
      accountAddress: identities.quoteVault,
    };
  }

  // 11. Pure Mathematical LP Accounting Calculation
  const accounting = calculateAmmV4LpInaccessibleClaims(poolState.lpReserve, lpMintState.supply);
  if (!accounting.ok) {
    return {
      ok: false,
      category: "LP_ACCOUNTING_CALCULATION_FAILED",
      message: `LP claim calculation rejected [${accounting.category}]: ${accounting.message}`,
      slot,
    };
  }

  // 12. Compute deterministic SHA-256 digests for all 4 raw buffers
  const accountDigests = {
    poolSha256: createHash("sha256").update(poolBuffer).digest("hex"),
    lpMintSha256: createHash("sha256").update(lpMintBuffer).digest("hex"),
    baseVaultSha256: createHash("sha256").update(baseVaultBuffer).digest("hex"),
    quoteVaultSha256: createHash("sha256").update(quoteVaultBuffer).digest("hex"),
  };

  return {
    ok: true,
    accounting,
    diagnostics: {
      slot,
      evidenceOrigin,
      isSyntheticFixture,
      retrievedAtIso,
      requestedIdentities: identities,
      poolState,
      lpMintState,
      baseVaultState: baseVaultParse.state,
      quoteVaultState: quoteVaultParse.state,
      derivedAmmAuthority: Object.freeze({
        address: derivedAmmAuthority.address,
        bump: derivedAmmAuthority.bump,
      }),
      accountDigests,
    },
    evidenceBoundary: {
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    },
  };
}

/**
 * Extracts context slot and account value array from a standard Solana JSON-RPC payload.
 */
function extractRpcValueAndSlot(payload: unknown): {
  slot: number | null;
  value: unknown[] | null;
  error?: string | undefined;
} {
  if (typeof payload !== "object" || payload === null) {
    return { slot: null, value: null, error: "Invalid JSON-RPC payload: expected an object" };
  }

  const record = payload as Record<string, unknown>;
  if (record.error) {
    return {
      slot: null,
      value: null,
      error: `RPC Error: ${typeof record.error === "object" ? JSON.stringify(record.error) : String(record.error)}`,
    };
  }

  let resultRecord: Record<string, unknown> | undefined;
  if (record.result && typeof record.result === "object") {
    resultRecord = record.result as Record<string, unknown>;
  } else if ("context" in record && "value" in record) {
    resultRecord = record;
  }

  if (!resultRecord) {
    return {
      slot: null,
      value: null,
      error: "Missing RPC result or context/value structure in payload",
    };
  }

  const context = resultRecord.context as Record<string, unknown> | undefined;
  const slot = typeof context?.slot === "number" ? context.slot : null;

  const value = resultRecord.value;
  if (!Array.isArray(value)) {
    return { slot, value: null, error: "RPC result.value is not an array" };
  }

  return { slot, value };
}

/**
 * Extracts raw Buffer from base64 account data representation with strict syntax validation.
 */
function extractAccountBuffer(data: unknown): Buffer | null {
  if (Array.isArray(data) && typeof data[0] === "string") {
    const encoding = data[1];
    if (encoding !== undefined && encoding !== "base64") {
      return null;
    }
    const encoded = data[0];
    if (!isValidStrictBase64(encoded)) {
      return null;
    }
    return Buffer.from(encoded, "base64");
  }
  if (typeof data === "string") {
    if (!isValidStrictBase64(data)) {
      return null;
    }
    return Buffer.from(data, "base64");
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  return null;
}
