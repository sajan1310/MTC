<#
.SYNOPSIS
  Pulls the newest verified snapshot from the production server and restores it
  over the local development database.

.DESCRIPTION
  The server at 192.168.31.86 is the sole system of record -- the Flask ERP is
  the only place data is entered. This script makes the laptop's copy match it:

    1. asks the server for its newest mtc_*.dump
    2. copies the dump and its .sha256 sidecar to C:\Users\erkar\mtc-backups
    3. re-verifies the checksum locally -- a truncated copy is caught here, not
       halfway through a restore
    4. dumps the CURRENT local database first, so this is reversible
    5. drops and recreates the local database and restores into it

  Steps 1-3 are the same contract as the nightly "MTC backup pull" task on the
  VMware host: OK means verified, not merely copied.

  The dump's objects are owned by the server's `mtc` role, which does not exist
  on this laptop, so the restore passes --no-owner --no-privileges.
  --exit-on-error means a partial restore fails loudly instead of leaving a
  half-populated database that looks fine until a query returns a wrong number.

.PARAMETER Snapshot
  Restore a specific dump instead of the newest (a filename, e.g.
  mtc_20260907_190819.dump). It is pulled from the server if not already local.

.PARAMETER Database
  Local database to overwrite. Defaults to MTC, the one Project-root/.env
  points the app at.

.PARAMETER PullOnly
  Copy and verify the dump, then stop. Nothing local is touched.

.PARAMETER SkipSafetyDump
  Skip step 4. Only sensible when the local database is already disposable.

.EXAMPLE
  .\scripts\refresh-local-db.ps1
  .\scripts\refresh-local-db.ps1 -PullOnly
  .\scripts\refresh-local-db.ps1 -Snapshot mtc_20260905_131150.dump
#>
[CmdletBinding()]
param(
    [string]$Snapshot,
    [string]$Database = 'MTC',
    [switch]$PullOnly,
    [switch]$SkipSafetyDump
)

$ErrorActionPreference = 'Stop'

$Server    = 'mtc-erp@192.168.31.86'
$ServerDir = '/opt/mtc/src/backups'
# Deliberately outside OneDrive: a synced folder would upload the whole
# business database to Microsoft's cloud.
$LocalDir  = 'C:\Users\erkar\mtc-backups'
$SafetyDir = Join-Path $LocalDir 'local-safety'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$EnvFile   = Join-Path $RepoRoot 'Project-root\.env'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }

# Windows PowerShell strips embedded double quotes when it hands an argument to
# a native .exe, so `psql -c 'CREATE DATABASE "MTC"'` arrives as
# `CREATE DATABASE MTC` -- which Postgres folds to lowercase and applies to a
# DIFFERENT database. That is how this script once dropped the unrelated `mtc`
# database while believing it was recreating `MTC`. SQL therefore goes in over
# stdin, where nothing rewrites it.
function Invoke-Sql {
    param([string]$Sql, [string]$Db = 'postgres', [string[]]$ExtraArgs = @())
    $Sql | psql -U $script:dbUser -h $script:dbHost -p $script:dbPort -d $Db `
                -v ON_ERROR_STOP=1 -q @ExtraArgs -f -
}

# --- credentials -----------------------------------------------------------
# Read from Project-root/.env rather than hardcoding, so this script does not
# become a second place the password has to be changed.
if (-not (Test-Path $EnvFile)) { throw "No $EnvFile -- cannot find the local DB password." }
$envVars = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $envVars[$Matches[1]] = $Matches[2] }
}
$dbHost = if ($envVars['DB_HOST']) { $envVars['DB_HOST'] } else { '127.0.0.1' }
$dbPort = if ($envVars['DB_PORT']) { $envVars['DB_PORT'] } else { '5432' }
$dbUser = if ($envVars['DB_USER']) { $envVars['DB_USER'] } else { 'postgres' }
if (-not $envVars['DB_PASS']) { throw "DB_PASS not found in $EnvFile" }
$env:PGPASSWORD = $envVars['DB_PASS']

foreach ($tool in 'psql', 'pg_dump', 'pg_restore', 'ssh', 'scp') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
}
if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir | Out-Null }

# --- 1. choose the snapshot ------------------------------------------------
if (-not $Snapshot) {
    Step "Asking $Server for its newest snapshot"
    # ConnectTimeout keeps an off-network run to a few seconds. Without it the
    # laptop sits in a TCP connect for over a minute every time it is run on
    # any Wi-Fi other than the factory's -- the common case for a laptop.
    # `ls -t` is newest first; the glob keeps the .sha256 sidecars out.
    $Snapshot = (ssh -o BatchMode=yes -o ConnectTimeout=10 $Server "ls -t $ServerDir/mtc_*.dump | head -1") -replace '.*/', ''
    if ($LASTEXITCODE -ne 0 -or -not $Snapshot) {
        throw "Cannot reach $Server. The server is on the factory LAN (192.168.31.x) and is not reachable from other networks -- connect to the factory Wi-Fi and re-run. Nothing local was changed."
    }
}
Ok "snapshot: $Snapshot"

$dumpPath = Join-Path $LocalDir $Snapshot
$shaPath  = "$dumpPath.sha256"

# --- 2. pull ---------------------------------------------------------------
if (Test-Path $dumpPath) {
    Ok 'already present locally; re-verifying rather than re-copying'
} else {
    Step "Copying to $LocalDir"
    # -q is load-bearing: without it the progress meter kills the equivalent
    # scheduled task on the VMware host with 0xC000013A and no log line at all.
    scp -q "${Server}:$ServerDir/$Snapshot" $dumpPath
    if ($LASTEXITCODE -ne 0) { throw "scp of $Snapshot failed." }
    scp -q "${Server}:$ServerDir/$Snapshot.sha256" $shaPath
    if ($LASTEXITCODE -ne 0) { throw "scp of the .sha256 sidecar failed." }
    Ok ('copied {0:N1} MB' -f ((Get-Item $dumpPath).Length / 1MB))
}

# --- 3. verify -------------------------------------------------------------
Step 'Verifying checksum'
$expected = ((Get-Content $shaPath -Raw).Trim() -split '\s+')[0]
$actual   = (Get-FileHash $dumpPath -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) {
    throw "CHECKSUM MISMATCH for $Snapshot`n  expected $expected`n  got      $actual`nThe copy is corrupt. Delete it and re-run."
}
Ok "sha256 OK ($actual)"

# pg_restore -l proves the archive is readable, without a server to restore into.
$toc = pg_restore -l $dumpPath
if ($LASTEXITCODE -ne 0) { throw "pg_restore cannot read $Snapshot." }
Ok "archive readable, $(($toc | Where-Object { $_ -notmatch '^;' }).Count) TOC entries"

if ($PullOnly) {
    Step 'PullOnly: stopping here. Nothing local was changed.'
    return
}

# --- 4. safety dump of what is about to be replaced ------------------------
$exists = "SELECT 1 FROM pg_database WHERE datname = '$Database';" |
    psql -U $dbUser -h $dbHost -p $dbPort -d postgres -tA -f -
if ($exists -eq '1' -and -not $SkipSafetyDump) {
    if (-not (Test-Path $SafetyDir)) { New-Item -ItemType Directory -Path $SafetyDir | Out-Null }
    $safety = Join-Path $SafetyDir ("local_{0}_{1}.dump" -f $Database, (Get-Date -Format 'yyyyMMdd_HHmmss'))
    Step "Dumping the current local $Database first (the restore below is destructive)"
    pg_dump -U $dbUser -h $dbHost -p $dbPort -d $Database -Fc -Z9 -f $safety
    if ($LASTEXITCODE -ne 0) { throw "Safety dump failed -- refusing to drop $Database." }
    Ok "safety copy: $safety"
} elseif ($SkipSafetyDump) {
    Write-Host '    skipping safety dump (-SkipSafetyDump)' -ForegroundColor Yellow
}

# --- 5. restore ------------------------------------------------------------
Step "Recreating $Database"
# WITH (FORCE) terminates whatever is still connected -- typically a Flask dev
# server left running. Without it the DROP simply blocks until it is closed.
Invoke-Sql "DROP DATABASE IF EXISTS ""$Database"" WITH (FORCE);"
if ($LASTEXITCODE -ne 0) { throw "Could not drop $Database." }
Invoke-Sql "CREATE DATABASE ""$Database"";"
if ($LASTEXITCODE -ne 0) { throw "Could not create $Database." }

# Prove the identifier quoting survived: a fresh database has no erp schema.
# If it has one, the DROP/CREATE landed somewhere other than $Database and the
# restore must not proceed.
$stray = "SELECT count(*) FROM pg_namespace WHERE nspname = 'erp';" |
    psql -U $dbUser -h $dbHost -p $dbPort -d $Database -tA -f -
if ($stray -ne '0') {
    throw "$Database still contains an erp schema after being recreated -- the DROP/CREATE did not target it. Aborting before the restore."
}

Step "Restoring $Snapshot into $Database"
pg_restore -U $dbUser -h $dbHost -p $dbPort -d $Database --no-owner --no-privileges --exit-on-error $dumpPath
if ($LASTEXITCODE -ne 0) { throw "Restore failed. The safety dump above still holds the previous local data." }
Ok 'restored with no errors'

# --- report ----------------------------------------------------------------
Step "Row counts now in local $Database"
$counts = @"
SELECT 'users' AS relation, count(*) FROM public.users
UNION ALL SELECT 'items',            count(*) FROM erp.items
UNION ALL SELECT 'stock',            count(*) FROM erp.stock
UNION ALL SELECT 'production',       count(*) FROM erp.production
UNION ALL SELECT 'bill_headers',     count(*) FROM erp.bill_headers
UNION ALL SELECT 'po_headers',       count(*) FROM erp.po_headers
UNION ALL SELECT 'dispatch_headers', count(*) FROM erp.dispatch_headers;
"@
$counts | psql -U $dbUser -h $dbHost -p $dbPort -d $Database -f -

Write-Host ''
Write-Host "Local $Database now matches the server as of $Snapshot." -ForegroundColor Green
