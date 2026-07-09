param(
  [switch]$Uninstall,
  [string]$TaskName = "Hermes Ollama Runtime"
)

$ErrorActionPreference = "Stop"

function Write-Status($Message) {
  Write-Host "[Hermes Ollama Runtime] $Message"
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

$ollamaCommand = Get-Command ollama.exe -ErrorAction SilentlyContinue
if (-not $ollamaCommand) {
  $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
}
if (-not $ollamaCommand) {
  throw "Ollama was not found on PATH. Install Ollama or add it to PATH before installing the startup task."
}

$ollama = $ollamaCommand.Source
$action = New-ScheduledTaskAction -Execute $ollama -Argument "serve"
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
    -Description "Starts Ollama at Windows logon so Hermes Council local-provider features can use qwen3:4b." `
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
  $shortcut.TargetPath = $ollama
  $shortcut.Arguments = "serve"
  $shortcut.WorkingDirectory = Split-Path -Parent $ollama
  $shortcut.WindowStyle = 7
  $shortcut.Description = "Starts Ollama at Windows logon for Hermes OS."
  $shortcut.Save()

  Write-Status "Installed startup shortcut '$startupShortcut'."
}

Write-Status "Command: $ollama serve"
