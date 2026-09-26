export type CandidateScannerRejectionReason =
  | "REJECTED_OUTSIDE_MATURITY_WINDOW"
  | "REJECTED_IMBALANCED_LIQUIDITY_DEPTH"
  | "REJECTED_UNLOCKED_LP_RISK"
  | "REJECTED_ACTIVE_MINT_AUTHORITY"
  | "REJECTED_ACTIVE_FREEZE_AUTHORITY"
  | "REJECTED_INSUFFICIENT_TRANSACTION_COUNT"
  | "REJECTED_WASH_TRADE_SIZE_ANOMALY"
  | "REJECTED_NET_SELLER_DOMINANCE"
  | "REJECTED_INVALID_POOL_METADATA"
  | "REJECTED_NO_ACTIVE_DEX_PAIR";

export interface ScannedPoolRecord {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly baseMint: string;
  readonly liquidityUsd: number;
  readonly marketCapUsd: number;
  readonly openTimeSec: number;
  readonly lpBurnPct: number;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly volume5mUsd: number;
  readonly txCount5m: number;
  readonly buys5m: number;
  readonly sells5m: number;
  readonly spotPriceUsd: number;
  readonly fetchedAt: string;
}

export interface CandidateScannerFilterEvaluation {
  readonly filterName: string;
  readonly passed: boolean;
  readonly reason?: CandidateScannerRejectionReason | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface CandidateScannerCandidate {
  readonly canonicalMint: string;
  readonly symbol: string;
  readonly slotId: string;
  readonly discoveredAt: string;
  readonly assetAgeSeconds: number;
  readonly liquidityUsd: number;
  readonly marketCapUsd: number;
  readonly lmcRatio: number;
  readonly lpBurnPct: number;
  readonly spotPriceUsd: number;
  readonly filterEvaluations: readonly CandidateScannerFilterEvaluation[];
}

export interface CandidateScannerEvaluationResult {
  readonly admitted: boolean;
  readonly candidate?: CandidateScannerCandidate | undefined;
  readonly primaryRejectionReason?: CandidateScannerRejectionReason | undefined;
  readonly filterEvaluations: readonly CandidateScannerFilterEvaluation[];
}

export interface CandidateScannerRuntimeConfig {
  readonly minAgeSec: number;
  readonly maxAgeSec: number;
  readonly minLmcRatio: number;
  readonly maxLmcRatio: number;
  readonly minLpBurnPct: number;
  readonly minTxCount5m: number;
  readonly minAvgTxUsd: number;
  readonly maxAvgTxUsd: number;
  readonly requireNetBuyerFlow: boolean;
  readonly pollIntervalMs: number;
  readonly pageSize: number;
  readonly dryRun: boolean;
}

export interface CandidateScannerStreamStats {
  scannedPools: number;
  admittedCandidates: number;
  rejectedMaturity: number;
  rejectedLmc: number;
  rejectedRug: number;
  rejectedWashTrade: number;
  errors: number;
}
