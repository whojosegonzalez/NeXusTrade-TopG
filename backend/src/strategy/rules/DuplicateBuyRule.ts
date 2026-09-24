import type { StrategyDecisionRecord } from "../../db/schema/index.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

export interface DuplicateBuyRuleResult extends StrategyRuleResult {
  readonly duplicateBuy: boolean;
}

export function evaluateDuplicateBuyRule(
  existingDecisions: readonly StrategyDecisionRecord[],
  duplicateBuyInCurrentRun: boolean,
): DuplicateBuyRuleResult {
  const duplicateBuy =
    duplicateBuyInCurrentRun || existingDecisions.some((decision) => decision.decision === "BUY");

  return {
    ruleName: "duplicate_buy_protection",
    points: 0,
    passed: !duplicateBuy,
    duplicateBuy,
    warnings: duplicateBuy ? ["DUPLICATE_BUY_PREVENTED"] : [],
    reason: duplicateBuy
      ? "A BUY decision already exists for this session and mint."
      : "No prior BUY decision exists for this session and mint.",
  };
}
