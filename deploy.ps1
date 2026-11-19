param([Parameter(Mandatory = $true)][string]$Version)
# Tests -> package -> install into the local VS Code. Reload the VS Code window afterwards to load the new build.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.version = $Version
[IO.File]::WriteAllText("$PSScriptRoot\package.json", ($pkg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))

npx tsc -p .
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
node --test "out/test/*.test.js"
if ($LASTEXITCODE -ne 0) { throw 'tests failed - not deploying' }

Get-ChildItem *.vsix -ErrorAction SilentlyContinue | Remove-Item -Force
npx vsce package --allow-missing-repository --skip-license | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'package failed' }
$vsix = Get-ChildItem *.vsix | Select-Object -First 1
code --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw 'install failed' }
Write-Host "Deployed $($vsix.Name). Reload the window: Ctrl+Shift+P -> Developer: Reload Window"

