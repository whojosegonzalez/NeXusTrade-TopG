/**
 * Phase 12.94-D Milestone D.3.3: Authentic Captured Solana Tracker Bundlers Response Fixture
 *
 * PROVENANCE & CAPTURE METADATA:
 * - Requested Token Mint: 4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
 * - Provider URL: https://data.solanatracker.io/tokens/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/bundlers
 * - Capture Timestamp: 2026-11-06T04:30:37.645Z
 * - Local Retrieved At: 1793939437824 (epoch ms)
 * - HTTP Status: 200 OK
 * - Execution Duration: 179 ms
 * - Original Wire SHA-256: 7e94db7211bf83c7b4d6710df83adce106fd59c3faf9aeac2c9b1b4958c73dd3
 * - Original Wire Size: 78,651 bytes
 *
 * LABELED SUBSETTING & TRANSFORMATIONS:
 * - Top-level metrics (`total`, `balance`, `percentage`, `initialBalance`, `initialPercentage`)
 *   are preserved EXACTLY from the original wire payload.
 * - The `wallets` array in this version-controlled fixture retains the first 5 authentic entries
 *   of the 500 received in the wire sample to preserve full schema validity while remaining portable
 *   and compact.
 * - Disclaimers: PROVIDER_REPORTED_UNVERIFIED. Capture does not establish provider accuracy,
 *   deployer attribution, Jito equivalence, or complete launch history.
 */

import type { SolanaTrackerBundlerParseRequestMetadata } from "../SolanaTrackerBundlerParser.js";

export const CAPTURED_SOLANA_TRACKER_METADATA: SolanaTrackerBundlerParseRequestMetadata & {
  readonly providerUrl: string;
  readonly httpStatus: number;
  readonly localRequestTimeIso: string;
  readonly localResponseTimeIso: string;
  readonly executionDurationMs: number;
  readonly receivedWireSha256: string;
} = Object.freeze({
  requestedMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  localRetrievedAtMs: 1793939437824,
  providerUrl:
    "https://data.solanatracker.io/tokens/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/bundlers",
  httpStatus: 200,
  localRequestTimeIso: "2026-11-06T04:30:37.645Z",
  localResponseTimeIso: "2026-11-06T04:30:37.824Z",
  executionDurationMs: 179,
  receivedWireSha256: "7e94db7211bf83c7b4d6710df83adce106fd59c3faf9aeac2c9b1b4958c73dd3",
});

/**
 * Authentic historical wire payload containing authentic top-level numbers and a 5-wallet authentic sample.
 */
export const CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD = Object.freeze({
  total: 1349,
  balance: 327694.4523689999,
  percentage: 0.05904,
  initialBalance: 41962.98172099917,
  initialPercentage: 0.00756,
  wallets: Object.freeze([
    Object.freeze({
      wallet: "MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa",
      initialBalance: 0,
      initialPercentage: 0,
      balance: 168626.525905,
      percentage: 0.03038,
      bundleTime: 1768067187513,
    }),
    Object.freeze({
      wallet: "4GQeEya6ZTwvXre4Br6ZfDyfe2WQMkcDz2QbkJZazVqS",
      initialBalance: 1138.4988289999508,
      initialPercentage: 0.0002,
      balance: 23390.624375,
      percentage: 0.00421,
      bundleTime: 1777998120379,
    }),
    Object.freeze({
      wallet: "FkaLnX17cXZGyeu3kZGdHCNdFMJJzBrPPYVvd18B3MZp",
      initialBalance: 2074.105016,
      initialPercentage: 0.0004,
      balance: 23349.036259,
      percentage: 0.00421,
      bundleTime: 1775737899705,
    }),
    Object.freeze({
      wallet: "GJvewfRjqTUPtx6WsBSUnaFbdgXwgXnWfpDyLm65T4YA",
      initialBalance: 0,
      initialPercentage: 0,
      balance: 22539.187334,
      percentage: 0.00406,
      bundleTime: 1768068378962,
    }),
    Object.freeze({
      wallet: "A9PzVmoBvTMLSh8VcaPQfYc3qwH63pmLuMxRmWraqGYk",
      initialBalance: 785.757459,
      initialPercentage: 0.0001,
      balance: 22061.487288,
      percentage: 0.00398,
      bundleTime: 1792365813338,
    }),
  ]),
});
