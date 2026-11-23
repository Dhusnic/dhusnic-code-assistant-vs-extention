/**
 * Repo map (core/repoMap.ts): per-language symbol extraction, ranking, the token budget, ignored folders, the
 * repo_map tool with a path, incremental cache invalidation, the time-boxed prompt section and its place in the
 * agent's system prompt. Everything runs on temporary folders; no network.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RepoMap, RepoMaps, extractSymbols, repoMapTool } from '../core/repoMap';
import { FileIndex } from '../core/search';
import { Agent } from '../core/agent';
import { fakeLlm, recordingUi, text, tmpDir } from './helpers';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tmpDir('repomap-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}
const labels = (file: string, src: string): string[] => extractSymbols(file, src).map((d) => d.label);
const ctxFor = (root: string) => ({ root, signal: new AbortController().signal, snapshot: async () => {} });

test('repoMap: TypeScript/JavaScript definitions, public class methods only, no calls inside bodies', () => {
  const src = `import x from 'y';
export function alpha(a: number): number { return a; }
export async function beta() {}
export default class Agent extends Base {
  private secret = 1;
  constructor(readonly deps: Deps) { super(); }
  async send(text: string): Promise<void> {
    helper(text);
    if (text) { return; }
  }
  static create<T>(o: T): Agent { return new Agent(o as any); }
  private hidden(): void {}
  #priv() {}
}
export interface Deps { a: string }
export type Mode = 'a' | 'b';
export const enum Color { Red }
export const run = async (x: number) => x;
export const LIMIT = 5;
function localHelper() {}
const notShown = 1;
`;
  assert.deepEqual(labels('src/agent.ts', src), [
    'alpha()', 'beta()', 'class Agent', 'send()', 'create()', 'interface Deps', 'type Mode', 'enum Color', 'run()', 'LIMIT', 'localHelper()',
  ]);
  const local = extractSymbols('src/agent.ts', src).filter((d) => d.local).map((d) => d.name);
  assert.deepEqual(local, ['localHelper']);
});

test('repoMap: Python, Go, Rust definitions', () => {
  assert.deepEqual(labels('app/models.py', `import os

class User(Base):
    def __init__(self):
        pass

    def save(self):
        def inner():
            pass

    def _private(self):
        pass

def load_user(id):
    pass

async def fetch():
    pass
`), ['class User', '__init__()', 'save()', 'load_user()', 'fetch()']);

  assert.deepEqual(labels('main.go', `package main

type Server struct {
	addr string
}
type Handler interface{}
type ID string

func (s *Server) Start() error { return nil }
func NewServer(addr string) *Server { return nil }
func main() {}
`), ['type Server', 'type Handler', 'type ID', 'Server.Start()', 'NewServer()', 'main()']);

  assert.deepEqual(labels('src/lib.rs', `pub struct Config { pub a: u32 }
pub enum Kind { A }
pub trait Store {}
impl Config {
    pub fn new() -> Self { Config { a: 1 } }
    fn private_one() {}
}
pub(crate) async fn serve() {}
fn helper() {}
`), ['struct Config', 'enum Kind', 'trait Store', 'new()', 'serve()']);
});

test('repoMap: Java, Kotlin, C#, PHP, Ruby definitions', () => {
  assert.deepEqual(labels('src/UserService.java', `package a;
public class UserService {
    private final Repo repo;
    public UserService(Repo repo) { this.repo = repo; }
    public User findUser(long id) { return repo.find(id); }
    public static List<User> all() { return null; }
    private void hidden() {}
}
interface Repo { User find(long id); }
`), ['class UserService', 'findUser()', 'all()', 'interface Repo']);

  assert.deepEqual(labels('src/Main.kt', `data class Point(val x: Int)
object Registry
fun main() {}
private fun hidden() {}
suspend fun load(): Int = 1
`), ['class Point', 'object Registry', 'main()', 'load()']);

  assert.deepEqual(labels('Svc.cs', `namespace A {
  public sealed class OrderService {
    public async Task<Order> GetOrder(int id) { return null; }
    private void Hidden() {}
  }
  public interface IOrders {}
}
`), ['class OrderService', 'GetOrder()', 'interface IOrders']);

  assert.deepEqual(labels('src/Cart.php', `<?php
final class Cart {
    public function __construct() {}
    public function addItem($i) {}
    private function hidden() {}
    public static function make() {}
}
interface Payable {}
function helper() {}
`), ['class Cart', '__construct()', 'addItem()', 'make()', 'interface Payable', 'helper()']);

  assert.deepEqual(labels('lib/shop/cart.rb', `module Shop
  class Cart
    def add(item)
    end
    def self.build
    end
    def empty?
    end
  end
end
`), ['module Shop', 'class Cart', 'add()', 'build()', 'empty?()']);

  assert.deepEqual(extractSymbols('README.md', '# export function nope() {}'), []);
});

test('repoMap: files whose names are used by many others rank first; entry points get a boost', async () => {
  const root = await repo({
    'src/util.ts': 'export function formatDate(d: Date) { return ""; }\nexport class Logger {}\n',
    'src/a.ts': "import { formatDate, Logger } from './util';\nexport function aThing() { formatDate(new Date()); }\n",
    'src/b.ts': "import { formatDate } from './util';\nexport function bThing() { formatDate(new Date()); }\n",
    'src/c.ts': "import { Logger } from './util';\nimport { aThing } from './a';\nexport function cThing() { aThing(); }\n",
    'src/lonely.ts': 'export function unusedThing() {}\n',
    'src/deep/x/index.ts': 'export function nothingUses() {}\n',
    'index.ts': 'export function bootstrap() {}\n',
  });
  const map = new RepoMap(root);
  await map.refresh();
  const order = map.rank().map((r) => r.file);
  assert.equal(order[0], 'src/util.ts');
  assert.ok(order.indexOf('src/a.ts') < order.indexOf('src/b.ts'), order.join());
  assert.ok(order.indexOf('index.ts') < order.indexOf('src/lonely.ts'), 'top-level entry point beats an unused file');
  assert.ok(order.indexOf('index.ts') < order.indexOf('src/deep/x/index.ts'), 'shallow entry points beat deep ones');
  // A file named in the user's message is listed first.
  assert.match(map.render({ mentioned: ['src/lonely.ts'] }).split('\n').find((l) => /^[\w/.]+\.ts: /.test(l))!, /^src\/lonely\.ts: /);
});

test('repoMap: the rendered map stays within the token budget and says how many files were left out', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 120; i++) { files[`pkg/mod${i}/service${i}.ts`] = `export class Service${i} {}\nexport function handler${i}() {}\nexport const CONFIG_${i} = 1;\n`; }
  const root = await repo(files);
  const map = new RepoMap(root);
  await map.refresh();
  for (const budgetTokens of [200, 500, 1500]) {
    const out = map.render({ budgetTokens, forPrompt: true });
    assert.ok(out.length <= budgetTokens * 3.5, `${out.length} > ${budgetTokens * 3.5}`);
    assert.match(out, /^# Repository map/);
    assert.match(out, /\((\d+) more files with definitions; use repo_map with a path to expand\)$/);
    const shown = out.split('\n').filter((l) => /^pkg\/.*: /.test(l)).length;
    assert.equal(Number(/\((\d+) more files/.exec(out)![1]) + shown, 120);
  }
  // A small repository fits completely: no "more files" note.
  const small = await repo({ 'a.ts': 'export function one() {}\n', 'lib/b.ts': 'export function two() {}\n' });
  const all = new RepoMap(small);
  await all.refresh();
  const out = all.render({ forPrompt: true });
  assert.match(out, /a\.ts: one\(\)/);
  assert.match(out, /lib\/b\.ts: two\(\)/);
  assert.doesNotMatch(out, /more files/);
  assert.match(out, /Folders: lib\/ \(1\); 1 file at the top level/);
});

test('repoMap: ignored and generated folders are left out', async () => {
  const root = await repo({
    '.gitignore': 'generated/\n',
    'src/main.ts': 'export function realCode() {}\n',
    'node_modules/lib/index.js': 'export function fromNodeModules() {}\n',
    'dist/bundle.js': 'export function fromDist() {}\n',
    'generated/api.ts': 'export function fromGenerated() {}\n',
    'web/app.min.js': 'export function minified() {}\n',
  });
  const map = new RepoMap(root);
  await map.refresh();
  const out = map.render();
  assert.match(out, /realCode/);
  for (const hidden of ['fromNodeModules', 'fromDist', 'fromGenerated', 'minified', 'node_modules', 'generated/']) { assert.ok(!out.includes(hidden), hidden); }
});

test('repoMap: the repo_map tool maps one folder when given a path, and limits the file count', async () => {
  const root = await repo({
    'src/api/users.ts': 'export function listUsers() {}\n',
    'src/api/orders.ts': 'export function listOrders() {}\n',
    'src/api/v2/items.ts': 'export function listItems() {}\n',
    'src/ui/button.ts': 'export function Button() {}\n',
  });
  const tool = repoMapTool(new RepoMaps());
  assert.equal(tool.kind, 'read');
  assert.equal(tool.spec.function.name, 'repo_map');
  const out = await tool.run({ path: 'src/api' }, ctxFor(root));
  assert.match(out, /Repository map of src\/api\/ \(3 files/);
  assert.match(out, /Folders: src\/api\/v2\/ \(1\); 2 files directly in src\/api\//);
  assert.match(out, /src\/api\/users\.ts: listUsers\(\)/);
  assert.match(out, /src\/api\/v2\/items\.ts: listItems\(\)/);
  assert.ok(!out.includes('Button'));
  const one = await tool.run({ path: 'src/api', max_files: 1 }, ctxFor(root));
  assert.equal(one.split('\n').filter((l) => /^src\/api\/.*: /.test(l)).length, 1);
  assert.match(one, /\(2 more files with definitions/);
  assert.match(await tool.run({ path: 'nothing/here' }, ctxFor(root)), /no files/);
  await assert.rejects(tool.run({ path: '../outside' }, ctxFor(root)), /outside/);
});

test('repoMap: refresh re-reads only files whose size or mtime changed, and drops deleted files', async () => {
  const root = await repo({ 'a.ts': 'export function first() {}\n', 'b.ts': 'export function keep() {}\n' });
  const index = new FileIndex(root, 0);
  const map = new RepoMap(root, index);
  const abs = path.join(root, 'a.ts');
  const when = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(abs, when, when);
  await map.refresh();
  assert.match(map.render(), /a\.ts: first\(\)/);
  // Same size and mtime: the cached entry is kept (the new name is not seen).
  await fs.writeFile(abs, 'export function other() {}\n');
  await fs.utimes(abs, when, when);
  await map.refresh();
  assert.match(map.render(), /a\.ts: first\(\)/);
  // A real change (new size) is picked up.
  await fs.writeFile(abs, 'export function second() {}\nexport class Added {}\n');
  await map.refresh();
  assert.match(map.render(), /a\.ts: (class Added, second\(\)|second\(\), class Added)/);
  await fs.rm(path.join(root, 'b.ts'));
  await map.refresh();
  assert.ok(!map.render().includes('keep'));
});

class SlowIndex extends FileIndex {
  release!: () => void;
  private gate = new Promise<void>((r) => { this.release = r; });
  async files(): Promise<string[]> { await this.gate; return super.files(); }
}

test('repoMap: the prompt section is left out when the first build is slow, and is ready on the next turn', async () => {
  const root = await repo({ 'src/app.ts': 'export function start() {}\n' });
  const slow = new SlowIndex(root);
  const maps = new RepoMaps(() => slow);
  assert.equal(await maps.promptSection(root, { timeoutMs: 20 }), '');
  slow.release();
  await maps.get(root).refresh();
  const section = await maps.promptSection(root, { timeoutMs: 20 });
  assert.match(section, /^# Repository map/);
  assert.match(section, /src\/app\.ts: start\(\)/);
  // Same files, same text: the system prompt does not change between turns.
  assert.equal(await maps.promptSection(root), section);
});

test('repoMap: the agent puts the section in the system prompt once per turn', async () => {
  const root = await tmpDir();
  const llm = fakeLlm([text('ok')]);
  let calls = 0;
  const agent = new Agent({
    root, llm: llm.fn, getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm', temperature: 0, allowSelfSigned: true }),
    tools: () => [], repoMap: () => { calls++; return '# Repository map\nsrc/x.ts: thing()'; },
  });
  await agent.send('hi', { mode: 'ask', effort: 'medium', model: 'm' }, recordingUi());
  assert.equal(calls, 1);
  assert.match(llm.calls[0][0].content, /# Repository map\nsrc\/x\.ts: thing\(\)/);
});
