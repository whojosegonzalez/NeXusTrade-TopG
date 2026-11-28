import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Explicit offline selection for isolated verification: the CPMM evidence, acquisition, activity
 * check, observation, retrospective and credential-sanitizer script suites. No glob widens the
 * selection, no environment file is loaded (envDir: false), and the offline guard refuses
 * external requests and real credential-file reads (loopback only).
 */
export default defineConfig({
  root: fileURLToPath(new URL("../backend/", import.meta.url)),
  envDir: false,
  publicDir: false,
  cacheDir: "../node_modules/.cache/cpmm-scripts",
  test: {
    include: [
      "src/scripts/cpmm-pool-acquisition-evidence.test.ts",
      "src/scripts/cpmm-pool-activity-check.test.ts",
      "src/scripts/cpmm-pool-observation-evidence.test.ts",
      "src/scripts/cpmm-pool-observation-run.test.ts",
      "src/scripts/cpmm-pool-observation.test.ts",
      "src/scripts/cpmm-retrospective-transaction.test.ts",
      "src/scripts/evidence-credential-sanitizer.test.ts",
    ],
    setupFiles: [fileURLToPath(new URL("./vitest-offline-guard.setup.mjs", import.meta.url))],
    environment: "node",
    watch: false,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
