<#
.SYNOPSIS
    Rehearses the production database against the exact MariaDB production will
    run, on this machine, before any of it is done for real.

.DESCRIPTION
    Development runs XAMPP MariaDB 10.4, which is out of support and is not
    strict. Production runs MariaDB 11.4 LTS, which is both. This script is the
    bridge: it brings up the pinned 11.4 container in deploy/compat, builds the
    schema from nothing but committed migrations, tightens the grants the way
    production does, proves the result matches schema.prisma, and runs the test
    suite against it.

    Nothing it does touches XAMPP. It never opens a connection to port 3306.

    The sequence, and why it is this order:

      1. The container is healthy          - crash recovery finished, not just
                                             the port answering
      2. The schema is dropped and rebuilt - proves a NEW database can reach
         from committed migrations only      today's schema, which is what
                                             go-live actually does
      3. post-migrate-grants.sql is applied - the audit-log revoke cannot run
                                             before the table exists
      4. `prisma migrate diff` is empty    - the migrations and schema.prisma
                                             agree; no surprise migration is
                                             waiting for the next developer
      5. The test suite runs against it    - strict mode, 11.4 collation, UTC

.PARAMETER Reset
    Destroy the compat database and its volume first, so step 2 starts from a
    genuinely empty server. Refuses to run against anything that is not the
    local compat container.

.PARAMETER SkipTests
    Stop after step 4. Useful when iterating on a migration.

.EXAMPLE
    PS> .\scripts\db\compat-test.ps1 -Reset

.EXAMPLE
    PS> .\scripts\db\compat-test.ps1 -SkipTests

.NOTES
    Requires : Docker Desktop running, Node 24+, backend dependencies installed.
    Exit code: 0 only if every step passed.
    Recovery : If the container will not become healthy, `docker compose logs`
               in deploy/compat is the first place to look; a config typo in
               mariadb-compat.cnf aborts startup with the variable named.
#>
[CmdletBinding()]
param(
    [switch]$Reset,
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$CompatDir  = Join-Path $RepoRoot 'deploy\compat'
$BackendDir = Join-Path $RepoRoot 'backend'
$EnvFile    = Join-Path $CompatDir '.env'

# The container this script is allowed to talk to. Named rather than derived,
# so that a mistyped port or a copied .env cannot point the destructive parts
# of this script at something else.
$ExpectedContainer = 'uboss-compat-mariadb'
$ExpectedHost      = '127.0.0.1'

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  + $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "xx $Message" -ForegroundColor Red }

function Stop-With { param([string]$Message) Write-Fail $Message; exit 1 }

<#
 Runs a native program and returns its exit code, WITHOUT letting anything it
 writes to stderr become a PowerShell error.

 This is not defensive padding. In Windows PowerShell 5.1, with
 `$ErrorActionPreference = 'Stop'`, every line a native program writes to
 stderr is wrapped in an ErrorRecord and thrown as a NativeCommandError - even
 when the program exits 0. Prisma writes "Loaded Prisma config from
 prisma.config.ts." to stderr on every invocation, and vitest writes its
 progress there, so without this the first `npx prisma` call in this script
 would abort it with Prisma's own banner as the error message.

 The exit code is what decides pass or fail here, so it is what this returns.
#>
function Invoke-Native {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # `| Out-Host`, and it is load-bearing. Without it the command's output
        # joins this function's return value, so the caller's
        # `$code = Invoke-Native { & npm test }` gets an ARRAY of every line
        # vitest printed with the exit code on the end - and `$code -ne 0` is
        # then true no matter what happened. The first version of this script
        # reported a passing 2 323-test suite as a failure for exactly that
        # reason. Out-Host sends the output to the console instead of the
        # pipeline, leaving the exit code as the only thing returned.
        & $Command | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------
Write-Step 'Checking the environment'

if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-With 'Docker is not on PATH. Install Docker Desktop, or run the rehearsal on a machine that has it.'
}

$dockerCode = Invoke-Native { & docker info --format '{{.ServerVersion}}' *> $null }
if ($dockerCode -ne 0) {
    Stop-With 'The Docker daemon is not responding. Start Docker Desktop and wait for the whale to stop animating.'
}
Write-Ok 'Docker is running'

if (-not (Test-Path $EnvFile)) {
    Write-Fail "No $EnvFile."
    Write-Host '   Copy deploy\compat\.env.database.example to deploy\compat\.env and generate four passwords:' -ForegroundColor Red
    Write-Host '     node -e "console.log(require(''crypto'').randomBytes(24).toString(''base64url''))"' -ForegroundColor Red
    exit 1
}

# Read the compat .env. Values are used, never printed.
$compat = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
        $compat[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
}
foreach ($required in @('COMPAT_DB_ROOT_PASSWORD', 'COMPAT_DB_MIGRATE_PASSWORD', 'COMPAT_DB_APP_PASSWORD')) {
    if (-not $compat.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($compat[$required])) {
        Stop-With "$required is empty in deploy\compat\.env. See .env.database.example."
    }
}
$Port = '3307'
if ($compat.ContainsKey('COMPAT_DB_PORT') -and -not [string]::IsNullOrWhiteSpace($compat['COMPAT_DB_PORT'])) {
    $Port = $compat['COMPAT_DB_PORT']
}

# PRODUCTION SAFEGUARD. Everything below either drops databases or runs a test
# suite that truncates tables. It may only ever do that to the local container.
if ($Port -eq '3306') {
    Stop-With 'COMPAT_DB_PORT is 3306, which is XAMPP. This script drops and rebuilds the database it points at. Refusing.'
}
Write-Ok "Target is the compat container only: ${ExpectedHost}:$Port  (passwords not shown)"

# ---------------------------------------------------------------------------
# The container
# ---------------------------------------------------------------------------
Push-Location $CompatDir
try {
    if ($Reset) {
        Write-Step 'Destroying the compat database and its volume'
        Write-Warn 'This removes the uboss-compat-data volume. It holds nothing but rehearsal data.'
        if ((Invoke-Native { & docker compose --progress quiet down -v }) -ne 0) { Stop-With 'docker compose down failed.' }
        Write-Ok 'Volume removed'
    }

    Write-Step 'Starting MariaDB 11.4 (pinned by digest)'
    if ((Invoke-Native { & docker compose --progress quiet up -d }) -ne 0) { Stop-With 'docker compose up failed.' }

    # Wait for the image''s own probe rather than for the port. `--connect
    # --innodb_initialized` waits for crash recovery to finish; a port that
    # answers during recovery will refuse the first migration.
    Write-Host '    waiting for the health check to pass...' -ForegroundColor DarkGray
    $deadline = (Get-Date).AddMinutes(3)
    $health = ''
    while ((Get-Date) -lt $deadline) {
        $health = (& docker inspect -f '{{.State.Health.Status}}' $ExpectedContainer 2>$null)
        if ($health -eq 'healthy') { break }
        Start-Sleep -Seconds 3
    }
    if ($health -ne 'healthy') {
        Write-Fail "The container never became healthy (last state: '$health')."
        Write-Host '   docker compose logs mariadb   -- a bad setting in mariadb-compat.cnf names itself there.' -ForegroundColor Red
        exit 1
    }
    Write-Ok 'MariaDB is healthy'
} finally {
    Pop-Location
}

# A local helper that runs SQL inside the container as root. Nothing it is given
# is echoed.
function Invoke-CompatSql {
    param([string]$Sql, [string]$Database = '')
    $args = @('exec', '-i', $ExpectedContainer, 'mariadb', '-uroot', "-p$($compat['COMPAT_DB_ROOT_PASSWORD'])", '--batch', '--skip-column-names')
    if (-not [string]::IsNullOrEmpty($Database)) { $args += $Database }
    # Same NativeCommandError trap as Invoke-Native above: the mariadb client
    # writes warnings to stderr, and with $ErrorActionPreference = 'Stop' every
    # one of them would be thrown as a PowerShell error regardless of the exit
    # code. The exit code is the thing that decides whether the SQL worked.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $result = $Sql | & docker @args 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "SQL failed: $result" }
    return @($result | ForEach-Object { "$_" })
}

# @() at the call site: PowerShell unrolls a one-element array on return, so a
# single-row query comes back as a bare string and [0] is then its first
# CHARACTER - which reports this server as "1".
$serverVersion = @(Invoke-CompatSql 'SELECT VERSION();')[0]
Write-Ok "Server is $serverVersion"

# ---------------------------------------------------------------------------
# Rebuild the schema from committed migrations only
#
# DROP then CREATE, rather than `migrate reset`: this proves that a database
# that has never seen this application can reach today's schema from the
# repository alone, which is exactly what the first production deployment does.
# ---------------------------------------------------------------------------
Write-Step 'Rebuilding uboss and uboss_test from committed migrations'

foreach ($db in @('uboss', 'uboss_test')) {
    Invoke-CompatSql "DROP DATABASE IF EXISTS ``$db``; CREATE DATABASE ``$db`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" | Out-Null
}
Write-Ok 'Both databases dropped and recreated, empty, utf8mb4_unicode_ci'

$migrateUrlFor = {
    param($db)
    "mysql://uboss_migrate:$($compat['COMPAT_DB_MIGRATE_PASSWORD'])@${ExpectedHost}:$Port/$db"
}

Push-Location $BackendDir
try {
    foreach ($db in @('uboss', 'uboss_test')) {
        $env:DATABASE_URL = & $migrateUrlFor $db
        $env:PRISMA_TARGET_TEST_DB = ''
        Write-Host "    prisma migrate deploy -> $db" -ForegroundColor DarkGray
        $deployCode = Invoke-Native { & npx prisma migrate deploy 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray } }
        if ($deployCode -ne 0) {
            Write-Fail "migrate deploy failed against $db on MariaDB $serverVersion."
            Write-Host '   This is the failure worth having here: a migration that works on XAMPP 10.4' -ForegroundColor Red
            Write-Host '   and not on 11.4 would otherwise have been found during go-live.' -ForegroundColor Red
            exit 1
        }
    }
    Write-Ok 'All committed migrations applied to both databases from empty'

    # -----------------------------------------------------------------------
    # The grants that can only be issued once the tables exist
    # -----------------------------------------------------------------------
    Write-Step 'Applying post-migration grants'
    # THE SAME GENERATOR PRODUCTION USES - deploy/mariadb/post-migrate-grants.sql,
    # driven here by PowerShell and there by deploy/scripts/apply-grants.sh.
    # One implementation, exercised twice, because a least-privilege model that
    # is written out separately for the rehearsal is a rehearsal of a different
    # system.
    #
    # The only difference is the host part: this container is reached over TCP
    # from Windows, so uboss_app here is @'%' where production's is @'localhost'.
    # The generator takes it as a parameter for exactly that reason.
    $generator = Join-Path $RepoRoot 'deploy\mariadb\post-migrate-grants.sql'
    $generated = @(Invoke-CompatSql ("SET @app_user='uboss_app'; SET @app_host='%';`n" + (Get-Content $generator -Raw)) 'uboss')

    $grantCount = @($generated | Where-Object { $_ -like 'GRANT UPDATE, DELETE*' }).Count
    if ($grantCount -lt 1) { Stop-With 'The grant generator produced nothing. Did migrate deploy actually create the tables?' }
    Write-Host "    $grantCount tables to be writable; audit_logs and _prisma_migrations not" -ForegroundColor DarkGray

    $verification = @(Invoke-CompatSql ($generated -join "`n") 'uboss')
    foreach ($row in $verification) { Write-Host "    $row" -ForegroundColor DarkGray }

    # The generated script ends by naming each protected table and whether it is
    # still writable. This is a security control, so anything short of two
    # append-only rows stops the rehearsal rather than warning about it.
    if (($verification -join ' ') -match 'NOT PROTECTED') {
        Stop-With 'A protected table is still writable by uboss_app: the application can rewrite its own audit log.'
    }
    if (@($verification | Where-Object { $_ -like '*append-only*' }).Count -ne 2) {
        Stop-With 'Expected two protected tables in the verification output. Check the account host part.'
    }
    Write-Ok 'audit_logs and _prisma_migrations are append-only for the runtime user'

    # -----------------------------------------------------------------------
    # Drift
    # -----------------------------------------------------------------------
    Write-Step 'Checking the built schema against schema.prisma'
    $env:DATABASE_URL = & $migrateUrlFor 'uboss'
    $driftCode = Invoke-Native { & npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code *> $null }
    if ($driftCode -eq 2) {
        Write-Fail 'The migrations and schema.prisma disagree. The differences:'
        Invoke-Native { & npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma } | Out-Null
        Write-Host '   docs/DATABASE-MIGRATION.md section 5 explains how to reconcile this WITHOUT' -ForegroundColor Red
        Write-Host '   rewriting migration history. Do not run `prisma migrate dev` to "fix" it.' -ForegroundColor Red
        exit 1
    }
    if ($driftCode -ne 0) { Stop-With 'prisma migrate diff could not run.' }
    Write-Ok 'No difference: committed migrations produce exactly what schema.prisma declares'

    # -----------------------------------------------------------------------
    # The test suite, against 11.4
    # -----------------------------------------------------------------------
    if ($SkipTests) {
        Write-Step 'Skipping the test suite (-SkipTests)'
    } else {
        Write-Step "Running the backend test suite against MariaDB $serverVersion"
        Write-Host '    Strict mode, 11.4 collation, UTC. A test that passes on XAMPP and fails' -ForegroundColor DarkGray
        Write-Host '    here has found a real difference - read it before dismissing it.' -ForegroundColor DarkGray

        # The runtime account, not the migration one. A test that needs DDL is a
        # test that has found a place where the application expects privileges
        # production will not give it.
        $env:DATABASE_URL      = "mysql://uboss_app:$($compat['COMPAT_DB_APP_PASSWORD'])@${ExpectedHost}:$Port/uboss"
        $env:TEST_DATABASE_URL = "mysql://uboss_app:$($compat['COMPAT_DB_APP_PASSWORD'])@${ExpectedHost}:$Port/uboss_test"

        $testCode = Invoke-Native { & npm test }
        if ($testCode -ne 0) {
            Write-Fail 'The test suite failed against the production candidate.'
            Write-Host '   Compare with a run against XAMPP before assuming the code is wrong:' -ForegroundColor Red
            Write-Host '     cd backend; npm test' -ForegroundColor Red
            Write-Host '   A test that fails only here is a real 10.4-vs-11.4 difference.' -ForegroundColor Red
            exit 1
        }
        Write-Ok 'The suite passes against the production candidate'
    }
} finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL, Env:TEST_DATABASE_URL, Env:PRISMA_TARGET_TEST_DB -ErrorAction SilentlyContinue
}

Write-Step 'Rehearsal complete'
Write-Host "  The schema builds from committed migrations on $serverVersion, matches schema.prisma," -ForegroundColor Green
Write-Host '  and the application passes its tests against it under production settings.' -ForegroundColor Green
Write-Host ''
Write-Host '  The compat container is still running. Leave it, or:' -ForegroundColor DarkGray
Write-Host '    cd deploy\compat; docker compose down      # keep the data' -ForegroundColor DarkGray
Write-Host '    cd deploy\compat; docker compose down -v   # and throw it away' -ForegroundColor DarkGray
exit 0
