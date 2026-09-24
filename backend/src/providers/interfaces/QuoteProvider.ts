import type { ProviderResult, QuoteRequest, QuoteResult } from "@nexustrade/shared";

import type { ProviderAdapter } from "./ProviderAdapter.js";

export interface QuoteProvider extends ProviderAdapter {
  readonly getQuote: (request: QuoteRequest) => Promise<ProviderResult<QuoteResult>>;
}
