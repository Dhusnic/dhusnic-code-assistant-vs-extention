---
name: init
description: Analyse the repository and create or improve its project memory file (INFRAON.md, or the existing CLAUDE.md / AGENTS.md) with build, test and lint commands, architecture, conventions and non-obvious gotchas. Use when the user asks to init, set up, generate or improve project memory or instructions for this repo.
argument-hint: "[focus area, optional]"
---

# Initialise project memory

Project memory is plain Markdown that is added to every request, so every line costs budget (about 30,000 characters across all memory files). Write only what a capable newcomer could not quickly infer from the code. Aim for under 100 lines.

## Steps

1. **Find existing memory.** Look in the repository root (and the current workspace folder) for `INFRAON.md`, `CLAUDE.md` and `AGENTS.md`, plus `.github/copilot-instructions.md` and Cursor rules if present.
   - If one of the three exists, you will improve that file. Never create a second one next to it.
   - If several exist, improve the one that is most complete and do not duplicate its content into the others.
   - If none exists, create `INFRAON.md` in the repository root.
   - Read what exists in full before planning anything.

2. **Analyse the repository.** Read, do not guess:
   - `README`, `CONTRIBUTING`, `docs/`, and any architecture notes.
   - Manifests and task runners: `package.json` scripts, `pyproject.toml`, `Makefile`, `go.mod`, `Cargo.toml`, `pom.xml`, Gradle files, CI workflows.
   - Top-level layout and the main entry points. Sample a few source files and tests to learn conventions.
   - Collect: exact commands to build, lint, run all tests, and run a single test; the module map in a few lines; rules the code enforces (layering, forbidden imports, naming, formatting); gotchas such as slow or dangerous commands, required env setup, generated files, or tests that must not be run casually.
   - Verify each command exists in the manifest or CI before you write it down. Do not run destructive, long-running or networked commands just to check.

3. **Draft.** Use short sections, for example `## Commands`, `## Architecture`, `## Conventions`, `## Gotchas`. Rules:
   - Only non-obvious facts. Skip anything the tooling or file names already make clear, and generic advice ("write clean code", "add tests").
   - One fact per line, imperative and specific.
   - Point to docs (`see docs/ARCHITECTURE.md`) instead of copying them.
   - **Never include secrets**: tokens, passwords, keys, internal URLs with credentials, `.env` values. Name the variable, never its value.
   - Keep any `## Verify` section intact if one exists. It tells the agent how to check changes after edits.

4. **Show and confirm.**
   - New file: show the full draft and the target path, then ask before writing.
   - Existing file: show a clear list of proposed additions and changes (what and why). Ask before editing. Do not overwrite the file wholesale.
   - Never delete or rewrite existing content without asking. If a line looks stale or wrong, flag it and let the user decide. Keep the user's wording and structure for lines you keep.

5. **Write after the go-ahead.** Apply only the approved changes with the normal edit tools. Keep the diff focused and do not reformat untouched lines.

6. **Report.** Say which file you created or changed, how many lines it has now, what you added, and what you left out or flagged. Mention that the user can review or edit it any time with `/memory`.

## Edge cases

- **Empty or tiny repository:** write only what exists (a commands section may be all there is). Say that it is sparse.
- **Monorepo:** put shared rules at the root and keep per-package notes to one line each, or suggest a memory file in the package folder.
- **Already thorough file:** make no changes, say so, and list at most a few optional improvements.
- **Over budget:** if the file would exceed about 30,000 characters, trim your own additions first, then suggest what the user could cut.
