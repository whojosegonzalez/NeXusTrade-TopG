import type { RiskFlag } from "../RiskFlags.js";

export type RiskRuleSeverity = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface RiskScoreDeduction {
  readonly flag: RiskFlag;
  readonly points: number;
  readonly reason: string;
}

export interface RiskRuleResult {
  readonly severity: RiskRuleSeverity;
  readonly flags: readonly RiskFlag[];
  readonly deductions: readonly RiskScoreDeduction[];
}

export function maxSeverity(severities: readonly RiskRuleSeverity[]): RiskRuleSeverity {
  return severities.reduce<RiskRuleSeverity>(
    (current, next) => (severityWeight(next) > severityWeight(current) ? next : current),
    "PASS",
  );
}

function severityWeight(severity: RiskRuleSeverity): number {
  switch (severity) {
    case "FAIL":
      return 3;
    case "WARN":
      return 2;
    case "UNKNOWN":
      return 1;
    case "PASS":
      return 0;
  }
}
