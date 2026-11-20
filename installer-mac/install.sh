#!/bin/bash
# Infraon Code Assistant - one-click macOS installer and updater.
# First install: installs VS Code if it is missing, installs the extension, asks for the API key, and configures everything.
# Already installed: updates the extension in place and keeps the saved API key (no questions).
# --reset-key: asks for the API key again (also when updating) and replaces the saved one.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="https://172.16.48.75:30400/v1"
EXT_ID="infraon.infraon-code-assistant"
RESET_KEY=0
for arg in "$@"; do
  case "$arg" in
    --reset-key|-ResetKey) RESET_KEY=1 ;;
  esac
done

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
NEW_VERSION="$(basename "$VSIX" | sed -E 's/.*-([0-9]+\.[0-9]+\.[0-9]+)\.vsix$/\1/')"
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

# --- 2. Fresh install or update? An installed extension means the API key is already saved. ---
step "Checking for an existing installation"
INSTALLED_VERSION="$("$CODE" --list-extensions --show-versions 2>/dev/null | grep -i "^$EXT_ID@" | head -1 | cut -d@ -f2 || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  IS_UPDATE=1
  if [ "$INSTALLED_VERSION" = "$NEW_VERSION" ]; then ok "Version $INSTALLED_VERSION is installed - reinstalling it."
  else ok "Version $INSTALLED_VERSION is installed - updating to $NEW_VERSION."; fi
else
  IS_UPDATE=0
  ok "Not installed yet - fresh install of $NEW_VERSION."
fi

# --- 3. API key: asked only on a fresh install or with --reset-key ---
KEY=""
step "API key"
if [ "$IS_UPDATE" = 1 ] && [ "$RESET_KEY" = 0 ]; then
  ok "Keeping your saved API key. (To change it: bash install.sh --reset-key)"
else
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
fi

# --- 4. Install or update the extension ---
if [ "$IS_UPDATE" = 1 ]; then step "Updating the extension"; else step "Installing the extension"; fi
"$CODE" --install-extension "$VSIX" --force || die "Extension install failed."
ok "Infraon Code Assistant $NEW_VERSION installed."

# --- 5. Configure (only when a key was entered) ---
if [ -n "$KEY" ]; then
  step "Configuring"
  # The extension moves this into VS Code's encrypted secret store on first start, then deletes the file.
  # replace = true: an explicit --reset-key overwrites the saved key; a fresh install has none to overwrite.
  REPLACE=false; [ "$RESET_KEY" = 1 ] && REPLACE=true
  DIR="$HOME/.infraon-assistant"
  mkdir -p "$DIR"
  chmod 700 "$DIR"
  umask 077
  printf '{"apiKey":"%s","replace":%s}\n' "$KEY" "$REPLACE" > "$DIR/setup.json"
  chmod 600 "$DIR/setup.json"
  KEY=""
  ok "API key staged for secure storage (moved into VS Code on first launch)."
fi

# --- 6. Launch ---
step "Starting VS Code"
if pgrep -x "Electron" >/dev/null 2>&1 || pgrep -f "Visual Studio Code.app" >/dev/null 2>&1; then
  warn 'VS Code was already open: press Cmd+Shift+P -> "Developer: Reload Window" once so the new version starts.'
fi
open -a "Visual Studio Code" 2>/dev/null || "$CODE" >/dev/null 2>&1 || true

echo
if [ "$IS_UPDATE" = 1 ] && [ "$RESET_KEY" = 1 ]; then
  printf '\033[32m  Updated to %s! Your settings were kept and your new API key is used after the reload.\033[0m\n\n' "$NEW_VERSION"
elif [ "$IS_UPDATE" = 1 ]; then
  printf '\033[32m  Updated to %s! Your settings and API key were kept.\033[0m\n\n' "$NEW_VERSION"
else
  printf '\033[32m  Done! Click the "Infraon Assistant" icon in the VS Code activity bar to start.\033[0m\n\n'
fi
