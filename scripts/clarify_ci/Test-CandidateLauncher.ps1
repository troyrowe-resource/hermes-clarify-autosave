<#
.SYNOPSIS
  Self-test of the candidate's isolating launcher on a real Windows host. Needs no build.

.DESCRIPTION
  Lays the shipped launcher beside a fake package (a tiny compiled executable that records its environment and
  arguments), points the INHERITED environment at a fake "real" profile that holds fake real Hermes locations,
  and runs Start-HermesClarifyCandidate.ps1 in child shells. It proves the launcher refuses every unsafe sandbox
  location without creating anything, refuses a tampered or non-candidate package, and otherwise hands the
  candidate a complete, credential-free, fully sandboxed environment. Run it with each shell the user might use:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File Test-CandidateLauncher.ps1
    pwsh -NoProfile -File Test-CandidateLauncher.ps1

  Touches only a temp directory it creates. Exit code 0 when every case passed.
#>
[CmdletBinding()]
param(
    [string]$LauncherSource = (Join-Path $PSScriptRoot 'candidate-package')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $LauncherSource 'launcher\CandidateCommon.ps1')

$shell = (Get-Process -Id $PID).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('hermes-launcher-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
# The launcher compares long-form paths; runner temp directories are spelled with 8.3 short names.
$work = Get-NormalPath $work
$commit = 'abcdef0123456789abcdef0123456789abcdef01'
$exeName = 'hermes-abcdef0.exe'
$results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail) {
    $script:results.Add([pscustomobject]@{ Case = $Name; Passed = $Passed; Detail = $Detail })
    Write-Output (('{0,-4} {1}{2}' -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Passed) { '' } else { ' - ' + $Detail })))
}

function Assert-Case([string]$Name, [scriptblock]$Check) {
    try {
        $detail = & $Check
        Add-Result $Name ($null -eq $detail -or $detail -eq '') ([string]$detail)
    } catch {
        Add-Result $Name $false $_.Exception.Message
    }
}

# --- A fake real profile with fake real Hermes locations ---------------------------------------------------------
$real = Join-Path $work 'real'
$realLocal = Join-Path $real 'AppData\Local'
$realRoaming = Join-Path $real 'AppData\Roaming'
foreach ($path in @((Join-Path $realLocal 'hermes'), (Join-Path $realRoaming 'Hermes'), (Join-Path $real '.hermes'), (Join-Path $work 'machine-home'))) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    Set-Content -LiteralPath (Join-Path $path 'config.yaml') -Value 'model: real' -Encoding ASCII
}

# --- The fake package: shipped launcher + a compiled stand-in for the app executable ------------------------------
$package = Join-Path $work 'pkg'
New-Item -ItemType Directory -Force -Path (Join-Path $package 'app\resources') | Out-Null
Copy-Item -Path (Join-Path $LauncherSource '*') -Destination $package -Recurse -Force
$source = Join-Path $work 'fake-app.cs'
Set-Content -LiteralPath $source -Encoding ASCII -Value @'
using System;
using System.IO;
using System.Collections;
using System.Text;
public static class FakeApp {
    public static int Main(string[] args) {
        var text = new StringBuilder();
        foreach (string a in args) text.AppendLine("ARG=" + a);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) text.AppendLine("ENV=" + e.Key + "=" + e.Value);
        text.AppendLine("CWD=" + Environment.CurrentDirectory);
        File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "fake-app-report.txt"), text.ToString());
        return 7;
    }
}
'@
$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $package ('app\' + $exeName)
& $csc /nologo /target:exe ('/out:' + $exe) $source | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not compile the stand-in executable' }

function Write-PackageFiles([string]$UpdateMechanism = 'external', [string]$BuildSource = 'commit-build', [string]$Suffix = '-clarify-candidate') {
    $baked = [ordered]@{ HERMES_DATA_DIR_SUFFIX = $Suffix; HERMES_HOME = $null }
    $stamp = [ordered]@{ source = $BuildSource; updateMechanism = $UpdateMechanism; payload = 'bundled'; commit = $commit; bundleEnv = $baked }
    Set-Content -LiteralPath (Join-Path $package 'app\resources\install-stamp.json') -Value ($stamp | ConvertTo-Json) -Encoding ASCII
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        source = [ordered]@{ commit = $commit }
        app    = [ordered]@{ exe = ('app/' + $exeName); exe_sha256 = $hash
                             stamp = [ordered]@{ runtime = [ordered]@{ commands = [ordered]@{ hermes = ('bin/' + $exeName) } } } }
    }
    Set-Content -LiteralPath (Join-Path $package 'MANIFEST.json') -Value ($manifest | ConvertTo-Json -Depth 8) -Encoding ASCII
}
Write-PackageFiles

# --- Running the launcher in a child shell whose INHERITED environment is the fake real profile -----------------
function Invoke-Launcher([string]$ScriptName, [string[]]$Arguments, [hashtable]$Environment = @{}) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $shell
    $quoted = @($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
    $info.Arguments = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $package ('launcher\' + $ScriptName)) + '"')) + $quoted) -join ' '
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $work
    $info.EnvironmentVariables['USERPROFILE'] = $real
    $info.EnvironmentVariables['APPDATA'] = $realRoaming
    $info.EnvironmentVariables['LOCALAPPDATA'] = $realLocal
    $info.EnvironmentVariables['TEMP'] = $work
    $info.EnvironmentVariables['TMP'] = $work
    foreach ($name in @('HERMES_HOME', 'HERMES_FOO')) { if ($info.EnvironmentVariables.ContainsKey($name)) { $info.EnvironmentVariables.Remove($name) } }
    foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = [string]$Environment[$name] }
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ Code = $process.ExitCode; Out = $stdout; Err = $stderr }
}

function Test-Refused([string]$Name, [string]$Root, [int]$Code = 2, [hashtable]$Environment = @{}, [bool]$ExpectNothingCreated = $true) {
    Assert-Case $Name {
        $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', $Root, '-EmitEnvironment') $Environment
        if ($run.Code -ne $Code) { return "exit $($run.Code), wanted $Code; stderr: $($run.Err.Trim())" }
        if ($run.Err -notmatch 'REFUSING TO START') { return "no refusal message: $($run.Err.Trim())" }
        if ($run.Out.Trim()) { return "a refusal still printed a launch contract: $($run.Out.Trim())" }
        if ($ExpectNothingCreated -and (Test-Path -LiteralPath (Join-Path $Root 'user-data'))) { return "a refusal created $Root\user-data" }
    }
}

# --- The safe case ----------------------------------------------------------------------------------------------
$sandbox = Join-Path $work 'sand box'
$contract = $null
Assert-Case 'starts in a sandbox outside every real location and prints a launch contract' {
    $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', $sandbox, '-EmitEnvironment') @{
        OPENAI_API_KEY = 'sk-test'; GITHUB_TOKEN = 'ghs_test'; HERMES_FOO = 'leak'; NODE_OPTIONS = '--inspect'; ELECTRON_RUN_AS_NODE = '1'; PYTHONPATH = 'C:\leak'
        HERMES_GATEWAY_LOCK_DIR = 'C:\real-locks'; XDG_STATE_HOME = 'C:\real-state'; CODEX_HOME = 'C:\real-codex'; CLAUDE_CONFIG_DIR = 'C:\real-claude'
    }
    if ($run.Code -ne 0) { return "exit $($run.Code): $($run.Err.Trim())" }
    $script:contract = $run.Out.Trim() | ConvertFrom-Json
    if ($script:contract.layout.root -ne $sandbox) { return "root is $($script:contract.layout.root)" }
}
if ($contract) {
    $envMap = @{}
    foreach ($property in $contract.environment.PSObject.Properties) { $envMap[$property.Name] = [string]$property.Value }
    Assert-Case 'every state location is inside the sandbox and the user-data switch matches the env var' {
        $inside = @('HERMES_HOME', 'HERMES_DESKTOP_USER_DATA_DIR', 'HERMES_GATEWAY_LOCK_DIR', 'HERMES_DESKTOP_CWD', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')
        foreach ($name in $inside) { if (-not $envMap[$name].StartsWith($sandbox + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return "$name=$($envMap[$name]) is outside $sandbox" } }
        if ($contract.arguments[0] -ne ('--user-data-dir=' + $envMap['HERMES_DESKTOP_USER_DATA_DIR'])) { return "switch $($contract.arguments[0])" }
        if ($envMap['HERMES_HOME'] -ne (Join-Path $envMap['HERMES_DESKTOP_USER_DATA_DIR'] 'hermes-home')) { return "HERMES_HOME $($envMap['HERMES_HOME'])" }
        foreach ($name in @('userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp', 'gatewayLocks', 'workspace')) { if (-not (Test-Path -LiteralPath $contract.layout.$name)) { return "$name was not created" } }
        if ($envMap['HERMES_GATEWAY_LOCK_DIR'] -ne $contract.layout.gatewayLocks) { return "lock dir $($envMap['HERMES_GATEWAY_LOCK_DIR'])" }
        if ($envMap['HERMES_DESKTOP_CWD'] -ne $contract.layout.workspace) { return "agent working directory $($envMap['HERMES_DESKTOP_CWD'])" }
        if (-not (Test-Path -LiteralPath (Join-Path $sandbox '.hermes-clarify-candidate-sandbox'))) { return 'no sandbox marker' }
    }
    Assert-Case 'the isolation flags are set and nothing from the real user environment leaks in' {
        foreach ($name in @('HERMES_DESKTOP_IGNORE_EXISTING', 'HERMES_DESKTOP_ISOLATED_BACKEND', 'HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION')) { if ($envMap[$name] -ne '1') { return "$name=$($envMap[$name])" } }
        if ($envMap['HERMES_DESKTOP_APP_NAME'] -ne 'HermesClarifyCandidate-abcdef0') { return "app name $($envMap['HERMES_DESKTOP_APP_NAME'])" }
        foreach ($name in @('OPENAI_API_KEY', 'GITHUB_TOKEN', 'HERMES_FOO', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR')) { if ($envMap.ContainsKey($name)) { return "$name leaked into the candidate" } }
        if (-not $envMap.ContainsKey('SystemRoot') -or -not $envMap.ContainsKey('PATH')) { return 'SystemRoot or PATH was dropped; Windows programs and Python sockets need them' }
        foreach ($path in $contract.refusedLocations) { if ($envMap.Values -contains $path) { return "a real location $path is in the candidate environment" } }
    }
    Assert-Case 'the real locations it guards are the fake real profile, not the sandbox' {
        $locations = @($contract.refusedLocations)
        foreach ($expected in @((Join-Path $realLocal 'hermes'), (Join-Path $real '.hermes'), (Join-Path $realRoaming 'Hermes'))) {
            if (-not ($locations | Where-Object { $_ -ieq $expected })) { return "$expected is not guarded: $($locations -join '; ')" }
        }
    }
}
Assert-Case 'the default root is under LOCALAPPDATA, beside (not inside) the installed Hermes home' {
    $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-EmitEnvironment')
    if ($run.Code -ne 0) { return "exit $($run.Code): $($run.Err.Trim())" }
    $root = ($run.Out.Trim() | ConvertFrom-Json).layout.root
    if ($root -ne (Join-Path $realLocal 'HermesClarifyCandidate')) { return "default root $root" }
}

# --- Refusals: each is exit 2, a message, and nothing created ----------------------------------------------------------
Test-Refused 'refuses the default Hermes home itself' (Join-Path $realLocal 'hermes')
Test-Refused 'refuses a folder inside the default Hermes home' (Join-Path $realLocal 'hermes\candidate')
Test-Refused 'refuses the legacy .hermes home' (Join-Path $real '.hermes')
Test-Refused 'refuses a folder inside the installed app user data' (Join-Path $realRoaming 'Hermes\x')
Test-Refused 'refuses a folder that contains the real homes (the user profile)' $real
Test-Refused 'refuses LOCALAPPDATA itself' $realLocal
Test-Refused 'refuses an exported HERMES_HOME' (Join-Path $work 'machine-home') 2 @{ HERMES_HOME = (Join-Path $work 'machine-home') }
Test-Refused 'refuses a folder inside an exported HERMES_HOME' (Join-Path $work 'machine-home\x') 2 @{ HERMES_HOME = (Join-Path $work 'machine-home') }
Test-Refused 'refuses a relative root' 'sandbox' 2 @{} $false
Test-Refused 'refuses a network root' '\\server\share\candidate' 2 @{} $false
$foreign = Join-Path $work 'foreign'
New-Item -ItemType Directory -Force -Path $foreign | Out-Null
Set-Content -LiteralPath (Join-Path $foreign 'notes.txt') -Value 'not ours' -Encoding ASCII
Test-Refused 'refuses a non-empty folder that is not a candidate sandbox' $foreign 2 @{} $false
$junction = Join-Path $work 'junction'
& cmd.exe /c ('mklink /J "' + $junction + '" "' + (Join-Path $realLocal 'hermes') + '"') | Out-Null
Test-Refused 'refuses a junction (even one that points at a real home)' $junction 2 @{} $false

# --- A damaged or non-candidate package ---------------------------------------------------------------------------------
Assert-Case 'refuses an executable that no longer matches MANIFEST.json (exit 3)' {
    [System.IO.File]::AppendAllText($exe, 'x')
    try { $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $work 's3'), '-EmitEnvironment') }
    finally { Write-PackageFiles }
    if ($run.Code -ne 3 -or $run.Err -notmatch 'sha256') { return "exit $($run.Code): $($run.Err.Trim())" }
}
Write-PackageFiles
Assert-Case 'refuses a build whose updater is not switched off (exit 4)' {
    Write-PackageFiles 'self' 'commit-build'
    try { $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $work 's4'), '-EmitEnvironment') }
    finally { Write-PackageFiles }
    if ($run.Code -ne 4 -or $run.Err -notmatch 'updateMechanism') { return "exit $($run.Code): $($run.Err.Trim())" }
}
Assert-Case 'refuses a build that is not a one-commit build (exit 4)' {
    Write-PackageFiles 'external' 'git'
    try { $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $work 's5'), '-EmitEnvironment') }
    finally { Write-PackageFiles }
    if ($run.Code -ne 4 -or $run.Err -notmatch "source=") { return "exit $($run.Code): $($run.Err.Trim())" }
}
Assert-Case 'refuses a build that does not bake the candidate data directory, which a double-click would need (exit 4)' {
    Write-PackageFiles 'external' 'commit-build' '-someone-else'
    try { $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $work 's6'), '-EmitEnvironment') }
    finally { Write-PackageFiles }
    if ($run.Code -ne 4 -or $run.Err -notmatch 'bundleEnv') { return "exit $($run.Code): $($run.Err.Trim())" }
}

# --- A real start: the stand-in executable sees exactly the launch contract --------------------------------------------
Assert-Case 'starts the executable with the switch (spaces quoted) and ONLY the contract environment' {
    $root = Join-Path $work 'started root'
    $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', $root, '-Wait') @{ OPENAI_API_KEY = 'sk-leak'; HERMES_FOO = 'leak' }
    if ($run.Code -ne 7) { return "launcher exit $($run.Code) (the stand-in exits 7): $($run.Err.Trim()) $($run.Out.Trim())" }
    $report = Get-Content -LiteralPath (Join-Path $root 'tmp\fake-app-report.txt')
    if ($report -notcontains ('ARG=--user-data-dir=' + (Join-Path $root 'user-data'))) { return "arguments: $($report | Where-Object { $_ -like 'ARG=*' })" }
    if ($report -notcontains 'ENV=HERMES_DESKTOP_ISOLATED_BACKEND=1') { return 'isolation flag missing in the started process' }
    $leaked = @($report | Where-Object { $_ -match '^ENV=(OPENAI_API_KEY|HERMES_FOO)=' })
    if ($leaked.Count) { return "leaked: $leaked" }
    if (@($report | Where-Object { $_ -like 'CWD=*' }) -notcontains ('CWD=' + (Join-Path $root 'tmp'))) { return 'wrong working directory' }
}
Assert-Case 'Stop-HermesClarifyCandidate ends nothing it does not own and exits 0' {
    $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $work 'started root'))
    if ($run.Code -ne 0 -or $run.Out -notmatch 'still running: 0') { return "exit $($run.Code): $($run.Out.Trim()) $($run.Err.Trim())" }
}

# --- Report ------------------------------------------------------------------------------------------------------------------
if (Test-Path -LiteralPath $junction) { & cmd.exe /c ('rmdir "' + $junction + '"') | Out-Null }
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
$failed = @($results | Where-Object { -not $_.Passed })
Write-Output ('{0} case(s), {1} failed ({2})' -f $results.Count, $failed.Count, $shell)
if ($failed.Count -gt 0) { exit 1 }
exit 0
