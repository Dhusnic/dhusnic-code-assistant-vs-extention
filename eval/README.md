# Eval tasks

Real coding tasks the agent runs end to end against the LLM gateway, graded by tests it does not see. Use them to
check that a prompt, setting or model change keeps (or raises) the pass rate before it ships.

## Running

```
$env:INFRAON_EVAL_BASE_URL = "https://172.16.48.75:30400/v1"
$env:INFRAON_EVAL_API_KEY  = "<key>"        # never commit it
$env:INFRAON_EVAL_MODEL    = "qwen3-coder-next"
npm run eval -- --repeat 3 --history
```

- `--filter <regex>` runs matching task names only; `--effort low|medium|high|max` sets the effort (default medium).
- `--repeat N` runs each task N times; the report gives the pass rate per task and overall.
- `--history` appends one JSON line (date, extension version, model, effort, pass rate, per-task results, repeat
  count) to `eval/results/history.jsonl`, which git ignores. Compare the line for a release with the previous one.
- Tasks whose toolchain is missing (`"requires": ["python"]` without Python 3 on PATH) are skipped and listed.

## Comparing with Cline

```
npm install --prefix D:\tools\cline cline        # once; any folder works
npm run eval -- --agent both --cline D:\tools\cline --repeat 3
```

- `--agent infraon|cline|both`: `both` runs every task with this extension's agent and then Cline, back to back, with
  the same prompt, time limit, hidden tests and model. The report shows both side by side (pass rate, wall time, LLM
  calls, model wait, time to first byte, tokens in/out, timeouts) and names the tasks where they differ.
- Both agents reach the gateway through a local metering proxy, so calls and tokens are counted the same way for both.
  It also writes this model's sampling profile into every request (Cline sends no temperature of its own);
  `--native-sampling` lets each agent use its own sampling. `--cline-thinking <level>` passes Cline's `--thinking`.
- Cline runs with isolated state in `eval-results/<stamp>-cline-home`, gets a placeholder key (the proxy adds the real
  one), and its outbound proxy is set to a closed local port, so it cannot reach anything but the local proxy:
  no Cline cloud, no telemetry, no update checks. The task code never leaves the machine except to the gateway.
- `--history` records only this extension's runs.

## Task format

```
eval/tasks/<name>/
  task.json        name, prompt, check, hiddenTests, difficulty, language, tags, requires, mustNotChange, timeoutSeconds
  repo/            the starting repository the agent works in
  hidden/          files copied in only after the agent finishes (graders and hidden tests)
  solution/        the reference solution: files that replace or add to repo/ (never shown to the agent)
```

The check (usually `node __grade__.js`) runs in the finished repository with `hidden/` copied in; exit code 0 is a
pass. `npm test` (the slow tests: `npm run test:slow`) includes `src/test/slow/evalTasks.test.ts`, which proves every task is gradable: its check must
fail on the untouched `repo/` and pass once `solution/` is applied. Add a task by creating the four parts above and
running that test.
