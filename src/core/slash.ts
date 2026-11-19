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
  { name: 'changes', description: 'Review every file this session changed: accept, revert or open diffs' },
  { name: 'commit', description: 'Write a commit message from the current diff and commit after you confirm' },
  { name: 'pr', description: 'Raise a pull request with your pr-creation skill' },
  { name: 'memory', description: 'View and edit CLAUDE.md / INFRAON.md project memory' },
  { name: 'search', description: 'Search the text of all saved sessions', args: '<text>' },
  { name: 'export', description: 'Save this session as Markdown or HTML', args: '[md|html]' },
  { name: 'permissions', description: 'Show the active permission rules and hooks (or `/permissions edit`)', args: '[edit]' },
  { name: 'audit', description: 'Open the log of commands, edits and approvals for this session' },
  { name: 'schedule', description: 'Create and manage scheduled tasks' },
];

/** Commands the host loads on demand, so they cost nothing until they are used. */
export const FEATURE_COMMANDS = ['changes', 'commit', 'pr', 'memory', 'search', 'export', 'permissions', 'audit', 'schedule'];

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
    default: return false;
  }
  return true;
}
