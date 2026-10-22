# Shared by Start-HermesClarifyCandidate.ps1 and Stop-HermesClarifyCandidate.ps1 (dot-sourced; functions only).
#
# What this guarantees, for every way the candidate is started through its launcher:
#   * every state location Hermes and Electron use is a directory inside ONE disposable sandbox root;
#   * the sandbox is never, never inside, and never an ancestor of a real Hermes location of the
#     current user (default home, legacy home, installed app's user data and updater cache, any
#     HERMES_HOME the user or the machine has set);
#   * the candidate gets a fresh environment: no credentials, no HERMES_*/PYTHON*/NODE*/ELECTRON* leakage.
# Exit codes: 2 unsafe location, 3 package integrity, 4 not a candidate-shaped build, 5 start failure.

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
    param([string]$Path)
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
using System.Text;
using System.Runtime.InteropServices;
public static class HermesCandidateNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint bufferLength);
}
'@
        }
        $buffer = New-Object System.Text.StringBuilder 32768
        $length = [HermesCandidateNative]::GetLongPathNameW($existing, $buffer, [uint32]$buffer.Capacity)
        if ($length -gt 0 -and $length -lt $buffer.Capacity) { $existing = $buffer.ToString() }
    } catch {
        # Short-name expansion is an extra; the case-insensitive full-path comparison still applies.
    }
    return ($existing.TrimEnd([char]92, [char]47) + $tail)
}

function Test-SameOrInside {
    param([string]$Path, [string]$Parent)
    if ([string]::IsNullOrEmpty($Path) -or [string]::IsNullOrEmpty($Parent)) { return $false }
    if ($Path.Equals($Parent, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $Path.StartsWith($Parent + '\', [System.StringComparison]::OrdinalIgnoreCase)
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
        if ($entry[0]) { $locations.Add(@{ Path = (Get-NormalPath (Join-Path $entry[0] $entry[1])); Why = $entry[2] }) }
    }
    $explicit = @(
        @($env:HERMES_HOME, 'HERMES_HOME in the current environment'),
        @((Get-RegistryHermesHome 'HKCU:\Environment'), 'HERMES_HOME saved in the user environment'),
        @((Get-RegistryHermesHome 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'), 'HERMES_HOME saved in the machine environment')
    )
    foreach ($entry in $explicit) {
        if ($entry[0] -and [System.IO.Path]::IsPathRooted($entry[0])) {
            $locations.Add(@{ Path = (Get-NormalPath $entry[0]); Why = $entry[1] })
        }
    }
    return ,$locations.ToArray()
}

function Get-ProfileContainers {
    # The sandbox may sit INSIDE these (the default root is under LOCALAPPDATA) but must not equal or contain them.
    $containers = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @(@($env:USERPROFILE, 'the user profile'), @($env:APPDATA, 'the roaming profile'), @($env:LOCALAPPDATA, 'the local profile'))) {
        if ($entry[0]) { $containers.Add(@{ Path = (Get-NormalPath $entry[0]); Why = $entry[1] }) }
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
    }
}

function Assert-SafeSandbox {
    param([string]$Root)
    if (-not $Root -or $Root -notmatch '^[A-Za-z]:\\') {
        Stop-Refused 2 "the sandbox root '$Root' is not an absolute local path (for example C:\Users\you\AppData\Local\HermesClarifyCandidate)."
    }
    $rootFull = Get-NormalPath $Root
    $layout = Get-SandboxLayout $rootFull
    $realLocations = Get-RealHermesLocations
    foreach ($real in $realLocations) {
        if ((Test-SameOrInside $rootFull $real.Path) -or (Test-SameOrInside $real.Path $rootFull)) {
            Stop-Refused 2 "the sandbox root '$rootFull' is, is inside, or contains $($real.Why) ($($real.Path))."
        }
    }
    foreach ($container in (Get-ProfileContainers)) {
        if (Test-SameOrInside $container.Path $rootFull) {
            Stop-Refused 2 "the sandbox root '$rootFull' is, or contains, $($container.Why) ($($container.Path))."
        }
    }
    foreach ($name in @('root', 'userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp')) {
        if (Test-ReparsePoint $layout[$name]) {
            Stop-Refused 2 "'$($layout[$name])' is a link or junction; the sandbox must be a plain directory tree."
        }
    }
    if ((Test-Path -LiteralPath $rootFull) -and -not (Test-Path -LiteralPath (Join-Path $rootFull $script:SandboxMarker))) {
        if (@(Get-ChildItem -LiteralPath $rootFull -Force).Count -gt 0) {
            Stop-Refused 2 "'$rootFull' exists, is not empty and is not a candidate sandbox (it has no $script:SandboxMarker marker)."
        }
    }
    return @{ Layout = $layout; RealLocations = $realLocations }
}

function Initialize-Sandbox {
    param($Layout, [string]$Commit)
    foreach ($name in @('root', 'userData', 'hermesHome', 'profile', 'roaming', 'local', 'temp')) {
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
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $exe = Join-Path $PackageRoot (($manifest.app.exe) -replace '/', '\')
    if (-not (Test-Path -LiteralPath $exe)) { Stop-Refused 3 "the product executable '$exe' named by MANIFEST.json is missing." }
    if (-not $SkipHashCheck) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
        if ($actual -cne $manifest.app.exe_sha256) { Stop-Refused 3 "'$exe' does not match the sha256 in MANIFEST.json (found $actual); the package was altered or damaged." }
    }
    $stampPath = Join-Path (Split-Path -Parent $exe) 'resources\install-stamp.json'
    if (-not (Test-Path -LiteralPath $stampPath)) { Stop-Refused 4 "'$stampPath' is missing; this is not a bundled candidate build." }
    $stamp = Get-Content -Raw -LiteralPath $stampPath | ConvertFrom-Json
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
    $drop = '^(?:PYTHON|VIRTUAL_ENV|CONDA|NODE_|NPM_|ELECTRON_|VITE_|UV_|PM_|HERMES_|GITHUB_|RUNNER_|ACTIONS_)'
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

function Get-CandidateProcesses {
    # Every running process whose image lies inside this package's app directory (the app, its helpers
    # and the background gateway, which is the bundled interpreter). Image path, not window or name.
    param([string]$AppDirectory)
    $prefix = (Get-NormalPath $AppDirectory) + '\'
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and ((Get-NormalPath $_.ExecutablePath).StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))
    })
}
