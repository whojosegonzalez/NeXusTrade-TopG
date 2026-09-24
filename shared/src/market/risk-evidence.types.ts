import type { ProviderName } from "../providers/provider.types.js";
import type { TokenMintAddress } from "./token.types.js";

export type RiskEvidenceLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type AuthorityState = "PRESENT" | "DISABLED" | "UNKNOWN";
export type AuthorityEvidenceSource =
  | "SOLANA_RPC_JSON_PARSED"
  | "SOLANA_RPC_BASE64_LAYOUT"
  | "QUICKNODE_DAS"
  | "ALCHEMY_DAS"
  | "HELIUS"
  | "UNAVAILABLE";

export interface RiskEvidenceSnapshot {
  readonly mintAddress: TokenMintAddress;
  readonly source: ProviderName;
  readonly score?: number;
  readonly flags: readonly string[];
  readonly mintAuthorityState?: AuthorityState;
  readonly freezeAuthorityState?: AuthorityState;
  readonly authorityEvidenceSource?: AuthorityEvidenceSource;
  readonly tokenProgram?: string;
  readonly mintAuthorityRisk?: RiskEvidenceLevel;
  readonly freezeAuthorityRisk?: RiskEvidenceLevel;
  readonly liquidityRisk?: RiskEvidenceLevel;
  readonly holderConcentrationRisk?: RiskEvidenceLevel;
  readonly sellabilityRisk?: RiskEvidenceLevel;
  readonly rawEvidence?: unknown;
  readonly fetchedAt: Date;
}
