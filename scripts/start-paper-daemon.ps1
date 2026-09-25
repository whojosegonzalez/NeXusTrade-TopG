[CmdletBinding()]
param(
  [double]$DurationHours = 6.0,
  [int]$MaxPositions = 3,
  [double]$PositionSizeSol = 1.0,
  [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".tmp")) {
  New-Item -ItemType Directory -Path ".tmp" | Out-Null
}

if ([string]::IsNullOrWhiteSpace($SessionId)) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $SessionId = "session-paper-$timestamp"
}

$logFile = ".tmp/paper-daemon-$SessionId.log"
$pidFile = ".tmp/paper-daemon.pid"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  NeXusTrade Phase 11: Autonomous Paper Trading Daemon" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " Session ID:         $SessionId" -ForegroundColor Yellow
Write-Host " Duration:           $DurationHours hours"
Write-Host " Max Positions:      $MaxPositions"
Write-Host " Position Size:      $PositionSizeSol SOL"
Write-Host " Log File:           $logFile"
Write-Host "----------------------------------------------------------------"

$cmd = "pnpm trading:paper-daemon --session-id=$SessionId --duration-hours=$DurationHours --max-positions=$MaxPositions --position-size-sol=$PositionSizeSol"

$proc = Start-Process powershell.exe -ArgumentList "-NoProfile -Command $cmd > $logFile 2>&1" -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii

Write-Host "[SUCCESS] Paper trading daemon started in background with PID $($proc.Id)." -ForegroundColor Green
Write-Host ""
Write-Host "To monitor session progress:" -ForegroundColor Yellow
Write-Host "  .\scripts\inspect-paper-session.ps1"
Write-Host ""
Write-Host "To stop session:" -ForegroundColor Yellow
Write-Host "  .\scripts\stop-paper-session.ps1"
Write-Host "================================================================" -ForegroundColor Cyan
