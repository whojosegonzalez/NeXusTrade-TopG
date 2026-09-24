# H2 Implementation Contract

Accepted design: D1-D9 of the [approved checklist](./NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md).
Recorded 2026-09-10 against `a0bfdf9`; implementation and tests must establish this contract before H2 closes.

## Operation Identity And Results

Version 1 keys are SHA-256 over canonical JSON containing version, PAPER mode, session ID, side,
source ID (BUY strategy-decision ID or SELL exact position ID), and explicit intent ID. The legacy
adapters use the literal `initial` intent ID. A caller may explicitly supply a stable new intent ID
through the typed application API after a terminal rejection; no CLI flag, scheduler, random key,
automatic retry, or new trading authority is introduced. The same key with different intent conflicts.

The canonical digest also binds mint, source references, requested amount, and economic policy:

- BUY: strategy-decision ID, radar ID, requested lamports, base/priority fees, slippage BPS, quote source.
- SELL: exact position ID, normalized full token quantity, base/priority fees, slippage BPS, quote source,
  cached-price permission and maximum age, explicit trigger (SELL_ALL or MINT), and optional ExitManager
  source/trigger/action. Position cost/fees and ownership are revalidated at commit.
- Exclude runner limit, once/dry-run/log switches, fresh quote/order IDs, observation timestamps,
  current cash, current provider evidence, and mutable diagnostic text. They do not identify intent.
- Sort object keys recursively; preserve ordered arrays; reject unknown fields/nonfinite values.
  Safe integers are required for lamports/BPS/age. Decimal quantity uses plain positive decimal text
  with at most 18 fractional digits, canonicalized without Number conversion.

Registration stores PENDING in its own short immediate transaction. A technical interruption,
temporary quote unavailability, stale evidence, or writer contention leaves PENDING and returns a
retryable failure with no accounting effect. No worker retries autonomously. Business rejection
(insufficient funds, conflicting exposure, invalid lifecycle/ownership/intent) is explicit; a valid
registered intent may atomically become REJECTED with its required rejected order/result but no fill,
position, or cash effect. Corruption/identity conflicts are errors, never repaired rejections.

COMMITTED and REJECTED are terminal. Replays verify stored owned result references and return that
result before provider work. Result version, operation ID, side, state/code, owned order/fill/position
references, and accounting deltas are persisted together. A replay is marked separately and adds zero
new effects to runner summaries. No mutation of terminal intent or result is permitted.

Bounded result categories: INVALID_INTENT, IDENTITY_CONFLICT, CORRUPT_OPERATION, INVALID_STATE,
STALE_EVIDENCE, RETRYABLE_EVIDENCE, RETRYABLE_CONTENTION, and TECHNICAL_FAILURE; existing domain
rejection reasons remain available. Diagnostic failures are warnings separate from these outcomes.

## Transaction Write Sets And Callers

BUY commit re-reads PAPER/RUNNING session and BUY termination gate, source decision/radar ownership,
registered intent, cash, and existing OPEN/CLOSING/ambiguous exposure. It writes order/quote status,
fill, opened position, cash delta, final order status, radar BOUGHT, and operation result atomically.
Missing price/duplicate exposure/insufficient cash retain existing rejected-order behavior atomically.

SELL commit re-reads PAPER/RUNNING session and supported explicit exit gate, exact OPEN position,
quantity/basis/fees, intent, current cash/P&L, and prepared evidence freshness. It writes order/fill,
conditional close, net cash and realized P/L deltas, final order/radar state, and operation result
atomically. Never subtract fees twice from the already-net SELL fill proceeds. No partial sales.

All participating repositories come from the same synchronous transaction. No await, provider call,
or diagnostic log runs inside it. Async callbacks are rejected and transaction access is invalidated
after callback return; an escaped repository or delayed continuation must not write. Validate affected
row counts and safe-integer arithmetic before committing. Busy/locked errors yield bounded retryable
results with no internal retry loop. Diagnostics before/after the operation cannot change its result.

Caller inventory includes PaperRunner, PaperSellRunner, direct PaperExecutionService/
PaperSellExecutionService users, ExitManagerService, TerminalStageRunner, and script composition roots.
Selectors keep existing behavior; replay at the operation boundary remains supported even when the
normal selector no longer selects a filled/closed item. No operational script is executed during H2.

## Radar Merge Policy

Identity is session/mint/source/pair, with undefined normalized to null and blank pair rejected.
Preserve existing ID and creation time, and the minimum first-seen time. Discovery fields update
only when incoming discoveredAt is strictly newer; equal/older observations leave those fields
unchanged. BOUGHT, WATCHING, and ERROR are execution-owned for discovery upserts and cannot be reset
by them. Explicit execution status updates retain their existing responsibility. Null and non-null
pairs have separate unique indexes; use atomic ON CONFLICT updates, never REPLACE or a read/insert race.

## Schema And Migration Design

Add PAPER operations with versioned intent/result, PENDING/COMMITTED/REJECTED state, session/side/source
ownership, terminal result references, and safe timestamps. Composite ownership keys enforce matching
sessions for operations/orders/fills and decision links where representable. Service checks additionally
bind mint, position, and side. New H2 operations have one full fill; historical PARTIALLY_FILLED shapes
remain recognizable and reconcile as INCOMPLETE rather than being silently converted.

Existing session/order/position/radar enum domains become real SQL constraints. Cash and fees are
nonnegative safe integers; signed P/L remains permitted within safe-integer limits. Timestamps use
nonnegative safe integers, end/close cannot precede start/open, and update cannot precede creation.
Nullable historical fields retain nullability. OPEN/CLOSING positions are unique by session/mint;
ERROR exposure blocks new conflicting execution in the service until reviewed.

Migration SQL 0000/0001 and their existing journal entries remain unchanged. Append a new migration
and pin the trusted ordered chain and structural features. Preflight invalid prior data and report
bounded table/key/reason findings without repair. If SQLite rebuilds need foreign keys disabled,
do so only on the explicitly supplied migration connection outside its transaction, restore the
previous setting in finally, and check all foreign keys before committing the single migration
transaction. Failed rebuilds/journal writes roll back. Migration readiness is read-only, verifies
the full trusted chain and required schema, and never auto-migrates. Unknown/newer/tampered databases
are rejected. Only owned fixtures are migrated during implementation.

## Reconciliation

Accept supplied read-only repositories/snapshots only, with no default database/configuration path.
Verify cash, fills/orders, owned operation links, lifecycle, fees/P&L, and orphan/duplicate records.
PASS requires sufficient evidence for every applicable invariant. Any proven discrepancy dominates
INCOMPLETE; otherwise missing/ambiguous historical evidence yields INCOMPLETE. Seeded positions,
unsupported partial fills, and unrecorded cash movements cannot be invented into a complete history.
No repair, migration, report-file output, or cash-ledger backfill is included.
