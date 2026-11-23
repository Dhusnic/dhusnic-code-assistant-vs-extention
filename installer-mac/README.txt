INFRAON CODE ASSISTANT 0.29.0 - INSTALL OR UPDATE (macOS)

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

New in 0.29.0: more reliable, smarter checks
- The status line shows what is happening: "Waiting for the model... no response for 45 s" while the
  gateway is silent, and "Writing index.html... 14.2 KB" while a file is being written.
- The sidebar Status checks that the model really answers ("Gateway up - model not responding").
- A gateway that stops answering is retried once, with a visible note, instead of minutes of "Thinking...".
- At Max effort the agent writes a task list before its first change (setting: infraonAssistant.planFirst).
- Sub-packages (for example a client/ next to a server/) are type-checked after changes, and test
  runners such as vitest no longer hang in watch mode.
- Fix rounds run only the related tests first; the full suite still runs before the agent finishes.
- Repo map uses language-server symbols for Java, C#, Go, Kotlin and PHP.
- Better inline completions (fill-in-the-middle, context from open tabs and imports).
- Search by meaning turns on by itself when the gateway serves an embedding model.
- Cmd+Shift+P -> "Infraon Assistant: Show Edit Statistics" shows local edit success/failure counts.

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
