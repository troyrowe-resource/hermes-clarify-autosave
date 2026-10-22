<#
.SYNOPSIS
  Stop the Hermes clarify-autosave candidate and the background gateway it started.

.DESCRIPTION
  The Desktop app attaches to a detached gateway daemon (hermes gateway run) and never stops it, so closing the
  window leaves that daemon running. This closes the candidate's windows, asks the packaged CLI to stop the
  sandbox's gateway, then ends any process whose image still lies inside THIS package's app folder. Processes
  elsewhere (an installed Hermes, its gateway, its updater) are never matched.

.PARAMETER Root
  Sandbox root used when starting. Default: %LOCALAPPDATA%\HermesClarifyCandidate.
#>
[CmdletBinding()]
param(
    [string]$Root = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'CandidateCommon.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
if (-not $Root) {
    if (-not $env:LOCALAPPDATA) { Stop-Refused 2 'LOCALAPPDATA is not set; pass -Root.' }
    $Root = Join-Path $env:LOCALAPPDATA 'HermesClarifyCandidate'
}
$safe = Assert-SafeSandbox $Root
$package = Get-CandidatePackage -PackageRoot $packageRoot -SkipHashCheck
$appDirectory = Split-Path -Parent $package.Exe
$childEnvironment = Get-CandidateEnvironment -Layout $safe.Layout -Commit ([string]$package.Manifest.source.commit)

$before = @(Get-CandidateProcesses $appDirectory)
Write-Output ('Candidate processes running: ' + $before.Count)

foreach ($row in $before) {
    $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
}
Start-Sleep -Seconds 3

# The shipped CLI stops the gateway the way Hermes itself does (control pipe, lock, state), for THIS sandbox's home.
$cli = Join-Path (Join-Path $appDirectory 'resources\agent-payload') ([string]$package.Manifest.app.stamp.runtime.commands.hermes -replace '/', '\')
if (Test-Path -LiteralPath $cli) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $cli
    $startInfo.Arguments = 'gateway stop'
    $startInfo.WorkingDirectory = $safe.Layout.temp
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables.Clear()
    foreach ($name in $childEnvironment.Keys) { $startInfo.EnvironmentVariables[$name] = $childEnvironment[$name] }
    $stopper = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $stopper.WaitForExit(45000)) { $stopper.Kill() }
    Write-Output ('gateway stop exited with ' + $stopper.ExitCode)
}

$remaining = @(Get-CandidateProcesses $appDirectory)
foreach ($row in $remaining) {
    Stop-Process -Id $row.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
$left = @(Get-CandidateProcesses $appDirectory)
Write-Output ('Force-stopped: ' + $remaining.Count + '; still running: ' + $left.Count)
if ($left.Count -gt 0) { exit 1 }
exit 0
