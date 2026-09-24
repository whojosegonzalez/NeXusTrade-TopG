import type { ProviderName, TokenIdentity } from "@nexustrade/shared";

import type { SystemLogRepository } from "../db/repositories/SystemLogRepository.js";
import { stringifyJson } from "../db/utils/json.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";

export interface DiscoveredTokenCandidate {
  readonly identity: TokenIdentity;
  readonly source: ProviderName;
  readonly discoveredAt: Date;
}

export interface ScannerDiscoveryMetrics {
  readonly rawCount: number;
  readonly providerCount: number;
  readonly successfulProviderCount: number;
  readonly failedProviderCount: number;
  readonly warnings: readonly string[];
}

export interface ScannerDiscoveryResult {
  readonly candidates: readonly DiscoveredTokenCandidate[];
  readonly metrics: ScannerDiscoveryMetrics;
}

export interface CandidateDeduplicationResult {
  readonly candidates: readonly DiscoveredTokenCandidate[];
  readonly rawCount: number;
  readonly uniqueCount: number;
  readonly duplicateCount: number;
}

export interface ScannerDiscoveryServiceOptions {
  readonly registry: ProviderRegistry;
  readonly systemLogs?: SystemLogRepository;
  readonly sessionId?: string;
}

export class ScannerDiscoveryService {
  constructor(private readonly options: ScannerDiscoveryServiceOptions) {}

  async discover(limit: number): Promise<ScannerDiscoveryResult> {
    const providers = this.options.registry.getTokenDiscoveryProviders();
    const warnings: string[] = [];
    const candidates: DiscoveredTokenCandidate[] = [];
    let successfulProviderCount = 0;
    let failedProviderCount = 0;

    for (const provider of providers) {
      const result = await provider.discoverTokens(limit);

      warnings.push(...result.warnings);

      if (!result.ok) {
        failedProviderCount += 1;
        warnings.push(`${provider.name}: ${result.error.code} - ${result.error.message}`);
        continue;
      }

      successfulProviderCount += 1;
      candidates.push(
        ...result.data.map((identity) => ({
          identity,
          source: provider.name,
          discoveredAt: result.fetchedAt,
        })),
      );
    }

    const limitedCandidates = candidates.slice(0, limit);
    const metrics: ScannerDiscoveryMetrics = {
      rawCount: candidates.length,
      providerCount: providers.length,
      successfulProviderCount,
      failedProviderCount,
      warnings,
    };

    this.writeLog("Scanner discovery completed.", {
      ...metrics,
    });

    return {
      candidates: limitedCandidates,
      metrics,
    };
  }

  private writeLog(message: string, context: unknown): void {
    const input = {
      level: "INFO" as const,
      scope: "SCANNER" as const,
      message,
      contextJson: stringifyJson(context),
    };

    this.options.systemLogs?.createLog(
      this.options.sessionId ? { ...input, sessionId: this.options.sessionId } : input,
    );
  }
}

export function dedupeCandidatesByMint(
  candidates: readonly DiscoveredTokenCandidate[],
): CandidateDeduplicationResult {
  const byMint = new Map<string, DiscoveredTokenCandidate>();

  for (const candidate of candidates) {
    if (!byMint.has(candidate.identity.mintAddress)) {
      byMint.set(candidate.identity.mintAddress, candidate);
    }
  }

  return {
    candidates: [...byMint.values()],
    rawCount: candidates.length,
    uniqueCount: byMint.size,
    duplicateCount: candidates.length - byMint.size,
  };
}
