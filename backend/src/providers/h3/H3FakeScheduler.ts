export class H3FakeScheduler {
  now = 0;
  private readonly tasks = new Set<{ at: number; wake: () => void; abort: () => void }>();
  clock = () => this.now;
  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const task = {
        at: this.now + ms,
        wake: () => {
          cleanup();
          resolve();
        },
        abort: () => {
          cleanup();
          reject(new Error("cancelled timer"));
        },
      };
      const cleanup = () => {
        this.tasks.delete(task);
        signal?.removeEventListener("abort", task.abort);
      };
      if (signal?.aborted) {
        reject(new Error("cancelled timer"));
        return;
      }
      this.tasks.add(task);
      signal?.addEventListener("abort", task.abort, { once: true });
    });
  get pendingTimers() {
    return this.tasks.size;
  }
  async advance(ms: number) {
    this.now += ms;
    for (const task of [...this.tasks]) if (task.at <= this.now) task.wake();
    await this.flush();
  }
  async wakeEarly() {
    for (const task of [...this.tasks]) task.wake();
    await this.flush();
  }
  async flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}
