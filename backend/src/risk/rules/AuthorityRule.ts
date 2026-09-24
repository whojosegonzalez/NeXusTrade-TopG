import type { RiskEvidenceSnapshot } from "@nexustrade/shared";

import type { RiskFlag } from "../RiskFlags.js";
import {
  maxSeverity,
  type RiskRuleResult,
  type RiskRuleSeverity,
  type RiskScoreDeduction,
} from "./RiskRuleResult.js";

export interface AuthorityRuleFacts {
  readonly mintAuthorityDisabled?: boolean;
  readonly freezeAuthorityDisabled?: boolean;
}

export interface AuthorityRuleResult extends RiskRuleResult {
  readonly facts: AuthorityRuleFacts;
}

export function evaluateAuthorityRule(
  riskEvidence: RiskEvidenceSnapshot | undefined,
): AuthorityRuleResult {
  if (!riskEvidence) {
    return {
      severity: "WARN",
      flags: ["MISSING_AUTHORITY_EVIDENCE"],
      deductions: [
        {
          flag: "MISSING_AUTHORITY_EVIDENCE",
          points: 10,
          reason: "Helius authority evidence is missing.",
        },
      ],
      facts: {},
    };
  }

  const flags: RiskFlag[] = [];
  const deductions: RiskScoreDeduction[] = [];
  const severities: RiskRuleSeverity[] = [];
  const facts: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
  } = {};
  const evidenceFlags = new Set(riskEvidence.flags);

  if (
    evidenceFlags.has("MINT_AUTHORITY_PRESENT") ||
    evidenceFlags.has("mint_authority_present") ||
    riskEvidence.mintAuthorityState === "PRESENT" ||
    riskEvidence.mintAuthorityRisk === "HIGH"
  ) {
    flags.push("MINT_AUTHORITY_PRESENT");
    deductions.push({
      flag: "MINT_AUTHORITY_PRESENT",
      points: 40,
      reason: "Mint authority is present.",
    });
    severities.push("FAIL");
    facts.mintAuthorityDisabled = false;
  } else if (
    evidenceFlags.has("MINT_AUTHORITY_DISABLED") ||
    riskEvidence.mintAuthorityState === "DISABLED" ||
    riskEvidence.mintAuthorityRisk === "LOW"
  ) {
    flags.push("MINT_AUTHORITY_DISABLED");
    severities.push("PASS");
    facts.mintAuthorityDisabled = true;
  } else {
    flags.push("MINT_AUTHORITY_UNKNOWN");
    flags.push("MISSING_AUTHORITY_EVIDENCE");
    deductions.push({
      flag: "MISSING_AUTHORITY_EVIDENCE",
      points: 10,
      reason: "Mint authority is absent or unknown, not confirmed disabled.",
    });
    severities.push("WARN");
  }

  if (
    evidenceFlags.has("FREEZE_AUTHORITY_PRESENT") ||
    evidenceFlags.has("freeze_authority_present") ||
    riskEvidence.freezeAuthorityState === "PRESENT" ||
    riskEvidence.freezeAuthorityRisk === "HIGH"
  ) {
    flags.push("FREEZE_AUTHORITY_PRESENT");
    deductions.push({
      flag: "FREEZE_AUTHORITY_PRESENT",
      points: 40,
      reason: "Freeze authority is present.",
    });
    severities.push("FAIL");
    facts.freezeAuthorityDisabled = false;
  } else if (
    evidenceFlags.has("FREEZE_AUTHORITY_DISABLED") ||
    riskEvidence.freezeAuthorityState === "DISABLED" ||
    riskEvidence.freezeAuthorityRisk === "LOW"
  ) {
    flags.push("FREEZE_AUTHORITY_DISABLED");
    severities.push("PASS");
    facts.freezeAuthorityDisabled = true;
  } else {
    flags.push("FREEZE_AUTHORITY_UNKNOWN");
    flags.push("MISSING_AUTHORITY_EVIDENCE");
    deductions.push({
      flag: "MISSING_AUTHORITY_EVIDENCE",
      points: 10,
      reason: "Freeze authority is absent or unknown, not confirmed disabled.",
    });
    severities.push("WARN");
  }

  return {
    severity: maxSeverity(severities),
    flags,
    deductions,
    facts,
  };
}
