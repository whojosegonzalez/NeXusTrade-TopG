import type { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";
import type {
  FormulationBDecisionFacts,
  FormulationBProviderClient,
} from "./FormulationBCollectionTypes.js";

export class FormulationBMomentumCapture {
  constructor(
    private readonly provider: FormulationBProviderClient,
    private readonly safety: FormulationBSafetyMonitor,
  ) {}

  public async captureMomentumEvidence(
    canonicalMint: string,
    anchorAt: string,
    utcDate: string,
    assetAgeSeconds: number,
  ): Promise<FormulationBDecisionFacts> {
    this.safety.trackProviderCall(utcDate);

    const response = await this.provider.fetchMomentumEvidence(canonicalMint, anchorAt);
    this.safety.checkRateLimitResponse(response.status);
    this.safety.checkSecretLeakage(response.rawBody);
    this.safety.checkClockDrift(response.headers["date"], Date.now());

    const rawData = response.data as unknown as Record<string, unknown>;
    this.safety.checkLiquidityProhibition(rawData);

    const priceUsd = typeof rawData["priceUsd"] === "number" ? rawData["priceUsd"] : null;
    const mom5m = typeof rawData["momentum5mPct"] === "number" ? rawData["momentum5mPct"] : null;
    const mom15m = typeof rawData["momentum15mPct"] === "number" ? rawData["momentum15mPct"] : null;

    let acc: number | null = null;
    if (mom5m !== null && mom15m !== null && Number.isFinite(mom5m) && Number.isFinite(mom15m)) {
      acc = mom5m - mom15m;
    }

    return {
      priceUsd,
      momentum5mPct: mom5m,
      momentum15mPct: mom15m,
      momentumAccelerationPct: acc,
      assetAgeSeconds,
      missingnessCode: mom5m === null || mom15m === null ? "MISSING_MOMENTUM_HISTORY" : undefined,
    };
  }
}
