/**
 * Shared between the runner (plain Node) and the suite (VS Code extension host). Must not import 'vscode'.
 * The two sides talk over the fake gateway's control routes (/__e2e/*).
 */

export const API_KEY = 'e2e-fake-key-not-a-secret';
export const MODELS = ['e2e-model-a', 'e2e-model-b'];

/** Environment passed from the runner to the suite. */
export const ENV = {
  control: 'INFRAON_E2E_CONTROL',
  outDir: 'INFRAON_E2E_OUT',
  workspace: 'INFRAON_E2E_WORKSPACE',
  grep: 'INFRAON_E2E_GREP',
  budgetMs: 'INFRAON_E2E_BUDGET_MS',
  strict: 'INFRAON_E2E_STRICT',
} as const;

export interface ToolCallSpec { name: string; args: unknown; id?: string }

/** One scripted answer to one POST /v1/chat/completions. Everything is JSON so a flow can send it over HTTP. */
export interface ScriptStep {
  /** Assistant text, streamed in word-sized chunks. */
  text?: string;
  /** Tool calls, streamed after the text. */
  toolCalls?: ToolCallSpec[];
  /** Answer with this HTTP status instead of a stream. */
  status?: number;
  /** Response body for `status`. */
  body?: string;
  /** Wait before the first byte. */
  delayMs?: number;
  /** Wait between chunks. */
  chunkDelayMs?: number;
  /** Stop after `afterChars` characters of text until the flow releases this gate (or the client disconnects). */
  gate?: { name: string; afterChars?: number };
  /** Destroy the socket without answering. */
  drop?: boolean;
}

export interface RecordedMessage { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }

export interface RecordedRequest {
  seq: number;
  auth: string;
  model: string;
  stream: boolean;
  messages: RecordedMessage[];
  tools: string[];
  /** The client went away before the answer finished (e.g. the Stop button). */
  aborted: boolean;
  /** No scripted step was queued, so the gateway answered with a default reply. */
  unscripted: boolean;
}

export interface GatewayState { requests: RecordedRequest[]; pending: number; unscripted: number }

export interface ScreenshotResult { file?: string; error?: string }

/** Test status vocabulary used in .e2e/results.json. */
export type TestStatus = 'passed' | 'failed' | 'known-failure' | 'unexpected-pass' | 'skipped';

export interface TestCaseResult {
  name: string;
  classname: string;
  status: TestStatus;
  time: number;
  failure?: { message: string; stack?: string };
  knownFailure?: string;
  screenshots: string[];
}

export interface SuiteResult { name: string; tests: number; failures: number; time: number; testcases: TestCaseResult[] }

export interface RunResults {
  name: string;
  timestamp: string;
  complete: boolean;
  tests: number;
  passed: number;
  failures: number;
  knownFailures: number;
  skipped: number;
  time: number;
  testsuites: SuiteResult[];
}
