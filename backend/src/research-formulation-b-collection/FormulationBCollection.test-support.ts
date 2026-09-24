import type {
  FormulationBDecisionFacts,
  FormulationBDiscoveryCandidate,
  FormulationBProviderClient,
  FormulationBProviderResponse,
} from "./FormulationBCollectionTypes.js";

export interface MockProviderOptions {
  readonly discoverStatus?: number;
  readonly discoverHeaders?: Record<string, string>;
  readonly discoverRawBody?: string;
  readonly discoverCandidates?: readonly FormulationBDiscoveryCandidate[];
  readonly candidateAgeSeconds?: number;

  readonly momentumStatus?: number;
  readonly momentumHeaders?: Record<string, string>;
  readonly momentumRawBody?: string;
  readonly momentumOverride?: Partial<FormulationBDecisionFacts>;
  readonly injectedLiquidityKey?: string;
  readonly missingMomentum?: boolean;

  readonly spotPriceStatus?: number;
  readonly spotPriceHeaders?: Record<string, string>;
  readonly spotPriceRawBody?: string;
  readonly spotPriceUsd?: number | null;
}

export class MockFormulationBProviderClient implements FormulationBProviderClient {
  private candidateCounter = 0;

  constructor(private readonly options: MockProviderOptions = {}) {}

  public async discoverCandidates(
    limit: number,
  ): Promise<FormulationBProviderResponse<readonly FormulationBDiscoveryCandidate[]>> {
    const status = this.options.discoverStatus ?? 200;
    const headers = this.options.discoverHeaders ?? {
      date: new Date().toUTCString(),
    };
    const rawBody = this.options.discoverRawBody ?? '{"ok":true}';

    if (this.options.discoverCandidates) {
      return {
        status,
        headers,
        data: this.options.discoverCandidates,
        latencyMs: 15,
        rawBody,
      };
    }

    const cands: FormulationBDiscoveryCandidate[] = [];
    for (let i = 0; i < limit; i++) {
      this.candidateCounter++;
      const canonicalMint = `MintSynthetic${String(this.candidateCounter).padStart(36, "0")}`;
      cands.push({
        canonicalMint,
        slotId: `slot-${this.candidateCounter}`,
        discoveredAt: new Date().toISOString(),
        assetAgeSeconds: this.options.candidateAgeSeconds ?? 600,
      });
    }

    return {
      status,
      headers,
      data: cands,
      latencyMs: 15,
      rawBody,
    };
  }

  public async fetchMomentumEvidence(
    canonicalMint: string,
    anchorAt: string,
  ): Promise<FormulationBProviderResponse<FormulationBDecisionFacts>> {
    void canonicalMint;
    void anchorAt;
    const status = this.options.momentumStatus ?? 200;
    const headers = this.options.momentumHeaders ?? {
      date: new Date().toUTCString(),
    };
    const rawBody = this.options.momentumRawBody ?? '{"momentum":"captured"}';

    const facts: Record<string, unknown> = {
      priceUsd: 1.0,
      momentum5mPct: this.options.missingMomentum ? null : 10.0,
      momentum15mPct: this.options.missingMomentum ? null : 4.0,
      momentumAccelerationPct: this.options.missingMomentum ? null : 6.0,
      assetAgeSeconds: this.options.candidateAgeSeconds ?? 600,
      ...this.options.momentumOverride,
    };

    if (this.options.injectedLiquidityKey) {
      facts[this.options.injectedLiquidityKey] = 50000;
    }

    return {
      status,
      headers,
      data: facts as unknown as FormulationBDecisionFacts,
      latencyMs: 25,
      rawBody,
    };
  }

  public async fetchSpotPrice(
    canonicalMint: string,
    targetAt: string,
  ): Promise<FormulationBProviderResponse<{ priceUsd: number | null }>> {
    void canonicalMint;
    void targetAt;
    const status = this.options.spotPriceStatus ?? 200;
    const headers = this.options.spotPriceHeaders ?? {
      date: new Date().toUTCString(),
    };
    const rawBody = this.options.spotPriceRawBody ?? '{"spot":"ok"}';
    const priceUsd = this.options.spotPriceUsd !== undefined ? this.options.spotPriceUsd : 1.05;

    return {
      status,
      headers,
      data: { priceUsd },
      latencyMs: 20,
      rawBody,
    };
  }
}
