import type {
  RiskEvidenceSnapshot,
  TokenMetadataSnapshot,
  TokenMintAddress,
} from "@nexustrade/shared";

import type { ParsedMintAccountSnapshot } from "./SolanaRpcMintAccountParser.js";
import { TOKEN_2022_PROGRAM_ID } from "./SolanaRpcMintAccountParser.js";

export function mapSolanaRpcMintToMetadata(
  snapshot: ParsedMintAccountSnapshot,
  fallbackMintAddress: TokenMintAddress,
): TokenMetadataSnapshot {
  return {
    mintAddress: snapshot.mintAddress || fallbackMintAddress,
    source: "SOLANA_RPC",
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.decimals !== undefined ? { decimals: snapshot.decimals } : {}),
    ...(snapshot.supply !== undefined ? { supply: snapshot.supply } : {}),
    tokenProgram: snapshot.tokenProgram,
    mintAuthority: snapshot.mintAuthority ?? null,
    freezeAuthority: snapshot.freezeAuthority ?? null,
  };
}

export function mapSolanaRpcMintToRiskEvidence(
  snapshot: ParsedMintAccountSnapshot,
): RiskEvidenceSnapshot {
  const flags: string[] = [];

  flags.push(
    snapshot.mintAuthorityState === "PRESENT"
      ? "MINT_AUTHORITY_PRESENT"
      : "MINT_AUTHORITY_DISABLED",
  );
  flags.push(
    snapshot.freezeAuthorityState === "PRESENT"
      ? "FREEZE_AUTHORITY_PRESENT"
      : "FREEZE_AUTHORITY_DISABLED",
  );

  if (snapshot.tokenProgram === TOKEN_2022_PROGRAM_ID) {
    flags.push("TOKEN_2022_EXTENSIONS_NOT_FULLY_EVALUATED");
  }

  return {
    mintAddress: snapshot.mintAddress,
    source: "SOLANA_RPC",
    fetchedAt: snapshot.fetchedAt,
    flags,
    mintAuthorityState: snapshot.mintAuthorityState,
    freezeAuthorityState: snapshot.freezeAuthorityState,
    authorityEvidenceSource: snapshot.authorityEvidenceSource,
    tokenProgram: snapshot.tokenProgram,
    mintAuthorityRisk: snapshot.mintAuthorityState === "PRESENT" ? "HIGH" : "LOW",
    freezeAuthorityRisk: snapshot.freezeAuthorityState === "PRESENT" ? "HIGH" : "LOW",
    rawEvidence: {
      parser: snapshot.parser,
      slot: snapshot.slot,
      isInitialized: snapshot.isInitialized,
    },
  };
}
