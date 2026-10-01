# SessionManager Architecture

Phase 8 adds the paper-only SessionManager. It creates position and equity snapshots, calculates
unrealized P/L, tracks target and drawdown progress, and gates future paper BUY activity without
selling positions automatically.

SessionManager is not an exit engine, wallet runner, signer, live swap executor, or session
liquidator.

## Runtime Command

```bash
pnpm session:manage --once
pnpm session:manage --once --dry-run
pnpm session:manage --once --session-id=session_123
pnpm session:manage --once --target-sol=0.25
pnpm session:manage --once --target-pct=5
pnpm session:manage --once --max-drawdown-sol=0.10
pnpm session:manage --once --max-drawdown-pct=3
```

`--once` is required in Phase 8.

## Session Policy

When `--session-id` is supplied, the session must exist and be `PAPER` + `RUNNING`.

When `--session-id` is omitted, SessionManager uses the latest `PAPER` session with
`status = RUNNING`. It does not require BUY candidates, does not require open positions, and never
auto-creates sessions.

## Pipeline

```text
SELECT RUNNING PAPER SESSION
LOAD OPEN POSITIONS
VALUE OPEN POSITIONS
CALCULATE EQUITY AND UNREALIZED P/L
EVALUATE TARGET AND DRAWDOWN
CREATE POSITION SNAPSHOTS
CREATE EQUITY SNAPSHOT
UPDATE SESSION UNREALIZED P/L
SET TERMINATION REASON WHEN GATED
LOG
```

## BUY Gating

Phase 8 does not add new session statuses. It keeps sessions `RUNNING` and gates future paper BUY
activity through `Session.terminationReason`.

```text
NOT_TERMINATED -> TARGET_REACHED
NOT_TERMINATED -> MAX_DRAWDOWN
```

Paper BUY execution rejects explicit gated sessions and skips gated sessions when selecting an
implicit active paper session.

Manual `paper:sell` remains available while the session is `RUNNING`.

## Valuation Fallback

Position valuation follows this hierarchy:

1. Fresh exact sell quote through `MarketDataService` when decimals and token amount are available.
2. Refreshed provider price.
3. Cached `TokenRadar.priceSol`.
4. `Position.avgEntryPriceSol`.
5. `Position.costBasisLamports`.

The valuation source, fallback reason, provider warnings, mint address, token quantity, and market
value are stored in `PositionSnapshot.rawQuoteJson`.

Seeded fake mints are expected to use cached, entry-price, or cost-basis fallback because providers
cannot resolve fake assets.

## Snapshot Mapping

`EquitySnapshot` stores:

- cash
- open position value
- total equity
- realized P/L
- unrealized P/L
- drawdown

`PositionSnapshot` stores:

- `positionId`
- `sessionId`
- mark price when available
- market value in `sellQuoteLamports`
- unrealized P/L
- liquidity when available
- valuation context in `rawQuoteJson`

No Phase 8 migration is required.

## Safety Boundary

Phase 8 may create:

- `EquitySnapshot`
- `PositionSnapshot`
- `SystemLog`

Phase 8 may update:

- `Session.unrealizedPnlLamports`
- `Session.terminationReason`

Phase 8 must not:

- create orders
- create fills
- open positions
- close positions
- update cash
- update realized P/L
- update TokenRadar
- complete sessions
- auto-sell positions
- load wallets
- sign transactions
- submit transactions

Automatic session-level exits are implemented by Phase 8.5 ExitManager. Position-level exits such
as stop-losses, trailing stops, max-hold exits, and liquidity-collapse exits remain deferred.
