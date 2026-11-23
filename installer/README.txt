INFRAON CODE ASSISTANT 0.30.0 - INSTALL OR UPDATE (Windows)

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

New in 0.30.0: built-in skills for Office and PDF files
- Ask for a Word document, Excel workbook, PowerPoint deck or PDF and the agent creates, reads or
  edits it, then renders the pages and checks the layout itself (skills: docx, xlsx, pptx, pdf).
- skill-creator helps you write and test your own skills; import-memory brings your preferences over
  from ChatGPT or another assistant.
- These skills use Python, LibreOffice and Node on your machine. Ctrl+Shift+P -> "Infraon Assistant:
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
- Check right away: Ctrl+Shift+P -> "Infraon Assistant: Check for Updates".
- Every update is signed and verified before it is installed. Prefer to be asked first? Set
  infraonAssistant.autoUpdate to false.

Notes
- Do NOT double-click the .vsix file. Windows opens it in the Visual Studio installer, which fails.
  Always run Install-InfraonAssistant.bat instead.
- Be on the office network / VPN so the gateway (172.16.48.75) is reachable.
- Windows SmartScreen may warn about the .bat: choose More info -> Run anyway.
