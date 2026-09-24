import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, type TokenEnrichmentSnapshot } from "@nexustrade/shared";

import { RiskScoringService } from "./RiskScoringService.js";

const TOKEN_MINT = parseTokenMintAddress("Fake111111111111111111111111111111111111111");
const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const fetchedAt = new Date("2026-06-21T12:00:00.000Z");

describe("RiskScoringService", () => {
  it("returns WARN when authority evidence is absent or unknown", () => {
    const result = new RiskScoringService().evaluate(
      createSnapshot({
        riskEvidence: {
          mintAddress: TOKEN_MINT,
          source: "HELIUS",
          fetchedAt,
          flags: ["mint_authority_absent_or_unknown", "freeze_authority_absent_or_unknown"],
          mintAuthorityRisk: "UNKNOWN",
          freezeAuthorityRisk: "UNKNOWN",
        },
      }),
      fetchedAt.getTime(),
    );

    expect(result.result).toBe("WARN");
    expect(result.score).toBe(80);
    expect(result.facts.mintAuthorityDisabled).toBeUndefined();
    expect(result.facts.freezeAuthorityDisabled).toBeUndefined();
  });

  it("returns PASS when Solana RPC confirms authorities are disabled", () => {
    const result = new RiskScoringService().evaluate(
      createSnapshot({
        riskEvidence: {
          mintAddress: TOKEN_MINT,
          source: "SOLANA_RPC",
          fetchedAt,
          flags: ["MINT_AUTHORITY_DISABLED", "FREEZE_AUTHORITY_DISABLED"],
          mintAuthorityRisk: "LOW",
          freezeAuthorityRisk: "LOW",
          mintAuthorityState: "DISABLED",
          freezeAuthorityState: "DISABLED",
          authorityEvidenceSource: "SOLANA_RPC_JSON_PARSED",
        },
      }),
      fetchedAt.getTime(),
    );

    expect(result.result).toBe("PASS");
    expect(result.score).toBe(100);
    expect(result.flags).toEqual(["MINT_AUTHORITY_DISABLED", "FREEZE_AUTHORITY_DISABLED"]);
    expect(result.facts.mintAuthorityDisabled).toBe(true);
    expect(result.facts.freezeAuthorityDisabled).toBe(true);
  });

  it("returns FAIL for severe liquidity, age, or authority deductions", () => {
    const result = new RiskScoringService().evaluate(
      createSnapshot({
        riskEvidence: {
          mintAddress: TOKEN_MINT,
          source: "HELIUS",
          fetchedAt,
          flags: ["mint_authority_present", "freeze_authority_absent_or_unknown"],
          mintAuthorityRisk: "HIGH",
          freezeAuthorityRisk: "UNKNOWN",
        },
        liquidityUsd: 1_000,
      }),
      fetchedAt.getTime(),
    );

    expect(result.result).toBe("FAIL");
    expect(result.flags).toContain("MINT_AUTHORITY_PRESENT");
    expect(result.flags).toContain("LOW_LIQUIDITY");
  });
});

function createSnapshot(
  input: {
    readonly riskEvidence?: TokenEnrichmentSnapshot["riskEvidence"];
    readonly liquidityUsd?: number;
  } = {},
): TokenEnrichmentSnapshot {
  return {
    identity: {
      chainId: "solana",
      mintAddress: TOKEN_MINT,
      symbol: "FAKE",
    },
    bestPair: {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "pair_1",
      baseMint: TOKEN_MINT,
      quoteMint: SOL_MINT,
      source: "DEXSCREENER",
      fetchedAt,
      liquidityUsd: input.liquidityUsd ?? 20_000,
      pairCreatedAt: new Date(fetchedAt.getTime() - 60 * 60 * 1000),
    },
    buyQuote: {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inputAmountRaw: "10000000",
      outputAmountRaw: "1000000",
      estimatedPriceImpactPct: 1,
      source: "JUPITER",
      fetchedAt,
    },
    sellQuote: {
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      inputAmountRaw: "1000000",
      outputAmountRaw: "9000000",
      estimatedPriceImpactPct: 1,
      source: "JUPITER",
      fetchedAt,
    },
    ...(input.riskEvidence ? { riskEvidence: input.riskEvidence } : {}),
    sourcesUsed: ["DEXSCREENER", "JUPITER", "HELIUS"],
    warnings: [],
    fetchedAt,
  };
}
