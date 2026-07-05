param(
  [ValidateSet("Start", "Restart", "Status", "Logs")]
  [string]$Action = "Status",
  [string]$TaskName = "Hermes Local Worker",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $ProjectRoot "logs\hermes-local-worker.log"

function Write-WorkerStatus([string]$Message) {
  Write-Host "[Hermes Local Worker] $Message"
}

function Import-EnvPresence([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
      $name = $Matches[1]
      $value = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($name, "Process") -and $value) {
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
      }
    }
  }
}

function Assert-Prerequisites {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json"))) {
    throw "Project root is invalid: $ProjectRoot"
  }
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js is missing from PATH. Install Node.js, then open a new PowerShell window."
  }
  if (-not ((Get-Command npm.cmd -ErrorAction SilentlyContinue) -or (Get-Command npm -ErrorAction SilentlyContinue))) {
    throw "npm is missing from PATH. Install Node.js, then open a new PowerShell window."
  }

  Import-EnvPresence (Join-Path $ProjectRoot ".env.local")
  Import-EnvPresence (Join-Path $ProjectRoot ".env")
  $missing = @()
  if (-not $env:TURSO_DATABASE_URL) { $missing += "TURSO_DATABASE_URL" }
  if (-not $env:TURSO_AUTH_TOKEN) { $missing += "TURSO_AUTH_TOKEN" }
  if ($missing.Count -gt 0) {
    throw "Required worker configuration is missing: $($missing -join ', '). Values were not displayed."
  }
  Write-WorkerStatus "Node, npm, and required worker configuration are present."
  if (-not ($env:HERMES_WORKER_API_BASE_URL -or $env:NEXT_PUBLIC_APP_URL -or $env:VERCEL_URL)) {
    Write-WorkerStatus "Worker API target: documented production default https://www.parawi.com (set HERMES_WORKER_API_BASE_URL to override)."
  }
}

function Get-WorkerTask {
  return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-ValidatedWorkerProcess {
  $pidPath = Join-Path $ProjectRoot "logs\hermes-local-worker.pid"
  if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
  $workerPid = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
  if ($workerPid -notmatch '^\d+$') { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -match 'hermes-local-worker\.(ts|js)') { return $process }
  return $null
}

function Show-WorkerStatus {
  $task = Get-WorkerTask
  if (-not $task) {
    $fallback = Get-ValidatedWorkerProcess
    Write-WorkerStatus "Scheduled task '$TaskName' is not installed; Startup-folder fallback is in use."
    Write-WorkerStatus "State: $(if ($fallback) { 'Running' } else { 'Stopped' })"
    Write-WorkerStatus "Log: $LogPath"
    return [bool]$fallback
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-WorkerStatus "Scheduled task: installed"
  Write-WorkerStatus "State: $($task.State)"
  Write-WorkerStatus "Last result: $($info.LastTaskResult)"
  Write-WorkerStatus "Last run: $($info.LastRunTime)"
  Write-WorkerStatus "Next run: $($info.NextRunTime)"
  Write-WorkerStatus "Log: $LogPath"
  return $true
}

Set-Location -LiteralPath $ProjectRoot

if ($Action -eq "Logs") {
  if (Test-Path -LiteralPath $LogPath) {
    Write-WorkerStatus "Showing the latest worker log lines from $LogPath"
    Get-Content -LiteralPath $LogPath -Tail 100
  } else {
    Write-WorkerStatus "No worker log exists yet at $LogPath."
  }
  exit 0
}

Assert-Prerequisites
$installed = Show-WorkerStatus
if ($Action -eq "Status") { exit $(if ($installed) { 0 } else { 1 }) }
if (-not (Get-WorkerTask)) {
  $fallbackProcess = Get-ValidatedWorkerProcess
  if ($Action -eq "Restart" -and $fallbackProcess) {
    Stop-Process -Id $fallbackProcess.ProcessId
    Start-Sleep -Seconds 1
  } elseif ($Action -eq "Start" -and $fallbackProcess) {
    Write-WorkerStatus "Worker is already running; no duplicate was started."
    exit 0
  }
  $launcher = Join-Path $ProjectRoot "scripts\run-hermes-local-worker.cmd"
  Start-Process -FilePath $launcher -WorkingDirectory $ProjectRoot -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (-not (Get-ValidatedWorkerProcess)) { throw "Startup fallback launched, but no validated worker process appeared. Check npm run worker:logs." }
  Write-WorkerStatus "Worker started through the Startup-folder fallback launcher."
  Show-WorkerStatus | Out-Null
  exit 0
}

if ($Action -eq "Restart") {
  $task = Get-WorkerTask
  if ($task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 250
      $task = Get-WorkerTask
    } while ($task.State -eq "Running" -and (Get-Date) -lt $deadline)
    if ($task.State -eq "Running") { throw "Scheduled task did not stop within 20 seconds." }
  }
}

$task = Get-WorkerTask
if ($task.State -eq "Running") {
  Write-WorkerStatus "Worker is already running; no duplicate was started."
} else {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 1
  $task = Get-WorkerTask
  if ($task.State -ne "Running") { throw "Start was requested, but the scheduled task state is $($task.State). Check npm run worker:logs." }
  Write-WorkerStatus "Worker started through scheduled task '$TaskName'."
}
Show-WorkerStatus | Out-Null
