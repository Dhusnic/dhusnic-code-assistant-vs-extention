import { EFFORTS, Effort, MODES, MODE_INFO, Mode, isEffort, isMode } from './policy';

export interface SlashCommand { name: string; description: string; args?: string }

export const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show available commands' },
  { name: 'clear', description: 'Start a new chat' },
  { name: 'skills', description: 'Manage skills: create, edit, run, enable for the agent' },
  { name: 'agents', description: 'List agent types and the sub-agents of this session' },
  { name: 'mcp', description: 'Show MCP servers and tools (or `/mcp reload`)', args: '[reload]' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'undo', description: 'Rewind the last message and restore its file changes' },
  { name: 'history', description: 'Browse saved chats' },
  { name: 'plan', description: 'Switch to plan mode (optionally with a task)', args: '[task]' },
  { name: 'mode', description: 'Set permission mode: ask, auto-edit, auto, plan', args: '<mode>' },
  { name: 'effort', description: 'Set effort: low, medium, high, max', args: '<level>' },
  { name: 'model', description: 'Show or switch the model', args: '[name]' },
  { name: 'init', description: 'Analyze the project and create a CLAUDE.md with its conventions' },
  { name: 'review', description: 'Review the uncommitted changes in the workspace' },
  { name: 'fix', description: 'Fix a bug test-first: reproduce it with a failing test, fix, prove the test passes', args: '<bug description>' },
  { name: 'deploy', description: 'Deploy to a Linux server: check, back up, apply, verify, roll back if needed', args: '[server] [what to deploy]' },
  { name: 'changes', description: 'Review every file this session changed: accept, revert or open diffs' },
  { name: 'commit', description: 'Write a commit message from the current diff and commit after you confirm' },
  { name: 'pr', description: 'Raise a pull request with your pr-creation skill' },
  { name: 'memory', description: 'View and edit CLAUDE.md / INFRAON.md project memory' },
  { name: 'search', description: 'Search the text of all saved sessions', args: '<text>' },
  { name: 'export', description: 'Save this session as Markdown or HTML', args: '[md|html]' },
  { name: 'permissions', description: 'Show the active permission rules and hooks (or `/permissions edit`)', args: '[edit]' },
  { name: 'audit', description: 'Open the log of commands, edits and approvals for this session' },
  { name: 'schedule', description: 'Create and manage scheduled tasks' },
  { name: 'qa', description: 'Test an app end to end in a real browser: flows, API failures, data correctness, mobile, audit — report saved to test-reports/', args: '<url, feature or what to test>' },
  { name: 'research', description: 'Deep research on the web: parallel researchers, cited report saved to research/', args: '<topic or question>' },
  { name: 'sources', description: 'List every web source used in this session (or `/sources save` to write them to a file)', args: '[save]' },
  { name: 'web', description: 'Web access status, search provider and cache (`/web key`, `/web clear-cache`)', args: '[key|clear-cache]' },
];

/** Commands the host loads on demand, so they cost nothing until they are used. */
export const FEATURE_COMMANDS = ['changes', 'commit', 'pr', 'memory', 'search', 'export', 'permissions', 'audit', 'schedule', 'sources', 'web'];

const ALIASES: Record<string, string> = { new: 'clear', reset: 'clear', rewind: 'undo', chats: 'history' };

export interface ParsedSlash { name: string; args: string; known: boolean }

/** `/name args` → command. Absolute paths like /usr/bin/x are not commands. */
export function parseSlash(text: string): ParsedSlash | null {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) { return null; }
  const name = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase();
  return { name, args: (m[2] ?? '').trim(), known: COMMANDS.some((c) => c.name === name) };
}

export function matchCommands(prefix: string, commands: SlashCommand[] = COMMANDS): SlashCommand[] {
  const p = prefix.toLowerCase().replace(/^\//, '');
  return commands.filter((c) => c.name.startsWith(p));
}

export const INIT_PROMPT = `Analyze this repository (structure, languages, build/test commands, conventions) and create a CLAUDE.md at the workspace root.
Keep it concise: purpose, layout, how to build/run/test, coding conventions, and hard rules a new engineer must follow. If CLAUDE.md already exists, improve it instead of replacing it.`;

export const REVIEW_PROMPT = `Review the uncommitted changes in this workspace. Run \`git status\` and \`git diff\`, then report correctness bugs, security issues, and missing tests, ordered by severity, with file:line references. Do not modify any files.`;

/** The test-first bug-fix workflow behind /fix. */
export function fixPrompt(args: string): string {
  return `Fix this bug test-first: ${args || '(no description given: ask me what the bug is with ask_user_question, then continue)'}

Work in these steps and track them with todo_write:
1. Find the cause: locate the relevant code and existing tests (glob_files, grep, find_references). Find how this project runs its tests.
2. Reproduce: add a focused test (next to the existing tests, in their style) that fails because of this bug. Run ONLY that test and confirm it fails for the reason described, not for an unrelated error. If the project has no test setup, write the smallest script that shows the bug instead, and say so. When the record_diagnosis tool is offered, record the root cause with it now: source files stay locked until it is accepted.
3. Fix the root cause with the smallest change. Do not change the test to make it pass.
4. Prove it: run the new test (it must pass now), then the related test files, then the project's checks.
5. Report: the cause (file:line), the fix, the test you added, and the test results before and after.`;
}

/** The safe deployment workflow behind /deploy. */
export function deployPrompt(args: string): string {
  return `Deploy to a Linux server${args ? `: ${args}` : ''}.

Work like a careful release engineer:
1. Call list_servers and read the target server's notes (paths, service names, health checks). If the server or what to deploy is unclear, ask me with ask_user_question before doing anything.
2. Write the plan as a task list with todo_write.
3. Build and test locally first with the project's own build and test commands. Stop if they fail.
4. Inspect the server before changing it: current version or commit, service status, free disk space.
5. Back up what you will replace (a timestamped copy or the previous release) and say where it is.
6. Deploy: upload the build with remote_upload or pull it on the server, then install, migrate and restart. Run anything long with background: true and follow it with remote_job_output.
7. Verify: service status, the last log lines, and the health check from the notes. Do not finish without verifying.
8. If verification fails, roll back to the backup, verify again, and report what went wrong.
Finish with: what was deployed, the version before and after, the verification evidence, and where the backup is.`;
}

/** The end-to-end QA workflow behind /qa: plan, explore, break it on purpose, check the data, report with evidence. */
export function qaPrompt(args: string, today = new Date(), reportsFolder = 'test-reports'): string {
  const date = today.toISOString().slice(0, 10);
  return `Test this like a senior QA engineer: ${args || '(nothing given: ask me with ask_user_question which app URL or feature to test, and how to log in, then continue)'}

You have a real browser (browser_open, browser_act, browser_read, browser_network, browser_screenshot, browser_audit), failure simulation (browser_simulate), API tests (api_test), data checks (data_compare) and read-only SQL (db_query). Track every step with todo_write.

1. Understand: find the app (README, package.json scripts, routes, API handlers, .env.example) — its URL, how to start it, the main user flows, the APIs each page calls, and any test accounts. If the app is not running, start it with run_command (background) and wait until it answers. If login details are missing, ask me with ask_user_question.
2. Plan: write a short test plan as a todo list — smoke, main flows, input validation, API failure handling, data correctness, responsive layout, audit. Prefer depth on what changed or what I named.
3. Smoke test: browser_open each main page. Every page-load failure, JS error, console error, failed or 4xx/5xx API call is a finding.
4. Flows: drive the real user flows with browser_act (create, edit, delete, search, filter, sort, paginate, log out). After each step check the result on screen AND in browser_network (the right API was called, with the right body, and succeeded).
5. Negative tests: empty and invalid inputs, boundaries (0, negative, very long text, special characters, emoji), double submit, back button, refresh mid-flow. Errors must be clear and the app must not break.
6. Failure handling: with browser_simulate make each important API fail (status 500, 401/403, 404, network failure, timeout via delay, empty list "[]", malformed JSON), reload, and check what the user sees — a helpful message and a way to retry, not a blank page, an endless spinner or a JS crash. Try network "offline" and "slow-3g". Clear the simulation afterwards.
7. Data correctness: compare what the UI shows with the API response (data_compare actual={"page_table": …} expected={"network": "/api/…"}), the API with the database when one is configured (db_query / data_compare with {"db": …}), and with expected files when the repo has them. Check totals, counts, formatting, dates and time zones, sorting and pagination. Use api_test with "rows" rules for required, unique, type and range checks.
8. API tests: api_test each endpoint you found — happy path, validation errors (400/422), missing or bad auth (401/403), unknown ids (404), response time. Note error responses that leak stack traces or SQL.
9. Layout and quality: browser_open with device "mobile" and "tablet" on the main pages; browser_audit for performance and accessibility; screenshots of anything broken.
10. Report: write ${reportsFolder}/${date}-<short-slug>.md with:
   - Summary: what was tested, environment (URL, browser, data), overall verdict
   - Results table: area · test · result (✔ pass / ✘ fail / ⚠ warning) · evidence
   - Bugs, worst first: title, severity (critical/high/medium/low), steps to reproduce, expected vs actual, evidence (failing request id + status + body excerpt, console error, screenshot path), likely cause in the code (file:line) when you can find it
   - Data mismatches with the exact rows and values
   - Not tested and why
   Reply with the summary, the bug list and the report path. Do not fix anything unless I ask; offer to fix the bugs test-first and to turn the checks into automated regression tests in the project's own test framework.`;
}

/** The deep-research workflow behind /research: plan, parallel researchers, cross-check, cited report on disk. */
export function researchPrompt(args: string, today = new Date()): string {
  const date = today.toISOString().slice(0, 10);
  return `Research this thoroughly using the internet: ${args || '(no topic given: ask me what to research with ask_user_question, then continue)'}

Work like a senior R&D analyst and track the steps with todo_write:
1. Scope: restate the question, list 3–6 sub-questions that together answer it, and what "done" looks like. If the topic is ambiguous, ask me first with ask_user_question.
2. Investigate in parallel: launch one "researcher" agent per sub-question in ONE response (they run at the same time). Give each a precise brief: the sub-question, which sources fit (web_search, paper_search for academic work, package_info / vuln_lookup / github_lookup for software, tech_search for community and standards), and ask it to return findings with source numbers [n], dates, and confidence.
3. Check the evidence: compare the reports. Where sources disagree, say so and explain which is more credible (official docs, standards, peer-reviewed and government sources outrank vendors, news, forums and blogs; newer beats older for fast-moving topics). Fetch primary sources yourself (web_fetch) for any claim the answer depends on. Never present something as fact without a source.
4. Report: write research/${date}-<short-slug>.md with:
   - Summary (5–10 bullet points answering the question)
   - Findings per sub-question, every claim cited as [n]
   - Comparison table when options are compared (features, maturity, license, activity, performance, cost)
   - Disagreements and open questions
   - Recommendation, with the confidence level and why
   - References: the output of web_sources for the sources you cited (number, title, URL, type, date)
5. Reply with the summary, the recommendation and the report's path.`;
}

export interface SlashApi {
  info(text: string): void;
  newChat(): void;
  undo(): Promise<void>;
  compact(): Promise<void>;
  mcp(args: string): Promise<void>;
  agents(): void;
  skills(): void;
  openHistory(): void;
  setMode(m: Mode): void;
  setEffort(e: Effort): void;
  setModel(name: string): void;
  currentModel(): string;
  models(): string[];
  /** Sends a prompt to the agent; `display` is what the chat shows for it. */
  send(prompt: string, display?: string): Promise<void>;
  /** Runs one of FEATURE_COMMANDS. */
  feature?(name: string, args: string): Promise<void>;
}

/** Executes a parsed command. Returns false when the text should be treated as a normal prompt. */
export async function runSlash(p: ParsedSlash, api: SlashApi): Promise<boolean> {
  if (!p.known) { api.info(`Unknown command /${p.name}. Type /help to see commands.`); return true; }
  if (FEATURE_COMMANDS.includes(p.name) && api.feature) { await api.feature(p.name, p.args); return true; }
  switch (p.name) {
    case 'help':
      api.info(COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`).join('\n'));
      break;
    case 'clear': api.newChat(); break;
    case 'undo': await api.undo(); break;
    case 'compact': await api.compact(); break;
    case 'mcp': await api.mcp(p.args); break;
    case 'agents': api.agents(); break;
    case 'skills': api.skills(); break;
    case 'history': api.openHistory(); break;
    case 'plan':
      api.setMode('plan');
      if (p.args) { await api.send(p.args); } else { api.info('Plan mode on. Describe the task and I will research and propose a plan.'); }
      break;
    case 'mode': {
      const v = p.args.toLowerCase();
      if (isMode(v)) { api.setMode(v); api.info(`Mode: ${MODE_INFO[v].label}`); }
      else { api.info(`Usage: /mode <${MODES.join('|')}>`); }
      break;
    }
    case 'effort': {
      const v = p.args.toLowerCase();
      if (isEffort(v)) { api.setEffort(v); api.info(`Effort: ${v}`); }
      else { api.info(`Usage: /effort <${EFFORTS.join('|')}>`); }
      break;
    }
    case 'model':
      if (!p.args) { api.info(`Model: ${api.currentModel()}\nAvailable: ${api.models().join(', ') || '(none loaded)'}`); }
      else if (api.models().length && !api.models().includes(p.args)) { api.info(`Unknown model "${p.args}". Available: ${api.models().join(', ')}`); }
      else { api.setModel(p.args); api.info(`Model: ${p.args}`); }
      break;
    case 'init': await api.send(INIT_PROMPT, '/init'); break;
    case 'review': await api.send(REVIEW_PROMPT, '/review'); break;
    case 'fix': await api.send(fixPrompt(p.args), `/fix${p.args ? ` ${p.args}` : ''}`); break;
    case 'deploy': await api.send(deployPrompt(p.args), `/deploy${p.args ? ` ${p.args}` : ''}`); break;
    case 'qa': await api.send(qaPrompt(p.args), `/qa${p.args ? ` ${p.args}` : ''}`); break;
    case 'research': await api.send(researchPrompt(p.args), `/research${p.args ? ` ${p.args}` : ''}`); break;
    default: return false;
  }
  return true;
}
