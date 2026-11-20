INFRAON CODE ASSISTANT - INSTALL (macOS)

1. Double-click the zip to extract it.
2. Right-click  Install-InfraonAssistant.command  ->  Open  ->  Open
   (the first time only, because macOS blocks downloaded scripts on a plain double-click).
3. Paste your API key when asked (typing is hidden), press Return.
4. VS Code opens. Click the "Infraon Assistant" icon in the left activity bar.

If step 2 does not work, open Terminal and run (type "bash " then drag install.sh into the window):
    bash install.sh

What the installer does
- Installs Visual Studio Code if you do not have it (the only dependency) - via Homebrew if present,
  otherwise the official download from code.visualstudio.com.
- Installs the Infraon Code Assistant extension.
- Checks your key against the Infraon LLM gateway, then stores it in VS Code's encrypted storage.

Notes
- Do NOT double-click the .vsix file. Always run Install-InfraonAssistant.command (or install.sh).
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
- If VS Code was already open, press Cmd+Shift+P -> "Developer: Reload Window" once.
- Wrong key later?  Cmd+Shift+P -> "Infraon Assistant: Set API Key".
- Re-run the installer any time to update.
