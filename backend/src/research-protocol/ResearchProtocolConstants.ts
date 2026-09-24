export const INITIAL_EXPLORATORY_PROTOCOL_V1_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v1.json" as const;

export const INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256 =
  "748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152" as const;

export const EXPLORATORY_PROTOCOL_V2_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json" as const;

export const EXPLORATORY_PROTOCOL_V2_SHA256 =
  "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed" as const;

export const APPROVED_EXPLORATORY_PROTOCOL_PATHS = [
  INITIAL_EXPLORATORY_PROTOCOL_V1_PATH,
  EXPLORATORY_PROTOCOL_V2_PATH,
] as const;

export type ApprovedExploratoryProtocolPath = (typeof APPROVED_EXPLORATORY_PROTOCOL_PATHS)[number];

// Retained for historical V1 validation callers. New Phase 10.6A planning uses V2 explicitly.
export const INITIAL_EXPLORATORY_PROTOCOL_PATH = INITIAL_EXPLORATORY_PROTOCOL_V1_PATH;
export const INITIAL_EXPLORATORY_PROTOCOL_SHA256 = INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256;

export const PHASE10_4_BRIEF_FINGERPRINT =
  "5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7" as const;

export const PHASE10_5_REVIEW_GATE_FINGERPRINT =
  "2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b" as const;

export const PHASE9_29_CONCLUSION = "NO_DEFENSIBLE_HYPOTHESIS" as const;
