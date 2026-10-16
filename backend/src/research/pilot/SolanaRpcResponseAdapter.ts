/**
 * Phase 12.94-D Milestone D.2.3: Solana RPC Response Adapter
 *
 * Implements strict offline parsing and validation of Solana JSON-RPC responses.
 * Handles getAccountInfo for Raydium AMM pools and getMultipleAccounts for vault balances.
 * Guarantees slot-coherence tracking and raw bigint balance decoding (D23P-01, D23P-02).
 */

import {
  parseRaydiumAmmV4Account,
  parseSplTokenVaultAccount,
  type RaydiumAmmParseResult,
  type SplVaultParseResult,
} from "./RaydiumAmmParser.js";
import type { D23RaydiumAmmV4State, D23VaultBalances } from "./PilotTypes.js";

export interface SolanaRpcPoolResult {
  readonly ok: boolean;
  readonly slot: number | null;
  readonly poolState: D23RaydiumAmmV4State | null;
  readonly error?: string | undefined;
}

export interface SolanaRpcVaultsResult {
  readonly ok: boolean;
  readonly slot: number | null;
  readonly balances: D23VaultBalances | null;
  readonly error?: string | undefined;
}

/**
 * Parses JSON-RPC getAccountInfo response for a Raydium AMM v4 pool account.
 */
export function parseSolanaRpcPoolAccountResponse(
  payload: unknown,
  expectedPoolAddress: string,
): SolanaRpcPoolResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, slot: null, poolState: null, error: "Invalid JSON-RPC payload object" };
  }

  const rpc = payload as Record<string, unknown>;
  if (rpc.error) {
    return {
      ok: false,
      slot: null,
      poolState: null,
      error: `RPC Error: ${JSON.stringify(rpc.error)}`,
    };
  }

  const result = rpc.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") {
    return { ok: false, slot: null, poolState: null, error: "Missing RPC result" };
  }

  const context = result.context as Record<string, unknown> | undefined;
  const slot = typeof context?.slot === "number" ? context.slot : null;

  const value = result.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      slot,
      poolState: null,
      error: "Pool account not found on-chain (null value)",
    };
  }

  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const data = value.data;

  let buffer: Buffer | null = null;
  if (Array.isArray(data) && typeof data[0] === "string" && data[1] === "base64") {
    buffer = Buffer.from(data[0], "base64");
  } else if (typeof data === "string") {
    buffer = Buffer.from(data, "base64");
  } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    buffer = Buffer.from(data);
  }

  if (!buffer) {
    return { ok: false, slot, poolState: null, error: "Failed to extract base64 account data" };
  }

  const parseResult: RaydiumAmmParseResult = parseRaydiumAmmV4Account(
    buffer,
    expectedPoolAddress,
    owner,
    slot ?? undefined,
  );

  if (!parseResult.ok) {
    return {
      ok: false,
      slot,
      poolState: null,
      error: `Raydium parse error [${parseResult.category}]: ${parseResult.message}`,
    };
  }

  return {
    ok: true,
    slot,
    poolState: parseResult.state,
  };
}

/**
 * Parses JSON-RPC getMultipleAccounts response for base and quote vault token accounts (D23P-02).
 * When retrieved in a single getMultipleAccounts call, both vaults share the exact same context slot.
 */
export function parseSolanaRpcMultipleVaultsResponse(
  payload: unknown,
  vaultAddresses: readonly [string, string], // [baseVault, quoteVault]
  expectedMints: readonly [string, string], // [baseMint, quoteMint]
): SolanaRpcVaultsResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, slot: null, balances: null, error: "Invalid JSON-RPC payload object" };
  }

  const rpc = payload as Record<string, unknown>;
  if (rpc.error) {
    return {
      ok: false,
      slot: null,
      balances: null,
      error: `RPC Error: ${JSON.stringify(rpc.error)}`,
    };
  }

  const result = rpc.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") {
    return { ok: false, slot: null, balances: null, error: "Missing RPC result" };
  }

  const context = result.context as Record<string, unknown> | undefined;
  const slot = typeof context?.slot === "number" ? context.slot : null;

  const value = result.value;
  if (!Array.isArray(value) || value.length < 2) {
    return {
      ok: false,
      slot,
      balances: null,
      error: `Expected 2 vault account entries in getMultipleAccounts value array, got ${Array.isArray(value) ? value.length : 0}`,
    };
  }

  const baseAccountRaw = value[0] as Record<string, unknown> | null;
  const quoteAccountRaw = value[1] as Record<string, unknown> | null;

  if (!baseAccountRaw || !quoteAccountRaw) {
    return {
      ok: false,
      slot,
      balances: null,
      error: "One or both vault accounts returned null on-chain",
    };
  }

  const baseBuffer = extractAccountBuffer(baseAccountRaw.data);
  const quoteBuffer = extractAccountBuffer(quoteAccountRaw.data);

  if (!baseBuffer || !quoteBuffer) {
    return {
      ok: false,
      slot,
      balances: null,
      error: "Failed to decode base64 data for base or quote vault",
    };
  }

  const baseOwner = typeof baseAccountRaw.owner === "string" ? baseAccountRaw.owner.trim() : "";
  const quoteOwner = typeof quoteAccountRaw.owner === "string" ? quoteAccountRaw.owner.trim() : "";

  const baseParse: SplVaultParseResult = parseSplTokenVaultAccount(
    baseBuffer,
    vaultAddresses[0],
    expectedMints[0],
    baseOwner,
    slot ?? undefined,
  );

  if (!baseParse.ok) {
    return {
      ok: false,
      slot,
      balances: null,
      error: `Base vault parse failure [${baseParse.category}]: ${baseParse.message}`,
    };
  }

  const quoteParse: SplVaultParseResult = parseSplTokenVaultAccount(
    quoteBuffer,
    vaultAddresses[1],
    expectedMints[1],
    quoteOwner,
    slot ?? undefined,
  );

  if (!quoteParse.ok) {
    return {
      ok: false,
      slot,
      balances: null,
      error: `Quote vault parse failure [${quoteParse.category}]: ${quoteParse.message}`,
    };
  }

  const balances: D23VaultBalances = {
    baseVaultRaw: baseParse.state.rawAmount,
    quoteVaultRaw: quoteParse.state.rawAmount,
    baseVaultSlot: slot ?? undefined,
    quoteVaultSlot: slot ?? undefined,
    slotDiscrepancy: false,
    slotDelta: 0,
  };

  return {
    ok: true,
    slot,
    balances,
  };
}

/**
 * Detects cross-request slot discrepancies when vault accounts are read in separate queries (D23P-02).
 */
export function detectSlotDiscrepancy(
  slotA: number | undefined | null,
  slotB: number | undefined | null,
): { slotDiscrepancy: boolean; slotDelta: number } {
  if (slotA === undefined || slotA === null || slotB === undefined || slotB === null) {
    return { slotDiscrepancy: false, slotDelta: 0 };
  }
  const delta = Math.abs(slotA - slotB);
  return {
    slotDiscrepancy: delta > 0,
    slotDelta: delta,
  };
}

function extractAccountBuffer(data: unknown): Buffer | null {
  if (Array.isArray(data) && typeof data[0] === "string") {
    return Buffer.from(data[0], "base64");
  }
  if (typeof data === "string") {
    return Buffer.from(data, "base64");
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  return null;
}
