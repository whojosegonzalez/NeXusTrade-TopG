import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: false,
  publicDir: false,
  cacheDir: "../node_modules/.cache/measurement-analysis",
  test: {
    include: [
      "src/research-measurement-cohort-analysis/*.test.ts",
      "src/research-formulation-b-analysis/*.test.ts",
      "src/research-formulation-b-collection/*.test.ts",
      "src/candidate-scanner/*.test.ts",
      "src/exits/DynamicRatchetService.test.ts",
      "src/paper/PaperTradingDaemon.test.ts",
      "src/wallet/*.test.ts",
      "src/session/SessionControlIpcService.test.ts",
    ],
    environment: "node",
    watch: false,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
