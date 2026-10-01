# Paper SELL Engine Architecture

Phase 7.5 adds the SELL side of PaperExchange. It consumes open paper positions, requires an
explicit sell trigger, creates simulated SELL records, closes positions, restores paper cash, and
stores realized P/L.

The SELL engine is not a target manager, stop-loss engine, wallet runner, signer, or live swap
executor.

## Runtime Command

```bash
pnpm paper:sell --once --sell-all
pnpm paper:sell --once --mint=<mint>
pnpm paper:sell --once --sell-all --dry-run
pnpm paper:sell --once --mint=<mint> --dry-run
```

Rejected by design:

```bash
pnpm paper:sell --once
```

Plain `--once` fails because Phase 7.5 requires explicit operator intent through either
`--sell-all` or `--mint=<mint>`.

## Defaults

- `limit`: `10`
- `slippageBps`: `100`
- `baseFeeLamports`: `5000`
- `priorityFeeLamports`: `0`
- `allowCachedRadarPrice`: `false`
- `maxCachedPriceAgeMs`: `60000`
- `quoteSource`: `MarketDataService`

## Session Policy

Paper SELL execution:

- runs only in `PAPER`
- requires a `RUNNING` session
- does not auto-create sessions
- uses the latest active paper session with matching open positions when `--session-id` is omitted
- never completes sessions or evaluates targets

## Pipeline

```text
SELECT OPEN POSITIONS
VALIDATE SESSION AND POSITION
REFRESH QUOTE OR PRICE
CALCULATE PROCEEDS AND P/L
CREATE SELL ORDER
LINK QUOTE
CREATE SELL FILL
CLOSE POSITION
UPDATE SESSION CASH/P&L
MARK TOKENRADAR WATCHING
LOG
```

## Quote Fallback

The quote service follows the locked fallback hierarchy:

1. Exact sell quote through `MarketDataService` when decimals and quote path are available.
2. Refreshed provider price when exact quote construction is unavailable.
3. Cached `TokenRadar.priceSol` only when `--allow-cached-radar-price` is supplied and the row is
   not stale.
4. Reject if no usable pricing exists.

Cached price fallback is disabled by default.

Fresh quotes and refreshed prices require a real Solana token mint. Seeded fake positions can still
exercise selection, validation, rejection, and logging, but provider refresh will reject them because
DexScreener, Jupiter, and Helius cannot resolve fake assets.

## Existing-Schema Storage

No Phase 7.5 DB migration is required.

SELL order details:

- `Order.side = SELL`
- `Order.requestedTokenAmount = position.tokensHeld`
- `Order.rawOrderJson` stores `positionId`, trigger context, position context, policy, rejection,
  and failure details.

SELL fill details:

- `Fill.tokensFilled = sold quantity`
- `Fill.solReceivedLamports = net sell proceeds`
- `Fill.rawQuoteJson` stores mint, side, gross proceeds, net proceeds, fees, slippage, price impact,
  quote provider, fallback details, and P/L context.
- When called by ExitManager, SELL order and fill JSON include `exitContext.source =
EXIT_MANAGER`.

Closed position details:

- `Position.status = CLOSED`
- `Position.proceedsLamports = net sell proceeds`
- `Position.realizedPnlLamports` and `realizedPnlBps` are set
- `Position.feesPaidLamports` becomes buy fees plus sell fees

## Accounting

```text
grossProceedsLamports =
tokensHeld * sellPrice

netSellProceedsLamports =
grossProceedsLamports
- sellFeesLamports
- sellSlippageLamports

realizedPnlLamports =
netSellProceedsLamports
- position.costBasisLamports
- position.feesPaidLamports
```

Session cash is updated with net sell proceeds only.

## Dry Run

Dry-run mode may select positions, refresh quote/price evidence, calculate proceeds, and log a
summary.

Dry-run mode must not create orders, create fills, close positions, update session cash, update
TokenRadar, or create snapshots.

## Safety Boundary

Phase 7.5 may create:

- `Order(SELL)`
- `Fill(SELL)`
- `SystemLog`

Phase 7.5 may update:

- `Position` to `CLOSED`
- `Session.currentCashLamports`
- `Session.realizedPnlLamports`
- `TokenRadar.status` from `BOUGHT` to `WATCHING`

Phase 7.5 must not:

- load wallets
- sign transactions
- submit transactions
- use live mode
- create `PositionSnapshot`
- create `EquitySnapshot`
- complete sessions
- trigger target-profit or stop-loss logic

## Known Limitations

- The first pass uses deterministic ordered writes rather than a repository-level transaction
  wrapper.
- SELL audit details that are not first-class columns live in existing JSON fields.
- Cached price fallback must be explicitly enabled.
- Local seeded fake positions are expected to reject fresh provider pricing.
- Phase 8 owns snapshots and target/drawdown detection.
- Phase 8.5 owns session-level target/drawdown sell-all automation and optional session completion.
- Stop-loss, trailing-stop, max-hold, liquidity-collapse, and partial exits remain deferred.
