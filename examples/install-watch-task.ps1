# Registers a Windows scheduled task that runs `wake-grokbot watch --once` every 5 minutes.
# The wake URL and key must be in the user's environment variables (never in this script).
# Usage:  powershell -ExecutionPolicy Bypass -File install-watch-task.ps1 -Config <config file> [-Version 0.1.0] [-Minutes 5] [-Remove]
param(
  [string]$Config = "",
  [string]$Version = "0.1.0",
  [int]$Minutes = 5,
  [string]$TaskName = "wake-grokbot-watch",
  [switch]$Remove
)
$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed $TaskName"
  return
}

if (-not $Config) { throw "Pass -Config <path to wake-grokbot.json> (explicit config, no search)" }
$Config = (Resolve-Path $Config).Path
$cmd = Get-Command wake-grokbot -ErrorAction SilentlyContinue
if ($cmd) {
  # A global install is used only when it is exactly the pinned version; a different version is an error.
  $have = (& $cmd.Source --version 2>$null | Out-String).Trim()
  if ($have -ne $Version) {
    throw "global wake-grokbot is '$have', pinned version is $Version; install wake-grokbot@$Version or remove the global one"
  }
  $exe = $cmd.Source
  $watchArgs = "--config `"$Config`" watch --once"
} else {
  $exe = (Get-Command npx).Source
  $watchArgs = "--yes wake-grokbot@$Version --config `"$Config`" watch --once"
}

$action = New-ScheduledTaskAction -Execute $exe -Argument $watchArgs
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "wake-grokbot: deliver queued wakes" -Force | Out-Null
Write-Host "Registered $TaskName (every $Minutes min). Stop wakes any time with: setx WAKE_GROKBOT_DISABLED 1"
