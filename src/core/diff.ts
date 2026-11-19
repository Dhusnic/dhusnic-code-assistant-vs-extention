export type DiffLine =
  | { t: 'add'; text: string; n: number }
  | { t: 'del'; text: string; n: number }
  | { t: 'ctx'; text: string; n: number }
  | { t: 'gap'; text: string };

export interface DiffResult { lines: DiffLine[]; added: number; removed: number }

const MAX_CELLS = 4_000_000;

type Op = { t: 'add' | 'del' | 'ctx'; text: string };

/** Line-level diff: trims common prefix/suffix, then LCS on the middle (or a plain replace if it is too large). */
export function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const head = a.slice(0, start).map((text): Op => ({ t: 'ctx', text }));
  const tail = a.slice(endA).map((text): Op => ({ t: 'ctx', text }));
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  return [...head, ...lcsOps(midA, midB), ...tail];
}

function lcsOps(a: string[], b: string[]): Op[] {
  if (!a.length) { return b.map((text): Op => ({ t: 'add', text })); }
  if (!b.length) { return a.map((text): Op => ({ t: 'del', text })); }
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text): Op => ({ t: 'del', text })), ...b.map((text): Op => ({ t: 'add', text }))];
  }
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ t: 'del', text: a[i++] }); }
    else { out.push({ t: 'add', text: b[j++] }); }
  }
  while (i < a.length) { out.push({ t: 'del', text: a[i++] }); }
  while (j < b.length) { out.push({ t: 'add', text: b[j++] }); }
  return out;
}

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'));

/** Unified-style diff with `context` unchanged lines around each change and collapsed gaps between hunks. */
export function diffText(oldText: string, newText: string, context = 3): DiffResult {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  let added = 0, removed = 0;
  const numbered: Array<Op & { n: number }> = [];
  let oldNo = 0, newNo = 0;
  for (const op of ops) {
    if (op.t === 'add') { added++; newNo++; numbered.push({ ...op, n: newNo }); }
    else if (op.t === 'del') { removed++; oldNo++; numbered.push({ ...op, n: oldNo }); }
    else { oldNo++; newNo++; numbered.push({ ...op, n: newNo }); }
  }
  const keep = new Array<boolean>(numbered.length).fill(false);
  numbered.forEach((op, i) => {
    if (op.t === 'ctx') { return; }
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k++) { keep[k] = true; }
  });
  const lines: DiffLine[] = [];
  let skipped = 0;
  numbered.forEach((op, i) => {
    if (keep[i]) {
      if (skipped) { lines.push({ t: 'gap', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` }); skipped = 0; }
      lines.push({ t: op.t, text: op.text, n: op.n });
    } else { skipped++; }
  });
  if (skipped && lines.length) { lines.push({ t: 'gap', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` }); }
  return { lines, added, removed };
}
