import type { AppDatabase } from "../connection.js";
import { AccountingUnitOfWork } from "../AccountingUnitOfWork.js";
import { PaperOperationRepository } from "./PaperOperationRepository.js";
import { FillRepository } from "./FillRepository.js";
import { OrderRepository } from "./OrderRepository.js";
import { PositionRepository } from "./PositionRepository.js";
import { ProviderHealthRepository } from "./ProviderHealthRepository.js";
import { RiskAssessmentRepository } from "./RiskAssessmentRepository.js";
import { SessionRepository } from "./SessionRepository.js";
import { SnapshotRepository } from "./SnapshotRepository.js";
import { StrategyDecisionRepository } from "./StrategyDecisionRepository.js";
import { SystemLogRepository } from "./SystemLogRepository.js";
import { TokenRadarRepository } from "./TokenRadarRepository.js";
import { WatchlistReturnObservationRepository } from "./WatchlistReturnObservationRepository.js";

export interface Repositories {
  readonly accounting: AccountingUnitOfWork;
  readonly operations: PaperOperationRepository;
  readonly sessions: SessionRepository;
  readonly tokenRadar: TokenRadarRepository;
  readonly riskAssessments: RiskAssessmentRepository;
  readonly strategyDecisions: StrategyDecisionRepository;
  readonly orders: OrderRepository;
  readonly fills: FillRepository;
  readonly positions: PositionRepository;
  readonly snapshots: SnapshotRepository;
  readonly systemLogs: SystemLogRepository;
  readonly providerHealth: ProviderHealthRepository;
  readonly watchlistReturns: WatchlistReturnObservationRepository;
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    accounting: new AccountingUnitOfWork(db),
    operations: new PaperOperationRepository(db),
    sessions: new SessionRepository(db),
    tokenRadar: new TokenRadarRepository(db),
    riskAssessments: new RiskAssessmentRepository(db),
    strategyDecisions: new StrategyDecisionRepository(db),
    orders: new OrderRepository(db),
    fills: new FillRepository(db),
    positions: new PositionRepository(db),
    snapshots: new SnapshotRepository(db),
    systemLogs: new SystemLogRepository(db),
    providerHealth: new ProviderHealthRepository(db),
    watchlistReturns: new WatchlistReturnObservationRepository(db),
  };
}
