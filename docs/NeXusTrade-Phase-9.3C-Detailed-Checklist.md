# NeXusTrade Phase 9.3C Detailed Checklist

Helius fallback / RPC authority evidence

Last updated: July 2026

## Status

Implemented; initial provider validation and post-fix follow-up validation reviewed.

Implementation now includes the `SOLANA_RPC`, `QUICKNODE_DAS`, and `ALCHEMY_DAS` provider
surfaces, raw Solana RPC mint-account authority parsing, optional DAS metadata fallback plumbing,
and provider-health/report diagnostics for authority evidence source, authority state, RPC cache,
RPC failure category, DAS provider, and DAS failure category.

Phase 9.3C replaces the most important Helius risk-evidence dependency with cheaper, more durable
authority evidence gathered from raw Solana RPC mint accounts. Optional DAS metadata providers can
supplement token metadata, but raw RPC authority parsing is the primary goal.

Phase 9.3C remains research-only and paper-safe.

## Validation Conclusion

Post-fix follow-up validation:

```text
Run label = phase9.3C-followup1-20260719-0047
Archive = data/archive/phase9.3C/followup1-phase9.3C-followup1-20260719-0047
Provider smoke exit code = 0
runtime = 119.4484 minutes
cycles = 162
radar = 41
risk = 1622
strategy = 1016
observedReturns = 200
providerHealth = 10000
orders/fills/positions = 0
```

Follow-up authority result:

```text
Risk by result = PASS:20 | WARN:996 | FAIL:606
Strategy by decision = WATCH:19 | SKIP:997 | BUY:0
missingAuthorityEvidenceCount = 0
strategyRows = 500
missingQuote = 410
missingAuthority = 0
missingImpact = 373

SOLANA_RPC:
  total = 4005
  liveRateLimited = 0%
  combinedRateLimited = 0%
  cacheHits = 3889
  authoritySources = SOLANA_RPC_JSON_PARSED:4005
  mintAuthority = DISABLED:4005
  freezeAuthority = DISABLED:4005
  rpcFailures = NONE:4005
```

Follow-up interpretation:

```text
The risk-rule fix worked. Explicit DISABLED mint/freeze authority evidence from Solana RPC now
passes through risk evaluation without being misclassified as missing authority.

Phase 9.3C therefore succeeds at replacing the exhausted Helius authority-evidence dependency for
long validation runs.
```

Remaining provider limitation:

```text
JUPITER combinedRateLimited = 61.76%
RAYDIUM error = 100%
RAYDIUM failures = RAYDIUM_UNAVAILABLE:745
RAYDIUM preflight = FAILED:745
```

Strategy conclusion:

```text
Do not enable paper BUY automation from this phase.
The best observed WATCH bucket was score 85-89, but sample size was only 10 decision-level rows
from one run and quote pressure remains material.
Next work should focus on quote availability/quality and candidate venue coverage, not loosening
paper BUY gates.
```

Initial validation archive:

Phase 9.3C validation ran three full TerminalRunner archives:

```text
Test1: cycles=110 scannerStored=1303 strategyWritten=102 safety=PASS oneSession=yes
Test2: cycles=72 scannerStored=1260 strategyWritten=446 safety=PASS oneSession=yes
Test3: cycles=108 scannerStored=1453 strategyWritten=315 safety=PASS oneSession=yes
```

Aggregate output:

```text
data/archive/phase9.3C/aggregate-20260718-0054
```

Provider outcome:

```text
validRuns = 3/3
observedDecisions = 278
uniqueMints = 15
orders/fills/positions = 0

SOLANA_RPC:
  total = 22032
  liveRateLimited = 0%
  combinedRateLimited = 0%
  cacheHits = 21618
  authoritySources = SOLANA_RPC_JSON_PARSED:22028
  mintAuthority = DISABLED:21740 | PRESENT:288
  freezeAuthority = DISABLED:21708 | PRESENT:320
  rpcFailures = NONE:22028 | SOLANA_RPC_NOT_FOUND:4

QUICKNODE_DAS:
  total = 2
  errors = BAD_REQUEST:2

JUPITER:
  combinedRateLimited = 50.3368%

RAYDIUM:
  error = 99.2218%
  raydiumFailures = NONE:8 | RAYDIUM_UNAVAILABLE:3060
  raydiumPreflight = FAILED:3068
```

Interpretation:

```text
The Solana RPC provider worked and removed Helius as a required authority-evidence source.
Provider health remained paper-safe and no execution rows were created.
However, the archived risk/strategy decisions still showed MISSING_AUTHORITY_EVIDENCE for every
observed decision.
```

Root cause:

```text
The risk authority rule still treated explicit DISABLED authority evidence as missing because it
only understood the earlier Helius absent/unknown shape.
```

Fix applied after validation:

```text
AuthorityRule now treats explicit mintAuthorityState=DISABLED / freezeAuthorityState=DISABLED,
MINT_AUTHORITY_DISABLED / FREEZE_AUTHORITY_DISABLED flags, or LOW authority risk as PASS evidence.
UNKNOWN authority remains WARN and still emits MISSING_AUTHORITY_EVIDENCE.
PRESENT authority remains FAIL.
```

Follow-up status:

```text
Completed on July 19, 2026. missingAuthority dropped to 0 in calibration and interpretation output.
```

## Why This Phase Exists

Phase 9.3B validation showed:

```text
Safety passed.
Helius free-plan credits were exhausted on July 16, 2026.
Helius-enabled validation produced 100% rate-limited behavior.
No-Helius validation reduced noise but left authority evidence broadly unavailable.
Raydium diagnostics worked, but candidate quote attempts remained 0% OK.
Jupiter remained usable but pressured at roughly 50% combined rate-limited behavior.
No paper BUY readiness was established.
```

The next highest-value move is not paper BUY and not broad provider expansion. It is replacing the
Helius-specific authority evidence path with a provider-neutral authority evidence path.

Target flow:

```text
TokenRadar candidate
-> raw Solana RPC getAccountInfo mint account
-> parse mint authority / freeze authority / decimals / supply / token program
-> produce TokenMetadataSnapshot + RiskEvidenceSnapshot
-> store existing RiskAssessment / TokenRadar evidence snapshots through current flows
-> report provider health and authority evidence source
```

## Reference Docs

Use these provider docs before implementation:

```text
Solana getAccountInfo:
https://solana.com/docs/rpc/http/getaccountinfo

QuickNode DAS:
https://www.quicknode.com/docs/solana/solana-das-api
https://www.quicknode.com/docs/solana/getAsset

Alchemy Solana DAS:
https://www.alchemy.com/docs/reference/alchemy-das-apis-for-solana
https://www.alchemy.com/docs/reference/alchemy-das-apis-for-solana/solana-das-api-endpoints/get-asset

Deferred token-info provider research:
Shyft, RugCheck, Moralis, and similar providers may be reconsidered after RPC + DAS validation.
```

Implementation interpretation:

```text
Solana RPC getAccountInfo = canonical mint authority evidence
QuickNode DAS getAsset = metadata/asset fallback, not required for authority pass
Alchemy DAS getAsset = metadata/asset fallback, not required for authority pass
Shyft = deferred provider research, not included in Phase 9.3C implementation
```

## Non-Goals

Phase 9.3C must not:

- enable paper BUY automation,
- call `paper:execute`,
- create orders, fills, or positions,
- load wallets,
- sign transactions,
- submit transactions,
- change strategy score weights,
- change strategy thresholds,
- promote a shadow-entry profile,
- add live trading behavior,
- add Birdeye market-data enrichment,
- add Titan, Autobahn, Meteora, or Orca adapters,
- treat DAS metadata as proof of executable liquidity,
- treat unknown authority evidence as PASS,
- persist raw provider payloads by default,
- log API keys, headers, wallet data, serialized transactions, or raw signed data.

## Success Criteria

Phase 9.3C is successful when:

```text
Raw Solana RPC authority provider exists and is enabled by config.
Mint authority can be classified as PRESENT, DISABLED, or UNKNOWN.
Freeze authority can be classified as PRESENT, DISABLED, or UNKNOWN.
Successful parsed mint accounts map into TokenMetadataSnapshot.
Successful parsed mint accounts map into RiskEvidenceSnapshot.
Explicit DISABLED authority can produce LOW authority risk.
PRESENT authority produces HIGH authority risk and clear flags.
UNKNOWN authority remains UNKNOWN/WARN, never PASS.
Token Program and Token-2022 Program are distinguished when possible.
ProviderHealth reports SOLANA_RPC authority evidence source, cache hits, live calls, and failures.
providers:smoke can verify RPC authority evidence without Helius.
TerminalRunner validation can run with Helius disabled.
orders/fills/positions remain 0.
paper BUY automation remains disabled.
wallet loaded = no.
transaction signing = disabled.
transaction submission = disabled.
```

Target validation goals:

```text
Helius no longer required for authority evidence in validation runs.
missingAuthority decreases materially versus Phase 9.3B no-Helius validation.
SOLANA_RPC live rate limiting is measurable and not dominant.
RiskAssessment WARN/FAIL behavior remains conservative.
No paper BUY readiness is claimed from authority fallback alone.
```

## Runtime Defaults

Recommended Phase 9.3C defaults:

```text
PROVIDERS_ENABLED=DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS

SOLANA_RPC_ENABLED=true
SOLANA_RPC_BASE_URL=
SOLANA_RPC_RATE_LIMIT_PER_MINUTE=300
SOLANA_RPC_TIMEOUT_MS=10000
SOLANA_RPC_MINT_ACCOUNT_CACHE_ENABLED=true
SOLANA_RPC_MINT_ACCOUNT_CACHE_TTL_MS=3600000
SOLANA_RPC_USE_JSON_PARSED=true
SOLANA_RPC_BASE64_FALLBACK_ENABLED=true

QUICKNODE_DAS_ENABLED=true
QUICKNODE_DAS_BASE_URL=
QUICKNODE_DAS_RATE_LIMIT_PER_MINUTE=60
QUICKNODE_DAS_METADATA_ENABLED=true
QUICKNODE_DAS_RISK_EVIDENCE_ENABLED=false

ALCHEMY_DAS_ENABLED=true
ALCHEMY_SOLANA_BASE_URL=
ALCHEMY_DAS_API_KEY=
ALCHEMY_DAS_RATE_LIMIT_PER_MINUTE=60
ALCHEMY_DAS_METADATA_ENABLED=true
ALCHEMY_DAS_RISK_EVIDENCE_ENABLED=false
```

Notes:

- `SOLANA_RPC_BASE_URL` can be a QuickNode, Alchemy, or other Solana RPC endpoint.
- QuickNode DAS can often use the QuickNode Solana endpoint when the DAS add-on is enabled.
- Alchemy DAS uses Alchemy's Solana endpoint and API key.
- Shyft is deferred provider research and should not be implemented in Phase 9.3C.
- If a configured optional provider lacks credentials, disable it cleanly and record the reason.

## Provider Names And Capabilities

Add provider names:

```text
SOLANA_RPC
QUICKNODE_DAS
ALCHEMY_DAS
```

Provider capabilities:

```text
SOLANA_RPC:
  TOKEN_METADATA
  RISK_EVIDENCE

QUICKNODE_DAS:
  TOKEN_METADATA

ALCHEMY_DAS:
  TOKEN_METADATA
```

Do not give DAS providers `RISK_EVIDENCE` in the first pass unless the implementation can
confidently map authority state. Authority truth should come from raw mint-account parsing.

## Authority Evidence Model

Add a small internal authority state model:

```text
AuthorityState = PRESENT | DISABLED | UNKNOWN

AuthorityEvidenceSource =
  SOLANA_RPC_JSON_PARSED
  SOLANA_RPC_BASE64_LAYOUT
  QUICKNODE_DAS
  ALCHEMY_DAS
  HELIUS
  UNAVAILABLE
```

Recommended normalized mint-account snapshot:

```text
ParsedMintAccountSnapshot:
  mintAddress
  tokenProgram
  decimals
  supply
  isInitialized
  mintAuthority
  mintAuthorityState
  freezeAuthority
  freezeAuthorityState
  source
  parser
  slot
  fetchedAt
  warnings
```

Risk mapping:

```text
mintAuthorityState=PRESENT:
  mintAuthorityRisk=HIGH
  flags include MINT_AUTHORITY_PRESENT

mintAuthorityState=DISABLED:
  mintAuthorityRisk=LOW
  flags include MINT_AUTHORITY_DISABLED

mintAuthorityState=UNKNOWN:
  mintAuthorityRisk=UNKNOWN
  flags include MINT_AUTHORITY_UNKNOWN

freezeAuthorityState=PRESENT:
  freezeAuthorityRisk=HIGH
  flags include FREEZE_AUTHORITY_PRESENT

freezeAuthorityState=DISABLED:
  freezeAuthorityRisk=LOW
  flags include FREEZE_AUTHORITY_DISABLED

freezeAuthorityState=UNKNOWN:
  freezeAuthorityRisk=UNKNOWN
  flags include FREEZE_AUTHORITY_UNKNOWN
```

Token-2022 caveat:

```text
Token-2022 mint base layout authority parsing is useful, but extensions may add additional risk.
If tokenProgram is Token-2022, add TOKEN_2022_EXTENSIONS_NOT_FULLY_EVALUATED unless extension
inspection is implemented in the same phase.
```

## Raw Solana RPC Adapter

Add:

```text
backend/src/providers/solana-rpc/SolanaRpcAdapter.ts
backend/src/providers/solana-rpc/SolanaRpcMintAccountCache.ts
backend/src/providers/solana-rpc/SolanaRpcMintAccountParser.ts
backend/src/providers/solana-rpc/solanaRpc.schemas.ts
backend/src/providers/solana-rpc/solanaRpc.mappers.ts
backend/src/providers/solana-rpc/*.test.ts
```

Adapter responsibilities:

```text
implements TokenMetadataProvider
implements RiskEvidenceProvider
calls JSON-RPC getAccountInfo for the mint address
uses encoding=jsonParsed when SOLANA_RPC_USE_JSON_PARSED=true
falls back to encoding=base64 when jsonParsed is unavailable or unparseable
uses in-memory cache by mint address
records ProviderHealth rows for live, cache, parse failure, unsupported owner, and not found
never requests transaction signing or wallet data
```

`getAccountInfo` request shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getAccountInfo",
  "params": [
    "<mintAddress>",
    {
      "commitment": "confirmed",
      "encoding": "jsonParsed"
    }
  ]
}
```

Fallback base64 request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getAccountInfo",
  "params": [
    "<mintAddress>",
    {
      "commitment": "confirmed",
      "encoding": "base64"
    }
  ]
}
```

Base mint layout parser:

```text
minimum bytes = 82
mintAuthorityOption: u32 little-endian at offset 0
mintAuthority: 32 bytes at offset 4
supply: u64 little-endian at offset 36
decimals: u8 at offset 44
isInitialized: u8/bool at offset 45
freezeAuthorityOption: u32 little-endian at offset 46
freezeAuthority: 32 bytes at offset 50
```

Implementation detail:

```text
If no base58 dependency is added, implement a small tested base58 encoder for 32-byte pubkeys.
Avoid adding @solana/web3.js unless implementation genuinely needs it.
```

Failure categories:

```text
SOLANA_RPC_NOT_CONFIGURED
SOLANA_RPC_RATE_LIMITED
SOLANA_RPC_UNAVAILABLE
SOLANA_RPC_NOT_FOUND
SOLANA_RPC_UNSUPPORTED_OWNER
SOLANA_RPC_PARSE_FAILED
SOLANA_RPC_INVALID_RESPONSE
SOLANA_RPC_TIMEOUT
```

ProviderHealth context:

```text
authorityEvidenceSource
authorityParser
mintAuthorityState
freezeAuthorityState
tokenProgram
rpcSlot
rpcCacheStatus = HIT | MISS | BYPASS
rpcFailureCategory
```

## DAS Metadata Fallbacks

Add a generic DAS adapter if practical:

```text
backend/src/providers/das/DasAssetAdapter.ts
backend/src/providers/das/das.schemas.ts
backend/src/providers/das/das.mappers.ts
backend/src/providers/das/*.test.ts
```

Then configure provider names:

```text
QUICKNODE_DAS -> DasAssetAdapter(provider="QUICKNODE_DAS")
ALCHEMY_DAS -> DasAssetAdapter(provider="ALCHEMY_DAS")
```

Request method:

```text
JSON-RPC method = getAsset
params.id = mintAddress
options/showFungible = true
```

Use DAS for:

```text
token name
symbol
decimals if available
image URI
metadata URI
token standard / compression flags if available
```

Do not use DAS for:

```text
executable quote evidence
liquidity evidence
authority PASS unless authority state is explicit and mapped with tests
paper BUY decisions
```

Failure categories:

```text
DAS_NOT_CONFIGURED
DAS_RATE_LIMITED
DAS_UNAVAILABLE
DAS_NOT_FOUND
DAS_INVALID_RESPONSE
DAS_UNSUPPORTED_ASSET
DAS_TIMEOUT
```

ProviderHealth context:

```text
dasProvider
dasMethod=getAsset
dasShowFungible=true
dasCacheStatus = HIT | MISS | BYPASS
dasFailureCategory
```

## Provider Ordering

Token metadata provider order:

```text
SOLANA_RPC
QUICKNODE_DAS
ALCHEMY_DAS
HELIUS
JUPITER optional metadata fallback
```

Risk evidence provider order:

```text
SOLANA_RPC
HELIUS if explicitly enabled and not exhausted
RUGCHECK later if implemented
```

Recommended validation provider set while Helius credits are exhausted:

```powershell
$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS"
```

Do not make Helius part of the default validation set again until credits reset or the plan changes.

## Config And Environment Work

Update:

```text
backend/src/providers/config/providerConfig.ts
backend/src/config/env.test.ts
```

Add API key/base URL config:

```text
SOLANA_RPC_BASE_URL
QUICKNODE_DAS_BASE_URL
ALCHEMY_SOLANA_BASE_URL
ALCHEMY_DAS_API_KEY
```

Add runtime config:

```text
SOLANA_RPC_RATE_LIMIT_PER_MINUTE
SOLANA_RPC_MINT_ACCOUNT_CACHE_ENABLED
SOLANA_RPC_MINT_ACCOUNT_CACHE_TTL_MS
SOLANA_RPC_USE_JSON_PARSED
SOLANA_RPC_BASE64_FALLBACK_ENABLED

QUICKNODE_DAS_RATE_LIMIT_PER_MINUTE
QUICKNODE_DAS_METADATA_ENABLED

ALCHEMY_DAS_RATE_LIMIT_PER_MINUTE
ALCHEMY_DAS_METADATA_ENABLED
```

Credential handling:

```text
Do not add real keys to docs.
Do not log keys.
Do not print full provider URLs if they embed secrets.
Use sanitized provider labels in logs.
```

## Registry Work

Update:

```text
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderRegistry.test.ts
```

Tasks:

- Register `SolanaRpcAdapter` when `SOLANA_RPC` is enabled and `SOLANA_RPC_BASE_URL` is set.
- Register `QuickNodeDasAdapter` when `QUICKNODE_DAS` is enabled and base URL is set.
- Register `AlchemyDasAdapter` when `ALCHEMY_DAS` is enabled and endpoint/key is set.
- Keep Helius optional and disabled when credentials are absent or `PROVIDERS_ENABLED` excludes it.
- Preserve quote provider order from Phase 9.3B.
- Preserve DexScreener discovery/liquidity behavior.
- Sort token metadata providers so cheap/canonical authority evidence wins.
- Sort risk evidence providers so raw RPC authority evidence runs before Helius.

## Shared Type Work

Update if low-blast-radius:

```text
shared/src/providers/provider.types.ts
shared/src/market/risk-evidence.types.ts
shared/src/market/metadata.types.ts
shared/src/index.ts
```

Recommended changes:

```text
Add provider names:
  SOLANA_RPC
  QUICKNODE_DAS
  ALCHEMY_DAS

Add optional RiskEvidenceSnapshot fields:
  mintAuthorityState
  freezeAuthorityState
  authorityEvidenceSource
  tokenProgram

Keep existing mintAuthorityRisk/freezeAuthorityRisk fields.
```

If optional typed fields cause broad churn, keep the new details in `rawEvidence` for Phase 9.3C
and add typed fields later.

## Risk Engine Integration

Risk engine behavior must remain conservative:

```text
PRESENT authority -> risk FAIL or WARN according to current deterministic rules
DISABLED authority -> eligible for authority PASS/LOW evidence
UNKNOWN authority -> WARN, never PASS
provider unavailable -> UNKNOWN/WARN
Token-2022 extensions not evaluated -> WARN note
```

Update:

```text
backend/src/risk/RiskEvaluationService.ts if needed
backend/src/risk/rules/* if authority-rule input assumptions need adjustment
backend/src/risk/*.test.ts
```

Acceptance rule:

```text
Phase 9.3C may reduce missingAuthority, but it must not loosen risk rules just to increase BUY count.
```

## Reporting Work

Update reports to show authority fallback evidence:

```text
backend/src/providers/ProviderPressureClassifier.ts
backend/src/terminal-runner/TerminalRunSummary.ts
backend/src/analytics/AnalyticsReportService.ts
backend/src/analytics/AnalyticsReportFormatter.ts
backend/src/calibration/ProviderImpactAnalyzer.ts
backend/src/calibration/CalibrationReportFormatter.ts
backend/src/research/CrossRunResearchService.ts
backend/src/research/ResearchAggregateReportFormatter.ts
backend/src/research-interpretation/ProviderInterpretationService.ts
backend/src/research-interpretation/ResearchInterpretationReportFormatter.ts
```

Add compact counts where available:

```text
authoritySources=SOLANA_RPC_JSON_PARSED=10, SOLANA_RPC_BASE64_LAYOUT=4, UNAVAILABLE=2
mintAuthority=PRESENT=3, DISABLED=9, UNKNOWN=4
freezeAuthority=PRESENT=1, DISABLED=11, UNKNOWN=4
rpcCache=HIT=20, MISS=15
rpcFailures=SOLANA_RPC_PARSE_FAILED=2, SOLANA_RPC_RATE_LIMITED=1
dasProviders=QUICKNODE_DAS=8, ALCHEMY_DAS=2
dasFailures=DAS_RATE_LIMITED=1
```

Research interpretation should be able to distinguish:

```text
missingAuthority because no authority provider was configured
missingAuthority because RPC failed
missingAuthority because mint account was unparseable
authority present and risky
authority explicitly disabled
```

## Provider Smoke Work

Update:

```text
backend/src/scripts/providers-smoke.ts
```

Smoke checks:

```text
SOLANA_RPC authority check:
  use a known mint such as wrapped SOL or USDC
  expect parsed mint account or clear skipped/not-configured status

QUICKNODE_DAS getAsset:
  run only when configured
  expect metadata ok/skipped

ALCHEMY_DAS getAsset:
  run only when configured
  expect metadata ok/skipped

HELIUS:
  keep tolerant skipped behavior when rate-limited/exhausted unless --strict
```

Smoke output must include:

```text
Provider diagnostics: authoritySources=..., rpcFailures=..., dasFailures=...
```

## Test Plan

Unit tests:

```text
shared/src/providers/provider-results.test.ts or provider.types test:
  parses new provider names

backend/src/providers/solana-rpc/SolanaRpcMintAccountParser.test.ts:
  parses jsonParsed mint account with present authorities
  parses jsonParsed mint account with disabled authorities
  parses base64 SPL Token mint layout
  parses base64 Token-2022 base mint layout with extension warning
  rejects too-short account data
  rejects unsupported owner
  preserves UNKNOWN when parser cannot distinguish disabled from missing

backend/src/providers/solana-rpc/SolanaRpcAdapter.test.ts:
  returns TokenMetadataSnapshot from RPC mint account
  returns RiskEvidenceSnapshot from RPC mint account
  cache hit avoids duplicate HTTP call
  rate-limited failure records ProviderHealth context
  not-found account maps to provider failure

backend/src/providers/das/*.test.ts:
  maps getAsset token metadata
  handles missing fungible info
  handles rate limit
  handles invalid response

backend/src/providers/ProviderRegistry.test.ts:
  registers SOLANA_RPC when configured
  disables SOLANA_RPC when base URL missing
  orders SOLANA_RPC before Helius for risk evidence
  orders SOLANA_RPC / DAS before Jupiter metadata fallback

backend/src/providers/ProviderPressureClassifier.test.ts:
  counts authority source, authority states, rpc cache, rpc failures, DAS failures

backend/src/scripts/providers-smoke tests if current pattern supports it:
  no secret leakage
  Helius skipped does not fail non-strict smoke
```

Integration / verification:

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm check:secrets
corepack pnpm providers:smoke
```

## Validation Runbook After Implementation

Short smoke:

```powershell
cd U:\Projects\NeXusTrade-Otis

$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS"

corepack pnpm verify
corepack pnpm providers:smoke
```

Short TerminalRunner validation:

```powershell
cd U:\Projects\NeXusTrade-Otis

$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS"

corepack pnpm db:reset:paper

$run = "phase9.3C-smoke-$(Get-Date -Format 'yyyyMMdd-HHmm')"

Start-Transcript -Path "data\$run-transcript.txt"

corepack pnpm terminal:run `
  --max-runtime-minutes=20 `
  --interval-ms=60000 `
  --output-dir="data\$run"

Write-Host ""
Write-Host "Waiting 30 minutes so short-window returns can mature..."
Start-Sleep -Seconds 1800

corepack pnpm watchlist:returns --once
corepack pnpm analytics:report --once | Tee-Object "data\$run-analytics-tail30.txt"
corepack pnpm calibration:report --once --max-hold-minutes=60 | Tee-Object "data\$run-calibration-tail30.txt"
corepack pnpm shadow:calibrate --once | Tee-Object "data\$run-shadow-calibrate-tail30.txt"

Stop-Transcript

$archive = "data\archive\phase9.3C\smoke-$run"

New-Item -ItemType Directory -Force -Path $archive
Copy-Item "data\$run" $archive -Recurse -Force
Copy-Item "data\$run*.txt" $archive -Force
Copy-Item data\nexus_paper.db* $archive -Force

Write-Host "Archive Folder: $archive"
```

Full validation:

```text
Run 2 full 120-minute validation windows first.
Use Helius disabled unless credits reset or provider plan changes.
Run a third full validation only if the first two disagree materially.
```

Full validation command shape:

```powershell
cd U:\Projects\NeXusTrade-Otis

$env:PROVIDERS_ENABLED = "DEXSCREENER,JUPITER,RAYDIUM,SOLANA_RPC,QUICKNODE_DAS,ALCHEMY_DAS"

corepack pnpm db:reset:paper

$run = "phase9.3C-test1-$(Get-Date -Format 'yyyyMMdd-HHmm')"

Start-Transcript -Path "data\$run-transcript.txt"

corepack pnpm terminal:run `
  --max-runtime-minutes=120 `
  --interval-ms=60000 `
  --output-dir="data\$run"

Write-Host ""
Write-Host "Waiting 60 minutes so watchlist returns can mature..."
Start-Sleep -Seconds 3600

corepack pnpm watchlist:returns --once
corepack pnpm analytics:report --once | Tee-Object "data\$run-analytics-tail60.txt"
corepack pnpm calibration:report --once --max-hold-minutes=120 | Tee-Object "data\$run-calibration-tail60.txt"
corepack pnpm shadow:calibrate --once | Tee-Object "data\$run-shadow-calibrate-tail60.txt"

Stop-Transcript

$archive = "data\archive\phase9.3C\test1-$run"

New-Item -ItemType Directory -Force -Path $archive
Copy-Item "data\$run" $archive -Recurse -Force
Copy-Item "data\$run*.txt" $archive -Force
Copy-Item data\nexus_paper.db* $archive -Force

Write-Host "Archive Folder: $archive"
```

## Acceptance Criteria

Phase 9.3C is accepted when:

```text
corepack pnpm verify passes.
providers:smoke passes without Helius.
At least one short TerminalRunner smoke completes with safety PASS.
At least two full validation runs complete with safety PASS.
orders/fills/positions remain 0.
missingAuthority is materially lower than Phase 9.3B no-Helius baseline.
authority evidence source and authority state counts are visible in reports.
SOLANA_RPC provider pressure is measurable and not hidden under generic UNKNOWN.
QuickNode/Alchemy DAS are optional metadata fallbacks, not mandatory for authority evidence.
Phase 9.3C conclusion is documented before moving to Phase 9.3D or Phase 9.4.
```

## Expected Outcomes

Best case:

```text
Raw RPC authority evidence works for most candidates.
missingAuthority drops sharply.
Risk decisions become more explainable without Helius.
Helius can stay disabled until credits reset or the project can fund an upgrade.
```

Acceptable case:

```text
Raw RPC works for SPL Token mints but Token-2022 extensions remain partially unknown.
DAS providers improve metadata but not authority evidence.
Risk remains conservative.
```

Failure case:

```text
RPC endpoint is rate-limited or unavailable.
Mint account parsing is unreliable.
Authority evidence remains mostly UNKNOWN.
```

If failure case occurs, consider:

```text
QuickNode RPC rate-limit adjustment
Alchemy RPC fallback
RugCheck selective security fallback
Birdeye selective enrichment only after authority evidence is stable
```
