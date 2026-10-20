/**
 * Phase 12.94-D Milestone D.2.9-A: Independent On-Chain Verification Dispatch
 *
 * Implements strict, protocol-segregated routing of discovered pool initialization
 * candidates to their authoritative read-only parsers:
 * - Canonical AMM v4 -> RaydiumAmmParser
 * - Canonical CPMM   -> RaydiumCpmmParser
 *
 * Requirements (D29-A3, D29-A7):
 * 1. Zero protocol fallback or substitution between parsers.
 * 2. Exact expected program-owner assertions on fetched on-chain account data.
 * 3. Point-in-time slot provenance: preserves transactionSlot, poolAccountSlot,
 *    vault0AccountSlot, vault1AccountSlot, and host observation timestamps.
 * 4. Slot discrepancy fail-closed: any cross-slot mismatch sets tier to SLOT_DISCREPANT,
 *    marks effectiveReservesAvailable false, and nullifies spot prices.
 * 5. Isolation: PARTIALLY_VERIFIED and SLOT_DISCREPANT prices are never elevated
 *    to verified research measurements.
 * 6. Zero synthetic execution feasibility claims derived from reserve spot proxies.
 */

import type {
  DiscoveredPoolInitializationEvent,
  IOnChainAccountFetcher,
  VerificationDispatchResult,
} from "./EventDiscoveryContracts.js";
import {
  parseRaydiumAmmV4Account,
  parseSplTokenVaultAccount,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  WSOL_MINT,
} from "./RaydiumAmmParser.js";
import {
  computeCpmmReserveAccounting,
  parseCpmmVaultAccount,
  parseRaydiumCpmmAccount,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "./RaydiumCpmmParser.js";

export interface VerificationDispatchOptions {
  readonly maxAcceptableSlotDelta?: number | undefined; // Maximum allowed slot delta from tx
  readonly enforceStrictSlotMatch?: boolean | undefined; // If true, requires exact slot match between accounts
}

/**
 * Dispatches an identified pool initialization event to the appropriate verified parser.
 */
export async function dispatchPoolVerification(
  event: DiscoveredPoolInitializationEvent,
  fetcher: IOnChainAccountFetcher,
  options: VerificationDispatchOptions = {},
): Promise<VerificationDispatchResult> {
  const hostObservedAt = Date.now();
  const txSlot = event.slot;

  // 1. Immediately reject unsupported protocols without querying RPC
  if (event.protocol === "UNSUPPORTED_PROTOCOL") {
    return {
      poolId: event.poolId,
      protocol: "UNSUPPORTED_PROTOCOL",
      verified: false,
      rejectionReason: event.unsupportedReason ?? "UNSUPPORTED_PROTOCOL",
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: null,
      vault0AccountSlot: null,
      vault1AccountSlot: null,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  // 2. Fetch pool account and both vault accounts in parallel
  const [poolAccount, vault0Account, vault1Account] = await fetcher.getMultipleAccounts([
    event.poolId,
    event.token0Vault,
    event.token1Vault,
  ]);

  if (!poolAccount) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: "POOL_ACCOUNT_NOT_FOUND",
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: null,
      vault0AccountSlot: vault0Account?.slot ?? null,
      vault1AccountSlot: vault1Account?.slot ?? null,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  if (!vault0Account || !vault1Account) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: !vault0Account ? "VAULT_0_ACCOUNT_NOT_FOUND" : "VAULT_1_ACCOUNT_NOT_FOUND",
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: poolAccount.slot,
      vault0AccountSlot: vault0Account?.slot ?? null,
      vault1AccountSlot: vault1Account?.slot ?? null,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  // Confirm fetched account identity against requested pool and vault addresses (BREADY-03)
  if (poolAccount.address && poolAccount.address !== event.poolId) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: `Pool account address mismatch: requested ${event.poolId}, received ${poolAccount.address}`,
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: poolAccount.slot,
      vault0AccountSlot: vault0Account.slot,
      vault1AccountSlot: vault1Account.slot,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  if (vault0Account.address && vault0Account.address !== event.token0Vault) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: `Vault 0 address mismatch: requested ${event.token0Vault}, received ${vault0Account.address}`,
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: poolAccount.slot,
      vault0AccountSlot: vault0Account.slot,
      vault1AccountSlot: vault1Account.slot,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  if (vault1Account.address && vault1Account.address !== event.token1Vault) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: `Vault 1 address mismatch: requested ${event.token1Vault}, received ${vault1Account.address}`,
      verificationTier: "REJECTED",
      transactionSlot: txSlot,
      poolAccountSlot: poolAccount.slot,
      vault0AccountSlot: vault0Account.slot,
      vault1AccountSlot: vault1Account.slot,
      slotDiscrepancy: false,
      slotDelta: 0,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  const poolSlot = poolAccount.slot;
  const v0Slot = vault0Account.slot;
  const v1Slot = vault1Account.slot;

  // Detect slot discrepancies (cross-slot race conditions)
  const isVaultSlotDiscrepancy = v0Slot !== v1Slot;
  const isPoolVaultSlotDiscrepancy = poolSlot !== v0Slot;
  const slotDiscrepancy = isVaultSlotDiscrepancy || isPoolVaultSlotDiscrepancy;
  const slotDelta = Math.max(poolSlot, v0Slot, v1Slot) - txSlot;

  if (options.maxAcceptableSlotDelta !== undefined && slotDelta > options.maxAcceptableSlotDelta) {
    return {
      poolId: event.poolId,
      protocol: event.protocol,
      verified: false,
      rejectionReason: `Slot delta ${slotDelta} exceeds maximum acceptable threshold ${options.maxAcceptableSlotDelta}`,
      verificationTier: "SLOT_DISCREPANT",
      transactionSlot: txSlot,
      poolAccountSlot: poolSlot,
      vault0AccountSlot: v0Slot,
      vault1AccountSlot: v1Slot,
      slotDiscrepancy,
      slotDelta,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: false,
      spotPriceSol: null,
      spotPrice0Per1: null,
    };
  }

  // --------------------------------------------------------------------------
  // Dispatch: Raydium AMM v4 Verification
  // --------------------------------------------------------------------------
  if (event.protocol === "RAYDIUM_AMM_V4") {
    // Assert exact owner
    if (poolAccount.owner !== RAYDIUM_AMM_V4_PROGRAM_ID) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `Owner mismatch: expected ${RAYDIUM_AMM_V4_PROGRAM_ID}, got ${poolAccount.owner}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
      };
    }

    const poolData = Buffer.from(poolAccount.data);
    const ammParseResult = parseRaydiumAmmV4Account(
      poolData,
      event.poolId,
      poolAccount.owner,
      poolSlot,
    );

    if (!ammParseResult.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `AMM v4 layout parse failed: ${ammParseResult.category} - ${ammParseResult.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
      };
    }

    const ammState = ammParseResult.state;

    // Verify AMM v4 event mints and vaults match independently decoded state (BREADY-03)
    if (
      event.token0Mint !== ammState.baseMint ||
      event.token1Mint !== ammState.quoteMint ||
      event.token0Vault !== ammState.baseVault ||
      event.token1Vault !== ammState.quoteVault
    ) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `Initialization event parameters mismatch AMM v4 pool state: event mints (${event.token0Mint}, ${event.token1Mint}) vs state mints (${ammState.baseMint}, ${ammState.quoteMint}), event vaults (${event.token0Vault}, ${event.token1Vault}) vs state vaults (${ammState.baseVault}, ${ammState.quoteVault})`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        instructionRequestedOpenTimeSec:
          event.instructionRequestedOpenTimeSec ?? event.poolOpenTimeSec,
        decodedAmmState: ammState,
      };
    }

    // Verify SPL token vaults
    const v0Data = Buffer.from(vault0Account.data);
    const v1Data = Buffer.from(vault1Account.data);
    const v0Parse = parseSplTokenVaultAccount(
      v0Data,
      event.token0Vault,
      ammState.baseMint,
      vault0Account.owner,
      v0Slot,
    );
    const v1Parse = parseSplTokenVaultAccount(
      v1Data,
      event.token1Vault,
      ammState.quoteMint,
      vault1Account.owner,
      v1Slot,
    );

    if (!v0Parse.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `SPL Vault 0 parse failed: ${v0Parse.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedAmmState: ammState,
      };
    }

    if (!v1Parse.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `SPL Vault 1 parse failed: ${v1Parse.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedAmmState: ammState,
      };
    }

    // Determine quote cohort
    const isWsol = ammState.baseMint === WSOL_MINT || ammState.quoteMint === WSOL_MINT;
    const quoteCohort = isWsol ? "WSOL_NATIVE" : "EXOTIC_CROSS";

    // If slot discrepancy occurred, fail closed on spot price
    if (slotDiscrepancy) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_AMM_V4",
        verified: false,
        rejectionReason: `Slot discrepancy between pool (${poolSlot}) and vaults (${v0Slot}, ${v1Slot})`,
        verificationTier: "SLOT_DISCREPANT",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy: true,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        quoteCohort,
        decodedAmmState: ammState,
      };
    }

    return {
      poolId: event.poolId,
      protocol: "RAYDIUM_AMM_V4",
      verified: true,
      verificationTier: "VERIFIED_AMM_V4",
      transactionSlot: txSlot,
      poolAccountSlot: poolSlot,
      vault0AccountSlot: v0Slot,
      vault1AccountSlot: v1Slot,
      slotDiscrepancy: false,
      slotDelta,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: true,
      spotPriceSol: null, // AMM v4 calculation handled in reserve accounting
      spotPrice0Per1: null,
      quoteCohort,
      instructionRequestedOpenTimeSec:
        event.instructionRequestedOpenTimeSec ?? event.poolOpenTimeSec,
      decodedAmmState: ammState,
    };
  }

  // --------------------------------------------------------------------------
  // Dispatch: Raydium CPMM Verification
  // --------------------------------------------------------------------------
  if (event.protocol === "RAYDIUM_CPMM") {
    // Assert exact owner
    if (poolAccount.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `Owner mismatch: expected ${RAYDIUM_CPMM_PROGRAM_ID}, got ${poolAccount.owner}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
      };
    }

    const poolData = Buffer.from(poolAccount.data);
    const cpmmParseResult = parseRaydiumCpmmAccount(
      poolData,
      event.poolId,
      poolAccount.owner,
      poolSlot,
    );

    if (!cpmmParseResult.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `CPMM layout parse failed: ${cpmmParseResult.category} - ${cpmmParseResult.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
      };
    }

    const cpmmState = cpmmParseResult.state;

    // 1. Verify initialization event matches decoded state
    if (
      event.token0Mint !== cpmmState.token0Mint ||
      event.token1Mint !== cpmmState.token1Mint ||
      event.token0Vault !== cpmmState.token0Vault ||
      event.token1Vault !== cpmmState.token1Vault
    ) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `Initialization event parameters mismatch CPMM pool state: event mints (${event.token0Mint}, ${event.token1Mint}) vs state mints (${cpmmState.token0Mint}, ${cpmmState.token1Mint})`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedCpmmState: cpmmState,
      };
    }

    // 2. Independently parse and verify token 0 and token 1 vault accounts (D29-F1)
    const v0Parse = parseCpmmVaultAccount(
      vault0Account.data,
      event.token0Vault,
      cpmmState.token0Vault,
      cpmmState.token0Mint,
      cpmmState.token0Program,
      vault0Account.owner,
      v0Slot,
    );
    if (!v0Parse.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `CPMM Vault 0 verification failed: ${v0Parse.category} - ${v0Parse.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedCpmmState: cpmmState,
      };
    }

    const v1Parse = parseCpmmVaultAccount(
      vault1Account.data,
      event.token1Vault,
      cpmmState.token1Vault,
      cpmmState.token1Mint,
      cpmmState.token1Program,
      vault1Account.owner,
      v1Slot,
    );
    if (!v1Parse.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `CPMM Vault 1 verification failed: ${v1Parse.category} - ${v1Parse.message}`,
        verificationTier: "REJECTED",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedCpmmState: cpmmState,
      };
    }

    const reserveResult = computeCpmmReserveAccounting(
      cpmmState,
      v0Parse.snapshot,
      v1Parse.snapshot,
    );

    if (!reserveResult.ok) {
      return {
        poolId: event.poolId,
        protocol: "RAYDIUM_CPMM",
        verified: false,
        rejectionReason: `CPMM reserve accounting failed: ${reserveResult.category} - ${reserveResult.message}`,
        verificationTier: "UNAVAILABLE",
        transactionSlot: txSlot,
        poolAccountSlot: poolSlot,
        vault0AccountSlot: v0Slot,
        vault1AccountSlot: v1Slot,
        slotDiscrepancy,
        slotDelta,
        verifiedAtEpochMs: hostObservedAt,
        hostObservationTimestampMs: hostObservedAt,
        effectiveReservesAvailable: false,
        spotPriceSol: null,
        spotPrice0Per1: null,
        decodedCpmmState: cpmmState,
      };
    }

    const accounting = reserveResult.accounting;

    // Strict Invariant: PARTIALLY_VERIFIED and SLOT_DISCREPANT prices must never be
    // elevated into verified measurements.
    const isCoherent = accounting.verificationTier === "INDEPENDENTLY_COHERENT";

    return {
      poolId: event.poolId,
      protocol: "RAYDIUM_CPMM",
      verified: isCoherent,
      verificationTier: accounting.verificationTier,
      transactionSlot: txSlot,
      poolAccountSlot: poolSlot,
      vault0AccountSlot: v0Slot,
      vault1AccountSlot: v1Slot,
      slotDiscrepancy: accounting.slotDiscrepancy,
      slotDelta,
      verifiedAtEpochMs: hostObservedAt,
      hostObservationTimestampMs: hostObservedAt,
      effectiveReservesAvailable: accounting.effectiveReservesAvailable,
      spotPriceSol: isCoherent ? accounting.spotPriceSol : null,
      spotPrice0Per1: isCoherent ? accounting.spotPrice0Per1 : null,
      quoteCohort: accounting.quoteCohort,
      instructionRequestedOpenTimeSec:
        event.instructionRequestedOpenTimeSec ?? event.poolOpenTimeSec,
      decodedPoolStateActivationTimeSec: cpmmState.swapActivationTimeSec,
      decodedCpmmState: cpmmState,
      cpmmReserveAccounting: accounting,
    };
  }

  // Fallback for unreachable protocol branch
  return {
    poolId: event.poolId,
    protocol: "UNSUPPORTED_PROTOCOL",
    verified: false,
    rejectionReason: "UNKNOWN_PROTOCOL_BRANCH",
    verificationTier: "REJECTED",
    transactionSlot: txSlot,
    poolAccountSlot: poolSlot,
    vault0AccountSlot: v0Slot,
    vault1AccountSlot: v1Slot,
    slotDiscrepancy,
    slotDelta,
    verifiedAtEpochMs: hostObservedAt,
    hostObservationTimestampMs: hostObservedAt,
    effectiveReservesAvailable: false,
    spotPriceSol: null,
    spotPrice0Per1: null,
  };
}
