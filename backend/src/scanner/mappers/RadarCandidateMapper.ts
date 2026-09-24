import type { ProviderResult, TokenEnrichmentSnapshot } from "@nexustrade/shared";

import type { CreateRadarEntryInput } from "../../db/repositories/TokenRadarRepository.js";
import { stringifyJson } from "../../db/utils/json.js";
import type { DiscoveredTokenCandidate } from "../ScannerDiscoveryService.js";

export interface RadarCandidateMapperInput {
  readonly sessionId: string;
  readonly candidate: DiscoveredTokenCandidate;
  readonly enrichment: ProviderResult<TokenEnrichmentSnapshot>;
  readonly cycleTimestampMs: number;
}

export function mapCandidateToRadarEntry(input: RadarCandidateMapperInput): CreateRadarEntryInput {
  if (!input.enrichment.ok) {
    return {
      sessionId: input.sessionId,
      mintAddress: input.candidate.identity.mintAddress,
      source: input.candidate.source,
      firstSeenAtMs: input.candidate.discoveredAt.getTime(),
      discoveredAtMs: input.cycleTimestampMs,
      status: "ERROR",
      notes: `${input.enrichment.error.code}: ${input.enrichment.error.message}`,
      rawDataJson: stringifyJson({
        phase: "PHASE_4_SCANNER_ONLY",
        discovery: summarizeDiscovery(input.candidate),
        enrichment: {
          ok: false,
          error: input.enrichment.error,
          warnings: input.enrichment.warnings,
        },
      }),
    };
  }

  const snapshot = input.enrichment.data;
  const bestPair = snapshot.bestPair;
  const firstSeenAtMs =
    bestPair?.pairCreatedAt?.getTime() ?? input.candidate.discoveredAt.getTime();
  const ageSeconds =
    bestPair?.pairCreatedAt === undefined
      ? undefined
      : Math.max(0, Math.floor((input.cycleTimestampMs - bestPair.pairCreatedAt.getTime()) / 1000));
  const priceUsd = snapshot.price?.priceUsd ?? bestPair?.priceUsd;
  const priceSol = snapshot.price?.priceSol ?? bestPair?.priceNative;
  const liquidityUsd = bestPair?.liquidityUsd;
  const volume5mUsd = bestPair?.volume5m;
  const volume1hUsd = bestPair?.volume1h;
  const notes =
    snapshot.warnings.length > 0 ? `Enrichment warnings: ${snapshot.warnings.length}` : undefined;

  return {
    sessionId: input.sessionId,
    mintAddress: snapshot.identity.mintAddress,
    source: input.candidate.source,
    firstSeenAtMs,
    discoveredAtMs: input.cycleTimestampMs,
    status: "DISCOVERED",
    rawDataJson: stringifyJson({
      phase: "PHASE_4_SCANNER_ONLY",
      discovery: summarizeDiscovery(input.candidate),
      enrichment: summarizeEnrichment(snapshot),
    }),
    ...(snapshot.identity.symbol ? { symbol: snapshot.identity.symbol } : {}),
    ...(snapshot.identity.name ? { name: snapshot.identity.name } : {}),
    ...(bestPair?.pairAddress ? { pairAddress: bestPair.pairAddress } : {}),
    ...(priceUsd !== undefined ? { priceUsd: String(priceUsd) } : {}),
    ...(priceSol !== undefined ? { priceSol: String(priceSol) } : {}),
    ...(liquidityUsd !== undefined ? { liquidityUsd: String(liquidityUsd) } : {}),
    ...(volume5mUsd !== undefined ? { volume5mUsd: String(volume5mUsd) } : {}),
    ...(volume1hUsd !== undefined ? { volume1hUsd: String(volume1hUsd) } : {}),
    ...(ageSeconds !== undefined ? { ageSeconds } : {}),
    ...(notes ? { notes } : {}),
  };
}

function summarizeDiscovery(candidate: DiscoveredTokenCandidate): unknown {
  return {
    source: candidate.source,
    discoveredAt: candidate.discoveredAt.toISOString(),
    identity: {
      chainId: candidate.identity.chainId,
      mintAddress: candidate.identity.mintAddress,
      ...(candidate.identity.symbol ? { symbol: candidate.identity.symbol } : {}),
      ...(candidate.identity.name ? { name: candidate.identity.name } : {}),
      ...(candidate.identity.logoUri ? { logoUri: candidate.identity.logoUri } : {}),
    },
  };
}

function summarizeEnrichment(snapshot: TokenEnrichmentSnapshot): unknown {
  return {
    ok: true,
    fetchedAt: snapshot.fetchedAt.toISOString(),
    sourcesUsed: snapshot.sourcesUsed,
    warnings: snapshot.warnings,
    price: snapshot.price
      ? {
          source: snapshot.price.source,
          ...(snapshot.price.priceUsd !== undefined ? { priceUsd: snapshot.price.priceUsd } : {}),
          ...(snapshot.price.priceSol !== undefined ? { priceSol: snapshot.price.priceSol } : {}),
        }
      : undefined,
    bestPair: snapshot.bestPair
      ? {
          source: snapshot.bestPair.source,
          dexId: snapshot.bestPair.dexId,
          pairAddress: snapshot.bestPair.pairAddress,
          baseMint: snapshot.bestPair.baseMint,
          quoteMint: snapshot.bestPair.quoteMint,
          ...(snapshot.bestPair.liquidityUsd !== undefined
            ? { liquidityUsd: snapshot.bestPair.liquidityUsd }
            : {}),
          ...(snapshot.bestPair.volume5m !== undefined
            ? { volume5m: snapshot.bestPair.volume5m }
            : {}),
          ...(snapshot.bestPair.volume1h !== undefined
            ? { volume1h: snapshot.bestPair.volume1h }
            : {}),
          ...(snapshot.bestPair.pairCreatedAt
            ? { pairCreatedAt: snapshot.bestPair.pairCreatedAt.toISOString() }
            : {}),
        }
      : undefined,
    metadata: snapshot.metadata
      ? {
          source: snapshot.metadata.source,
          ...(snapshot.metadata.symbol ? { symbol: snapshot.metadata.symbol } : {}),
          ...(snapshot.metadata.name ? { name: snapshot.metadata.name } : {}),
          ...(snapshot.metadata.decimals !== undefined
            ? { decimals: snapshot.metadata.decimals }
            : {}),
        }
      : undefined,
    riskEvidence: snapshot.riskEvidence
      ? {
          source: snapshot.riskEvidence.source,
          flags: snapshot.riskEvidence.flags,
          ...(snapshot.riskEvidence.mintAuthorityRisk
            ? { mintAuthorityRisk: snapshot.riskEvidence.mintAuthorityRisk }
            : {}),
          ...(snapshot.riskEvidence.freezeAuthorityRisk
            ? { freezeAuthorityRisk: snapshot.riskEvidence.freezeAuthorityRisk }
            : {}),
        }
      : undefined,
  };
}
