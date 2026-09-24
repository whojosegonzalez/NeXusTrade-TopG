import { describe, expect, it } from "vitest";

import { loadAppConfig } from "./env.js";
import { assertLiveModeAllowed } from "./liveModeGuard.js";

describe("loadAppConfig", () => {
  it("defaults to paper mode", () => {
    expect(loadAppConfig({ NODE_ENV: "test" }).mode).toBe("PAPER");
  });

  it("accepts explicit paper mode", () => {
    expect(loadAppConfig({ NODE_ENV: "test", NEXUSTRADE_MODE: "PAPER" }).mode).toBe("PAPER");
  });

  it("accepts lowercase mode names", () => {
    expect(loadAppConfig({ NODE_ENV: "test", NEXUSTRADE_MODE: "paper" }).mode).toBe("PAPER");
  });

  it("rejects unknown modes", () => {
    expect(() => loadAppConfig({ NODE_ENV: "test", NEXUSTRADE_MODE: "real-money-now" })).toThrow(
      /Invalid execution mode/,
    );
  });

  it("keeps live mode blocked during Phase 1", () => {
    const config = loadAppConfig({ NODE_ENV: "test", NEXUSTRADE_MODE: "LIVE" });

    expect(() => assertLiveModeAllowed(config.mode)).toThrow(
      /LIVE mode is disabled during early development/,
    );
  });

  it("enables keyless providers by default and disables key-backed providers without crashing", () => {
    const config = loadAppConfig({ NODE_ENV: "test" });

    expect(config.providers.requestedProviders).toEqual([
      "DEXSCREENER",
      "JUPITER",
      "HELIUS",
      "RAYDIUM",
    ]);
    expect(config.providers.enabledProviders).toEqual(["DEXSCREENER", "RAYDIUM"]);
    expect(config.providers.disabledProviders.map((provider) => provider.provider)).toEqual([
      "JUPITER",
      "HELIUS",
    ]);
  });

  it("accepts explicit provider keys for Jupiter and Helius", () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      HELIUS_API_KEY: "helius-test-key",
      JUPITER_API_KEY: "jupiter-test-key",
    });

    expect(config.providers.enabledProviders).toEqual([
      "DEXSCREENER",
      "JUPITER",
      "HELIUS",
      "RAYDIUM",
    ]);
  });

  it("accepts Raydium without an API key and parses Raydium options", () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      PROVIDERS_ENABLED: "RAYDIUM",
      RAYDIUM_API_V3_BASE_URL: "https://api-v3.raydium.io/",
      RAYDIUM_BASE_URL: "https://transaction-v1.raydium.io/",
      RAYDIUM_RATE_LIMIT_PER_MINUTE: "120",
      RAYDIUM_TX_VERSION: "legacy",
      RAYDIUM_DIAGNOSTICS_ENABLED: "false",
      RAYDIUM_PRECHECK_ENABLED: "false",
      RAYDIUM_PRECHECK_TTL_MS: "30000",
      RAYDIUM_MINT_PRICE_DIAGNOSTICS_ENABLED: "true",
      RAYDIUM_CAPTURE_SANITIZED_ERROR_CONTEXT: "false",
      RAYDIUM_MAX_ERROR_MESSAGE_LENGTH: "80",
    });

    expect(config.providers.enabledProviders).toEqual(["RAYDIUM"]);
    expect(config.providers.baseUrls.raydiumApiV3).toBe("https://api-v3.raydium.io");
    expect(config.providers.baseUrls.raydiumTrade).toBe("https://transaction-v1.raydium.io");
    expect(config.providers.rateLimitsPerMinute.RAYDIUM).toBe(120);
    expect(config.providers.raydium).toMatchObject({
      txVersion: "LEGACY",
      diagnosticsEnabled: false,
      precheckEnabled: false,
      precheckTtlMs: 30_000,
      mintPriceDiagnosticsEnabled: true,
      captureSanitizedErrorContext: false,
      maxErrorMessageLength: 80,
    });
  });

  it("rejects invalid provider names", () => {
    expect(() =>
      loadAppConfig({ NODE_ENV: "test", PROVIDERS_ENABLED: "DEXSCREENER,NOPE" }),
    ).toThrow(/Invalid provider name/);
  });

  it("rejects invalid provider numbers without printing secrets", () => {
    const loadInvalidConfig = () =>
      loadAppConfig({
        NODE_ENV: "test",
        HELIUS_API_KEY: "helius-secret-value",
        PROVIDER_TIMEOUT_MS: "50",
      });

    expect(loadInvalidConfig).toThrow(/PROVIDER_TIMEOUT_MS/);
    expect(loadInvalidConfig).not.toThrow(/helius-secret-value/);
  });

  it("defaults quote resilience options", () => {
    const config = loadAppConfig({ NODE_ENV: "test" });

    expect(config.providers.quoteResilience.cache).toMatchObject({
      enabled: true,
      ttlMs: 90_000,
      maxEntries: 1_000,
    });
    expect(config.providers.jupiter).toMatchObject({
      tokenMetadataEnabled: false,
    });
    expect(config.providers.helius).toMatchObject({
      metadataCacheEnabled: true,
      riskEvidenceCacheEnabled: true,
      metadataCacheTtlMs: 3_600_000,
      riskEvidenceCacheTtlMs: 3_600_000,
      backoffEnabled: true,
      backoffBaseCooldownMs: 60_000,
      backoffMaxCooldownMs: 600_000,
      skipLowPriorityDuringCooldown: true,
    });
    expect(config.providers.raydium).toMatchObject({
      diagnosticsEnabled: true,
      precheckEnabled: true,
      precheckTtlMs: 60_000,
      mintPriceDiagnosticsEnabled: false,
      captureSanitizedErrorContext: true,
      maxErrorMessageLength: 240,
    });
    expect(config.providers.quoteResilience.backoff).toMatchObject({
      enabled: true,
      baseCooldownMs: 30_000,
      maxCooldownMs: 120_000,
      multiplier: 2,
      jitterPct: 10,
      skipLowPriorityDuringCooldown: true,
    });
  });

  it("accepts explicit quote resilience options", () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      QUOTE_CACHE_ENABLED: "false",
      QUOTE_CACHE_TTL_MS: "5000",
      QUOTE_CACHE_MAX_ENTRIES: "50",
      QUOTE_BACKOFF_ENABLED: "false",
      QUOTE_BACKOFF_BASE_COOLDOWN_MS: "1000",
      QUOTE_BACKOFF_MAX_COOLDOWN_MS: "2000",
      QUOTE_BACKOFF_MULTIPLIER: "3",
      QUOTE_BACKOFF_JITTER_PCT: "0",
      QUOTE_SKIP_LOW_PRIORITY_DURING_COOLDOWN: "false",
      JUPITER_TOKEN_METADATA_ENABLED: "true",
      HELIUS_METADATA_CACHE_ENABLED: "false",
      HELIUS_RISK_EVIDENCE_CACHE_ENABLED: "false",
      HELIUS_METADATA_CACHE_TTL_MS: "7000",
      HELIUS_RISK_EVIDENCE_CACHE_TTL_MS: "8000",
      HELIUS_BACKOFF_ENABLED: "false",
      HELIUS_BACKOFF_BASE_COOLDOWN_MS: "9000",
      HELIUS_BACKOFF_MAX_COOLDOWN_MS: "10000",
      HELIUS_SKIP_LOW_PRIORITY_DURING_COOLDOWN: "false",
    });

    expect(config.providers.quoteResilience.cache).toMatchObject({
      enabled: false,
      ttlMs: 5_000,
      maxEntries: 50,
    });
    expect(config.providers.quoteResilience.backoff).toMatchObject({
      enabled: false,
      baseCooldownMs: 1_000,
      maxCooldownMs: 2_000,
      multiplier: 3,
      jitterPct: 0,
      skipLowPriorityDuringCooldown: false,
    });
    expect(config.providers.jupiter).toMatchObject({
      tokenMetadataEnabled: true,
    });
    expect(config.providers.helius).toMatchObject({
      metadataCacheEnabled: false,
      riskEvidenceCacheEnabled: false,
      metadataCacheTtlMs: 7_000,
      riskEvidenceCacheTtlMs: 8_000,
      backoffEnabled: false,
      backoffBaseCooldownMs: 9_000,
      backoffMaxCooldownMs: 10_000,
      skipLowPriorityDuringCooldown: false,
    });
  });

  it("rejects invalid quote resilience options", () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        QUOTE_CACHE_TTL_MS: "0",
      }),
    ).toThrow(/QUOTE_CACHE_TTL_MS/);

    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        QUOTE_BACKOFF_MULTIPLIER: "0",
      }),
    ).toThrow(/QUOTE_BACKOFF_MULTIPLIER/);
  });

  it("rejects invalid Raydium options", () => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        RAYDIUM_BASE_URL: "not a url",
      }),
    ).toThrow(/RAYDIUM_BASE_URL/);

    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        RAYDIUM_API_V3_BASE_URL: "not a url",
      }),
    ).toThrow(/RAYDIUM_API_V3_BASE_URL/);

    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        RAYDIUM_RATE_LIMIT_PER_MINUTE: "0",
      }),
    ).toThrow(/RAYDIUM_RATE_LIMIT_PER_MINUTE/);

    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        RAYDIUM_TX_VERSION: "V1",
      }),
    ).toThrow(/RAYDIUM_TX_VERSION/);

    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        RAYDIUM_PRECHECK_TTL_MS: "0",
      }),
    ).toThrow(/RAYDIUM_PRECHECK_TTL_MS/);
  });
});
