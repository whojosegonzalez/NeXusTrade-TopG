export function isVerifiedMatchingPool(
  actualResponsePoolId: string | null | undefined,
  expectedPoolId: string,
): boolean;

export interface ReadinessAuditResult {
  readonly totalSessionsFound: number;
  readonly finalizedSessionsCount: number;
  readonly interruptedSessionsCount: number;
  readonly unfinalizedSessionsCount: number;
  readonly totalDecisions: number;
  readonly totalObservations: number;
  readonly observationsWithVerifiedPool: number;
  readonly decisionsWithUsablePreDecisionReserves: number;
  readonly totalQuotesFound: number;
  readonly totalFillsFound: number;
  readonly totalSamplingRecords: number;
  readonly totalMalformedRecordsCount: number;
  readonly h1Feasible: boolean;
  readonly h2Feasible: boolean;
  readonly h3Feasible: boolean;
  readonly h4Feasible: boolean;
  readonly overallReadinessStatus: string;
}

export function runReadinessAudit(options?: {
  readonly rootDir?: string | undefined;
  readonly telemetrySessionsDir?: string | undefined;
  readonly legacySessionsDir?: string | undefined;
  readonly reportOutputPath?: string | undefined;
}): ReadinessAuditResult;
