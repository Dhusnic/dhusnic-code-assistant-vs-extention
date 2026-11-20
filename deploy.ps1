param(
    [Parameter(Mandatory = $true)][string]$Version,
    # Also sign the package and publish it to the update server, so installed extensions update themselves.
    [switch]$Publish,
    # scp destination of the server's updates folder, e.g. user@172.16.48.75:/srv/infraon-assistant/updates
    [string]$PublishTarget = $env:INFRAON_UPDATE_TARGET,
    [string]$Notes = '',
    # Clients must reload (modal prompt) instead of being allowed to postpone.
    [switch]$Mandatory
)
# Tests -> package -> install into the local VS Code. Reload the VS Code window afterwards to load the new build.
# With -Publish: also signs the package and copies it, then latest.json, to the update server.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Node keeps package.json's formatting; PowerShell 5.1's ConvertTo-Json re-indents it and escapes quotes as '.
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version=process.argv[1];fs.writeFileSync('package.json',JSON.stringify(p,null,4)+'\n')" $Version
if ($LASTEXITCODE -ne 0) { throw 'could not set the version' }

npx tsc -p .
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
node --test "out/test/*.test.js"
if ($LASTEXITCODE -ne 0) { throw 'tests failed - not deploying' }
# Slow tests (they start many processes) run on their own so timing-sensitive tests are not starved.
node --test --test-concurrency=1 "out/test/slow/*.test.js"
if ($LASTEXITCODE -ne 0) { throw 'tests failed - not deploying' }

Get-ChildItem *.vsix -ErrorAction SilentlyContinue | Remove-Item -Force
# vsce prints advice (e.g. about bundling) on stderr; only its exit code decides success.
$ErrorActionPreference = 'Continue'
npx vsce package --allow-missing-repository --skip-license 2>$null | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'package failed' }
$vsix = Get-ChildItem *.vsix | Select-Object -First 1

if ($Publish) {
    $stage = Join-Path $PSScriptRoot 'dist\updates'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    $signArgs = @('scripts/sign-update.js', '--vsix', $vsix.FullName, '--out', $stage)
    if ($Notes) { $signArgs += @('--notes', $Notes) }
    if ($Mandatory) { $signArgs += '--mandatory' }
    node @signArgs
    if ($LASTEXITCODE -ne 0) { throw 'signing failed - not publishing' }
    if ($PublishTarget) {
        $target = $PublishTarget.TrimEnd('/')
        # Package first, manifest last: a client never sees a manifest whose package is not on the server yet.
        scp (Join-Path $stage $vsix.Name) "$target/"
        if ($LASTEXITCODE -ne 0) { throw 'copying the package to the update server failed' }
        scp (Join-Path $stage 'latest.json') "$target/latest.json"
        if ($LASTEXITCODE -ne 0) { throw 'copying latest.json to the update server failed' }
        Write-Host "Published $Version to $target. Installed extensions pick it up within 4 hours (or: Infraon Assistant: Check for Updates)."
    } else {
        Write-Host "Signed release staged in $stage. Copy the .vsix, then latest.json, to the server's /infraon-assistant/updates/ folder (or pass -PublishTarget)."
    }
}
# The code CLI can print Node deprecation warnings on stderr; only its exit code decides success.
$ErrorActionPreference = 'Continue'
code --install-extension $vsix.FullName --force 2>$null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'install failed' }
Write-Host "Deployed $($vsix.Name). Reload the window: Ctrl+Shift+P -> Developer: Reload Window"

