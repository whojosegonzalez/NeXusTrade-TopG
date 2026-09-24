import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderHttpAttempt } from "@nexustrade/shared";

import type { QuoteDiagnoseProbeResult, QuoteDiagnoseReport } from "./QuoteDiagnoseTypes.js";

export function formatQuoteDiagnoseJson(report: QuoteDiagnoseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatQuoteDiagnoseReport(report: QuoteDiagnoseReport): string {
  return [
    "Quote Diagnose Report",
    "",
    "Safety Boundary",
    `  mode: ${report.safety.mode}`,
    `  session created: ${report.safety.sessionCreated}`,
    `  wallet loaded: ${report.safety.walletLoaded}`,
    `  transaction signing: ${report.safety.transactionSigning}`,
    `  transaction submission: ${report.safety.transactionSubmission}`,
    "",
    "Configured Provider Order",
    `  ${report.providerOrder.join(" -> ") || "none"}`,
    "",
    "Input Contract",
    `  inputMint: ${report.inputContract.inputMint}`,
    `  outputMint: ${report.inputContract.outputMint}`,
    `  amountRaw: ${report.inputContract.amountRaw}`,
    `  slippageBps: ${report.inputContract.slippageBps ?? "default"}`,
    "",
    "Raydium Preflight Contract",
    `  poolType: ${report.raydiumPreflightContract.poolType}`,
    `  poolSortField: ${report.raydiumPreflightContract.poolSortField}`,
    `  sortType: ${report.raydiumPreflightContract.sortType}`,
    `  pageSize: ${report.raydiumPreflightContract.pageSize}`,
    `  page: ${report.raydiumPreflightContract.page}`,
    "",
    "Per-Probe Result",
    ...report.probes.flatMap(formatProbe),
    "",
    `ProviderHealth rows written: ${report.providerHealthRowsWritten}`,
    `Recommended Next Action: ${report.recommendedNextAction}`,
  ].join("\n");
}

export function writeQuoteDiagnoseArtifacts(input: {
  readonly report: QuoteDiagnoseReport;
  readonly outputDir: string;
}): readonly string[] {
  mkdirSync(input.outputDir, { recursive: true });
  const textPath = join(input.outputDir, "quote-diagnose.txt");
  const jsonPath = join(input.outputDir, "quote-diagnose.json");

  writeFileSync(textPath, formatQuoteDiagnoseReport(input.report), "utf8");
  writeFileSync(jsonPath, formatQuoteDiagnoseJson(input.report), "utf8");

  return [textPath, jsonPath];
}

function formatProbe(probe: QuoteDiagnoseProbeResult): readonly string[] {
  return [
    `  ${probe.name}: ${probe.status}${probe.message ? ` (${probe.message})` : ""}`,
    ...(probe.provider ? [`    provider: ${probe.provider}`] : []),
    ...(probe.quote
      ? [
          `    quote source: ${probe.quote.source}`,
          `    outputAmountRaw: ${probe.quote.outputAmountRaw}`,
          `    priceImpactPct: ${probe.quote.estimatedPriceImpactPct ?? "unknown"}`,
          `    provenance: ${formatJsonCompact(probe.quote.provenance ?? {})}`,
        ]
      : []),
    ...(probe.preflight
      ? [
          `    preflight status: ${probe.preflight.status}`,
          `    preflight poolsFound: ${probe.preflight.poolsFound}`,
          `    preflight cacheStatus: ${probe.preflight.cacheStatus}`,
          `    preflight detail: ${probe.preflight.failureDetail ?? "NONE"}`,
        ]
      : []),
    ...(probe.raydiumFailureCategory
      ? [`    raydiumFailureCategory: ${probe.raydiumFailureCategory}`]
      : []),
    ...(probe.raydiumFailureDetail
      ? [`    raydiumFailureDetail: ${probe.raydiumFailureDetail}`]
      : []),
    ...(probe.diagnostics ? [`    diagnostics: ${formatJsonCompact(probe.diagnostics)}`] : []),
    "    HTTP Attempt Timeline",
    ...(probe.httpAttempts.length > 0
      ? probe.httpAttempts.map((attempt) => `      ${formatHttpAttempt(attempt)}`)
      : ["      none"]),
    "    Latest Attempt Versus Last Successful Quote",
    `      ${formatJsonCompact(probe.journalSnapshot ?? {})}`,
  ];
}

function formatHttpAttempt(attempt: ProviderHttpAttempt): string {
  return [
    `#${attempt.attemptNumber}`,
    attempt.provider,
    attempt.endpointId,
    attempt.method,
    attempt.outcome,
    `latencyMs=${attempt.latencyMs}`,
    ...(attempt.statusCode !== undefined ? [`status=${attempt.statusCode}`] : []),
    ...(attempt.retryAfterMs !== undefined ? [`retryAfterMs=${attempt.retryAfterMs}`] : []),
  ].join(" ");
}

function formatJsonCompact(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length > 500 ? `${json.slice(0, 497)}...` : json;
}
