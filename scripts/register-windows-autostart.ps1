[CmdletBinding()]
param(
  [string]$TaskName = "Auto-Doc MCP Self-Hosted Stack"
)

$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "start-self-hosted.ps1"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Startup launcher not found: $launcher"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Starts Docker Desktop and the Auto-Doc self-hosted profile, including Cloudflare Tunnel." `
  -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' for user $env:USERNAME."
Write-Output "Run it now with: Start-ScheduledTask -TaskName '$TaskName'"
