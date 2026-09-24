export type RaydiumVenueGuardDecision =
  | "ALLOW"
  | "DISABLED_ALLOW"
  | "SKIP_NO_RAYDIUM_VENUE"
  | "UNKNOWN_ALLOW";

export interface RaydiumVenueGuardOptions {
  readonly enabled: boolean;
  readonly skipWhenVenueAbsent: boolean;
  readonly requireVenueEvidence?: boolean;
}

export interface RaydiumVenueGuardInput {
  readonly observedDexIds?: readonly string[];
}

export interface RaydiumVenueGuardResult {
  readonly decision: RaydiumVenueGuardDecision;
  readonly reason: string;
  readonly observedVenues: readonly string[];
  readonly matchedVenue?: string;
}

export class RaydiumVenueGuard {
  constructor(private readonly options: RaydiumVenueGuardOptions) {}

  evaluate(input: RaydiumVenueGuardInput): RaydiumVenueGuardResult {
    const observedVenues = uniqueNormalized(input.observedDexIds);

    if (!this.options.enabled) {
      return { decision: "DISABLED_ALLOW", reason: "guard-disabled", observedVenues };
    }

    if (observedVenues.length === 0) {
      if (this.options.requireVenueEvidence) {
        return {
          decision: "SKIP_NO_RAYDIUM_VENUE",
          reason: "raydium-venue-evidence-required",
          observedVenues,
        };
      }
      return { decision: "UNKNOWN_ALLOW", reason: "no-venue-evidence", observedVenues };
    }

    const matchedVenue = observedVenues.find(isRaydiumVenue);

    if (matchedVenue) {
      return { decision: "ALLOW", reason: "raydium-venue-observed", observedVenues, matchedVenue };
    }

    if (this.options.skipWhenVenueAbsent) {
      return {
        decision: "SKIP_NO_RAYDIUM_VENUE",
        reason: "non-raydium-venues-observed",
        observedVenues,
      };
    }

    return { decision: "UNKNOWN_ALLOW", reason: "venue-suppression-disabled", observedVenues };
  }
}

function uniqueNormalized(values: readonly string[] | undefined): readonly string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
    ),
  ];
}

function isRaydiumVenue(value: string): boolean {
  return value.includes("raydium");
}
