[CmdletBinding()]
param(
  [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"
$pidFile = ".tmp/paper-daemon.pid"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  NeXusTrade Paper Trading Daemon: Session Inspection" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$running = $false
$pidVal = $null

if (Test-Path $pidFile) {
  $pidVal = Get-Content $pidFile -Raw
  $pidVal = $pidVal.Trim()
  if ($pidVal -match '^\d+$') {
    $proc = Get-Process -Id ([int]$pidVal) -ErrorAction SilentlyContinue
    if ($proc) {
      $running = $true
      Write-Host " Daemon Process:     RUNNING (PID: $pidVal)" -ForegroundColor Green
    } else {
      Write-Host " Daemon Process:     STOPPED / EXITED (Last PID: $pidVal)" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host " Daemon Process:     NO ACTIVE PID FILE FOUND" -ForegroundColor Yellow
}

$activeJson = ".tmp/paper-session-active.json"
if (Test-Path $activeJson) {
  try {
    $state = Get-Content $activeJson -Raw | ConvertFrom-Json
    Write-Host "----------------------------------------------------------------"
    Write-Host " Live Session Telemetry:" -ForegroundColor Cyan
    Write-Host " Status:             $($state.status)"
    Write-Host " Portfolio Value:    $([math]::Round($state.currentPortfolioSol, 4)) SOL (Initial: $($state.initialPortfolioSol) SOL)"
    Write-Host " Realized P/L:       $([math]::Round($state.totalRealizedPnlSol, 4)) SOL"
    Write-Host " Unrealized P/L:     $([math]::Round($state.totalUnrealizedPnlSol, 4)) SOL"
    Write-Host " Open Positions:     $($state.openPositions.Count)"
    Write-Host " Closed Trades:      $($state.closedTrades.Count)"
    if ($state.openPositions.Count -gt 0) {
      Write-Host " Active Positions:" -ForegroundColor Yellow
      $state.openPositions | ForEach-Object {
        $pnlPct = [math]::Round(($_.currentPnlBps / 100.0), 2)
        Write-Host "  - Mint: $($_.mintAddress) | Spot: $($_.spotPriceSol) | PnL: $pnlPct% | Tier: $($_.ratchetState.activeTier)"
      }
    }
  } catch {}
}

$logFiles = Get-ChildItem -Path ".tmp" -Filter "paper-daemon-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending

if ($logFiles.Count -gt 0) {
  $targetLog = $logFiles[0].FullName
  Write-Host " Latest Log:         $targetLog"
  Write-Host " Last Updated:       $($logFiles[0].LastWriteTime)"
  Write-Host "----------------------------------------------------------------"
  Write-Host " Recent Output (Last 20 lines):" -ForegroundColor Cyan
  Get-Content -Path $targetLog -Tail 20 | ForEach-Object { Write-Host "   $_" }
} else {
  Write-Host " No log files found in .tmp/" -ForegroundColor Yellow
}

Write-Host "================================================================" -ForegroundColor Cyan
