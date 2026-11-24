/**
 * The agent loop's built-in tools (delegation, questions, task list, plan approval) as the model sees them, and the
 * system prompt that frames every request. These are definitions only; the loop that executes them is agent.ts, which
 * re-exports everything here.
 */
import type { ToolSpec } from './llm';
import { fnSpec, WorkspaceRoot } from './tool';
import { AgentType, DEFAULT_AGENT_TYPE } from './agentTypes';
import { MAX_OPTIONS, MAX_QUESTIONS } from './questions';
import { MAX_TODOS } from './todos';
import { Effort, Mode, effortParams } from './policy';
import { BASE_PROMPT, FANOUT_PROMPT, PLAN_FIRST_PROMPT, environmentSection } from './prompts';
import { SKILLS_PROMPT } from './skills';

/** Wraps mid-turn user messages so the model knows they arrived while it was working. */
export function queuedMessageText(texts: string[]): string {
  return `The user sent ${texts.length > 1 ? 'these messages' : 'this message'} while you were working:\n${texts.map((t) => `<user-message>\n${t}\n</user-message>`).join('\n')}\n\nTake ${texts.length > 1 ? 'them' : 'it'} into account now: ${texts.length > 1 ? 'they' : 'it'} may add to, change, redirect or cancel the current task. Briefly acknowledge ${texts.length > 1 ? 'them' : 'it'}, then continue with the updated task (or stop if the user asked you to).`;
}

/** Claude-style delegation tool: launches a sub-agent (foreground or background). */
export const AGENT_TOOL = 'agent';
export const TASK_TOOL = AGENT_TOOL;
export const SEND_TOOL = 'send_message';
export const DELEGATION_TOOLS = [AGENT_TOOL, SEND_TOOL, 'ask_user_question'];

export function agentToolSpec(types: AgentType[]): ToolSpec {
  const list = types.map((t) => `- ${t.name}: ${t.description}${t.readOnly ? ' (read-only)' : ''}`).join('\n');
  return fnSpec(AGENT_TOOL, `Launch a sub-agent to handle a task autonomously in its own context window. Available agent types:
${list}

How to use it:
- Sub-agents start with an EMPTY context (except "fork"), so put every detail they need in prompt and say exactly what to return.
- Launch several agents in one turn (multiple tool calls) to run them in parallel. When the user lists several independent tasks, launch one agent per task in the same response; never give two parallel agents edits to the same files.
- Set run_in_background to true for long work: the call returns at once and you are notified automatically when the agent finishes. Do not poll, sleep or wait for it; continue with other work or end your turn.
- An agent's final message is its report and is returned only to you; summarize what matters for the user.
- Use send_message to give an existing agent follow-up instructions; it keeps its context.
- Prefer doing small, targeted tasks yourself; delegate broad searches or independent pieces of work.`,
  {
    description: { type: 'string', description: 'Short (3-6 word) title of the task.' },
    prompt: { type: 'string', description: 'The complete task for the agent, including all context it needs and what to report back.' },
    subagent_type: { type: 'string', enum: types.map((t) => t.name), description: `Agent type (default: ${DEFAULT_AGENT_TYPE}).` },
    run_in_background: { type: 'boolean', description: 'Run without waiting; you will be notified when it finishes.' },
  }, ['description', 'prompt']);
}

export const QUESTION_TOOL = 'ask_user_question';
export const QUESTION_SPEC: ToolSpec = fnSpec(QUESTION_TOOL,
  `Ask the user 1-${MAX_QUESTIONS} multiple-choice questions when you are genuinely unsure how to proceed (ambiguous requirements, a choice between approaches, preferences, missing details). The run pauses until the user answers, then continues with the answers as this tool's result.
- Each question has 2-${MAX_OPTIONS} concise options with a short description of the trade-off. Do NOT add an "Other" option: the user can always pick "Other" and type an answer.
- Use multiSelect: true when several options can apply at once.
- If you recommend an option, put it first and end its label with " (Recommended)".
- Ask everything you need in ONE call instead of several in a row. Do not use this for things you can find out by reading the code.`,
  {
    questions: {
      type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full question, ending with a question mark.' },
          header: { type: 'string', description: 'Very short label shown as a chip (max 12 characters), e.g. "Format".' },
          options: {
            type: 'array', minItems: 2, maxItems: MAX_OPTIONS,
            items: { type: 'object', properties: { label: { type: 'string', description: '1-5 words.' }, description: { type: 'string', description: 'What choosing this means.' } }, required: ['label'] },
          },
          multiSelect: { type: 'boolean', description: 'Allow selecting several options.' },
        },
        required: ['question', 'options'],
      },
    },
  }, ['questions']);

export const TODO_TOOL = 'todo_write';
export const TODO_SPEC: ToolSpec = fnSpec(TODO_TOOL,
  `Create or update your task list for the current work; the user sees it as a live checklist. Send the COMPLETE list every time (it replaces the previous one).
- Use it for tasks with 3 or more steps, and right after a plan is approved (one item per plan step).
- Exactly one step should be in_progress while you work; mark a step completed immediately when it is done.
- content is the step in imperative form ("Fix the login bug"); activeForm is the present-continuous form shown while it runs ("Fixing the login bug").
- At most ${MAX_TODOS} steps. Skip the list for trivial single-step requests.`,
  {
    todos: {
      type: 'array', minItems: 1, maxItems: MAX_TODOS,
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string' },
        },
        required: ['content', 'status'],
      },
    },
  }, ['todos']);

export const SEND_SPEC: ToolSpec = fnSpec(SEND_TOOL,
  'Send a follow-up message to an existing sub-agent (by the agent id returned when it was launched). It continues with its context intact and runs in the background; you are notified when it replies.',
  { to: { type: 'string', description: 'Agent id, e.g. "a3".' }, message: { type: 'string', description: 'What the agent should do next.' } }, ['to', 'message']);

const SUBAGENT_PROMPT = `\n\nYou are a SUB-AGENT launched by a parent agent to do one task. Work autonomously: you cannot ask the user questions.
Finish with a concise, factual report: key findings with file:line references, what you changed and how you verified it. Do not include raw dumps of file contents. Your final message is the only thing the parent will see.`;

export const PLAN_TOOL = 'exit_plan_mode';
export const PLAN_SPEC: ToolSpec = fnSpec(PLAN_TOOL,
  'Present your finished plan to the user for approval. Call this once research is complete; only available in plan mode. On approval you leave plan mode and can edit files.',
  { plan: { type: 'string', description: 'The full plan in markdown: numbered steps, files to change, risks, verification.' } }, ['plan']);

const PLAN_PROMPT = `\n\nYou are in PLAN MODE. You may only read and search; you cannot edit files or run commands.
Research the task thoroughly, then call the exit_plan_mode tool with a concrete plan for the user to approve: numbered steps, the files you will change, risks, and how you will verify the result. Do not write the plan only as chat text and do not start implementing until the plan is approved.`;

/** `skills`: the model can load skills itself (the skill tool is offered), so it is told when to (SKILLS_PROMPT). */
export function buildSystemPrompt(mode: Mode, effort: Effort, root: string, memory: string, activeFile?: string, subagent = false, extra = '', checks = '', roots?: WorkspaceRoot[], planFirst = false, skills = false): string {
  const hint = effortParams(effort).hint;
  return [
    BASE_PROMPT,
    mode === 'plan' ? PLAN_PROMPT : '',
    subagent ? SUBAGENT_PROMPT : `\n\n${FANOUT_PROMPT}`,
    skills ? `\n\n${SKILLS_PROMPT}` : '',
    extra ? `\n\n${extra}` : '',
    hint ? `\n\nEffort guidance: ${hint}` : '',
    planFirst ? `${hint ? '\n' : '\n\n'}${PLAN_FIRST_PROMPT}` : '',
    `\n\n${environmentSection(root, { platform: process.platform, ...(roots && roots.length > 1 ? { roots } : {}) })}`,
    checks ? `\n\n${checks}` : '',
    activeFile ? `\nActive file: ${activeFile}` : '',
    memory ? `\n\n# Project instructions\n${memory}` : '',
  ].join('');
}
