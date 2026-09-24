import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: false,
  publicDir: false,
  cacheDir: "../node_modules/.cache/h3",
  test: {
    include: [
      "src/providers/http/providerRateLimiter.test.ts",
      "src/providers/http/ProviderHttpClient.test.ts",
      "src/providers/ProviderRegistry.test.ts",
      "src/providers/ProviderHealthService.test.ts",
      "src/providers/config/providerConfig.test.ts",
      "src/providers/birdeye/BirdeyeAdapter.test.ts",
      "src/providers/das/DasMetadataAdapter.test.ts",
      "src/providers/helius/HeliusAdapter.test.ts",
      "src/providers/raydium/RaydiumAdapter.test.ts",
      "src/providers/solana-rpc/SolanaRpcAdapter.test.ts",
      "src/providers/quotes/QuoteBudgetPlanner.test.ts",
      "src/providers/quotes/QuoteProviderRouter.test.ts",
      "src/providers/jupiter/JupiterDemandController.test.ts",
      "src/providers/h3/*.test.ts",
    ],
    setupFiles: ["src/providers/h3/H3TestSetup.ts"],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
  },
});
