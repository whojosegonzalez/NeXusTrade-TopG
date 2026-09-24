import type { AppDatabase } from "./connection.js";
import { SessionRepository } from "./repositories/SessionRepository.js";
import { TokenRadarRepository } from "./repositories/TokenRadarRepository.js";
import { StrategyDecisionRepository } from "./repositories/StrategyDecisionRepository.js";
import { RiskAssessmentRepository } from "./repositories/RiskAssessmentRepository.js";
import { OrderRepository } from "./repositories/OrderRepository.js";
import { FillRepository } from "./repositories/FillRepository.js";
import { PositionRepository } from "./repositories/PositionRepository.js";
import { PaperOperationRepository } from "./repositories/PaperOperationRepository.js";

export interface AccountingRepositories {
  readonly sessions: SessionRepository;
  readonly tokenRadar: TokenRadarRepository;
  readonly strategyDecisions: StrategyDecisionRepository;
  readonly riskAssessments: RiskAssessmentRepository;
  readonly orders: OrderRepository;
  readonly fills: FillRepository;
  readonly positions: PositionRepository;
  readonly operations: PaperOperationRepository;
}

export class AccountingUnitOfWork {
  private running = false;
  constructor(private readonly db: AppDatabase) {}
  run<T>(work: (repositories: AccountingRepositories) => T): T {
    if (this.running) throw new Error("ACCOUNTING_NESTED_TRANSACTION");
    this.running = true;
    try {
      return this.db.transaction(
        (tx) => {
          let active = true;
          const guard = () => {
            if (!active) throw new Error("ACCOUNTING_TRANSACTION_EXPIRED");
          };
          const repositories: AccountingRepositories = Object.freeze({
            sessions: scoped(new SessionRepository(tx), guard),
            tokenRadar: scoped(new TokenRadarRepository(tx), guard),
            strategyDecisions: scoped(new StrategyDecisionRepository(tx), guard),
            riskAssessments: scoped(new RiskAssessmentRepository(tx), guard),
            orders: scoped(new OrderRepository(tx), guard),
            fills: scoped(new FillRepository(tx), guard),
            positions: scoped(new PositionRepository(tx), guard),
            operations: scoped(new PaperOperationRepository(tx), guard),
          });
          try {
            const result = work(repositories);
            active = false;
            if (
              result !== null &&
              (typeof result === "object" || typeof result === "function") &&
              typeof Reflect.get(result, "then") === "function"
            ) {
              // Consume rejected continuations after invalidating their repository access.
              void Promise.resolve(result).catch(() => undefined);
              throw new Error("ACCOUNTING_ASYNC_CALLBACK");
            }
            return result;
          } finally {
            active = false;
          }
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
        const code = Reflect.get(cause, "code");
        if (typeof code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)/.test(code))
          throw new Error("PAPER_OPERATION_RETRYABLE_CONTENTION");
        cause = Reflect.get(cause, "cause");
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}

function scoped<T extends object>(repository: T, guard: () => void): T {
  return new Proxy(repository, {
    get(target, key) {
      guard();
      const method = Reflect.get(target, key);
      if (typeof method !== "function" || key === "constructor")
        throw new Error("ACCOUNTING_PRIVATE_ACCESS");
      return (...args: unknown[]) => {
        guard();
        return Reflect.apply(method, target, args);
      };
    },
    set: () => false,
    defineProperty: () => false,
  });
}
