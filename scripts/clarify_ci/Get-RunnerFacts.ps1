<#
.SYNOPSIS
  Record what the runner is (CPU, memory, free disk per drive, tool versions, Defender state) as JSON.

.DESCRIPTION
  The Windows candidate pipeline builds several gigabytes of files and its budgets are guesses until a real run
  measures them, so every Windows job writes this once, and the package job again after the build. Read-only: it
  changes nothing on the machine. Works in Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER Out
  File to write. Its folder is created.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Out
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-ToolVersion([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    try { return ((& $command.Source --version 2>&1 | Out-String).Trim()) } catch { return $_.Exception.Message }
}

function Get-DefenderState {
    try {
        $status = Get-MpComputerStatus
        return [ordered]@{ antivirus = [bool]$status.AntivirusEnabled; realtime_protection = [bool]$status.RealTimeProtectionEnabled }
    } catch {
        return [ordered]@{ unavailable = $_.Exception.Message }
    }
}

$system = Get-CimInstance Win32_ComputerSystem
$facts = [ordered]@{
    recorded_at   = (Get-Date).ToUniversalTime().ToString('o')
    os            = (Get-CimInstance Win32_OperatingSystem).Caption
    os_version    = [System.Environment]::OSVersion.VersionString
    image_version = $env:ImageVersion
    cpus          = [System.Environment]::ProcessorCount
    memory_gb     = [math]::Round($system.TotalPhysicalMemory / 1GB, 1)
    disks         = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $null -ne $_.Used } | ForEach-Object {
            [ordered]@{ drive = $_.Name; free_gb = [math]::Round($_.Free / 1GB, 1); used_gb = [math]::Round($_.Used / 1GB, 1) }
        })
    tools         = [ordered]@{ python = (Get-ToolVersion 'python'); node = (Get-ToolVersion 'node'); git = (Get-ToolVersion 'git') }
    defender      = Get-DefenderState
}

$folder = Split-Path -Parent $Out
if ($folder) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
$json = $facts | ConvertTo-Json -Depth 6
Set-Content -LiteralPath $Out -Value $json -Encoding UTF8
Write-Output $json
