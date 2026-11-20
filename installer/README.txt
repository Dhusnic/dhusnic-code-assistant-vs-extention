INFRAON CODE ASSISTANT 0.26.0 - INSTALL OR UPDATE (Windows)

First install
1. Right-click the zip -> Extract All (do not run from inside the zip).
2. Double-click  Install-InfraonAssistant.bat
3. Paste your API key when asked (typing is hidden), press Enter.
4. VS Code opens. Click the "Infraon Assistant" icon in the left activity bar.

Update (already installed)
1. Extract the new zip and double-click  Install-InfraonAssistant.bat  again.
2. Nothing is asked: the installer sees the installed version, updates it, and keeps your
   saved API key and settings.
3. If VS Code was open, press Ctrl+Shift+P -> "Developer: Reload Window" once.

Change your API key
- In VS Code: Ctrl+Shift+P -> "Infraon Assistant: Set API Key", or
- Open a Command Prompt in the extracted folder and run:  Install-InfraonAssistant.bat -ResetKey

What the installer does
- Installs Visual Studio Code if you do not have it (the only dependency).
- Installs or updates the Infraon Code Assistant extension.
- First install only: checks your key against the Infraon LLM gateway, then stores it in VS Code's
  encrypted storage.

New in 0.26.0: automatic updates
- This is the last update you install by hand. From now on, new versions are published on the Infraon
  gateway server and the assistant installs them by itself (checked at start-up and every 4 hours).
  When one is installed you are asked to reload the window; it never interrupts a running agent.
- Check right away: Ctrl+Shift+P -> "Infraon Assistant: Check for Updates".
- Every update is signed and verified before it is installed. Prefer to be asked first? Set
  infraonAssistant.autoUpdate to false.

Notes
- Do NOT double-click the .vsix file. Windows opens it in the Visual Studio installer, which fails.
  Always run Install-InfraonAssistant.bat instead.
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
- Windows SmartScreen may warn about the .bat: choose More info -> Run anyway.
