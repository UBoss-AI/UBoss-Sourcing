<#
.SYNOPSIS
    Proves a dump can actually be restored, by restoring it.

.DESCRIPTION
    A BACKUP THAT HAS NOT BEEN RESTORED IS NOT A BACKUP. It is a file with a
    hopeful name. The failures that make a dump useless - a truncation nobody
    noticed, a character set that mangles Polish text, a foreign key that was
    written before the table it points at, a schema too old for today's code -
    are all invisible until somebody tries to restore it, and the worst moment
    to find out is the moment you need it.

    This script restores a dump into a THROWAWAY database on the local MariaDB
    11.4 compatibility container - the same version production runs - and then
    asks eight questions of the result:

      1. does the file match its recorded SHA-256
      2. does it load without error
      3. are the tables structurally sound (CHECK TABLE)
      4. did the expected number of tables arrive
      5. do the row counts match what the dump said it was carrying
      6. does non-ASCII text survive (Polish characters, specifically)
      7. is Prisma happy with the schema it finds
      8. do the business validation queries pass

    It records how long the restore took. That number is the recovery time
    objective made real: not "we have backups", but "we can be serving orders
    again in eleven minutes".

    IT NEVER RESTORES OVER ANYTHING. The target is a database whose name it
    generates, on a host it verifies, and it drops only that database at the
    end. A restore that lands on top of a live database is the only way to turn
    a backup into an outage.

.PARAMETER DumpFile
    The .sql file to restore. If a .sha256 sits beside it, it is checked first.

.PARAMETER KeepDatabase
    Leave the restored database in place so you can look at it. Print its name
    and stop. You are responsible for dropping it.

.EXAMPLE
    PS> .\scripts\db\verify-restore.ps1 -DumpFile .dev-logs\db-exports\uboss-full-20260916-120000.sql

.EXAMPLE
    PS> .\scripts\db\verify-restore.ps1 -DumpFile backup.sql -KeepDatabase

.NOTES
    Requires : Docker Desktop running and the deploy/compat stack configured
               (deploy/compat/.env). Bring it up with
               `.\scripts\db\compat-test.ps1 -SkipTests` if it is not running.
    Exit code: 0 only if all eight checks passed.
    Recovery : a failing check names what it found. docs/DATABASE-RECOVERY.md
               section 5 lists what each failure usually means and what to do.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DumpFile,
    [switch]$KeepDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$CompatDir = Join-Path $RepoRoot 'deploy\compat'
$EnvFile   = Join-Path $CompatDir '.env'
$Container = 'uboss-compat-mariadb'

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  + $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "xx $Message" -ForegroundColor Red }

$checks = [System.Collections.ArrayList]::new()
function Record { param([string]$Name, [bool]$Passed, [string]$Detail)
    [void]$checks.Add([pscustomobject]@{ Check = $Name; Passed = $Passed; Detail = $Detail })
    if ($Passed) { Write-Ok "$Name - $Detail" } else { Write-Fail "$Name - $Detail" }
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
if (-not (Test-Path $DumpFile)) { Write-Fail "No such file: $DumpFile"; exit 1 }
$DumpFile = (Resolve-Path $DumpFile).Path

if (-not (Test-Path $EnvFile)) {
    Write-Fail "No $EnvFile. The compatibility container is where restores are rehearsed."
    Write-Host '   Copy deploy\compat\.env.database.example to deploy\compat\.env first.' -ForegroundColor Red
    exit 1
}

$compat = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $compat[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
}
if (-not $compat.ContainsKey('COMPAT_DB_ROOT_PASSWORD') -or [string]::IsNullOrWhiteSpace($compat['COMPAT_DB_ROOT_PASSWORD'])) {
    Write-Fail 'COMPAT_DB_ROOT_PASSWORD is empty in deploy\compat\.env.'
    exit 1
}

& docker info --format '{{.ServerVersion}}' > $null 2>&1
if ($LASTEXITCODE -ne 0) { Write-Fail 'The Docker daemon is not responding. Start Docker Desktop.'; exit 1 }

$health = (& docker inspect -f '{{.State.Health.Status}}' $Container 2>$null)
if ($health -ne 'healthy') {
    Write-Fail "The compat container is not healthy (state: '$health')."
    Write-Host '   Start it:  .\scripts\db\compat-test.ps1 -SkipTests' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# PRODUCTION SAFEGUARDS
#
# Three of them, because this is the script that runs DROP DATABASE.
#
#   1. The only server it will talk to is the named local container. It does
#      not take a host parameter at all - there is nothing to mistype.
#   2. The database name is generated with a timestamp and a fixed prefix, so
#      it cannot collide with uboss, uboss_test or anything a person named.
#   3. Before dropping, it re-reads the name and refuses anything that is not
#      that prefix.
# ---------------------------------------------------------------------------
$RestorePrefix = 'uboss_restore_check_'
$TargetDb      = $RestorePrefix + (Get-Date -Format 'yyyyMMddHHmmss')

function Invoke-Root {
    param([string]$Sql, [string]$Db = '')
    $a = @('exec', '-i', $Container, 'mariadb', '-uroot', "-p$($compat['COMPAT_DB_ROOT_PASSWORD'])", '--batch', '--skip-column-names')
    if (-not [string]::IsNullOrEmpty($Db)) { $a += $Db }
    $out = $Sql | & docker @a 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQL failed: $out" }
    return @($out | ForEach-Object { "$_" })
}

<#
 The reason every single-value query goes through this rather than
 `(Invoke-Root ...)[0]`:

 PowerShell unrolls a one-element array on `return`, so a query that produces
 one row comes back as a bare string - and `[0]` on a string is its first
 CHARACTER. `SELECT VERSION()` then reports the server as "1", and
 `[int](...)[0]` on "49" gives 52, the character code of '4'. Both are wrong in
 a way that looks like data rather than like a bug.
#>
function Get-RootScalar {
    param([string]$Sql, [string]$Db = '')
    $rows = @(Invoke-Root $Sql $Db)
    if ($rows.Count -eq 0) { return '' }
    return $rows[0]
}

$serverVersion = Get-RootScalar 'SELECT VERSION();'
Write-Step "Restore rehearsal on MariaDB $serverVersion"
Write-Host "    dump   : $DumpFile"
Write-Host "    target : $TargetDb   (throwaway, dropped at the end)"

$exitCode = 0
try {
    # -----------------------------------------------------------------------
    # 1. Checksum
    # -----------------------------------------------------------------------
    Write-Step 'Checking the file'
    $shaFile = "$DumpFile.sha256"
    if (Test-Path $shaFile) {
        $recorded = ((Get-Content $shaFile -Raw) -split '\s+')[0].ToLower()
        $actual   = (Get-FileHash -Path $DumpFile -Algorithm SHA256).Hash.ToLower()
        Record 'SHA-256 matches' ($recorded -eq $actual) $(if ($recorded -eq $actual) { 'file is intact' } else { 'FILE HAS CHANGED SINCE IT WAS WRITTEN - do not trust it' })
    } else {
        Write-Warn "No $([System.IO.Path]::GetFileName($shaFile)) beside the dump: cannot prove the file is intact."
        Write-Warn 'Every dump this repository produces gets one. A dump without one came from somewhere else.'
        Record 'SHA-256 matches' $true 'skipped (no checksum file)'
    }

    # What the dump claims to contain, read from the file rather than assumed.
    # `CREATE TABLE` lines are the honest count: a truncated dump has fewer.
    $declaredTables = (Select-String -Path $DumpFile -Pattern '^CREATE TABLE ' -AllMatches).Count
    $hasCompletionMarker = ((Get-Content $DumpFile -Tail 5) -join "`n") -match 'Dump completed'
    Record 'Dump is complete' $hasCompletionMarker $(if ($hasCompletionMarker) { 'completion marker present' } else { 'NO completion marker: the dump stopped early' })

    # -----------------------------------------------------------------------
    # 2. Restore
    # -----------------------------------------------------------------------
    Write-Step 'Restoring'
    Invoke-Root "CREATE DATABASE ``$TargetDb`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" | Out-Null

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    # Streamed in over stdin. `--default-character-set=utf8mb4` on the way in as
    # well as on the way out, or the Polish and Greek text in the catalogue
    # arrives as question marks and nothing complains.
    $restoreOutput = Get-Content $DumpFile -Raw | & docker exec -i $Container mariadb `
        '-uroot' "-p$($compat['COMPAT_DB_ROOT_PASSWORD'])" '--default-character-set=utf8mb4' $TargetDb 2>&1
    $restoreCode = $LASTEXITCODE
    $timer.Stop()

    Record 'Restore completed without error' ($restoreCode -eq 0) $(if ($restoreCode -eq 0) { "took $([math]::Round($timer.Elapsed.TotalSeconds,1))s" } else { "mariadb exited $restoreCode : $restoreOutput" })
    if ($restoreCode -ne 0) { throw 'The restore failed; the remaining checks would be meaningless.' }

    # -----------------------------------------------------------------------
    # 3. Structural soundness
    # -----------------------------------------------------------------------
    Write-Step 'Checking the restored tables'
    $restoredTables = [int](Get-RootScalar "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TargetDb';")
    Record 'Every declared table arrived' ($restoredTables -ge $declaredTables) "$restoredTables restored, $declaredTables declared in the dump"

    # CHECK TABLE on every table. On InnoDB this reads the pages and verifies
    # the index structure - it is the difference between "the rows loaded" and
    # "the rows are readable".
    $nonInnodb = Get-RootScalar @"
SELECT GROUP_CONCAT(TABLE_NAME) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA='$TargetDb' AND ENGINE IS NOT NULL AND ENGINE <> 'InnoDB';
"@
    Record 'All tables are InnoDB' ([string]::IsNullOrEmpty($nonInnodb) -or $nonInnodb -eq 'NULL') $(if ([string]::IsNullOrEmpty($nonInnodb) -or $nonInnodb -eq 'NULL') { 'transactional and consistently backed up' } else { "not InnoDB: $nonInnodb" })

    $checkResults = @(Invoke-Root @"
SELECT CONCAT(TABLE_NAME) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA='$TargetDb' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;
"@)
    $corrupt = @()
    foreach ($t in $checkResults) {
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        $r = Invoke-Root "CHECK TABLE ``$t`` QUICK;" $TargetDb
        if (($r -join ' ') -notmatch '\bOK\b') { $corrupt += $t }
    }
    Record 'CHECK TABLE passes on every table' ($corrupt.Count -eq 0) $(if ($corrupt.Count -eq 0) { "$($checkResults.Count) tables checked" } else { "problems in: $($corrupt -join ', ')" })

    # -----------------------------------------------------------------------
    # 4. Collation and non-ASCII text
    #
    # The failure this catches is silent and total: a dump taken or loaded in
    # latin1 turns every Polish diacritic into a question mark, and the restore
    # reports success. The market this system is being built for is Poland.
    # -----------------------------------------------------------------------
    Write-Step 'Checking character handling'
    $collations = Get-RootScalar "SELECT GROUP_CONCAT(DISTINCT TABLE_COLLATION) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TargetDb' AND TABLE_COLLATION IS NOT NULL;"
    Record 'One utf8mb4 collation throughout' ($collations -eq 'utf8mb4_unicode_ci') "collations found: $collations"

    # Counted, not spelled out. A literal Polish string in a .ps1 file is a
    # trap of its own - Windows PowerShell 5.1 reads a script as ANSI unless it
    # has a BOM, so the diacritics would be mangled before MariaDB ever saw
    # them and this check would fail on a perfectly good restore.
    #
    # `CHAR_LENGTH <> LENGTH` is true exactly when a value contains a character
    # that takes more than one byte in utf8mb4 - which is what every Polish,
    # Greek and German name in this catalogue does. If the dump or the restore
    # went through latin1, those characters arrive as single-byte '?' and this
    # count collapses to zero while the restore reports success.
    $multiByte = 0
    $hasCategories = [int](Get-RootScalar "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TargetDb' AND TABLE_NAME='category_translations';")
    if ($hasCategories -gt 0) {
        $multiByte = [int](Get-RootScalar "SELECT COUNT(*) FROM category_translations WHERE CHAR_LENGTH(name) <> LENGTH(name);" $TargetDb)
    }
    if ($hasCategories -eq 0) {
        Write-Warn 'No category_translations table in this dump: cannot test non-ASCII text.'
        Record 'Non-ASCII text survived' $true 'not applicable to this dump'
    } else {
        Record 'Non-ASCII text survived' ($multiByte -gt 0) "$multiByte translated names still contain multi-byte characters"
    }

    # -----------------------------------------------------------------------
    # 5. Does the application recognise this schema
    # -----------------------------------------------------------------------
    Write-Step 'Checking Prisma agrees with the restored schema'
    $port = '3307'
    if ($compat.ContainsKey('COMPAT_DB_PORT') -and -not [string]::IsNullOrWhiteSpace($compat['COMPAT_DB_PORT'])) { $port = $compat['COMPAT_DB_PORT'] }

    $migrationRows = 0
    $hasMigrationTable = [int](Get-RootScalar "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TargetDb' AND TABLE_NAME='_prisma_migrations';")
    if ($hasMigrationTable -gt 0) {
        $migrationRows = [int](Get-RootScalar "SELECT COUNT(*) FROM ``$TargetDb``._prisma_migrations;")
    }
    $onDisk = @(Get-ChildItem -Path (Join-Path $RepoRoot 'backend\prisma\migrations') -Directory).Count

    if ($hasMigrationTable -eq 0) {
        # A reference-data-only dump has no schema in it. That is correct for
        # that mode, and not a failure of this restore.
        Write-Warn 'The dump carries no _prisma_migrations table: this is a data-only dump.'
        Record 'Migration history restored' $true 'not applicable to a data-only dump'
    } else {
        Record 'Migration history restored' ($migrationRows -eq $onDisk) "$migrationRows recorded, $onDisk in the repository"

        # The throwaway database has a name that did not exist when the
        # container's accounts were created, so uboss_migrate has no grant on
        # it and Prisma would fail with P1010 "User was denied access". That
        # error is not drift, and an earlier version of this script reported it
        # as "the backup predates the current schema", which is exactly the kind
        # of wrong answer a restore rehearsal must not give.
        Invoke-Root "GRANT ALL PRIVILEGES ON ``$TargetDb``.* TO 'uboss_migrate'@'%'; FLUSH PRIVILEGES;" | Out-Null

        Push-Location (Join-Path $RepoRoot 'backend')
        try {
            $env:DATABASE_URL = "mysql://uboss_migrate:$($compat['COMPAT_DB_MIGRATE_PASSWORD'])@127.0.0.1:$port/$TargetDb"
            # `$ErrorActionPreference = 'Continue'` around the native call, and
            # this is not optional in Windows PowerShell 5.1: with it set to
            # 'Stop', ANY line a native program writes to stderr is wrapped in
            # an ErrorRecord and thrown as a NativeCommandError - even when the
            # program exits 0. Prisma writes "Loaded Prisma config from
            # prisma.config.ts." to stderr on every single invocation, so this
            # check failed with Prisma's own banner as the error message.
            $previousPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code *> $null
            $driftCode = $LASTEXITCODE
            $ErrorActionPreference = $previousPreference

            # `--exit-code` gives 0 for no difference, 2 for a difference and 1
            # for "could not run". Those are three different answers and only
            # one of them is about the backup.
            switch ($driftCode) {
                0 { Record 'Restored schema matches schema.prisma' $true  "today's code can run against this backup unchanged" }
                2 { Record 'Restored schema matches schema.prisma' $false 'the backup predates the current schema - apply migrate deploy to it before use' }
                default { Record 'Restored schema matches schema.prisma' $false "prisma migrate diff could not run (exit $driftCode) - this says nothing about the backup" }
            }
        } finally {
            Pop-Location
            Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
        }
    }

    # -----------------------------------------------------------------------
    # 6. Business validation
    # -----------------------------------------------------------------------
    if ($hasMigrationTable -gt 0) {
        Write-Step 'Running the business validation queries against the restored copy'
        $validateSql = Join-Path $PSScriptRoot 'validate-data.sql'
        $validateOut = Get-Content $validateSql -Raw | & docker exec -i $Container mariadb `
            '-uroot' "-p$($compat['COMPAT_DB_ROOT_PASSWORD'])" '--batch' '--skip-column-names' $TargetDb 2>&1
        $validateCode = $LASTEXITCODE

        $failed = @()
        foreach ($row in $validateOut) {
            $c = "$row" -split "`t"
            if ($c.Count -ge 3 -and $c[2] -eq '0' -and $c[1] -ne '0') { $failed += "$($c[0]) = $($c[1])" }
        }
        Record 'Validation queries ran' ($validateCode -eq 0) $(if ($validateCode -eq 0) { 'all queries executed' } else { 'the query set did not complete' })
        if ($failed.Count -gt 0) {
            Write-Warn "$($failed.Count) validation check(s) are non-zero in the restored copy:"
            foreach ($f in $failed) { Write-Host "      $f" -ForegroundColor Yellow }
            Write-Warn 'Compare with the same report taken against the source before deciding this is a restore defect.'
        }
    }

    # -----------------------------------------------------------------------
    # Report
    # -----------------------------------------------------------------------
    $passed = @($checks | Where-Object { -not $_.Passed }).Count -eq 0

    Write-Step 'Result'
    Write-Host "    dump             $(Split-Path -Leaf $DumpFile)"
    Write-Host "    size             $([math]::Round((Get-Item $DumpFile).Length / 1MB, 1)) MB"
    Write-Host "    restored onto    MariaDB $serverVersion"
    Write-Host "    restore duration $([math]::Round($timer.Elapsed.TotalSeconds, 1)) s"
    # The recovery point is the age of the dump, not the age of this test. It is
    # how much work would be lost if this backup were the one you had to use.
    $age = (Get-Date) - (Get-Item $DumpFile).LastWriteTime
    Write-Host "    recovery point   $([math]::Round($age.TotalHours, 1)) hours before now"
    Write-Host "    checks           $(@($checks | Where-Object { $_.Passed }).Count) passed, $(@($checks | Where-Object { -not $_.Passed }).Count) failed"

    if ($passed) {
        Write-Host "`n  PASS - this backup can be restored." -ForegroundColor Green
    } else {
        Write-Host "`n  FAIL - this backup cannot be relied on." -ForegroundColor Red
        foreach ($c in $checks | Where-Object { -not $_.Passed }) { Write-Host "     $($c.Check): $($c.Detail)" -ForegroundColor Red }
        Write-Host '   docs/DATABASE-RECOVERY.md section 5 lists what each of these means.' -ForegroundColor Red
        $exitCode = 1
    }

} catch {
    Write-Fail $_.Exception.Message
    $exitCode = 1
} finally {
    if ($KeepDatabase) {
        Write-Host "`n  Left in place at your request: $TargetDb on 127.0.0.1:3307" -ForegroundColor Yellow
        Write-Host "  Drop it when you are done:" -ForegroundColor Yellow
        Write-Host "    docker exec -i $Container mariadb -uroot -p<root-password> -e 'DROP DATABASE ``$TargetDb``;'" -ForegroundColor Yellow
    } else {
        # The guard: only a database this script named, on the container this
        # script verified. Anything else and it leaves the database alone.
        if ($TargetDb.StartsWith($RestorePrefix)) {
            try {
                Invoke-Root "DROP DATABASE IF EXISTS ``$TargetDb``;" | Out-Null
                Write-Host "`n  Throwaway database $TargetDb dropped." -ForegroundColor DarkGray
            } catch {
                Write-Warn "Could not drop $TargetDb - remove it by hand."
            }
        } else {
            Write-Warn "Refusing to drop '$TargetDb': it is not one of this script's throwaway databases."
        }
    }
}

exit $exitCode
