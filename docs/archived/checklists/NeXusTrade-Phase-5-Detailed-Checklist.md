# NeXusTrade Phase 5 Detailed Checklist

Phase 5 builds the first deterministic risk engine. It consumes existing Phase 4 `TokenRadar` candidates, refreshes evidence, probes quotes, evaluates deterministic risk rules, writes `RiskAssessment` records, and updates TokenRadar only within risk-safe bounds.

Phase 5 does not create strategy decisions, orders, fills, positions, wallet activity, transaction signing, transaction submission, or live trades.

## Definition of Done

- [x] Risk runner command exists.
- [x] Root package exposes `risk:evaluate`.
- [x] Backend package exposes `risk:evaluate`.
- [x] Risk runtime config exists.
- [x] Risk CLI parsing exists.
- [x] Default statuses are `DISCOVERED,WATCHING`.
- [x] Default recency window is 24 hours.
- [x] Default candidate limit is 50.
- [x] Default max enrichment concurrency is 3.
- [x] Default quote probe is `0.01 SOL`.
- [x] Phase 5 does not auto-create sessions.
- [x] No-session behavior selects the latest `PAPER` + `RUNNING` session with eligible TokenRadar candidates.
- [x] No-session behavior fails clearly when no eligible session exists.
- [x] Candidate selection is implemented.
- [x] TokenRadar repository supports multi-status filtering.
- [x] TokenRadar repository supports `discoveredAtMs` recency filtering.
- [x] Evidence refresh is implemented through `MarketDataService`.
- [x] Buy quote probing is implemented.
- [x] Sell quote probing is implemented when a buy quote is available.
- [x] Missing Jupiter quote evidence is `WARN`.
- [x] Authority rules are implemented.
- [x] Unknown Helius authority evidence is `WARN`, not `PASS`.
- [x] Unknown authority evidence does not set disabled authority fields to `true`.
- [x] Liquidity rules are implemented.
- [x] Pair age rules are implemented.
- [x] Price impact rules are implemented.
- [x] Risk flag taxonomy exists.
- [x] 0-100 scoring is implemented.
- [x] PASS/WARN/FAIL score bands are implemented.
- [x] Warning rule severity cannot be mislabeled as PASS.
- [x] RiskAssessment persistence is implemented.
- [x] TokenRadar status updates are implemented.
- [x] Risk notes are appended instead of blindly replacing scanner notes.
- [x] Dry-run mode skips RiskAssessment writes.
- [x] Dry-run mode skips TokenRadar updates.
- [x] SystemLog entries are written with scope `RISK`.
- [x] Boundary tests verify no strategy decisions, orders, fills, or positions.
- [x] Risk engine documentation is created.
- [x] `docs/Structure.md`, `docs/ROADMAP.md`, and `README.md` are updated.

## Verification Notes

- 2026-06-21: `corepack pnpm typecheck` passed.
- 2026-06-21: `corepack pnpm test` passed with 26 backend test files and 71 backend tests.
- 2026-06-21: risk config, deterministic rules, scoring, candidate selection, dry-run, persistence, status updates, and safety boundaries are covered by tests.
- 2026-06-21: `corepack pnpm risk:evaluate --once --dry-run` passed against the local paper database with 25 selected, 25 evaluated, 0 written, and 0 status updates.
- 2026-06-21: `corepack pnpm risk:evaluate --once` passed against the local paper database with 25 selected, 25 evaluated, 25 written, and 25 status updates.

## Verification Commands

```bash
pnpm verify
pnpm risk:evaluate --once --dry-run
pnpm risk:evaluate --once
```

## Runtime Commands

```bash
pnpm risk:evaluate --once
pnpm risk:evaluate --session-id=session_123
pnpm risk:evaluate --status=DISCOVERED,WATCHING
pnpm risk:evaluate --since-hours=24
pnpm risk:evaluate --limit=50
pnpm risk:evaluate --concurrency=3
pnpm risk:evaluate --probe-sol=0.01
pnpm risk:evaluate --dry-run
```

## Phase Notes

- Phase 5 consumes scanner sessions and does not create sessions.
- If no session ID is supplied, Phase 5 uses the latest `PAPER` + `RUNNING` session with eligible TokenRadar candidates.
- Risk evaluation refreshes evidence before scoring instead of relying only on scanner-stored evidence.
- Risk evaluation uses bounded candidate refresh concurrency to keep the default 50-candidate run practical.
- The buy quote probe is `SOL -> token` for the configured SOL amount.
- The sell quote probe is `token -> SOL` using the buy quote output amount when available.
- A missing quote is warning evidence, not a failed run.
- Helius authority evidence remains conservative until the mapper can distinguish explicit disabled authority from unknown data.
- `FAIL` updates TokenRadar to `REJECTED`.
- `PASS` and `WARN` update TokenRadar to `WATCHING`.
- `UNKNOWN` leaves TokenRadar status unchanged.
- Phase 5 never sets `APPROVED` or `BOUGHT`.
- Provider latency can make full 50-candidate evaluations slow; `--concurrency` controls bounded parallelism.

## Out of Scope

- Holder concentration scoring.
- Strategy decisions.
- Paper buy/sell simulation.
- PaperExchange.
- P/L target enforcement.
- Dashboard UI.
- Wallet loading.
- Swap transaction construction.
- Transaction signing.
- Transaction submission.
- Live trading.
