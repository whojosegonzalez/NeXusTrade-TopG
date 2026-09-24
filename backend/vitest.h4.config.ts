import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: false,
  publicDir: false,
  cacheDir: "../node_modules/.cache/h4",
  test: {
    include: ["src/analytics/AnalyticsReportService.test.ts", "src/analytics/h4/*.test.ts"],
    setupFiles: ["src/analytics/h4/H4TestSetup.ts"],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
  },
});
