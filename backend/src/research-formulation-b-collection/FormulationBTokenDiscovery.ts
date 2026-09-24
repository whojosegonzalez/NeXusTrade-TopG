import type { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";
import type {
  FormulationBDiscoveryCandidate,
  FormulationBProviderClient,
} from "./FormulationBCollectionTypes.js";

export class FormulationBTokenDiscovery {
  private readonly seenMints = new Set<string>();

  constructor(
    private readonly provider: FormulationBProviderClient,
    private readonly safety: FormulationBSafetyMonitor,
  ) {}

  public isMintSeen(canonicalMint: string): boolean {
    return this.seenMints.has(canonicalMint);
  }

  public registerMint(canonicalMint: string): void {
    this.seenMints.add(canonicalMint);
  }

  public getDistinctMintCount(): number {
    return this.seenMints.size;
  }

  public async discoverNextCandidate(
    utcDate: string,
    slotId: string,
  ): Promise<FormulationBDiscoveryCandidate | null> {
    this.safety.trackProviderCall(utcDate);

    const response = await this.provider.discoverCandidates(10);
    this.safety.checkRateLimitResponse(response.status);
    this.safety.checkSecretLeakage(response.rawBody);
    this.safety.checkClockDrift(response.headers["date"], Date.now());

    for (const cand of response.data) {
      if (this.seenMints.has(cand.canonicalMint)) {
        continue;
      }
      if (cand.assetAgeSeconds < 300) {
        continue;
      }

      this.seenMints.add(cand.canonicalMint);
      return {
        canonicalMint: cand.canonicalMint,
        slotId,
        discoveredAt: cand.discoveredAt,
        assetAgeSeconds: cand.assetAgeSeconds,
      };
    }

    return null;
  }
}
