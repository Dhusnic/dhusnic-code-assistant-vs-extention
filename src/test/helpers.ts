import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentUi, ApprovalRequest } from '../core/agent';
import { LlmFn, StreamResult } from '../core/llm';

export async function tmpDir(prefix = 'ica-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Scripted LLM: returns the queued results in order and records every call. */
export function fakeLlm(script: Array<StreamResult | ((msgs: any[]) => StreamResult)>): { fn: LlmFn; calls: any[][] } {
  const calls: any[][] = [];
  let i = 0;
  const fn: LlmFn = async (_cfg, messages, _tools, onToken) => {
    calls.push(messages);
    const step = script[Math.min(i++, script.length - 1)];
    const res = typeof step === 'function' ? step(messages) : step;
    if (res.content) { onToken(res.content); }
    return res;
  };
  return { fn, calls };
}

export const text = (content: string): StreamResult => ({ content, toolCalls: [] });
export const call = (name: string, args: object, id = `c_${name}`): StreamResult => ({
  content: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

export interface RecordingUi extends AgentUi { events: string[]; approvals: ApprovalRequest[] }

export function recordingUi(approveWith: boolean | ((r: ApprovalRequest) => boolean) = true): RecordingUi {
  const events: string[] = [];
  const approvals: ApprovalRequest[] = [];
  return {
    events, approvals,
    token: (t) => events.push(`token:${t}`),
    toolStart: (_id, name) => events.push(`start:${name}`),
    toolEnd: (_id, ok, r) => events.push(`end:${ok ? 'ok' : 'fail'}:${r.slice(0, 60)}`),
    info: (t) => events.push(`info:${t}`),
    approve: async (req) => { approvals.push(req); return typeof approveWith === 'function' ? approveWith(req) : approveWith; },
  };
}
