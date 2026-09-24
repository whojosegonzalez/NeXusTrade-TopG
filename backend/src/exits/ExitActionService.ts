import type { ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";
import type { ExitTriggerEvaluation, SupportedExitTrigger } from "./ExitTriggerService.js";

export type ResolvedExitAction =
  | {
      readonly action: "sell-all";
      readonly trigger: SupportedExitTrigger;
    }
  | {
      readonly action: "observe";
      readonly trigger?: SupportedExitTrigger;
      readonly reason: "NO_SUPPORTED_TRIGGER" | "TARGET_ACTION_OBSERVE" | "DRAWDOWN_ACTION_OBSERVE";
    };

export class ExitActionService {
  resolve(
    triggerEvaluation: ExitTriggerEvaluation,
    config: ExitManagerRuntimeConfig,
  ): ResolvedExitAction {
    if (!triggerEvaluation.supported) {
      return {
        action: "observe",
        reason: "NO_SUPPORTED_TRIGGER",
      };
    }

    if (triggerEvaluation.trigger === "TARGET_REACHED") {
      return config.targetAction === "sell-all"
        ? {
            action: "sell-all",
            trigger: triggerEvaluation.trigger,
          }
        : {
            action: "observe",
            trigger: triggerEvaluation.trigger,
            reason: "TARGET_ACTION_OBSERVE",
          };
    }

    return config.drawdownAction === "sell-all"
      ? {
          action: "sell-all",
          trigger: triggerEvaluation.trigger,
        }
      : {
          action: "observe",
          trigger: triggerEvaluation.trigger,
          reason: "DRAWDOWN_ACTION_OBSERVE",
        };
  }
}
