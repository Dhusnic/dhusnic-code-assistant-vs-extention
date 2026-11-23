/**
 * Repo map refinement with language-server symbols (core/repoMap.ts `SymbolProvider`, `defsFromSymbols`): the
 * mapping from document symbols, preference over the regexes, fallback on throw/timeout/empty answers, caching by
 * size and mtime, only the shown files of weak-regex languages are asked about, the prompt section never waits for
 * it, and the rendered text is stable once refined. Fake providers on temporary folders; no network, no vscode.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LsSymbol, RepoMap, RepoMaps, SymbolProvider, defsFromSymbols } from '../core/repoMap';
import { FileIndex } from '../core/search';
import { tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('repomap-ls-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

const sym = (name: string, kind: string, line?: string, children?: LsSymbol[]): LsSymbol => ({ name, kind, line, children });

/** A provider that answers from a table keyed by file name and records the files it was asked about. */
function fake(answer: (rel: string) => LsSymbol[] | undefined | Promise<LsSymbol[] | undefined>): SymbolProvider & { asked: string[] } {
  const asked: string[] = [];
  const fn: SymbolProvider = async (abs) => { const rel = path.basename(abs); asked.push(rel); return answer(rel); };
  return Object.assign(fn, { asked });
}

// The regex does not see interface methods and drops package-private and annotated multi-line declarations.
const JAVA = `package a;
public class UserService {
    private final Repo repo;
    public UserService(Repo repo) { this.repo = repo; }
    public User findUser(long id) { return repo.find(id); }
    private void hidden() {}
}
`;
const JAVA_SYMBOLS = [
  sym('a', 'Package', 'package a;'),
  sym('UserService', 'Class', 'public class UserService {', [
    sym('repo', 'Field', '    private final Repo repo;'),
    sym('UserService(Repo)', 'Constructor', '    public UserService(Repo repo) { this.repo = repo; }'),
    sym('findUser(long)', 'Method', '    public User findUser(long id) { return repo.find(id); }'),
    sym('hidden()', 'Method', '    private void hidden() {}'),
    sym('Page', 'Class', '    public static class Page {', [sym('next()', 'Method', '        public Page next() {')]),
  ]),
  sym('Repo', 'Interface', 'interface Repo {', [sym('find(long)', 'Method', '    User find(long id);')]),
];

test('repoMap LS: document symbols map to the same kinds and visibility rules as the regexes', () => {
  assert.deepEqual(defsFromSymbols('src/UserService.java', JAVA_SYMBOLS).map((d) => d.label),
    ['class UserService', 'findUser()', 'class Page', 'next()', 'interface Repo', 'find()']);

  const go = defsFromSymbols('srv/main.go', [
    sym('Server', 'Struct', 'type Server struct {', [sym('addr', 'Field', '\taddr string')]),
    sym('ID', 'Class', 'type ID string'),
    sym('(*Server).Start', 'Method', 'func (s *Server) Start() error { return nil }'),
    sym('NewServer', 'Function', 'func NewServer(addr string) *Server { return nil }'),
    sym('helper', 'Function', 'func helper() {}'),
    sym('Version', 'Constant', 'const Version = "1"'),
  ]);
  assert.deepEqual(go.map((d) => d.label), ['type Server', 'type ID', 'Server.Start()', 'NewServer()', 'helper()']);
  assert.deepEqual(go.map((d) => d.kind), ['class', 'type', 'method', 'function', 'function']);
  assert.deepEqual(go.filter((d) => d.local).map((d) => d.name), ['helper']);

  assert.deepEqual(defsFromSymbols('Svc.cs', [
    sym('A', 'Namespace', 'namespace A {', [
      sym('OrderService', 'Class', '  public sealed class OrderService {', [
        sym('GetOrder(int)', 'Method', '  public async Task<Order> GetOrder(int id) { return null; }'),
        sym('Hidden()', 'Method', '  void Hidden() {}'),
        sym('Name', 'Property', '  public string Name { get; set; }'),
      ]),
      sym('IOrders', 'Interface', '  public interface IOrders {', [sym('Count()', 'Method', '    int Count();')]),
      sym('Inner', 'Class', '  private class Inner {'),
    ]),
  ]).map((d) => d.label), ['class OrderService', 'GetOrder()', 'interface IOrders', 'Count()']);

  assert.deepEqual(defsFromSymbols('src/Main.kt', [
    sym('Point', 'Class', 'data class Point(val x: Int) {', [
      sym('norm', 'Method', '    fun norm(): Int = x'),
      sym('secret', 'Method', '    private fun secret() {}'),
    ]),
    sym('Registry', 'Object', 'object Registry'),
    sym('main', 'Function', 'fun main() {}'),
    sym('hidden', 'Function', 'private fun hidden() {}'),
  ]).map((d) => d.label), ['class Point', 'norm()', 'object Registry', 'main()']);

  // Odd answers are skipped, not thrown on.
  assert.deepEqual(defsFromSymbols('x.java', [sym('<lambda>', 'Function'), sym('', 'Class'), { kind: 'Class' } as LsSymbol]), []);
  assert.deepEqual(defsFromSymbols('README.md', JAVA_SYMBOLS), []);
});

test('repoMap LS: provider definitions are preferred over the regexes, from the next render on, and the text is then stable', async () => {
  const root = await repo({ 'src/UserService.java': JAVA, 'src/app.ts': 'export function start() {}\n' });
  const provider = fake((rel) => (rel === 'UserService.java' ? JAVA_SYMBOLS : undefined));
  const map = new RepoMap(root, new FileIndex(root), { symbols: () => provider });
  await map.refresh();
  const first = map.render();
  assert.match(first, /src\/UserService\.java: class UserService, findUser\(\)$/m);
  await map.refinement();
  // Only the weak-regex language is asked about; TypeScript keeps its regexes.
  assert.deepEqual(provider.asked, ['UserService.java']);
  const refined = map.render();
  assert.match(refined, /src\/UserService\.java: .*interface Repo/m);
  assert.match(refined, /find\(\)/);
  await map.refinement();
  await map.refresh();
  assert.equal(map.render(), refined, 'unchanged files render the same text');
  assert.equal(provider.asked.length, 1, 'cached: no new call');
});

test('repoMap LS: a throw, a timeout or an empty answer keeps the regex definitions', async () => {
  const root = await repo({ 'a/Thrower.java': JAVA, 'b/Slow.java': JAVA, 'c/Empty.java': JAVA });
  const provider = fake((rel) => {
    if (rel === 'Thrower.java') { throw new Error('server crashed'); }
    if (rel === 'Slow.java') { return new Promise<undefined>(() => {}); }
    return [];
  });
  const map = new RepoMap(root, new FileIndex(root), { symbols: () => provider, lsCallMs: 30 });
  await map.refresh();
  const before = map.render();
  await map.refinement();
  assert.equal(provider.asked.length, 3);
  assert.equal(map.render(), before);
  await map.refinement();
  assert.doesNotMatch(map.render(), /interface Repo|class Page/);
  // A language whose server only fails is paused instead of being asked about every file again.
  for (let i = 0; i < 5; i++) { map.render(); await map.refinement(); }
  assert.equal(provider.asked.length, 3);
});

test('repoMap LS: a provider that never answers does not delay the prompt section', async () => {
  const root = await repo({ 'src/Main.java': 'public class Main {\n    public static void run() {}\n}\n' });
  const provider = fake(() => new Promise<undefined>(() => {}));
  const maps = new RepoMaps((r) => new FileIndex(r), { symbolsFor: () => provider });
  await maps.get(root).refresh();
  const t0 = Date.now();
  const section = await maps.promptSection(root, { timeoutMs: 200 });
  assert.ok(Date.now() - t0 < 150, `${Date.now() - t0} ms`);
  assert.match(section, /src\/Main\.java: class Main, run\(\)/);
  assert.deepEqual(provider.asked, ['Main.java'], 'the background pass started');
  // Turned off (setting or no workspace folder): no calls at all.
  const offMaps = new RepoMaps((r) => new FileIndex(r), { symbolsFor: () => undefined });
  await offMaps.promptSection(root);
  await offMaps.get(root).refinement();
  assert.equal(offMaps.get(root).lsCalls, 0);
});

test('repoMap LS: results are cached by size and mtime; a changed file is asked about again', async () => {
  const root = await repo({ 'Svc.java': JAVA });
  let version = 1;
  const provider = fake(() => [sym(`Service${version}`, 'Class', `public class Service${version} {`)]);
  const map = new RepoMap(root, new FileIndex(root, 0), { symbols: () => provider });
  await map.refresh();
  map.render();
  await map.refinement();
  assert.match(map.render(), /Svc\.java: class Service1/);
  await map.refinement();
  await map.refresh();
  map.render();
  await map.refinement();
  assert.equal(provider.asked.length, 1);
  version = 2;
  await fs.writeFile(path.join(root, 'Svc.java'), `${JAVA}\n// changed\n`);
  await map.refresh();
  assert.match(map.render(), /Svc\.java: class UserService/, 'the regexes cover the new version until the server answers');
  await map.refinement();
  assert.equal(provider.asked.length, 2);
  assert.match(map.render(), /Svc\.java: class Service2/);
});

test('repoMap LS: only the files the render showed are refined, at most 60 per pass', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 150; i++) { files[`pkg/m${i}/Service${i}.java`] = `public class Service${i} {\n    public void handle${i}() {}\n}\n`; }
  const root = await repo(files);
  const provider = fake((rel) => [sym(rel.replace('.java', ''), 'Class', `public class ${rel.replace('.java', '')} {`)]);
  const map = new RepoMap(root, new FileIndex(root), { symbols: () => provider });
  await map.refresh();
  const out = map.render({ budgetTokens: 300, forPrompt: true });
  const shown = out.split('\n').filter((l) => /^pkg\/.*: /.test(l)).map((l) => path.basename(l.slice(0, l.indexOf(':'))));
  await map.refinement();
  assert.ok(shown.length > 0 && shown.length < 60, String(shown.length));
  assert.deepEqual([...provider.asked].sort(), [...shown].sort());
  // The tool's larger render shows more files, but one pass asks about at most 60.
  map.render({ budgetTokens: 50_000 });
  await map.refinement();
  assert.equal(provider.asked.length, shown.length + 60);
});
