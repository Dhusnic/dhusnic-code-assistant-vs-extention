INFRAON CODE ASSISTANT - INSTALL (Windows)

1. Right-click the zip -> Extract All (do not run from inside the zip).
2. Double-click  Install-InfraonAssistant.bat
3. Paste your API key when asked (typing is hidden), press Enter.
4. VS Code opens. Click the "Infraon Assistant" icon in the left activity bar.

What the installer does
- Installs Visual Studio Code if you do not have it (the only dependency).
- Installs the Infraon Code Assistant extension.
- Checks your key against the Infraon LLM gateway, then stores it in VS Code's encrypted storage.

Notes
- Do NOT double-click the .vsix file. Windows opens it in the Visual Studio installer, which fails.
  Always run Install-InfraonAssistant.bat instead.
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
- If VS Code was already open, press Ctrl+Shift+P -> "Developer: Reload Window" once.
- Wrong key later?  Ctrl+Shift+P -> "Infraon Assistant: Set API Key".
- Windows SmartScreen may warn about the .bat: choose More info -> Run anyway.
- Re-run the installer any time to update.
