import type { SessionRecord } from "../db/schema/index.js";

export type SupportedExitTrigger = "TARGET_REACHED" | "MAX_DRAWDOWN";

export type ExitTriggerEvaluation =
  | {
      readonly supported: true;
      readonly trigger: SupportedExitTrigger;
    }
  | {
      readonly supported: false;
      readonly reason: "SESSION_NOT_GATED" | "UNSUPPORTED_TERMINATION_REASON";
      readonly terminationReason: SessionRecord["terminationReason"];
    };

export class ExitTriggerService {
  evaluate(session: SessionRecord): ExitTriggerEvaluation {
    if (
      session.terminationReason === "TARGET_REACHED" ||
      session.terminationReason === "MAX_DRAWDOWN"
    ) {
      return {
        supported: true,
        trigger: session.terminationReason,
      };
    }

    if (session.terminationReason === "NOT_TERMINATED") {
      return {
        supported: false,
        reason: "SESSION_NOT_GATED",
        terminationReason: session.terminationReason,
      };
    }

    return {
      supported: false,
      reason: "UNSUPPORTED_TERMINATION_REASON",
      terminationReason: session.terminationReason,
    };
  }
}
