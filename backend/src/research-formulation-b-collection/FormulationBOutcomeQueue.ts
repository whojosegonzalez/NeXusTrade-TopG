import type { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";
import type {
  FormulationBForwardOutcome,
  FormulationBPrimaryLabel,
  FormulationBProviderClient,
} from "./FormulationBCollectionTypes.js";

export class FormulationBOutcomeQueue {
  constructor(
    private readonly provider: FormulationBProviderClient,
    private readonly safety: FormulationBSafetyMonitor,
  ) {}

  public async evaluateForwardOutcomes(
    canonicalMint: string,
    anchorPriceUsd: number | null,
    anchorAt: string,
    utcDate: string,
  ): Promise<FormulationBForwardOutcome> {
    if (anchorPriceUsd === null || anchorPriceUsd <= 0) {
      return {
        return60mPct: null,
        primaryLabel: "UNUSABLE_60M",
      };
    }

    const anchorMs = Date.parse(anchorAt);
    const t3m = new Date(anchorMs + 3 * 60 * 1000).toISOString();
    const t5m = new Date(anchorMs + 5 * 60 * 1000).toISOString();
    const t15m = new Date(anchorMs + 15 * 60 * 1000).toISOString();
    const t60m = new Date(anchorMs + 60 * 60 * 1000).toISOString();

    // 3m horizon
    this.safety.trackProviderCall(utcDate);
    const r3m = await this.provider.fetchSpotPrice(canonicalMint, t3m);
    this.safety.checkRateLimitResponse(r3m.status);
    this.safety.checkSecretLeakage(r3m.rawBody);

    // 5m horizon
    this.safety.trackProviderCall(utcDate);
    const r5m = await this.provider.fetchSpotPrice(canonicalMint, t5m);
    this.safety.checkRateLimitResponse(r5m.status);
    this.safety.checkSecretLeakage(r5m.rawBody);

    // 15m horizon
    this.safety.trackProviderCall(utcDate);
    const r15m = await this.provider.fetchSpotPrice(canonicalMint, t15m);
    this.safety.checkRateLimitResponse(r15m.status);
    this.safety.checkSecretLeakage(r15m.rawBody);

    // 60m horizon (Primary)
    this.safety.trackProviderCall(utcDate);
    const r60m = await this.provider.fetchSpotPrice(canonicalMint, t60m);
    this.safety.checkRateLimitResponse(r60m.status);
    this.safety.checkSecretLeakage(r60m.rawBody);

    const p3m = r3m.data.priceUsd;
    const p5m = r5m.data.priceUsd;
    const p15m = r15m.data.priceUsd;
    const p60m = r60m.data.priceUsd;

    const return3mPct = p3m !== null ? ((p3m - anchorPriceUsd) / anchorPriceUsd) * 100 : undefined;
    const return5mPct = p5m !== null ? ((p5m - anchorPriceUsd) / anchorPriceUsd) * 100 : undefined;
    const return15mPct =
      p15m !== null ? ((p15m - anchorPriceUsd) / anchorPriceUsd) * 100 : undefined;
    const return60mPct = p60m !== null ? ((p60m - anchorPriceUsd) / anchorPriceUsd) * 100 : null;

    let primaryLabel: FormulationBPrimaryLabel;
    if (return60mPct === null) {
      primaryLabel = "UNUSABLE_60M";
    } else if (return60mPct > 0) {
      primaryLabel = "POSITIVE_60M";
    } else {
      primaryLabel = "NON_POSITIVE_60M";
    }

    return {
      return60mPct,
      primaryLabel,
      return3mPct,
      return5mPct,
      return15mPct,
    };
  }
}
