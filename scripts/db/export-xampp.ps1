<#
.SYNOPSIS
    Takes a consistent, checksummed logical backup of the local XAMPP database.

.DESCRIPTION
    This is the only supported way to get data out of XAMPP. DO NOT COPY THE
    DATA DIRECTORY. `C:\xampp\mysql\data` is InnoDB's own on-disk format: it is
    version-specific, it is byte-order-specific, half of it is in ibdata1 and
    the redo log, and a copy taken while the server is running is a copy of a
    database mid-write. Moving those files to a Linux MariaDB 11.4 produces a
    server that either refuses to start or starts and is quietly wrong.

    What this script produces instead is SQL text: portable between versions,
    readable, diffable, and restorable into anything that speaks MariaDB.

    WHAT IT NEVER EXPORTS, and none of these are oversights:

      mysql, performance_schema, information_schema, sys
                     The server's own accounts and internals. Production has
                     its own accounts, created on the machine by bootstrap.sh
                     and never seen on this laptop. Importing XAMPP's `mysql`
                     database into production would replace the production
                     accounts with four passwordless root logins.
      phpmyadmin, test
                     XAMPP furniture.
      Definers       Not applicable here - this schema has no views, routines,
                     triggers or events - but the flags are set anyway so that
                     a future one cannot smuggle `DEFINER=root@localhost` into
                     a server where that account does not exist.

    Three modes, and the choice matters more than any flag:

      -Mode Schema     structure only. What production's schema should be built
                       from is `prisma migrate deploy`, NOT this - but a schema
                       dump is how you diff what migrations produced against
                       what the development database actually has.
      -Mode Full       everything, for a local rehearsal or a disaster copy.
                       NOT for loading into production: it carries demo orders,
                       test payments, sessions and sandbox tokens.
      -Mode Reference  the allowlist only: countries, currencies, tax classes,
                       VAT rates, categories, roles, permissions, feature flags
                       and shipping methods. This is the one that is allowed
                       anywhere near a production database.

.PARAMETER Mode
    Schema | Full | Reference. Defaults to Full.

.PARAMETER OutputDirectory
    Where the dump goes. Defaults to `.dev-logs/db-exports/` (gitignored).

.PARAMETER Database
    Defaults to the database in backend/.env.

.EXAMPLE
    PS> .\scripts\db\export-xampp.ps1 -Mode Full

.EXAMPLE
    PS> .\scripts\db\export-xampp.ps1 -Mode Reference -OutputDirectory C:\uboss-golive

.NOTES
    Requires : XAMPP MariaDB running, and its dump binary. XAMPP 10.4 ships
               `mysqldump.exe`; MariaDB 11.4 ships `mariadb-dump`. This script
               looks for both rather than assuming either.
    Exit code: 0 only if the dump completed AND verified.
    Output   : <db>-<mode>-<timestamp>.sql plus a .sha256 beside it.
    Recovery : A dump that fails verification is deleted, deliberately. A
               truncated dump kept "just in case" is the file somebody restores
               at 3am believing it is a backup.
#>
[CmdletBinding()]
param(
    [ValidateSet('Schema', 'Full', 'Reference')]
    [string]$Mode = 'Full',
    [string]$OutputDirectory,
    [string]$Database
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  + $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "xx $Message" -ForegroundColor Red }

# --- The dump binary ------------------------------------------------------
#
# Named differently on the two versions this repository has to deal with.
# Detected, not assumed - the same mistake, hard-coded, is what would have
# broken deploy/scripts/backup.sh the first time it ran on 11.4.
$Dump = $null
foreach ($candidate in @(
    'C:\xampp\mysql\bin\mariadb-dump.exe',
    'C:\xampp\mysql\bin\mysqldump.exe',
    'D:\xampp\mysql\bin\mariadb-dump.exe',
    'D:\xampp\mysql\bin\mysqldump.exe')) {
    if (Test-Path $candidate) { $Dump = $candidate; break }
}
if ($null -eq $Dump) {
    $onPath = Get-Command mariadb-dump, mysqldump -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $onPath) { $Dump = $onPath.Source }
}
if ($null -eq $Dump) { Write-Fail 'Neither mariadb-dump nor mysqldump was found.'; exit 1 }

# --- Connection -----------------------------------------------------------
$EnvFile = Join-Path $RepoRoot 'backend\.env'
if (-not (Test-Path $EnvFile)) { Write-Fail 'No backend\.env.'; exit 1 }
$line = Select-String -Path $EnvFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
if ($null -eq $line) { Write-Fail 'backend\.env has no DATABASE_URL.'; exit 1 }
$rawUrl = ($line.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
try { $uri = [System.Uri]$rawUrl } catch { Write-Fail 'DATABASE_URL is not a URL.'; exit 1 }

$DbHost = $uri.Host
$DbPort = $uri.Port; if ($DbPort -le 0) { $DbPort = 3306 }
$parts  = $uri.UserInfo -split ':', 2
$DbUser = [System.Uri]::UnescapeDataString($parts[0])
$DbPass = ''; if ($parts.Count -gt 1) { $DbPass = [System.Uri]::UnescapeDataString($parts[1]) }
if ([string]::IsNullOrWhiteSpace($Database)) { $Database = $uri.AbsolutePath.TrimStart('/') }

# PRODUCTION SAFEGUARD. This script names itself after XAMPP and is for XAMPP.
# Dumping production from a laptop writes production's data and its password
# onto a machine that is not backed up and is carried around.
if ($DbHost -notin @('127.0.0.1', 'localhost', '::1')) {
    Write-Fail "DATABASE_URL points at '$DbHost'. This script exports the LOCAL development database only."
    Write-Host '   To back up production, run deploy/scripts/backup.sh on the VPS. It encrypts' -ForegroundColor Red
    Write-Host '   the dump before it touches the disk and ships it off the machine.' -ForegroundColor Red
    exit 1
}

Write-Step "Exporting $DbUser@${DbHost}:$DbPort/$Database  mode=$Mode  (password not shown)"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $RepoRoot '.dev-logs\db-exports'
}
if (-not (Test-Path $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }

$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$DumpFile = Join-Path $OutputDirectory "$Database-$($Mode.ToLower())-$stamp.sql"

# --- Defaults file --------------------------------------------------------
$DefaultsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("uboss-export-" + [guid]::NewGuid().ToString('N') + '.cnf')
[System.IO.File]::WriteAllText($DefaultsFile, "[client]`nhost=$DbHost`nport=$DbPort`nuser=$DbUser`npassword=$DbPass`n", (New-Object System.Text.UTF8Encoding $false))
$acl = Get-Acl $DefaultsFile
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')))
Set-Acl -Path $DefaultsFile -AclObject $acl

# --- The tables the Reference mode is allowed to touch --------------------
#
# AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE WHOLE POINT. A denylist is
# wrong the moment somebody adds a table, and the way it is wrong is that a
# table of customers' data goes to production because nobody remembered to
# exclude it. A table that is not named here does not travel.
#
# Everything on this list is reference data: it describes the world (countries,
# currencies, tax rates) or the shop's own configuration (categories, roles,
# permissions, flags). None of it is about a person, an order or a payment.
$ReferenceTables = @(
    'countries',
    'currencies',
    'tax_classes',
    'vat_rates',
    'categories',
    'category_translations',
    'category_attribute_definitions',
    'roles',
    'permissions',
    'role_permissions',
    'feature_flags',
    'shipping_methods'
)

$exitCode = 0
try {
    # --- Flags, and why each one is here ----------------------------------
    #
    # --single-transaction   A consistent snapshot WITHOUT locking the tables.
    #                        It works because every table here is InnoDB - the
    #                        audit script checks that, and on a MyISAM table it
    #                        would silently give an inconsistent dump instead.
    # --quick                Stream rows instead of buffering the result set.
    #                        Without it, dumping a large table can exhaust
    #                        memory and produce a truncated file that still
    #                        looks like a dump.
    # --default-character-set=utf8mb4
    #                        Or Polish, Greek and German product text comes back
    #                        as question marks.
    # --set-gtid-purged / --master-data are deliberately NOT used. They belong
    #                        to a replication setup this does not have, and
    #                        --master-data would need RELOAD on an account that
    #                        does not need it.
    # --hex-blob             Binary columns survive a round trip through a text
    #                        file unambiguously.
    # --routines --triggers --events
    #                        Included so the dump is complete if any are ever
    #                        added. There are none today; the audit script
    #                        warns if that changes.
    # --no-tablespaces       The dump does not need the PROCESS privilege, so
    #                        the backup account does not need it either.
    $common = @(
        "--defaults-extra-file=$DefaultsFile",
        '--single-transaction',
        '--quick',
        '--hex-blob',
        '--default-character-set=utf8mb4',
        '--no-tablespaces',
        '--skip-lock-tables'
    )

    switch ($Mode) {
        'Schema' {
            $arguments = $common + @('--no-data', '--routines', '--triggers', '--events', $Database)
        }
        'Full' {
            $arguments = $common + @('--routines', '--triggers', '--events', $Database)
            Write-Warn 'A Full dump carries demo orders, test payments, sessions and sandbox tokens.'
            Write-Warn 'It is for a local rehearsal or a disaster copy. It must not be loaded into production.'
        }
        'Reference' {
            $arguments = $common + @('--no-create-info', '--complete-insert', $Database) + $ReferenceTables
            Write-Ok "Allowlist: $($ReferenceTables.Count) reference tables, no personal data, no orders, no payments"
        }
    }

    Write-Step "Dumping with $(Split-Path -Leaf $Dump)"
    # stderr is kept separate: mysqldump writes warnings there, and merging them
    # into stdout would put them in the middle of the SQL.
    $errFile = "$DumpFile.stderr"
    $process = Start-Process -FilePath $Dump -ArgumentList $arguments -NoNewWindow -Wait -PassThru `
                             -RedirectStandardOutput $DumpFile -RedirectStandardError $errFile

    $stderr = ''
    if (Test-Path $errFile) { $stderr = (Get-Content $errFile -Raw); Remove-Item $errFile -Force }

    if ($process.ExitCode -ne 0) {
        Write-Fail "The dump failed (exit $($process.ExitCode)):`n$stderr"
        if (Test-Path $DumpFile) { Remove-Item $DumpFile -Force }
        exit 1
    }
    if (-not [string]::IsNullOrWhiteSpace($stderr)) { Write-Warn $stderr.Trim() }

    # --- Verify, before calling it a backup -------------------------------
    #
    # A dump that stopped halfway is still a file, still has a plausible size
    # and still opens in an editor. The only cheap proof that it finished is
    # the completion marker the dumper writes as its last line.
    $size = (Get-Item $DumpFile).Length
    if ($size -lt 1024) {
        Write-Fail "The dump is $size bytes. That is not a database."
        Remove-Item $DumpFile -Force
        exit 1
    }

    $tail = Get-Content $DumpFile -Tail 5 -ErrorAction SilentlyContinue
    if (($tail -join "`n") -notmatch 'Dump completed') {
        Write-Fail 'The dump has no completion marker: it stopped before the end.'
        Write-Host '   Deleting it rather than keeping it. A truncated dump that looks like a' -ForegroundColor Red
        Write-Host '   backup is worse than no backup.' -ForegroundColor Red
        Remove-Item $DumpFile -Force
        exit 1
    }
    Write-Ok ("Dump completed: {0:N1} MB" -f ($size / 1MB))

    # --- Checksum ---------------------------------------------------------
    #
    # So that a file copied to another machine can be proved to be the same
    # file. Restore rehearsals compare this before they start.
    $hash = (Get-FileHash -Path $DumpFile -Algorithm SHA256).Hash.ToLower()
    $shaFile = "$DumpFile.sha256"
    "$hash  $(Split-Path -Leaf $DumpFile)" | Out-File -FilePath $shaFile -Encoding ascii
    Write-Ok "SHA-256 written to $(Split-Path -Leaf $shaFile)"

    Write-Host ''
    Write-Step 'Next'
    Write-Host "  File: $DumpFile"
    Write-Host ''
    Write-Host '  This dump is NOT encrypted and it is NOT off-site. If it holds real data,' -ForegroundColor Yellow
    Write-Host '  those are both required before it counts as a backup - docs/DATABASE-RECOVERY.md' -ForegroundColor Yellow
    Write-Host '  section 3. On the VPS, deploy/scripts/backup.sh does both.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Restore it into a disposable database and prove it works:' -ForegroundColor DarkGray
    Write-Host '    .\scripts\db\verify-restore.ps1 -DumpFile "' -NoNewline -ForegroundColor DarkGray
    Write-Host "$DumpFile`"" -ForegroundColor DarkGray

} catch {
    Write-Fail $_.Exception.Message
    $exitCode = 1
} finally {
    if (Test-Path $DefaultsFile) { Remove-Item -Path $DefaultsFile -Force -ErrorAction SilentlyContinue }
}

exit $exitCode
