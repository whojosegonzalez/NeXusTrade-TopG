export interface StrategyRuleResult {
  readonly ruleName: string;
  readonly points: number;
  readonly passed: boolean;
  readonly warnings: readonly string[];
  readonly reason: string;
}
