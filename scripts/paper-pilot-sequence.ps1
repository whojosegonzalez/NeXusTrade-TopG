<#
.SYNOPSIS
  NeXusTrade - conditional discovery -> Stage B single-candidate pilot (decision-only).

.DESCRIPTION
  PROPOSAL: live execution AWAITS A SEPARATE, COMBINED OPERATOR APPROVAL.

  Discovery is exactly one of two explicit modes (mutually exclusive parameter sets):
    -PrecheckOutDir <dir>          the reviewed one-shot Stage A precheck (unchanged), or
    -Watch -WatchOutDir <dir>      the bounded AMM v4 creation watch (collector -> validator -> sealer).

  Without -Execute this script is INERT: it runs only offline checks (the code/configuration pin and
  the discovery dry run, which loads no configuration, opens no transport, sends nothing and writes
  nothing) and prints the planned sequence.

  With -Execute it runs, at most once each, with no retry, substitution, fallback or polling:
    1. Pin check (relevant code/configuration equal the pinned commit and are clean; the reviewed
       runner and its dependencies are unchanged since 6855efb).
    2. Wallet hash check.
    3. Discovery into a NEW directory: the precheck (--live) or ONE watch run (--live). Only exit 0
       (a selected target; for the watch, a sealed, verified, confirmed selection) continues.
       Cancellation, no target, failure or incomplete evidence ends the sequence; the watch never
       falls back to the precheck and discovery is never repeated.
    4. Handoff check (offline; structured JSON whose exit code must match its decision). For watch
       evidence: integrity, completeness, REPRODUCED, confirmed selection, identity, start window,
       new pilot directory, and the sealed manifest digest. WAIT -> exactly one bounded sleep.
    5. Stage B dry run with the exact handed-off pool and mint.
    6. Handoff check AGAIN, immediately before Stage B (pin, evidence and window rechecked); it must
       allow the identical pool and mint and, for watch evidence, the identical manifest digest.
    7. Stage B (--live) once.
  Final checks run on every path once a live step may have run, and never replace the original
  failure: Stage B integrity verification (if Stage B ran), watch evidence verification (if the
  watch ran), and the wallet hash. Operator Ctrl+C stops the sequence; the final checks are
  attempted and the summary (outcome, original failure, final-check failures) is printed from the
  sequence core's finally block, which runs even though the core then never returns.

.PARAMETER PinnedCommit
  The reviewed commit (40 hex characters) the working tree must match.
.PARAMETER PrecheckOutDir
  Precheck mode: new directory under data/research/prechecks/ for Stage A.
.PARAMETER Watch
  Watch mode (requires -WatchOutDir).
.PARAMETER WatchOutDir
  Watch mode: new directory directly under data/research/prechecks/ for the sealed watch run.
.PARAMETER PilotOutDir
  New directory under data/research/single-candidate/ for Stage B.
.PARAMETER Execute
  Explicit request to perform the live sequence. Omit for the inert check.
#>
[CmdletBinding(DefaultParameterSetName = 'Precheck')]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PinnedCommit,
  [Parameter(Mandatory = $true, ParameterSetName = 'Precheck')][ValidatePattern('^data/research/prechecks/[A-Za-z0-9._-]+$')][string]$PrecheckOutDir,
  [Parameter(Mandatory = $true, ParameterSetName = 'Watch')][switch]$Watch,
  [Parameter(Mandatory = $true, ParameterSetName = 'Watch')][ValidatePattern('^data/research/prechecks/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$WatchOutDir,
  [Parameter(Mandatory = $true)][ValidatePattern('^data/research/single-candidate/[A-Za-z0-9._-]+$')][string]$PilotOutDir,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot
. (Join-Path $PSScriptRoot 'paper-pilot-sequence.core.ps1')

$Tsx = Join-Path $RepoRoot 'backend/node_modules/tsx/dist/cli.mjs'
$WalletPath = Join-Path $RepoRoot '.tmp/virtual-wallet.json'

$config = @{
  Mode           = $(if ($PSCmdlet.ParameterSetName -eq 'Watch') { 'WATCH' } else { 'PRECHECK' })
  PinnedCommit   = $PinnedCommit
  EvidenceOutDir = $(if ($PSCmdlet.ParameterSetName -eq 'Watch') { $WatchOutDir } else { $PrecheckOutDir })
  PilotOutDir    = $PilotOutDir
  Execute        = [bool]$Execute
  WalletSha256   = '7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9'
  Scripts        = @{
    Handoff  = 'backend/src/scripts/paper-pilot-handoff.ts'
    Precheck = 'backend/src/scripts/fresh-amm-v4-precheck.ts'
    Watch    = 'backend/src/scripts/fresh-amm-v4-watch.ts'
    Runner   = 'backend/src/scripts/paper-single-candidate-diagnostic.ts'
  }
}

$hooks = @{
  # Each child runs once; its standard output is captured, its standard error goes to the console.
  RunChild    = {
    param($Step, [string[]]$Arguments)
    $output = & node $Tsx @Arguments
    return @{ Code = [int]$LASTEXITCODE; Output = (@($output) -join "`n") }
  }
  Wait        = { param([long]$Ms) Start-Sleep -Milliseconds $Ms }
  WalletHash  = { (Get-FileHash -Algorithm SHA256 -LiteralPath $WalletPath).Hash }
  PathExists  = { param($Path) Test-Path -LiteralPath $Path }
  # Operator cancellation is Ctrl+C: it stops this script (and reaches the child in the same
  # console, which seals its own cancellation); the finally block still attempts the final checks.
  IsCancelled = { $false }
  # Written straight to the console, not through the PowerShell pipeline, so the core's summary
  # still prints while a pipeline stop (Ctrl+C) is propagating through its finally blocks.
  Log         = { param($Line) [Console]::Out.WriteLine([string]$Line) }
}

# The core prints the one summary (outcome, original failure, final-check failures) from its own
# finally block, which also runs when a pipeline stop means it never returns here.
$result = Invoke-PilotSequence -Config $config -Hooks $hooks
if ($result.Outcome -eq 'INERT') { exit 0 }
if ($result.Outcome -eq 'COMPLETE') {
  Write-Host '[PILOT_SEQUENCE] Sequence complete (decision-only; no buy, no position). No rerun.'
  exit 0
}
exit 1
