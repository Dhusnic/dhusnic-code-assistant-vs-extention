# Infraon Code Assistant: notes for AI coding agents

A VS Code extension (TypeScript, Node 20). It's an agentic coding assistant backed by a company-hosted OpenAI-compatible LLM gateway.

## Commands

- Build: `npm run compile` (tsc into `out/`, plus the esbuild bundle into `dist/extension.js`)
- Lint: `npm run lint`
- Unit tests: `npm run test:unit`. A single file: `npx tsc -p . && node --test out/test/<name>.test.js`
- Don't run `npm run test:e2e` or `npm run eval` unless asked. They open VS Code windows or call the real gateway.

## Rules

- `src/core/**` must never import `vscode`. Editor access goes through the interfaces in `core/agent.ts` and `core/tool.ts`, implemented in `src/host/**`.
- Every source file opens with a comment that explains its design. Read it before you change the file, and keep it accurate.
- Tests use `node:test` with the fakes in `src/test/helpers.ts`. They must not touch the network.
- Webview code in `media/*.js` is plain browser JavaScript under a strict CSP (nonce scripts only). No inline handlers, no external URLs.
- Never add telemetry or outbound network calls. LLM traffic goes only to `infraonAssistant.baseUrl`, and web traffic only through `src/core/web/net.ts`.
- Secrets live in VS Code SecretStorage, never in settings, logs or session files.
- Don't bulk-reformat files. Keep diffs focused.

See `docs/ARCHITECTURE.md` for the module map and the request flow.
