import {
  parseTokenMintAddress,
  type PriorityFeeEstimateSnapshot,
  type RiskEvidenceSnapshot,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { HeliusAsset, HeliusPriorityFeeResult } from "./helius.schemas.js";

function optionalSupply(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return String(value);
}

function updateAuthority(asset: HeliusAsset): string | undefined {
  return asset.authorities?.find((authority) => authority.address)?.address;
}

export function mapHeliusAssetToMetadata(
  asset: HeliusAsset,
  fallbackMintAddress: TokenMintAddress,
  fetchedAt: Date,
): TokenMetadataSnapshot {
  const mintAddress =
    asset.id && asset.id.trim() !== "" ? parseTokenMintAddress(asset.id) : fallbackMintAddress;
  const metadata = asset.content?.metadata;
  const tokenInfo = asset.token_info;
  const supply = optionalSupply(tokenInfo?.supply);
  const authority = updateAuthority(asset);

  return {
    mintAddress,
    source: "HELIUS",
    fetchedAt,
    ...(metadata?.symbol ? { symbol: metadata.symbol } : {}),
    ...(metadata?.name ? { name: metadata.name } : {}),
    ...(metadata?.description ? { description: metadata.description } : {}),
    ...(tokenInfo?.decimals !== undefined ? { decimals: tokenInfo.decimals } : {}),
    ...(supply !== undefined ? { supply } : {}),
    ...(tokenInfo?.token_program ? { tokenProgram: tokenInfo.token_program } : {}),
    ...(tokenInfo?.mint_authority !== undefined
      ? { mintAuthority: tokenInfo.mint_authority ?? null }
      : {}),
    ...(tokenInfo?.freeze_authority !== undefined
      ? { freezeAuthority: tokenInfo.freeze_authority ?? null }
      : {}),
    ...(authority ? { updateAuthority: authority } : {}),
    ...(asset.content?.json_uri ? { metadataUri: asset.content.json_uri } : {}),
    ...(asset.content?.links?.image ? { imageUri: asset.content.links.image } : {}),
  };
}

export function mapHeliusAssetToRiskEvidence(
  asset: HeliusAsset,
  mintAddress: TokenMintAddress,
  fetchedAt: Date,
): RiskEvidenceSnapshot {
  const mintAuthority = asset.token_info?.mint_authority;
  const freezeAuthority = asset.token_info?.freeze_authority;
  const flags: string[] = [];

  if (mintAuthority) {
    flags.push("mint_authority_present");
  } else {
    flags.push("mint_authority_absent_or_unknown");
  }

  if (freezeAuthority) {
    flags.push("freeze_authority_present");
  } else {
    flags.push("freeze_authority_absent_or_unknown");
  }

  return {
    mintAddress,
    source: "HELIUS",
    fetchedAt,
    flags,
    mintAuthorityRisk: mintAuthority ? "HIGH" : "UNKNOWN",
    freezeAuthorityRisk: freezeAuthority ? "HIGH" : "UNKNOWN",
  };
}

export function mapHeliusPriorityFeeEstimate(
  result: HeliusPriorityFeeResult,
  fetchedAt: Date,
): PriorityFeeEstimateSnapshot {
  return {
    source: "HELIUS",
    fetchedAt,
    ...(result.priorityFeeEstimate !== undefined
      ? { recommendedMicroLamports: result.priorityFeeEstimate }
      : {}),
    ...(result.priorityFeeLevels
      ? {
          levels: {
            ...(result.priorityFeeLevels.min !== undefined
              ? { min: result.priorityFeeLevels.min }
              : {}),
            ...(result.priorityFeeLevels.low !== undefined
              ? { low: result.priorityFeeLevels.low }
              : {}),
            ...(result.priorityFeeLevels.medium !== undefined
              ? { medium: result.priorityFeeLevels.medium }
              : {}),
            ...(result.priorityFeeLevels.high !== undefined
              ? { high: result.priorityFeeLevels.high }
              : {}),
            ...(result.priorityFeeLevels.veryHigh !== undefined
              ? { veryHigh: result.priorityFeeLevels.veryHigh }
              : {}),
            ...(result.priorityFeeLevels.unsafeMax !== undefined
              ? { unsafeMax: result.priorityFeeLevels.unsafeMax }
              : {}),
          },
        }
      : {}),
  };
}
