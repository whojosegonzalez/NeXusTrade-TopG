param(
  [Parameter(Mandatory=$true)]
  [string]$ArchiveRoot
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NeXusTrade Formulation B Collection Run Inspector" -ForegroundColor Cyan
Write-Host " Archive: $ArchiveRoot" -ForegroundColor Cyan
Write-Host " Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC' -AsUTC)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Lock File Status & PID Liveness
$LockPath = Join-Path $ArchiveRoot "collection.lock"
if (Test-Path $LockPath) {
  $LockJson = Get-Content $LockPath -Raw | ConvertFrom-Json
  Write-Host "[STATUS] Active Lock Present: YES" -ForegroundColor Yellow
  Write-Host "  - PID: $($LockJson.pid)"
  Write-Host "  - Started At: $($LockJson.startedAt)"
  Write-Host "  - Protocol SHA: $($LockJson.protocolSha256.Substring(0,16))..."

  $IsRunning = Get-Process -Id $LockJson.pid -ErrorAction SilentlyContinue
  if ($IsRunning) {
    Write-Host "  - Process Liveness: RUNNING (CPU: $($IsRunning.CPU)s, WorkingSet: $([math]::Round($IsRunning.WorkingSet64/1MB,2)) MB)" -ForegroundColor Green
  } else {
    Write-Host "  - Process Liveness: NOT FOUND / TERMINATED" -ForegroundColor Red
  }
} else {
  Write-Host "[STATUS] Active Lock Present: NO (Run finalized or not started)" -ForegroundColor Green
}

# 2. Collected Units & Partition Breakdown
$UnitsPath = Join-Path $ArchiveRoot "units.v1.ndjson"
if (Test-Path $UnitsPath) {
  $Lines = Get-Content $UnitsPath | Where-Object { $_.Trim().Length -gt 0 }
  $UnitCount = $Lines.Count

  $DiscoveryCount = 0
  $ValidationCount = 0
  $DateGroups = @{}

  foreach ($Line in $Lines) {
    $Unit = $Line | ConvertFrom-Json
    if ($Unit.partition -eq "DISCOVERY") { $DiscoveryCount++ }
    elseif ($Unit.partition -eq "VALIDATION") { $ValidationCount++ }

    $Date = $Unit.anchorDate
    if (-not $DateGroups.ContainsKey($Date)) { $DateGroups[$Date] = 0 }
    $DateGroups[$Date]++
  }

  Write-Host "`n[PROGRESS] Collected Units: $UnitCount / 96 (Min Floor: 72)" -ForegroundColor White
  Write-Host "  - Discovery Units:  $DiscoveryCount (Target: ~48, Min: 32)"
  Write-Host "  - Validation Units: $ValidationCount (Target: ~48, Min: 32)"

  Write-Host "`n[DAILY CONCENTRATION] Distinct UTC Dates: $($DateGroups.Keys.Count) / 8" -ForegroundColor White
  foreach ($Date in ($DateGroups.Keys | Sort-Object)) {
    $Share = [math]::Round(($DateGroups[$Date] / $UnitCount) * 100, 2)
    $ShareColor = if ($Share -le 20.0) { "Green" } else { "Red" }
    Write-Host "  - $Date : $($DateGroups[$Date]) units ($Share% share)" -ForegroundColor $ShareColor
  }
} else {
  Write-Host "`n[PROGRESS] units.v1.ndjson: NOT FOUND (No units committed yet)" -ForegroundColor Yellow
}

# 3. Provider Call & Latency Ledger
$InvPath = Join-Path $ArchiveRoot "source-inventory.v1.json"
if (Test-Path $InvPath) {
  $Inv = Get-Content $InvPath -Raw | ConvertFrom-Json
  Write-Host "`n[PROVIDER ACTIVITY] Recorded Operations: $($Inv.sources.Count)" -ForegroundColor White
}

# 4. Tail Recent Log Entries
$LogPath = Join-Path $ArchiveRoot "collection.log"
if (Test-Path $LogPath) {
  Write-Host "`n[RECENT LOG TAIL (Last 5 lines)]" -ForegroundColor Gray
  Get-Content $LogPath -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Write-Host "`n============================================================" -ForegroundColor Cyan
