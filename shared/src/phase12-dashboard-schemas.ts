import { z } from "zod";
import { livePaperPositionSchema } from "./phase11-schemas.js";

export const strategyThresholdsSchema = z.object({
  minLmcRatio: z.number().default(0.15),
  maxLmcRatio: z.number().default(0.3),
  minBuyToSellRatio: z.number().default(1.5),
  minVolume5mUsd: z.number().default(2500),
  minMaturityAgeSec: z.number().default(300),
  maxMaturityAgeSec: z.number().default(900),
});

export type StrategyThresholds = z.infer<typeof strategyThresholdsSchema>;

export const dashboardSettingsSchema = z.object({
  maxConcurrentPositions: z.number().int().min(1).max(10).default(3),
  positionSizeSol: z.number().positive().default(1.0),
  gasReserveSol: z.number().nonnegative().default(0.05),
  goalMode: z.enum(["PERCENT_GAIN", "FINAL_SOL_BALANCE"]).default("PERCENT_GAIN"),
  targetGoalValue: z.number().positive().default(10.0),
  walletAddress: z.string().default(""),
  strategyThresholds: strategyThresholdsSchema.default({}),
});

export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;

export const walletTokenHoldingSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  amount: z.number(),
  decimals: z.number(),
});

export type WalletTokenHolding = z.infer<typeof walletTokenHoldingSchema>;

export const walletTelemetrySchema = z.object({
  solBalance: z.number().nonnegative(),
  deployableSol: z.number().nonnegative(),
  tokens: z.array(walletTokenHoldingSchema),
  signatureReady: z.boolean(),
  fetchedAt: z.string(),
});

export type WalletTelemetry = z.infer<typeof walletTelemetrySchema>;

export const sessionControlActionSchema = z.enum([
  "PAUSE",
  "RESUME",
  "START_EXITING",
  "MANUAL_EXIT",
  "EMERGENCY_STOP",
]);

export type SessionControlAction = z.infer<typeof sessionControlActionSchema>;

export const sessionControlCommandSchema = z.object({
  action: sessionControlActionSchema,
  targetPositionId: z.string().optional(),
  issuedAt: z.number(),
});

export type SessionControlCommand = z.infer<typeof sessionControlCommandSchema>;

export const watchlistCandidateStatusSchema = z.enum(["WATCHING", "BUY_TRIGGERED", "DROPPED"]);

export type WatchlistCandidateStatus = z.infer<typeof watchlistCandidateStatusSchema>;

export const watchlistCandidateItemSchema = z.object({
  poolId: z.string(),
  mintAddress: z.string(),
  symbol: z.string(),
  liquidityUsd: z.number(),
  marketCapUsd: z.number(),
  lmcRatio: z.number(),
  lpBurnPct: z.number(),
  assetAgeSeconds: z.number(),
  volume5mUsd: z.number(),
  buys5m: z.number(),
  sells5m: z.number(),
  buyToSellRatio: z.number(),
  status: watchlistCandidateStatusSchema,
  rejectionReason: z.string().optional(),
  discoveredAt: z.string(),
  lastEvaluatedAt: z.string(),
});

export type WatchlistCandidateItem = z.infer<typeof watchlistCandidateItemSchema>;

export const activityLogEntrySchema = z.object({
  timestamp: z.number(),
  type: z.enum(["INFO", "BUY", "SELL", "RATCHET", "ALERT", "CONTROL"]),
  message: z.string(),
});

export type ActivityLogEntry = z.infer<typeof activityLogEntrySchema>;

export const sessionLifecycleStatusSchema = z.enum([
  "IDLE",
  "RUNNING",
  "PAUSED",
  "EXITING",
  "COMPLETED",
  "HALTED",
]);

export type SessionLifecycleStatus = z.infer<typeof sessionLifecycleStatusSchema>;

export const activeSessionTelemetrySchema = z.object({
  sessionId: z.string(),
  status: sessionLifecycleStatusSchema,
  haltReason: z.string().optional(),
  startedAtMs: z.number(),
  durationHours: z.number(),
  elapsedSeconds: z.number(),
  initialPortfolioSol: z.number(),
  currentPortfolioSol: z.number(),
  realizedPnlSol: z.number(),
  unrealizedPnlSol: z.number(),
  netSessionPnlSol: z.number(),
  netSessionPnlPct: z.number(),
  openPositionCount: z.number(),
  maxConcurrentPositions: z.number(),
  closedTradesCount: z.number(),
  winsCount: z.number(),
  lossesCount: z.number(),
  scratchesCount: z.number(),
  openPositions: z.array(livePaperPositionSchema),
  watchlist: z.array(watchlistCandidateItemSchema),
  recentActivityLogs: z.array(activityLogEntrySchema),
});

export type ActiveSessionTelemetry = z.infer<typeof activeSessionTelemetrySchema>;

export const historicalTradeSchema = z.object({
  tradeId: z.string(),
  poolId: z.string(),
  mintAddress: z.string(),
  symbol: z.string(),
  entryPriceSol: z.number(),
  exitPriceSol: z.number(),
  sizeSol: z.number(),
  enteredAt: z.string(),
  exitedAt: z.string(),
  holdDurationSeconds: z.number(),
  peakGainBps: z.number(),
  finalPnlBps: z.number(),
  finalPnlSol: z.number(),
  exitReason: z.string(),
  finalTier: z.string(),
});

export type HistoricalTrade = z.infer<typeof historicalTradeSchema>;

export const historicalSessionSummarySchema = z.object({
  sessionId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMinutes: z.number(),
  startingCapitalSol: z.number(),
  endingCapitalSol: z.number(),
  netPnlSol: z.number(),
  netPnlPct: z.number(),
  totalTrades: z.number(),
  winsCount: z.number(),
  lossesCount: z.number(),
  scratchesCount: z.number(),
  winRatePct: z.number(),
  trades: z.array(historicalTradeSchema),
});

export type HistoricalSessionSummary = z.infer<typeof historicalSessionSummarySchema>;
