# Provider Architecture

Phase 3 adds the read-only live market-data layer for NeXusTrade. Provider code can fetch and normalize market data, but it must not load wallets, sign transactions, submit transactions, create orders, create fills, or create positions.

## Design Rules

- Vendor APIs sit behind internal adapter interfaces in `backend/src/providers/interfaces`.
- Business logic consumes normalized NeXusTrade types from `@nexustrade/shared`, not vendor response shapes.
- Every provider result includes provider attribution, a fetched-at timestamp, latency, warnings, and structured success or failure state.
- Normalized quote results should preserve quote provenance: provider identity, live/cache source
  type, and fallback reason when fallback is used.
- Adapters return `ProviderResult<T>` with structured `ProviderError` values instead of throwing raw vendor failures where possible.
- API keys, headers, wallet data, and secrets must never be logged.
- Raw payload logging is disabled by default with `ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING=false`.
- Provider smoke tests run in `PAPER` mode only and require no wallet access.

## Provider Matrix

| Provider      | Capabilities                                               | Credentials                                         | Status                                 |
| ------------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `DEXSCREENER` | `PRICE`, `LIQUIDITY`, `TOKEN_DISCOVERY`                    | No key required for current public HTTP endpoints   | Implemented                            |
| `JUPITER`     | `PRICE`, `QUOTE`, `TOKEN_METADATA` partial from price data | `JUPITER_API_KEY`                                   | Implemented, disabled until key exists |
| `HELIUS`      | `TOKEN_METADATA`, `RISK_EVIDENCE`, `PRIORITY_FEE`          | `HELIUS_API_KEY`                                    | Implemented, disabled until key exists |
| `RAYDIUM`     | `QUOTE`                                                    | No key required for first quote-only implementation | Implemented; validation pending        |
| `RUGCHECK`    | `RISK_EVIDENCE`                                            | TBD                                                 | Deferred                               |
| `MOCK`        | Test fixtures and mocked provider paths                    | None                                                | Shared contract only                   |

## Runtime Configuration

Provider config is loaded through `loadAppConfig()` and exposed at `config.providers`.

Important `.env` values:

- `PROVIDERS_ENABLED=DEXSCREENER,JUPITER,HELIUS,RAYDIUM`
- `PROVIDER_TIMEOUT_MS=10000`
- `PROVIDER_MAX_RETRIES=2`
- `PROVIDER_RETRY_BACKOFF_MS=250`
- `ENABLE_PROVIDER_RAW_PAYLOAD_LOGGING=false`
- `WRITE_PROVIDER_HEALTH=true`
- `DEXSCREENER_RATE_LIMIT_PER_MINUTE=300`
- `JUPITER_RATE_LIMIT_PER_MINUTE=60`
- `HELIUS_RATE_LIMIT_PER_MINUTE=60`
- `RAYDIUM_RATE_LIMIT_PER_MINUTE=60`
- `RAYDIUM_BASE_URL=https://transaction-v1.raydium.io`
- `RAYDIUM_TX_VERSION=V0`

Missing Jupiter or Helius keys disable those providers during normal runs. `pnpm providers:smoke --strict` treats missing requested key-backed providers as failures.

## Provider Notes

DexScreener public HTTP endpoints are currently used for token pairs and token profiles. The official reference lists `GET /token-pairs/v1/{chainId}/{tokenAddress}` and `GET /tokens/v1/{chainId}/{tokenAddresses}` at 300 requests per minute, with token-profile style endpoints at 60 requests per minute. The WebSocket API exists for real-time profiles, boosts, ads, and community takeovers, but Phase 3 keeps the first adapter HTTP-only.

Jupiter Price v3 and Swap quote endpoints currently document `x-api-key` authorization. The adapter therefore stays disabled until `JUPITER_API_KEY` is present. Quote support fetches quotes only; it does not build, sign, or execute transactions.

Raydium Phase 9.3 uses the public Trade API exact-input quote computation endpoint only:
`GET /compute/swap-base-in`. The adapter normalizes quote output behind `QuoteProvider`, does not
require an API key, and must not call Raydium transaction serialization endpoints. Phase 9.3 quote
results preserve whether the quote came from Jupiter or Raydium, whether it was live or cached, and
why fallback occurred.

Helius DAS `getAsset` and priority-fee JSON-RPC endpoints require `api-key` query authorization. The Helius risk evidence adapter only surfaces authority evidence such as mint/freeze authority presence. It is not the risk-engine pass/fail decision.

## Smoke Test

Run:

```bash
pnpm providers:smoke
pnpm providers:smoke --mint=So11111111111111111111111111111111111111112
pnpm providers:smoke --strict
```

Expected behavior:

- Mode must be `PAPER`.
- Wallet loaded: no.
- Transaction signing and submission: disabled.
- DexScreener runs without credentials.
- Jupiter and Helius run only when their keys are configured.
- ProviderHealth and SystemLog rows are written.

## Phase 4 Handoff

The scanner should call `TokenDiscoveryProvider` for candidate discovery and `MarketDataService.enrichToken()` for enrichment. Candidate storage in `TokenRadar` should remain a later scanner responsibility; Phase 3 deliberately does not persist enriched token candidates.

## Phase 9+ Provider Planning

Future provider bottleneck and fallback planning lives in
[Provider-Strategy-Phase9Plus.md](./Provider-Strategy-Phase9Plus.md).

Current direction:

- Phase 9 reports provider pressure but does not add new provider adapters by default.
- Phase 9.2 adds quote cache, rate-limit backoff, and fallback framework.
- Phase 9.25 selected Raydium as the first provider expansion target.
- Phase 9.3 implements Raydium as a quote-only direct fallback; validation is pending.
- Birdeye Standard is planned as selective enrichment only.
- Autobahn and Titan are access-gated aggregate quote fallback candidates.
- Meteora and Orca are later pool-specific quote adapter candidates.
