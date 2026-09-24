import type {
  ProviderHttpAttempt,
  ProviderName,
  QuoteRequest,
  QuoteResult,
} from "@nexustrade/shared";

import type { ProviderConfig } from "../providers/config/providerConfig.js";
import type { QuoteAttemptJournalSnapshot } from "../providers/quotes/index.js";
import type { RaydiumPreflightResult } from "../providers/raydium/RaydiumPoolPreflightService.js";
import type { QuoteDiagnoseConfig } from "./QuoteDiagnoseConfig.js";

export type QuoteDiagnoseProbeName = "router" | "raydium" | "preflight" | "router_round_trip_sell";

export interface QuoteDiagnoseProbeResult {
  readonly name: QuoteDiagnoseProbeName;
  readonly status: "ok" | "failed" | "skipped";
  readonly message?: string;
  readonly provider?: ProviderName;
  readonly quote?: QuoteResult;
  readonly preflight?: RaydiumPreflightResult;
  readonly raydiumFailureCategory?: string;
  readonly raydiumFailureDetail?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly httpAttempts: readonly ProviderHttpAttempt[];
  readonly journalSnapshot?: QuoteAttemptJournalSnapshot;
}

export interface QuoteDiagnoseReport {
  readonly startedAt: Date;
  readonly config: QuoteDiagnoseConfig;
  readonly providerOrder: readonly ProviderName[];
  readonly enabledProviders: readonly ProviderName[];
  readonly inputContract: QuoteRequest;
  readonly raydiumPreflightContract: {
    readonly poolType: ProviderConfig["raydium"]["preflightPoolType"];
    readonly poolSortField: ProviderConfig["raydium"]["preflightSortField"];
    readonly sortType: ProviderConfig["raydium"]["preflightSortType"];
    readonly pageSize: number;
    readonly page: number;
  };
  readonly probes: readonly QuoteDiagnoseProbeResult[];
  readonly providerHealthRowsWritten: number;
  readonly safety: {
    readonly mode: "PAPER";
    readonly sessionCreated: false;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
  };
  readonly recommendedNextAction: string;
}
