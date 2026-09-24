import type { Repositories } from "../db/repositories/index.js";
import type { PaperSellExecutionSummary } from "../paper/PaperSellExecutionService.js";
import type { ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";
import type { ResolvedExitAction } from "./ExitActionService.js";

export type ExitCompletionResult =
  | {
      readonly completed: true;
      readonly skippedReason?: undefined;
    }
  | {
      readonly completed: false;
      readonly skippedReason:
        | "DRY_RUN"
        | "COMPLETION_DISABLED"
        | "ACTION_NOT_SELL_ALL"
        | "SELL_FAILURES_REMAIN"
        | "OPEN_POSITIONS_REMAIN";
    };

export class ExitCompletionService {
  constructor(private readonly repositories: Pick<Repositories, "sessions" | "positions">) {}

  completeAfterExit(input: {
    readonly sessionId: string;
    readonly config: ExitManagerRuntimeConfig;
    readonly action: ResolvedExitAction;
    readonly sellSummary?: PaperSellExecutionSummary;
  }): ExitCompletionResult {
    if (input.config.dryRun) {
      return {
        completed: false,
        skippedReason: "DRY_RUN",
      };
    }

    if (!input.config.completeSessionOnExit) {
      return {
        completed: false,
        skippedReason: "COMPLETION_DISABLED",
      };
    }

    if (input.action.action !== "sell-all") {
      return {
        completed: false,
        skippedReason: "ACTION_NOT_SELL_ALL",
      };
    }

    if (input.sellSummary && input.sellSummary.failedCount + input.sellSummary.rejectedCount > 0) {
      return {
        completed: false,
        skippedReason: "SELL_FAILURES_REMAIN",
      };
    }

    if (this.repositories.positions.listOpenPositions(input.sessionId).length > 0) {
      return {
        completed: false,
        skippedReason: "OPEN_POSITIONS_REMAIN",
      };
    }

    this.repositories.sessions.completeSession(input.sessionId, input.action.trigger);

    return {
      completed: true,
    };
  }
}
