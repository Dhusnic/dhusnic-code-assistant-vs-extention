---
name: run
description: Launch and drive this project's app to see a change working in the real thing, not just in tests. Use when asked to run, start, try or screenshot the app, or to confirm that a change works end to end. First looks for project docs or skills that cover launching; otherwise falls back by project type (CLI, server, TUI, Electron or VS Code extension, browser app, library).
argument-hint: "[what to verify]"
---

# Run the app and verify a change

Tests passing is not the same as the feature working. Start the real thing, use the changed behaviour, and report what you saw.

## Safety rules

- Never run commands that hit production or external services (real databases, deployed APIs, payment, email, cloud accounts). Use local, mock, sandbox or test configuration only. If the only way to run is against a real service, stop and ask.
- Never add telemetry, analytics or new outbound network calls to make verification easier.
- Do not print or store secrets in evidence. Redact tokens and keys from logs you quote.
- Do not run suites that open windows or call real gateways unless the user asked or the project docs say it is safe.
- Stop everything you started, even when something fails.

## Steps

1. **Look for existing instructions.** Check, in order: a project skill or command for running the app, `INFRAON.md` / `CLAUDE.md` / `AGENTS.md`, `README`, `CONTRIBUTING`, `docs/`, then the manifest scripts (`start`, `dev`, `serve`, `run`) and CI. If the project documents how to launch and drive the app, follow that and skip step 2.

2. **Otherwise pick a fallback by project type.**
   - **CLI:** build if needed, run the changed command with realistic arguments and input, check stdout, stderr and the exit code. Also try one bad input.
   - **Server or API:** start it in the background on a free local port with test config, wait until it answers a health check or logs readiness, then call the changed endpoint with `curl` or similar against localhost only.
   - **TUI:** run it inside a pseudo-terminal or `tmux` session if available, send keystrokes, and capture the screen text. If you cannot drive it, say so.
   - **Electron or VS Code extension:** build, then launch with an isolated user-data directory and a throwaway workspace (for a VS Code extension, an Extension Development Host or the project's test harness). Do not use the user's real profile. Drive it through the project's own harness (CDP, test commands) where one exists; check logs and the output channel.
   - **Browser app:** start the dev server in the background, open it with a headless browser (Playwright or Puppeteer if the project has them), exercise the changed flow, and capture a screenshot or DOM text plus console errors.
   - **Library:** write a tiny throwaway script outside the source tree (scratchpad or temp folder) that imports the built package, call the changed API, and print the result.

3. **Build first.** Use the project's build command so you run the current code, not stale output. Note any build errors and stop if it fails.

4. **Run long-lived processes in the background.** Redirect output to a log file, record the process id, and never block the session on them. Wait for readiness by polling a port, health endpoint or log line with a timeout. Do not use fixed sleeps as the only wait. If readiness does not come, read the log, report the failure, and clean up.

5. **Exercise the changed behaviour.** Do exactly what a user would do to hit the new or fixed path, then one nearby case that should be unaffected, and one failure or edge case. Compare against what the change is supposed to do.

6. **Capture evidence.** Keep the commands you ran, the relevant output, exit codes, log excerpts, and screenshots where applicable. Quote short excerpts, not whole logs.

7. **Stop what you started.** Kill background processes by the recorded id, close browsers and windows you opened, remove temp data directories and throwaway files. Confirm nothing is left listening on the port.

8. **Report plainly.** Use three parts:
   - **Verified:** what you ran and observed, with the evidence.
   - **Not verified:** what you could not or did not exercise, and why (needs a real service, could not drive the UI, no test data).
   - **Problems:** anything that failed or looked wrong, with the log excerpt.

   Do not claim success for anything you did not observe. If the app did not start, say that first.
