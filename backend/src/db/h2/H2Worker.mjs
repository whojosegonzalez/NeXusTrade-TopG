import { register } from "../../../node_modules/tsx/dist/esm/api/index.mjs";

const loader = register({ namespace: "h2-owned-worker", tsconfig: false });
try {
  const { runH2Worker } = await loader.import("./H2WorkerTask.ts", import.meta.url);
  await runH2Worker();
} finally {
  await loader.unregister();
}
