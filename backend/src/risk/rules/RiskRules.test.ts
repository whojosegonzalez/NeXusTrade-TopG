import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, type DexPairSnapshot, type QuoteResult } from "@nexustrade/shared";

import { evaluateAuthorityRule } from "./AuthorityRule.js";
import { evaluateLiquidityRule } from "./LiquidityRule.js";
import { evaluatePairAgeRule } from "./PairAgeRule.js";
import { evaluatePriceImpactRule } from "./PriceImpactRule.js";

const TOKEN_MINT = parseTokenMintAddress("Fake111111111111111111111111111111111111111");
const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const fetchedAt = new Date("2026-06-21T12:00:00.000Z");

describe("risk rules", () => {
  it("treats present authorities as FAIL and absent-or-unknown authority evidence as WARN", () => {
    expect(
      evaluateAuthorityRule({
        mintAddress: TOKEN_MINT,
        source: "HELIUS",
        fetchedAt,
        flags: ["mint_authority_present", "freeze_authority_absent_or_unknown"],
        mintAuthorityRisk: "HIGH",
        freezeAuthorityRisk: "UNKNOWN",
      }),
    ).toMatchObject({
      severity: "FAIL",
      flags: ["MINT_AUTHORITY_PRESENT", "FREEZE_AUTHORITY_UNKNOWN", "MISSING_AUTHORITY_EVIDENCE"],
      facts: {
        mintAuthorityDisabled: false,
      },
    });

    const unknown = evaluateAuthorityRule({
      mintAddress: TOKEN_MINT,
      source: "HELIUS",
      fetchedAt,
      flags: ["mint_authority_absent_or_unknown", "freeze_authority_absent_or_unknown"],
      mintAuthorityRisk: "UNKNOWN",
      freezeAuthorityRisk: "UNKNOWN",
    });

    expect(unknown.severity).toBe("WARN");
    expect(unknown.facts.mintAuthorityDisabled).toBeUndefined();
    expect(unknown.facts.freezeAuthorityDisabled).toBeUndefined();
  });

  it("treats explicit disabled Solana RPC authorities as PASS evidence", () => {
    const result = evaluateAuthorityRule({
      mintAddress: TOKEN_MINT,
      source: "SOLANA_RPC",
      fetchedAt,
      flags: ["MINT_AUTHORITY_DISABLED", "FREEZE_AUTHORITY_DISABLED"],
      mintAuthorityRisk: "LOW",
      freezeAuthorityRisk: "LOW",
      mintAuthorityState: "DISABLED",
      freezeAuthorityState: "DISABLED",
      authorityEvidenceSource: "SOLANA_RPC_JSON_PARSED",
    });

    expect(result).toMatchObject({
      severity: "PASS",
      flags: ["MINT_AUTHORITY_DISABLED", "FREEZE_AUTHORITY_DISABLED"],
      deductions: [],
      facts: {
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
      },
    });
  });

  it("evaluates liquidity thresholds", () => {
    expect(evaluateLiquidityRule(createPair({ liquidityUsd: 1_999 })).severity).toBe("FAIL");
    expect(evaluateLiquidityRule(createPair({ liquidityUsd: 5_000 })).severity).toBe("WARN");
    expect(evaluateLiquidityRule(createPair({ liquidityUsd: 10_000 })).severity).toBe("PASS");
  });

  it("evaluates pair age thresholds", () => {
    const checkedAtMs = fetchedAt.getTime();

    expect(
      evaluatePairAgeRule(
        createPair({
          pairCreatedAt: new Date(checkedAtMs - 4 * 60 * 1000),
        }),
        checkedAtMs,
      ).severity,
    ).toBe("FAIL");
    expect(
      evaluatePairAgeRule(
        createPair({
          pairCreatedAt: new Date(checkedAtMs - 10 * 60 * 1000),
        }),
        checkedAtMs,
      ).severity,
    ).toBe("WARN");
    expect(
      evaluatePairAgeRule(
        createPair({
          pairCreatedAt: new Date(checkedAtMs - 31 * 60 * 1000),
        }),
        checkedAtMs,
      ).severity,
    ).toBe("PASS");
  });

  it("evaluates price impact and missing quotes", () => {
    expect(evaluatePriceImpactRule(undefined, undefined).severity).toBe("WARN");
    expect(
      evaluatePriceImpactRule(
        createQuote({ estimatedPriceImpactPct: 4.9 }),
        createQuote({ estimatedPriceImpactPct: 1 }),
      ).severity,
    ).toBe("PASS");
    expect(
      evaluatePriceImpactRule(
        createQuote({ estimatedPriceImpactPct: 5 }),
        createQuote({ estimatedPriceImpactPct: 1 }),
      ).severity,
    ).toBe("WARN");
    expect(
      evaluatePriceImpactRule(
        createQuote({ estimatedPriceImpactPct: 16 }),
        createQuote({ estimatedPriceImpactPct: 1 }),
      ).severity,
    ).toBe("FAIL");
  });
});

function createPair(input: Partial<DexPairSnapshot>): DexPairSnapshot {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "pair_1",
    baseMint: TOKEN_MINT,
    quoteMint: SOL_MINT,
    source: "DEXSCREENER",
    fetchedAt,
    ...input,
  };
}

function createQuote(input: Partial<QuoteResult>): QuoteResult {
  return {
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    inputAmountRaw: "10000000",
    outputAmountRaw: "1000000",
    source: "JUPITER",
    fetchedAt,
    ...input,
  };
}
