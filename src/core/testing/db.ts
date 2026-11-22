import { execFile } from 'child_process';
import { parseCsv, Row } from './data';

export type DbType = 'postgres' | 'mysql' | 'sqlite' | 'sqlserver';
export const DB_TYPES: DbType[] = ['postgres', 'mysql', 'sqlite', 'sqlserver'];

/** A database the agent may query (read-only). The password lives in VS Code's secret storage, never here. */
export interface DbConnection {
  name: string; type: DbType; host?: string; port?: number; database?: string; user?: string;
  /** SQLite: the database file. */
  file?: string;
  /** Path to psql / mysql / sqlite3 / sqlcmd when it is not on PATH. */
  cli?: string;
  description?: string;
}

/** Words that start a statement that writes or changes state: refused at the start of the query or of a subquery. */
const WRITE_STATEMENTS = new Set(['insert', 'update', 'delete', 'merge', 'upsert', 'replace', 'drop', 'alter', 'create', 'truncate', 'rename', 'grant', 'revoke',
  'exec', 'execute', 'call', 'do', 'copy', 'lock', 'unlock', 'vacuum', 'reindex', 'cluster', 'attach', 'detach', 'load', 'import', 'set', 'reset',
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'prepare', 'deallocate', 'listen', 'notify', 'refresh', 'comment', 'shutdown', 'kill',
  'handler', 'install', 'uninstall', 'backup', 'restore', 'dbcc', 'bulk']);
/** Functions with side effects (file access, other servers, sequences, killing sessions): refused when called. */
const WRITE_FUNCTIONS = new Set(['pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_write_file', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'lo_import', 'lo_export', 'dblink', 'dblink_exec', 'set_config', 'nextval', 'setval', 'load_file', 'xp_cmdshell', 'sp_executesql', 'openrowset', 'opendatasource', 'openquery']);
/** Refused anywhere: SELECT … INTO creates a table or writes a file. */
const WRITE_ANYWHERE = new Set(['into', 'outfile', 'dumpfile']);
const READ_STARTS = ['select', 'with', 'show', 'explain', 'describe', 'desc', 'values', 'table', 'pragma'];

/** Comments and quoted text removed, so keywords inside strings ('please delete me') do not count. */
export function stripSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') { i++; } out += ' '; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { i++; } i++; out += ' '; continue; }
    // '#' comments and [bracket] names differ per database: they stay as code, which can only make the check stricter.
    if (c === "'" || c === '"' || c === '`') {
      const close = c;
      i++;
      while (i < sql.length) { if (sql[i] === close) { if (sql[i + 1] === close) { i += 2; continue; } break; } i++; }
      out += c === "'" ? "''" : ' x ';
      continue;
    }
    if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) { const end = sql.indexOf(tag[0], i + tag[0].length); i = end < 0 ? sql.length : end + tag[0].length - 1; out += "''"; continue; }
    }
    out += c;
  }
  return out;
}

/** Why this SQL is not a single read-only query, or undefined when it is. */
export function readOnlyProblem(sql: string): string | undefined {
  const s = stripSql(sql).trim().replace(/;\s*$/, '').trim();
  if (!s) { return 'The query is empty.'; }
  if (s.includes(';')) { return 'Only one statement is allowed (remove the extra ";").'; }
  const lower = s.toLowerCase();
  const tokens = [...lower.matchAll(/[a-z_][a-z0-9_]*|[()]/g)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
  const words = tokens.filter((t) => t.w !== '(' && t.w !== ')').map((t) => t.w);
  const first = words[0] ?? '';
  if (!READ_STARTS.includes(first)) { return `Only read-only queries are allowed (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE); this one starts with "${first || s.slice(0, 10)}".`; }
  if (first === 'pragma' && s.includes('=')) { return 'PRAGMA assignments change the database and are not allowed.'; }
  if (first === 'explain') {
    // EXPLAIN ANALYZE runs the statement, so what it explains must itself be a read.
    const target = words.slice(1).find((w) => !['analyze', 'analyse', 'verbose', 'costs', 'buffers', 'format', 'json', 'text', 'true', 'false', 'on', 'off', 'query', 'plan', 'extended', 'partitions'].includes(w));
    if (target && !['select', 'with', 'values', 'table'].includes(target)) { return `EXPLAIN of "${target.toUpperCase()}" is not allowed: only queries that read can be explained.`; }
  }
  for (let i = 0; i < tokens.length; i++) {
    const { w, at } = tokens[i];
    const prev = tokens[i - 1]?.w;
    const next = lower.slice(at + w.length).trimStart()[0];
    const bad = WRITE_ANYWHERE.has(w) ? w
      : WRITE_STATEMENTS.has(w) && (i === 0 || prev === '(' || prev === 'as') && next !== '(' ? w
      : WRITE_FUNCTIONS.has(w) && next === '(' ? `${w}()`
      : undefined;
    if (bad) { return `The query contains "${bad.toUpperCase()}", which can change data or the server. Only read-only queries are allowed.`; }
  }
  if (/\bfor\s+(update|share|no\s+key\s+update)\b/i.test(s)) { return 'SELECT … FOR UPDATE takes locks; remove it.'; }
  return undefined;
}

export interface DbCommand { cmd: string; args: string[]; env: Record<string, string>; delimiter: string; skipLines: number }

/** The CLI invocation for a query. Read-only is also enforced by the server where the CLI allows it. */
export function dbCommand(c: DbConnection, sql: string, password: string | undefined, timeoutSec: number): DbCommand {
  const q = sql.trim().replace(/;\s*$/, '');
  switch (c.type) {
    case 'postgres': {
      const conn = [c.host && `host=${c.host}`, c.port && `port=${c.port}`, c.database && `dbname=${c.database}`, c.user && `user=${c.user}`, 'application_name=infraon-assistant'].filter(Boolean).join(' ');
      return {
        cmd: c.cli || 'psql', args: [conn, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-c', q],
        env: { PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${timeoutSec * 1000}`, PGCONNECT_TIMEOUT: '15', ...(password ? { PGPASSWORD: password } : {}) },
        delimiter: ',', skipLines: 0,
      };
    }
    case 'mysql':
      return {
        cmd: c.cli || 'mysql',
        args: [...(c.host ? ['-h', c.host] : []), ...(c.port ? ['-P', String(c.port)] : []), ...(c.user ? ['-u', c.user] : []), ...(c.database ? ['-D', c.database] : []),
          '--batch', '--connect-timeout=15', '-e', `SET SESSION TRANSACTION READ ONLY; SET SESSION max_execution_time=${timeoutSec * 1000}; ${q}`],
        env: password ? { MYSQL_PWD: password } : {}, delimiter: '\t', skipLines: 0,
      };
    case 'sqlite':
      if (!c.file) { throw new Error(`The SQLite connection "${c.name}" has no "file".`); }
      return { cmd: c.cli || 'sqlite3', args: ['-readonly', '-header', '-csv', c.file, q], env: {}, delimiter: ',', skipLines: 0 };
    case 'sqlserver':
      return {
        cmd: c.cli || 'sqlcmd',
        args: ['-S', `${c.host ?? 'localhost'}${c.port ? `,${c.port}` : ''}`, ...(c.database ? ['-d', c.database] : []), ...(c.user ? ['-U', c.user] : ['-E']),
          '-W', '-s', '\t', '-b', '-l', '15', '-t', String(timeoutSec), '-K', 'ReadOnly', '-Q', `SET NOCOUNT ON; ${q}`],
        env: password ? { SQLCMDPASSWORD: password } : {}, delimiter: '\t', skipLines: 1,
      };
  }
}

/** Parses the CLI's table output into rows. */
export function parseDbOutput(out: string, d: Pick<DbCommand, 'delimiter' | 'skipLines'>): Row[] {
  let lines = out.replace(/\r\n/g, '\n').split('\n');
  if (d.skipLines) { lines = [lines[0], ...lines.slice(1 + d.skipLines)]; }
  const text = lines.join('\n');
  if (d.delimiter === '\t') {
    // Tab output escapes tabs and newlines inside values instead of quoting them.
    const rows = text.split('\n').filter((l) => l.trim());
    const header = (rows.shift() ?? '').split('\t').map((h) => h.trim());
    return rows.map((l) => { const cells = l.split('\t'); return Object.fromEntries(header.map((h, i) => [h, cells[i] === undefined || cells[i] === 'NULL' ? null : cells[i].replace(/\\n/g, '\n').replace(/\\t/g, '\t')])); });
  }
  return parseCsv(text, d.delimiter);
}

/** Hides the password itself and any password=… in a connection string, but keeps the message ("password authentication failed"). */
export function maskPassword(text: string, password?: string): string {
  let out = text.replace(/\b(password|pwd)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;'"]+)/gi, '$1$2••••');
  if (password && password.length >= 3) { out = out.split(password).join('••••'); }
  return out;
}

export async function runQuery(c: DbConnection, sql: string, password: string | undefined, o: { timeoutSec?: number; signal?: AbortSignal; cwd?: string } = {}): Promise<{ rows: Row[]; ms: number }> {
  const problem = readOnlyProblem(sql);
  if (problem) { throw new Error(problem); }
  const timeoutSec = o.timeoutSec ?? 60;
  const cmd = dbCommand(c, sql, password, timeoutSec);
  const t0 = Date.now();
  const out = await new Promise<string>((resolve, reject) => {
    execFile(cmd.cmd, cmd.args, { env: { ...process.env, ...cmd.env }, timeout: (timeoutSec + 15) * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal: o.signal, cwd: o.cwd }, (err, stdout, stderr) => {
      if (err) {
        const e: any = err;
        if (e.code === 'ENOENT') { reject(new Error(`${cmd.cmd} was not found. Install the ${c.type} command-line client or set "cli" to its full path in the connection "${c.name}".`)); return; }
        const msg = maskPassword(String(stderr || stdout || err.message), password).trim().split('\n').slice(0, 8).join('\n');
        reject(new Error(`${c.type} error: ${msg}`));
        return;
      }
      resolve(stdout);
    });
  });
  return { rows: parseDbOutput(out, cmd), ms: Date.now() - t0 };
}

export function validateConnections(raw: unknown): { connections: DbConnection[]; errors: string[] } {
  const errors: string[] = [];
  const connections: DbConnection[] = [];
  for (const [i, c] of (Array.isArray(raw) ? raw : []).entries()) {
    if (!c || typeof c !== 'object') { errors.push(`testing.databases[${i}] is not an object`); continue; }
    const name = String((c as any).name ?? '').trim();
    const type = String((c as any).type ?? '').trim().toLowerCase() as DbType;
    if (!/^[\w.-]{1,64}$/.test(name)) { errors.push(`testing.databases[${i}]: "name" must be letters, digits, . _ - (got "${name}")`); continue; }
    if (!DB_TYPES.includes(type)) { errors.push(`database "${name}": "type" must be one of ${DB_TYPES.join(', ')}`); continue; }
    const port = (c as any).port === undefined ? undefined : Number((c as any).port);
    connections.push({ name, type, host: (c as any).host, port: Number.isFinite(port) ? port : undefined, database: (c as any).database, user: (c as any).user, file: (c as any).file, cli: (c as any).cli, description: (c as any).description });
  }
  return { connections, errors };
}
