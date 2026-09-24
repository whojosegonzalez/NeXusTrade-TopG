import {
  QuoteNegativeCache,
  type QuoteNegativeCacheOptions,
} from "../quotes/QuoteNegativeCache.js";

/** A separately configured negative cache for Raydium's stable no-pool/no-route evidence. */
export class RaydiumNegativeCache extends QuoteNegativeCache {
  constructor(options: QuoteNegativeCacheOptions) {
    super(options);
  }
}
