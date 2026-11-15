<#
.SYNOPSIS
  NeXusTrade - sequence core of scripts/paper-pilot-sequence.ps1 (dot-sourced; defines functions only).

.DESCRIPTION
  Invoke-PilotSequence runs the conditional discovery -> handoff -> Stage B sequence against injected
  hooks, so the orchestration is tested offline with stubbed children, waits, wallet hashes and
  paths. The entry script supplies the real hooks (node + tsx, Start-Sleep, Get-FileHash,
  Test-Path, Write-Host). Every child runs at most once; nothing is retried, substituted or polled.

  Discovery is exactly one of:
    PRECHECK  the reviewed one-shot Stage A precheck (unchanged sequence), or
    WATCH     the bounded creation-watch entry point; only its confirmed-success exit (0) permits
              the watched handoff, and nothing falls back to the precheck or repeats discovery.

  Identity (pool, mint) and, in WATCH mode, the sealed manifest digest come only from the
  handoff's structured JSON decision, whose exit code must match the decision. Human-readable
  child output is never parsed for identity.
#>

Set-StrictMode -Version 2.0

$script:PilotSequenceRefused = '[PILOT_SEQUENCE_REFUSED]'
$script:PilotSequenceCancelled = '[PILOT_SEQUENCE_CANCELLED]'

function Get-PilotJsonProperty([object]$Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Test-PilotInteger([object]$Value) {
  return ($Value -is [int] -or $Value -is [long]) -and -not ($Value -is [bool])
}

<#
  Validates one handoff invocation result. Exactly one non-empty output line holding a JSON object;
  the decision and its exit code must agree (PIN_OK 0, ALLOWED 0, WAIT 2, REFUSED 1). For ALLOWED and
  WAIT the identity must be two distinct base58 addresses, the pilot directory the requested one,
  and in WATCH mode the evidence source and a 64-hex manifest digest must be present. Anything else
  throws a refusal.
#>
function ConvertFrom-PilotHandoffResult {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Result,
    [Parameter(Mandatory = $true)][ValidateSet('PIN', 'DECISION')][string]$Expect,
    [string]$Mode = 'PRECHECK',
    [string]$PilotOutDir = ''
  )
  $bad = { param($why) throw "$script:PilotSequenceRefused malformed or inconsistent handoff output ($why; exit $($Result.Code))" }
  $lines = @(([string]$Result.Output) -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -ne 1) { & $bad "expected exactly one JSON line, got $($lines.Count)" }
  $raw = $lines[0].Trim()
  if (-not $raw.StartsWith('{')) { & $bad 'not a JSON object' }
  try { $d = $raw | ConvertFrom-Json } catch { & $bad 'not JSON' }
  $decision = Get-PilotJsonProperty $d 'decision'
  if (-not ($decision -is [string])) { & $bad 'no decision' }
  # Read directly: returning an array from a function would unroll it.
  $refusalsProperty = $d.PSObject.Properties['refusals']
  if ($null -eq $refusalsProperty -or -not ($refusalsProperty.Value -is [System.Array])) { & $bad 'no refusals list' }
  $refusals = @($refusalsProperty.Value)
  $expectedCode = @{ 'PIN_OK' = 0; 'ALLOWED' = 0; 'REFUSED' = 1; 'WAIT' = 2 }
  if (-not $expectedCode.ContainsKey($decision)) { & $bad "unknown decision $decision" }
  if ($Result.Code -ne $expectedCode[$decision]) { & $bad "decision $decision does not match its exit code" }
  if ($Expect -eq 'PIN' -and $decision -ne 'PIN_OK' -and $decision -ne 'REFUSED') { & $bad "decision $decision for a pin check" }
  if ($Expect -eq 'DECISION' -and $decision -eq 'PIN_OK') { & $bad 'pin decision for a handoff check' }
  if ($decision -eq 'REFUSED') {
    if ($refusals.Count -lt 1) { & $bad 'refusal without reasons' }
    return @{ Decision = 'REFUSED'; Refusals = $refusals; Raw = $raw }
  }
  if ($decision -eq 'PIN_OK') {
    if ($refusals.Count -ne 0) { & $bad 'PIN_OK with refusals' }
    return @{ Decision = 'PIN_OK'; Refusals = @(); Raw = $raw }
  }
  $pool = Get-PilotJsonProperty $d 'poolId'
  $mint = Get-PilotJsonProperty $d 'mintAddress'
  $base58 = '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  if (-not ($pool -is [string]) -or $pool -notmatch $base58) { & $bad 'pool is not a base58 address' }
  if (-not ($mint -is [string]) -or $mint -notmatch $base58) { & $bad 'mint is not a base58 address' }
  if ($pool -ceq $mint) { & $bad 'pool equals mint' }
  if ((Get-PilotJsonProperty $d 'pilotOutDir') -cne $PilotOutDir) { & $bad 'pilot directory differs from the requested one' }
  $source = Get-PilotJsonProperty $d 'evidenceSource'
  $manifest = Get-PilotJsonProperty $d 'manifestSha256'
  if ($Mode -eq 'WATCH') {
    if ($source -cne 'WATCH_EVIDENCE') { & $bad 'evidence source is not WATCH_EVIDENCE' }
    if (-not ($manifest -is [string]) -or $manifest -cnotmatch '^[0-9a-f]{64}$') { & $bad 'no sealed manifest digest' }
  } elseif ($null -ne $source -or $null -ne $manifest) {
    & $bad 'watch fields in a precheck decision'
  }
  $waitMs = $null
  if ($decision -eq 'ALLOWED') {
    if ($refusals.Count -ne 0) { & $bad 'ALLOWED with refusals' }
  } else {
    if ($refusals.Count -ne 1 -or $refusals[0] -cne 'START_WINDOW_NOT_YET_OPEN') { & $bad 'WAIT without its single reason' }
    $waitMs = Get-PilotJsonProperty $d 'waitMs'
    if (-not (Test-PilotInteger $waitMs) -or $waitMs -lt 1 -or $waitMs -gt 240000) { & $bad 'wait outside 1..240000 ms' }
  }
  return @{
    Decision = $decision; Refusals = @(); Raw = $raw; PoolId = $pool; MintAddress = $mint
    ManifestSha256 = $manifest; WaitMs = $waitMs
  }
}

<#
  Config keys: Mode ('PRECHECK'|'WATCH'), PinnedCommit, EvidenceOutDir, PilotOutDir, Execute (bool),
  WalletSha256, Scripts (hashtable: Handoff, Precheck, Watch, Runner).
  Hooks: RunChild { param($Step, [string[]]$Arguments) -> @{ Code; Output } }, Wait { param([long]$Ms) },
  WalletHash { -> string }, PathExists { param($Path) -> bool }, IsCancelled { -> bool },
  Log { param($Line) }.
  Returns @{ Outcome = INERT|COMPLETE|STOPPED|CANCELLED; Failure; CheckFailures; PoolId; MintAddress;
  ManifestSha256; Steps }. A refusal or failure never throws out of this function; a pipeline stop
  (operator Ctrl+C) still runs the final checks in the finally block.
#>
function Invoke-PilotSequence {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Config,
    [Parameter(Mandatory = $true)][hashtable]$Hooks
  )
  $mode = [string]$Config.Mode
  if ($mode -ne 'PRECHECK' -and $mode -ne 'WATCH') { throw "$script:PilotSequenceRefused unknown mode $mode" }
  $s = $Config.Scripts
  $evidence = [string]$Config.EvidenceOutDir
  $pilot = [string]$Config.PilotOutDir
  $state = @{
    Outcome = $null; Failure = $null; CheckFailures = New-Object System.Collections.ArrayList
    Step = 'START'; LiveStarted = $false; AcquisitionRan = $false; StageBRan = $false
    FinalChecksDone = $false
    PoolId = $null; MintAddress = $null; ManifestSha256 = $null
    Steps = New-Object System.Collections.ArrayList
  }
  $log = { param($line) & $Hooks.Log "[PILOT_SEQUENCE] $line" }
  $refuse = { param($why) throw "$script:PilotSequenceRefused $why" }
  $checkCancel = {
    param($where)
    if (& $Hooks.IsCancelled) { throw "$script:PilotSequenceCancelled cancelled $where" }
  }
  $run = {
    param($step, [string[]]$arguments)
    $state.Step = $step
    [void]$state.Steps.Add($step)
    $r = & $Hooks.RunChild $step $arguments
    if ($null -eq $r -or -not ($r -is [hashtable]) -or -not (Test-PilotInteger $r.Code)) {
      & $refuse "child $step returned no exit code"
    }
    return $r
  }
  $handoffArgs = {
    $a = @($s.Handoff, '--pinned-commit', $Config.PinnedCommit)
    if ($mode -eq 'WATCH') { $a += @('--watch-evidence-dir', $evidence) } else { $a += @('--precheck-dir', $evidence) }
    return , ($a + @('--pilot-out-dir', $pilot))
  }
  $discovery = if ($mode -eq 'WATCH') { $s.Watch } else { $s.Precheck }

  try {
    # 1. Pin (offline).
    $pin = ConvertFrom-PilotHandoffResult -Result (& $run 'PIN' @($s.Handoff, '--pinned-commit', $Config.PinnedCommit, '--pin-only')) -Expect 'PIN'
    if ($pin.Decision -ne 'PIN_OK') { & $refuse "pin check: $($pin.Raw)" }
    & $log "Pin OK: $($Config.PinnedCommit)"
    if (& $Hooks.PathExists $evidence) { & $refuse "evidence directory exists: $evidence" }
    if (& $Hooks.PathExists $pilot) { & $refuse "pilot directory exists: $pilot" }

    # Discovery dry run (offline: no configuration, no transport, no request, nothing written).
    $dry = & $run 'DISCOVERY_DRY_RUN' @($discovery, '--out-dir', $evidence)
    if ($dry.Code -ne 0) { & $refuse "$mode dry run failed (exit $($dry.Code))" }
    & $Hooks.Log $dry.Output

    if (-not $Config.Execute) {
      & $log 'INERT: no live step performed. Re-run with -Execute only under the combined operator approval.'
      if ($mode -eq 'WATCH') {
        & $log "Planned: watch --live (one bounded watch; validation; sealing) -> watched handoff -> (one bounded wait if needed) -> runner dry run -> watched handoff recheck (same manifest, pool and mint) -> runner --live -> --verify, into $evidence and $pilot."
      } else {
        & $log "Planned: precheck --live -> handoff -> (one bounded wait if needed) -> runner dry run -> handoff recheck -> runner --live -> --verify, into $evidence and $pilot."
      }
      $state.Outcome = 'INERT'
    } else {
      # 2. Wallet, then discovery (one attempt; no fallback, no repetition).
      $state.LiveStarted = $true
      $state.Step = 'WALLET_BEFORE'
      if ((& $Hooks.WalletHash) -ne $Config.WalletSha256) { & $refuse 'wallet hash changed (before discovery)' }
      & $log 'Wallet hash unchanged (before discovery).'
      & $checkCancel 'before discovery'
      $state.AcquisitionRan = $true
      $acq = & $run 'DISCOVERY_LIVE' @($discovery, '--out-dir', $evidence, '--live')
      & $Hooks.Log $acq.Output
      if ($acq.Code -ne 0) {
        & $refuse "$mode did not confirm a selected target (exit $($acq.Code)); sequence ends, no fallback, no retry"
      }

      # 3. Handoff; one bounded wait at most.
      & $checkCancel 'before the handoff'
      $first = ConvertFrom-PilotHandoffResult -Result (& $run 'HANDOFF_FIRST' (& $handoffArgs)) -Expect 'DECISION' -Mode $mode -PilotOutDir $pilot
      & $log "Handoff: $($first.Raw)"
      if ($first.Decision -eq 'REFUSED') { & $refuse "handoff refused: $($first.Raw)" }
      $state.PoolId = $first.PoolId
      $state.MintAddress = $first.MintAddress
      $state.ManifestSha256 = $first.ManifestSha256
      if ($first.Decision -eq 'WAIT') {
        & $checkCancel 'before the wait'
        $state.Step = 'WAIT'
        [void]$state.Steps.Add('WAIT')
        & $log "Single wait of $($first.WaitMs) ms until the start window opens (planning estimate)."
        & $Hooks.Wait ([long]$first.WaitMs + 1000)
        & $checkCancel 'during the wait'
      }

      # 4. Stage B dry run with the exact handed-off identity.
      & $checkCancel 'before the Stage B dry run'
      $dryB = & $run 'STAGE_B_DRY_RUN' @($s.Runner, '--pool', $state.PoolId, '--mint', $state.MintAddress, '--out-dir', $pilot)
      if ($dryB.Code -ne 0) { & $refuse "Stage B dry run failed (exit $($dryB.Code))" }
      & $Hooks.Log $dryB.Output

      # 5. Final handoff immediately before Stage B: pin, evidence and window rechecked; it must allow
      #    the identical pool and mint (and, for watch evidence, the identical sealed manifest).
      & $checkCancel 'before the final handoff'
      $final = ConvertFrom-PilotHandoffResult -Result (& $run 'HANDOFF_FINAL' (& $handoffArgs)) -Expect 'DECISION' -Mode $mode -PilotOutDir $pilot
      & $log "Final handoff: $($final.Raw)"
      if ($final.Decision -ne 'ALLOWED') { & $refuse "final handoff did not allow Stage B: $($final.Raw)" }
      if ($final.PoolId -cne $state.PoolId -or $final.MintAddress -cne $state.MintAddress) {
        & $refuse 'identity changed between handoff checks'
      }
      if ($mode -eq 'WATCH' -and $final.ManifestSha256 -cne $state.ManifestSha256) {
        & $refuse 'sealed watch manifest changed between handoff checks'
      }

      # 6. Stage B once.
      & $checkCancel 'before Stage B'
      $state.StageBRan = $true
      $stageB = & $run 'STAGE_B_LIVE' @($s.Runner, '--pool', $state.PoolId, '--mint', $state.MintAddress, '--out-dir', $pilot, '--live')
      & $Hooks.Log $stageB.Output
      if ($stageB.Code -ne 0) { & $refuse "Stage B exited with $($stageB.Code)" }
      $state.Outcome = 'COMPLETE'
    }
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception -is [System.Management.Automation.PipelineStoppedException] -or
        $_.Exception -is [System.OperationCanceledException] -or
        $message.StartsWith($script:PilotSequenceCancelled)) {
      $state.Outcome = 'CANCELLED'
      $state.Failure = if ($message.StartsWith($script:PilotSequenceCancelled)) { $message } else { "$script:PilotSequenceCancelled interrupted during $($state.Step)" }
    } else {
      $state.Outcome = 'STOPPED'
      $state.Failure = if ($message.StartsWith($script:PilotSequenceRefused)) { $message } else { "$script:PilotSequenceRefused $($state.Step) failed: $message" }
    }
  } finally {
    if ($null -eq $state.Outcome) {
      # A pipeline stop (operator Ctrl+C) bypasses catch: record it before the final checks.
      $state.Outcome = 'CANCELLED'
      $state.Failure = "$script:PilotSequenceCancelled interrupted during $($state.Step)"
    }
    # The final checks and the summary run on every path, including a pipeline stop (operator
    # Ctrl+C) in which this function never returns. A pipeline stop skips every catch block, so
    # nothing here can swallow it: once this block ends, the stop keeps propagating.
    $state.FinalChecksDone = $false
    try {
      if ($state.LiveStarted) {
        # Final offline checks on every path once a live step may have run; their failures never
        # replace the original failure. Nothing here is live.
        $finalCheck = {
          param($label, $action)
          try { & $action } catch { [void]$state.CheckFailures.Add("$label could not run: $($_.Exception.Message)") }
        }
        if ($state.StageBRan) {
          & $finalCheck 'Stage B verification' {
            [void]$state.Steps.Add('STAGE_B_VERIFY')
            $v = & $Hooks.RunChild 'STAGE_B_VERIFY' @($s.Runner, '--verify', $pilot)
            & $Hooks.Log $v.Output
            if ($v.Code -ne 0) { [void]$state.CheckFailures.Add("Stage B integrity verification failed (exit $($v.Code))") }
          }
        }
        if ($mode -eq 'WATCH' -and $state.AcquisitionRan) {
          & $finalCheck 'Watch evidence verification' {
            [void]$state.Steps.Add('WATCH_VERIFY')
            $v = & $Hooks.RunChild 'WATCH_VERIFY' @($s.Watch, '--verify', $evidence)
            & $Hooks.Log $v.Output
            # 0 confirmed, 3 integrity holds but not confirmed; anything else is an integrity failure.
            if ($v.Code -ne 0 -and $v.Code -ne 3) { [void]$state.CheckFailures.Add("watch evidence integrity verification failed (exit $($v.Code))") }
          }
        }
        & $finalCheck 'Wallet check' {
          [void]$state.Steps.Add('WALLET_AFTER')
          if ((& $Hooks.WalletHash) -ne $Config.WalletSha256) { [void]$state.CheckFailures.Add('wallet hash changed (final check)') }
        }
      }
      $state.FinalChecksDone = $true
    } finally {
      if ($state.LiveStarted -and -not $state.FinalChecksDone) {
        [void]$state.CheckFailures.Add('final checks interrupted before they finished')
        if ($state.Outcome -eq 'COMPLETE') {
          $state.Outcome = 'CANCELLED'
          $state.Failure = "$script:PilotSequenceCancelled interrupted during the final checks"
        }
      }
      if ($state.Outcome -eq 'COMPLETE' -and $state.CheckFailures.Count -gt 0) {
        $state.Outcome = 'STOPPED'
        $state.Failure = "$script:PilotSequenceRefused final check failed: $($state.CheckFailures[0])"
      }
      # The one summary (the entry script prints none): the outcome, the original failure, then
      # each secondary final-check failure on its own line.
      foreach ($line in @(
          "Outcome: $($state.Outcome)"
          $(if ($state.Failure) { [string]$state.Failure })
          @($state.CheckFailures | ForEach-Object { "Final check failure: $_" })
        )) {
        if ($line) {
          try { & $log $line } catch { }
        }
      }
    }
  }
  return @{
    Outcome = $state.Outcome; Failure = $state.Failure; CheckFailures = @($state.CheckFailures)
    PoolId = $state.PoolId; MintAddress = $state.MintAddress; ManifestSha256 = $state.ManifestSha256
    Steps = @($state.Steps)
  }
}
