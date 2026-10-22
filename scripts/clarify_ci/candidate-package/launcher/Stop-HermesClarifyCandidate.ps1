<#
.SYNOPSIS
  Stop the Hermes clarify-autosave candidate and the background gateway it started.

.DESCRIPTION
  The Desktop app attaches to a detached gateway daemon (hermes gateway run) and never stops it, so closing the
  window leaves that daemon running. This closes the candidate's windows, asks the packaged CLI to stop the
  sandbox's gateway, then ends every process whose image lies inside THIS package's app folder. Processes
  elsewhere (an installed Hermes, its gateway, its updater, an unrelated program that merely shares a file name)
  are never matched.

  Stopping is never refused and never waits on anyone. The gateway request is a courtesy: it is told --yes and reads
  its input from NUL, empty and already ended (so it cannot prompt), is cut off after -GatewayStopTimeoutSeconds,
  and any failure of it is reported and ignored; the sweep always runs. It works after a start without the
  launcher too (no sandbox has to exist).
  Exit code 1 only when a process of this package is still running afterwards, or the processes could not be
  listed; otherwise 0.

.PARAMETER Root
  Sandbox root used when starting. Default: %LOCALAPPDATA%\HermesClarifyCandidate.

.PARAMETER GatewayStopTimeoutSeconds
  How long to wait for `hermes gateway stop` before ending it. Default 45.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [int]$GatewayStopTimeoutSeconds = 45
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'CandidateCommon.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
$appDirectory = Get-PackageAppDirectory $packageRoot
$manifest = $null
try {
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $packageRoot 'MANIFEST.json') | ConvertFrom-Json
} catch {
    Write-Output ('MANIFEST.json was not read (' + $_.Exception.Message + '); stopping by folder only.')
}

# 1. Ask the windows to close (the app flushes its state on a normal quit).
try {
    $before = @(Get-CandidateProcesses $appDirectory)
    Write-Output ('Candidate processes running: ' + $before.Count)
    if ((Close-CandidateWindows $before) -gt 0) { Start-Sleep -Seconds 3 }
} catch {
    Write-Output ('Could not list the candidate processes yet (' + $_.Exception.Message + ')')
}

# 2. Ask the gateway of this sandbox to stop.
if (-not $Root -and $env:LOCALAPPDATA) { $Root = Join-Path $env:LOCALAPPDATA 'HermesClarifyCandidate' }
try {
    $safety = if ($Root) { Test-SandboxSafety $Root } else { @{ Layout = $null; Problem = 'no sandbox root is known (LOCALAPPDATA is not set and -Root was not given)' } }
} catch {
    $safety = @{ Layout = $null; Problem = $_.Exception.Message }
}
Invoke-GatewayStop -AppDirectory $appDirectory -Manifest $manifest -Safety $safety -TimeoutSeconds $GatewayStopTimeoutSeconds

# 3. Whatever still runs from this package ends now. Whatever happened above.
try {
    $outcome = Stop-CandidateProcesses $appDirectory
} catch {
    [Console]::Error.WriteLine("The candidate's processes could not be listed or ended: " + $_.Exception.Message)
    exit 1
}
Write-Output ('Force-stopped: ' + $outcome.Ended + '; still running: ' + $outcome.Left.Count)
foreach ($row in $outcome.Left) { Write-Output ('  still running: ' + $row.ProcessId + ' ' + $row.ExecutablePath) }
if ($outcome.Left.Count -gt 0) { exit 1 }
exit 0
