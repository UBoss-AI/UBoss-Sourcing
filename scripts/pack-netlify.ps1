<#
.SYNOPSIS
    Builds the three front ends and packs each one into a zip you can drop
    onto Netlify.

.DESCRIPTION
    One zip per application, each containing that application's built files at
    the root of the archive plus a netlify.toml with the API origin filled in.
    Netlify's "deploy manually" box takes the zip as-is: drag it in and the
    site is live, with the single-page-application fallback and the /api proxy
    already configured.

    WHAT THIS DOES NOT DO: put the API anywhere. The API is a Fastify server
    with a MariaDB database and a background worker, and none of that runs on a
    static host. -ApiOrigin is where it already is. Without a reachable one,
    the sites render and nobody can sign in.

    The bundles themselves contain no hostname. `.env.netlify` sets
    VITE_API_BASE_URL to the relative `/api/v1`, so every request goes to
    whichever host served the page and the netlify.toml proxy forwards it on.
    That is what keeps the browser seeing one origin, which is what lets the
    session and CSRF cookies stay SameSite=Lax. Only the netlify.toml in each
    zip knows the API's address, so pointing these at a different API is a
    re-pack, never a rebuild of the JavaScript.

.PARAMETER ApiOrigin
    Public base URL of the API, scheme included, no trailing slash and no
    path. For example https://api.your-company.com

    Leave it out and the placeholder from each netlify.toml is kept, which
    produces zips that deploy and cannot reach an API. Useful for looking at
    the UI, useless for signing in.

.PARAMETER Apps
    Which of the three to pack. All of them by default.

.PARAMETER OutDir
    Where the zips are written. Defaults to output/netlify, which is
    gitignored.

.PARAMETER SkipBuild
    Pack whatever is already in each app's dist/ instead of rebuilding.
    Fails if a dist is missing. For a second pack against a different
    -ApiOrigin, where rebuilding would produce identical bytes.

.EXAMPLE
    .\scripts\pack-netlify.ps1 -ApiOrigin https://api.your-company.com

.EXAMPLE
    # Same bundles, pointed at a tunnel so somebody else can try it today.
    .\scripts\pack-netlify.ps1 -ApiOrigin https://abc123.ngrok-free.dev -SkipBuild
#>

[CmdletBinding()]
param(
    [string] $ApiOrigin,

    [ValidateSet('customer-web', 'admin-web', 'logistics-web')]
    [string[]] $Apps = @('customer-web', 'admin-web', 'logistics-web'),

    [string] $OutDir,

    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The repository root, from this script's own location, so the script works
# from any working directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'output\netlify' }

# The string every netlify.toml ships with. Substituted, not templated, so the
# committed file stays a valid netlify.toml that a git-connected site can use
# directly - a `{{API_ORIGIN}}` placeholder would make it valid for this script
# and broken for everything else.
$placeholder = 'https://uboss-api.example.com'

if ($ApiOrigin) {
    $ApiOrigin = $ApiOrigin.TrimEnd('/')

    if ($ApiOrigin -notmatch '^https?://[^/\s]+$') {
        throw "-ApiOrigin must be a scheme and a host and nothing else, e.g. https://api.your-company.com - got '$ApiOrigin'"
    }

    # Not fatal, because a private network or a plain-HTTP tunnel is a real
    # thing to be testing against. It is said out loud because the failure it
    # causes is silent: Netlify serves the page over HTTPS, the browser refuses
    # to attach a cookie that is not Secure, and the sign-in looks like it
    # worked and did nothing.
    if ($ApiOrigin.StartsWith('http://')) {
        Write-Warning "$ApiOrigin is plain HTTP. Netlify serves these sites over HTTPS, so cookies need COOKIE_SECURE=true on the API, and a Secure cookie is not sent over http://. Sign-in will fail. Use an HTTPS origin."
    }
} else {
    Write-Warning "No -ApiOrigin given: the zips keep the placeholder $placeholder and will not reach an API. Re-run with -ApiOrigin once the API has a public URL."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# Both, and not just the second one. `ZipArchive` and `ZipArchiveMode` live in
# System.IO.Compression; `ZipFileExtensions` and the file-based helpers live in
# System.IO.Compression.FileSystem. Loading only the FileSystem assembly gets as
# far as "Unable to find type [System.IO.Compression.ZipArchiveMode]".
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$built = @()

foreach ($app in $Apps) {
    $appDir = Join-Path $repoRoot "apps\$app"
    $distDir = Join-Path $appDir 'dist'
    $tomlSrc = Join-Path $appDir 'netlify.toml'

    if (-not (Test-Path $appDir)) { throw "No such application: $appDir" }
    if (-not (Test-Path $tomlSrc)) { throw "Missing $tomlSrc - the redirects and headers live in it, and a zip without it is a site where every reload is a 404." }

    Write-Host ''
    Write-Host "=== $app ===" -ForegroundColor Cyan

    if ($SkipBuild) {
        if (-not (Test-Path $distDir)) { throw "-SkipBuild was given but $distDir does not exist. Run once without it." }
        Write-Host 'Reusing the existing dist/.'
    } else {
        Write-Host 'Building...'
        Push-Location $appDir
        try {
            # `npm run` returns the script's exit code, and PowerShell does not
            # treat a non-zero one from a native command as an error - so
            # without this check a failed build packs the PREVIOUS dist and
            # reports success.
            npm run build:netlify
            if ($LASTEXITCODE -ne 0) { throw "npm run build:netlify failed in $app (exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
    }

    # Stage rather than zip dist/ directly: netlify.toml has to sit beside
    # index.html at the root of the archive, and writing it into dist/ would
    # leave a file behind that the next `vite build` does not clean up and that
    # nothing in the repository accounts for.
    $staging = Join-Path $OutDir "_staging-$app"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null

    Copy-Item -Path (Join-Path $distDir '*') -Destination $staging -Recurse -Force

    $toml = Get-Content -Raw -Path $tomlSrc
    if ($ApiOrigin) { $toml = $toml.Replace($placeholder, $ApiOrigin) }

    # Cut the [build] section out.
    #
    # THIS IS NOT TIDYING. A manual zip deploy reads netlify.toml exactly like a
    # git-connected one does, build command included - so a zip carrying
    # `command = "npm run build:netlify"` makes Netlify try to BUILD the site it
    # was just handed. The zip is the built output; it has no package.json and
    # no source, so npm exits 254, the deploy fails and nothing is published.
    #
    # The markers are in each app's netlify.toml so this cut is declared there
    # rather than inferred here by pattern-matching TOML.
    $cut = [regex]::Match(
        $toml,
        '(?ms)^\#\s*>>>\s*BUILD SETTINGS.*?^\#\s*<<<\s*BUILD SETTINGS END[^\r\n]*\r?\n')

    if (-not $cut.Success) {
        throw "No build-settings markers in $tomlSrc. They are what keeps the build command out of the zip, and without the cut Netlify fails the deploy with 'exit code 254: npm run build:netlify'. Restore the '# >>> BUILD SETTINGS' / '# <<< BUILD SETTINGS END' pair around the [build] blocks."
    }

    $toml = $toml.Remove($cut.Index, $cut.Length).Insert($cut.Index, @"
# No [build] section, deliberately.
#
# This file was written by scripts/pack-netlify.ps1 into a zip that already
# holds the built site. Netlify reads a manual deploy's netlify.toml in full,
# so a build command here would make it try to rebuild a folder that has no
# source in it, fail with exit code 254 and publish nothing.
#
# The redirects and headers below DO apply to a manual deploy, which is the
# whole reason this file is in the zip.

"@)

    # UTF-8 without a BOM. Netlify's TOML parser treats a leading BOM as part
    # of the first key and rejects the file, which costs a deploy to discover.
    [System.IO.File]::WriteAllText(
        (Join-Path $staging 'netlify.toml'),
        $toml,
        (New-Object System.Text.UTF8Encoding($false))
    )

    $zip = Join-Path $OutDir "uboss-$app.zip"
    if (Test-Path $zip) { Remove-Item -Force $zip }

    # Entry by entry, with the separator written by hand.
    #
    # THE REASON THIS IS NOT ONE CALL TO Compress-Archive OR CreateFromDirectory:
    # both of them, on Windows PowerShell 5.1 / .NET Framework, write nested
    # entry names with a BACKSLASH - `assets\index-a1b2c3.js`. The zip format
    # says forward slash. Unzipping on Windows papers over it; Netlify does not,
    # and the result is a site that serves index.html and then 404s every single
    # script and stylesheet it asks for. The page is blank, the deploy log is
    # green, and the file listing in Netlify shows one file with a strange name.
    #
    # It was verified by reading the entry names back out of the archive, which
    # is the only way to see it - it is invisible from Explorer.
    $zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
    try {
        $archive = New-Object System.IO.Compression.ZipArchive(
            $zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            $prefix = (Resolve-Path $staging).Path.TrimEnd('\') + '\'

            foreach ($file in Get-ChildItem -Path $staging -Recurse -File) {
                $entryName = $file.FullName.Substring($prefix.Length).Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, $file.FullName, $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $zipStream.Dispose()
    }

    Remove-Item -Recurse -Force $staging

    $sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    Write-Host "Packed $zip ($sizeMb MB)" -ForegroundColor Green
    $built += [pscustomobject]@{ App = $app; Zip = $zip; SizeMB = $sizeMb }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
$built | Format-Table -AutoSize

Write-Host @"
Next, in Netlify:

  1. Sites -> Add new site -> Deploy manually, and drop ONE zip per site.
     Three zips means three sites; they are separate applications with
     separate sign-ins and the console must not share a hostname with the
     storefront.

  2. On the API, for each site URL Netlify gives back:
       COOKIE_SECURE=true          Netlify is HTTPS. Without this the browser
                                   drops the session cookie and every sign-in
                                   silently does nothing.
       CUSTOMER_WEB_ORIGIN         add the storefront site's URL
       ADMIN_WEB_ORIGIN            add the console site's URL
       LOGISTICS_WEB_ORIGIN        add the portal site's URL
       *_PUBLIC_URL                the same three URLs - these are what the
                                   links in emails point at
     Restart the API afterwards: they are read once, at boot.

  3. Put the admin console behind Netlify password protection or an access
     policy before there is real data behind it. It is the screen where prices,
     refunds and staff accounts are changed, and a Netlify URL is public.
"@
