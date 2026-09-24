import type { RaydiumPoolInfo, RaydiumPoolsByMintResponse } from "./raydium.pool.schemas.js";

export interface RaydiumPoolPreflightSummary {
  readonly poolsFound: number;
  readonly productTypes: readonly string[];
}

export function mapRaydiumPoolsByMintResponse(
  response: RaydiumPoolsByMintResponse,
): RaydiumPoolPreflightSummary {
  const pools = readPools(response);
  const productTypes = [
    ...new Set(
      pools
        .map((pool) => pool.type ?? pool.programId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ].sort();

  return {
    poolsFound: pools.length,
    productTypes,
  };
}

function readPools(response: RaydiumPoolsByMintResponse): readonly RaydiumPoolInfo[] {
  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (response.data && Array.isArray(response.data.data)) {
    return response.data.data;
  }

  return [];
}
