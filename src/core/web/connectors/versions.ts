/**
 * A forgiving version comparator for every registry we talk to (SemVer, PEP 440, Maven, Go "v" tags).
 * Numeric dot parts compare numerically; a pre-release (1.0.0-rc.1, 1.0rc1, 2.0.0-beta) sorts below its
 * release; Maven release qualifiers (.Final, .RELEASE, -GA) count as the release; build metadata is ignored.
 */

const RELEASE_QUALIFIERS = /^[.-]?(final|ga|release|r)$/i;
const POST = /^[.-]?(post|p|sp|patch)\.?\d*$/i;

interface Parsed { nums: number[]; pre: string[] | null; post: number }

function parse(v: string): Parsed {
  const s = v.trim().replace(/^[vV=]/, '').split('+')[0];
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) { return { nums: [], pre: s ? s.split(/[.-]/) : null, post: 0 }; }
  const nums = m[1].split('.').map(Number);
  const rest = m[2];
  if (!rest || RELEASE_QUALIFIERS.test(rest)) { return { nums, pre: null, post: 0 }; }
  if (POST.test(rest)) { return { nums, pre: null, post: Number(/\d+/.exec(rest)?.[0] ?? 1) || 1 }; }
  return { nums, pre: rest.replace(/^[.-]/, '').split(/[.-]|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/i).filter(Boolean), post: 0 };
}

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) { return Math.sign(Number(a) - Number(b)); }
  if (an !== bn) { return an ? -1 : 1; }
  const al = a.toLowerCase(), bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : 0;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) { return Math.sign(d); }
  }
  if (!x.pre !== !y.pre) { return x.pre ? -1 : 1; }
  if (x.pre && y.pre) {
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      if (x.pre[i] === undefined) { return -1; }
      if (y.pre[i] === undefined) { return 1; }
      const d = cmpIdent(x.pre[i], y.pre[i]);
      if (d) { return d; }
    }
  }
  return Math.sign(x.post - y.post);
}

/** True for versions with a pre-release part (alpha/beta/rc/dev/snapshot…). */
export const isPrerelease = (v: string): boolean => parse(v).pre !== null;
