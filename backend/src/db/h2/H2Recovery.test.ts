import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { h2Fixture } from "./H2Fixtures.js";
import type { H2WorkerInput } from "./H2WorkerTask.js";
import { defaultPaperExchangeConfig } from "../../paper/PaperExchangeConfig.js";
import { defaultPaperSellConfig } from "../../paper/PaperSellConfig.js";
import { executePaperBuy } from "../../paper/PaperBuyAccounting.js";
import type { PaperOperationResult } from "../../paper/PaperOperationResult.js";

let fixture: ReturnType<typeof h2Fixture> | undefined;
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  fixture?.cleanup();
  fixture = undefined;
});
type Job = H2WorkerInput extends infer T
  ? T extends H2WorkerInput
    ? Omit<T, "barrier" | "file" | "clockMs">
    : never
  : never;
interface Outcome {
  readonly exitCode: number;
  readonly result?: { readonly result: PaperOperationResult; readonly replayed: boolean };
  readonly quoteCalls?: number;
  readonly failure?: string;
}
async function race(jobs: readonly Job[]): Promise<Outcome[]> {
  const barrier = new SharedArrayBuffer(4),
    gate = new Int32Array(barrier);
  const ready: Promise<void>[] = [],
    done: Promise<Outcome>[] = [];
  for (const job of jobs) {
    const worker = new Worker(new URL("./H2Worker.mjs", import.meta.url), {
      workerData: {
        ...job,
        file: fixture!.context.path,
        clockMs: fixture!.session.createdAtMs + 60_000,
        barrier,
      },
      execArgv: [],
    });
    workers.push(worker);
    let readyResolve: () => void = () => undefined,
      readyReject: (error: Error) => void = () => undefined;
    ready.push(
      new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      }),
    );
    done.push(
      new Promise<Outcome>((resolve, reject) => {
        let outcome: Omit<Outcome, "exitCode"> = {};
        worker.on(
          "message",
          (message: {
            type: string;
            result?: Outcome["result"];
            quoteCalls?: number;
            message?: string;
          }) => {
            if (message.type === "ready") readyResolve();
            if (message.type === "result")
              outcome = {
                ...(message.result ? { result: message.result } : {}),
                ...(message.quoteCalls === undefined ? {} : { quoteCalls: message.quoteCalls }),
              };
            if (message.type === "failure")
              outcome = { failure: message.message ?? "worker failed" };
          },
        );
        worker.once("error", (error) => {
          readyReject(error);
          reject(error);
        });
        worker.once("exit", (exitCode) => {
          readyReject(new Error(`worker exited before ready: ${exitCode}`));
          resolve({ ...outcome, exitCode });
        });
      }),
    );
  }
  // Attach rejection handling immediately even while waiting for all workers to register.
  const completion = Promise.all(done);
  void completion.catch(() => undefined);
  await Promise.all(ready);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0, jobs.length);
  return completion;
}
function setup() {
  fixture = h2Fixture();
  return fixture;
}
function buy(f: ReturnType<typeof h2Fixture>): Job {
  return {
    kind: "BUY",
    candidate: { tokenRadar: f.radar, strategyDecision: f.decision },
    config: defaultPaperExchangeConfig(),
  };
}
function secondBuy(f: ReturnType<typeof h2Fixture>, sameMint = false): Job {
  const radar = sameMint
    ? f.radar
    : f.repositories.tokenRadar.createRadarEntry({
        ...f.radarInput,
        mintAddress: "SecondSyntheticMint",
      });
  const decision = f.repositories.strategyDecisions.createStrategyDecision({
    ...f.decision,
    id: "second-decision",
    mintAddress: radar.mintAddress,
  });
  return {
    kind: "BUY",
    candidate: { tokenRadar: radar, strategyDecision: decision },
    config: defaultPaperExchangeConfig(),
  };
}
function sell(f: ReturnType<typeof h2Fixture>, explicitIntentId?: string): Job {
  const position = f.repositories.positions.listOpenPositions(f.session.id)[0]!;
  return {
    kind: "SELL",
    candidate: {
      session: f.repositories.sessions.getSessionById(f.session.id)!,
      position,
      tokenRadar: f.repositories.tokenRadar.getRadarEntryById(f.radar.id)!,
    },
    config: defaultPaperSellConfig({ type: "SELL_ALL" }),
    ...(explicitIntentId ? { explicitIntentId } : {}),
  };
}
function outcomes(rows: Outcome[]) {
  expect(rows.every((row) => row.exitCode === 0 && !row.failure)).toBe(true);
  return rows.map((row) => row.result!);
}
describe("H2 independent worker concurrency and crash recovery", () => {
  it.each(["registered", "inside-commit", "after-commit"] as const)(
    "recovers SELL after worker exits %s",
    async (crash) => {
      const f = setup();
      const opening = buy(f);
      if (opening.kind !== "BUY") throw new Error("fixture");
      executePaperBuy({ ...opening, repositories: f.repositories, clock: () => Date.now() });
      const job = sell(f);
      const [lost] = await race([{ ...job, crash }]);
      expect(lost?.exitCode).toBe(
        crash === "registered" ? 70 : crash === "inside-commit" ? 71 : 72,
      );
      expect(f.repositories.positions.listClosedPositions(f.session.id)).toHaveLength(
        crash === "after-commit" ? 1 : 0,
      );
      const rows = await race([job]);
      const [resumed] = outcomes(rows);
      expect(resumed?.replayed).toBe(crash === "after-commit");
      expect(rows[0]?.quoteCalls).toBe(crash === "after-commit" ? 0 : 1);
      expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(2);
      expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
        1_009_690_000,
      );
    },
    30_000,
  );
  it("serializes duplicate SELL intent into one close and one replay", async () => {
    const f = setup();
    const opening = buy(f);
    if (opening.kind !== "BUY") throw new Error("fixture");
    executePaperBuy({ ...opening, repositories: f.repositories, clock: () => Date.now() });
    const job = sell(f);
    const results = outcomes(await race([job, job]));
    expect(results.filter((row) => row.replayed)).toHaveLength(1);
    expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(2);
  }, 30_000);
  it("preserves both credits and realized P/L for independent concurrent SELLs", async () => {
    const f = setup();
    const first = buy(f),
      second = secondBuy(f);
    if (first.kind !== "BUY" || second.kind !== "BUY") throw new Error("fixture");
    executePaperBuy({ ...first, repositories: f.repositories, clock: () => Date.now() });
    executePaperBuy({ ...second, repositories: f.repositories, clock: () => Date.now() });
    const jobs: Job[] = f.repositories.positions
      .listOpenPositions(f.session.id)
      .map((position) => ({
        kind: "SELL",
        candidate: { session: f.repositories.sessions.getSessionById(f.session.id)!, position },
        config: defaultPaperSellConfig({ type: "SELL_ALL" }),
      }));
    expect(outcomes(await race(jobs)).every((row) => row.result.state === "COMMITTED")).toBe(true);
    expect(f.repositories.sessions.getSessionById(f.session.id)).toMatchObject({
      currentCashLamports: 1_019_380_000,
      realizedPnlLamports: 19_380_000,
    });
  }, 30_000);
  it("serializes duplicate BUY intents into one commit and one replay", async () => {
    const f = setup();
    const job = buy(f);
    const results = outcomes(await race([job, job]));
    expect(results.filter((row) => row.replayed)).toHaveLength(1);
    expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(1);
  }, 30_000);
  it.each(["mint", "cash"])(
    "serializes two BUYs competing for %s",
    async (conflict) => {
      const f = setup();
      if (conflict === "cash")
        f.repositories.sessions.updateSessionPnl(f.session.id, { currentCashLamports: 15_000_000 });
      const results = outcomes(await race([buy(f), secondBuy(f, conflict === "mint")]));
      expect(results.filter((row) => row.result.state === "COMMITTED")).toHaveLength(1);
      expect(results.filter((row) => row.result.state === "REJECTED")).toHaveLength(1);
      expect(f.repositories.positions.listOpenPositions(f.session.id)).toHaveLength(1);
      expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
        (conflict === "cash" ? 15_000_000 : f.session.currentCashLamports) - 10_105_000,
      );
    },
    30_000,
  );
  it("prevents two distinct operations from closing one position", async () => {
    const f = setup();
    const job = buy(f);
    if (job.kind !== "BUY") throw new Error("fixture");
    executePaperBuy({ ...job, repositories: f.repositories, clock: () => Date.now() });
    const results = outcomes(await race([sell(f), sell(f, "distinct-close")]));
    expect(results.filter((row) => row.result.state === "COMMITTED")).toHaveLength(1);
    expect(f.repositories.positions.listClosedPositions(f.session.id)).toHaveLength(1);
    expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
      1_009_690_000,
    );
  }, 30_000);
  it("preserves aggregate deltas for a concurrent BUY and SELL", async () => {
    const f = setup();
    const job = buy(f);
    if (job.kind !== "BUY") throw new Error("fixture");
    executePaperBuy({ ...job, repositories: f.repositories, clock: () => Date.now() });
    const results = outcomes(await race([sell(f), secondBuy(f)]));
    expect(results.every((row) => row.result.state === "COMMITTED")).toBe(true);
    expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
      999_585_000,
    );
  }, 30_000);
  it.each(["registered", "inside-commit", "after-commit"] as const)(
    "recovers BUY after worker exits %s",
    async (crash) => {
      const f = setup();
      const job = buy(f);
      const [lost] = await race([{ ...job, crash }]);
      expect(lost?.exitCode).toBe(
        crash === "registered" ? 70 : crash === "inside-commit" ? 71 : 72,
      );
      expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(
        crash === "after-commit" ? 1 : 0,
      );
      const [resumed] = outcomes(await race([job]));
      expect(resumed?.replayed).toBe(crash === "after-commit");
      expect(f.repositories.fills.listFillsForSession(f.session.id)).toHaveLength(1);
      expect(f.repositories.sessions.getSessionById(f.session.id)?.currentCashLamports).toBe(
        989_895_000,
      );
    },
    30_000,
  );
  it.each([null, "pair-a"])(
    "merges racing radar records for pair %s",
    async (pairAddress) => {
      const f = setup();
      const results = await race([
        {
          kind: "RADAR",
          input: {
            ...f.radarInput,
            pairAddress,
            firstSeenAtMs: 900,
            discoveredAtMs: 2000,
            priceSol: "0.002",
          },
        },
        {
          kind: "RADAR",
          input: {
            ...f.radarInput,
            pairAddress,
            firstSeenAtMs: 800,
            discoveredAtMs: 3000,
            priceSol: "0.003",
          },
        },
      ]);
      expect(results.every((row) => row.exitCode === 0 && !row.failure)).toBe(true);
      const rows = f.repositories.tokenRadar
        .listRadarEntries(f.session.id)
        .filter((row) => row.pairAddress === pairAddress);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ firstSeenAtMs: 800, priceSol: "0.003" });
    },
    30_000,
  );
});
