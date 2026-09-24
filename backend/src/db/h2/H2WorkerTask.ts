import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "../connection.js";
import { assertH2FixturePath } from "./H2FixturePaths.js";
import { createRepositories } from "../repositories/RepositoryFactory.js";
import { executePaperBuy } from "../../paper/PaperBuyAccounting.js";
import { executePaperSell } from "../../paper/PaperSellAccounting.js";
import { identifyPaperBuy, identifyPaperSell } from "../../paper/PaperOperationIdentity.js";
import { SessionRepository } from "../repositories/SessionRepository.js";
import type { PaperExecutionCandidate } from "../../paper/PaperExecutionCandidateSelector.js";
import type { PaperSellCandidate } from "../../paper/PaperSellCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "../../paper/PaperExchangeConfig.js";
import type { PaperSellRuntimeConfig } from "../../paper/PaperSellConfig.js";
import type { CreateRadarEntryInput } from "../repositories/TokenRadarRepository.js";

export type H2WorkerInput = {
  readonly file: string;
  readonly clockMs: number;
  readonly barrier: SharedArrayBuffer;
  readonly crash?: "registered" | "inside-commit" | "after-commit";
} & (
  | {
      readonly kind: "BUY";
      readonly candidate: PaperExecutionCandidate;
      readonly config: PaperExchangeRuntimeConfig;
    }
  | {
      readonly kind: "SELL";
      readonly candidate: PaperSellCandidate;
      readonly config: PaperSellRuntimeConfig;
      readonly explicitIntentId?: string;
    }
  | { readonly kind: "RADAR"; readonly input: CreateRadarEntryInput }
);

export async function runH2Worker(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("H2 worker requires an owned parent");
  // Only this fixture parent supplies payloads; never resolve a default database or environment config.
  const input = workerData as H2WorkerInput;
  assertH2FixturePath(input.file);
  if (!(input.barrier instanceof SharedArrayBuffer)) throw new Error("H2 worker missing barrier");
  globalThis.fetch = async () => {
    throw new Error("H2_WORKER_PROVIDER_FORBIDDEN");
  };
  const context = openDatabase(input.file, "PAPER");
  const repositories = createRepositories(context.db);
  try {
    if (input.kind !== "RADAR") {
      const identity =
        input.kind === "BUY"
          ? identifyPaperBuy(input.candidate, input.config)
          : identifyPaperSell(input.candidate, input.config, input.explicitIntentId);
      repositories.accounting.run((r) => r.operations.register(identity, input.clockMs));
    }
    port.postMessage({ type: "ready" });
    const gate = new Int32Array(input.barrier);
    if (Atomics.wait(gate, 0, 0, 15_000) === "timed-out")
      throw new Error("H2_WORKER_BARRIER_TIMEOUT");
    if (input.crash === "registered") process.exit(70);
    if (input.crash === "inside-commit")
      SessionRepository.prototype.applyAccountingDelta = function () {
        process.exit(71);
      };
    let quoteCalls = 0;
    const result =
      input.kind === "RADAR"
        ? repositories.tokenRadar.upsertRadarEntry(input.input)
        : input.kind === "BUY"
          ? executePaperBuy({
              repositories,
              candidate: input.candidate,
              config: input.config,
              clock: () => input.clockMs,
            })
          : await executePaperSell({
              repositories,
              candidate: input.candidate,
              config: input.config,
              ...(input.explicitIntentId ? { explicitIntentId: input.explicitIntentId } : {}),
              clock: () => input.clockMs,
              quoteService: {
                resolveQuote: async () => {
                  quoteCalls++;
                  return {
                    ok: true,
                    quote: {
                      priceSource: "QUOTE",
                      quoteSource: "SYNTHETIC",
                      priceSol: "0.002",
                      tokensSold: input.candidate.position.tokensHeld,
                      grossProceedsLamports: 20_000_000,
                      fallbackUsed: false,
                      warnings: [],
                    },
                  };
                },
              },
            });
    if (input.crash === "after-commit") process.exit(72);
    port.postMessage({ type: "result", result, quoteCalls });
  } catch (error) {
    port.postMessage({
      type: "failure",
      message: error instanceof Error ? error.message : "worker failed",
    });
  } finally {
    context.close();
    port.close();
  }
}
