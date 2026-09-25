import type {
  CandidateScannerFilterEvaluation,
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "../CandidateScannerTypes.js";

const RENOUNCED_AUTHORITY_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "null",
  "none",
  "",
]);

function isRenouncedAuthority(authority: string | null): boolean {
  if (authority === null) return true;
  const trimmed = authority.trim();
  if (!trimmed) return true;
  return RENOUNCED_AUTHORITY_ADDRESSES.has(trimmed.toLowerCase());
}

export class AntiRugEvaluator {
  evaluate(
    pool: ScannedPoolRecord,
    config: CandidateScannerRuntimeConfig,
  ): CandidateScannerFilterEvaluation {
    // 1. LP Burn / Lock check
    if (pool.lpBurnPct < config.minLpBurnPct) {
      return {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_UNLOCKED_LP_RISK",
        details: {
          lpBurnPct: pool.lpBurnPct,
          minLpBurnPct: config.minLpBurnPct,
        },
      };
    }

    // 2. Mint Authority check
    if (!isRenouncedAuthority(pool.mintAuthority)) {
      return {
        filterName: "ANTI_RUG_MINT_AUTHORITY",
        passed: false,
        reason: "REJECTED_ACTIVE_MINT_AUTHORITY",
        details: {
          mintAuthority: pool.mintAuthority,
        },
      };
    }

    // 3. Freeze Authority check
    if (!isRenouncedAuthority(pool.freezeAuthority)) {
      return {
        filterName: "ANTI_RUG_FREEZE_AUTHORITY",
        passed: false,
        reason: "REJECTED_ACTIVE_FREEZE_AUTHORITY",
        details: {
          freezeAuthority: pool.freezeAuthority,
        },
      };
    }

    return {
      filterName: "ANTI_RUG_AUTHORITY_AND_LP",
      passed: true,
      details: {
        lpBurnPct: pool.lpBurnPct,
        mintAuthority: pool.mintAuthority ?? "RENOUNCED",
        freezeAuthority: pool.freezeAuthority ?? "RENOUNCED",
      },
    };
  }
}
