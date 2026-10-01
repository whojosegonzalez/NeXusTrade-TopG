# PaperExchange Architecture

Phase 7 adds the first paper execution engine. It consumes approved strategy output and creates simulated BUY execution records. Phase 7.5 adds the matching paper SELL engine documented in [paper-sell-engine.md](./paper-sell-engine.md).

PaperExchange is not a wallet runner, swap builder, signer, or live-trading executor.

## Runtime Command

```bash
pnpm paper:execute --once
```

Supported options:

```bash
pnpm paper:execute --dry-run
pnpm paper:execute --session-id=session_123
pnpm paper:execute --buy-sol=0.01
pnpm paper:execute --limit=10
```

Defaults:

- `buySol`: `0.01`
- `limit`: `10`
- `baseFeeLamports`: `5000`
- `priorityFeeLamports`: `0`
- `slippageBps`: `100`
- `quoteSource`: `TOKEN_RADAR_PRICE`
- `dryRun`: `false`

The command runs in `PAPER` mode only. It prints that wallet loading, transaction signing, and transaction submission are disabled.

## Session Policy

Paper execution consumes existing scanner, risk, and strategy output. It never auto-creates sessions.

When `--session-id` is supplied:

- the session must exist
- the session must be `PAPER`
- the session must be `RUNNING`
- the session must have `terminationReason = NOT_TERMINATED`

When `--session-id` is omitted:

- use the latest `PAPER` session with status `RUNNING` that has approved BUY execution candidates
- skip `RUNNING` sessions whose `terminationReason` is not `NOT_TERMINATED`
- fail with a clear message if no eligible session exists

Phase 8 SessionManager gates future paper BUY activity by setting `Session.terminationReason` to
`TARGET_REACHED` or `MAX_DRAWDOWN` while keeping the session `RUNNING` for snapshots and manual
SELLs. Paper BUY execution treats those sessions as buy-gated and will not create new entry orders.

## Pipeline

Each paper execution run executes:

```text
SELECT APPROVED BUY CANDIDATES
VALIDATE SESSION
BUILD SIMULATED QUOTE
VALIDATE NO OPEN POSITION
VALIDATE CASH
CREATE ORDER
LINK QUOTE
CREATE FILL
OPEN POSITION
UPDATE SESSION CASH
MARK TOKENRADAR BOUGHT
LOG
```

The implementation uses:

- `PaperExchangeConfig` for defaults, bounds, and CLI parsing
- `PaperExecutionCandidateSelector` for active session and `BUY` + `APPROVED` selection
- `PaperFillFactory` for simulated quote, slippage, token amount, and fill input creation
- `PaperOrderFactory` for paper BUY order input creation
- `PaperPositionFactory` for open position input creation
- `PaperExecutionService` for write ordering, rejection handling, status updates, and logs
- `PaperRunner` and `paper-execute.ts` for CLI orchestration

## Candidate Selection

Phase 7 selects only:

```text
StrategyDecision.decision = BUY
TokenRadar.status = APPROVED
```

The decision and TokenRadar row must belong to the same session and mint.

Phase 7 does not consume:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

## Simulated Quote

The first paper BUY engine uses `TokenRadar.priceSol` as the simulated price source.

If `TokenRadar.priceSol` is missing or invalid:

- create a paper order
- mark it `REJECTED`
- use reason `MISSING_PRICE_SOL`
- do not create a fill, position, cash update, or TokenRadar status update

Price impact is read from latest compact risk evidence when available. If missing, it falls back to `0` bps.

## Costs

PaperExchange uses integer lamports for final cash accounting.

```text
estimatedSlippageLamports = ceil(requestedSolLamports * slippageBps / 10000)
totalCostLamports =
  requestedSolLamports
  + baseFeeLamports
  + priorityFeeLamports
  + estimatedSlippageLamports
```

The default Phase 7 buy uses:

```text
requestedSolLamports = 10_000_000
baseFeeLamports = 5_000
priorityFeeLamports = 0
slippageBps = 100
estimatedSlippageLamports = 100_000
totalCostLamports = 10_105_000
```

## Order Lifecycle

Successful BUY:

```text
CREATED -> QUOTED -> FILLED
```

Business-rule rejection:

```text
CREATED -> REJECTED
```

Expected rejection reasons:

- `MISSING_PRICE_SOL`
- `INSUFFICIENT_CASH`
- `OPEN_POSITION_EXISTS`

Unexpected failures are logged with `SystemLog.scope = EXECUTION`. When possible, the related TokenRadar row is moved to `ERROR` only for unrecoverable persistence or mapping failures.

## Cash And Position State

Successful execution creates:

- one `Order`
- one `Fill`
- one `OPEN` `Position`

Then it updates:

- `Session.currentCashLamports`
- `TokenRadar.status = BOUGHT`

`TokenRadar` is updated last so `BOUGHT` means the execution records and cash update were already stored.

## Token Identity And Seeded Data

PaperExchange uses `mintAddress` as the executable token identity. Symbol and name are display
metadata only, and `pairAddress` is optional DEX/liquidity context from provider evidence.

Earlier development and smoke-test runs may create open positions for seeded fake mints such as
`Fake111111111111111111111111111111111111111`. Those rows are useful for validating database shape
and execution write paths, but they cannot refresh against real providers. DexScreener, Jupiter, and
Helius require real Solana mint addresses for fresh pairs, prices, quotes, and metadata.

Use `pnpm providers:smoke --mint=<real-mint>` to verify whether a token contract address can be
priced/enriched before expecting paper BUY or SELL execution to refresh market data.

## Dry Run

Dry-run mode allows:

- candidate selection
- session validation
- simulated quote creation
- duplicate-position checks
- cash checks
- summary logging

Dry-run mode skips:

- `Order` writes
- `Fill` writes
- `Position` writes
- session cash updates
- TokenRadar status updates

## Safety Boundary

Phase 7 may create:

- `Order`
- `Fill`
- `Position`
- `SystemLog`

Phase 7 may update:

- `Session.currentCashLamports`
- `TokenRadar.status`

Phase 7 must not create:

- SELL orders or fills
- closed positions
- `PositionSnapshot`
- `EquitySnapshot`
- wallet activity
- transaction signing
- transaction submission

## Known Limitations

- SELL execution is handled by Phase 7.5.
- Realized P/L is handled by Phase 7.5.
- Unrealized P/L is deferred to Phase 8.
- `PositionSnapshot` creation is deferred.
- Duplicate open-position protection is application-level.
- Paper writes are ordered and failure-marked, but there is not yet a repository-level transaction wrapper for the full multi-record execution sequence.
- A real non-dry run needs existing `BUY` + `APPROVED` candidates from earlier phases.
