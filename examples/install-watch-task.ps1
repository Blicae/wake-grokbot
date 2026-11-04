# Registers a Windows scheduled task that runs `wake-grokbot watch --once` every 5 minutes.
# The wake URL and key must be in the user's environment variables (never in this script).
# Usage:  powershell -ExecutionPolicy Bypass -File install-watch-task.ps1 [-Minutes 5] [-Remove]
param(
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

$cmd = Get-Command wake-grokbot -ErrorAction SilentlyContinue
if ($cmd) {
  $exe = $cmd.Source
  $watchArgs = "watch --once"
} else {
  $exe = (Get-Command npx).Source
  $watchArgs = "--yes wake-grokbot watch --once"
}

$action = New-ScheduledTaskAction -Execute $exe -Argument $watchArgs
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "wake-grokbot: deliver queued wakes" -Force | Out-Null
Write-Host "Registered $TaskName (every $Minutes min). Stop wakes any time with: setx WAKE_GROKBOT_DISABLED 1"
