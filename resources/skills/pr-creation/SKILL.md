---
name: pr-creation
description: Raise an Azure DevOps pull request for the current git branch with one command - pushes the branch, opens the PR against main, fills title/description from the commits, and links work item 46936 (changeable). Use when the user asks to create, raise, open or submit a PR / pull request for the Infraon APM repo on dev.azure.com.
argument-hint: "[work-item-id] [target-branch]"
requires: cmd:git, cmd:az
---

# Create an Azure DevOps pull request

Defaults: work item **46936** and target branch **main**. Both can be changed by the user: `/pr-creation 51234 release/1.2` means work item 51234 into `release/1.2`. If only a number is given, it is the work item; if only a name, it is the target branch. Always tell the user which work item and target you are using and that they can change them.

## Rules

- **PR creation is outward-facing. Confirm title, description, source, target and work item with the user before running `az repos pr create`.**
- Never force-push (`--force`, `--force-with-lease`, `+branch`). Never push to `main` (or the target branch) directly. If the current branch is `main` or the target, stop and ask the user to switch to a feature branch.
- Never put a token or PAT in a command, log or file, and never ask the user to paste one. Authentication is done by the user with `az login` or `az devops login` in their own terminal.
- Only `dev.azure.com` (the company's Azure DevOps) is contacted, through `git push` and `az`. No other service.

## Steps

1. **Check the tools.**
   - `git --version`, `az --version`, `az extension show --name azure-devops`.
   - If `az` is missing, say so (install Azure CLI) and go to **Manual alternative**. If the extension is missing, tell the user to run `az extension add --name azure-devops` and stop or use the manual route. Do not install it unasked.
   - `az account show` (or `az devops project show` after step 2). If not logged in, tell the user to run `az login` themselves, then use the manual route meanwhile.

2. **Check org and project defaults.** Run `az devops configure --list`. If organization or project is empty, derive them from `git remote get-url origin` (`https://dev.azure.com/<org>/<project>/_git/<repo>`) and ask the user before setting them with `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`. Do not guess if the remote is not an Azure DevOps URL.

3. **Verify git state.**
   - `git branch --show-current` is the source branch (must not be `main`/target).
   - `git status --porcelain`: if there are uncommitted changes, list them and ask whether to commit them first (do not commit or stash on your own).
   - `git fetch origin <target>`, then `git log origin/<target>..HEAD --oneline` must show at least one commit. If none, there is nothing to raise; stop.
   - Note if the branch is behind the target (`git rev-list --count HEAD..origin/<target>`) and mention it; do not rebase or merge unasked.

4. **Draft title and description** from `git log origin/<target>..HEAD` and `git diff --stat origin/<target>...HEAD` (read the diff for the important files):
   - Title: one line, imperative, under about 80 characters. For a single commit, reuse its subject.
   - Description in Markdown:
     ```
     ## Summary
     <what and why, 1-3 sentences>

     ## Changes
     - <key change per bullet, grouped by area>

     ## Testing
     - <tests run or added, how to verify manually; say "not run" if that is the truth>

     Related work item: #<id>
     ```
   - Do not invent test results. Do not include secrets, tokens or internal hostnames from the diff.

5. **Confirm with the user.** Show source -> target, work item, title and the full description, and ask for a go-ahead or edits. Wait.

6. **Push the branch** (plain push, no force): `git push -u origin <source-branch>`. If it is rejected as non-fast-forward, stop and tell the user; do not force.

7. **Create the PR** after confirmation. Write the description to a temporary file in the workspace only if it is long or multi-line, and delete it afterwards:
   ```
   az repos pr create --source-branch <source> --target-branch <target> --title "<title>" --description "<description>" --work-items <id>
   ```
   Add `--open` only if the user wants the PR opened in the browser. Add `--draft true` only if asked. Pass `--organization`/`--project`/`--repository` only if the defaults are not set.

8. **Report** the PR id and URL (from the command output, `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>`), the linked work item, and the target branch. If the work item link fails (wrong id or no permission), say so and give the PR URL so the user can link it in the web UI.

## Manual alternative (az missing, extension missing or not logged in)

State exactly what is missing, then:
1. Push the branch (steps 3 and 6 still apply).
2. Open `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequestcreate?sourceRef=<source-branch>&targetRef=<target-branch>` (derive org/project/repo from `git remote get-url origin`; URL-encode slashes in branch names as `%2F`).
3. Give the user the drafted title and description to paste, and tell them to add work item `<id>` under "Work items".

## Edge cases

- **PR already exists** for the branch: `az repos pr create` fails or `az repos pr list --source-branch <source> --status active` shows it. Report the existing PR instead of creating another.
- **Detached HEAD** or no `origin` remote: stop and explain.
- **Argument looks wrong** (non-numeric work item that is not a branch name): ask rather than guess.
