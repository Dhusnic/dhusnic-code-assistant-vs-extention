import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PermissionRule, RuleEffect, RuleSource, evaluatePermission, loadPermissionSettings, parseRule } from '../core/permissions';
import { HookConfig, HookSpawnFn, hasHooks, hooksHash, mergeHooks, parseHooks, runHooks } from '../core/hooks';
import { DETECTORS, SecretVault, redactMessages } from '../core/redact';
import { AuditEntry, AuditLog } from '../core/audit';
import { ChatMessage } from '../core/llm';
import { tmpDir } from './helpers';

// Assembled at runtime so that this file itself never contains a scannable credential.
const fake = {
  aws: 'AKIA' + 'Q7RZ2M4KT9LP3XVB',
  awsSecret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYzz12' + 'abcd5678',
  github: 'ghp_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6',
  githubPat: 'github_pat_' + '11ABCDE0Y0aB3dE6gH9jK2_mN5pQ8sT1vW4yZ7bC0eF3hJ6',
  gitlab: 'glpat-' + 'aB3dE6gH9jK2mN5pQ8sT',
  slack: 'xoxb-' + '2048-1024-aB3dE6gH9jK2mN5p',
  stripe: 'sk_live_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4',
  google: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  azure: 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6kL9nP2rS5uX8zA1cD4fG7iJ0mO3qR6tU9wY2bE5hK8nQ==',
  npm: 'npm_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  pem: ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo', '4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onL', '-----END RSA ' + 'PRIVATE KEY-----'].join('\n'),
};

const rulesOf = (spec: Partial<Record<RuleEffect, string[]>>, source: RuleSource = 'user'): PermissionRule[] =>
  (Object.entries(spec) as Array<[RuleEffect, string[]]>).flatMap(([effect, list]) => list.map((r) => {
    const rule = parseRule(r, effect, source);
    assert.ok(rule, `rule should parse: ${r}`);
    return rule;
  }));
const cmd = (rules: PermissionRule[], command: string, platform: NodeJS.Platform = 'linux') =>
  evaluatePermission(rules, { tool: 'run_command', kind: 'exec', args: { command }, root: '/repo', platform }).effect;
const file = (rules: PermissionRule[], tool: string, p: unknown, platform: NodeJS.Platform = 'linux', root = '/repo') =>
  evaluatePermission(rules, { tool, kind: tool.includes('read') ? 'read' : 'edit', args: { path: p }, root, platform }).effect;

// ---------------------------------------------------------------- permissions: parsing

test('parseRule: canonicalises aliases and keeps the raw text', () => {
  assert.deepEqual(parseRule('Bash(git push*)', 'deny', 'user'), { effect: 'deny', tool: 'run_command', pattern: 'git push*', source: 'user', raw: 'Bash(git push*)' });
  assert.equal(parseRule('run_command(npm test*)', 'allow', 'local')?.tool, 'run_command');
  assert.equal(parseRule('Edit(.env*)', 'deny', 'user')?.tool, 'edit');
  assert.equal(parseRule('edit(.env*)', 'deny', 'user')?.tool, 'edit');
  assert.equal(parseRule('Read(secrets/**)', 'deny', 'user')?.tool, 'read');
  assert.equal(parseRule('read(secrets/**)', 'deny', 'user')?.pattern, 'secrets/**');
  assert.equal(parseRule('mcp__docs__search', 'allow', 'user')?.tool, 'mcp__docs__search');
  assert.equal(parseRule('mcp__docs__*', 'allow', 'user')?.tool, 'mcp__docs__*');
  assert.equal(parseRule('run_command', 'deny', 'policy')?.pattern, undefined);
  assert.equal(parseRule('Bash(echo (a))', 'allow', 'user')?.pattern, 'echo (a)');
});

test('parseRule: malformed rules return null and never throw', () => {
  for (const bad of ['', '   ', '(x)', 'Bash(', 'Bash()', 'Bash(  )', 'Bash(x', 'x)', '*', '**', 'bad name', 'mcp__x__y(pattern)', 'mcp__*(p)', 'na me(x)']) {
    assert.equal(parseRule(bad, 'deny', 'user'), null, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, 42, {}, []]) { assert.equal(parseRule(bad as any, 'deny', 'user'), null); }
});

test('loadPermissionSettings: merges all layers, reports errors, keeps hooks per source', async () => {
  const dir = await tmpDir();
  const user = path.join(dir, 'user.json'), project = path.join(dir, 'project.json'), local = path.join(dir, 'local.json');
  await fs.writeFile(user, '\uFEFF' + JSON.stringify({ permissions: { allow: ['Bash(npm test*)', 7, 'Bash('] }, hooks: { Stop: [] } }));
  await fs.writeFile(project, '{ not json');
  await fs.writeFile(local, JSON.stringify({ permissions: { deny: 'nope', ask: ['Read(a/**)'] } }));
  const out = await loadPermissionSettings({ user, project, local }, { permissions: { deny: ['Bash(rm*)'] }, hooks: { PreToolUse: [] } });
  assert.deepEqual(out.rules.map((r) => `${r.source}:${r.effect}:${r.raw}`).sort(), ['local:ask:Read(a/**)', 'policy:deny:Bash(rm*)', 'user:allow:Bash(npm test*)']);
  assert.equal(out.errors.length, 4);
  assert.ok(out.errors.some((e) => e.includes('invalid JSON')));
  assert.deepEqual(out.hooks, { policy: { PreToolUse: [] }, user: { Stop: [] } });
});

test('loadPermissionSettings: missing files are silent, bad shapes are reported', async () => {
  const dir = await tmpDir();
  assert.deepEqual(await loadPermissionSettings({ user: path.join(dir, 'none.json') }), { rules: [], errors: [], hooks: {} });
  assert.deepEqual(await loadPermissionSettings({}), { rules: [], errors: [], hooks: {} });
  const bad = path.join(dir, 'arr.json');
  await fs.writeFile(bad, '[]');
  assert.equal((await loadPermissionSettings({ user: bad })).errors.length, 1);
  assert.equal((await loadPermissionSettings({ user: dir })).errors.length, 1, 'a directory is an error, not a throw');
  assert.equal((await loadPermissionSettings({}, 'policy')).errors.length, 1);
  await fs.writeFile(bad, '{"permissions":[]}');
  assert.equal((await loadPermissionSettings({ user: bad })).errors.length, 1);
});

// ---------------------------------------------------------------- permissions: precedence

test('precedence: deny beats ask beats allow across every source', () => {
  const rules = [...rulesOf({ allow: ['Bash(git*)'] }, 'policy'), ...rulesOf({ ask: ['Bash(git*)'] }, 'local'), ...rulesOf({ deny: ['Bash(git push*)'] }, 'user')];
  assert.equal(cmd(rules, 'git push origin'), 'deny');
  assert.equal(cmd(rules, 'git status'), 'ask');
  assert.equal(cmd(rulesOf({ allow: ['Bash(git*)'] }), 'git status'), 'allow');
  assert.equal(cmd(rules, 'ls'), undefined);
});

test('precedence: a policy deny or ask cannot be weakened by any other layer', () => {
  const policy = rulesOf({ deny: ['Bash(curl*)'], ask: ['Bash(npm publish*)'] }, 'policy');
  const local = rulesOf({ allow: ['Bash(curl*)', 'Bash(npm publish*)', 'run_command'] }, 'local');
  assert.equal(cmd([...local, ...policy], 'curl x'), 'deny');
  assert.equal(cmd([...local, ...policy], 'npm publish'), 'ask');
  const r = evaluatePermission([...local, ...policy], { tool: 'run_command', args: { command: 'curl x' }, root: '/repo', platform: 'linux' });
  assert.equal(r.rule?.source, 'policy');
  assert.match(r.reason ?? '', /curl/);
});

test('tools: bare names and mcp wildcards', () => {
  const rules = rulesOf({ allow: ['mcp__docs__*', 'mcp__a__b'], deny: ['mcp__evil__*'] });
  const of = (tool: string) => evaluatePermission(rules, { tool, kind: 'meta', args: {}, root: '/repo' }).effect;
  assert.equal(of('mcp__docs__search'), 'allow');
  assert.equal(of('mcp__a__b'), 'allow');
  assert.equal(of('mcp__a__c'), undefined);
  assert.equal(of('mcp__evil__x'), 'deny');
  assert.equal(of('MCP__EVIL__x'), 'deny', 'deny ignores case');
  assert.equal(of('mcp__DOCS__search'), undefined, 'allow is exact');
  assert.equal(cmd(rulesOf({ deny: ['run_command'] }), 'anything'), 'deny');
});

// ---------------------------------------------------------------- permissions: command matching

test('commands: allow requires every segment to match', () => {
  const rules = rulesOf({ allow: ['Bash(npm test*)', 'Bash(git status*)'] });
  assert.equal(cmd(rules, 'npm test'), 'allow');
  assert.equal(cmd(rules, 'npm test && git status'), 'allow');
  for (const c of ['npm test && rm -rf /', 'npm test; rm -rf /', 'npm test || rm -rf /', 'npm test | sh', 'npm test & rm x', 'npm test\nrm -rf /', 'npm test\r\nrm x']) {
    assert.equal(cmd(rules, c), undefined, c);
  }
});

test('commands: deny or ask fires if any segment matches', () => {
  const rules = rulesOf({ deny: ['Bash(rm -rf*)'], ask: ['Bash(git push*)'], allow: ['Bash(npm*)'] });
  for (const c of ['npm i && rm -rf /', 'npm i; rm -rf /', 'npm i || rm -rf /', 'npm i | rm -rf /', 'npm i & rm -rf /', 'npm i\nrm -rf /']) {
    assert.equal(cmd(rules, c), 'deny', c);
  }
  assert.equal(cmd(rules, 'npm i && git push'), 'ask');
});

test('commands: separators inside quotes do not split', () => {
  const rules = rulesOf({ allow: ['Bash(echo *)'], deny: ['Bash(rm*)'] });
  assert.equal(cmd(rules, 'echo "a && rm -rf /"'), 'allow');
  assert.equal(cmd(rules, "echo 'a; rm -rf /'"), 'allow');
  assert.equal(cmd(rules, 'echo "a\nb"'), 'allow');
});

test('commands: substitution and file redirection are never auto-allowed', () => {
  const rules = rulesOf({ allow: ['Bash(echo*)', 'run_command'] });
  for (const c of ['echo $(whoami)', 'echo `whoami`', 'echo "$(whoami)"', 'echo "`whoami`"', 'echo hi > out.txt', 'echo hi >> out.txt', 'echo hi 2> err.log', 'echo hi &> all.log', 'echo <(ls)', 'echo >| f', '(echo hi)']) {
    assert.equal(cmd(rules, c), undefined, c);
  }
});

test('commands: harmless redirections and literal single quotes stay allowed', () => {
  const rules = rulesOf({ allow: ['Bash(npm test)', 'Bash(echo*)'] });
  for (const c of ['npm test 2>&1', 'npm test >/dev/null', 'npm test 2>/dev/null', 'npm test > NUL', 'npm test >$null']) { assert.equal(cmd(rules, c), 'allow', c); }
  assert.equal(cmd(rules, "echo '$(not run)'"), 'allow');
  assert.equal(cmd(rules, "echo 'a > b'"), 'allow');
});

test('commands: deny still sees inside substitutions, subshells and interpreters', () => {
  const rules = rulesOf({ deny: ['Bash(rm -rf*)'] });
  for (const c of ['echo $(rm -rf /)', 'echo `rm -rf /`', 'echo "$(rm -rf /)"', 'echo $(echo $(rm -rf /))', '(rm -rf /)', '{ rm -rf /; }', 'bash -c "rm -rf /"', "sh -c 'rm -rf /'", 'eval "rm -rf /"', 'cmd /c rm -rf /', 'powershell -Command "rm -rf /"', 'if true; then rm -rf /; fi', 'cat <(rm -rf /)']) {
    assert.equal(cmd(rules, c), 'deny', c);
  }
});

test('commands: deny resists quoting, spacing, escapes, wrappers and paths', () => {
  const rules = rulesOf({ deny: ['Bash(rm -rf*)'] });
  for (const c of ['r"m" -rf /', "r'm' -rf /", '"rm" "-rf" /', 'rm    -rf   /', 'rm\t-rf /', '  rm -rf /', 'r\\m -rf /', 'rm \\\n -rf /', 'FOO=1 rm -rf /', 'A=1 B="x y" rm -rf /', 'sudo rm -rf /', 'sudo -u root rm -rf /', 'env rm -rf /', 'env -i rm -rf /', 'command rm -rf /', 'nohup rm -rf /', 'xargs rm -rf /', '/bin/rm -rf /', './rm -rf /', 'r`m -rf /']) {
    assert.equal(cmd(rules, c), 'deny', c);
  }
});

test('commands: windows matching ignores case and handles exe names and caret escapes', () => {
  const rules = rulesOf({ deny: ['Bash(Remove-Item -Recurse*)', 'Bash(rm -rf*)'] });
  for (const c of ['remove-item -recurse x', 'REMOVE-ITEM   -RECURSE x', 'RM -RF /', 'C:\\tools\\rm.exe -rf /', 'r^m -rf /']) {
    assert.equal(cmd(rules, c, 'win32'), 'deny', c);
  }
  assert.equal(cmd(rules, 'RM -RF /', 'linux'), undefined, 'POSIX commands are case-sensitive');
});

test('commands: backslash separators are split for deny and never auto-allowed', () => {
  assert.equal(cmd(rulesOf({ deny: ['Bash(rm*)'] }), 'git status\\;rm x', 'win32'), 'deny');
  assert.equal(cmd(rulesOf({ allow: ['Bash(git status*)'] }), 'git status\\;rm x', 'win32'), undefined);
  assert.equal(cmd(rulesOf({ allow: ['Bash(echo*)'] }), 'echo "a\\" ; rm x'), undefined, 'quote parity differs between shells');
});

test('commands: env prefixes are stripped, but hijacking variables void auto-allow', () => {
  const rules = rulesOf({ allow: ['Bash(npm test*)'] });
  assert.equal(cmd(rules, 'FOO=1 npm test'), 'allow');
  assert.equal(cmd(rules, 'FOO=1 BAR="a b" npm   test'), 'allow');
  for (const c of ['PATH=. npm test', 'LD_PRELOAD=x.so npm test', 'NODE_OPTIONS=--require=./x npm test', 'FOO=1', 'FOO=1; npm test']) {
    assert.equal(cmd(rules, c), undefined, c);
  }
});

test('commands: parser edge cases never throw', () => {
  const rules = rulesOf({ allow: ['Bash(echo*)'], deny: ['Bash(rm*)'] });
  assert.equal(cmd(rules, 'echo "unterminated'), undefined);
  assert.equal(cmd(rules, "echo 'unterminated"), undefined);
  assert.equal(cmd(rules, 'echo $(unterminated'), undefined);
  assert.equal(cmd(rules, 'echo `unterminated'), undefined);
  assert.equal(cmd(rules, ''), undefined);
  assert.equal(cmd(rules, '   ;;; && ||'), undefined);
  assert.equal(cmd(rules, 'echo a;'), 'allow');
  for (const args of [{}, { command: 5 }, null, undefined]) {
    assert.equal(evaluatePermission(rules, { tool: 'run_command', args, root: '/repo' }).effect, undefined);
  }
});

test('commands: pathological input stays fast', () => {
  const rules = rulesOf({ deny: ['Bash(*a*a*a*a*a*b)'], allow: ['Bash(echo*)'] });
  const inputs = ['a'.repeat(50_000), '$('.repeat(5_000), '`'.repeat(5_001), 'a;'.repeat(5_000), '"'.repeat(9_999)];
  const t0 = Date.now();
  for (const c of inputs) { cmd(rules, c); }
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

// ---------------------------------------------------------------- permissions: paths

test('paths: edit rules cover write_file and edit_file, read rules cover the read tools', () => {
  const rules = rulesOf({ deny: ['edit(.env*)', 'read(secrets/**)'] });
  assert.equal(file(rules, 'write_file', '.env'), 'deny');
  assert.equal(file(rules, 'edit_file', '.env.local'), 'deny');
  assert.equal(file(rules, 'read_file', '.env'), undefined, 'edit rules do not affect reads');
  for (const t of ['read_file', 'grep', 'glob_files', 'list_dir']) { assert.equal(file(rules, t, 'secrets/a/b.txt'), 'deny', t); }
  assert.equal(file(rules, 'list_dir', 'secrets'), 'deny', 'the folder itself');
  assert.equal(file(rules, 'grep', undefined), undefined, 'grep without a path arg');
  assert.equal(file(rules, 'write_file', 'secrets/x'), undefined);
});

test('paths: bare-name globs match at any depth', () => {
  const rules = rulesOf({ deny: ['Edit(.env*)'] });
  assert.equal(file(rules, 'edit_file', 'a/b/c/.env.prod'), 'deny');
  assert.equal(file(rules, 'edit_file', 'a/.envrc'), 'deny');
  assert.equal(file(rules, 'edit_file', 'a/b/env'), undefined);
  assert.equal(file(rules, 'edit_file', '.env.d/config'), 'deny', 'deny covers files below a matching folder');
  assert.equal(file(rulesOf({ allow: ['Edit(*.md)'] }), 'edit_file', 'x.md/evil.sh'), undefined, 'allow only looks at the file name');
});

test('paths: traversal and separators are normalised before matching', () => {
  const rules = rulesOf({ deny: ['read(secrets/**)'] });
  for (const p of ['./secrets/a', 'src/../secrets/a', 'secrets//a', 'a/b/../../secrets/a', '/repo/secrets/a']) { assert.equal(file(rules, 'read_file', p), 'deny', p); }
  for (const p of ['src\\..\\secrets\\a', 'SECRETS\\a', 'D:/repo/secrets/a', 'd:\\REPO\\Secrets\\a']) { assert.equal(file(rules, 'read_file', p, 'win32', 'D:\\repo'), 'deny', p); }
  assert.equal(file(rules, 'read_file', 'secrets-old/a'), undefined);
});

test('paths: windows casing, trailing dots and alternate streams cannot evade deny', () => {
  const rules = rulesOf({ deny: ['Edit(.env*)', 'Read(Secrets/**)', 'Edit(config.json)'] });
  for (const p of ['.ENV', 'sub\\.Env.Local', '.env.', '.env ', '.env::$DATA']) { assert.equal(file(rules, 'edit_file', p, 'win32', 'D:\\repo'), 'deny', p); }
  assert.equal(file(rules, 'edit_file', 'CONFIG.JSON::$DATA', 'win32', 'D:\\repo'), 'deny');
  assert.equal(file(rules, 'read_file', 'SECRETS/x', 'win32', 'd:\\REPO'), 'deny');
  assert.equal(file(rules, 'edit_file', '.ENV', 'linux'), undefined, 'POSIX paths are case-sensitive');
});

test('paths: outside the root only absolute rules match', () => {
  const rules = rulesOf({ deny: ['read(secrets/**)', 'read(*.pem)', 'read(/etc/**)'] });
  assert.equal(file(rules, 'read_file', '../other/secrets/a'), undefined);
  assert.equal(file(rules, 'read_file', '/elsewhere/key.pem'), undefined);
  assert.equal(file(rules, 'read_file', '/etc/passwd'), 'deny');
  assert.equal(file(rules, 'read_file', '../../etc/passwd'), 'deny');
  assert.equal(file(rulesOf({ deny: ['Read(C:/Windows/**)'] }), 'read_file', 'c:\\WINDOWS\\system32\\x', 'win32', 'D:\\repo'), 'deny');
  assert.equal(file(rulesOf({ deny: ['Read(../sibling/**)'] }), 'read_file', '../sibling/x'), 'deny');
  assert.equal(file(rulesOf({ allow: ['Read(**)'] }), 'read_file', '../outside'), undefined, 'relative allow cannot reach outside');
});

test('paths: braces, question marks, folders and home expansion', () => {
  assert.equal(file(rulesOf({ deny: ['Edit(src/**/*.{pem,key})'] }), 'edit_file', 'src/a/b.key'), 'deny');
  assert.equal(file(rulesOf({ deny: ['Edit(src/**/*.{pem,key})'] }), 'edit_file', 'src/b.pem'), 'deny');
  assert.equal(file(rulesOf({ deny: ['Edit(src/**/*.{pem,key})'] }), 'edit_file', 'src/b.txt'), undefined);
  assert.equal(file(rulesOf({ deny: ['Edit(a?.txt)'] }), 'edit_file', 'ab.txt'), 'deny');
  assert.equal(file(rulesOf({ deny: ['Read(build/)'] }), 'read_file', 'build/x/y'), 'deny');
  assert.equal(file(rulesOf({ allow: ['Edit(src/*.ts)'] }), 'edit_file', 'src/a/b.ts'), undefined, '* stops at a folder');
});

// ---------------------------------------------------------------- hooks: config

const hook = (command: string, matcher = '', timeout?: number): HookConfig => ({ PreToolUse: [{ matcher, hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }] });

test('parseHooks: accepts valid config and reports every invalid part', () => {
  const ok = parseHooks({ PreToolUse: [{ matcher: 'run_command|edit_file', hooks: [{ type: 'command', command: 'x', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'y' }] }] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.PreToolUse?.[0].hooks[0].timeout, 5);
  assert.equal(ok.config.Stop?.[0].matcher, '');
  const bad = parseHooks({
    Nope: [], Stop: 'x',
    PreToolUse: [5, { matcher: '(', hooks: [] }, { matcher: 3, hooks: [] }, { hooks: 'x' },
      { hooks: [{ type: 'http', command: 'x' }, { type: 'command', command: ' ' }, { type: 'command', command: 'x', timeout: -1 }] }],
  });
  assert.equal(bad.errors.length, 9);
  assert.ok(bad.errors.some((e) => e.includes('valid regex')));
  assert.deepEqual(bad.config, {});
  assert.deepEqual(parseHooks(undefined), { config: {}, errors: [] });
  assert.equal(parseHooks([]).errors.length, 1);
});

test('mergeHooks, hasHooks: concatenate in order and drop exact duplicates', () => {
  const merged = mergeHooks([hook('a'), hook('b', 'x'), hook('a'), { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'c' }] }] }]);
  assert.deepEqual(merged.PreToolUse?.map((m) => m.hooks[0].command), ['a', 'b']);
  assert.ok(hasHooks(merged, 'Stop'));
  assert.ok(!hasHooks(merged, 'Notification'));
  assert.ok(!hasHooks({ Stop: [{ matcher: '', hooks: [] }] }, 'Stop'));
});

test('hooksHash: stable across ordering, sensitive to what runs', () => {
  const a: HookConfig = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'a' }] }], PreToolUse: hook('b').PreToolUse };
  const b: HookConfig = { PreToolUse: hook('b').PreToolUse, Stop: [{ hooks: [{ command: 'a', type: 'command' }], matcher: '' }] };
  assert.equal(hooksHash(a), hooksHash(b));
  assert.match(hooksHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hooksHash(hook('a')), hooksHash(hook('b')));
  assert.notEqual(hooksHash(hook('a', 'x')), hooksHash(hook('a', 'y')));
  assert.notEqual(hooksHash(hook('a', '', 5)), hooksHash(hook('a', '', 6)));
});

// ---------------------------------------------------------------- hooks: execution

/** Runs the hook's command string as a node script, so tests do not depend on a shell. */
const nodeHook: HookSpawnFn = (file, args, options) => {
  if (file === 'taskkill') { return spawn(file, args, options); }
  return spawn(process.execPath, ['-e', args[args.length - 1].replace(/\nif \(\$LASTEXITCODE\).*$/, '')], options);
};
const opts = (extra: object = {}) => ({ cwd: process.cwd(), spawnFn: nodeHook, ...extra });
const script = (code: string, event: keyof HookConfig = 'PreToolUse', matcher = '', timeout?: number): HookConfig =>
  ({ [event]: [{ matcher, hooks: [{ type: 'command', command: code, ...(timeout ? { timeout } : {}) }] }] });

test('runHooks: zero hooks returns at once and spawns nothing', async () => {
  let spawned = 0;
  const spawnFn: HookSpawnFn = (f, a, o) => { spawned++; return nodeHook(f, a, o); };
  assert.deepEqual(await runHooks('Stop', {}, {}, { cwd: '.', spawnFn }), { blocked: false, context: [], results: [] });
  await runHooks('PreToolUse', { tool_name: 'read_file' }, script('1', 'PreToolUse', '^run_command$'), { cwd: '.', spawnFn });
  assert.equal(spawned, 0);
});

test('runHooks: matcher is a regex; empty and * match everything', async () => {
  const code = 'process.exit(0)';
  const ran = async (matcher: string, tool: string) => (await runHooks('PreToolUse', { tool_name: tool }, script(code, 'PreToolUse', matcher), opts())).results.length;
  assert.equal(await ran('run_command|edit_file', 'edit_file'), 1);
  assert.equal(await ran('run_command|edit_file', 'read_file'), 0);
  assert.equal(await ran('', 'x'), 1);
  assert.equal(await ran('*', 'x'), 1);
  assert.equal(await ran('^mcp__', 'mcp__a__b'), 1);
});

test('runHooks: payload arrives as JSON on stdin, stdout becomes context', async () => {
  const code = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.hook_event_name+':'+j.tool_name)})`;
  const r = await runHooks('PreToolUse', { tool_name: 'grep' }, script(code), opts());
  assert.deepEqual(r.context, ['PreToolUse:grep']);
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].code, 0);
  assert.equal(r.results[0].timedOut, false);
});

test('runHooks: exit 2 blocks with stderr as the reason', async () => {
  const r = await runHooks('PreToolUse', { tool_name: 'x' }, script(`console.error('nope');process.exit(2)`), opts());
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'nope');
  for (const ev of ['UserPromptSubmit', 'Stop'] as const) {
    assert.equal((await runHooks(ev, {}, script('process.exit(2)', ev), opts())).blocked, true, ev);
  }
});

test('runHooks: only PreToolUse, UserPromptSubmit and Stop can block', async () => {
  for (const ev of ['PostToolUse', 'SubagentStop', 'Notification'] as const) {
    const r = await runHooks(ev, {}, script(`console.log('{"decision":"block"}');process.exit(2)`, ev), opts());
    assert.equal(r.blocked, false, ev);
    assert.equal(r.results[0].code, 2);
  }
});

test('runHooks: JSON decision blocks, other JSON adds context', async () => {
  const r = await runHooks('Stop', {}, script(`console.log(JSON.stringify({decision:'block',reason:'keep going'}))`, 'Stop'), opts());
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'keep going');
  const c = await runHooks('UserPromptSubmit', {}, script(`console.log(JSON.stringify({additionalContext:'hello'}))`, 'UserPromptSubmit'), opts());
  assert.deepEqual(c.context, ['hello']);
  assert.equal(c.blocked, false);
});

test('runHooks: other non-zero exits are reported, never blocking', async () => {
  const r = await runHooks('PreToolUse', {}, script(`console.log('partial');console.error('boom');process.exit(3)`), opts());
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].code, 3);
  assert.match(r.results[0].stderr, /boom/);
  assert.deepEqual(r.context, []);
});

test('runHooks: hooks for one event run in parallel', async () => {
  const code = `setTimeout(()=>{},400)`;
  const cfg: HookConfig = { Stop: [{ matcher: '', hooks: [1, 2, 3, 4].map((n) => ({ type: 'command' as const, command: `${code}//${n}` })) }] };
  const solo = (await runHooks('Stop', {}, script(code, 'Stop'), opts())).results[0].ms;
  const t0 = Date.now();
  const r = await runHooks('Stop', {}, cfg, opts());
  assert.equal(r.results.length, 4);
  assert.ok(Date.now() - t0 < solo * 3, `parallel took ${Date.now() - t0}ms, one hook takes ${solo}ms`);
});

test('runHooks: output is capped at 64KB per stream', async () => {
  const r = await runHooks('Stop', {}, script(`process.stdout.write('x'.repeat(300000));process.stderr.write('y'.repeat(300000))`, 'Stop'), opts());
  assert.equal(r.results[0].stdout.length, 64 * 1024);
  assert.equal(r.results[0].stderr.length, 64 * 1024);
});

test('runHooks: timeout kills the process and does not block', async () => {
  const r = await runHooks('PreToolUse', {}, script(`console.error('x');setInterval(()=>{},1000)`, 'PreToolUse', '', 0.4), opts());
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].timedOut, true);
  assert.ok(r.results[0].ms < 8000, `took ${r.results[0].ms}ms`);
});

test('runHooks: timeout kills the whole process tree', async () => {
  const dir = await tmpDir();
  const marker = path.join(dir, 'alive.txt').replace(/\\/g, '/');
  const grandchild = `setTimeout(()=>require('fs').writeFileSync('${marker}','x'),1500)`;
  const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  await runHooks('PreToolUse', {}, script(code, 'PreToolUse', '', 0.6), opts({ spawnFn: (f: string, a: string[], o: any) => nodeHook(f, a, { ...o, detached: process.platform !== 'win32' }) }));
  await new Promise((r) => setTimeout(r, 1800));
  await assert.rejects(fs.access(marker), 'grandchild must be dead');
});

test('runHooks: abort kills running hooks and never blocks', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const r = await runHooks('PreToolUse', {}, script(`console.error('x');process.exitCode=2;setInterval(()=>{},1000)`), opts({ signal: ac.signal }));
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].timedOut, false);
  assert.ok(Date.now() - t0 < 8000);
  let spawned = 0;
  await runHooks('PreToolUse', {}, script('1'), { cwd: '.', signal: ac.signal, spawnFn: (f, a, o) => { spawned++; return nodeHook(f, a, o); } });
  assert.equal(spawned, 0, 'an already aborted signal spawns nothing');
});

test('runHooks: a hook that ignores stdin does not cause EPIPE failures', async () => {
  const big = { tool_name: 't', blob: 'x'.repeat(2_000_000) };
  const r = await runHooks('PreToolUse', big, script('process.exit(0)'), opts());
  assert.equal(r.results[0].code, 0);
});

test('runHooks: spawn failures are reported without blocking', async () => {
  const r = await runHooks('PreToolUse', {}, script('1'), { cwd: '.', spawnFn: () => { throw new Error('no shell'); } });
  assert.equal(r.blocked, false);
  assert.equal(r.results[0].code, null);
  assert.match(r.results[0].stderr, /no shell/);
  const missing = await runHooks('PreToolUse', {}, script('1'), { cwd: '.', spawnFn: (_f, a, o) => spawn('definitely-not-a-binary-xyz', a, o) });
  assert.equal(missing.blocked, false);
  assert.match(missing.results[0].stderr, /ENOENT/);
});

test('runHooks: real shell forwards exit codes and stdin', { skip: process.platform !== 'win32' }, async () => {
  const blocked = await runHooks('PreToolUse', {}, hook(`[Console]::Error.WriteLine('stop'); exit 2`), { cwd: process.cwd() });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'stop');
  const native = await runHooks('PreToolUse', {}, hook(`& "${process.execPath}" -e "process.exit(2)"`), { cwd: process.cwd() });
  assert.equal(native.results[0].code, 2, 'native exit codes survive powershell');
  assert.equal(native.blocked, true);
  const ok = await runHooks('PreToolUse', { tool_name: 'zed' }, hook(`$input | Out-String`), { cwd: process.cwd() });
  assert.match(ok.results[0].stdout, /"tool_name":"zed"/);
});

// ---------------------------------------------------------------- redaction

test('redact: detects every supported kind', () => {
  const cases: Array<[string, string, string]> = [
    ['aws_access_key', `key ${fake.aws} end`, fake.aws],
    ['aws_secret', `aws_secret_access_key = ${fake.awsSecret}`, fake.awsSecret],
    ['github', `t=${fake.github}`, fake.github],
    ['github', fake.githubPat, fake.githubPat],
    ['gitlab', `x ${fake.gitlab}`, fake.gitlab],
    ['slack', `x ${fake.slack}`, fake.slack],
    ['stripe', `x ${fake.stripe}`, fake.stripe],
    ['google', `x ${fake.google}`, fake.google],
    ['azure', `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${fake.azure};EndpointSuffix=core`, fake.azure],
    ['npm', `//registry/:x ${fake.npm}`, fake.npm],
    ['jwt', `jwt ${fake.jwt} end`, fake.jwt],
    ['private_key', `before\n${fake.pem}\nafter`, fake.pem],
    ['auth_header', 'Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789'],
    ['auth_header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['url_password', 'postgres://admin:s3cr3tPass@db.internal:5432/app', 's3cr3tPass'],
    ['conn_password', 'Server=db;Database=app;User Id=sa;Password=Pa55w0rd!;', 'Pa55w0rd!'],
    ['generic', 'password = "hunter2xyz"', 'hunter2xyz'],
    ['generic', "api_key: 'k3y-98f7a6b5'", 'k3y-98f7a6b5'],
    ['generic', 'CLIENT_SECRET=a8f5f167f44f4964e6c998dee827110c', 'a8f5f167f44f4964e6c998dee827110c'],
    ['generic', '"apikey": "Zx9_qW3-rT5y"', 'Zx9_qW3-rT5y'],
    ['generic', 'passwd=Tr0ub4dor3x', 'Tr0ub4dor3x'],
    ['generic', 'const token: string = "abc123XYZ789"', 'abc123XYZ789'],
  ];
  for (const [kind, input, secret] of cases) {
    const v = new SecretVault();
    const r = v.redact(input);
    assert.ok(!r.text.includes(secret), `${kind} leaked: ${r.text}`);
    assert.ok(r.kinds.includes(kind), `${kind} not reported for ${input}: ${r.kinds}`);
    assert.equal(v.restore(r.text), input);
  }
  assert.ok(DETECTORS.length >= 15);
});

test('redact: url credentials keep the user and host', () => {
  const r = new SecretVault().redact('mongodb+srv://bob:pw12345@cluster0.example.net/db');
  assert.match(r.text, /^mongodb\+srv:\/\/bob:‹secret:url_password:1›@cluster0\.example\.net\/db$/);
});

test('redact: multi-line and truncated PEM blocks are masked whole', () => {
  const v = new SecretVault();
  const r = v.redact(`a\n${fake.pem}\nb`);
  assert.match(r.text, /^a\n‹secret:private_key:1›\nb$/);
  const truncated = fake.pem.split('\n').slice(0, 3).join('\n');
  const t = v.redact(truncated);
  assert.ok(!t.text.includes('MIIEpAIB'));
  assert.equal(v.restore(t.text), truncated);
});

test('redact: same secret gets the same number, different secrets differ', () => {
  const v = new SecretVault();
  const a = v.redact(`${fake.github} and ${fake.github}`);
  assert.equal(a.count, 2);
  assert.equal(a.text, '‹secret:github:1› and ‹secret:github:1›');
  assert.equal(v.size, 1);
  assert.equal(v.redact(`again ${fake.github}`).text, 'again ‹secret:github:1›');
  assert.equal(v.redact(fake.gitlab).text, '‹secret:gitlab:2›');
  assert.equal(v.size, 2);
  assert.equal(new SecretVault().redact(fake.gitlab).text, '‹secret:gitlab:1›', 'vaults are independent');
});

test('redact: round trip supports edit_file old_string and new_string', () => {
  const v = new SecretVault();
  const source = `const a = "${fake.stripe}";\nconst pw = "hunter2xyz";\n`;
  const masked = v.redact(source).text;
  assert.ok(!masked.includes(fake.stripe));
  const oldString = masked.split('\n')[0];
  const newString = oldString.replace('const a', 'const b');
  assert.equal(source.replace(v.restore(oldString), v.restore(newString)), source.replace('const a', 'const b'));
  const dollar = new SecretVault();
  const tricky = 'password = "pa$&ss$1word"';
  assert.equal(dollar.restore(dollar.redact(tricky).text), tricky, 'replacement patterns stay literal');
});

test('redact: is idempotent on masked text', () => {
  const v = new SecretVault();
  const once = v.redact(`password = "hunter2xyz" url=https://u:pa55word1@h/ ${fake.jwt}`);
  const twice = v.redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.count, 0);
  assert.equal(v.size, 3);
});

test('redact: unknown placeholders are detected', () => {
  const a = new SecretVault();
  const masked = a.redact(fake.github).text;
  assert.equal(a.hasUnknownPlaceholder(masked), false);
  assert.equal(a.hasUnknownPlaceholder('plain text'), false);
  const restarted = new SecretVault();
  assert.equal(restarted.hasUnknownPlaceholder(masked), true);
  assert.equal(restarted.restore(masked), masked, 'unknown placeholders stay intact');
  assert.equal(a.hasUnknownPlaceholder(`${masked} ‹secret:github:99›`), true);
  assert.equal(a.hasUnknownPlaceholder('‹secret:Bad Kind:1›'), false, 'not the placeholder format');
});

test('redact: false positives are left alone', () => {
  const clean = [
    'password = ${DB_PASSWORD}', 'password: ${VAR}', 'token = "$TOKEN"', 'secret = process.env.SECRET', 'api_key = os.environ["KEY"]',
    'password = "<password>"', 'password: <password>', 'password = "changeme"', 'password=change_me', 'password = "example"',
    'api_key = "your-api-key"', 'token = "xxxxxxxx"', 'password = "********"', 'password = ""', "secret = ''",
    'password: true', 'token = false', 'token: 12345678', 'secret = 3.14', 'password: string', 'token: String', 'password?: string',
    'secret: number', 'password: str', 'function login(password: string, token: string) {}', 'interface A { apiKey: string; token: string | null }',
    'const password = getPassword();', 'token = req.headers.authorization', 'secret = config.auth.secret', 'password = self.password', 'token = None', 'password = null',
    'commit 3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b', 'id 123e4567-e89b-12d3-a456-426614174000', 'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'max_tokens = 4096', 'tokens: 1200', 'tokenizer = "gpt2-large"', 'https://example.com:8080/path', 'http://localhost:3000/a@b',
    'Bearer authentication is required', 'Authorization: Bearer ${TOKEN}', 'Authorization: Bearer <token>', 'token: "Invalid token provided"', 'password: "Enter your password"',
    'postgres://user:${DB_PASS}@host/db', 'postgres://user:<password>@host/db', 'AWS key AKIAIOSFODNN7EXAMPLE', 'mailto:someone@example.com',
    'Server=db;Password=${DB_PASSWORD};', 'const x = a ? b : c;', 'secret: "./secrets/prod.json"',
  ];
  for (const s of clean) {
    const v = new SecretVault();
    const r = v.redact(s);
    assert.equal(r.text, s, `false positive: ${s}`);
    assert.equal(r.count, 0);
  }
});

test('redactMessages: covers content and tool arguments with new objects', () => {
  const v = new SecretVault();
  const args = JSON.stringify({ path: 'a.env', content: `TOKEN=${fake.github}`, password: 'hunter2xyz', nested: [{ api_key: 'abc123XYZ789' }] });
  const input: ChatMessage[] = [
    { role: 'system', content: `s ${fake.gitlab}` },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: args } }] },
    { role: 'tool', content: `out ${fake.npm}`, tool_call_id: '1', display: 'ui' },
  ];
  const snapshot = JSON.stringify(input);
  const out = redactMessages(input, v);
  assert.equal(JSON.stringify(input), snapshot, 'input is not mutated');
  assert.notEqual(out[0], input[0]);
  assert.notEqual(out[1].tool_calls![0], input[1].tool_calls![0]);
  const text = JSON.stringify(out);
  for (const s of [fake.github, fake.gitlab, fake.npm, 'hunter2xyz', 'abc123XYZ789']) { assert.ok(!text.includes(s), s); }
  const masked = JSON.parse(out[1].tool_calls![0].function.arguments);
  assert.equal(masked.path, 'a.env');
  assert.deepEqual(JSON.parse(v.restoreJson(out[1].tool_calls![0].function.arguments)), JSON.parse(args));
  assert.equal(out[2].tool_call_id, '1');
  assert.equal(out[1].content, null);
  assert.deepEqual(redactMessages(out, v), out, 'idempotent');
});

test('redactMessages: multi-line secrets in arguments stay valid JSON and round trip', () => {
  const v = new SecretVault();
  const args = JSON.stringify({ content: `x\n${fake.pem}\ny` });
  const [m] = redactMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'w', arguments: args } }] }], v);
  const out = m.tool_calls![0].function.arguments;
  assert.ok(!out.includes('MIIEpAIB'));
  assert.equal(JSON.parse(v.restoreJson(out)).content, `x\n${fake.pem}\ny`);
  const broken = redactMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'w', arguments: `{bad ${fake.github}` } }] }], v);
  assert.ok(!broken[0].tool_calls![0].function.arguments.includes(fake.github), 'unparsable arguments are masked as text');
});

// The 2MB redact timing test lives in test/slow/perf.test.ts: it runs on its own so a busy suite cannot starve it.

// ---------------------------------------------------------------- audit

const entry = (detail: string, sessionId = 's1'): Omit<AuditEntry, 'at'> => ({ sessionId, agentId: 'main', kind: 'tool', tool: 'grep', detail });

test('audit: appends and reads back in order', async () => {
  const log = new AuditLog(path.join(await tmpDir(), 'nested', 'audit'));
  log.append({ ...entry('one'), outcome: 'ok', ruleRaw: 'Bash(x)', ms: 12 });
  log.append(entry('two'));
  await log.flush();
  const rows = await log.read('s1');
  assert.deepEqual(rows.map((r) => r.detail), ['one', 'two']);
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].ms, 12);
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)));
  assert.deepEqual((await log.read('s1', { limit: 1 })).map((r) => r.detail), ['two']);
  assert.deepEqual(await log.read('s1', { limit: 0 }), []);
  assert.deepEqual(await log.read('missing'), []);
});

test('audit: one file per session, invalid ids are dropped without throwing', async () => {
  const dir = await tmpDir();
  const log = new AuditLog(dir);
  log.append(entry('a', 'alpha'));
  log.append(entry('b', 'beta-2'));
  for (const bad of ['../evil', 'a/b', 'a b', '', 'x'.repeat(65), 'CON', 'nul', 'a\n']) { log.append(entry('x', bad)); }
  log.append(null as any);
  log.append({} as any);
  await log.flush();
  assert.deepEqual((await fs.readdir(dir)).sort(), ['alpha.jsonl', 'beta-2.jsonl']);
  assert.deepEqual(await log.read('../evil'), []);
});

test('audit: details are redacted, then clipped to 2000 characters', async () => {
  const v = new SecretVault();
  const log = new AuditLog(await tmpDir(), { redact: (s) => v.redact(s).text });
  log.append(entry(`run with ${fake.github}`));
  log.append(entry('z'.repeat(5000)));
  const rows = await log.read('s1');
  assert.ok(!rows[0].detail.includes(fake.github));
  assert.match(rows[0].detail, /‹secret:github:1›/);
  assert.equal(rows[1].detail.length, 2000);
});

test('audit: a failing redactor fails closed', async () => {
  const log = new AuditLog(await tmpDir(), { redact: () => { throw new Error('bad'); } });
  log.append(entry('top secret'));
  assert.equal((await log.read('s1'))[0].detail, '[redaction failed]');
});

test('audit: rotates by size and keeps at most maxFiles', async () => {
  const dir = await tmpDir();
  const log = new AuditLog(dir, { maxBytes: 1000, maxFiles: 3 });
  for (let i = 0; i < 200; i++) { log.append(entry(`entry-${i}-${'p'.repeat(40)}`)); }
  await log.flush();
  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ['s1.1.jsonl', 's1.2.jsonl', 's1.jsonl']);
  for (const f of files) { assert.ok((await fs.stat(path.join(dir, f))).size <= 1000, f); }
  const rows = await log.read('s1');
  assert.ok(rows.length > 0 && rows.length < 200);
  assert.match(rows[rows.length - 1].detail, /^entry-199-/);
  const nums = rows.map((r) => Number(r.detail.split('-')[1]));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'oldest first across rotated files');
});

test('audit: maxFiles of one simply truncates', async () => {
  const dir = await tmpDir();
  const log = new AuditLog(dir, { maxBytes: 300, maxFiles: 1 });
  for (let i = 0; i < 30; i++) { log.append(entry(`n${i}`)); }
  await log.flush();
  assert.deepEqual(await fs.readdir(dir), ['s1.jsonl']);
});

test('audit: concurrent appends and flushes lose nothing and keep order', async () => {
  const dir = await tmpDir();
  const log = new AuditLog(dir);
  await Promise.all(Array.from({ length: 500 }, async (_, i) => {
    log.append(entry(String(i), `s${i % 3}`));
    if (i % 50 === 0) { await log.flush(); }
  }));
  await log.flush();
  let total = 0;
  for (const s of ['s0', 's1', 's2']) {
    const rows = await log.read(s);
    total += rows.length;
    const nums = rows.map((r) => Number(r.detail));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), s);
  }
  assert.equal(total, 500);
  for (const f of await fs.readdir(dir)) {
    for (const line of (await fs.readFile(path.join(dir, f), 'utf8')).trim().split('\n')) { JSON.parse(line); }
  }
});

test('audit: tolerates a corrupt trailing line and keeps appending cleanly', async () => {
  const dir = await tmpDir();
  const good = JSON.stringify({ at: '2026-01-01T00:00:00Z', sessionId: 's1', agentId: 'm', kind: 'tool', detail: 'ok' });
  await fs.writeFile(path.join(dir, 's1.jsonl'), `${good}\n{"at":"2026-01-01T00:00:01Z","sess`);
  const log = new AuditLog(dir);
  assert.deepEqual((await log.read('s1')).map((r) => r.detail), ['ok']);
  log.append(entry('after'));
  assert.deepEqual((await log.read('s1')).map((r) => r.detail), ['ok', 'after']);
});

test('audit: unwritable directories never throw', async () => {
  const dir = await tmpDir();
  const blocker = path.join(dir, 'file');
  await fs.writeFile(blocker, 'x');
  const log = new AuditLog(path.join(blocker, 'sub'));
  log.append(entry('x'));
  await log.flush();
  assert.deepEqual(await log.read('s1'), []);
});

test('audit: csv quotes fields and neutralises formulas', () => {
  const log = new AuditLog('unused');
  const csv = log.toCsv([
    { at: 't', sessionId: 's', agentId: 'a', kind: 'tool', detail: 'say "hi", ok\nnext', ms: 5 },
    { at: 't', sessionId: 's', agentId: 'a', kind: 'hook', tool: '=cmd()', detail: '@x' },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'at,sessionId,agentId,kind,tool,detail,outcome,ruleRaw,ms');
  assert.equal(lines[1], 't,s,a,tool,,"say ""hi"", ok\nnext",,,5');
  assert.equal(lines[2], "t,s,a,hook,'=cmd(),'@x,,,");
  assert.equal(log.toCsv([]), 'at,sessionId,agentId,kind,tool,detail,outcome,ruleRaw,ms\r\n');
});

test('safety modules do not import vscode', async () => {
  for (const f of ['permissions', 'hooks', 'redact', 'audit']) {
    const src = await fs.readFile(path.join(__dirname, '..', 'core', `${f}.js`), 'utf8');
    assert.ok(!/require\("vscode"\)/.test(src), f);
  }
});
