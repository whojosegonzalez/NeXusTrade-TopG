import { describe, expect, it } from "vitest";

import { createProviderConfig } from "./config/providerConfig.js";
import { createProviderRegistry } from "./ProviderRegistry.js";

describe("ProviderRegistry", () => {
  it("keeps Jupiter token metadata disabled by default while quotes stay enabled", () => {
    const registry = createProviderRegistry({
      config: createProviderConfig({
        NODE_ENV: "test",
        JUPITER_API_KEY: "jupiter-test-key",
        HELIUS_API_KEY: "helius-test-key",
      }),
      mode: "PAPER",
    });

    expect(registry.listProviderNames()).toEqual(["DEXSCREENER", "JUPITER", "HELIUS", "RAYDIUM"]);
    expect(registry.getQuoteProviders()).toHaveLength(1);
    expect(registry.getTokenMetadataProviders().map((provider) => provider.name)).toEqual([
      "HELIUS",
    ]);
  });

  it("allows Jupiter token metadata explicitly and still prefers Helius first", () => {
    const registry = createProviderRegistry({
      config: createProviderConfig({
        NODE_ENV: "test",
        JUPITER_API_KEY: "jupiter-test-key",
        HELIUS_API_KEY: "helius-test-key",
        JUPITER_TOKEN_METADATA_ENABLED: "true",
      }),
      mode: "PAPER",
    });

    expect(registry.getTokenMetadataProviders().map((provider) => provider.name)).toEqual([
      "HELIUS",
      "JUPITER",
    ]);
  });

  it("enables Raydium as a keyless quote provider", () => {
    const registry = createProviderRegistry({
      config: createProviderConfig({
        NODE_ENV: "test",
        PROVIDERS_ENABLED: "RAYDIUM",
      }),
      mode: "PAPER",
    });

    expect(registry.listProviderNames()).toEqual(["RAYDIUM"]);
    expect(registry.getQuoteProviders()).toHaveLength(1);
    expect(registry.getTokenMetadataProviders()).toHaveLength(0);
  });

  it("keeps Birdeye disabled by default", () => {
    const registry = createProviderRegistry({
      config: createProviderConfig({
        NODE_ENV: "test",
        PROVIDERS_ENABLED: "DEXSCREENER",
      }),
      mode: "PAPER",
    });

    expect(registry.listProviderNames()).toEqual(["DEXSCREENER"]);
    expect(registry.getPriceProviders().map((provider) => provider.name)).toEqual(["DEXSCREENER"]);
  });

  it("enables Birdeye when explicitly configured with an API key", () => {
    const config = createProviderConfig({
      NODE_ENV: "test",
      PROVIDERS_ENABLED: "BIRDEYE",
      BIRDEYE_API_KEY: "birdeye-test-key",
    });
    const registry = createProviderRegistry({
      config,
      mode: "PAPER",
    });

    expect(config.disabledProviders).toEqual([]);
    expect(registry.listProviderNames()).toEqual(["BIRDEYE"]);
    expect(registry.getPriceProviders().map((provider) => provider.name)).toEqual(["BIRDEYE"]);
    expect(registry.getTokenMetadataProviders().map((provider) => provider.name)).toEqual([
      "BIRDEYE",
    ]);
  });

  it("disables Birdeye with a clear reason when the key is missing", () => {
    const config = createProviderConfig({
      NODE_ENV: "test",
      PROVIDERS_ENABLED: "BIRDEYE",
    });
    const registry = createProviderRegistry({
      config,
      mode: "PAPER",
    });

    expect(config.enabledProviders).toEqual([]);
    expect(config.disabledProviders).toEqual([
      {
        provider: "BIRDEYE",
        reason: "BIRDEYE_API_KEY is not set.",
      },
    ]);
    expect(registry.listProviderNames()).toEqual([]);
  });

  it("prefers Solana RPC authority evidence ahead of Helius when explicitly enabled", () => {
    const registry = createProviderRegistry({
      config: createProviderConfig({
        NODE_ENV: "test",
        PROVIDERS_ENABLED: "HELIUS,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS,JUPITER",
        HELIUS_API_KEY: "helius-test-key",
        JUPITER_API_KEY: "jupiter-test-key",
        SOLANA_RPC_BASE_URL: "https://rpc.example.test",
        QUICKNODE_DAS_BASE_URL: "https://quicknode.example.test",
        ALCHEMY_SOLANA_BASE_URL: "https://alchemy.example.test",
        JUPITER_TOKEN_METADATA_ENABLED: "true",
      }),
      mode: "PAPER",
    });

    expect(registry.getRiskEvidenceProviders().map((provider) => provider.name)).toEqual([
      "SOLANA_RPC",
      "HELIUS",
    ]);
    expect(registry.getTokenMetadataProviders().map((provider) => provider.name)).toEqual([
      "SOLANA_RPC",
      "QUICKNODE_DAS",
      "ALCHEMY_DAS",
      "HELIUS",
      "JUPITER",
    ]);
  });
});
