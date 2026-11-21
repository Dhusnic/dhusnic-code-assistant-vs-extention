# Contributing

## Setup

```
npm ci
npm run compile
```

Open the folder in VS Code and press **F5** (*Run Extension*). The launch configuration compiles first and loads `dist/extension.js` in an Extension Development Host. For fast iteration, run `npm run watch` (type check) and `npm run watch:bundle` (rebuilds the bundle), then reload the host window after each change.

## Branches and pull requests

- Branch from `main` (`feature/<topic>`, `fix/<topic>`). Don't commit to `main` directly.
- Before opening a PR, run `npm run lint` and `npm test`. CI (`.github/workflows/ci.yml`) runs lint, the type check, the unit tests on Windows and Linux, and packaging.
- Keep `src/core` free of `vscode` imports. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Every source file starts with a comment that explains its design. Update that comment when you change the design.

## Scripts

| Command | What it does |
|---|---|
| `npm run compile` | `tsc` (type check and test build into `out/`) plus the development bundle |
| `npm run bundle` | Production bundle (minified) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format -- <files>` | Prettier on the files you touched (the codebase isn't bulk-formatted, to keep diffs reviewable) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests, then `out/test/slow/*` serially |
| `npm run test:unit` | Unit tests only |
| `npm run test:coverage` | Unit tests with a coverage report for `core/` and `host/` |
| `npm run test:e2e` | UI tests in a real VS Code window (see below) |
| `npm run eval` | Agent evaluation tasks against the real gateway (see below) |

## Tests

- **Unit and integration tests** live in `src/test/*.test.ts` and use `node:test` and `node:assert/strict`. Shared fakes (`fakeLlm`, `recordingUi`, `tmpDir`) are in `src/test/helpers.ts`. Tests must not need the network or the gateway. Use the fakes, the fake MCP server (`fixtures/fake-mcp.js`) or the in-process SSH server (`fixtures/sshServer.ts`).
- **Slow tests** (`src/test/slow/`) run one at a time because they measure performance or run long evaluations.
- **End-to-end tests** (`src/e2e/`) launch the VS Code installed on your machine with an isolated profile, against `fakeGateway.ts`. They need a desktop session, so CI doesn't run them; run them before a release. Use `INFRAON_E2E_GREP=<regex>` to run some flows only, and `INFRAON_E2E_KEEP=1` to keep the temporary profile. See `src/e2e/run.ts`.
- **Evals** (`eval/tasks/*`) give the agent real tasks (fix a bug, add a feature, refactor) in a scratch project and check the result. They need the gateway, so run them inside the network when you change prompts, the tool loop or the default model.

## Releasing

1. Bump nothing by hand. `deploy.ps1 -Version x.y.z` sets the version, runs the type check, packages the extension (`vscode:prepublish` builds the production bundle) and installs it locally.
2. With `-Publish`, it also signs the package and uploads it to the update server. Installed copies then update themselves. See [server/updates/README.md](server/updates/README.md).
3. `node scripts/build-installers.js` builds the first-install zips from the committed tree. Upload them to the gateway's `downloads/` folder. They aren't stored in git.

The update-signing private key lives only on the build machine (`%USERPROFILE%\.infraon-signing\`). Never commit it.

## Security and data handling

This tool is built to keep company code inside the network:

- LLM calls go only to the configured company gateway (`infraonAssistant.baseUrl`).
- Web access (`infraonAssistant.web.enabled`, on by default, and central policy can turn it off) sends every request through `core/web/net.ts` (domain policy, secret and query filters, SSRF checks, quotas). Never add a network call that bypasses it.
- Don't add telemetry, crash reporting or any dependency that phones home.
- Don't log prompts, code or secrets outside the local audit log.
