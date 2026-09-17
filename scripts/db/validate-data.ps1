<#
.SYNOPSIS
    Runs scripts/db/validate-data.sql and turns its output into a pass/fail
    report you can diff between two runs.

.DESCRIPTION
    READ-ONLY. Every statement it runs is a SELECT.

    The point of this script is the comparison, not the single run. Take a
    report before a migration, take one after, and `Compare-Object` the two:
    a row count that fell, a sequence that went backwards or a check that
    turned non-zero is what a migration went wrong looks like.

        .\scripts\db\validate-data.ps1 -OutputPath before.tsv
        # ... migrate ...
        .\scripts\db\validate-data.ps1 -OutputPath after.tsv
        Compare-Object (Get-Content before.tsv) (Get-Content after.tsv)

    Checks whose expected value is "0" are pass/fail and set the exit code.
    Checks marked "compare" never fail a run on their own - a row count is only
    meaningful against another row count.

    NO PERSONAL DATA is read or written. The report is counts and check names.

.PARAMETER ConnectionUrl
    A mysql:// URL. Defaults to backend/.env's DATABASE_URL.

.PARAMETER OutputPath
    Where the TSV report goes. Defaults to a timestamped file under
    `.dev-logs/db-validation/`, which is gitignored.

.PARAMETER AllowRemote
    Permit a host other than loopback. Required to run this against the VPS
    over an SSH tunnel, and deliberately not the default.

.EXAMPLE
    PS> .\scripts\db\validate-data.ps1

.EXAMPLE
    PS> .\scripts\db\validate-data.ps1 -ConnectionUrl "mysql://uboss_app:...@127.0.0.1:3307/uboss"

.NOTES
    Requires : a MariaDB client (XAMPP's, or one on PATH).
    Exit code: 0 if every pass/fail check was 0, 1 otherwise, 2 if it could not run.
    Recovery : a failing check names the defect it found. docs/DATABASE-MIGRATION.md
               section 9 lists what each family of failure usually means.
#>
[CmdletBinding()]
param(
    [string]$ConnectionUrl,
    [string]$OutputPath,
    [switch]$AllowRemote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SqlFile  = Join-Path $PSScriptRoot 'validate-data.sql'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Fail { param([string]$Message) Write-Host "xx $Message" -ForegroundColor Red }

if (-not (Test-Path $SqlFile)) { Write-Fail "Missing $SqlFile"; exit 2 }

# --- Client ---------------------------------------------------------------
$Client = $null
foreach ($candidate in @('C:\xampp\mysql\bin\mariadb.exe', 'C:\xampp\mysql\bin\mysql.exe')) {
    if (Test-Path $candidate) { $Client = $candidate; break }
}
if ($null -eq $Client) {
    $onPath = Get-Command mariadb, mysql -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $onPath) { $Client = $onPath.Source }
}
if ($null -eq $Client) { Write-Fail 'No MariaDB client found (looked in C:\xampp\mysql\bin and on PATH).'; exit 2 }

# --- Connection -----------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($ConnectionUrl)) {
    $EnvFile = Join-Path $RepoRoot 'backend\.env'
    if (-not (Test-Path $EnvFile)) { Write-Fail 'No backend\.env and no -ConnectionUrl.'; exit 2 }
    $line = Select-String -Path $EnvFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
    if ($null -eq $line) { Write-Fail 'backend\.env has no DATABASE_URL.'; exit 2 }
    $ConnectionUrl = ($line.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
}

try { $uri = [System.Uri]$ConnectionUrl } catch { Write-Fail 'Not a URL. Expected mysql://user:password@host:port/database'; exit 2 }

$DbHost = $uri.Host
$DbPort = $uri.Port; if ($DbPort -le 0) { $DbPort = 3306 }
$parts  = $uri.UserInfo -split ':', 2
$DbUser = [System.Uri]::UnescapeDataString($parts[0])
$DbPass = ''; if ($parts.Count -gt 1) { $DbPass = [System.Uri]::UnescapeDataString($parts[1]) }
$DbName = $uri.AbsolutePath.TrimStart('/')

if ($DbHost -notin @('127.0.0.1', 'localhost', '::1') -and -not $AllowRemote) {
    Write-Fail "Host '$DbHost' is not loopback. Pass -AllowRemote if that is deliberate."
    Write-Host '   Prefer an SSH tunnel to the VPS over a direct connection: the database' -ForegroundColor Red
    Write-Host '   listens on 127.0.0.1 there and should stay that way.' -ForegroundColor Red
    exit 2
}

Write-Step "Validating $DbUser@${DbHost}:$DbPort/$DbName  (password not shown)"

# --- Defaults file, so no password reaches a command line ------------------
$DefaultsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("uboss-validate-" + [guid]::NewGuid().ToString('N') + '.cnf')
[System.IO.File]::WriteAllText($DefaultsFile, "[client]`nhost=$DbHost`nport=$DbPort`nuser=$DbUser`npassword=$DbPass`n", (New-Object System.Text.UTF8Encoding $false))
$acl = Get-Acl $DefaultsFile
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')))
Set-Acl -Path $DefaultsFile -AclObject $acl

$exitCode = 0
try {
    $raw = & $Client "--defaults-extra-file=$DefaultsFile" '--batch' '--skip-column-names' $DbName -e "source $($SqlFile -replace '\\','/')" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "The validation query set did not complete:`n$raw"
        exit 2
    }

    $failures = @()
    $lines    = @()
    foreach ($row in $raw) {
        $text = "$row"
        $cols = $text -split "`t"
        if ($cols.Count -lt 3) { continue }
        $name = $cols[0]; $actual = $cols[1]; $expected = $cols[2]

        if ($name -like '===*') { Write-Host "`n  $name" -ForegroundColor DarkGray; continue }
        $lines += "$name`t$actual"

        if ($expected -eq '0') {
            if ($actual -ne '0') {
                Write-Host ("    {0,-58} {1,8}  FAIL" -f $name, $actual) -ForegroundColor Red
                $failures += "$name = $actual"
            } else {
                Write-Host ("    {0,-58} {1,8}" -f $name, $actual) -ForegroundColor DarkGray
            }
        } else {
            Write-Host ("    {0,-58} {1,8}" -f $name, $actual)
        }
    }

    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $dir = Join-Path $RepoRoot '.dev-logs\db-validation'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $OutputPath = Join-Path $dir ("validate-$DbName-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tsv')
    }
    $lines | Out-File -FilePath $OutputPath -Encoding utf8
    Write-Host ''
    Write-Step "Report written to $OutputPath"

    if ($failures.Count -gt 0) {
        Write-Host ''
        Write-Fail "$($failures.Count) check(s) failed:"
        foreach ($f in $failures) { Write-Host "     $f" -ForegroundColor Red }
        Write-Host ''
        Write-Host '   Before treating these as corruption, check whether the rows are demo data.' -ForegroundColor Yellow
        Write-Host '   Seeded orders are numbered UB-DEMO-* and are deliberately not the product of' -ForegroundColor Yellow
        Write-Host '   a real checkout, so they can fail the money and payment checks legitimately -' -ForegroundColor Yellow
        Write-Host '   and are on the never-export list in docs/DATABASE-MIGRATION.md section 8.' -ForegroundColor Yellow
        $exitCode = 1
    } else {
        Write-Host '  Every pass/fail check returned 0.' -ForegroundColor Green
    }
} catch {
    Write-Fail $_.Exception.Message
    $exitCode = 2
} finally {
    if (Test-Path $DefaultsFile) { Remove-Item -Path $DefaultsFile -Force -ErrorAction SilentlyContinue }
}

exit $exitCode
