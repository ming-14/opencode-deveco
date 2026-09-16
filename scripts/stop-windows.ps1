# Stop the opencode-deveco proxy on Windows.
#
# The supervisor goes first: it restarts its child on exit, so killing only the
# proxy on the port would see it come back a second later.

param(
  [int]$Port = 17128
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ProjectRoot "proxy-daemon.pid"

$stopped = $false

if (Test-Path $PidFile) {
  $daemonPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($daemonPid -match '^\d+$') {
    $proc = Get-Process -Id ([int]$daemonPid) -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $proc.Id -Force
      Write-Host "Stopped supervisor (PID $($proc.Id))."
      $stopped = $true
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $procId = $conn.OwningProcess | Select-Object -First 1
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped proxy (PID $procId) on port $Port."
  $stopped = $true
}

if (-not $stopped) {
  Write-Host "Nothing to stop (no supervisor pid file, nothing listening on port $Port)."
}