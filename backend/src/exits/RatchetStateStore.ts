import type { PositionRatchetState } from "./DynamicRatchetTypes.js";

export class RatchetStateStore {
  private readonly states = new Map<string, PositionRatchetState>();

  initPositionState(
    positionId: string,
    mintAddress: string,
    entryPriceSol: number,
    initialTimestampMs: number,
    initialFloorBps = -800,
  ): PositionRatchetState {
    if (entryPriceSol <= 0) {
      throw new Error(`Invalid entryPriceSol: ${entryPriceSol}. Must be > 0.`);
    }

    const state: PositionRatchetState = {
      positionId,
      mintAddress,
      entryPriceSol,
      peakPriceSol: entryPriceSol,
      peakGainBps: 0,
      currentStopFloorBps: initialFloorBps,
      activeTier: "HARD_STOP",
      drawdownState: "NORMAL",
      drawdownEnteredAtMs: null,
      lastEvaluatedAtMs: initialTimestampMs,
    };

    this.states.set(positionId, state);
    return state;
  }

  get(positionId: string): PositionRatchetState | undefined {
    return this.states.get(positionId);
  }

  update(updatedState: PositionRatchetState): void {
    const existing = this.states.get(updatedState.positionId);
    if (existing) {
      // Enforce Monotonicity Invariant: Locked profit floor can NEVER decrease once raised above initial
      if (
        existing.currentStopFloorBps > -800 &&
        updatedState.currentStopFloorBps < existing.currentStopFloorBps
      ) {
        throw new Error(
          `Monotonicity violation for position ${updatedState.positionId}: ` +
            `attempted to lower currentStopFloorBps from ${existing.currentStopFloorBps} to ${updatedState.currentStopFloorBps}`,
        );
      }
    }
    this.states.set(updatedState.positionId, updatedState);
  }

  delete(positionId: string): boolean {
    return this.states.delete(positionId);
  }

  clear(): void {
    this.states.clear();
  }

  size(): number {
    return this.states.size;
  }
}
