[CmdletBinding()]
param(
  [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"
$pidFile = ".tmp/paper-daemon.pid"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  NeXusTrade Paper Trading Daemon: Stopping Session" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

if (Test-Path $pidFile) {
  $pidVal = Get-Content $pidFile -Raw
  $pidVal = $pidVal.Trim()
  if ($pidVal -match '^\d+$') {
    $proc = Get-Process -Id [int]$pidVal -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id [int]$pidVal -Force
      Write-Host "[SUCCESS] Terminated paper daemon process (PID: $pidVal)." -ForegroundColor Green
    } else {
      Write-Host "[INFO] Process PID $pidVal was not running." -ForegroundColor Yellow
    }
  }
  Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "[INFO] No active pid file found." -ForegroundColor Yellow
}

Write-Host "================================================================" -ForegroundColor Cyan
