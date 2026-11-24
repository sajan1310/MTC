<#
.SYNOPSIS
  Copies the server's nightly database snapshots to this laptop, checks each
  one, and keeps a month of them. Run by the scheduled task "MTC backup pull
  (laptop)"; safe to run by hand at any time.

.DESCRIPTION
  The laptop is the copy that leaves the building. The server keeps its own
  snapshots (/opt/mtc/src/backups) and the VMware host pulls them to F:, but
  both live on the same old desktop, so neither survives it. Until 2026-11-24
  the only copy that left automatically was the Google Sheets export -- rows in
  cells, which can be read but not restored. That export is gone; this is its
  replacement, and unlike it every file here restores with pg_restore.

  Each run:
    1. reaches the server over Tailscale (works from anywhere the laptop has
       internet), falling back to the factory LAN address
    2. copies every snapshot the server has that this laptop does not -- so a
       laptop that was off for a week catches up in one run
    3. checks each copy against the server's .sha256 and with pg_restore -l
       before it counts; a bad copy is deleted, never kept
    4. keeps the 60 newest snapshots plus the newest of every month; deletes
       only older dailies, and never because the server no longer has a file
       (a broken server must not be able to empty the laptop)
    5. shows a Windows notice if the newest copy here is more than two days
       old, or if the run failed

  Log: C:\Users\erkar\mtc-backups\pull.log

.PARAMETER KeepDaily
  How many of the newest snapshots to keep (default 60, about 1.3 GB at
  November 2026 sizes). The newest snapshot of each month is kept beyond
  that, for good.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\pull-backups-to-laptop.ps1
#>
[CmdletBinding()]
param(
    [int]$KeepDaily = 60
)

$ErrorActionPreference = 'Stop'

# Tailscale first: the laptop is usually not on the factory Wi-Fi.
$Hosts     = @('mtc-erp@100.93.74.28', 'mtc-erp@192.168.31.86')
$ServerDir = '/opt/mtc/src/backups'
# Deliberately outside OneDrive: a synced folder would upload the whole
# business database to Microsoft's cloud.
$LocalDir  = 'C:\Users\erkar\mtc-backups'
$LogFile   = Join-Path $LocalDir 'pull.log'
$StaleHours = 50
$NamePattern = '^mtc_(\d{8})_(\d{6})\.dump$'

if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir | Out-Null }

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

# A notice in the corner of the screen, for the one thing that must not go
# unnoticed: the laptop no longer getting fresh copies.
function Show-Notice([string]$Title, [string]$Text) {
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $xml.GetElementsByTagName('text')
        $null = $texts.Item(0).AppendChild($xml.CreateTextNode($Title))
        $null = $texts.Item(1).AppendChild($xml.CreateTextNode($Text))
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    } catch {
        Write-Log "  (could not show a notice: $($_.Exception.Message))"
    }
}

function Get-SnapshotTime([string]$Name) {
    if ($Name -notmatch $NamePattern) { return $null }
    return [datetime]::ParseExact("$($Matches[1])$($Matches[2])", 'yyyyMMddHHmmss', $null)
}

function Get-LocalSnapshots {
    Get-ChildItem -Path $LocalDir -Filter 'mtc_*.dump' -File |
        Where-Object { $_.Name -match $NamePattern } |
        Sort-Object Name -Descending
}

# Checks a copy against its sidecar and proves pg_restore can read it.
function Test-Snapshot([string]$DumpPath, [string]$ShaPath) {
    $expected = ((Get-Content $ShaPath -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $DumpPath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { return "checksum mismatch (expected $expected, got $actual)" }
    $null = & pg_restore -l $DumpPath 2>&1
    if ($LASTEXITCODE -ne 0) { return 'pg_restore cannot read it' }
    return $null
}

$failed = $null
try {
    foreach ($tool in 'ssh', 'scp', 'pg_restore') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
    }

    # --- 1. reach the server -------------------------------------------------
    $server = $null
    $listing = $null
    foreach ($candidate in $Hosts) {
        # ConnectTimeout keeps an unreachable address to a few seconds.
        $out = & ssh -o BatchMode=yes -o ConnectTimeout=10 $candidate "ls -1 $ServerDir/" 2>$null
        if ($LASTEXITCODE -eq 0) { $server = $candidate; $listing = $out; break }
    }
    if (-not $server) {
        throw 'Cannot reach the server over Tailscale or the factory LAN. Is Tailscale on?'
    }
    $onServer = @($listing | ForEach-Object { $_.Trim() } | Where-Object { $_ -match $NamePattern } | Sort-Object)
    $sidecars = @($listing | ForEach-Object { $_.Trim() } | Where-Object { $_ -like '*.dump.sha256' })

    # --- 2 and 3. copy what is missing, and check it -------------------------
    $have = @{}
    Get-LocalSnapshots | ForEach-Object { $have[$_.Name] = $true }
    $missing = @($onServer | Where-Object { -not $have.ContainsKey($_) -and $sidecars -contains "$_.sha256" })
    $pulled = 0
    $bad = 0
    foreach ($name in $missing) {
        $dump = Join-Path $LocalDir $name
        $part = "$dump.part"
        $shaPart = "$dump.sha256.part"
        # -q is load-bearing: without it the progress meter kills scp under
        # Task Scheduler (0xC000013A), as on the VMware host's task.
        & scp -q "${server}:$ServerDir/$name.sha256" $shaPart
        if ($LASTEXITCODE -eq 0) { & scp -q "${server}:$ServerDir/$name" $part }
        if ($LASTEXITCODE -ne 0) {
            Remove-Item $part, $shaPart -ErrorAction SilentlyContinue
            Write-Log "  FAILED to copy $name"
            $bad++
            continue
        }
        $problem = Test-Snapshot $part $shaPart
        if ($problem) {
            Remove-Item $part, $shaPart -ErrorAction SilentlyContinue
            Write-Log "  REJECTED $name -- $problem"
            $bad++
            continue
        }
        Move-Item $shaPart "$dump.sha256" -Force
        Move-Item $part $dump -Force
        $pulled++
        Write-Log ('  pulled {0} ({1:N1} MB, checked)' -f $name, ((Get-Item $dump).Length / 1MB))
    }

    # --- 4. keep a month of dailies and one per month ------------------------
    $local = @(Get-LocalSnapshots)
    $keep = @{}
    $local | Select-Object -First $KeepDaily | ForEach-Object { $keep[$_.Name] = $true }
    $local | Group-Object { $_.Name.Substring(4, 6) } | ForEach-Object {
        $keep[($_.Group | Sort-Object Name -Descending | Select-Object -First 1).Name] = $true
    }
    $removed = 0
    foreach ($file in $local) {
        if ($keep.ContainsKey($file.Name)) { continue }
        Remove-Item $file.FullName, "$($file.FullName).sha256" -ErrorAction SilentlyContinue
        $removed++
    }

    $newest = Get-LocalSnapshots | Select-Object -First 1
    Write-Log ("OK via {0}: {1} pulled, {2} rejected, {3} old removed; newest here {4}" -f
        $server, $pulled, $bad, $removed, $(if ($newest) { $newest.Name } else { 'none' }))
    if ($bad -gt 0) { $failed = "$bad snapshot(s) could not be copied or checked." }
} catch {
    $failed = $_.Exception.Message
    Write-Log "FAILED: $failed"
}

# --- 5. say so when the laptop copy is going stale ---------------------------
$newest = Get-LocalSnapshots | Select-Object -First 1
$age = if ($newest) { (Get-Date) - (Get-SnapshotTime $newest.Name) } else { $null }
if (-not $newest -or $age.TotalHours -gt $StaleHours) {
    $days = if ($age) { [math]::Floor($age.TotalDays) } else { 'no' }
    $why = if ($failed) { " Last try: $failed" } else { '' }
    Show-Notice 'MTC backup: laptop copy is out of date' ("The newest database copy on this laptop is $days day(s) old.$why")
}

# Keep the log to its last 2,000 lines.
$lines = @(Get-Content $LogFile -ErrorAction SilentlyContinue)
if ($lines.Count -gt 2000) { $lines | Select-Object -Last 2000 | Set-Content $LogFile -Encoding UTF8 }

if ($failed) { exit 1 }
exit 0
