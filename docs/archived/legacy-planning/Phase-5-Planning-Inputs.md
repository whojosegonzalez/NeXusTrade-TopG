# Phase 5 Planning Inputs

Phase 5 goal: build the first deterministic risk engine around existing Phase 4 `TokenRadar` candidates and provider enrichment. The intended flow is:

```text
TokenRadar candidate
collect or refresh evidence
evaluate deterministic risk rules
produce structured risk facts
store RiskAssessment
update TokenRadar status only when appropriate
```

This file gathers the current Phase 4 implementation state needed to write the Phase 5 checklist.

## 1. Current File Tree After Phase 4

Omitted from this tree: `.git/`, `node_modules/`, local `.env`, local SQLite database files, and Husky internal shim files.

```text
NeXusTrade-Otis/
├─ .editorconfig
├─ .env.example
├─ .gitignore
├─ .node-version
├─ .npmrc
├─ .nvmrc
├─ .prettierignore
├─ .prettierrc
├─ eslint.config.js
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ README.md
├─ tsconfig.base.json
├─ .husky/
│  └─ pre-commit
├─ backend/
│  ├─ drizzle.config.ts
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ drizzle/
│  │  ├─ 0000_tense_aqueduct.sql
│  │  └─ meta/
│  │     ├─ 0000_snapshot.json
│  │     └─ _journal.json
│  └─ src/
│     ├─ index.ts
│     ├─ config/
│     ├─ db/
│     │  ├─ repositories/
│     │  ├─ schema/
│     │  ├─ seeds/
│     │  ├─ testing/
│     │  └─ utils/
│     ├─ health/
│     ├─ logging/
│     ├─ providers/
│     │  ├─ config/
│     │  ├─ dexscreener/
│     │  ├─ helius/
│     │  ├─ http/
│     │  ├─ interfaces/
│     │  └─ jupiter/
│     ├─ scanner/
│     │  ├─ CandidateEnrichmentService.test.ts
│     │  ├─ CandidateEnrichmentService.ts
│     │  ├─ ScannerConfig.test.ts
│     │  ├─ ScannerConfig.ts
│     │  ├─ ScannerDiscoveryService.test.ts
│     │  ├─ ScannerDiscoveryService.ts
│     │  ├─ ScannerRunner.test.ts
│     │  ├─ ScannerRunner.ts
│     │  ├─ TokenRadarPersistenceService.test.ts
│     │  ├─ TokenRadarPersistenceService.ts
│     │  └─ mappers/
│     │     ├─ RadarCandidateMapper.test.ts
│     │     └─ RadarCandidateMapper.ts
│     └─ scripts/
│        ├─ providers-smoke.ts
│        └─ scanner-discover.ts
├─ data/
│  └─ .gitkeep
├─ docs/
│  ├─ DECISIONS.md
│  ├─ NeXusTrade-Phase-1-Detailed-Checklist.md
│  ├─ NeXusTrade-Phase-2-Detailed-Checklist.md
│  ├─ Phase-4-Planning-Inputs.md
│  ├─ Provider-Architecture.md
│  ├─ ROADMAP.md
│  ├─ Structure.md
│  ├─ architecture/
│  │  ├─ database.md
│  │  └─ scanner.md
│  └─ phase-notes/
│     └─ phase-2-database-layer.md
├─ frontend/
│  └─ README.md
├─ scripts/
│  └─ check-secrets.mjs
└─ shared/
   ├─ package.json
   ├─ tsconfig.json
   └─ src/
      ├─ config.ts
      ├─ index.ts
      ├─ modes.test.ts
      ├─ modes.ts
      ├─ market/
      └─ providers/
```

## 2. Scanner Architecture Doc

File: `docs/architecture/scanner.md`

Current Phase 4 rules:

- Scanner-only mode is paper-only.
- Default command is `pnpm scanner:discover`.
- `--once` runs one discovery cycle and exits.
- `--dry-run` still allows provider calls, session/log writes, and provider health writes, but skips `TokenRadar` writes.
- Runtime defaults are `intervalMs=60000`, `limit=25`, and `concurrency=3`.
- Auto-created sessions are `PAPER`, `RUNNING`, zero-balance sessions.
- Existing session reuse is limited to `PAPER` sessions in `CREATED` or `RUNNING`.
- Pipeline is discovery, dedupe, enrichment, normalization, upsert, log.
- Current discovery source is DexScreener token profiles only.
- Scanner tests assert no risk assessments, strategy decisions, orders, fills, or positions.

Phase 5 should preserve this boundary. The risk engine can read scanner outputs, but scanner-only mode should remain independent of risk decisions unless a later orchestration phase explicitly composes them.

## 3. ScannerRunner.ts

File: `backend/src/scanner/ScannerRunner.ts`

Important public surface:

```ts
export interface ScannerCycleResult {
  readonly sessionId: string;
  readonly discoveredCount: number;
  readonly uniqueCount: number;
  readonly duplicateCount: number;
  readonly enrichedCount: number;
  readonly storedCount: number;
  readonly errorCount: number;
  readonly dryRun: boolean;
}

export class ScannerRunner {
  stop(): void;
  run(): Promise<ScannerCycleResult | undefined>;
  runOnce(): Promise<ScannerCycleResult>;
  runContinuously(): Promise<ScannerCycleResult | undefined>;
  runCycle(sessionId: string): Promise<ScannerCycleResult>;
  resolveSession(): SessionRecord;
}
```

Session policy:

- No `sessionId`: create `PAPER` session with `RUNNING`, zero balances, and scanner config in `configSnapshotJson`.
- Existing `CREATED`: mark `RUNNING`.
- Existing `RUNNING`: reuse.
- Existing `PAUSED`: reject for now.
- Existing `COMPLETED`, `FAILED`, `CANCELLED`: reject.

Risk-engine note: Phase 5 should not be inserted inside `ScannerRunner.runCycle()` yet. It is cleaner to create a standalone risk service and command, then let a later orchestration phase decide whether scanner cycles should trigger risk evaluation.

## 4. RadarCandidateMapper.ts

File: `backend/src/scanner/mappers/RadarCandidateMapper.ts`

Current mapping behavior:

- Failed enrichment becomes a `TokenRadar` input with `status="ERROR"`.
- Successful enrichment becomes a `TokenRadar` input with `status="DISCOVERED"`.
- `source` is the discovery provider.
- `pairAddress` is `bestPair.pairAddress` when available.
- `firstSeenAtMs` is `bestPair.pairCreatedAt` when available, otherwise discovery time.
- `discoveredAtMs` is the current scanner cycle timestamp.
- `ageSeconds` is derived from `pairCreatedAt` when available.
- `priceUsd`, `priceSol`, `liquidityUsd`, `volume5mUsd`, and `volume1hUsd` are stored as strings.
- `rawDataJson` contains a compact `PHASE_4_SCANNER_ONLY` discovery/enrichment summary.

Risk-engine note: Phase 5 can read `TokenRadar` columns for fast filtering, but should refresh or collect evidence through `MarketDataService` before writing `RiskAssessment`, because scanner rows can get stale.

## 5. TokenRadarRepository.ts

File: `backend/src/db/repositories/TokenRadarRepository.ts`

Public methods:

```ts
createRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord;
upsertRadarEntry(input: CreateRadarEntryInput): TokenRadarRecord;
getRadarEntryById(id: string): TokenRadarRecord | undefined;
findRadarEntryByMint(sessionId: string, mintAddress: string): TokenRadarRecord | undefined;
listRadarEntries(sessionId: string, filter?: RadarEntryListFilter): TokenRadarRecord[];
updateRadarStatus(id: string, status: TokenRadarStatus, notes?: string): TokenRadarRecord;
```

List filter:

```ts
interface RadarEntryListFilter {
  readonly status?: TokenRadarStatus;
  readonly mintAddress?: string;
  readonly limit?: number;
}
```

Current statuses:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `APPROVED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

Risk-engine note: `listRadarEntries()` currently supports one status at a time. Phase 5 may need either repeated calls for `DISCOVERED` and `WATCHING`, or a repository enhancement for status arrays and recency filters.

## 6. RiskAssessmentRepository.ts

File: `backend/src/db/repositories/RiskAssessmentRepository.ts`

Public methods:

```ts
createRiskAssessment(input: CreateRiskAssessmentInput): RiskAssessmentRecord;
getRiskAssessmentById(id: string): RiskAssessmentRecord | undefined;
getLatestRiskAssessment(sessionId: string, mintAddress: string): RiskAssessmentRecord | undefined;
listRiskAssessments(sessionId: string, filter?: RiskAssessmentListFilter): RiskAssessmentRecord[];
```

List filter:

```ts
interface RiskAssessmentListFilter {
  readonly result?: RiskResult;
  readonly mintAddress?: string;
  readonly limit?: number;
}
```

Persisted table fields:

- `id`
- `sessionId`
- `tokenRadarId`
- `mintAddress`
- `checkedAtMs`
- `score`
- `result`: `PASS`, `FAIL`, `WARN`, or `UNKNOWN`
- `passed`
- `mintAuthorityDisabled`
- `freezeAuthorityDisabled`
- `tokenProgram`
- `topHoldersPercent`
- `liquidityUsd`
- `riskFlagsJson`
- `rawProviderDataJson`
- `createdAtMs`

Risk-engine note: The schema already fits a deterministic first pass. Holder concentration can remain null until a provider supplies it.

## 7. Current RiskEvidenceSnapshot Type

File: `shared/src/market/risk-evidence.types.ts`

```ts
export type RiskEvidenceLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface RiskEvidenceSnapshot {
  readonly mintAddress: TokenMintAddress;
  readonly source: ProviderName;
  readonly score?: number;
  readonly flags: readonly string[];
  readonly mintAuthorityRisk?: RiskEvidenceLevel;
  readonly freezeAuthorityRisk?: RiskEvidenceLevel;
  readonly liquidityRisk?: RiskEvidenceLevel;
  readonly holderConcentrationRisk?: RiskEvidenceLevel;
  readonly sellabilityRisk?: RiskEvidenceLevel;
  readonly rawEvidence?: unknown;
  readonly fetchedAt: Date;
}
```

Phase 5 can use `flags`, `mintAuthorityRisk`, `freezeAuthorityRisk`, and optional future fields. Today, Helius is the only implemented risk-evidence provider.

## 8. Current TokenEnrichmentSnapshot Type

File: `shared/src/market/enrichment.types.ts`

```ts
export interface TokenEnrichmentSnapshot {
  readonly identity: TokenIdentity;
  readonly price?: TokenPriceSnapshot;
  readonly bestPair?: DexPairSnapshot;
  readonly metadata?: TokenMetadataSnapshot;
  readonly riskEvidence?: RiskEvidenceSnapshot;
  readonly buyQuote?: QuoteResult;
  readonly sellQuote?: QuoteResult;
  readonly sourcesUsed: readonly ProviderName[];
  readonly warnings: readonly string[];
  readonly fetchedAt: Date;
}
```

Important note: `buyQuote` and `sellQuote` are only present when the caller supplies quote requests to `MarketDataService.enrichToken()`. Phase 4 scanner calls enrichment with only `mintAddress`, so Phase 4 rows normally do not contain quote or price-impact evidence.

## 9. Helius Metadata And Authority Evidence Fields

Files:

- `backend/src/providers/helius/helius.schemas.ts`
- `backend/src/providers/helius/helius.mappers.ts`

Current Helius metadata fields mapped:

- `mintAddress`
- `symbol`
- `name`
- `description`
- `decimals`
- `supply`
- `tokenProgram`
- `mintAuthority`
- `freezeAuthority`
- `updateAuthority`
- `metadataUri`
- `imageUri`
- `source="HELIUS"`
- `fetchedAt`

Current Helius authority/risk evidence mapped:

- `flags`
- `mintAuthorityRisk`
- `freezeAuthorityRisk`
- `source="HELIUS"`
- `fetchedAt`

Current flag behavior:

- Mint authority present: `mint_authority_present`, `mintAuthorityRisk="HIGH"`
- Mint authority missing or unknown: `mint_authority_absent_or_unknown`, `mintAuthorityRisk="UNKNOWN"`
- Freeze authority present: `freeze_authority_present`, `freezeAuthorityRisk="HIGH"`
- Freeze authority missing or unknown: `freeze_authority_absent_or_unknown`, `freezeAuthorityRisk="UNKNOWN"`

Phase 5 caution: current mapping cannot distinguish "authority explicitly disabled" from "unknown", so `mint_authority_absent_or_unknown` and `freeze_authority_absent_or_unknown` must be treated as `WARN`, not a confident pass, unless the Helius mapper is improved.

## 10. DexScreener Liquidity Fields Currently Mapped

Files:

- `backend/src/providers/dexscreener/dexscreener.schemas.ts`
- `backend/src/providers/dexscreener/dexscreener.mappers.ts`

Current pair fields mapped into `DexPairSnapshot`:

- `chainId`
- `dexId`
- `pairAddress`
- `baseMint`
- `quoteMint`
- `baseSymbol`
- `quoteSymbol`
- `priceUsd`
- `priceNative`
- `liquidityUsd`
- `volume5m`
- `volume1h`
- `volume6h`
- `volume24h`
- `txns5mBuys`
- `txns5mSells`
- `pairCreatedAt`
- `source="DEXSCREENER"`
- `fetchedAt`

Current best-pair selection:

1. Higher `liquidityUsd`
2. Higher `volume24h`
3. Newer `pairCreatedAt`
4. Lexicographic `pairAddress`

Phase 5 can use `liquidityUsd`, `volume5m`, `volume1h`, `volume24h`, and `pairCreatedAt` immediately.

## 11. Jupiter Quote And Price-Impact Fields Currently Mapped

Files:

- `backend/src/providers/jupiter/jupiter.schemas.ts`
- `backend/src/providers/jupiter/jupiter.mappers.ts`

Price fields mapped into `TokenPriceSnapshot`:

- `priceUsd` from `usdPrice`
- `confidence="HIGH"` when `usdPrice` exists, otherwise `UNKNOWN`
- `rawReferenceId` from `blockId`
- `source="JUPITER"`
- `fetchedAt`

Metadata fields derived from price response:

- `decimals`

Quote fields mapped into `QuoteResult`:

- `inputMint`
- `outputMint`
- `inputAmountRaw`
- `outputAmountRaw`
- `estimatedPriceImpactPct` from `priceImpactPct`
- `routeSummary` with route label, input mint, output mint, and percent
- `minimumOutAmountRaw` from `otherAmountThreshold`
- `contextSlot`
- `source="JUPITER"`
- `fetchedAt`

Phase 5 note: price impact is available only when Phase 5 asks `MarketDataService` for quote requests. The Phase 4 scanner did not request buy or sell quotes.

## 12. Scanner Test Files And Safety Boundary

Scanner tests:

- `backend/src/scanner/ScannerConfig.test.ts`
- `backend/src/scanner/ScannerDiscoveryService.test.ts`
- `backend/src/scanner/CandidateEnrichmentService.test.ts`
- `backend/src/scanner/mappers/RadarCandidateMapper.test.ts`
- `backend/src/scanner/TokenRadarPersistenceService.test.ts`
- `backend/src/scanner/ScannerRunner.test.ts`

Important safety boundary in `ScannerRunner.test.ts`:

```ts
function assertScannerSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.riskAssessments.listRiskAssessments(sessionId)).toHaveLength(0);
  expect(repositories.strategyDecisions.listStrategyDecisions(sessionId)).toHaveLength(0);
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
}
```

Phase 5 should add a matching risk-engine boundary test that verifies risk evaluation creates `RiskAssessment` records but still creates no strategy decisions, orders, fills, positions, wallet activity, signing, or submission.

## 13. Sample TokenRadar Row From A Real Phase 4 Scanner Run

Source: local `data/nexus_paper.db`, latest `token_radar` row by `created_at_ms` at the time this handoff was written. Raw provider payloads are not included; this is the compact Phase 4 `rawDataJson` summary.

```json
{
  "id": "radar_d853cb10-2b0c-4f79-8031-974860852aa4",
  "sessionId": "session_3e2830d0-1bb0-496c-b8f0-772215840996",
  "mintAddress": "66n4pFmt1YWPzsX97mRxwmSDYfQ782f1ZTSzKuhJpump",
  "symbol": "PUMPTOWN",
  "name": "Pump Town",
  "pairAddress": "CjiyhVPHKSea21iEjhZZRemfViHEHLFLMcMwAeStVH4V",
  "source": "DEXSCREENER",
  "firstSeenAtIso": "2026-06-21T03:11:53.000Z",
  "discoveredAtIso": "2026-06-21T06:14:11.494Z",
  "priceUsd": "0.000001694",
  "priceSol": "2.319e-8",
  "liquidityUsd": "2955.82",
  "volume5mUsd": "8.47",
  "volume1hUsd": "61.21",
  "ageSeconds": 10938,
  "status": "DISCOVERED",
  "notes": "Enrichment warnings: 2",
  "rawDataSummary": {
    "phase": "PHASE_4_SCANNER_ONLY",
    "discovery": {
      "source": "DEXSCREENER",
      "identity": {
        "chainId": "solana",
        "mintAddress": "66n4pFmt1YWPzsX97mRxwmSDYfQ782f1ZTSzKuhJpump"
      }
    },
    "enrichment": {
      "ok": true,
      "sourcesUsed": ["DEXSCREENER", "HELIUS"],
      "warningCount": 2,
      "price": {
        "source": "DEXSCREENER",
        "priceUsd": 0.000001694,
        "priceSol": 2.319e-8
      },
      "bestPair": {
        "source": "DEXSCREENER",
        "dexId": "pumpswap",
        "pairAddress": "CjiyhVPHKSea21iEjhZZRemfViHEHLFLMcMwAeStVH4V",
        "baseMint": "66n4pFmt1YWPzsX97mRxwmSDYfQ782f1ZTSzKuhJpump",
        "quoteMint": "So11111111111111111111111111111111111111112",
        "liquidityUsd": 2955.82,
        "volume5m": 8.47,
        "volume1h": 61.21,
        "pairCreatedAt": "2026-06-21T03:11:53.000Z"
      },
      "metadata": {
        "source": "HELIUS",
        "symbol": "PUMPTOWN",
        "name": "Pump Town",
        "decimals": 6
      },
      "riskEvidence": {
        "source": "HELIUS",
        "flags": ["mint_authority_absent_or_unknown", "freeze_authority_absent_or_unknown"],
        "mintAuthorityRisk": "UNKNOWN",
        "freezeAuthorityRisk": "UNKNOWN"
      }
    }
  }
}
```

## 14. Phase 4 Completion Notes

Implemented:

- Scanner config and CLI parsing.
- Discovery through `TokenDiscoveryProvider`.
- Mint-address dedupe.
- Enrichment through `MarketDataService`.
- TokenRadar normalization and upsert.
- One-shot, continuous, dry-run, auto-session, and reusable-session behavior.
- `SystemLog` and provider-health integration.
- Safety tests proving scanner creates no risk assessment, strategy decision, order, fill, or position records.
- Scanner architecture, README, roadmap, decision log, and structure docs.

Final verification commands:

```bash
corepack pnpm verify
corepack pnpm scanner:discover --once --dry-run
corepack pnpm scanner:discover --once
```

Observed final scanner output:

```text
Providers enabled: DEXSCREENER, JUPITER, HELIUS
Discovery providers: DEXSCREENER
Wallet loaded: no
Transaction signing: disabled
Transaction submission: disabled
Cycle summary: discovered=25 unique=25 enriched=25 stored=25 errors=0
```

Known Phase 4 limitation:

- Discovery is DexScreener token profiles only.
- Recent-pair and streaming discovery are deferred.
- Scanner enrichment does not request Jupiter quotes, so price impact is not present in scanner rows by default.

## Phase 5 Decision Feedback

### Command Shape

Recommendation: add a separate command now, backed by a reusable service.

Suggested scripts:

```bash
pnpm risk:evaluate --once
pnpm risk:evaluate --session-id=session_123
pnpm risk:evaluate --status=DISCOVERED,WATCHING
pnpm risk:evaluate --since-hours=24
pnpm risk:evaluate --limit=50
pnpm risk:evaluate --dry-run
```

Reason: Phase 5 should be independently testable and runnable without changing scanner semantics. The implementation should still expose a `RiskEvaluationService` that a later runner can call after scanner cycles.

### Candidate Selection

Recommendation: evaluate `DISCOVERED` and `WATCHING` tokens by default, with a recency window and limit.

Suggested default:

- statuses: `DISCOVERED,WATCHING`
- since: last `24` hours by `discoveredAtMs`
- limit: `50`

Reason: this keeps Phase 5 focused on candidates the scanner is actively feeding, while avoiding old or intentionally ignored rows. It may require adding repository support for status arrays and `discoveredAtMs` filtering.

### Session Selection

Recommendation: risk evaluation consumes existing scanner output and never auto-creates sessions.

Default behavior:

```text
If --session-id is supplied:
  Use that session after validating it exists and is PAPER.

If --session-id is not supplied:
  Use the latest PAPER session with status RUNNING that has TokenRadar candidates.
  If none exists, fail with a clear message.
```

Reason: Phase 4 scanner sessions intentionally remain `RUNNING`, and scanner output is session-scoped. Auto-creating an empty risk session would make the command look successful while evaluating nothing useful.

### First-Pass Risk Thresholds

Recommended paper-mode defaults:

- Mint authority present: `FAIL`
- Freeze authority present: `FAIL`
- `mint_authority_absent_or_unknown`: `WARN`, not pass
- `freeze_authority_absent_or_unknown`: `WARN`, not pass
- Liquidity below `$2,000`: `FAIL`
- Liquidity `$2,000` to `$10,000`: `WARN`
- Liquidity at or above `$10,000`: liquidity check passes
- Pair age below `5` minutes: `FAIL`
- Pair age `5` to `30` minutes: `WARN`
- Missing best pair: `FAIL`
- Missing Helius evidence: `WARN`
- Missing Jupiter quote: `WARN` initially
- Buy or sell quote price impact above `15%`: `FAIL`
- Price impact `5%` to `15%`: `WARN`

Important: Phase 5 must define a quote probe amount before price-impact checks are real. A small configurable paper probe, such as `0.01 SOL`, is enough for a first pass.

### Authority Evidence Policy

Recommendation: keep authority checks conservative until provider evidence can distinguish explicit disabled authority from missing or unknown authority fields.

Current Phase 3 Helius behavior:

- Authority present maps to `mint_authority_present` or `freeze_authority_present` and should fail the corresponding risk check.
- Authority absent or unknown maps to `mint_authority_absent_or_unknown` or `freeze_authority_absent_or_unknown` and should warn, not pass.
- `mintAuthorityRisk="UNKNOWN"` and `freezeAuthorityRisk="UNKNOWN"` should not set `mintAuthorityDisabled=true` or `freezeAuthorityDisabled=true` in `RiskAssessment`.

Future improvement: if the Helius mapper later separates explicit disabled authority from unknown provider data, Phase 5 can promote explicit disabled authority to a passing fact while keeping unknown evidence as `WARN`.

### TokenRadar Status Changes

Recommendation: Phase 5 should own risk-result status changes, but only within risk-safe statuses:

- `FAIL`: update TokenRadar to `REJECTED`
- `PASS`: update TokenRadar to `WATCHING`
- `WARN`: update TokenRadar to `WATCHING` with notes
- `UNKNOWN`: leave current status unchanged and write the `RiskAssessment`

Reason: rejecting failed-risk tokens is a risk-engine responsibility, not a strategy decision. But Phase 5 should not use `APPROVED` or `BOUGHT`; those remain out of scope until later strategy and execution phases.
