import {
  parseTokenMintAddress,
  type ProviderName,
  type ProviderResult,
  type QuoteRequest,
  type QuoteResult,
} from "@nexustrade/shared";

import type { ProviderConfig } from "../providers/config/providerConfig.js";
import type { QuoteProvider } from "../providers/interfaces/index.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { QuoteProviderRouter } from "../providers/quotes/index.js";
import { RaydiumAdapter } from "../providers/raydium/RaydiumAdapter.js";
import type { QuoteDiagnoseConfig } from "./QuoteDiagnoseConfig.js";
import type {
  QuoteDiagnoseProbeName,
  QuoteDiagnoseProbeResult,
  QuoteDiagnoseReport,
} from "./QuoteDiagnoseTypes.js";

export interface QuoteDiagnoseRunnerOptions {
  readonly config: QuoteDiagnoseConfig;
  readonly providerConfig: ProviderConfig;
  readonly registry: ProviderRegistry;
  readonly providerHealthRowsBefore: number;
  readonly readProviderHealthRowsAfter: () => number;
}

export class QuoteDiagnoseRunner {
  constructor(private readonly options: QuoteDiagnoseRunnerOptions) {}

  async run(): Promise<QuoteDiagnoseReport> {
    const request = this.createQuoteRequest();
    const probes: QuoteDiagnoseProbeResult[] = [];

    if (this.shouldRun("router")) {
      const routerProbe = await this.runRouterProbe("router", request);
      probes.push(routerProbe);

      if (this.options.config.roundTrip && routerProbe.status === "ok" && routerProbe.quote) {
        probes.push(
          await this.runRouterProbe(
            "router_round_trip_sell",
            reverseRequest(request, routerProbe.quote),
          ),
        );
      }
    }

    if (this.shouldRun("raydium")) {
      probes.push(await this.runRaydiumProbe(request));
    }

    if (this.shouldRun("preflight")) {
      probes.push(await this.runPreflightProbe(request));
    }

    return {
      startedAt: new Date(),
      config: this.options.config,
      providerOrder: this.quoteProviderOrder(),
      enabledProviders: this.options.registry.listProviderNames(),
      inputContract: request,
      raydiumPreflightContract: {
        poolType: this.options.providerConfig.raydium.preflightPoolType,
        poolSortField: this.options.providerConfig.raydium.preflightSortField,
        sortType: this.options.providerConfig.raydium.preflightSortType,
        pageSize: this.options.providerConfig.raydium.preflightPageSize,
        page: this.options.providerConfig.raydium.preflightPage,
      },
      probes,
      providerHealthRowsWritten:
        this.options.readProviderHealthRowsAfter() - this.options.providerHealthRowsBefore,
      safety: {
        mode: "PAPER",
        sessionCreated: false,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      recommendedNextAction: recommendNextAction(probes),
    };
  }

  private shouldRun(mode: "router" | "raydium" | "preflight"): boolean {
    return this.options.config.mode === "all" || this.options.config.mode === mode;
  }

  private createQuoteRequest(): QuoteRequest {
    return {
      inputMint: this.options.config.inputMint,
      outputMint: this.options.config.outputMint,
      amountRaw: this.options.config.amountRaw,
      slippageBps: this.options.config.slippageBps,
    };
  }

  private async runRouterProbe(
    name: Extract<QuoteDiagnoseProbeName, "router" | "router_round_trip_sell">,
    request: QuoteRequest,
  ): Promise<QuoteDiagnoseProbeResult> {
    const provider = this.options.registry.getQuoteProviders()[0];

    if (!provider) {
      return skippedProbe(name, "No quote router is enabled.");
    }

    const result = await provider.getQuote(request);

    return this.toQuoteProbe(name, result, getRouterSnapshot(provider, request));
  }

  private async runRaydiumProbe(request: QuoteRequest): Promise<QuoteDiagnoseProbeResult> {
    const provider = this.raydiumAdapter();

    if (!provider) {
      return skippedProbe("raydium", "Raydium adapter is not enabled.");
    }

    const result = await provider.getQuote(request);

    return this.toQuoteProbe("raydium", result);
  }

  private async runPreflightProbe(request: QuoteRequest): Promise<QuoteDiagnoseProbeResult> {
    const provider = this.raydiumAdapter();

    if (!provider) {
      return skippedProbe("preflight", "Raydium adapter is not enabled.");
    }

    const preflight = await provider.diagnosePreflight(request);

    return {
      name: "preflight",
      status: preflight.status === "FAILED" ? "failed" : "ok",
      provider: "RAYDIUM",
      preflight,
      httpAttempts: [],
      ...(preflight.message ? { message: preflight.message } : {}),
      ...(preflight.failureDetail ? { raydiumFailureDetail: preflight.failureDetail } : {}),
    };
  }

  private toQuoteProbe(
    name: Extract<QuoteDiagnoseProbeName, "router" | "raydium" | "router_round_trip_sell">,
    result: ProviderResult<QuoteResult>,
    journalSnapshot?: QuoteDiagnoseProbeResult["journalSnapshot"],
  ): QuoteDiagnoseProbeResult {
    const raydiumFailureCategory = readString(result.diagnostics?.raydiumFailureCategory);
    const raydiumFailureDetail = readString(result.diagnostics?.raydiumFailureDetail);

    return {
      name,
      status: result.ok ? "ok" : "failed",
      provider: result.provider,
      message: result.ok ? `out ${result.data.outputAmountRaw}` : result.error.message,
      ...(result.ok ? { quote: result.data } : {}),
      ...(raydiumFailureCategory ? { raydiumFailureCategory } : {}),
      ...(raydiumFailureDetail ? { raydiumFailureDetail } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      httpAttempts: result.httpAttempts ?? [],
      ...(journalSnapshot ? { journalSnapshot } : {}),
    };
  }

  private raydiumAdapter(): RaydiumAdapter | undefined {
    const adapter = this.options.registry
      .listAdapters()
      .find((candidate) => candidate.name === "RAYDIUM");

    return adapter instanceof RaydiumAdapter ? adapter : undefined;
  }

  private quoteProviderOrder(): readonly ProviderName[] {
    const router = this.options.registry.getQuoteProviders()[0];

    if (router instanceof QuoteProviderRouter) {
      return this.options.registry
        .listAdapters()
        .filter((adapter) => adapter.capabilities.includes("QUOTE"))
        .map((adapter) => adapter.name);
    }

    return router ? [router.name] : [];
  }
}

function skippedProbe(name: QuoteDiagnoseProbeName, message: string): QuoteDiagnoseProbeResult {
  return {
    name,
    status: "skipped",
    message,
    httpAttempts: [],
  };
}

function getRouterSnapshot(provider: QuoteProvider, request: QuoteRequest) {
  if ("getDiagnosticSnapshot" in provider && typeof provider.getDiagnosticSnapshot === "function") {
    return provider.getDiagnosticSnapshot(request);
  }

  return undefined;
}

function reverseRequest(original: QuoteRequest, quote: QuoteResult): QuoteRequest {
  return {
    inputMint: parseTokenMintAddress(original.outputMint),
    outputMint: parseTokenMintAddress(original.inputMint),
    amountRaw: quote.outputAmountRaw,
    ...(original.slippageBps !== undefined ? { slippageBps: original.slippageBps } : {}),
  };
}

function recommendNextAction(probes: readonly QuoteDiagnoseProbeResult[]): string {
  const failures = probes.filter((probe) => probe.status === "failed");
  const unclassified = failures.filter(
    (probe) => probe.raydiumFailureDetail === "UNKNOWN" || !probe.raydiumFailureDetail,
  );

  if (unclassified.length > 0) {
    return "Fix remaining unclassified quote diagnostics before Phase 9.4B.";
  }

  if (failures.length > 0) {
    return "Failures are classified; proceed with short TerminalRunner validation.";
  }

  return "Known-route diagnostics are healthy; proceed with short TerminalRunner validation.";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
