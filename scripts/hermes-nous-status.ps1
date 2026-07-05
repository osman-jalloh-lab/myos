$ErrorActionPreference = "Stop"
$TaskName = "Hermes Local Worker"

function Write-NousStatus([string]$Message) {
  Write-Host "[Hermes Nous] $Message"
}

$agent = Get-Command hermes-agent.exe -ErrorAction SilentlyContinue
$hermes = Get-Command hermes.exe -ErrorAction SilentlyContinue
if (-not $agent -or -not $hermes) {
  Write-NousStatus "Hermes Nous is missing. Expected the local Hermes Agent installation to provide hermes-agent.exe and hermes.exe."
  exit 1
}

$version = (& $hermes.Source --version 2>&1 | Select-Object -First 1)
Write-NousStatus "Installed: $version"
$statusText = (& $hermes.Source status 2>&1 | Out-String)
$authReady = $statusText -match "Nous Portal\s+.*logged in"
$modelReady = $statusText -match "Model:\s+\S+" -and $statusText -match "Provider:\s+Nous Portal"

if ($authReady) { Write-NousStatus "Authentication: ready" } else { Write-NousStatus "Hermes Nous needs login." }
if ($modelReady) { Write-NousStatus "Model: ready" } else { Write-NousStatus "Hermes Nous needs a model." }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidPath = Join-Path $repoRoot "logs\hermes-local-worker.pid"
$workerRunning = $task -and $task.State -eq "Running"
if (-not $workerRunning -and (Test-Path -LiteralPath $pidPath)) {
  $workerPid = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
  if ($workerPid -match '^\d+$') {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
    $workerRunning = [bool]($process -and $process.CommandLine -match 'hermes-local-worker\.(ts|js)')
  }
}
if (-not $workerRunning) {
  Write-NousStatus "Start Local Worker first. Hermes Nous is command-based, not a separate daemon."
} else {
  Write-NousStatus "Local Worker: running"
}
Write-NousStatus "Invocation: the Local Worker launches 'hermes --oneshot' for queued Hermes Nous tasks."

if ($authReady -and $modelReady -and $workerRunning) { exit 0 }
exit 1
