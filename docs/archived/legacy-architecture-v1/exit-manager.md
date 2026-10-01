# ExitManager Architecture

Phase 8.5 adds the paper-only ExitManager. It reacts to SessionManager governance signals and can
automatically close all open paper positions when the operator explicitly configures a matching
sell-all action.

ExitManager is not a stop-loss engine, trailing-stop engine, max-hold engine, liquidity-collapse
engine, wallet runner, signer, live swap executor, or partial-exit engine.

## Runtime Command

```bash
pnpm exits:manage --once
pnpm exits:manage --once --dry-run
pnpm exits:manage --once --session-id=session_123
pnpm exits:manage --once --target-action=sell-all
pnpm exits:manage --once --drawdown-action=sell-all
pnpm exits:manage --once --target-action=sell-all --complete-session-on-exit=true
```

`--once` is required.

Observe-only is the default. Automated liquidation happens only when the matching action is
explicitly set to `sell-all`.

## Session Policy

When `--session-id` is supplied, the session must exist, be `PAPER`, be `RUNNING`, and have a
non-`NOT_TERMINATED` termination reason.

When `--session-id` is omitted, ExitManager selects a `PAPER` + `RUNNING` session with a supported
exit trigger, preferring the latest gated session that still has open positions.

Supported triggers:

```text
TARGET_REACHED
MAX_DRAWDOWN
```

Unsupported termination reasons are not liquidated in Phase 8.5.

## Pipeline

```text
SELECT GATED RUNNING PAPER SESSION
EVALUATE TERMINATION REASON
RESOLVE OBSERVE OR SELL-ALL ACTION
CALL PAPERSELL SERVICE LAYER WHEN NEEDED
OPTIONALLY COMPLETE SESSION
LOG AND SUMMARIZE
```

## PaperSell Reuse

ExitManager directly reuses the existing PaperSell service layer:

- `PaperSellCandidateSelector`
- `PaperSellQuoteService`
- `PaperSellValidationService`
- `PaperSellAccountingService`
- `PaperSellExecutionService`
- `PaperSellOrderFactory`
- `PaperSellFillFactory`

This preserves the Phase 7.5 quote fallback, ordered write behavior, realized P/L calculation, cash
update, position close, and TokenRadar `BOUGHT -> WATCHING` behavior.

ExitManager passes an optional `exitContext` into PaperSell so SELL order and fill JSON can identify
the source as `EXIT_MANAGER`.

## Session Completion

Session completion is controlled by:

```text
--complete-session-on-exit=true
```

Completion is disabled by default.

ExitManager completes a session only when:

- the session is `PAPER` + `RUNNING`
- the trigger is `TARGET_REACHED` or `MAX_DRAWDOWN`
- the matching action is `sell-all`
- dry-run is disabled
- all open positions are closed
- the PaperSell summary has no rejections or failures

Completion preserves the existing termination reason.

## Dry Run

Dry-run may select sessions, evaluate triggers, plan actions, call PaperSell in dry-run mode, and
print a summary.

Dry-run must not write:

- `SystemLog`
- `Order`
- `Fill`
- `Position`
- `Session`
- `TokenRadar`

ExitManager suppresses PaperSell system logs during ExitManager dry-runs so dry-run remains a true
no-write mode.

## Logging

ExitManager uses:

```text
SystemLog.scope = EXECUTION
contextJson.phase = PHASE_8_5_EXIT_MANAGER
```

No dedicated `EXIT` scope is required for Phase 8.5.

## Safety Boundary

Phase 8.5 may create:

- `Order(SELL)`
- `Fill(SELL)`
- `SystemLog`

Phase 8.5 may update:

- `Position` to `CLOSED`
- `Session.currentCashLamports`
- `Session.realizedPnlLamports`
- `Session.status` to `COMPLETED`, only when explicitly configured
- `TokenRadar.status` from `BOUGHT` to `WATCHING`

Phase 8.5 must not:

- create BUY orders
- open positions
- create snapshots
- evaluate stop losses
- evaluate trailing stops
- evaluate max-hold exits
- evaluate liquidity-collapse exits
- execute partial exits
- load wallets
- sign transactions
- submit transactions

## Known Limitations

- ExitManager reacts only to session-level `terminationReason`.
- Sell-all is the only automated exit action.
- PaperSell still uses ordered writes rather than a repository-level transaction wrapper.
- Some exit audit fields live in JSON rather than dedicated columns.
- Provider quote availability still depends on real token mints and provider responses.
