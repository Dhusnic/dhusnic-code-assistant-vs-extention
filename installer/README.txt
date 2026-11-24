INFRAON CODE ASSISTANT 0.31.5 - INSTALL OR UPDATE (Windows)

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

New in 0.31.5: long conversations stay on track
- Compaction now counts the whole request (instructions and tools too), so it starts in time on
  models with a small context window instead of failing with "context length exceeded".
- One long request with many steps is compacted too: its earlier steps are summarized, while your
  request and the latest steps are kept word for word.
- Each new summary builds on the previous one in full, so goals and rules you gave early in a long
  chat are not lost after several compactions. A summary that was cut off is never used.

New in 0.31.4: skills are used automatically when they clearly fit
- You do not have to name a skill. When your request clearly is the kind of work a skill covers
  (for example "write the release notes as a Word document"), the agent loads that skill by itself
  and follows it. You see a "Using skill: ..." step in the chat when that happens.
- It only does this for a clear match, not for requests that are merely related.

New in 0.31.3: use a skill anywhere in your message
- Type / anywhere in the message box (at the start or after a space) to pick a skill from the list.
- A skill named in the middle of a sentence now runs too, for example:
    please /code-review the login changes and then /simplify them
  The rest of your message is what the skill works on.

New in 0.31.2: find your messages faster, and no more endless repeats
- Press the Up arrow in the message box to bring back a message you sent before (Down goes forward
  again). Nothing is sent until you press Enter, so you can change it first.
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
