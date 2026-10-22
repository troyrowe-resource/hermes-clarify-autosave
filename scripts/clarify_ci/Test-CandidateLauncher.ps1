<#
.SYNOPSIS
  Self-test of the candidate's isolating launcher on a real Windows host. Needs no build.

.DESCRIPTION
  Lays the shipped launcher beside a fake package (a tiny compiled executable that records its environment and
  arguments), points the INHERITED environment at a fake "real" profile that holds fake real Hermes locations,
  and runs Start-HermesClarifyCandidate.ps1 in child shells. It proves the launcher refuses every unsafe sandbox
  location (also one that only reaches a real home through a junction or a substituted drive) without creating
  anything, refuses a tampered or non-candidate package, and otherwise hands the candidate a complete,
  credential-free, fully sandboxed environment. It also runs Stop-HermesClarifyCandidate.ps1 against real
  processes: it must end exactly what runs from the package, never wait on the gateway request, and never be
  refused. Run it with each shell the user might use:

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

# A process that simply stays (the app's gateway, or an unrelated program) and a stand-in for the packaged CLI: it
# records how `gateway stop` was run, and hangs when the sandbox's home holds a hang-gateway-stop marker.
$sleeperSource = Join-Path $work 'sleeper.cs'
Set-Content -LiteralPath $sleeperSource -Encoding ASCII -Value @'
public static class Sleeper { public static int Main() { System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); return 0; } }
'@
$cliSource = Join-Path $work 'fake-cli.cs'
Set-Content -LiteralPath $cliSource -Encoding ASCII -Value @'
using System;
using System.IO;
using System.Threading;
public static class FakeCli {
    public static int Main(string[] args) {
        string temp = Environment.GetEnvironmentVariable("TEMP");
        string home = Environment.GetEnvironmentVariable("HERMES_HOME");
        Directory.CreateDirectory(temp);
        File.WriteAllText(Path.Combine(temp, "fake-cli-report.txt"),
            "ARGS=" + string.Join(" ", args) + "\r\nHERMES_HOME=" + home + "\r\nSTDIN_REDIRECTED=" + Console.IsInputRedirected + "\r\n");
        // Everything a prompt could be waiting on, measured on the raw stream (no text decoding, so a byte-order mark or
        // any other byte shows up as a count): how many bytes arrive before the input ends, and whether it ends. A
        // console or an open pipe would block in Read, and the second report would never be written.
        int bytes = 0;
        bool ended = false;
        string error = "none";
        try {
            Stream input = Console.OpenStandardInput();
            byte[] buffer = new byte[256];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0) bytes += read;
            ended = true;
        } catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
        File.WriteAllText(Path.Combine(temp, "fake-cli-stdin.txt"), "STDIN_BYTES=" + bytes + "\r\nSTDIN_AT_EOF=" + ended + "\r\nSTDIN_ERROR=" + error + "\r\n");
        if (File.Exists(Path.Combine(home, "hang-gateway-stop"))) Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
'@
$ownedSleeper = Join-Path $package 'app\resources\agent-payload\python.exe'
$fakeCli = Join-Path $package ('app\resources\agent-payload\bin\' + $exeName)
$decoySleeper = Join-Path $work ('decoy\' + $exeName)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ownedSleeper), (Split-Path -Parent $fakeCli), (Split-Path -Parent $decoySleeper) | Out-Null
& $csc /nologo /target:exe ('/out:' + $ownedSleeper) $sleeperSource | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not compile the sleeper stand-in' }
Copy-Item -LiteralPath $ownedSleeper -Destination $decoySleeper
& $csc /nologo /target:exe ('/out:' + $fakeCli) $cliSource | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not compile the CLI stand-in' }

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
# A root that is harmless as written but physically lands inside a real home: the guard judges where it really is.
$ancestorLink = Join-Path $work 'ancestor-link'
& cmd.exe /c ('mklink /J "' + $ancestorLink + '" "' + (Join-Path $realLocal 'hermes') + '"') | Out-Null
Test-Refused 'refuses a root that reaches a real home through a junction in one of its ancestors' (Join-Path $ancestorLink 'candidate')
$elsewhere = Join-Path $work 'elsewhere'
$homeLink = Join-Path $work 'home-link'
New-Item -ItemType Directory -Force -Path $elsewhere | Out-Null
& cmd.exe /c ('mklink /J "' + $homeLink + '" "' + $elsewhere + '"') | Out-Null
Test-Refused 'refuses a root inside the place an exported HERMES_HOME junction really leads to' (Join-Path $elsewhere 'candidate') 2 @{ HERMES_HOME = $homeLink }
Assert-Case 'refuses a root on a substituted drive that stands for a real home' {
    $letter = $null
    foreach ($candidateLetter in 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z') { if (-not (Test-Path -LiteralPath ($candidateLetter + ':\'))) { $letter = $candidateLetter; break } }
    if (-not $letter) { return 'no free drive letter to substitute' }
    $drive = $letter + ':'
    & subst.exe $drive (Join-Path $realLocal 'hermes') | Out-Null
    try {
        $run = Invoke-Launcher 'Start-HermesClarifyCandidate.ps1' @('-Root', ($drive + '\candidate'), '-EmitEnvironment')
        if ($run.Code -ne 2 -or $run.Err -notmatch 'REFUSING TO START') { return "exit $($run.Code): $($run.Err.Trim()) $($run.Out.Trim())" }
        if (Test-Path -LiteralPath (Join-Path $realLocal 'hermes\candidate')) { return 'a candidate folder was created inside the real home' }
    } finally { & subst.exe $drive /d | Out-Null }
}

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

# --- Stop: real processes. What runs from the package ends; nothing else does; nothing can make it refuse or wait --------
function Start-Sleeper([string]$Path) { Start-Process -FilePath $Path -PassThru -WindowStyle Hidden }
function Stop-Sleepers($Processes) {
    foreach ($process in $Processes) { if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }
}
function Get-StopFailure($Run, [string]$Expected) {
    if ($Run.Code -ne 0 -or $Run.Out -notmatch $Expected) { return "exit $($Run.Code): $($Run.Out.Trim()) $($Run.Err.Trim())" }
    return $null
}
$startedRoot = Join-Path $work 'started root'
Assert-Case 'Stop ends what runs from the package, leaves an unrelated process that shares the executable name alone, and runs gateway stop --yes on an input that has already ended' {
    foreach ($name in 'fake-cli-report.txt', 'fake-cli-stdin.txt') { Remove-Item -LiteralPath (Join-Path $startedRoot ('tmp\' + $name)) -ErrorAction SilentlyContinue }
    $owned = Start-Sleeper $ownedSleeper
    $decoy = Start-Sleeper $decoySleeper
    try {
        $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', $startedRoot)
        $failure = Get-StopFailure $run 'gateway stop exited with 0(?s).*Force-stopped: 1; still running: 0'
        if ($failure) { return $failure }
        if (-not $owned.WaitForExit(10000)) { return 'a process that runs from the package was left running' }
        if ($decoy.HasExited) { return 'Stop ended an unrelated process that only shares the executable name' }
        $report = @(Get-Content -LiteralPath (Join-Path $startedRoot 'tmp\fake-cli-report.txt'))
        $stdinLines = @(Get-Content -LiteralPath (Join-Path $startedRoot 'tmp\fake-cli-stdin.txt') -ErrorAction SilentlyContinue)
        $seen = ($report + $stdinLines) -join ' | '
        if ($report -notcontains 'ARGS=gateway stop --yes') { return "gateway stop was run as: $seen" }
        if ($report -notcontains ('HERMES_HOME=' + (Join-Path $startedRoot 'user-data\hermes-home'))) { return "gateway stop saw another home: $seen" }
        # The CLI must never be able to wait on input: a stream that is not a console, empty, and over at once.
        if ($report -notcontains 'STDIN_REDIRECTED=True' -or $stdinLines -notcontains 'STDIN_BYTES=0' -or $stdinLines -notcontains 'STDIN_AT_EOF=True' -or $stdinLines -notcontains 'STDIN_ERROR=none') {
            return "the gateway request's input was not an empty, ended, non-console stream: $seen"
        }
    } finally { Stop-Sleepers @($owned, $decoy) }
}
Assert-Case 'the gateway request reaches a packaged CLI whose path holds spaces, &, parentheses and ^ (cmd quoting)' {
    $oddApp = Join-Path $work 'odd & (name) ^ app'
    $oddBin = Join-Path $oddApp 'resources\agent-payload\bin'
    New-Item -ItemType Directory -Force -Path $oddBin | Out-Null
    Copy-Item -LiteralPath $fakeCli -Destination (Join-Path $oddBin $exeName)
    $oddLayout = Get-SandboxLayout (Join-Path $work 'odd sandbox')
    foreach ($name in 'hermesHome', 'temp') { New-Item -ItemType Directory -Force -Path $oddLayout[$name] | Out-Null }
    $oddManifest = [pscustomobject]@{
        source = [pscustomobject]@{ commit = $commit }
        app    = [pscustomobject]@{ stamp = [pscustomobject]@{ runtime = [pscustomobject]@{ commands = [pscustomobject]@{ hermes = ('bin/' + $exeName) } } } }
    }
    $out = (@(Invoke-GatewayStop -AppDirectory $oddApp -Manifest $oddManifest -Safety @{ Layout = $oddLayout; Problem = $null } -TimeoutSeconds 20) -join ' | ')
    if ($out -notmatch 'gateway stop exited with 0') { return "the request did not run: $out" }
    $report = @(Get-Content -LiteralPath (Join-Path $oddLayout.temp 'fake-cli-report.txt'))
    if ($report -notcontains 'ARGS=gateway stop --yes') { return "arguments: $($report -join ' | ')" }
}
Assert-Case 'Stop still ends the package when gateway stop never finishes (the request is bounded and then ended)' {
    $marker = Join-Path $startedRoot 'user-data\hermes-home\hang-gateway-stop'
    Set-Content -LiteralPath $marker -Value 'x' -Encoding ASCII
    $owned = Start-Sleeper $ownedSleeper
    try {
        $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', $startedRoot, '-GatewayStopTimeoutSeconds', '3')
        $failure = Get-StopFailure $run 'did not finish within 3 s(?s).*still running: 0'
        if ($failure) { return $failure }
        if (-not $owned.WaitForExit(10000)) { return 'a process that runs from the package was left running' }
    } finally { Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue; Stop-Sleepers @($owned) }
}
Assert-Case 'Stop works with no sandbox at all (a start without the launcher, or a root that never ran): sweeps, creates nothing' {
    $never = Join-Path $work 'never started'
    $owned = Start-Sleeper $ownedSleeper
    try {
        $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', $never)
        $failure = Get-StopFailure $run 'gateway stop skipped: there is no sandbox home(?s).*Force-stopped: 1; still running: 0'
        if ($failure) { return $failure }
        if (-not $owned.WaitForExit(10000)) { return 'a process that runs from the package was left running' }
        if (Test-Path -LiteralPath $never) { return 'Stop created the sandbox root' }
    } finally { Stop-Sleepers @($owned) }
}
Assert-Case 'Stop is never refused: an unsafe -Root only skips the gateway request' {
    $owned = Start-Sleeper $ownedSleeper
    try {
        $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', (Join-Path $realLocal 'hermes'))
        $failure = Get-StopFailure $run 'gateway stop skipped: the sandbox root(?s).*Force-stopped: 1; still running: 0'
        if ($failure) { return $failure }
        if (-not $owned.WaitForExit(10000)) { return 'a process that runs from the package was left running' }
        if (Test-Path -LiteralPath (Join-Path $realLocal 'hermes\tmp')) { return 'Stop wrote into a real Hermes home' }
    } finally { Stop-Sleepers @($owned) }
}
Assert-Case 'Stop with nothing running exits 0' {
    $run = Invoke-Launcher 'Stop-HermesClarifyCandidate.ps1' @('-Root', $startedRoot)
    $failure = Get-StopFailure $run 'Force-stopped: 0; still running: 0'
    if ($failure) { return $failure }
}

# --- Report ------------------------------------------------------------------------------------------------------------------
# A recursive delete must never follow a junction: remove each link itself first.
foreach ($link in @($junction, $ancestorLink, $homeLink)) {
    if (Test-Path -LiteralPath $link) { & cmd.exe /c ('rmdir "' + $link + '"') | Out-Null }
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
$failed = @($results | Where-Object { -not $_.Passed })
Write-Output ('{0} case(s), {1} failed ({2})' -f $results.Count, $failed.Count, $shell)
if ($failed.Count -gt 0) { exit 1 }
exit 0
