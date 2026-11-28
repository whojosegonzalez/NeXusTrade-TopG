import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Explicit offline selection for isolated verification: the runner-pin handoff and the bounded
 * AMM v4 watch entry point. Both inject fake git, scripted fetch and in-memory transports; no
 * environment file is loaded (envDir: false) and no glob widens the selection.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../backend/", import.meta.url)),
  envDir: false,
  publicDir: false,
  cacheDir: "../node_modules/.cache/handoff-watch",
  test: {
    include: ["src/scripts/paper-pilot-handoff.test.ts", "src/scripts/fresh-amm-v4-watch.test.ts"],
    environment: "node",
    watch: false,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
