<#
.SYNOPSIS
  Start the Hermes clarify-autosave candidate in an isolated, disposable sandbox.

.DESCRIPTION
  Run through Start-HermesClarifyCandidate.cmd. The candidate keeps ALL of its state under one sandbox root
  (default %LOCALAPPDATA%\HermesClarifyCandidate): Hermes home, Electron user data, a sandboxed user profile
  (so Python's Path.home() and Electron's AppData folders land there too), the per-user gateway rendezvous
  directory, the folder the assistant works in by default, and a temp directory.

  It refuses to start (exit 2) when the sandbox would be, sit inside, or contain a real Hermes location of the
  current user, and (exit 3/4) when the package is damaged or is not a one-commit bundled build whose updater
  is disabled. It never registers the hermes:// handler, never attaches to an installed Hermes backend, and
  never touches an installed Hermes app, its updater or its data.

.PARAMETER Root
  Sandbox root. Default: %LOCALAPPDATA%\HermesClarifyCandidate. It must be an absolute local path.

.PARAMETER EmitEnvironment
  Create the sandbox, then print the launch contract (executable, arguments, complete environment, layout) as
  JSON instead of starting the app. The acceptance test launches the packaged executable from this output.

.PARAMETER Wait
  Wait for the app to exit and return its exit code.

.PARAMETER SkipHashCheck
  Skip re-hashing the executable against MANIFEST.json (about a second).
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$EmitEnvironment,
    [switch]$Wait,
    [switch]$SkipHashCheck
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'CandidateCommon.ps1')

$packageRoot = Split-Path -Parent $PSScriptRoot
if (-not $Root) {
    if (-not $env:LOCALAPPDATA) { Stop-Refused 2 'LOCALAPPDATA is not set, so there is no default sandbox root; pass -Root.' }
    $Root = Join-Path $env:LOCALAPPDATA 'HermesClarifyCandidate'
}

# Safety first, and from the inherited environment: nothing below runs before these refusals.
$safe = Assert-SafeSandbox $Root
$layout = $safe.Layout
$package = Get-CandidatePackage -PackageRoot $packageRoot -SkipHashCheck:$SkipHashCheck
$commit = [string]$package.Manifest.source.commit

Initialize-Sandbox -Layout $layout -Commit $commit
$childEnvironment = Get-CandidateEnvironment -Layout $layout -Commit $commit
# Belt and braces: the app applies HERMES_DESKTOP_USER_DATA_DIR before anything asks Electron for its default
# user data directory (that call creates it), and the switch names the same directory, so neither the app nor
# Chromium can resolve the default one, whatever either does.
$arguments = @('--user-data-dir=' + $layout.userData)

if ($EmitEnvironment) {
    $contract = [ordered]@{
        schema           = 1
        packageRoot      = $packageRoot
        exe              = $package.Exe
        arguments        = $arguments
        workingDirectory = $layout.temp
        environment      = $childEnvironment
        layout           = $layout
        commit           = $commit
        refusedLocations = @($safe.RealLocations | ForEach-Object { $_.Path })
    }
    # ASCII-only JSON (non-ASCII escaped) so the reader's console code page cannot matter.
    $json = $contract | ConvertTo-Json -Depth 6 -Compress
    $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($match) ('\u{0:x4}' -f [int][char]$match.Value) })
    [Console]::Out.WriteLine($json)
    exit 0
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $package.Exe
$startInfo.Arguments = (@($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')
$startInfo.WorkingDirectory = $layout.temp
$startInfo.UseShellExecute = $false
$startInfo.EnvironmentVariables.Clear()
foreach ($name in $childEnvironment.Keys) { $startInfo.EnvironmentVariables[$name] = $childEnvironment[$name] }

try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
} catch {
    Stop-Refused 5 ("Windows could not start '" + $package.Exe + "': " + $_.Exception.Message)
}

Write-Output ('Started Hermes Agent ' + $commit.Substring(0, 7) + ' (process ' + $process.Id + ').')
Write-Output ('Sandbox: ' + $layout.root)
Write-Output ('  Hermes home : ' + $layout.hermesHome)
Write-Output ('  Electron    : ' + $layout.userData)
Write-Output ('  Gateway lock: ' + $layout.gatewayLocks)
Write-Output ('  Workspace   : ' + $layout.workspace)
Write-Output 'This candidate is unsigned and separate from any installed Hermes. Stop it (and the background'
Write-Output 'gateway it starts) with Stop-HermesClarifyCandidate.cmd; delete the sandbox folder to reset it.'
if ($Wait) {
    $process.WaitForExit()
    exit $process.ExitCode
}
exit 0
