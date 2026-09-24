import type { ExploratoryCohortClock } from "./ExploratoryCohortTypes.js";

export function createSystemExploratoryCohortClock(): ExploratoryCohortClock {
  return {
    now: () => new Date(),
    sleepUntil: async (target) => {
      const delay = target.getTime() - Date.now();
      if (delay <= 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    },
  };
}
