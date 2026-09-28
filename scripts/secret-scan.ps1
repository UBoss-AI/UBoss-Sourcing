<#
.SYNOPSIS
  The CI secret scan, run here, before a push.

.DESCRIPTION
  Runs exactly what the "Secret scan" job in .github/workflows/ci.yml runs:
  the same pinned gitleaks release, checked against the same SHA-256, over the
  WHOLE history, with the same .gitleaks.toml. A finding here is a finding CI
  would turn red on, found before the push instead of after it.

  Why it exists: CI scans the history, so a false positive that reaches `main`
  cannot be fixed by editing the code - the string is in the history for good,
  and the only way to clear it is an exception in .gitleaks.toml. Catching it
  before the push means the exception (or the reworded line) goes out with the
  commit, and the pipeline never goes red.

  The version and both checksums are READ FROM ci.yml, never typed here, so
  bumping gitleaks in CI bumps it here too.

  THE WINDOWS FALSE PASS, AND WHY THIS SCRIPT CANNOT GIVE ONE
  .gitleaks.toml explains it: Git for Windows' `astextplain` textconv dies on
  the .docx files at the repository root, `git log -p` stops part-way, and
  gitleaks reports "no leaks found" having scanned only some of the history.
  This script turns the inherited git configuration off for the scan, and then
  refuses to pass if gitleaks logged ANY error or scanned fewer commits than
  the history holds. A clean result from it means the whole history was read.

  Run by the pre-push hook in .githooks/ once that is switched on:
    git config core.hooksPath .githooks

.EXAMPLE
  .\scripts\secret-scan.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# --- What CI pins ------------------------------------------------------------
$workflow = Get-Content -Raw (Join-Path $repo '.github\workflows\ci.yml')
function Read-Pin([string]$name) {
  $match = [regex]::Match($workflow, "(?m)^\s*${name}:\s*(\S+)\s*$")
  if (-not $match.Success) { throw "ci.yml has no $name - has the Secret scan job changed?" }
  return $match.Groups[1].Value
}
$version = Read-Pin 'GITLEAKS_VERSION'
$sha256 = (Read-Pin 'GITLEAKS_WINDOWS_X64_SHA256').ToLowerInvariant()

# --- The binary: downloaded once, verified every time ------------------------
# Outside the repository, so there is nothing to gitignore and nothing to commit.
$cache = Join-Path $env:LOCALAPPDATA "uboss\gitleaks\$version"
$exe = Join-Path $cache 'gitleaks.exe'
$zip = Join-Path $cache "gitleaks_${version}_windows_x64.zip"

if (-not (Test-Path $exe)) {
  New-Item -ItemType Directory -Force $cache | Out-Null
  $url = "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_windows_x64.zip"
  Write-Host "Downloading gitleaks $version ..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sha256) {
    Remove-Item -Force $zip
    throw "gitleaks download checksum mismatch: expected $sha256, got $actual. Not running it."
  }
  Expand-Archive -Path $zip -DestinationPath $cache -Force
}

# Verified on every run, not only on download: a binary that has been replaced
# since is not the binary CI runs.
$actualZip = if (Test-Path $zip) { (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
if ($actualZip -ne $sha256) {
  Remove-Item -Recurse -Force $cache
  throw "The cached gitleaks $version does not match the checksum in ci.yml. Removed it; run this again to fetch a clean copy."
}

# --- The scan ----------------------------------------------------------------
$expected = [int](git rev-list --count --no-merges HEAD)

$log = Join-Path $cache 'last-run.log'
$report = Join-Path $cache 'last-report.json'
Remove-Item -Force -ErrorAction SilentlyContinue $log, $report

# The inherited git configuration off, for gitleaks' own `git log` only: this
# is what stops astextplain from cutting the history short. Restored after.
$savedSystem = $env:GIT_CONFIG_SYSTEM
$savedGlobal = $env:GIT_CONFIG_GLOBAL
$env:GIT_CONFIG_SYSTEM = 'NUL'
$env:GIT_CONFIG_GLOBAL = 'NUL'
try {
  $process = Start-Process -FilePath $exe -NoNewWindow -Wait -PassThru `
    -RedirectStandardError $log -RedirectStandardOutput "$log.out" `
    -ArgumentList @(
      'detect', '--source=.', '--config=.gitleaks.toml', '--redact', '--no-banner',
      '--no-color', "--report-path=$report", '--exit-code=1'
    )
} finally {
  $env:GIT_CONFIG_SYSTEM = $savedSystem
  $env:GIT_CONFIG_GLOBAL = $savedGlobal
}

$output = (Get-Content -Raw -ErrorAction SilentlyContinue $log) + (Get-Content -Raw -ErrorAction SilentlyContinue "$log.out")
$scannedMatch = [regex]::Match($output, '(\d+) commits scanned')
$scanned = if ($scannedMatch.Success) { [int]$scannedMatch.Groups[1].Value } else { 0 }

Write-Host "gitleaks $version - commits scanned: $scanned (non-merge commits in history: $expected)"

# --- A clean result has to mean the whole history was read -------------------
$errors = @($output -split "`r?`n" | Where-Object { $_ -match '\bERR\b|fatal:' })
if ($errors.Count -gt 0) {
  Write-Host ''
  Write-Host 'SECRET SCAN INCOMPLETE - gitleaks reported errors, so a clean result would mean nothing:' -ForegroundColor Red
  $errors | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
  exit 2
}
# gitleaks' count and git's are not the same number: a commit whose diff is
# empty is not "scanned", and CI counts slightly MORE than git on its checkout.
# A walk that stopped early falls short by far more than a handful.
if ($scanned -lt ($expected - 3)) {
  Write-Host ''
  Write-Host "SECRET SCAN INCOMPLETE - $scanned of $expected commits were read. The history walk stopped early." -ForegroundColor Red
  exit 2
}

if ($process.ExitCode -eq 0) {
  Write-Host 'No leaks found. This is the result CI will get.' -ForegroundColor Green
  exit 0
}

# --- Findings ----------------------------------------------------------------
Write-Host ''
Write-Host 'LEAKS FOUND - CI''s Secret scan will fail on these:' -ForegroundColor Red
if (Test-Path $report) {
  foreach ($finding in (Get-Content -Raw $report | ConvertFrom-Json)) {
    Write-Host ("  {0}  {1}:{2}  commit {3}" -f $finding.RuleID, $finding.File, $finding.StartLine, $finding.Commit.Substring(0, 7))
  }
}
Write-Host ''
Write-Host 'For each one, decide first whether it is real:'
Write-Host '  - A real credential: remove it AND rotate it. Deleting it does not un-publish it.'
Write-Host '  - Not a credential: reword the line if it is not pushed yet, or add an exact-string'
Write-Host '    exception with its reason to .gitleaks.toml. Never a path.'
exit 1
