---
name: update-config
description: Change Infraon Assistant settings safely (infraonAssistant.* in VS Code user or workspace settings.json), such as model, approvals, web access, verification commands and disabling built-in skills. Use when the user asks to configure, turn on or off, allow, block or change an Infraon Assistant setting.
argument-hint: "[setting and desired value]"
---

# Update Infraon Assistant configuration

Infraon Assistant is configured through VS Code settings named `infraonAssistant.*`. Change only what the user asked for, with the smallest possible edit.

## Where settings live

- **User settings** apply to every project. Windows: `%APPDATA%\Code\User\settings.json`; macOS: `~/Library/Application Support/Code/User/settings.json`; Linux: `~/.config/Code/User/settings.json`. (VS Code Insiders, VSCodium and remote windows use their own folder.)
- **Workspace settings** apply to one project: `.vscode/settings.json` in the workspace root. They override user settings and are usually committed, so the team shares them.
- Default to **workspace** for project-specific things (`verifyCommands`, `testing.databases`, `web.allowedDomains` for this project). Default to **user** for personal preferences (`model`, `notifications.*`, `visibleTerminal`). If it is unclear, ask which one.
- A central policy (a policy file installed on the machine, or `policyUrl`) takes priority. If a setting does not take effect, tell the user it may be managed by their organization.

`settings.json` is **JSONC**: it may contain `//` comments and trailing commas. Do not parse and rewrite the whole file with `JSON.parse` or `JSON.stringify`; that deletes comments and reformats everything.

## Steps

1. **Read the current file.** Read the relevant `settings.json`. Create `.vscode/settings.json` containing `{}` only if it does not exist and the user wants a workspace setting. Note whether the key is already set.
2. **Verify the key exists.** Look it up in this extension's `package.json` under `contributes.configuration` (search for the exact `infraonAssistant.<name>`), or in the tables below. If it is not there, do not invent it: tell the user and suggest the closest real setting. Check its `type`, `enum` and `default` before choosing a value.
3. **Explain the change** in one or two sentences: the setting, the old value (or default), the new value, which file, and what will behave differently. Ask for confirmation if the change loosens safety (see below) or the request is ambiguous.
4. **Edit minimally** with the edit tool. Change or add only that key, and keep the file's indentation, key order, comments and trailing-comma style. Add new keys at the end of the top-level object with correct commas. Dotted names stay flat, as in `"infraonAssistant.web.enabled": false`; do not nest them under `"infraonAssistant": { ... }`.
5. **Re-read the file** and check that it is still valid (balanced braces, commas, quotes, correct value type). Tell the user which file you changed, and whether a window reload (`Developer: Reload Window`) is needed, for example after changing `mcpServers`.

## Hard rules

- **Never put secrets in settings.** API keys, tokens and passwords belong in VS Code SecretStorage, which the extension's commands manage (for example **Infraon Assistant: Set Web Search API Key or GitHub Token**). If the user pastes a secret, do not write it to any file; point them to the command. A proxy URL with embedded credentials (`web.proxy`) is a secret too, so prefer a proxy without credentials. Do not put passwords in `testing.databases`.
- **Never change `infraonAssistant.baseUrl` to a host outside the company** without explicit confirmation that names the host. LLM traffic, including code and prompts, goes to this URL, so an external host sends company code outside the enterprise. Ask the user to confirm the exact URL and that it is approved, and mention it if the scheme is `http:` instead of `https:`. Apply the same care to `updateUrl`, `policyUrl`, `web.search.searxngUrl` and `web.proxy`.
- **Settings that loosen safety need explicit confirmation**, restated back to the user: `autoApprove: true`, `redactSecrets: false`, `auditLog: false`, `confirmDangerousRemoteCommands: false`, `web.allowSelfSignedTls: true`, `testing.ignoreHttpsErrors: true`, broad wildcards in `web.allowedDomains`, and anything in `web.allowPrivateHosts`. Offer a narrower alternative first (for example `web.extraCaFile` instead of accepting any certificate).
- Do not change settings the user did not mention, and do not tidy or reformat the file.
- Do not switch a whole feature off to fix one problem; find the specific setting.

## Commonly used settings

Names, types and defaults come from this extension's `package.json`; confirm there before writing.

**Model and gateway**

| Setting | Type | What it does |
|---|---|---|
| `infraonAssistant.baseUrl` | string | OpenAI-compatible URL of the company LLM gateway. Sensitive, see the rules. |
| `infraonAssistant.model` | string | Model served by the gateway (default `qwen3-coder-next`). |
| `infraonAssistant.allowSelfSignedTls` | boolean | Accept the internal gateway's self-signed certificate (default true). |
| `infraonAssistant.maxOutputTokens` | number | Max tokens per reply; 0 uses the effort level's value. |
| `infraonAssistant.temperature` | number | Sampling temperature; only used when set explicitly. |
| `infraonAssistant.contextWindow` | number | Context window in tokens; normally detected from the gateway. |
| `infraonAssistant.autoCompactThreshold` | number | Fraction of the window (default 0.75) at which old conversation is trimmed or summarized. |
| `infraonAssistant.maxIterations` | number | Max tool-call rounds per request. |
| `infraonAssistant.llmIdleTimeoutSeconds` | number | Ends a request when the gateway is silent this long (default 180). |
| `infraonAssistant.modelRouting` | object | Use particular models for smaller jobs. |

**Behaviour and approvals**

| Setting | Type | What it does |
|---|---|---|
| `infraonAssistant.autoApprove` | boolean | Skip approval prompts for edits and commands (default false, not recommended). |
| `infraonAssistant.planFirst` | string: `off`, `max`, `always` | Write a plan before the first edit. |
| `infraonAssistant.selfReview` | string: `off`, `high`, `always` | Have the model review its own diff before finishing. |
| `infraonAssistant.autoVerify` | boolean | Run project checks after changes (default true). |
| `infraonAssistant.verifyCommands` | array of strings | Checks to run in order, e.g. `["npm run lint", "npm test"]`. |
| `infraonAssistant.checks.relatedTestsFirst` | boolean | Re-check a fix with only the related tests first. |
| `infraonAssistant.diagnosticsAfterEdit` | boolean | Add new language-server errors after an edit. |
| `infraonAssistant.visibleTerminal` | boolean | Run commands in a VS Code terminal you can watch. |
| `infraonAssistant.agentWorktrees` | boolean | Run each editing sub-agent in its own git worktree. |
| `infraonAssistant.maxConcurrentAgents` | number | Agents allowed to talk to the LLM at once (default 4). |
| `infraonAssistant.confirmDangerousRemoteCommands` | boolean | Ask before destructive remote commands (default true). |

**Search, tools and extensions**

| Setting | Type | What it does |
|---|---|---|
| `infraonAssistant.searchEngine` | string: `auto`, `ripgrep`, `builtin` | Engine for code search. |
| `infraonAssistant.ripgrepPath` | string | Path to a ripgrep binary. |
| `infraonAssistant.repoMap.enabled`, `.maxTokens` | boolean, number | Compact workspace overview in the prompt. |
| `infraonAssistant.mcpServers` | object | MCP servers started over stdio (`command`, `args`). Each entry runs a program on this machine, so confirm the command with the user. |
| `infraonAssistant.teamSkills` | array | Shared skill folders or git URLs. |
| `infraonAssistant.disabledBuiltinSkills` | array of strings | Built-in skills to leave out. See below. |
| `infraonAssistant.inlineCompletions.enabled` | boolean | Ghost-text suggestions (also `.mode`: `auto`, `fim`, `chat`; `.model`; `.debounceMs`; `.maxTokens`). |
| `infraonAssistant.notifications.enabled` | boolean | Master switch for notifications (also `.taskDone`, `.needsInput`, `.errors`, `.backgroundAgents`, `.minDurationSeconds`). |

**Web access and privacy**

| Setting | Type | What it does |
|---|---|---|
| `infraonAssistant.web.enabled` | boolean | Let agents search and read the web. |
| `infraonAssistant.web.offline` | boolean | Send nothing to the internet; use cache and the offline library only. |
| `infraonAssistant.web.approval` | string: `new-domains`, `always`, `never` | When to ask before contacting a site. |
| `infraonAssistant.web.allowedDomains` | array | Sites fetched without asking (`example.com` or `*.example.com`). |
| `infraonAssistant.web.askDomains` | array | Sites that always need approval. |
| `infraonAssistant.web.blockedDomains` | array | Sites never contacted. |
| `infraonAssistant.web.allowPrivateHosts` | array | Intranet hosts that may be read. |
| `infraonAssistant.web.blockedQueryPatterns` | array | Regexes; a matching URL or query is never sent (project code names and the like). |
| `infraonAssistant.web.search.provider` | string: `auto`, `searxng`, `brave`, `tavily`, `bing`, `google`, `duckduckgo` | Search provider; API keys go in SecretStorage. |
| `infraonAssistant.web.proxy`, `.noProxy`, `.extraCaFile` | string, array, string | Proxy and extra CA for corporate networks. |
| `infraonAssistant.redactSecrets` | boolean | Mask keys and tokens before text goes to the LLM (default true). |
| `infraonAssistant.auditLog` | boolean | Local log of commands, edits and approvals (default true). |

**Testing:** `infraonAssistant.testing.enabled`, `.browserPath`, `.headless`, `.timeoutSeconds`, `.reportsFolder`, `.databases` (read-only database connections).

## Permissions and allow lists

There is no per-tool or per-command allow list in settings. What exists is `autoApprove` (all or nothing; keep it off unless asked), the web lists above (`web.allowedDomains`, `askDomains`, `blockedDomains`, `allowPrivateHosts`, `blockedQueryPatterns`), and an organization policy that takes priority over settings. If the user wants a specific command to run without asking, say there is no such setting instead of writing an invented key. For domains, add the narrowest host (`docs.example.com`, not `*`). Setting `web.allowedDomains` replaces the built-in default list, so tell the user that before writing it.

## Disabling built-in skills

`infraonAssistant.disabledBuiltinSkills` is an array of skill names, or `["*"]` for all. Read the setting's description in `package.json` for the current list of built-in skill names, and check that each requested name is on it; a misspelled name does nothing. Add the requested name to the existing array without removing entries already there:

```jsonc
"infraonAssistant.disabledBuiltinSkills": ["pptx", "pdf"]
```

To see what each skill needs on the machine, the user can run **Infraon Assistant: Check Skill Requirements**.

## Finish

Report in a few lines: the file changed, the key, old value to new value, whether a reload is needed, and anything you declined to do and why.
