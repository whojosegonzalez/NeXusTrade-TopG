import type { ProviderName, QuoteRequest } from "@nexustrade/shared";

export interface QuoteRequestKeyInput {
  readonly provider: ProviderName;
  readonly request: QuoteRequest;
}

export function buildQuoteRequestKey(input: QuoteRequestKeyInput): string {
  return JSON.stringify({
    provider: input.provider,
    inputMint: input.request.inputMint,
    outputMint: input.request.outputMint,
    amountRaw: input.request.amountRaw,
    side: input.request.side,
    slippageBps: input.request.slippageBps,
    onlyDirectRoutes: input.request.onlyDirectRoutes,
    maxAccounts: input.request.maxAccounts,
  });
}
