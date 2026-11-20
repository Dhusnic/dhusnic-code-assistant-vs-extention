param([Parameter(Mandatory = $true)][string]$Version)
# Tests -> package -> install into the local VS Code. Reload the VS Code window afterwards to load the new build.
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
# The code CLI can print Node deprecation warnings on stderr; only its exit code decides success.
$ErrorActionPreference = 'Continue'
code --install-extension $vsix.FullName --force 2>$null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'install failed' }
Write-Host "Deployed $($vsix.Name). Reload the window: Ctrl+Shift+P -> Developer: Reload Window"

