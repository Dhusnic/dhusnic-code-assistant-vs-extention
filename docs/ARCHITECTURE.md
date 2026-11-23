# Architecture

This page explains how Infraon Code Assistant is put together, so that you know where a change belongs. Each source file starts with a comment that explains its own design decisions; read that comment before you change the file.

## Layers

```
src/
  core/   Agent logic. No `vscode` import: everything here runs (and is unit tested) in plain Node.
  host/   The VS Code side: activation, commands, webviews, editor integration. Adapts core to the editor.
  test/   Unit and integration tests (node:test), run from out/test.
  e2e/    UI tests that drive a real VS Code window against a fake LLM gateway.
  eval/   Task-based evaluation of the agent against the real gateway.
media/    Webview front-end (plain JavaScript and CSS) for the session tab and the sidebar.
scripts/  Build and release helpers (bundle, installers, update signing) and the OCR script.
server/   Configuration for the update server (nginx).
```

The rule that keeps this testable is that **`src/core` never imports `vscode`**. Anything the core needs from the editor is passed in as an interface, for example `AgentUi`, `AgentGuard` and `AgentDeps` in [agent.ts](../src/core/agent.ts), or `ToolCtx` in [tool.ts](../src/core/tool.ts). `src/host` implements those interfaces.

## Request flow

```
User types in the session tab (media/session.js)
  → postMessage → SessionPanel (host/sessionPanel.ts)
  → Runtime (core/runtime.ts): finds the session and its main agent, queues input while it is busy
  → Agent.send (core/agent.ts): the tool loop
       build system prompt (prompts.ts + memory files + skills + verify commands)
       → llm.streamChat (llm.ts, OpenAI-compatible /chat/completions, streaming, retries)
       → tool calls: scheduler.ts groups independent calls to run in parallel
       → each call: permission check (permissions.ts, hooks.ts, guard) → approval if needed → tool.run
       → results are added to the history; compaction.ts summarizes when the context is nearly full
       → after edits: verify.ts runs the project's checks; failures go back to the model
  → UI events (tokens, tool cards, approvals, todos) → Runtime transcript → webview
```

### Key modules

| Area | Files |
|---|---|
| Agent loop, sub-agents, plan mode | `core/agent.ts` (the loop), `core/agentContracts.ts` (UI, guard and dependency interfaces), `core/agentTools.ts` (built-in tool specs, system prompt), `core/checks.ts` (project checks), `core/agentTypes.ts`, `core/runtime.ts`, `core/notify.ts` |
| LLM client | `core/llm.ts` (streaming, retry, idle timeout), `core/textToolCalls.ts` (tool calls written as text), `core/modelInfo.ts`, `core/modelRouting.ts`, `core/usage.ts` |
| Tools | `core/tool.ts` (contracts), `core/fstools.ts` (files, search, commands), `core/search.ts` (ripgrep and a built-in fallback), `core/codeSearch.ts` (`search_code`: local BM25 ranking of code regions), `host/vscodeTools.ts` and `host/navTools.ts` (diagnostics, symbols, references), `core/editDiagnostics.ts` and `host/editDiagnostics.ts` (new errors appended to edit results) |
| Safety | `core/permissions.ts`, `core/hooks.ts`, `core/redact.ts` (secret masking), `core/audit.ts`, `core/policy.ts`, `core/centralPolicy.ts`, `host/features/guard.ts` |
| History and undo | `core/store.ts`, `core/sessions.ts`, `core/checkpoints.ts`, `core/changeJournal.ts`, `core/changes.ts` |
| Context | `core/memoryFiles.ts`, `core/mentions.ts`, `core/skills.ts`, `core/teamSkills.ts`, `core/compaction.ts`, `core/handoff.ts` |
| Remote servers | `core/ssh.ts`, `core/remoteTools.ts`, `host/features/remote.ts`, `host/features/servers.ts` |
| Web access | `core/web/` (see `core/web/types.ts` for the layout) |
| Editor features | `host/completions.ts`, `core/inlineEdit.ts`, `host/features/editorActions.ts` (light-bulb actions: fix, edit, document, generate tests), `host/features/scm.ts` (commit message button in Source Control), `host/diffProvider.ts` |
| Updates | `core/updater.ts`, `core/updateKey.ts`, `host/updater.ts`, `scripts/sign-update.js` |

## Activation and loading

[extension.ts](../src/host/extension.ts) imports only `vscode` statically. The hub, the agents and the webviews are loaded the first time the user needs them, through `import()`. esbuild bundles everything into `dist/extension.js`, so these imports become in-file lazy evaluations: module bodies still run only on first use, and VS Code reads one file instead of more than 100.

[hub.ts](../src/host/hub.ts) is the per-window composition root. It owns the configuration, the runtime, the services (web, remote, guard, scheduler) and the session panels.

## Webviews

`core/html.ts` produces the HTML, with a Content Security Policy that allows scripts only through a nonce. The front-end lives in `media/`. `session.js` renders the conversation, `md.js` renders Markdown, and Mermaid is loaded only when a diagram appears. The host and the webview exchange JSON messages over `postMessage`. The `type` field selects the handler: `SessionPanel.onMessage` on the host side, and a dispatcher in `session.js` on the webview side.

## Storage

- Sessions are stored once per machine in VS Code global storage (see `store.ts` for the layout) and scoped to the workspace that created them (`workspaceScope.ts`).
- Secrets (API keys, server passwords, private keys) are kept in VS Code `SecretStorage`, never in settings or session files.
- The audit log is stored as JSONL per session and rotated by size.

## Build outputs

| Output | Produced by | Used by |
|---|---|---|
| `out/` | `tsc -p .` | the tests, e2e and eval runs |
| `dist/extension.js` | `scripts/bundle.mjs` (esbuild) | the extension (`main` in package.json) and the `.vsix` |

`ssh2` is bundled too. Its optional native add-ons are left out, and it falls back to pure JavaScript, so the package ships no `node_modules`.
