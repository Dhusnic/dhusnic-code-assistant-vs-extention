# Infraon Code Assistant - one-click Windows installer and updater.
# First install: installs VS Code if it is missing, installs the extension, asks for the API key, and configures everything.
# Already installed: updates the extension in place and keeps the saved API key (no questions).
# -ResetKey: asks for the API key again (also when updating) and replaces the saved one.
param([string]$Vsix, [switch]$ResetKey)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseUrl = 'https://172.16.48.75:30400/v1'
$ExtId = 'infraon.infraon-code-assistant'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  Infraon Code Assistant - installer' -ForegroundColor White
Write-Host '  ----------------------------------'

# --- find the extension package ---
if (-not $Vsix) {
    $found = Get-ChildItem -Path $here -Filter 'infraon-code-assistant-*.vsix' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
    if (-not $found) { throw "Cannot find infraon-code-assistant-*.vsix next to this script ($here). Extract the whole zip first." }
    $Vsix = $found.FullName
}
$newVersion = if ((Split-Path -Leaf $Vsix) -match '-(\d+\.\d+\.\d+)\.vsix$') { $Matches[1] } else { '?' }
Ok "Package: $(Split-Path -Leaf $Vsix)"

# --- 1. VS Code (the only dependency; Node, ripgrep and the SSH library are bundled) ---
function Find-Code {
    $cmd = Get-Command code.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
        "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
        "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

Step 'Checking Visual Studio Code'
$code = Find-Code
if (-not $code) {
    Warn 'VS Code not found - installing it (per-user, no admin needed).'
    $installed = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
            winget install --id Microsoft.VisualStudioCode --scope user --silent --accept-package-agreements --accept-source-agreements
            $installed = ($LASTEXITCODE -eq 0)
        } catch { $installed = $false }
    }
    if (-not $installed) {
        Warn 'winget unavailable - downloading the official installer from code.visualstudio.com.'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $exe = Join-Path $env:TEMP 'VSCodeUserSetup.exe'
        Invoke-WebRequest -Uri 'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user' -OutFile $exe -UseBasicParsing
        Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath' -Wait
        Remove-Item $exe -Force -ErrorAction SilentlyContinue
    }
    $code = Find-Code
    if (-not $code) { throw 'VS Code installation failed. Install it from https://code.visualstudio.com and run this script again.' }
}
Ok "VS Code: $code"

# --- 2. Fresh install or update? An installed extension means the API key is already saved. ---
Step 'Checking for an existing installation'
$installedVersion = $null
# The code CLI may print Node warnings on stderr; in Windows PowerShell 5.1 that must not stop the script.
$ErrorActionPreference = 'Continue'
$listed = & $code --list-extensions --show-versions 2>$null
$ErrorActionPreference = 'Stop'
foreach ($line in @($listed)) {
    if ("$line" -like "$ExtId@*") { $installedVersion = "$line".Substring($ExtId.Length + 1) }
}
$isUpdate = [bool]$installedVersion
if ($isUpdate) {
    if ($installedVersion -eq $newVersion) { Ok "Version $installedVersion is installed - reinstalling it." }
    else { Ok "Version $installedVersion is installed - updating to $newVersion." }
} else {
    Ok "Not installed yet - fresh install of $newVersion."
}

# --- 3. API key: asked only on a fresh install or with -ResetKey ---
$key = $null
Step 'API key'
if ($isUpdate -and -not $ResetKey) {
    Ok 'Keeping your saved API key. (To change it: Install-InfraonAssistant.bat -ResetKey)'
} else {
    $secure = Read-Host 'Paste your Infraon LLM API key (input is hidden)' -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
    if (-not $key) { throw 'No API key entered. Run the installer again.' }

    # Quick check against the gateway (internal self-signed certificate is expected).
    try {
        Add-Type -TypeDefinition 'using System.Net;using System.Security.Cryptography.X509Certificates;public class TrustAll:ICertificatePolicy{public bool CheckValidationResult(ServicePoint s,X509Certificate c,WebRequest r,int p){return true;}}' -ErrorAction SilentlyContinue
        [Net.ServicePointManager]::CertificatePolicy = New-Object TrustAll
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $null = Invoke-RestMethod -Uri "$BaseUrl/models" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
        Ok 'Key accepted by the Infraon LLM gateway.'
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($status -eq 401 -or $status -eq 403) {
            throw 'The gateway rejected this API key. Check it and run the installer again.'
        }
        Warn 'Could not reach the gateway to verify the key (are you on the office network / VPN?). Continuing - the key is saved anyway.'
    }
}

# --- 4. Install or update the extension ---
Step $(if ($isUpdate) { 'Updating the extension' } else { 'Installing the extension' })
& $code --install-extension $Vsix --force
if ($LASTEXITCODE -ne 0) { throw 'Extension install failed.' }
Ok "Infraon Code Assistant $newVersion installed."

# --- 5. Configure (only when a key was entered) ---
if ($key) {
    Step 'Configuring'
    # The extension moves this into VS Code's encrypted secret store on first start, then deletes the file.
    # replace = true: an explicit -ResetKey overwrites the saved key; a fresh install has none to overwrite.
    $dir = Join-Path $env:USERPROFILE '.infraon-assistant'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $setup = Join-Path $dir 'setup.json'
    [IO.File]::WriteAllText($setup, (@{ apiKey = $key; replace = [bool]$ResetKey } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    # Only this user may read it.
    icacls $setup /inheritance:r /grant:r "$($env:USERNAME):(R,W,D)" | Out-Null
    $key = $null
    # Gateway address, self-signed TLS and model are the extension defaults; nothing else to set.
    Ok 'API key staged for secure storage (moved into VS Code on first launch).'
}

# --- 6. Launch ---
Step 'Starting VS Code'
$running = Get-Process -Name Code -ErrorAction SilentlyContinue
& $code
if ($running) {
    Warn 'VS Code was already open: press Ctrl+Shift+P -> "Developer: Reload Window" once so the new version starts.'
}

Write-Host ''
if ($isUpdate -and $ResetKey) {
    Write-Host "  Updated to $newVersion! Your settings were kept and your new API key is used after the reload." -ForegroundColor Green
} elseif ($isUpdate) {
    Write-Host "  Updated to $newVersion! Your settings and API key were kept." -ForegroundColor Green
} else {
    Write-Host '  Done! Click the "Infraon Assistant" icon in the VS Code activity bar to start.' -ForegroundColor Green
}
Write-Host ''
