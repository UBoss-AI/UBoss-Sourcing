<#
.SYNOPSIS
    Start, stop and check the whole UBOSS development stack in one command.

.DESCRIPTION
    SETUP.md Part 2 asks for four terminals and a MariaDB that XAMPP starts by
    hand. That works, but it hides two failures that cost an afternoon each:

      1. XAMPP's MariaDB is not a Windows service here, so `net start mysql`
         and `Get-Service mysql` both find nothing and it is easy to believe
         the database is up when it was never started.
      2. `tsx watch` keeps its parent alive after its child crashes. When the
         API dies on boot - almost always because the database was not up -
         the terminal still looks healthy, and the only visible symptom is
         Vite answering `http proxy error: /api/v1/... ECONNREFUSED`.

    So this script never trusts a process list. It checks the thing that
    actually matters - is the port answering - and treats "process alive but
    port dead" as a crash to be cleaned up and restarted, not as running.

    Everything is launched detached with Start-Process, never as a background
    task of an editor or agent: on a 16 GB machine those get reaped as a group
    under memory pressure, which leaves half the stack orphaned and is worse
    than a clean stop.

.PARAMETER Tunnel
    Start the frontends in tunnel mode and start the ngrok agent, for showing
    the app to somebody who is not at this computer. See SETUP.md Part 3.

.PARAMETER Local
    Force plain local mode. Only needed to come back down from tunnel mode: a
    stack already running through a tunnel stays that way across a restart,
    because silently dropping the tunnel breaks the URL somebody else is on.

.PARAMETER Stop
    Stop everything this script started, plus any stray stack process it can
    identify. Leaves MariaDB alone unless -IncludeDatabase is given.

.PARAMETER Restart
    Stop first, then start. Use when a server is holding a port with stale code.

.PARAMETER Status
    Report what is up and what is down, and change nothing.

.PARAMETER IncludeDatabase
    Let -Stop shut MariaDB down too. Off by default because phpMyAdmin, Prisma
    Studio and any other project on this machine share that one server.

.PARAMETER SkipDatabase
    Do not start or check MariaDB - for when the database lives somewhere else.

.PARAMETER TimeoutSeconds
    How long to wait for each component to answer before calling it failed.

.EXAMPLE
    .\scripts\dev-stack.ps1
    Start the five local processes and print where everything is.

.EXAMPLE
    .\scripts\dev-stack.ps1 -Status
    Ask what is running without touching anything.

.EXAMPLE
    .\scripts\dev-stack.ps1 -Restart -Tunnel
    Clean restart, frontends in tunnel mode, ngrok last.
#>

[CmdletBinding()]
param(
    [switch]$Tunnel,
    [switch]$Local,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Status,
    [switch]$IncludeDatabase,
    [switch]$SkipDatabase,
    [int]$TimeoutSeconds = 90,
    [string]$MysqldPath = 'C:\xampp\mysql\bin\mysqld.exe',
    [string]$MysqlIni = 'C:\xampp\mysql\bin\my.ini',
    [string]$NgrokTunnelName = 'shop'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot '.dev-logs'
$StateFile = Join-Path $LogDir 'dev-stack.pids.json'

# ---------------------------------------------------------------------------
# Output helpers. Colour carries the same information as the words, never
# instead of them, so this stays readable in a terminal that has no colour and
# in a log file that has stripped it.
# ---------------------------------------------------------------------------

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * $Text.Length) -ForegroundColor DarkGray
}
function Write-Ok([string]$Text) { Write-Host "  OK    $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  ..    $Text" -ForegroundColor Gray }
function Write-Warn([string]$Text) { Write-Host "  WARN  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  FAIL  $Text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Ports and processes
# ---------------------------------------------------------------------------

function Test-Port([int]$Port) {
    $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return [bool]$listening
}

function Wait-Port([int]$Port, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-NodeProcesses {
    # Win32_Process is the only place the command line lives, and the command
    # line is the only way to tell five identical node.exe apart.
    $all = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    if ($null -eq $all) { return @() }
    return @($all)
}

function Find-ByCommandLine([string]$Fragment) {
    # Not $matches - that is an automatic variable PowerShell rewrites on every
    # -match, and it is silently clobbered the moment anything in here matches.
    $found = @()
    foreach ($proc in Get-NodeProcesses) {
        if ($null -ne $proc.CommandLine -and $proc.CommandLine -like "*$Fragment*") {
            $found += $proc
        }
    }
    return $found
}

function Stop-Tree([int]$ProcessId) {
    # Depth first: a parent killed before its children leaves the children
    # orphaned and still holding their ports, which is the exact state this
    # script exists to avoid creating.
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($null -ne $children) {
        foreach ($child in @($children)) { Stop-Tree ([int]$child.ProcessId) }
    }
    try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch { }
}

function Get-RootWrapper([int]$ProcessId) {
    # Walk up from a tsx or vite process to the `npm run ...` wrapper that owns
    # it, so stopping kills the whole thing rather than leaving npm to respawn
    # or to sit there looking like a running server.
    $current = $ProcessId
    $best = $ProcessId
    for ($hop = 0; $hop -lt 6; $hop++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if ($null -eq $proc) { break }
        $parentId = [int]$proc.ParentProcessId
        if ($parentId -le 0) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
        if ($null -eq $parent) { break }
        if ($parent.Name -ne 'node.exe' -and $parent.Name -ne 'cmd.exe') { break }
        if ($null -ne $parent.CommandLine -and
            ($parent.CommandLine -like '*npm-cli.js*' -or $parent.CommandLine -like '*npm.cmd*')) {
            $best = $parentId
        }
        $current = $parentId
    }
    return $best
}

# ---------------------------------------------------------------------------
# The components, in start order. Order is not cosmetic: the API exits on boot
# if the database will not answer, and ngrok connects to nothing if it goes
# first.
# ---------------------------------------------------------------------------

function Get-Components {
    $viteScript = 'dev'
    if ($Tunnel) { $viteScript = 'dev:tunnel' }

    $list = @()

    if (-not $SkipDatabase) {
        $list += [pscustomobject]@{
            Key = 'db'; Name = 'MariaDB (XAMPP)'; Port = 3306
            Kind = 'exe'; Exe = $MysqldPath
            Args = @("--defaults-file=$MysqlIni", '--standalone')
            Cwd = $RepoRoot; Match = $null; Url = $null
            Ready = $null
        }
    }

    $list += [pscustomobject]@{
        Key = 'api'; Name = 'API'; Port = 4000
        Kind = 'npm'; Exe = $null; Args = @('run', 'dev')
        Cwd = (Join-Path $RepoRoot 'backend'); Match = 'src/http/server.ts'
        Url = 'http://localhost:4000'
        Ready = 'http://localhost:4000/health/ready'
    }

    # The worker binds no port, so "is it up" has to be asked a different way:
    # a live tsx child under the tsx watch parent. That distinction is the
    # whole point - the parent alone proves nothing.
    $list += [pscustomobject]@{
        Key = 'worker'; Name = 'Worker (emails, schedules, retries)'; Port = $null
        Kind = 'npm'; Exe = $null; Args = @('run', 'dev:worker')
        Cwd = (Join-Path $RepoRoot 'backend'); Match = 'src/worker/index.ts'
        Url = $null; Ready = $null
    }

    $list += [pscustomobject]@{
        Key = 'admin'; Name = 'Admin panel'; Port = 5173
        Kind = 'npm'; Exe = $null; Args = @('run', $viteScript)
        Cwd = (Join-Path $RepoRoot 'apps\admin-web'); Match = 'apps\admin-web'
        Url = 'http://localhost:5173'; Ready = $null
    }

    $list += [pscustomobject]@{
        Key = 'shop'; Name = 'Storefront'; Port = 5174
        Kind = 'npm'; Exe = $null; Args = @('run', $viteScript)
        Cwd = (Join-Path $RepoRoot 'apps\customer-web'); Match = 'apps\customer-web'
        Url = 'http://localhost:5174'; Ready = $null
    }

    # Listed when asked for, and also whenever one is already running: a status
    # report that omits a live tunnel is telling you the stack is local when
    # it is in fact published to the internet.
    $ngrokRunning = [bool](Get-Process ngrok -ErrorAction SilentlyContinue)
    if ($Tunnel -or $ngrokRunning) {
        $list += [pscustomobject]@{
            Key = 'ngrok'; Name = "ngrok agent ($NgrokTunnelName)"; Port = 4040
            Kind = 'exe'; Exe = 'ngrok'; Args = @('start', $NgrokTunnelName)
            Cwd = $RepoRoot; Match = $null
            Url = 'http://localhost:4040'; Ready = $null
        }
    }

    return $list
}

# ---------------------------------------------------------------------------
# Liveness. Ports first, always.
# ---------------------------------------------------------------------------

function Test-Component($Component) {
    if ($null -ne $Component.Port) { return (Test-Port $Component.Port) }

    # Worker: the tsx watch parent must exist AND still have a child. A parent
    # with no child is the crash this script was written for.
    if ($null -ne $Component.Match) {
        foreach ($parent in Find-ByCommandLine $Component.Match) {
            $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.ProcessId)" -ErrorAction SilentlyContinue
            if ($null -ne $child) { return $true }
        }
    }
    return $false
}

function Test-ComponentReady($Component) {
    # A listening port only proves something accepted the connection. Where a
    # component publishes a readiness endpoint, ask it - that is what catches
    # an API that is up but cannot reach the database.
    if ($null -eq $Component.Ready) { return $true }
    try {
        $response = Invoke-WebRequest -Uri $Component.Ready -UseBasicParsing -TimeoutSec 10
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-StaleProcesses($Component) {
    # Processes that match this component but whose port is dead: the zombie
    # case. Restarting on top of them just adds another dead tree.
    if ($null -eq $Component.Match) { return @() }
    if ($null -eq $Component.Port) { return @() }
    if (Test-Port $Component.Port) { return @() }
    return (Find-ByCommandLine $Component.Match)
}

# ---------------------------------------------------------------------------
# State file: which PIDs this script started, so -Stop is exact rather than a
# guess that could take down an unrelated node process.
# ---------------------------------------------------------------------------

function Read-State {
    if (-not (Test-Path $StateFile)) { return @{} }
    try {
        $raw = Get-Content $StateFile -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
        $object = $raw | ConvertFrom-Json
        $table = @{}
        foreach ($property in $object.PSObject.Properties) { $table[$property.Name] = [int]$property.Value }
        return $table
    } catch {
        return @{}
    }
}

function Write-State($Table) {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    ($Table | ConvertTo-Json -Depth 3) | Out-File -FilePath $StateFile -Encoding utf8
}

# ---------------------------------------------------------------------------
# Starting
# ---------------------------------------------------------------------------

function Start-Component($Component) {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    $outLog = Join-Path $LogDir "$($Component.Key).out.log"
    $errLog = Join-Path $LogDir "$($Component.Key).err.log"

    $exe = $Component.Exe
    $arguments = $Component.Args

    if ($Component.Kind -eq 'npm') {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($null -eq $npm) { throw "npm.cmd is not on PATH. Install Node 20.11+ and reopen the terminal." }
        $exe = $npm.Source
    } else {
        $resolved = Get-Command $exe -ErrorAction SilentlyContinue
        if ($null -ne $resolved) {
            $exe = $resolved.Source
        } elseif (-not (Test-Path $exe)) {
            throw "Cannot find $($Component.Name) at '$exe'."
        }
    }

    $process = Start-Process -FilePath $exe -ArgumentList $arguments `
        -WorkingDirectory $Component.Cwd -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    return $process.Id
}

function Show-Log($Component, [int]$Lines = 20) {
    foreach ($suffix in @('err', 'out')) {
        $path = Join-Path $LogDir "$($Component.Key).$suffix.log"
        if (Test-Path $path) {
            $tail = Get-Content $path -Tail $Lines -ErrorAction SilentlyContinue
            if ($null -ne $tail -and @($tail).Count -gt 0) {
                Write-Host "        --- $($Component.Key).$suffix.log ---" -ForegroundColor DarkGray
                foreach ($line in $tail) { Write-Host "        $line" -ForegroundColor DarkGray }
            }
        }
    }
}

function Invoke-Start {
    Write-Head 'Starting the UBOSS development stack'
    if ($Tunnel) { Write-Info 'Tunnel mode: frontends on --mode tunnel, ngrok last.' }

    $state = Read-State
    $failed = @()

    foreach ($component in Get-Components) {
        $label = $component.Name

        if (Test-Component $component) {
            if (Test-ComponentReady $component) {
                Write-Ok "$label already running"
                continue
            }
            Write-Warn "$label is listening but not ready - restarting it"
            foreach ($proc in Find-ByCommandLine $component.Match) {
                Stop-Tree (Get-RootWrapper ([int]$proc.ProcessId))
            }
            Start-Sleep -Milliseconds 800
        }

        $stale = Get-StaleProcesses $component
        if (@($stale).Count -gt 0) {
            # This is the `tsx watch` trap: a parent still alive over a child
            # that died on boot. Clear it before starting, or the new server
            # competes with a corpse.
            Write-Warn "$label has a dead process tree (crashed on boot) - clearing it"
            foreach ($proc in $stale) { Stop-Tree (Get-RootWrapper ([int]$proc.ProcessId)) }
            Start-Sleep -Milliseconds 800
        }

        Write-Info "starting $label"
        try {
            $pidStarted = Start-Component $component
            $state[$component.Key] = $pidStarted
        } catch {
            Write-Fail "$label could not be started: $($_.Exception.Message)"
            $failed += $component
            continue
        }

        if ($null -ne $component.Port) {
            if (-not (Wait-Port $component.Port $TimeoutSeconds)) {
                Write-Fail "$label never opened port $($component.Port)"
                Show-Log $component
                $failed += $component
                continue
            }
        } else {
            Start-Sleep -Seconds 3
        }

        if (-not (Test-Component $component)) {
            Write-Fail "$label started and then exited"
            Show-Log $component
            $failed += $component
            continue
        }

        # Readiness is given a second window of its own: Prisma's first
        # connection and the queue check happen after the port is already open.
        $readyDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $ready = Test-ComponentReady $component
        while (-not $ready -and (Get-Date) -lt $readyDeadline) {
            Start-Sleep -Milliseconds 900
            $ready = Test-ComponentReady $component
        }
        if (-not $ready) {
            Write-Fail "$label is up but not reporting ready ($($component.Ready))"
            Show-Log $component
            $failed += $component
            continue
        }

        Write-Ok "$label"
    }

    Write-State $state
    Show-Status
    Show-Endpoints

    if (@($failed).Count -gt 0) {
        Write-Host ''
        Write-Fail "$(@($failed).Count) component(s) did not come up. Logs are in .dev-logs\."
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Stopping
# ---------------------------------------------------------------------------

function Invoke-Stop {
    Write-Head 'Stopping the UBOSS development stack'
    $state = Read-State
    $stopped = 0

    foreach ($component in (Get-Components)) {
        if ($component.Key -eq 'db' -and -not $IncludeDatabase) { continue }

        $targets = @()
        if ($state.ContainsKey($component.Key)) { $targets += [int]$state[$component.Key] }
        if ($null -ne $component.Match) {
            foreach ($proc in Find-ByCommandLine $component.Match) {
                $targets += (Get-RootWrapper ([int]$proc.ProcessId))
            }
        }
        # ngrok is not a node process, so the command-line sweep above cannot
        # see it. Catch it by name as well, which also picks up an agent
        # somebody started by hand outside this script.
        if ($component.Key -eq 'ngrok') {
            foreach ($proc in @(Get-Process ngrok -ErrorAction SilentlyContinue)) {
                $targets += [int]$proc.Id
            }
        }

        $targets = @($targets | Sort-Object -Unique)
        foreach ($target in $targets) {
            if (Get-Process -Id $target -ErrorAction SilentlyContinue) {
                Stop-Tree $target
                $stopped++
            }
        }
        if (@($targets).Count -gt 0) { Write-Ok "$($component.Name) stopped" }
    }

    if ($IncludeDatabase) {
        $mysqld = Get-Process mysqld -ErrorAction SilentlyContinue
        if ($null -ne $mysqld) {
            foreach ($proc in @($mysqld)) { Stop-Tree $proc.Id }
            Write-Ok 'MariaDB stopped'
        }
    } else {
        Write-Info 'MariaDB left running (phpMyAdmin and Prisma Studio share it). Use -IncludeDatabase to stop it too.'
    }

    Write-State @{}
    Start-Sleep -Milliseconds 600

    # Confirm by port, for the same reason everything else here does.
    $stuck = @()
    foreach ($port in @(4000, 5173, 5174)) {
        if (Test-Port $port) { $stuck += $port }
    }
    if (@($stuck).Count -gt 0) {
        Write-Warn "Still listening: $($stuck -join ', '). Something outside this script is holding them."
    } else {
        Write-Ok 'Ports 4000, 5173 and 5174 are free'
    }
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

function Show-Status {
    Write-Head 'Status'
    $rows = @()
    foreach ($component in Get-Components) {
        $up = Test-Component $component
        $state = 'DOWN'
        if ($up) {
            if (Test-ComponentReady $component) { $state = 'UP' } else { $state = 'UP (not ready)' }
        }
        $portText = '-'
        if ($null -ne $component.Port) { $portText = [string]$component.Port }
        $rows += [pscustomobject]@{
            Component = $component.Name
            Port      = $portText
            State     = $state
        }
    }
    $rows | Format-Table -AutoSize | Out-String | Write-Host
}

function Show-Endpoints {
    Write-Head 'Where things are'
    Write-Host '  Storefront    http://localhost:5174'
    Write-Host '  Admin panel   http://localhost:5173'
    Write-Host '  API           http://localhost:4000   (/health/ready)'
    if ($Tunnel) {
        Write-Host '  ngrok         http://localhost:4040   (inspector; public URL is printed there)'
    }
    Write-Host ''
    Write-Host "  Logs          $LogDir" -ForegroundColor DarkGray
    Write-Host '  Sign-ins      SETUP.md, "Development logins"' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Preserve the mode the stack is already in.
#
# A plain -Restart used to be a silent downgrade: it stopped two Vite servers
# running `--mode tunnel` and an ngrok agent, then started the frontends in
# ordinary dev mode and never brought ngrok back. Everything reported OK, and
# the tunnel URL somebody else was looking at went to /admin/ 404s.
#
# So the mode is read from what is actually running before anything is stopped,
# and an explicit -Tunnel is still only ever additive.
# ---------------------------------------------------------------------------

if (-not $Tunnel) {
    $tunnelVite = @(Find-ByCommandLine '--mode tunnel')
    $ngrokLive = [bool](Get-Process ngrok -ErrorAction SilentlyContinue)
    if ((@($tunnelVite).Count -gt 0 -or $ngrokLive) -and -not $Local) {
        $Tunnel = $true
        if (-not $Status) {
            Write-Warn 'The stack is already in tunnel mode - keeping it there. Pass -Local to come back down to plain local mode.'
        }
    }
}

if ($Status) {
    Show-Status
    return
}

if ($Stop -and -not $Restart) {
    Invoke-Stop
    return
}

if ($Restart) {
    Invoke-Stop
    Start-Sleep -Seconds 1
}

Invoke-Start
