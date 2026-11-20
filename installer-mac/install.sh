#!/bin/bash
# Infraon Code Assistant - one-click macOS installer.
# Installs VS Code if it is missing, installs the extension, asks for the API key, and configures everything.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="https://172.16.48.75:30400/v1"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$1"; exit 1; }

echo
echo "  Infraon Code Assistant - installer (macOS)"
echo "  ------------------------------------------"

# --- find the extension package ---
VSIX="$(ls "$HERE"/infraon-code-assistant-*.vsix 2>/dev/null | sort | tail -1)"
[ -n "$VSIX" ] || die "Cannot find infraon-code-assistant-*.vsix next to this script ($HERE). Unzip the whole archive first."
ok "Package: $(basename "$VSIX")"

# --- 1. VS Code (the only dependency; the SSH library is bundled in the extension) ---
find_code() {
  if command -v code >/dev/null 2>&1; then command -v code; return; fi
  for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app"; do
    [ -x "$app/Contents/Resources/app/bin/code" ] && { echo "$app/Contents/Resources/app/bin/code"; return; }
  done
}

step "Checking Visual Studio Code"
CODE="$(find_code || true)"
if [ -z "$CODE" ]; then
  warn "VS Code not found - installing it."
  if command -v brew >/dev/null 2>&1 && brew install --cask visual-studio-code; then
    :
  else
    warn "Homebrew not available - downloading the official build from code.visualstudio.com."
    TMP="$(mktemp -d)"
    curl -fL "https://code.visualstudio.com/sha/download?build=stable&os=darwin-universal" -o "$TMP/vscode.zip" || die "Download failed. Check your internet connection."
    unzip -q "$TMP/vscode.zip" -d "$TMP"
    DEST="/Applications"
    [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
    rm -rf "$DEST/Visual Studio Code.app"
    mv "$TMP/Visual Studio Code.app" "$DEST/"
    xattr -dr com.apple.quarantine "$DEST/Visual Studio Code.app" 2>/dev/null || true
    rm -rf "$TMP"
  fi
  CODE="$(find_code || true)"
  [ -n "$CODE" ] || die "VS Code installation failed. Install it from https://code.visualstudio.com and run this again."
fi
ok "VS Code: $CODE"

# --- 2. API key (the only question) ---
step "API key"
printf "Paste your Infraon LLM API key (input is hidden): "
read -r -s KEY < /dev/tty
echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[ -n "$KEY" ] || die "No API key entered. Run the installer again."

# Quick check against the gateway (internal self-signed certificate is expected, hence -k).
STATUS="$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $KEY" "$BASE_URL/models" || true)"
case "$STATUS" in
  200) ok "Key accepted by the Infraon LLM gateway." ;;
  401|403) die "The gateway rejected this API key. Check it and run the installer again." ;;
  *) warn "Could not reach the gateway to verify the key (are you on the office network / VPN?). Continuing - the key is saved anyway." ;;
esac

# --- 3. Install the extension ---
step "Installing the extension"
"$CODE" --install-extension "$VSIX" --force || die "Extension install failed."
ok "Infraon Code Assistant installed."

# --- 4. Configure ---
step "Configuring"
# The extension moves this into VS Code's encrypted secret store on first start, then deletes the file.
DIR="$HOME/.infraon-assistant"
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
printf '{"apiKey":"%s"}\n' "$KEY" > "$DIR/setup.json"
chmod 600 "$DIR/setup.json"
KEY=""
ok "API key staged for secure storage (moved into VS Code on first launch)."

# --- 5. Launch ---
step "Starting VS Code"
if pgrep -x "Electron" >/dev/null 2>&1 || pgrep -f "Visual Studio Code.app" >/dev/null 2>&1; then
  warn 'VS Code was already open: press Cmd+Shift+P -> "Developer: Reload Window" once so the assistant starts and picks up your key.'
fi
open -a "Visual Studio Code" 2>/dev/null || "$CODE" >/dev/null 2>&1 || true

echo
printf '\033[32m  Done! Click the "Infraon Assistant" icon in the VS Code activity bar to start.\033[0m\n\n'
