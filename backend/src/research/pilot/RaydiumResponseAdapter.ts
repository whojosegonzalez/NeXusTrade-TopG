/**
 * Phase 12.94-D Milestone D.2.5: Raydium API v3 Response Adapter
 *
 * Implements strict offline parsing and validation of Raydium API v3 catalog responses.
 * Enforces schema extraction from GET /pools/info/list, base58 address validation,
 * bidirectional WSOL orientation (TOKEN_BASE_SOL_QUOTE and SOL_BASE_TOKEN_QUOTE),
 * explicit openTime status classifications (VALID, MISSING, INVALID, FUTURE_DATED),
 * unverified upstream metadata attribution, and rejection of proxy quote timestamps.
 *
 * Authority: Finding D25-R1, D25-R3, D25-R4.
 */

import {
  isCanonicalSolanaBase58,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  WSOL_MINT,
} from "./RaydiumAmmParser.js";
import type { RaydiumPairOrientation } from "./PilotTypes.js";

export const RAYDIUM_API_V3_ORIGIN = "https://api-v3.raydium.io";
export const RAYDIUM_POOLS_INFO_LIST_PATH = "/pools/info/list";
export const RAYDIUM_POOLS_INFO_LIST_ENDPOINT = "https://api-v3.raydium.io/pools/info/list";

/**
 * Validates that a target URL belongs to the strict Raydium API v3 allowlist.
 */
export function isAllowlistedRaydiumUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "api-v3.raydium.io" &&
      parsed.pathname === "/pools/info/list"
    );
  } catch {
    return false;
  }
}

export type RaydiumOpenTimeStatus = "VALID" | "MISSING" | "INVALID" | "FUTURE_DATED";

export interface RaydiumPoolSummary {
  readonly poolId: string; // Case-sensitive Solana base58
  readonly programId: string; // API hint (e.g. 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)
  readonly poolType: string; // e.g. "Standard"
  readonly baseTokenAddress: string;
  readonly baseTokenSymbol: string;
  readonly baseTokenDecimals: number;
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string;
  readonly quoteTokenDecimals: number;
  readonly targetMintAddress: string; // Non-WSOL mint
  readonly targetMintSymbol: string;
  readonly targetMintDecimals: number;
  readonly orientation: RaydiumPairOrientation;
  readonly vaultAAddress: string | null;
  readonly vaultBAddress: string | null;
  readonly spotPriceUsd: number | null;
  readonly spotPriceNative: number | null;
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly openTimeRaw: string | number | null;
  readonly openTimeMs: number | null;
  readonly openTimeStatus: RaydiumOpenTimeStatus;
  readonly poolAgeAtDiscoverySec: number | null;
  readonly sourceReportedTimeMs: null; // Strictly null per D23-A02 / D25-R3
  readonly missingFields: readonly string[];
  readonly isRaydiumStandardAmmCandidate: boolean;
}

export interface RaydiumPoolListParseResult {
  readonly ok: boolean;
  readonly pools: readonly RaydiumPoolSummary[];
  readonly totalPoolsInPayload: number;
  readonly validPoolsCount: number;
  readonly nonSolPoolsCount: number;
  readonly invalidAddressPoolsCount: number;
  readonly missingOpenTimeCount: number;
  readonly invalidOpenTimeCount: number;
  readonly futureDatedOpenTimeCount: number;
  readonly parseErrors: readonly string[];
  readonly hasNextPage: boolean;
}

/**
 * Parses raw JSON payload from GET /pools/info/list.
 */
export function parseRaydiumApiPoolListResponse(
  payload: unknown,
  receiptEpochMs: number,
): RaydiumPoolListParseResult {
  const parseErrors: string[] = [];
  const pools: RaydiumPoolSummary[] = [];

  let totalPoolsInPayload = 0;
  let nonSolPoolsCount = 0;
  let invalidAddressPoolsCount = 0;
  let missingOpenTimeCount = 0;
  let invalidOpenTimeCount = 0;
  let futureDatedOpenTimeCount = 0;
  let hasNextPage = false;

  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      pools: [],
      totalPoolsInPayload: 0,
      validPoolsCount: 0,
      nonSolPoolsCount: 0,
      invalidAddressPoolsCount: 0,
      missingOpenTimeCount: 0,
      invalidOpenTimeCount: 0,
      futureDatedOpenTimeCount: 0,
      parseErrors: ["Expected JSON object response from Raydium API v3"],
      hasNextPage: false,
    };
  }

  const root = payload as Record<string, unknown>;

  // Check success flag if present
  if (root.success === false) {
    const msg = typeof root.msg === "string" ? root.msg : "API indicated failure (success=false)";
    return {
      ok: false,
      pools: [],
      totalPoolsInPayload: 0,
      validPoolsCount: 0,
      nonSolPoolsCount: 0,
      invalidAddressPoolsCount: 0,
      missingOpenTimeCount: 0,
      invalidOpenTimeCount: 0,
      futureDatedOpenTimeCount: 0,
      parseErrors: [msg],
      hasNextPage: false,
    };
  }

  // Extract raw pools array from known envelope patterns:
  // 1. root.data.data (Standard API v3 pagination envelope)
  // 2. root.data (Direct list in data)
  // 3. Array.isArray(root) (Direct array)
  let rawPools: unknown[] = [];
  if (Array.isArray(root)) {
    rawPools = root;
  } else if (typeof root.data === "object" && root.data !== null) {
    const dataObj = root.data as Record<string, unknown>;
    if (Array.isArray(dataObj.data)) {
      rawPools = dataObj.data;
      hasNextPage = Boolean(dataObj.hasNextPage);
    } else if (Array.isArray(root.data)) {
      rawPools = root.data as unknown[];
    }
  }

  totalPoolsInPayload = rawPools.length;

  for (let idx = 0; idx < rawPools.length; idx++) {
    const rawItem = rawPools[idx];
    if (typeof rawItem !== "object" || rawItem === null) {
      parseErrors.push(`Item at index ${idx} is not an object`);
      continue;
    }

    const item = rawItem as Record<string, unknown>;
    const poolId = typeof item.id === "string" ? item.id.trim() : "";
    if (!poolId || !isCanonicalSolanaBase58(poolId)) {
      invalidAddressPoolsCount++;
      parseErrors.push(`Invalid pool ID base58 at index ${idx}: '${poolId}'`);
      continue;
    }

    const programId = typeof item.programId === "string" ? item.programId.trim() : "";
    const poolType = typeof item.type === "string" ? item.type.trim() : "Standard";

    // Extract mintA and mintB
    let mintAAddress = "";
    let mintASymbol = "UNKNOWN";
    let mintADecimals = 9;

    if (typeof item.mintA === "object" && item.mintA !== null) {
      const mA = item.mintA as Record<string, unknown>;
      mintAAddress = typeof mA.address === "string" ? mA.address.trim() : "";
      mintASymbol = typeof mA.symbol === "string" ? mA.symbol.trim() : "UNKNOWN";
      mintADecimals =
        typeof mA.decimals === "number" && Number.isFinite(mA.decimals) ? mA.decimals : 9;
    } else if (typeof item.mintA === "string") {
      mintAAddress = item.mintA.trim();
    }

    let mintBAddress = "";
    let mintBSymbol = "UNKNOWN";
    let mintBDecimals = 9;

    if (typeof item.mintB === "object" && item.mintB !== null) {
      const mB = item.mintB as Record<string, unknown>;
      mintBAddress = typeof mB.address === "string" ? mB.address.trim() : "";
      mintBSymbol = typeof mB.symbol === "string" ? mB.symbol.trim() : "UNKNOWN";
      mintBDecimals =
        typeof mB.decimals === "number" && Number.isFinite(mB.decimals) ? mB.decimals : 9;
    } else if (typeof item.mintB === "string") {
      mintBAddress = item.mintB.trim();
    }

    if (!mintAAddress || !isCanonicalSolanaBase58(mintAAddress)) {
      invalidAddressPoolsCount++;
      parseErrors.push(`Pool ${poolId} has invalid mintA address: '${mintAAddress}'`);
      continue;
    }
    if (!mintBAddress || !isCanonicalSolanaBase58(mintBAddress)) {
      invalidAddressPoolsCount++;
      parseErrors.push(`Pool ${poolId} has invalid mintB address: '${mintBAddress}'`);
      continue;
    }

    // Bidirectional WSOL pairing determination (D25-R4)
    let orientation: RaydiumPairOrientation = "NON_SOL_PAIR";
    let targetMintAddress = mintAAddress;
    let targetMintSymbol = mintASymbol;
    let targetMintDecimals = mintADecimals;

    if (mintBAddress === WSOL_MINT) {
      orientation = "TOKEN_BASE_SOL_QUOTE";
      targetMintAddress = mintAAddress;
      targetMintSymbol = mintASymbol;
      targetMintDecimals = mintADecimals;
    } else if (mintAAddress === WSOL_MINT) {
      orientation = "SOL_BASE_TOKEN_QUOTE";
      targetMintAddress = mintBAddress;
      targetMintSymbol = mintBSymbol;
      targetMintDecimals = mintBDecimals;
    } else {
      orientation = "NON_SOL_PAIR";
      nonSolPoolsCount++;
    }

    // Extract vault addresses
    let vaultAAddress: string | null = null;
    let vaultBAddress: string | null = null;
    if (typeof item.vault === "object" && item.vault !== null) {
      const v = item.vault as Record<string, unknown>;
      if (typeof v.A === "string" && isCanonicalSolanaBase58(v.A.trim())) {
        vaultAAddress = v.A.trim();
      }
      if (typeof v.B === "string" && isCanonicalSolanaBase58(v.B.trim())) {
        vaultBAddress = v.B.trim();
      }
    }
    if (
      !vaultAAddress &&
      typeof item.vaultA === "string" &&
      isCanonicalSolanaBase58(item.vaultA.trim())
    ) {
      vaultAAddress = item.vaultA.trim();
    }
    if (
      !vaultBAddress &&
      typeof item.vaultB === "string" &&
      isCanonicalSolanaBase58(item.vaultB.trim())
    ) {
      vaultBAddress = item.vaultB.trim();
    }

    // Parse openTime (D25-R1 / D25-R3)
    const openTimeRaw =
      typeof item.openTime === "string" || typeof item.openTime === "number" ? item.openTime : null;
    let openTimeStatus: RaydiumOpenTimeStatus = "MISSING";
    let openTimeMs: number | null = null;
    let poolAgeAtDiscoverySec: number | null = null;

    if (openTimeRaw === null || openTimeRaw === "") {
      openTimeStatus = "MISSING";
      missingOpenTimeCount++;
    } else {
      const parsedNum =
        typeof openTimeRaw === "number"
          ? openTimeRaw
          : Number.parseFloat(String(openTimeRaw).trim());

      if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
        openTimeStatus = "INVALID";
        invalidOpenTimeCount++;
      } else {
        // Convert seconds to milliseconds if timestamp is in seconds (< 1e11)
        const parsedMs = parsedNum < 1e11 ? Math.round(parsedNum * 1000) : Math.round(parsedNum);

        // Allow 60 seconds tolerance for forward clock skew
        if (parsedMs > receiptEpochMs + 60_000) {
          openTimeStatus = "FUTURE_DATED";
          openTimeMs = parsedMs;
          futureDatedOpenTimeCount++;
        } else {
          openTimeStatus = "VALID";
          openTimeMs = parsedMs;
          poolAgeAtDiscoverySec = Math.max(0, Math.floor((receiptEpochMs - parsedMs) / 1000));
        }
      }
    }

    // Extract price and liquidity metrics
    const priceRaw =
      typeof item.price === "number" ? item.price : Number.parseFloat(String(item.price ?? ""));
    const spotPriceUsd = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;

    const tvlRaw =
      typeof item.tvl === "number" ? item.tvl : Number.parseFloat(String(item.tvl ?? ""));
    const tvlUsd = Number.isFinite(tvlRaw) && tvlRaw >= 0 ? tvlRaw : null;

    const dayObj = (typeof item.day === "object" && item.day !== null ? item.day : {}) as Record<
      string,
      unknown
    >;
    const volDayRaw =
      typeof dayObj.volume === "number"
        ? dayObj.volume
        : Number.parseFloat(String(dayObj.volume ?? ""));
    const volume24hUsd = Number.isFinite(volDayRaw) && volDayRaw >= 0 ? volDayRaw : null;

    // Raydium info/list does not provide 5m flow or reserve numbers
    const missingFields: string[] = [
      "sourceTimestampMs",
      "baseReserve",
      "quoteReserve",
      "volume5mUsd",
      "buys5m",
      "sells5m",
    ];

    // Identify eligible Raydium standard AMM v4 candidate
    const typeLower = poolType.toLowerCase();
    const isStandard =
      typeLower === "standard" ||
      programId === RAYDIUM_AMM_V4_PROGRAM_ID ||
      typeLower.includes("amm");
    const isClmmOrCpmm = /clmm|cpmm|concentrated/i.test(typeLower);
    const isRaydiumStandardAmmCandidate =
      orientation !== "NON_SOL_PAIR" && isStandard && !isClmmOrCpmm;

    pools.push({
      poolId,
      programId,
      poolType,
      baseTokenAddress: mintAAddress,
      baseTokenSymbol: mintASymbol,
      baseTokenDecimals: mintADecimals,
      quoteTokenAddress: mintBAddress,
      quoteTokenSymbol: mintBSymbol,
      quoteTokenDecimals: mintBDecimals,
      targetMintAddress,
      targetMintSymbol,
      targetMintDecimals,
      orientation,
      vaultAAddress,
      vaultBAddress,
      spotPriceUsd,
      spotPriceNative: null,
      tvlUsd,
      volume24hUsd,
      volume5mUsd: null,
      buys5m: null,
      sells5m: null,
      openTimeRaw,
      openTimeMs,
      openTimeStatus,
      poolAgeAtDiscoverySec,
      sourceReportedTimeMs: null,
      missingFields,
      isRaydiumStandardAmmCandidate,
    });
  }

  return {
    ok: pools.length > 0 || totalPoolsInPayload === 0,
    pools,
    totalPoolsInPayload,
    validPoolsCount: pools.length,
    nonSolPoolsCount,
    invalidAddressPoolsCount,
    missingOpenTimeCount,
    invalidOpenTimeCount,
    futureDatedOpenTimeCount,
    parseErrors,
    hasNextPage,
  };
}
