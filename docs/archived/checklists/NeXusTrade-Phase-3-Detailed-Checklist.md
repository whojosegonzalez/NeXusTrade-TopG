# NeXusTrade Phase 3 Detailed Checklist

Phase 3 builds the read-only provider layer for live market data. It adds normalized provider contracts, vendor adapters, provider health logging, and a safe smoke-test path. It does not build scanner persistence, risk scoring, strategy decisions, paper execution, wallet loading, signing, or live trading.

## Definition of Done

- [x] Shared provider names, capabilities, provider errors, and `ProviderResult<T>` contracts exist.
- [x] Shared market-data contracts exist for tokens, prices, quotes, liquidity pairs, metadata, risk evidence, priority fees, and enrichment snapshots.
- [x] Provider runtime config is parsed from environment variables.
- [x] Provider base URLs, timeout, retry count, retry backoff, rate limits, raw payload logging, and provider health settings are configurable.
- [x] Provider API keys are loaded from local `.env` without committing secrets.
- [x] Provider HTTP client supports timeout, retry, rate limiting, and normalized provider errors.
- [x] Provider adapter interfaces exist for price, quote, metadata, liquidity, token discovery, risk evidence, and priority fee capabilities.
- [x] DexScreener adapter supports Solana pair lookup, best-pair selection, price-from-pair, and token-profile discovery.
- [x] Jupiter adapter supports Price v3, quote fetches, and partial metadata from price responses.
- [x] Helius adapter supports DAS metadata, authority risk evidence, and priority-fee estimates.
- [x] RugCheck remains explicitly deferred.
- [x] `ProviderRegistry` builds configured adapters and exposes providers by capability.
- [x] Missing key-backed providers are skipped during normal runs instead of crashing the app.
- [x] `ProviderHealthService` writes provider status and provider system logs through Phase 2 repositories.
- [x] `MarketDataService.enrichToken()` combines available provider outputs into a normalized `TokenEnrichmentSnapshot`.
- [x] Provider smoke script runs in `PAPER` mode only.
- [x] Provider smoke script prints wallet/signing/submission disabled safety status.
- [x] Provider smoke script writes ProviderHealth and SystemLog records.
- [x] Tests cover provider config, HTTP client behavior, rate limiting, provider health service, vendor mappers, shared provider results, shared market types, and market-data enrichment.
- [x] Provider architecture is documented.
- [x] `docs/Structure.md`, `docs/ROADMAP.md`, and `docs/DECISIONS.md` are updated for Phase 3.
- [x] Phase 4 planning inputs document the provider handoff.

## Verification Notes

- 2026-06-21: `pnpm verify` passed after Phase 3 provider implementation.
- 2026-06-21: `pnpm providers:smoke` passed in `PAPER` mode.
- 2026-06-21: `pnpm providers:smoke --strict` passed with local DexScreener/Jupiter/Helius configuration.
- 2026-06-21: Provider smoke confirmed wallet loading, transaction signing, and transaction submission were disabled.
- 2026-06-21: Provider smoke confirmed ProviderHealth and SystemLog writes.

Representative strict smoke output:

```text
MODE: PAPER
Providers requested: DEXSCREENER, JUPITER, HELIUS
Providers enabled: DEXSCREENER, JUPITER, HELIUS
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled

DEXSCREENER pairs: ok
JUPITER price: ok
JUPITER quote: ok
HELIUS metadata: ok
MarketDataService enrichment: ok
ProviderHealth writes: ok
SystemLog writes: ok

Result: provider smoke check passed
```

## Verification Commands

```bash
pnpm verify
pnpm providers:smoke
pnpm providers:smoke --mint=So11111111111111111111111111111111111111112
pnpm providers:smoke --strict
```

## Phase Notes

- DexScreener runs without a key for the selected public HTTP endpoints.
- DexScreener token-profile discovery is implemented, but recent-pair discovery and WebSockets are deferred.
- DexScreener best-pair selection is deterministic: higher liquidity, higher 24h volume, newer pair creation time, then pair address.
- Jupiter requires `JUPITER_API_KEY`; without it, the adapter is skipped in normal mode.
- Jupiter quote support only fetches quote data. It does not build, sign, submit, or execute swaps.
- Helius requires `HELIUS_API_KEY`; without it, the adapter is skipped in normal mode.
- Helius authority evidence currently records mint/freeze authority signals. It is not a risk-engine decision.
- RugCheck remains deferred until the API contract and product need are clearer.
- Raw provider payload logging remains disabled by default with `ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING=false`.
- Provider evidence and logs must not store API keys, headers, wallet data, or credentials.
- Missing key-backed providers are normal in local development. Strict smoke mode treats missing requested providers as failures.
- Phase 3 deliberately does not persist token candidates into `TokenRadar`; that responsibility belongs to Phase 4.

## Out of Scope

- Scanner loop and TokenRadar candidate persistence.
- Candidate deduplication.
- Candidate ranking.
- Risk scoring and pass/fail decisions.
- Strategy decisions.
- Paper buy/sell simulation.
- P/L target enforcement.
- Dashboard UI.
- Wallet loading.
- Swap transaction construction.
- Transaction signing.
- Transaction submission.
- Live trading.
