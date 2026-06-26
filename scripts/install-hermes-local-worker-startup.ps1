param(
  [switch]$Uninstall,
  [string]$TaskName = "Hermes Local Worker",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Write-Status($Message) {
  Write-Host "[Hermes Local Worker] $Message"
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Status "Removed scheduled task '$TaskName'."
  } else {
    Write-Status "No scheduled task named '$TaskName' was found."
  }
  exit 0
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npm) {
  $npm = (Get-Command npm -ErrorAction SilentlyContinue)?.Source
}
if (-not $npm) {
  throw "npm was not found on PATH. Install Node.js or add npm to PATH before installing the worker startup task."
}

$workerScript = Join-Path $ProjectRoot "scripts\hermes-local-worker.ts"
if (-not (Test-Path $workerScript)) {
  throw "Could not find scripts\hermes-local-worker.ts under $ProjectRoot."
}

$action = New-ScheduledTaskAction `
  -Execute $npm `
  -Argument "run worker:local" `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DisallowStartIfOnBatteries:$false `
  -ExecutionTimeLimit (New-TimeSpan -Days 30) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Starts Hermes Local Worker at Windows logon so Mission Control can claim local_worker tasks." `
  -Force | Out-Null

Write-Status "Installed scheduled task '$TaskName'."
Write-Status "Project root: $ProjectRoot"
Write-Status "Command: npm run worker:local"
