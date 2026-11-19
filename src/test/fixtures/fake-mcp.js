// Minimal MCP stdio server used by tests. Behaviour is switched with environment variables.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'lookup', description: 'Read-only lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'weird name!', description: 'Name needs sanitizing' },
];
if (process.env.FAKE_NO_INIT) { setInterval(() => {}, 1000); } // never answers: tests init timeout
rl.on('line', (line) => {
  if (process.env.FAKE_NO_INIT) { return; }
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }); }
  else if (m.method === 'tools/list') {
    if (process.env.FAKE_PAGED && !(m.params && m.params.cursor)) { send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } }); }
    else if (process.env.FAKE_PAGED) { send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(2) } }); }
    else { send({ jsonrpc: '2.0', id: m.id, result: { tools } }); }
  } else if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (process.env.FAKE_CRASH_ON_CALL) { process.exit(3); }
    if (process.env.FAKE_SLOW) { return; } // never replies
    if (name === 'echo') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo:${args.text}` }] } }); }
    else if (name === 'lookup') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `value-of-${args.key}` }, { type: 'image', data: 'xx', mimeType: 'image/png' }] } }); }
    else if (name === 'fail') { send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } }); }
    else { send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } }); }
  } else if (m.method === 'ping') { send({ jsonrpc: '2.0', id: m.id, result: {} }); }
});
// Server-initiated request the client must answer without crashing.
setTimeout(() => send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' }), 50);
