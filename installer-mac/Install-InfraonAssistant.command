#!/bin/bash
# Double-click launcher (Finder opens .command files in Terminal).
cd "$(dirname "$0")"
xattr -dr com.apple.quarantine . 2>/dev/null || true
bash ./install.sh
status=$?
if [ $status -ne 0 ]; then echo; echo "Installation did not complete. See the message above."; fi
echo
read -n 1 -s -r -p "Press any key to close..."
