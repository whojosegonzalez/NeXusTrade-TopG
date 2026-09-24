import {
  parseTokenMintAddress,
  type ProviderName,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { DasAsset } from "./das.schemas.js";

function optionalSupply(value: number | string | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function safeMintAddress(value: string | undefined, fallbackMintAddress: TokenMintAddress) {
  if (!value || value.trim() === "") {
    return fallbackMintAddress;
  }

  try {
    return parseTokenMintAddress(value);
  } catch {
    return fallbackMintAddress;
  }
}

function updateAuthority(asset: DasAsset): string | undefined {
  return asset.authorities?.find((authority) => authority.address)?.address;
}

export function mapDasAssetToMetadata(
  asset: DasAsset,
  fallbackMintAddress: TokenMintAddress,
  source: Extract<ProviderName, "ALCHEMY_DAS" | "QUICKNODE_DAS">,
  fetchedAt: Date,
): TokenMetadataSnapshot {
  const metadata = asset.content?.metadata;
  const tokenInfo = asset.token_info;
  const supply = optionalSupply(tokenInfo?.supply);
  const authority = updateAuthority(asset);

  return {
    mintAddress: safeMintAddress(asset.id, fallbackMintAddress),
    source,
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
