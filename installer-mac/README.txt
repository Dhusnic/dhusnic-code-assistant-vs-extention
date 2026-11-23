INFRAON CODE ASSISTANT 0.30.0 - INSTALL OR UPDATE (macOS)

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

New in 0.30.0: built-in skills for Office and PDF files
- Ask for a Word document, Excel workbook, PowerPoint deck or PDF and the agent creates, reads or
  edits it, then renders the pages and checks the layout itself (skills: docx, xlsx, pptx, pdf).
- skill-creator helps you write and test your own skills; import-memory brings your preferences over
  from ChatGPT or another assistant.
- These skills use Python, LibreOffice and Node on your machine. Cmd+Shift+P -> "Infraon Assistant:
  Check Skill Requirements" lists what is missing and how to install it; the agent tells you too.
- Everything runs locally and through the Infraon gateway only.
- Turn a skill off with the setting infraonAssistant.disabledBuiltinSkills, or copy it to your own
  skills (Skills manager) to change it.

New in 0.29.0: more reliable - live status line, model health check, task list at Max effort,
sub-package type checks, faster fix rounds, better inline completions.

New in 0.28.0: fewer mistakes - errors after each edit are fixed at once, loop detection, self-review
at High/Max effort, a project map, clearer test failures.

New in 0.27.0: testing toolkit (/qa), browser and API testing, Generate Tests, Add Documentation,
a commit-message button in Source Control, and search_code.

Automatic updates (since 0.26.0)
- New versions are published on the Infraon gateway server and the assistant installs them by itself
  (checked at start-up and every 4 hours).
  When one is installed you are asked to reload the window; it never interrupts a running agent.
- Check right away: Cmd+Shift+P -> "Infraon Assistant: Check for Updates".
- Every update is signed and verified before it is installed. Prefer to be asked first? Set
  infraonAssistant.autoUpdate to false.

Notes
- Do NOT double-click the .vsix file. Always run Install-InfraonAssistant.command (or install.sh).
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
