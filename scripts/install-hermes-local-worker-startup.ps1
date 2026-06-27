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
  $startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "$TaskName.lnk"
  if (Test-Path $startupShortcut) {
    Remove-Item -LiteralPath $startupShortcut -Force
    Write-Status "Removed startup shortcut '$startupShortcut'."
  }
  exit 0
}

$npm = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCommand) {
  $npm = $npmCommand.Source
} else {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCommand) {
    $npm = $npmCommand.Source
  }
}
if (-not $npm) {
  throw "npm was not found on PATH. Install Node.js or add npm to PATH before installing the worker startup task."
}

$workerScript = Join-Path $ProjectRoot "scripts\hermes-local-worker.ts"
if (-not (Test-Path $workerScript)) {
  throw "Could not find scripts\hermes-local-worker.ts under $ProjectRoot."
}

$launcherScript = Join-Path $ProjectRoot "scripts\run-hermes-local-worker.cmd"
if (-not (Test-Path $launcherScript)) {
  throw "Could not find scripts\run-hermes-local-worker.cmd under $ProjectRoot."
}

$action = New-ScheduledTaskAction `
  -Execute $launcherScript `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 30) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Starts Hermes Local Worker at Windows logon so Mission Control can claim local_worker tasks." `
    -Force `
    -ErrorAction Stop | Out-Null

  Write-Status "Installed scheduled task '$TaskName'."
} catch {
  Write-Status "Task Scheduler registration failed: $($_.Exception.Message)"
  Write-Status "Creating current-user Startup shortcut fallback."

  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not (Test-Path $startupDir)) {
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
  }
  $startupShortcut = Join-Path $startupDir "$TaskName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($startupShortcut)
  $shortcut.TargetPath = $launcherScript
  $shortcut.Arguments = ""
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Starts Hermes Local Worker at Windows logon."
  $shortcut.Save()

  Write-Status "Installed startup shortcut '$startupShortcut'."
}
Write-Status "Project root: $ProjectRoot"
Write-Status "Command: $launcherScript"
