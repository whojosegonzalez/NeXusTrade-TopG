import { describe, expect, it } from "vitest";

import { parseTokenMintAddress } from "@nexustrade/shared";

import {
  mapHeliusAssetToMetadata,
  mapHeliusAssetToRiskEvidence,
  mapHeliusPriorityFeeEstimate,
} from "./helius.mappers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

describe("Helius mappers", () => {
  it("normalizes asset metadata and authority evidence", () => {
    const mint = parseTokenMintAddress(SOL_MINT);
    const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
    const asset = {
      id: SOL_MINT,
      content: {
        json_uri: "https://example.test/metadata.json",
        metadata: {
          name: "Wrapped SOL",
          symbol: "SOL",
          description: "Native SOL wrapper",
        },
        links: {
          image: "https://example.test/sol.png",
        },
      },
      authorities: [{ address: "Authority111111111111111111111111111111111" }],
      token_info: {
        supply: "1000",
        decimals: 9,
        token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        mint_authority: "MintAuthority1111111111111111111111111111",
        freeze_authority: null,
      },
    };

    const metadata = mapHeliusAssetToMetadata(asset, mint, fetchedAt);
    const riskEvidence = mapHeliusAssetToRiskEvidence(asset, mint, fetchedAt);

    expect(metadata.symbol).toBe("SOL");
    expect(metadata.decimals).toBe(9);
    expect(metadata.mintAuthority).toBe("MintAuthority1111111111111111111111111111");
    expect(metadata.freezeAuthority).toBeNull();
    expect(riskEvidence.flags).toContain("mint_authority_present");
  });

  it("normalizes priority fee estimates", () => {
    const estimate = mapHeliusPriorityFeeEstimate(
      {
        priorityFeeEstimate: 12_000,
        priorityFeeLevels: {
          low: 1_000,
          medium: 5_000,
          high: 10_000,
        },
      },
      new Date("2026-06-20T12:00:00.000Z"),
    );

    expect(estimate.recommendedMicroLamports).toBe(12_000);
    expect(estimate.levels?.high).toBe(10_000);
  });
});
