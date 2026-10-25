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

# Lower THIS process, and let the build inherit it.
#
# Windows gives a child process its parent's priority class, so this covers npm, node,
# esbuild, go and every compiler they spawn. The earlier version launched each build
# through Start-Process so it could set the priority on the child directly, which works
# but costs the exit code: a process started with -PassThru and no -Wait reads its
# ExitCode back as empty, so a build that succeeded reported itself as failed. Calling
# the tools directly keeps $LASTEXITCODE meaningful, which matters more than setting the
# priority on the child rather than on us.
try {
    (Get-Process -Id $PID).PriorityClass = 'BelowNormal'
    Write-Host "[build-low] priority lowered to BelowNormal; children inherit it"
} catch {
    Write-Warning "[build-low] could not lower priority - the build will run at normal priority"
}

function Invoke-Low {
    # NOT $Args: that is a PowerShell automatic variable holding a function's unbound
    # arguments, so a parameter of that name is silently shadowed and arrives empty.
    param([string]$Label, [scriptblock]$Body)

    Write-Host "[build-low] $Label starting"
    & $Body
    if ($LASTEXITCODE -ne 0) {
        throw "[build-low] $Label failed with exit code $LASTEXITCODE"
    }
    Write-Host "[build-low] $Label done"
}

if ($Target -eq 'frontend' -or $Target -eq 'both') {
    Push-Location (Join-Path $repo 'frontend')
    try { Invoke-Low -Label 'frontend build' -Body { & npm.cmd run build } }
    finally { Pop-Location }
}

if ($Target -eq 'backend' -or $Target -eq 'both') {
    # Writes the staging binary, not the live one. run_backend.ps1 promotes it when the
    # scheduled task is stopped, so building here never swaps a running server.
    Push-Location (Join-Path $repo 'backend-go')
    try { Invoke-Low -Label 'backend build' -Body { & go.exe build -o o3c-backend-new.exe . } }
    finally { Pop-Location }
}

Write-Host "[build-low] complete"
