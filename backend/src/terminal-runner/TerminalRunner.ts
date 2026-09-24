import { createId } from "../db/utils/ids.js";
import type { TerminalRunnerRuntimeConfig } from "./TerminalRunnerConfig.js";
import {
  mergeProviderPressureSummaries,
  TERMINAL_STAGE_NAMES,
  type TerminalCycleStatus,
  type TerminalCycleSummary,
  type TerminalRunSummary,
  type TerminalStageName,
  type TerminalStageResult,
} from "./TerminalRunSummary.js";

export interface TerminalStageExecutor {
  readonly runStage: (name: TerminalStageName) => Promise<TerminalStageResult>;
}

export type TerminalRunnerProgressLogger = (message: string) => void;

export interface TerminalRunnerOptions {
  readonly config: TerminalRunnerRuntimeConfig;
  readonly stageExecutor: TerminalStageExecutor;
  readonly sessionId?: string;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly stageNames?: readonly TerminalStageName[];
  readonly progress?: TerminalRunnerProgressLogger;
}

export class TerminalRunner {
  private stopped = false;
  private readonly clock: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly stageNames: readonly TerminalStageName[];

  constructor(private readonly options: TerminalRunnerOptions) {
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.stageNames = options.stageNames ?? TERMINAL_STAGE_NAMES;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<TerminalRunSummary> {
    const runId = createId("terminal");
    const startedAtMs = this.clock();
    const deadlineMs =
      this.options.config.maxRuntimeMinutes !== undefined
        ? startedAtMs + this.options.config.maxRuntimeMinutes * 60_000
        : undefined;
    const cycles: TerminalCycleSummary[] = [];
    let fatalErrorMessage: string | undefined;

    while (this.shouldStartCycle(cycles.length, deadlineMs)) {
      const cycle = await this.runCycle(cycles.length + 1);
      cycles.push(cycle);

      const fatalStage = cycle.stages.find(
        (stage) => stage.status === "FAILED" && !stage.recoverableFailure,
      );

      if (fatalStage) {
        fatalErrorMessage = fatalStage.errorMessage ?? `${fatalStage.name} failed.`;
        break;
      }

      if (!this.shouldSleepBeforeNextCycle(cycles.length, deadlineMs)) {
        break;
      }

      this.emitProgress(
        `Waiting ${this.options.config.intervalMs}ms before cycle ${cycles.length + 1}.`,
      );
      await this.sleep(this.options.config.intervalMs);
    }

    const endedAtMs = this.clock();
    const providerPressure = mergeProviderPressureSummaries(
      cycles.map((cycle) => cycle.providerPressure),
    );

    return {
      runId,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      mode: "PAPER",
      shadowOnly: true,
      safetyStatus: fatalErrorMessage ? "FAILED" : "PASS",
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      ...(this.options.config.cycles !== undefined
        ? { requestedCycles: this.options.config.cycles }
        : {}),
      ...(this.options.config.maxRuntimeMinutes !== undefined
        ? { maxRuntimeMinutes: this.options.config.maxRuntimeMinutes }
        : {}),
      intervalMs: this.options.config.intervalMs,
      cycleCount: cycles.length,
      cycles,
      providerPressure,
      stopped: this.stopped,
      ...(fatalErrorMessage ? { fatalErrorMessage } : {}),
    };
  }

  private async runCycle(cycleNumber: number): Promise<TerminalCycleSummary> {
    const startedAtMs = this.clock();
    const stages: TerminalStageResult[] = [];

    this.emitProgress(`Cycle ${cycleNumber} started.`);

    for (const stageName of this.stageNames) {
      if (this.stopped) {
        break;
      }

      this.emitProgress(`Cycle ${cycleNumber} stage ${stageName} started.`);
      const result = await this.options.stageExecutor.runStage(stageName);
      stages.push(result);
      this.emitProgress(
        `Cycle ${cycleNumber} stage ${stageName} ${result.status}: ${result.summary}`,
      );

      if (result.status === "FAILED" && !result.recoverableFailure) {
        break;
      }
    }

    const endedAtMs = this.clock();

    const cycle = {
      cycleNumber,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      status: summarizeCycleStatus(stages),
      stages,
      providerPressure: mergeProviderPressureSummaries(
        stages.map((stage) => stage.providerPressure),
      ),
    };

    this.emitProgress(
      `Cycle ${cycleNumber} complete: ${cycle.status} durationMs=${cycle.durationMs}.`,
    );

    return cycle;
  }

  private shouldStartCycle(completedCycles: number, deadlineMs: number | undefined): boolean {
    if (this.stopped) {
      return false;
    }

    if (this.options.config.once) {
      return completedCycles === 0;
    }

    if (this.options.config.cycles !== undefined && completedCycles >= this.options.config.cycles) {
      return false;
    }

    return deadlineMs === undefined || this.clock() < deadlineMs;
  }

  private shouldSleepBeforeNextCycle(
    completedCycles: number,
    deadlineMs: number | undefined,
  ): boolean {
    if (this.stopped || this.options.config.once) {
      return false;
    }

    if (this.options.config.cycles !== undefined && completedCycles >= this.options.config.cycles) {
      return false;
    }

    return deadlineMs === undefined || this.clock() + this.options.config.intervalMs < deadlineMs;
  }

  private emitProgress(message: string): void {
    this.options.progress?.(`[${new Date(this.clock()).toISOString()}] ${message}`);
  }
}

function summarizeCycleStatus(stages: readonly TerminalStageResult[]): TerminalCycleStatus {
  if (stages.some((stage) => stage.status === "FAILED" && !stage.recoverableFailure)) {
    return "FAILED";
  }

  if (stages.some((stage) => stage.status === "FAILED" || stage.status === "EMPTY")) {
    return "PARTIAL";
  }

  return "SUCCESS";
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
