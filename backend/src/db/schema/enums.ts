import { EXECUTION_MODES } from "@nexustrade/shared";

export const executionModeValues = EXECUTION_MODES;

export const sessionStatusValues = [
  "CREATED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const terminationReasonValues = [
  "TARGET_REACHED",
  "MAX_DRAWDOWN",
  "DURATION_EXPIRED",
  "USER_STOP",
  "ENGINE_ERROR",
  "NOT_TERMINATED",
] as const;

export const tokenRadarStatusValues = [
  "DISCOVERED",
  "WATCHING",
  "REJECTED",
  "APPROVED",
  "BOUGHT",
  "IGNORED",
  "ERROR",
] as const;

export const riskResultValues = ["PASS", "FAIL", "WARN", "UNKNOWN"] as const;

export const strategyDecisionValues = ["WATCH", "SKIP", "BUY", "HOLD", "SELL"] as const;

export const orderSideValues = ["BUY", "SELL"] as const;

export const orderStatusValues = [
  "CREATED",
  "QUOTED",
  "FILLED",
  "PARTIALLY_FILLED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;

export const positionStatusValues = ["OPEN", "CLOSING", "CLOSED", "ERROR"] as const;

export const systemLogLevelValues = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export const systemLogScopeValues = [
  "SYSTEM",
  "DB",
  "SESSION",
  "SCANNER",
  "RISK",
  "STRATEGY",
  "EXECUTION",
  "PROVIDER",
  "TEST",
] as const;

export const providerStatusValues = [
  "OK",
  "DEGRADED",
  "RATE_LIMITED",
  "ERROR",
  "DISABLED",
] as const;

export const watchlistReturnStatusValues = ["PENDING", "OBSERVED", "MISSED", "FAILED"] as const;

export type SessionStatus = (typeof sessionStatusValues)[number];
export type TerminationReason = (typeof terminationReasonValues)[number];
export type TokenRadarStatus = (typeof tokenRadarStatusValues)[number];
export type RiskResult = (typeof riskResultValues)[number];
export type StrategyDecision = (typeof strategyDecisionValues)[number];
export type OrderSide = (typeof orderSideValues)[number];
export type OrderStatus = (typeof orderStatusValues)[number];
export type PositionStatus = (typeof positionStatusValues)[number];
export type SystemLogLevel = (typeof systemLogLevelValues)[number];
export type SystemLogScope = (typeof systemLogScopeValues)[number];
export type ProviderStatus = (typeof providerStatusValues)[number];
export type WatchlistReturnStatus = (typeof watchlistReturnStatusValues)[number];
