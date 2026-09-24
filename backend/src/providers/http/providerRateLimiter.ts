import type { ProviderName } from "@nexustrade/shared";
export interface ProviderRateLimitDecision {
  readonly waitedMs: number;
  readonly delayed: boolean;
}
export interface ProviderAdmissionControls {
  readonly signal?: AbortSignal;
  readonly maxQueueWaitMs?: number;
}
export type ProviderAdmissionErrorCode =
  | "ADMISSION_CANCELLED"
  | "ADMISSION_DEADLINE"
  | "ADMISSION_QUEUE_FULL"
  | "ADMISSION_INVALID_CONFIG"
  | "ADMISSION_INVALID_CLOCK"
  | "ADMISSION_SCHEDULER_FAILED";
export class ProviderAdmissionError extends Error {
  constructor(readonly code: ProviderAdmissionErrorCode) {
    super(code);
    this.name = "ProviderAdmissionError";
  }
}
type Clock = () => number;
type Sleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;
interface Entry {
  readonly started: number;
  readonly deadline: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: ProviderRateLimitDecision) => void;
  readonly reject: (error: ProviderAdmissionError) => void;
  abort: () => void;
}
interface State {
  readonly cap: number;
  timestamps: number[];
  readonly queue: Entry[];
  lastEarlyWake?: number;
  wake?: { readonly controller: AbortController; readonly at: number };
}
const WINDOW_MS = 60_000;
function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Instance-local rolling-window reservations, atomically admitted within one JavaScript owner. */
export class ProviderRateLimiter {
  private readonly states = new Map<ProviderName, State>();
  private queued = 0;
  private lastNow = 0;
  constructor(
    private readonly clock: Clock = () => performance.now(),
    private readonly sleep: Sleep = defaultSleep,
    private readonly maxQueuedRequests = 1024,
  ) {
    if (!Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 1)
      throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
  }
  waitForSlot(
    provider: ProviderName,
    cap: number,
    controls: ProviderAdmissionControls = {},
  ): Promise<ProviderRateLimitDecision> {
    return new Promise((resolve, reject) => {
      try {
        if (
          !Number.isSafeInteger(cap) ||
          cap < 0 ||
          (controls.maxQueueWaitMs !== undefined &&
            (!Number.isSafeInteger(controls.maxQueueWaitMs) || controls.maxQueueWaitMs < 0))
        )
          throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
        const now = this.now();
        const deadline =
          controls.maxQueueWaitMs === undefined ? undefined : now + controls.maxQueueWaitMs;
        if (
          deadline !== undefined &&
          (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER)
        )
          throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
        if (controls.signal?.aborted) throw new ProviderAdmissionError("ADMISSION_CANCELLED");
        if (deadline !== undefined && now >= deadline)
          throw new ProviderAdmissionError("ADMISSION_DEADLINE");
        let state = this.states.get(provider);
        if (state && state.cap !== cap)
          throw new ProviderAdmissionError("ADMISSION_INVALID_CONFIG");
        if (!state) {
          state = { cap, timestamps: [], queue: [] };
          this.states.set(provider, state);
        }
        const drainError = this.drain(state);
        if (drainError) throw drainError;
        if (state.queue.length === 0 && (cap === 0 || state.timestamps.length < cap)) {
          const admittedAt = this.now();
          if (controls.signal?.aborted) throw new ProviderAdmissionError("ADMISSION_CANCELLED");
          if (deadline !== undefined && admittedAt >= deadline)
            throw new ProviderAdmissionError("ADMISSION_DEADLINE");
          if (cap > 0) state.timestamps.push(admittedAt);
          resolve({ waitedMs: 0, delayed: false });
          return;
        }
        if (this.queued >= this.maxQueuedRequests)
          throw new ProviderAdmissionError("ADMISSION_QUEUE_FULL");
        const entry: Entry = {
          started: now,
          deadline,
          signal: controls.signal,
          resolve,
          reject,
          abort: () => undefined,
        };
        const owned = state;
        entry.abort = () => {
          const index = owned.queue.indexOf(entry);
          if (index < 0) return;
          this.remove(owned, index);
          reject(new ProviderAdmissionError("ADMISSION_CANCELLED"));
          this.drain(owned);
        };
        state.queue.push(entry);
        this.queued++;
        controls.signal?.addEventListener("abort", entry.abort, { once: true });
        this.drain(state);
      } catch (error) {
        reject(error);
      }
    });
  }
  private now(): number {
    let now: number;
    try {
      now = this.clock();
    } catch {
      throw new ProviderAdmissionError("ADMISSION_INVALID_CLOCK");
    }
    if (!Number.isFinite(now) || now < 0 || now < this.lastNow)
      throw new ProviderAdmissionError("ADMISSION_INVALID_CLOCK");
    this.lastNow = now;
    return now;
  }
  private remove(state: State, index: number): Entry {
    const entry = state.queue.splice(index, 1)[0]!;
    this.queued--;
    entry.signal?.removeEventListener("abort", entry.abort);
    return entry;
  }
  private cancelWake(state: State): void {
    const wake = state.wake;
    delete state.wake;
    wake?.controller.abort();
  }
  private fail(state: State, error: ProviderAdmissionError): void {
    this.cancelWake(state);
    while (state.queue.length) this.remove(state, 0).reject(error);
  }
  private drain(state: State): ProviderAdmissionError | undefined {
    try {
      const now = this.now();
      state.timestamps = state.timestamps.filter((time) => now - time < WINDOW_MS);
      for (let i = state.queue.length - 1; i >= 0; i--) {
        const entry = state.queue[i]!;
        const code = entry.signal?.aborted
          ? "ADMISSION_CANCELLED"
          : entry.deadline !== undefined && now >= entry.deadline
            ? "ADMISSION_DEADLINE"
            : undefined;
        if (code) this.remove(state, i).reject(new ProviderAdmissionError(code));
      }
      while (state.queue.length && (state.cap === 0 || state.timestamps.length < state.cap)) {
        const entry = this.remove(state, 0);
        if (state.cap > 0) state.timestamps.push(now);
        const waitedMs = now - entry.started;
        entry.resolve({ waitedMs, delayed: waitedMs > 0 });
      }
      if (!state.queue.length) {
        this.cancelWake(state);
        delete state.lastEarlyWake;
        return;
      }
      let wakeAt = state.timestamps[0]! + WINDOW_MS;
      for (const entry of state.queue)
        if (entry.deadline !== undefined) wakeAt = Math.min(wakeAt, entry.deadline);
      if (state.wake?.at === wakeAt) return;
      this.cancelWake(state);
      const wake = { controller: new AbortController(), at: wakeAt };
      state.wake = wake;
      Promise.resolve(this.sleep(Math.max(0, wakeAt - now), wake.controller.signal)).then(
        () => {
          if (state.wake !== wake) return;
          delete state.wake;
          try {
            const observed = this.now();
            // A broken injected sleeper must not recursively resolve forever at frozen time.
            if (observed < wake.at) {
              if (state.lastEarlyWake === observed)
                throw new ProviderAdmissionError("ADMISSION_SCHEDULER_FAILED");
              state.lastEarlyWake = observed;
            } else delete state.lastEarlyWake;
          } catch (error) {
            this.fail(
              state,
              error instanceof ProviderAdmissionError
                ? error
                : new ProviderAdmissionError("ADMISSION_INVALID_CLOCK"),
            );
            return;
          }
          this.drain(state);
        },
        () => {
          if (state.wake === wake)
            this.fail(state, new ProviderAdmissionError("ADMISSION_SCHEDULER_FAILED"));
        },
      );
    } catch (error) {
      const failure =
        error instanceof ProviderAdmissionError
          ? error
          : new ProviderAdmissionError("ADMISSION_SCHEDULER_FAILED");
      this.fail(state, failure);
      return failure;
    }
    return undefined;
  }
}
