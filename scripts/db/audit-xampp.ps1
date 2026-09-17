<#
.SYNOPSIS
    Reads the local XAMPP MariaDB and writes a compatibility report.

.DESCRIPTION
    READ-ONLY. Every statement it runs is a SELECT or a SHOW; it creates
    nothing, changes nothing and drops nothing. Run it before touching
    anything to do with the production database, because every decision in
    docs/DATABASE-PRODUCTION.md depends on knowing what is actually installed
    here rather than what the documentation remembers.

    It answers, in one pass:

      * which MariaDB this is, exactly
      * the character set, the collation and the SQL mode - the three settings
        that differ between XAMPP and production and change behaviour, not speed
      * what the schema is made of: tables, engines, foreign keys, checks,
        views, triggers, routines, events, generated columns, full-text indexes
      * whether any money column is stored as a float
      * how the Prisma migration history compares with the committed files
      * which accounts exist and whether any of them has no password

    NO ROW CONTENTS ARE READ. The report counts rows; it never looks at one.
    No password is printed, and no password is passed on a command line where
    another process could read it out of the process list.

.PARAMETER OutputPath
    Where the JSON report goes. Defaults to a timestamped file under
    `.dev-logs/db-audit/`, which is gitignored.

.PARAMETER Database
    The database to inspect. Defaults to the one in backend/.env.

.EXAMPLE
    PS> .\scripts\db\audit-xampp.ps1

.EXAMPLE
    PS> .\scripts\db\audit-xampp.ps1 -Database uboss_test -OutputPath C:\temp\audit.json

.NOTES
    Requires : XAMPP's MariaDB client (C:\xampp\mysql\bin\mysql.exe), running
               MariaDB service, and backend/.env with a DATABASE_URL.
    Exit code: 0 if the audit completed, 1 if it could not.
    Recovery : "Can't connect" almost always means the MariaDB service is
               stopped - start it from the XAMPP Control Panel. "Access
               denied" means backend/.env's DATABASE_URL no longer matches the
               account; fix the file, not this script.
#>
[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$Database
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "xx $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Locate the client
#
# XAMPP 10.4 ships the mysql-named binaries; MariaDB 11.4 ships only the
# mariadb-named ones. Look for both rather than assuming, because this same
# script is useful pointed at the compatibility container.
# ---------------------------------------------------------------------------
$clientCandidates = @(
    'C:\xampp\mysql\bin\mariadb.exe',
    'C:\xampp\mysql\bin\mysql.exe',
    'D:\xampp\mysql\bin\mariadb.exe',
    'D:\xampp\mysql\bin\mysql.exe'
)
$Client = $null
foreach ($candidate in $clientCandidates) {
    if (Test-Path $candidate) { $Client = $candidate; break }
}
if ($null -eq $Client) {
    $onPath = Get-Command mariadb, mysql -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $onPath) { $Client = $onPath.Source }
}
if ($null -eq $Client) {
    Write-Fail 'No MariaDB client found. Looked in C:\xampp\mysql\bin, D:\xampp\mysql\bin and on PATH.'
    exit 1
}

# ---------------------------------------------------------------------------
# Read the connection from backend/.env
#
# Parsed, never echoed. The host, port, user and database are shown so that it
# is obvious which database is being read; the password is not shown, is not
# put on a command line, and is written only to a defaults file that this
# script deletes before it exits.
# ---------------------------------------------------------------------------
$EnvFile = Join-Path $RepoRoot 'backend\.env'
if (-not (Test-Path $EnvFile)) {
    Write-Fail "No backend\.env. Copy backend\.env.example to backend\.env first."
    exit 1
}

$urlLine = Select-String -Path $EnvFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
if ($null -eq $urlLine) {
    Write-Fail 'backend\.env has no DATABASE_URL.'
    exit 1
}
$rawUrl = ($urlLine.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")

try {
    $uri = [System.Uri]$rawUrl
} catch {
    Write-Fail 'DATABASE_URL is not a URL. Expected mysql://user:password@host:port/database'
    exit 1
}

$DbHost = $uri.Host
$DbPort = $uri.Port
if ($DbPort -le 0) { $DbPort = 3306 }
$userInfo = $uri.UserInfo -split ':', 2
$DbUser = [System.Uri]::UnescapeDataString($userInfo[0])
$DbPass = ''
if ($userInfo.Count -gt 1) { $DbPass = [System.Uri]::UnescapeDataString($userInfo[1]) }
if ([string]::IsNullOrEmpty($Database)) { $Database = $uri.AbsolutePath.TrimStart('/') }

# ---------------------------------------------------------------------------
# PRODUCTION SAFEGUARD
#
# This script is read-only, so pointing it at production would do no damage -
# but it would put a production password into a file on a development laptop,
# and that is the thing worth refusing. Loopback only.
# ---------------------------------------------------------------------------
if ($DbHost -notin @('127.0.0.1', 'localhost', '::1')) {
    Write-Fail "DATABASE_URL points at '$DbHost'. This script is for the local development database only."
    Write-Host '   Auditing a remote or production database from a laptop means writing its' -ForegroundColor Red
    Write-Host '   password to a file here. Use an SSH session on that machine instead -' -ForegroundColor Red
    Write-Host '   docs/DATABASE-RECOVERY.md section 2 has the commands.' -ForegroundColor Red
    exit 1
}

Write-Step "Auditing $DbUser@${DbHost}:$DbPort/$Database  (password not shown)"

# ---------------------------------------------------------------------------
# A defaults file, so the password never reaches a command line
# ---------------------------------------------------------------------------
$DefaultsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("uboss-audit-" + [guid]::NewGuid().ToString('N') + '.cnf')
$defaultsBody = "[client]`nhost=$DbHost`nport=$DbPort`nuser=$DbUser`npassword=$DbPass`n"
[System.IO.File]::WriteAllText($DefaultsFile, $defaultsBody, (New-Object System.Text.UTF8Encoding $false))

# Readable by this account only. The file is deleted below whatever happens,
# but a crash between here and there should not leave a world-readable password.
$acl = Get-Acl $DefaultsFile
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')))
Set-Acl -Path $DefaultsFile -AclObject $acl

$exitCode = 0
try {
    function Invoke-Sql {
        param([string]$Sql)
        $output = & $Client "--defaults-extra-file=$DefaultsFile" '--batch' '--skip-column-names' '--execute' $Sql 2>&1
        if ($LASTEXITCODE -ne 0) { throw "query failed: $output" }
        return @($output | ForEach-Object { "$_" })
    }

    function Get-Scalar {
        param([string]$Sql)
        # `@(...)` at the call site, not inside Invoke-Sql. PowerShell unrolls a
        # one-element array on `return`, so a query with a single row comes back
        # as a bare string and `.Count` then throws under Set-StrictMode.
        $rows = @(Invoke-Sql $Sql)
        if ($rows.Count -eq 0) { return $null }
        return $rows[0]
    }

    # -----------------------------------------------------------------------
    # Server
    # -----------------------------------------------------------------------
    Write-Step 'Server'
    $server = [ordered]@{
        version               = Get-Scalar 'SELECT VERSION();'
        versionComment        = Get-Scalar 'SELECT @@version_comment;'
        characterSetServer    = Get-Scalar 'SELECT @@character_set_server;'
        collationServer       = Get-Scalar 'SELECT @@collation_server;'
        sqlMode               = Get-Scalar 'SELECT @@sql_mode;'
        timeZone              = Get-Scalar 'SELECT @@time_zone;'
        systemTimeZone        = Get-Scalar 'SELECT @@system_time_zone;'
        defaultStorageEngine  = Get-Scalar 'SELECT @@default_storage_engine;'
        maxConnections        = Get-Scalar 'SELECT @@max_connections;'
        maxAllowedPacket      = Get-Scalar 'SELECT @@max_allowed_packet;'
        innodbBufferPoolBytes = Get-Scalar 'SELECT @@innodb_buffer_pool_size;'
        innodbFilePerTable    = Get-Scalar 'SELECT @@innodb_file_per_table;'
        lowerCaseTableNames   = Get-Scalar 'SELECT @@lower_case_table_names;'
        binaryLogEnabled      = Get-Scalar 'SELECT @@log_bin;'
        timeZoneTablesLoaded  = Get-Scalar 'SELECT COUNT(*) FROM mysql.time_zone_name;'
    }
    Write-Host "    $($server.version)  charset=$($server.characterSetServer)  collation=$($server.collationServer)"
    Write-Host "    sql_mode=$($server.sqlMode)"
    Write-Host "    time_zone=$($server.timeZone) (system $($server.systemTimeZone))"

    # STRICT mode. XAMPP's default has no strict member; production's does. An
    # over-long value is truncated with a warning on one and rejected on the
    # other, and this is the single largest behavioural gap between the two.
    if ($server.sqlMode -notmatch 'STRICT_(TRANS|ALL)_TABLES') {
        Write-Warn 'This server is NOT in strict mode; production is. A value too long for its column is silently truncated here and rejected there.'
        Write-Warn 'Run the test suite against deploy/compat before believing a green local run - docs/DATABASE-MIGRATION.md section 4.'
    }

    # Named time zones. Without the tz tables, CONVERT_TZ(..., "Europe/Warsaw")
    # returns NULL. This application does its zone arithmetic in Node, so it
    # does not depend on them - but anybody debugging a schedule at a SQL
    # prompt will get silent nulls and believe the data is wrong.
    if ([int]$server.timeZoneTablesLoaded -eq 0) {
        Write-Warn 'mysql.time_zone_name is empty: named zones like Europe/Warsaw are unavailable at a SQL prompt here.'
    }

    # -----------------------------------------------------------------------
    # Schema shape
    # -----------------------------------------------------------------------
    Write-Step "Schema of $Database"
    $q = "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$Database'"
    $schema = [ordered]@{
        tables            = Get-Scalar "$q;"
        sizeMegabytes     = Get-Scalar "SELECT IFNULL(ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1048576,1),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$Database';"
        estimatedRows     = Get-Scalar "SELECT IFNULL(SUM(TABLE_ROWS),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$Database';"
        nonInnodbTables   = Get-Scalar "$q AND ENGINE <> 'InnoDB' AND ENGINE IS NOT NULL;"
        distinctCollations = (Invoke-Sql "SELECT DISTINCT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA='$Database' AND TABLE_COLLATION IS NOT NULL;") -join ','
        foreignKeys       = Get-Scalar "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='$Database' AND CONSTRAINT_TYPE='FOREIGN KEY';"
        uniqueConstraints = Get-Scalar "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA='$Database' AND CONSTRAINT_TYPE='UNIQUE';"
        checkConstraints  = Get-Scalar "SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='$Database';"
        views             = Get-Scalar "SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='$Database';"
        triggers          = Get-Scalar "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$Database';"
        routines          = Get-Scalar "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$Database';"
        events            = Get-Scalar "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='$Database';"
        generatedColumns  = Get-Scalar "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$Database' AND EXTRA LIKE '%GENERATED%';"
        fulltextIndexes   = Get-Scalar "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$Database' AND INDEX_TYPE='FULLTEXT';"
        decimalColumns    = Get-Scalar "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$Database' AND DATA_TYPE='decimal';"
        datetimeColumns   = Get-Scalar "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$Database' AND DATA_TYPE='datetime';"
        timestampColumns  = Get-Scalar "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$Database' AND DATA_TYPE='timestamp';"
        floatColumns      = (Invoke-Sql "SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME,' ',COLUMN_TYPE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$Database' AND DATA_TYPE IN ('float','double','real');") -join '; '
    }
    Write-Host "    $($schema.tables) tables, $($schema.sizeMegabytes) MB, ~$($schema.estimatedRows) rows"
    Write-Host "    $($schema.foreignKeys) foreign keys, $($schema.uniqueConstraints) unique, $($schema.checkConstraints) check constraints"

    # The whole reason a logical dump of this database is portable: nothing here
    # carries a DEFINER, nothing runs on a schedule, nothing is a view over
    # something else. If any of these stops being zero, the export plan in
    # docs/DATABASE-MIGRATION.md section 7 needs the routines/triggers flags.
    foreach ($object in @('views', 'triggers', 'routines', 'events')) {
        if ([int]$schema[$object] -gt 0) {
            Write-Warn "$($schema[$object]) $object exist. The export flags in docs/DATABASE-MIGRATION.md assume there are none - re-read section 7."
        }
    }

    # Money as a float is the one finding that is never acceptable. Every
    # monetary amount in this schema is a BigInt of minor units; a FLOAT or
    # DOUBLE appearing anywhere means somebody added a column the wrong way.
    if (-not [string]::IsNullOrEmpty($schema.floatColumns)) {
        Write-Warn "Binary floating-point columns found: $($schema.floatColumns)"
        Write-Warn 'Check whether any of them is a money, tax or quantity field before this reaches production.'
    }

    if ([int]$schema.nonInnodbTables -gt 0) {
        Write-Warn "$($schema.nonInnodbTables) tables are not InnoDB. Only InnoDB is transactional and only InnoDB is backed up consistently by --single-transaction."
    }

    # -----------------------------------------------------------------------
    # Migration history
    # -----------------------------------------------------------------------
    Write-Step 'Prisma migration history'
    $migrationsDir = Join-Path $RepoRoot 'backend\prisma\migrations'
    $onDisk = @(Get-ChildItem -Path $migrationsDir -Directory | Select-Object -ExpandProperty Name | Sort-Object)
    $applied = @(Invoke-Sql "SELECT migration_name FROM ``$Database``._prisma_migrations ORDER BY migration_name;")
    $unfinished = Get-Scalar "SELECT COUNT(*) FROM ``$Database``._prisma_migrations WHERE finished_at IS NULL;"
    $rolledBack = Get-Scalar "SELECT COUNT(*) FROM ``$Database``._prisma_migrations WHERE rolled_back_at IS NOT NULL;"

    $missingFromDb = @($onDisk | Where-Object { $applied -notcontains $_ })
    $notOnDisk     = @($applied | Where-Object { $onDisk -notcontains $_ } | Select-Object -Unique)
    $duplicates    = @($applied | Group-Object | Where-Object { $_.Count -gt 1 } | Select-Object -ExpandProperty Name)

    $migrations = [ordered]@{
        onDisk          = $onDisk.Count
        appliedRows     = $applied.Count
        unfinished      = [int]$unfinished
        rolledBack      = [int]$rolledBack
        missingFromDb   = $missingFromDb
        recordedNotOnDisk = $notOnDisk
        duplicateRecords  = $duplicates
    }
    Write-Host "    $($onDisk.Count) on disk, $($applied.Count) recorded as applied"

    if ($migrations.unfinished -gt 0) {
        Write-Warn "$($migrations.unfinished) migration(s) started and never finished. `prisma migrate deploy` will refuse to run until that is resolved - docs/DATABASE-MIGRATION.md section 6."
    }
    if ($missingFromDb.Count -gt 0) {
        Write-Warn "Not yet applied here: $($missingFromDb -join ', ')"
    }
    if ($notOnDisk.Count -gt 0) {
        Write-Warn "Recorded as applied but not in the repository: $($notOnDisk -join ', '). Somebody applied a migration that was never committed, or it was deleted after the fact."
    }
    if ($duplicates.Count -gt 0) {
        Write-Warn "Recorded more than once: $($duplicates -join ', '). Harmless to read, but `migrate deploy` counts rows - clean it up before this database is used as a template for anything."
    }

    # -----------------------------------------------------------------------
    # Accounts
    #
    # Names and hosts only. No password, no hash, no grant string - a grant
    # string on MariaDB includes `IDENTIFIED BY PASSWORD '<hash>'`, and a hash
    # in a report that gets pasted into a chat window is a credential leak.
    # -----------------------------------------------------------------------
    Write-Step 'Accounts'
    $accounts = @(Invoke-Sql @"
SELECT CONCAT(User, '@', Host, ' ',
              IF(JSON_VALUE(Priv, '$.authentication_string') IS NULL
                 OR JSON_VALUE(Priv, '$.authentication_string') = '', 'NO-PASSWORD', 'has-password'))
  FROM mysql.global_priv ORDER BY User, Host;
"@)
    foreach ($account in $accounts) { Write-Host "    $account" }

    $passwordless = @($accounts | Where-Object { $_ -match 'NO-PASSWORD' })
    if ($passwordless.Count -gt 0) {
        Write-Warn "$($passwordless.Count) account(s) have no password. Normal for XAMPP, unacceptable in production."
        Write-Warn 'Nothing here is ever copied to the VPS: production accounts are created fresh by deploy/scripts/bootstrap.sh.'
    }

    # -----------------------------------------------------------------------
    # Report
    # -----------------------------------------------------------------------
    if ([string]::IsNullOrEmpty($OutputPath)) {
        $reportDir = Join-Path $RepoRoot '.dev-logs\db-audit'
        if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
        $OutputPath = Join-Path $reportDir ("xampp-audit-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
    }

    $report = [ordered]@{
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        target         = [ordered]@{ host = $DbHost; port = $DbPort; user = $DbUser; database = $Database }
        server         = $server
        schema         = $schema
        migrations     = $migrations
        accounts       = $accounts
    }
    $report | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutputPath -Encoding utf8
    Write-Step "Report written to $OutputPath"
    Write-Host '    It contains counts and settings only - no row contents, no passwords.' -ForegroundColor DarkGray

} catch {
    Write-Fail $_.Exception.Message
    Write-Host '   If this is "Can''t connect", start MariaDB from the XAMPP Control Panel.' -ForegroundColor Red
    Write-Host '   If this is "Access denied", backend\.env''s DATABASE_URL no longer matches the account.' -ForegroundColor Red
    $exitCode = 1
} finally {
    # The password file goes, whatever happened above.
    if (Test-Path $DefaultsFile) { Remove-Item -Path $DefaultsFile -Force -ErrorAction SilentlyContinue }
}

exit $exitCode
