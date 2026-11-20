INFRAON CODE ASSISTANT 0.26.0 - INSTALL OR UPDATE (macOS)

First install
1. Double-click the zip to extract it.
2. Right-click  Install-InfraonAssistant.command  ->  Open  ->  Open
   (the first time only, because macOS blocks downloaded scripts on a plain double-click).
3. Paste your API key when asked (typing is hidden), press Return.
4. VS Code opens. Click the "Infraon Assistant" icon in the left activity bar.

If step 2 does not work, open Terminal and run (type "bash " then drag install.sh into the window):
    bash install.sh

Update (already installed)
1. Extract the new zip and run  Install-InfraonAssistant.command  again (or: bash install.sh).
2. Nothing is asked: the installer sees the installed version, updates it, and keeps your
   saved API key and settings.
3. If VS Code was open, press Cmd+Shift+P -> "Developer: Reload Window" once.

Change your API key
- In VS Code: Cmd+Shift+P -> "Infraon Assistant: Set API Key", or
- In Terminal:  bash install.sh --reset-key

What the installer does
- Installs Visual Studio Code if you do not have it (the only dependency) - via Homebrew if present,
  otherwise the official download from code.visualstudio.com.
- Installs or updates the Infraon Code Assistant extension.
- First install only: checks your key against the Infraon LLM gateway, then stores it in VS Code's
  encrypted storage.

New in 0.26.0: automatic updates
- This is the last update you install by hand. From now on, new versions are published on the Infraon
  gateway server and the assistant installs them by itself (checked at start-up and every 4 hours).
  When one is installed you are asked to reload the window; it never interrupts a running agent.
- Check right away: Cmd+Shift+P -> "Infraon Assistant: Check for Updates".
- Every update is signed and verified before it is installed. Prefer to be asked first? Set
  infraonAssistant.autoUpdate to false.

Notes
- Do NOT double-click the .vsix file. Always run Install-InfraonAssistant.command (or install.sh).
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
