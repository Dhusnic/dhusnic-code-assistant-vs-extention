INFRAON CODE ASSISTANT 0.24.0 - INSTALL OR UPDATE (macOS)

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

New in 0.24.0: internet access for research
- The assistant can search the web, read pages, PDFs, Word/Excel/PowerPoint files and images, and
  look up papers, packages, vulnerabilities, GitHub repos and RFCs, with numbered citations.
- Try:  /research <topic>   /sources   /web
- The first request to a new website asks for your approval.
- Optional: /web key to add a search API key (Brave, Tavily, Bing or Google) for better search results.

Notes
- Do NOT double-click the .vsix file. Always run Install-InfraonAssistant.command (or install.sh).
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
