<#
.SYNOPSIS
  NeXusTrade - conditional Stage A precheck -> Stage B single-candidate pilot (decision-only).

.DESCRIPTION
  PROPOSAL: live execution AWAITS A SEPARATE, COMBINED OPERATOR APPROVAL.

  Without -Execute this script is INERT: it runs only offline checks (code/configuration pin and
  the precheck dry run, which loads no configuration and sends nothing) and prints the sequence.

  With -Execute it runs, at most once each, with no retry, substitution or polling:
    1. Pin check (relevant code/configuration equal the pinned commit and are clean; the reviewed
       runner and its dependencies are unchanged since 6855efb).
    2. Wallet hash check.
    3. Stage A precheck (--live) into a NEW precheck directory. Anything but a selected target stops.
    4. Handoff check (offline): evidence integrity, re-derivation of the target from the sealed
       responses, identity, start window on the runner's age source, new pilot directory.
       WAIT -> exactly one sleep of the stated duration (bounded), never a loop.
    5. Stage B dry run with the exact sealed pool and mint.
    6. Handoff check AGAIN, immediately before Stage B; it must allow the identical pool and mint.
    7. Stage B (--live) once, then integrity verification and the wallet hash check.
  Every failure throws and stops the sequence.

.PARAMETER PinnedCommit
  The reviewed commit (40 hex characters) the working tree must match.
.PARAMETER PrecheckOutDir
  New directory under data/research/prechecks/ for Stage A.
.PARAMETER PilotOutDir
  New directory under data/research/single-candidate/ for Stage B.
.PARAMETER Execute
  Explicit request to perform the live sequence. Omit for the inert check.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PinnedCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^data/research/prechecks/[A-Za-z0-9._-]+$')][string]$PrecheckOutDir,
  [Parameter(Mandatory = $true)][ValidatePattern('^data/research/single-candidate/[A-Za-z0-9._-]+$')][string]$PilotOutDir,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot
$Tsx = Join-Path $RepoRoot 'backend/node_modules/tsx/dist/cli.mjs'
$Precheck = 'backend/src/scripts/fresh-amm-v4-precheck.ts'
$Handoff = 'backend/src/scripts/paper-pilot-handoff.ts'
$Runner = 'backend/src/scripts/paper-single-candidate-diagnostic.ts'
$WalletPath = Join-Path $RepoRoot '.tmp/virtual-wallet.json'
$WalletSha256 = '7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9'
$MaxWaitMs = 240000

function Fail([string]$Message) { throw "[PILOT_SEQUENCE_REFUSED] $Message" }

function Invoke-Node([string[]]$Arguments) {
  $output = & node $Tsx @Arguments
  return @{ Code = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Invoke-Handoff([string[]]$Arguments) {
  $r = Invoke-Node (@($Handoff, '--pinned-commit', $PinnedCommit) + $Arguments)
  $lines = @($r.Output -split "`n" | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -lt 1) { Fail "handoff produced no decision (exit $($r.Code))" }
  $decision = $lines[$lines.Count - 1] | ConvertFrom-Json
  return @{ Code = $r.Code; Decision = $decision; Raw = $lines[$lines.Count - 1] }
}

function Assert-Wallet([string]$When) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WalletPath).Hash
  if ($hash -ne $WalletSha256) { Fail "wallet hash changed ($When)" }
  Write-Host "[PILOT_SEQUENCE] Wallet hash unchanged ($When)."
}

# 1. Pin (offline).
$pin = Invoke-Handoff @('--pin-only')
if ($pin.Code -ne 0) { Fail "pin check: $($pin.Raw)" }
Write-Host "[PILOT_SEQUENCE] Pin OK: $PinnedCommit"
if (Test-Path -LiteralPath $PrecheckOutDir) { Fail "precheck directory exists: $PrecheckOutDir" }
if (Test-Path -LiteralPath $PilotOutDir) { Fail "pilot directory exists: $PilotOutDir" }

# Precheck dry run (offline: no configuration, no request, nothing written).
$dry = Invoke-Node @($Precheck, '--out-dir', $PrecheckOutDir)
if ($dry.Code -ne 0) { Fail "precheck dry run failed: $($dry.Output)" }
Write-Host $dry.Output

if (-not $Execute) {
  Write-Host '[PILOT_SEQUENCE] INERT: no live step performed. Re-run with -Execute only under the combined operator approval.'
  Write-Host "[PILOT_SEQUENCE] Planned: precheck --live -> handoff -> (one bounded wait if needed) -> runner dry run -> handoff recheck -> runner --live -> --verify, into $PrecheckOutDir and $PilotOutDir."
  exit 0
}

# 2-3. Wallet, then Stage A (one attempt).
Assert-Wallet 'before Stage A'
$stageA = Invoke-Node @($Precheck, '--out-dir', $PrecheckOutDir, '--live')
Write-Host $stageA.Output
if ($stageA.Code -ne 0) { Fail "Stage A did not select a target (exit $($stageA.Code)); sequence ends, no retry" }

# 4. Handoff; one bounded wait at most.
$first = Invoke-Handoff @('--precheck-dir', $PrecheckOutDir, '--pilot-out-dir', $PilotOutDir)
Write-Host "[PILOT_SEQUENCE] Handoff: $($first.Raw)"
if ($first.Code -eq 2) {
  $wait = [int64]$first.Decision.waitMs
  if ($wait -lt 0 -or $wait -gt $MaxWaitMs) { Fail "wait out of bounds: $wait ms" }
  Write-Host "[PILOT_SEQUENCE] Single wait of $wait ms until the start window opens (planning estimate)."
  Start-Sleep -Milliseconds ($wait + 1000)
} elseif ($first.Code -ne 0) {
  Fail "handoff refused: $($first.Raw)"
}
$Pool = [string]$first.Decision.poolId
$Mint = [string]$first.Decision.mintAddress
if ($Pool -eq '' -or $Mint -eq '') { Fail 'handoff gave no identity' }

# 5. Stage B dry run with the exact sealed identity.
$dryB = Invoke-Node @($Runner, '--pool', $Pool, '--mint', $Mint, '--out-dir', $PilotOutDir)
if ($dryB.Code -ne 0) { Fail "Stage B dry run failed: $($dryB.Output)" }
Write-Host $dryB.Output

# 6. Recheck immediately before Stage B: must allow the identical identity.
$final = Invoke-Handoff @('--precheck-dir', $PrecheckOutDir, '--pilot-out-dir', $PilotOutDir)
Write-Host "[PILOT_SEQUENCE] Final handoff: $($final.Raw)"
if ($final.Code -ne 0) { Fail "final handoff refused: $($final.Raw)" }
if ([string]$final.Decision.poolId -ne $Pool -or [string]$final.Decision.mintAddress -ne $Mint) {
  Fail 'identity changed between handoff checks'
}

# 7. Stage B once, then verification.
$stageB = Invoke-Node @($Runner, '--pool', $Pool, '--mint', $Mint, '--out-dir', $PilotOutDir, '--live')
Write-Host $stageB.Output
$verify = Invoke-Node @($Runner, '--verify', $PilotOutDir)
Write-Host $verify.Output
Assert-Wallet 'after Stage B'
if ($stageB.Code -ne 0) { Fail "Stage B exited with $($stageB.Code)" }
if ($verify.Code -ne 0) { Fail 'Stage B integrity verification failed' }
Write-Host '[PILOT_SEQUENCE] Sequence complete (decision-only; no buy, no position). No rerun.'
exit 0
