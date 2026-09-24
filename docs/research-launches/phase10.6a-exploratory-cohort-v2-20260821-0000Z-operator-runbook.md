# Phase 10.6A V2 External Scheduler Runbook

Status: Phase 10.6A.1 implementation is complete and this runbook remains unarmed. No operating-system
task, background process, archive, provider call, or collection command has been started.

## Authorized Scope

This runbook applies only to the committed source-controlled launch record:

```text
archive root   data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z
cohort start   2026-08-21T00:00:00.000Z
protocol       EXPLORATORY_COHORT@v2
```

It permits only the fixed Phase 10.6A DEXSCREENER/JUPITER observational collection. It does not
authorize a strategy/default change, Phase 10.6B analysis, PAPER trading, a wallet action, signing,
submission, an order, a fill, a position, or another archive root.

## Exact External Invocation

Each operator-owned scheduler invocation must run this command from the repository root, without a
shell output redirect, output option, wrapper loop, retry, or fallback:

```powershell
corepack pnpm research:exploratory-cohort:collect -- --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v2.json --archive-root=data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z --once --format=markdown
```

The collector writes only its fixed archive artifacts in the approved archive root. The operator may
view its standard output in the scheduler history/terminal but must not add a report, cache, database,
or generated-data write.

## Provider-Free Final Closeout

After all normal scheduler invocations have ended, schedule exactly one separate provider-free
closeout at `2026-09-04T01:01:00.000Z`. It is not a market-observation slot and must have no retry,
catch-up, output redirect, or wrapper loop:

```powershell
corepack pnpm research:exploratory-cohort:collect -- --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v2.json --archive-root=data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z --finalize-missed-slots --format=markdown
```

This command accepts only the existing approved root. It constructs no market gateway and makes zero
provider/RPC/HTTP, database, runtime, wallet, signing, submission, order, fill, or position action.
If the normal collection already finalized the archive, it returns that final state without changing
archive artifacts.

## UTC Schedule

Schedule exactly 168 independent external invocations, one per two-hour slot:

```text
first invocation start   2026-08-21T01:59:00.000Z
first decision anchor    2026-08-21T02:00:00.000Z
last invocation start    2026-09-03T23:59:00.000Z
last decision anchor     2026-09-04T00:00:00.000Z
last expected exit       2026-09-04T01:00:00.000Z
provider-free closeout   2026-09-04T01:01:00.000Z
```

For slot `i` from 1 through 168:

```text
invocationStart(i) = cohortStart + (2 hours × i) - 1 minute
anchor(i)          = cohortStart + (2 hours × i)
```

If the scheduler host is in Pacific Daylight Time, the first start is 2026-08-20 18:59 PDT and the
last start is 2026-09-03 16:59 PDT. UTC is authoritative; verify the host clock is synchronized and
do not rely on an unlabelled local-time conversion.

## Scheduler Configuration

The external scheduler is operator-owned and must remain outside NeXusTrade. Configure it with all of
the following constraints:

1. Trigger at the first UTC start, repeat every two hours, and prevent starts at or after
   `2026-09-04T00:00:00.000Z`. Confirm its history will show exactly 168 starts, not 167 or 169.
2. Permit one running instance only. Do not start a new instance until the previous one exits; each
   expected invocation ends approximately one hour after its anchor.
3. Disable automatic retries, restart-on-failure, catch-up execution, and “start as soon as possible
   after a missed schedule” behavior. The allowed start window is only slot end minus 60 seconds
   through slot end.
4. Run under the already configured local operator account. Do not put a credential, API key, header,
   environment value, or provider URL in the task definition, command line, log, or this runbook.
5. Do not register an internal cron, daemon, poller, repository background process, one-minute loop,
   or two-minute loop. The scheduler may only launch the one-shot command above.
6. Schedule the provider-free final closeout once at its fixed UTC instant. It is additional to the
   168 normal invocations but is not a 169th collection slot and must not be moved earlier.

## Pre-Activation Checklist

Before enabling the external task, the operator must confirm:

- the launch-record JSON is committed unchanged and validates against the pinned V2 protocol;
- the approved archive root does not exist and has no active/archived database, session, strategy,
  PAPER, wallet, or execution path;
- `corepack pnpm verify` has passed for the committed collector baseline;
- the scheduler clock is synchronized, first/last UTC timestamps are configured correctly, and the
  schedule has exactly 168 normal starts plus one provider-free final closeout;
- the task action is precisely the command above and has no retry, catch-up, output redirect, or
  additional argument; and
- enabling the task is an intentional use of the user authorization in this launch record.

## Missed-Window Safety Rule

Do not invoke the normal collection command late to replace a missed slot. Preserve the scheduler
history and do not manually backfill, restart, widen a slot, alter an archive, or make an additional
provider call. If a later normal invocation starts in its own permitted window, it will first record
each elapsed unrepresented slot as a canonical zero-request `PAUSE_WINDOW` with reason
`EXTERNAL_INVOCATION_MISSED`, then collect only its own current slot. If no later normal invocation
can run, the fixed provider-free final closeout records the remaining missed slots and finalizes the
existing root as incomplete.

An overlap or fresh lock conflict is not retried. Preserve the scheduler history; the conflicting
invocation makes zero provider calls. Do not change the procedure during the cohort.

## Closeout Boundary

After the provider-free closeout returns, preserve the finalized archive files unchanged. Record only
the archive-relative root, file hashes, bounded outcome, exact counts, and zero safety facts. Do not
run Phase 10.6B, draft a candidate, change strategy/defaults, or use PAPER execution without separate
approval.
