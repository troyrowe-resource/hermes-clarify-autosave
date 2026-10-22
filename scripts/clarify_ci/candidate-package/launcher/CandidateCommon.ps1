# Shared by Start-HermesClarifyCandidate.ps1 and Stop-HermesClarifyCandidate.ps1 (dot-sourced; functions only).
#
# What this guarantees, for every way the candidate is started through its launcher:
#   * every state location Hermes and Electron use is a directory inside ONE disposable sandbox root, including
#     the user profile (Python's Path.home() and Node's os.homedir() read USERPROFILE on Windows, never HOME) and the
#     per-OS-user rendezvous directory in which Hermes gateways find each other (HERMES_GATEWAY_LOCK_DIR, which
#     otherwise lives under the profile): a candidate can never attach to the user's real backend. The agent's
#     working directory is a sandbox folder too (HERMES_DESKTOP_CWD): a packaged app without one falls back to
#     Electron's home folder, which on Windows is the REAL profile whatever USERPROFILE says;
#   * the sandbox is never, never inside, and never an ancestor of a real Hermes location of the
#     current user (default home, legacy home, installed app's user data and updater cache, any
#     HERMES_HOME the user or the machine has set);
#   * the candidate gets a fresh environment: no credentials, no HERMES_*/PYTHON*/NODE*/ELECTRON* leakage.
# Exit codes: 2 unsafe location, 3 the executable does not match MANIFEST.json, 4 not a candidate-shaped build,
# 5 start failure. Stop never refuses: it only needs the package folder (see Stop-HermesClarifyCandidate.ps1).

$script:SandboxMarker = '.hermes-clarify-candidate-sandbox'
# Appended to the default Hermes home and Electron user data directory names. The build bakes the same value
# into the app (scripts/clarify_ci/candidate.py BUNDLE_ENV); the launcher refuses a package that does not carry it.
$script:DataDirSuffix = '-clarify-candidate'

function Stop-Refused {
    param([int]$Code, [string]$Message)
    [Console]::Error.WriteLine('Hermes clarify candidate: REFUSING TO START. ' + $Message)
    exit $Code
}

function Get-NormalPath {
    # Absolute, separator-normalised, 8.3 short names expanded where the path (or its nearest existing
    # ancestor) exists, no trailing separator. Comparison is case-insensitive at the call sites.
    # -Resolve also follows junctions, symbolic links, subst and mapped drives in that existing part, the way the
    # file system does: what a path REALLY is, not how it is spelled.
    param([string]$Path, [switch]$Resolve)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd([char]92, [char]47)
    $existing = $full
    $tail = ''
    while ($existing.Length -gt 3 -and -not (Test-Path -LiteralPath $existing)) {
        $tail = '\' + (Split-Path -Leaf $existing) + $tail
        $existing = Split-Path -Parent $existing
    }
    if (-not $existing -or -not (Test-Path -LiteralPath $existing)) { return $full }
    try {
        if (-not ('HermesCandidateNative' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HermesCandidateNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint bufferLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string fileName, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    // The final path of an existing file or folder, or null: opens it WITHOUT asking for any access (backup
    // semantics, so a folder opens too; reparse points are followed) and asks the volume what it really is.
    public static string FinalPath(string path) {
        IntPtr handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle == (IntPtr)(-1)) return null;
        try {
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) return null;
            string result = buffer.ToString();
            if (result.StartsWith("\\\\?\\UNC\\")) return "\\\\" + result.Substring(8);
            if (result.StartsWith("\\\\?\\")) return result.Substring(4);
            return result;
        } finally { CloseHandle(handle); }
    }
}
'@
        }
        $buffer = New-Object System.Text.StringBuilder 32768
        $length = [HermesCandidateNative]::GetLongPathNameW($existing, $buffer, [uint32]$buffer.Capacity)
        if ($length -gt 0 -and $length -lt $buffer.Capacity) { $existing = $buffer.ToString() }
        if ($Resolve) {
            $final = [HermesCandidateNative]::FinalPath($existing)
            if ($final) { $existing = $final }
        }
    } catch {
        # Short-name expansion and resolution are extras; the case-insensitive full-path comparison still applies.
    }
    return ($existing.TrimEnd([char]92, [char]47) + $tail)
}

function Test-SameOrInside {
    param([string]$Path, [string]$Parent)
    if ([string]::IsNullOrEmpty($Path) -or [string]::IsNullOrEmpty($Parent)) { return $false }
    if ($Path.Equals($Parent, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $Path.StartsWith($Parent + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-PathForms {
    # Every spelling of a path that could overlap a real Hermes location: as written (long names), and as the file
    # system really resolves it (junction, symbolic link, subst or mapped drive in any ancestor). A sandbox that is
    # harmless as written but physically lands inside a real home is caught by the second.
    param([string]$Path)
    $forms = New-Object System.Collections.Generic.List[string]
    foreach ($form in @((Get-NormalPath $Path), (Get-NormalPath $Path -Resolve))) {
        if (-not ($forms | Where-Object { $_ -ieq $form })) { $forms.Add($form) }
    }
    return ,$forms.ToArray()
}

function Find-PathOverlap {
    # The first pair of spellings in which one path is, is inside, or contains the other; $null when there is none.
    param([string[]]$Left, [string[]]$Right)
    foreach ($a in $Left) {
        foreach ($b in $Right) {
            if ((Test-SameOrInside $a $b) -or (Test-SameOrInside $b $a)) { return @{ Left = $a; Right = $b } }
        }
    }
    return $null
}

function Find-ContainedPath {
    # The first pair in which an Inner spelling is, or lies inside, an Outer one; $null when there is none.
    param([string[]]$Outer, [string[]]$Inner)
    foreach ($o in $Outer) {
        foreach ($i in $Inner) {
            if (Test-SameOrInside $i $o) { return @{ Left = $o; Right = $i } }
        }
    }
    return $null
}

function Format-Resolved {
    param([string]$Written, [string]$Seen)
    if ($Seen -ieq $Written) { return "'$Written'" }
    return "'$Written' (which resolves to '$Seen')"
}

function Get-RegistryHermesHome {
    param([string]$Key)
    $item = Get-ItemProperty -LiteralPath $Key -Name 'HERMES_HOME' -ErrorAction SilentlyContinue
    if ($item) { return [string]$item.HERMES_HOME }
    return ''
}

function Get-RealHermesLocations {
    # Directories that belong to a real Hermes install of the user running this: the sandbox may not be one
    # of them, inside one, or contain one. Built from the INHERITED environment, before it is replaced.
    $locations = New-Object System.Collections.Generic.List[object]
    $named = @(
        @($env:LOCALAPPDATA, 'hermes', 'the default Hermes home'),
        @($env:USERPROFILE, '.hermes', 'the legacy Hermes home'),
        @($env:APPDATA, 'Hermes', "the installed app's Electron user data"),
        @($env:APPDATA, 'hermes-desktop', 'a historical desktop user data directory'),
        @($env:LOCALAPPDATA, 'hermes-updater', "the installed app's updater cache")
    )
    foreach ($entry in $named) {
        if ($entry[0]) {
            $path = Get-NormalPath (Join-Path $entry[0] $entry[1])
            $locations.Add(@{ Path = $path; Forms = (Get-PathForms $path); Why = $entry[2] })
        }
    }
    $explicit = @(
        @($env:HERMES_HOME, 'HERMES_HOME in the current environment'),
        @((Get-RegistryHermesHome 'HKCU:\Environment'), 'HERMES_HOME saved in the user environment'),
        @((Get-RegistryHermesHome 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'), 'HERMES_HOME saved in the machine environment')
    )
    foreach ($entry in $explicit) {
        if ($entry[0] -and [System.IO.Path]::IsPathRooted($entry[0])) {
            $path = Get-NormalPath $entry[0]
            $locations.Add(@{ Path = $path; Forms = (Get-PathForms $path); Why = $entry[1] })
        }
    }
    return ,$locations.ToArray()
}

function Get-ProfileContainers {
    # The sandbox may sit INSIDE these (the default root is under LOCALAPPDATA) but must not equal or contain them.
    $containers = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @(@($env:USERPROFILE, 'the user profile'), @($env:APPDATA, 'the roaming profile'), @($env:LOCALAPPDATA, 'the local profile'))) {
        if ($entry[0]) {
            $path = Get-NormalPath $entry[0]
            $containers.Add(@{ Path = $path; Forms = (Get-PathForms $path); Why = $entry[1] })
        }
    }
    return ,$containers.ToArray()
}

function Test-ReparsePoint {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $attributes = (Get-Item -LiteralPath $Path -Force).Attributes
    return (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-SandboxLayout {
    param([string]$RootFull)
    $profile = Join-Path $RootFull 'profile'
    $userData = Join-Path $RootFull 'user-data'
    return [ordered]@{
        root       = $RootFull
        userData   = $userData
        hermesHome = (Join-Path $userData 'hermes-home')
        profile    = $profile
        roaming    = (Join-Path $profile 'AppData\Roaming')
        local      = (Join-Path $profile 'AppData\Local')
        temp       = (Join-Path $RootFull 'tmp')
        gatewayLocks = (Join-Path $RootFull 'gateway-locks')
        workspace  = (Join-Path $RootFull 'workspace')
    }
}

function Test-SandboxSafety {
    # Whether `Root` is a safe sandbox: its layout, the real locations it was judged against, and the first reason it
    # is not (Problem; $null when it is). It never refuses and never exits, so Stop can use it too. The root is judged
    # as written AND as the file system resolves it, against the real locations the same two ways.
    param([string]$Root)
    if (-not $Root -or $Root -notmatch '^[A-Za-z]:\\') {
        return @{ Layout = $null; RealLocations = @(); Problem = "the sandbox root '$Root' is not an absolute local path (for example C:\Users\you\AppData\Local\HermesClarifyCandidate)." }
    }
    $rootFull = Get-NormalPath $Root
    $layout = Get-SandboxLayout $rootFull
    $rootForms = Get-PathForms $rootFull
    $realLocations = Get-RealHermesLocations
    $result = @{ Layout = $layout; RealLocations = $realLocations; Problem = $null }
    foreach ($real in $realLocations) {
        $overlap = Find-PathOverlap $rootForms $real.Forms
        if ($overlap) {
            $result.Problem = "the sandbox root $(Format-Resolved $rootFull $overlap.Left) is, is inside, or contains $($real.Why) ($($real.Path))."
            return $result
        }
    }
    foreach ($container in (Get-ProfileContainers)) {
        # The sandbox may sit INSIDE a container but must not be, or contain, one.
        $overlap = Find-ContainedPath $rootForms $container.Forms
        if ($overlap) {
            $result.Problem = "the sandbox root $(Format-Resolved $rootFull $overlap.Left) is, or contains, $($container.Why) ($($container.Path))."
            return $result
        }
    }
    foreach ($name in @('root', 'userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp', 'gatewayLocks', 'workspace')) {
        if (Test-ReparsePoint $layout[$name]) {
            $result.Problem = "'$($layout[$name])' is a link or junction; the sandbox must be a plain directory tree."
            return $result
        }
    }
    if ((Test-Path -LiteralPath $rootFull) -and -not (Test-Path -LiteralPath (Join-Path $rootFull $script:SandboxMarker))) {
        if (@(Get-ChildItem -LiteralPath $rootFull -Force).Count -gt 0) {
            $result.Problem = "'$rootFull' exists, is not empty and is not a candidate sandbox (it has no $script:SandboxMarker marker)."
        }
    }
    return $result
}

function Assert-SafeSandbox {
    # Start's gate: the same judgement, as a refusal (exit 2) with nothing created.
    param([string]$Root)
    $safety = Test-SandboxSafety $Root
    if ($safety.Problem) { Stop-Refused 2 $safety.Problem }
    return @{ Layout = $safety.Layout; RealLocations = $safety.RealLocations }
}

function Initialize-Sandbox {
    param($Layout, [string]$Commit)
    foreach ($name in @('root', 'userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp', 'gatewayLocks', 'workspace')) {
        New-Item -ItemType Directory -Force -Path $Layout[$name] | Out-Null
    }
    $marker = Join-Path $Layout.root $script:SandboxMarker
    if (-not (Test-Path -LiteralPath $marker)) {
        $note = [ordered]@{ purpose = 'Disposable Hermes clarify-autosave candidate sandbox'; commit = $Commit; created = (Get-Date).ToUniversalTime().ToString('o') }
        Set-Content -LiteralPath $marker -Value ($note | ConvertTo-Json) -Encoding ASCII
    }
}

function Get-CandidatePackage {
    param([string]$PackageRoot, [switch]$SkipHashCheck)
    $manifestPath = Join-Path $PackageRoot 'MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { Stop-Refused 3 "MANIFEST.json is missing from '$PackageRoot'; this is not an intact candidate package." }
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    $exe = Join-Path $PackageRoot (($manifest.app.exe) -replace '/', '\')
    if (-not (Test-Path -LiteralPath $exe)) { Stop-Refused 3 "the product executable '$exe' named by MANIFEST.json is missing." }
    if (-not $SkipHashCheck) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
        if ($actual -cne $manifest.app.exe_sha256) { Stop-Refused 3 "'$exe' does not match the sha256 in MANIFEST.json (found $actual); the package was altered or damaged." }
    }
    $stampPath = Join-Path (Split-Path -Parent $exe) 'resources\install-stamp.json'
    if (-not (Test-Path -LiteralPath $stampPath)) { Stop-Refused 4 "'$stampPath' is missing; this is not a bundled candidate build." }
    $stamp = Get-Content -Raw -Encoding UTF8 -LiteralPath $stampPath | ConvertFrom-Json
    $required = @(@('source', 'commit-build'), @('updateMechanism', 'external'), @('payload', 'bundled'), @('commit', [string]$manifest.source.commit))
    foreach ($pair in $required) {
        $property = $stamp.PSObject.Properties[$pair[0]]
        $actual = if ($property) { [string]$property.Value } else { '' }
        if ($actual -cne $pair[1]) {
            Stop-Refused 4 "the build stamp says $($pair[0])='$actual', not '$($pair[1])'. The launcher only starts a one-commit bundled build that cannot update itself."
        }
    }
    # The baked defaults are what keep a start WITHOUT this launcher (a double-click on the .exe) out of a real
    # Hermes home: a data directory of its own, and no inherited or registry HERMES_HOME.
    $baked = $stamp.PSObject.Properties['bundleEnv']
    $bakedSuffix = if ($baked -and $baked.Value) { $baked.Value.PSObject.Properties['HERMES_DATA_DIR_SUFFIX'] } else { $null }
    $bakedHome = if ($baked -and $baked.Value) { $baked.Value.PSObject.Properties['HERMES_HOME'] } else { $null }
    if (-not $bakedSuffix -or [string]$bakedSuffix.Value -cne $script:DataDirSuffix -or -not $bakedHome -or $null -ne $bakedHome.Value) {
        Stop-Refused 4 "the build stamp does not bake the candidate's own data directory (bundleEnv must set HERMES_DATA_DIR_SUFFIX='$script:DataDirSuffix' and clear HERMES_HOME). Starting it would not be isolated."
    }
    return @{ Manifest = $manifest; Exe = $exe; Stamp = $stamp }
}

function Get-CandidateEnvironment {
    # The complete environment of the candidate process, as a hashtable. Nothing is inherited unless it is
    # needed to run a Windows program and cannot carry a credential or a Hermes/runtime override.
    param($Layout, [string]$Commit)
    # Runtime overrides, Hermes variables, CI state, and the variables other tools use to find a configuration or a
    # credential store outside the profile (XDG_*, CODEX_HOME, CLAUDE_CONFIG_DIR, provider settings).
    $drop = '^(?:PYTHON|VIRTUAL_ENV|CONDA|NODE_|NPM_|ELECTRON_|VITE_|UV_|PM_|HERMES_|GITHUB_|RUNNER_|ACTIONS_|XDG_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|OPENROUTER_|NOUS_|GEMINI_|GOOGLE_)'
    $secret = '(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)'
    $environment = @{}
    $inherited = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $inherited.Keys) {
        $value = [string]$inherited[$name]
        $upper = ([string]$name).ToUpperInvariant()
        if ([string]::IsNullOrEmpty($value) -or $upper -match $drop -or $upper -match $secret) { continue }
        $environment[[string]$name] = $value
    }
    $sha7 = $Commit.Substring(0, 7)
    $homeDrive = [System.IO.Path]::GetPathRoot($Layout.profile).TrimEnd([char]92)
    $overrides = [ordered]@{
        HERMES_HOME                                = $Layout.hermesHome
        HERMES_DESKTOP_USER_DATA_DIR               = $Layout.userData
        HERMES_GATEWAY_LOCK_DIR                    = $Layout.gatewayLocks
        HERMES_DESKTOP_CWD                         = $Layout.workspace
        HERMES_DESKTOP_IGNORE_EXISTING             = '1'
        HERMES_DESKTOP_ISOLATED_BACKEND            = '1'
        HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION  = '1'
        HERMES_DESKTOP_APP_NAME                    = "HermesClarifyCandidate-$sha7"
        HERMES_DATA_DIR_SUFFIX                     = $script:DataDirSuffix
        USERPROFILE                                = $Layout.profile
        HOME                                       = $Layout.profile
        HOMEDRIVE                                  = $homeDrive
        HOMEPATH                                   = $Layout.profile.Substring($homeDrive.Length)
        APPDATA                                    = $Layout.roaming
        LOCALAPPDATA                               = $Layout.local
        TEMP                                       = $Layout.temp
        TMP                                        = $Layout.temp
    }
    foreach ($name in $overrides.Keys) { $environment[$name] = [string]$overrides[$name] }
    return $environment
}

function ConvertTo-WindowsArgument {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Get-PackageAppDirectory {
    # The folder whose processes belong to this package: the one MANIFEST.json puts the product executable in, else
    # app\ (the layout the build ships). Stop needs it even when the manifest is damaged or missing.
    param([string]$PackageRoot)
    try {
        $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PackageRoot 'MANIFEST.json') | ConvertFrom-Json
        $exe = Join-Path $PackageRoot (([string]$manifest.app.exe) -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        return (Split-Path -Parent $exe)
    } catch {
        return (Join-Path $PackageRoot 'app')
    }
}

function Get-CandidateProcesses {
    # Every running process whose image lies inside this package's app directory (the app, its helpers
    # and the background gateway, which is the bundled interpreter). Image path, not window or name: an unrelated
    # program that merely shares a file name is never matched. A process reports the path it was really loaded from,
    # so the folder is also compared as the file system resolves it (an extraction path through a junction or subst).
    param([string]$AppDirectory)
    $prefixes = @(@((Get-NormalPath $AppDirectory), (Get-NormalPath $AppDirectory -Resolve)) | Select-Object -Unique | ForEach-Object { $_ + '\' })
    $found = foreach ($process in Get-CimInstance Win32_Process) {
        if (-not $process.ExecutablePath) { continue }
        $image = Get-NormalPath $process.ExecutablePath
        foreach ($prefix in $prefixes) {
            if ($image.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $process; break }
        }
    }
    return @($found)
}

function Close-CandidateWindows {
    # Asks each listed process that has a window to close it; returns how many were asked. A process that ended since
    # it was listed is not an error: the sweep that follows is what guarantees the outcome.
    param($Rows)
    $asked = 0
    foreach ($row in $Rows) {
        try {
            $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.MainWindowHandle -ne 0) {
                [void]$process.CloseMainWindow()
                $asked++
            }
        } catch {
            Write-Warning ('could not ask process ' + $row.ProcessId + ' to close: ' + $_.Exception.Message)
        }
    }
    return $asked
}

function New-GatewayStopStartInfo {
    # How the packaged CLI is started for `gateway stop --yes`: through cmd.exe, with its input taken from NUL. The CLI
    # then reads an input that has already ended and carries no byte, and can never meet a console nobody can answer.
    # A pipe made by .NET is not that: Windows PowerShell 5.1 builds its stdin writer from Console.InputEncoding and
    # flushes it as the process starts, so whenever the console code page is UTF-8 the child's first input is that
    # encoding's byte-order mark, whatever is done to the pipe afterwards. Output and errors are pipes the caller reads.
    # cmd's /s rule strips the outer quotes, so the CLI's path is quoted on its own; a percent sign in the path would be
    # expanded by cmd, which a folder the package was extracted into does not hold.
    param([string]$Cli, [string]$WorkingDirectory, $Environment)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = [System.IO.Path]::Combine([System.Environment]::SystemDirectory, 'cmd.exe')
    $startInfo.Arguments = '/d /s /c ""' + $Cli + '" gateway stop --yes < NUL"'
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Clear()
    foreach ($name in $Environment.Keys) { $startInfo.EnvironmentVariables[$name] = $Environment[$name] }
    return $startInfo
}

function Invoke-GatewayStop {
    # `hermes gateway stop` for THIS sandbox, from the packaged CLI with the sandbox's environment, so the gateway the
    # app left running can clean up its lock, state and control pipe the way Hermes itself does. A courtesy: the
    # sweep that follows is what guarantees the outcome. So it can never get in the way. It cannot prompt (its input is
    # NUL, see New-GatewayStopStartInfo, and --yes answers the live-session question), cannot hang (it is ended after
    # the timeout) and cannot throw (every failure becomes a line of output). Without a sandbox there is nothing to
    # ask: a start that did not go through the launcher has no sandbox, and its gateway is ended by the sweep.
    param([string]$AppDirectory, $Manifest, $Safety, [int]$TimeoutSeconds = 45)
    try {
        if ($Safety.Problem) { Write-Output ('gateway stop skipped: ' + $Safety.Problem); return }
        $layout = $Safety.Layout
        if (-not (Test-Path -LiteralPath $layout.hermesHome)) {
            Write-Output ('gateway stop skipped: there is no sandbox home at ' + $layout.hermesHome + ' (a start without the launcher, or another -Root)')
            return
        }
        $relative = ([string]$Manifest.app.stamp.runtime.commands.hermes) -replace '/', [System.IO.Path]::DirectorySeparatorChar
        $cli = Join-Path (Join-Path (Join-Path $AppDirectory 'resources') 'agent-payload') $relative
        if (-not (Test-Path -LiteralPath $cli)) { Write-Output ('gateway stop skipped: the packaged CLI ' + $cli + ' is missing'); return }
        $environment = Get-CandidateEnvironment -Layout $layout -Commit ([string]$Manifest.source.commit)
        $workingDirectory = $(if (Test-Path -LiteralPath $layout.temp) { $layout.temp } else { $layout.root })
        $stopper = [System.Diagnostics.Process]::Start((New-GatewayStopStartInfo -Cli $cli -WorkingDirectory $workingDirectory -Environment $environment))
        try {
            $streams = @($stopper.StandardOutput.ReadToEndAsync(), $stopper.StandardError.ReadToEndAsync())
            $finished = $stopper.WaitForExit($TimeoutSeconds * 1000)
            if (-not $finished) {
                try { $stopper.Kill() } catch { Write-Output ('  could not end it: ' + $_.Exception.Message) }
                [void]$stopper.WaitForExit(5000)
            }
            # What a process ended by Kill left behind (a CLI under cmd.exe keeps the pipes open) is the sweep's to end.
            $text = ''
            foreach ($stream in $streams) { if ($stream.Wait($(if ($finished) { 3000 } else { 500 }))) { $text += $stream.Result } }
            if ($finished) { Write-Output ('gateway stop exited with ' + $stopper.ExitCode) }
            else { Write-Output ('gateway stop did not finish within ' + $TimeoutSeconds + ' s and was ended') }
            foreach ($line in @($text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 8)) { Write-Output ('  ' + $line) }
        } finally {
            $stopper.Dispose()
        }
    } catch {
        Write-Output ('gateway stop failed: ' + $_.Exception.Message)
    }
}

function Stop-CandidateProcesses {
    # Ends every process whose image is inside the app folder, then whatever they started meanwhile, until none is
    # left or the time is up. Returns how many distinct processes it ended and the processes still running.
    param([string]$AppDirectory, [int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $ended = New-Object System.Collections.Generic.HashSet[int]
    while ($true) {
        $rows = @(Get-CandidateProcesses $AppDirectory)
        if ($rows.Count -eq 0 -or (Get-Date) -ge $deadline) { break }
        foreach ($row in $rows) {
            [void]$ended.Add([int]$row.ProcessId)
            Stop-Process -Id $row.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 700
    }
    return [pscustomobject]@{ Ended = $ended.Count; Left = $rows }
}
