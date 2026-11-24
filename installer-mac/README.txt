INFRAON CODE ASSISTANT 0.31.3 - INSTALL OR UPDATE (macOS)

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

New in 0.31.3: use a skill anywhere in your message
- Type / anywhere in the message box (at the start or after a space) to pick a skill from the list.
- A skill named in the middle of a sentence now runs too, for example:
    please /code-review the login changes and then /simplify them
  The rest of your message is what the skill works on.

New in 0.31.2: find your messages faster, and no more endless repeats
- Press the Up arrow in the message box to bring back a message you sent before (Down goes forward
  again). Nothing is sent until you press Return, so you can change it first.
- The clock button at the top of a session lists every message you sent, with its time. Click one
  (or type to filter) and the chat scrolls straight to it.
- Successful file edits show a pen icon instead of a tick, so changes stand out from reads.
- When the model keeps repeating the same tool call after two reminders, the call is no longer run,
  and the agent stops and tells you, instead of looping until it runs out of steps.

New in 0.31.1: clearer chat and a working Compact button
- Your message now stays pinned at the top of the chat while you scroll through that turn's work.
- The agent's replies, tool calls and approvals hang off a timeline with a status dot for each step
  (running, done, failed, waiting for you).
- Compact (the context ring, or /compact) now also works while the agent is busy: it runs before the
  agent's next step instead of showing an error.

New in 0.31.0: developer-workflow skills
- /code-review reviews your changes for bugs, /simplify cleans them up, /security-review checks them for
  security problems. /init writes the project notes file, /run starts the app and checks a change works.
- /pr-creation raises an Azure DevOps pull request (needs the az command line). /dataviz helps with
  charts. /update-config changes Infraon Assistant settings safely.
- All run locally through the Infraon gateway only. Turn one off with infraonAssistant.disabledBuiltinSkills.

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
