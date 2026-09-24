# Phase 10.6A.2 V3 External Scheduler Runbook

Status: Scheduler setup was authorized for the one committed V3 launch record below. The operator
registered and armed the matching task on 2026-09-04, and the frozen measurement-only collection is
active. This runbook remains a historical setup and inspection record; do not run its setup, arm, or
collection commands manually and do not alter the existing task. It applies to no other root,
protocol, strategy, PAPER, wallet, signing, submission, order, fill, position, or execution action.

## Fixed Authorized Scope

```text
launch record  docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z.json
archive root   data/archive/phase10.6a/measurement-v3-20260904-2100Z/
cohort anchor  2026-09-04T21:00:00.000Z (2026-09-04 14:00 PDT)
protocol       EXPLORATORY_COHORT_MEASUREMENT@v3
provider       direct DEXSCREENER only
```

The collector is measurement-only. It may make only the V3-pinned `discoverTokens(100)` request at
anchor−16 minutes and direct `BEST_PAIR` requests at −15/−10/−5/0 minutes. It has no later labels,
return/target/stop/P/L calculation, database/runtime access, or execution surface.

## Exact Schedule

The following UTC timestamps are authoritative. The host is in Pacific Daylight Time for this entire
collection window.

| Event                            | UTC              | PDT              |
| -------------------------------- | ---------------- | ---------------- |
| First invocation start           | 2026-09-04 20:44 | Sep 4, 1:44 PM   |
| First anchor                     | 2026-09-04 21:00 | Sep 4, 2:00 PM   |
| Last invocation start (slot 168) | 2026-09-18 18:44 | Sep 18, 11:44 AM |
| Last anchor (slot 168)           | 2026-09-18 19:00 | Sep 18, 12:00 PM |

Configure exactly 168 starts: one at 1:44 PM PDT, repeating once every two hours. The trigger's
335-hour, 59-minute repetition duration intentionally includes starts through +334 hours and excludes
a 169th start at +336 hours. The final direct request begins at the final anchor; allow the task's
10-second direct-provider timeout to return, but do not make any post-anchor request or overlap it
with another invocation.

## Fixed Command

Each scheduler trigger must run only this one-shot command from the repository root. Do not add a
wrapper loop, output redirect, retry, fallback, provider argument, archive override, or any other
argument.

```powershell
corepack pnpm research:measurement-cohort:collect -- --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v3.json --launch=docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z.json --once --format=json
```

## Pre-Arm Checks

Open a normal PowerShell window as the same interactive Windows user who owns `U:`. Run these
read-only checks from the project root:

```powershell
Set-Location 'U:\Projects\NeXusTrade-Otis'
git status --short
Test-Path 'U:\Projects\NeXusTrade-Otis\data\archive\phase10.6a\measurement-v3-20260904-2100Z'
Get-Date
```

Expected:

- `git status --short` is empty: the launch record and this runbook are committed unchanged.
- `Test-Path` returns `False`: the physical archive root is created only by the first authorized slot.
- The displayed local time is PDT and the host clock is synchronized.

If any check differs, do not arm or manually run the collector. Preserve the evidence and ask for
direction; never compensate with a late start, replacement, extra request, retry, or changed root.

## Register Disabled Task

Run the following block once, before 1:44 PM PDT. It creates a disabled task under the current
interactive user without storing credentials or redirecting output. It does not invoke the collector.

```powershell
$ErrorActionPreference = 'Stop'
$taskName = 'NeXusTrade-Phase10.6A2-MeasurementV3-20260904'
$projectRoot = 'U:\Projects\NeXusTrade-Otis'
$powerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '& { Set-Location -LiteralPath ''U:\Projects\NeXusTrade-Otis''; corepack pnpm research:measurement-cohort:collect -- --protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v3.json --launch=docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z.json --once --format=json }'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Refusing to replace existing task: $taskName"
}

$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command"
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-09-04T13:44:00') -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Hours 335 -Minutes 59)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable:$false -RestartCount 0 -ExecutionTimeLimit (New-TimeSpan -Minutes 17)
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Disable-ScheduledTask -TaskName $taskName | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
```

Expected state: `Disabled`. Do not use `Start-ScheduledTask`; the trigger must own the exact first
start. The interactive-user setting avoids stored credentials and requires the Windows user to remain
logged in with `U:` available. Keep the PC awake for the collection window.

## Inspect, Then Arm

Before 1:44 PM PDT, inspect the registered task:

```powershell
$taskName = 'NeXusTrade-Phase10.6A2-MeasurementV3-20260904'
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
(Get-ScheduledTask -TaskName $taskName).Triggers
```

Confirm the task is disabled, starts at 1:44 PM PDT, repeats every two hours for 335 hours and 59
minutes, disables catch-up/restarts, permits only one instance, and has the fixed command above.

When those facts are correct, arm it with this one command before 1:44 PM PDT:

```powershell
Enable-ScheduledTask -TaskName 'NeXusTrade-Phase10.6A2-MeasurementV3-20260904'
```

Do not edit, start manually, rerun, or replace the task after arming.

## Monitor Without Intervention

After the first expected exit, and periodically after later slot exits, inspect only scheduler state:

```powershell
$taskName = 'NeXusTrade-Phase10.6A2-MeasurementV3-20260904'
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns
```

Expected successful result: `LastTaskResult` is `0`. A missed run, conflict, nonzero result, or task
running past its 17-minute limit is evidence to preserve, not a reason to retry, manually invoke the
collector, backfill, alter the archive, or change pacing. The next independently scheduled slot may
run only at its own fixed time.

## End Of Schedule And Boundary

After the final expected exit on Sep 18, disable the task and inspect its final scheduler result:

```powershell
$taskName = 'NeXusTrade-Phase10.6A2-MeasurementV3-20260904'
Disable-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns
```

Do not run an extra closeout, replacement, analysis, or Phase 10.6C command. If the fixed final slot
runs, the collector finalizes the immutable archive as `COHORT_COMPLETE` or
`MEASUREMENT_COHORT_DATA_INSUFFICIENT`. If the final task is missed or any archive is not final, do
nothing further to it; report the bounded scheduler facts for separate review.
