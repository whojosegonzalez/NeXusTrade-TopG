import {
  EXPLORATORY_PROTOCOL_V2_PATH,
  EXPLORATORY_PROTOCOL_V2_SHA256,
} from "../research-protocol/ResearchProtocolConstants.js";

export const EXPLORATORY_COHORT_PROTOCOL_PATH = EXPLORATORY_PROTOCOL_V2_PATH;
export const EXPLORATORY_COHORT_PROTOCOL_SHA256 = EXPLORATORY_PROTOCOL_V2_SHA256;
export const EXPLORATORY_COHORT_PROTOCOL_VALIDATION_FINGERPRINT =
  "1fbe8a70792d872c7199d7182d095f13cce7c9908939526b44ecc7e2f872c283" as const;
export const EXPLORATORY_COHORT_ARCHIVE_PREFIX =
  "data/archive/phase10.6a/exploratory-cohort-v2-" as const;
export const EXPLORATORY_COHORT_LAUNCH_PREFIX =
  "docs/research-launches/phase10.6a-exploratory-cohort-v2-" as const;
export const EXPLORATORY_COHORT_SLOT_MS = 120 * 60 * 1000;
export const EXPLORATORY_COHORT_DISCOVERY_LEAD_MS = 60 * 1000;
export const EXPLORATORY_COHORT_LOCK_STALE_MS = 70 * 60 * 1000;
export const EXPLORATORY_COHORT_MAX_SLOTS = 168;
export const EXPLORATORY_COHORT_COMPLETION_VALID_UNITS = 96;
export const EXPLORATORY_COHORT_MINIMUM_VALID_UNITS = 72;
export const EXPLORATORY_COHORT_PROVIDER_CAPS = {
  DISCOVERY: 168,
  MARKET_CONTEXT: 168,
  QUOTE_IMPACT: 168,
  LATER_OBSERVATION: 672,
} as const;
export const EXPLORATORY_COHORT_LATER_HORIZONS = [
  { minutesAfterAnchor: 3, toleranceSeconds: 30 },
  { minutesAfterAnchor: 5, toleranceSeconds: 30 },
  { minutesAfterAnchor: 15, toleranceSeconds: 60 },
  { minutesAfterAnchor: 60, toleranceSeconds: 300 },
] as const;
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112" as const;
