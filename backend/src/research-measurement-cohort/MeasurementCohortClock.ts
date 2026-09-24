import type { MeasurementCohortClock } from "./MeasurementCohortTypes.js";

export class SystemMeasurementCohortClock implements MeasurementCohortClock {
  now(): Date {
    return new Date();
  }

  async sleepUntil(target: Date): Promise<void> {
    const delay = target.valueOf() - this.now().valueOf();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
