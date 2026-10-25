# Build at below-normal priority.
#
# Why this exists: Postgres runs on this same machine, and it serves both O3C and
# Phoenix. On 2026-10-22 a session compiling and testing here produced 118 failed
# database connections between 12:19 and 13:33, against 10 for the whole of the
# previous day, and zero on each of the three days afterwards once the building
# stopped. Both the IPv4 and the IPv6 attempt timed out, so those were real refusals
# rather than a harmless retry.
#
# Two things rode on it. The session-token denylist is checked on every request and
# deliberately fails open, so for those minutes a token that had been revoked would
# have been honoured. And the nightly customer-scoring job failed the same way at
# 03:30 that morning: it takes about six seconds, ran past the old fifteen-second
# ceiling under contention, and was recorded as failed although Postgres had committed
# the rebuild.
#
# A build is never more important than the live system. Run it through here.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-low.ps1 [frontend|backend|both]
#
# This file must stay ASCII. PowerShell 5.1 reads a BOM-less file as ANSI, so a dash
# that is not a plain hyphen becomes a curly quote and the whole script fails to parse,
# writing no log at all.

param(
    [ValidateSet('frontend', 'backend', 'both')]
    [string]$Target = 'both'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Invoke-Low {
    param([string]$File, [string[]]$Args, [string]$Cwd, [string]$Label)

    Write-Host "[build-low] $Label starting at BelowNormal priority"
    $p = Start-Process -FilePath $File -ArgumentList $Args -WorkingDirectory $Cwd `
        -PassThru -NoNewWindow
    # Set after launch: Start-Process has no priority parameter. A failure here is not
    # fatal, but it is reported, because a build running at normal priority is the
    # exact thing this script exists to prevent.
    try {
        $p.PriorityClass = 'BelowNormal'
    } catch {
        Write-Warning "[build-low] could not lower priority for $Label - it is running at normal priority"
    }
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) {
        throw "[build-low] $Label failed with exit code $($p.ExitCode)"
    }
    Write-Host "[build-low] $Label done"
}

if ($Target -eq 'frontend' -or $Target -eq 'both') {
    Invoke-Low -File 'npm.cmd' -Args @('run', 'build') `
        -Cwd (Join-Path $repo 'frontend') -Label 'frontend build'
}

if ($Target -eq 'backend' -or $Target -eq 'both') {
    # Writes the staging binary, not the live one. run_backend.ps1 promotes it when the
    # scheduled task is stopped, so building here never swaps a running server.
    Invoke-Low -File 'go.exe' -Args @('build', '-o', 'o3c-backend-new.exe', '.') `
        -Cwd (Join-Path $repo 'backend-go') -Label 'backend build'
}

Write-Host "[build-low] complete"
