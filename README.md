# Infraon Code Assistant

An agentic AI coding assistant for VS Code that runs on the company-hosted LLM gateway: prompts and code go only to that gateway. Optional web research goes through a guarded network layer that administrators can restrict or turn off.

Internal use only.

## What it does

- **Sessions with agents.** Each editor tab is a session. The agent reads, searches and edits files, runs commands, and verifies its work by running the project's checks. It can launch sub-agents for parallel work and asks before risky actions.
- **Modes.** Ask before edits, auto-accept edits, auto-execute, or plan-only (read and search, then propose a plan).
- **In the editor.** Inline completions, *Edit Selection* (inline diff you accept or reject), *Explain Selection*, *Fix Selection*, *Add Documentation*, *Generate Tests*, and *Fix Problem* from the light bulb.
- **Source Control.** The ✨ button in the commit box writes a commit message for your staged changes.
- **Code search by meaning.** Besides exact search (ripgrep), the agent can find code by describing what it does ("expired session cleanup"), ranked locally with no index service.
- **Safety.** Permission rules and hooks, secret masking before anything reaches the model, an audit log, per-turn checkpoints with rewind, and central policy for administrators.
- **Extensibility.** MCP servers, skills and custom agents (compatible with the Claude Code file formats), project memory in `CLAUDE.md`, `INFRAON.md` or `AGENTS.md`, and a shared team skill library.
- **Built-in skills.** Word (`docx`), Excel (`xlsx`), PowerPoint (`pptx`) and PDF (`pdf`) files, writing and testing new skills (`skill-creator`), and importing memories from another assistant (`import-memory`). They run locally with Python, LibreOffice and Node: **Infraon Assistant: Check Skill Requirements** shows what is missing and how to install it. Turn one off with the setting `disabledBuiltinSkills`, or copy it to your own skills to change it.
- **Linux servers.** Saved SSH servers with verified host keys. The agent can run commands, transfer files and follow long-running jobs.
- **Web research (optional).** Search, fetch and cite pages through a guarded network layer (domain approval, SSRF protection, quotas, offline library).
- **Scheduled tasks** and **automatic updates** from the company update server.

## Install

Use the installer from the link in the Teams announcement, or install a `.vsix` directly:

```
code --install-extension infraon-code-assistant-<version>.vsix
```

Then run **Infraon Assistant: Set API Key** and open the Infraon Assistant view in the activity bar. Every option is under *Settings → Extensions → Infraon Assistant*.

## Development

Requires Node.js 24 (the test scripts use `node --test` file globs, which Node 20 does not support) and VS Code 1.90+.

```
npm ci
npm run compile      # type check (out/) + bundle (dist/extension.js)
npm run lint
npm test             # unit tests, then the slow tests serially
```

Press **F5** to launch an Extension Development Host.

- `CONTRIBUTING.md` covers the workflow, tests, end-to-end and eval runs, and releases.
- `docs/ARCHITECTURE.md` explains how the code is organized.
- `server/updates/README.md` covers the update server and publishing.
