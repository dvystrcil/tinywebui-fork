// A model entry can name the MCP servers it is offered, so one model can be
// "the kitchen" (recipes and groceries) and another "the library" (lore and
// rules) without every tool from every server riding on every request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpHttpServer } from './mcp-http-fixture.js';
import { configProblems } from '../server/config/config.ts';

// The provider: records every request body, answers "ok".
const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

// Two MCP servers; the fixture gives each a `whoami` tool.
const kitchen = await startMcpHttpServer();
const library = await startMcpHttpServer();

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-model-mcp-'));
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, dbPath: join(dir, 'chats.db'),
  mcpServers: { kitchen: { url: kitchen.url }, library: { url: library.url } },
  config: {
    authMode: 'trusted-header', trustedProxyCidrs: ['127.0.0.1/32', '::1/128'],
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', autoTitle: false,
    model: 'everything',
    models: [
      { id: 'everything' },
      { id: 'meal-time', mcpServers: ['kitchen'] },
      { id: 'no-mcp', mcpServers: [] }
    ],
    access: { newUsers: 'approved', roles: { user: { features: ['chat', 'model-picker', 'tools'] } } }
  }
});
test.after(async () => { await srv.shutdown(); fake.close(); await kitchen.close(); await library.close(); });

const base = `http://127.0.0.1:${srv.address().port}`;
const headers = { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-cook' };
const pick = (model) => fetch(`${base}/api/me/prefs`, { method: 'POST', headers, body: JSON.stringify({ model }) });
/** The tool names the provider saw on a turn run with `model`. */
async function toolsOnTheWire(model) {
  assert.equal((await pick(model)).status, 200, `picked ${model}`);
  const before = seen.length;
  await (await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).text();
  assert.equal(seen.length, before + 1, 'one request reached the provider');
  return (seen.at(-1).tools || []).map((t) => t.function.name).sort();
}
const fromServer = (names, server) => names.filter((n) => n.startsWith(`${server}__`));
const builtIns = (names) => names.filter((n) => !n.includes('__'));

test('a model without mcpServers is offered every connected server, as before', async () => {
  const names = await toolsOnTheWire('everything');
  assert.deepEqual(fromServer(names, 'kitchen'), ['kitchen__whoami']);
  assert.deepEqual(fromServer(names, 'library'), ['library__whoami']);
});

test('a model that names its servers is offered only theirs, and keeps the built-ins', async () => {
  const all = await toolsOnTheWire('everything');
  const meal = await toolsOnTheWire('meal-time');
  assert.deepEqual(fromServer(meal, 'kitchen'), ['kitchen__whoami']);
  assert.deepEqual(fromServer(meal, 'library'), [], 'the library is not on the wire');
  assert.deepEqual(builtIns(meal), builtIns(all), 'built-in tools are not MCP servers and stay');
});

test('an empty list means no MCP servers, but the built-ins remain', async () => {
  const all = await toolsOnTheWire('everything');
  const none = await toolsOnTheWire('no-mcp');
  assert.deepEqual(none.filter((n) => n.includes('__')), []);
  assert.deepEqual(builtIns(none), builtIns(all));
});

test('mcpServers must be a list of server names', () => {
  const at = (mcpServers) => configProblems({ models: [{ id: 'a', mcpServers }], model: 'a' }).join();
  assert.match(at('kitchen'), /models\[0\]\.mcpServers must be a list of MCP server names/);
  assert.match(at([1]), /models\[0\]\.mcpServers must be a list of MCP server names/);
  assert.equal(at(['kitchen']), '');
  assert.equal(at([]), '');
});

test('saving the Models page keeps a model\'s mcpServers, though it has no field there yet', async () => {
  const { fromConfig, buildPatch } = await import('../web/src/panels/settings/draft.ts');
  const draft = fromConfig({ models: [{ id: 'meal-time', mcpServers: ['kitchen'] }, { id: 'everything' }], connectors: [] });
  const patch = buildPatch(draft, { admin: true, lockedKeys: new Set() });
  assert.deepEqual(patch.models.find((m) => m.id === 'meal-time').mcpServers, ['kitchen']);
  assert.equal('mcpServers' in patch.models.find((m) => m.id === 'everything'), false, 'unset stays unset');
});

// A person's own server switches in the composer: what they turn off is off for
// their turns only, on top of what the model is scoped to, and never touches
// the deployment's MCP config (which may be set in code).
const as = (id) => ({ 'content-type': 'application/json', 'x-tinysuite-user-id': id });
async function wireFor(id, model) {
  assert.equal((await fetch(`${base}/api/me/prefs`, { method: 'POST', headers: as(id), body: JSON.stringify({ model }) })).status, 200);
  const before = seen.length;
  await (await fetch(`${base}/api/chat`, { method: 'POST', headers: as(id), body: JSON.stringify({ message: 'hi' }) })).text();
  assert.equal(seen.length, before + 1);
  return (seen.at(-1).tools || []).map((t) => t.function.name);
}
const switchServer = (id, server, off) => fetch(`${base}/api/me/mcp`, { method: 'POST', headers: as(id), body: JSON.stringify({ server, off }) });

test('a server a person switches off is gone from their turns only', async () => {
  assert.equal((await switchServer('sub-a', 'library', true)).status, 200);
  const a = await wireFor('sub-a', 'everything');
  const b = await wireFor('sub-b', 'everything');
  assert.equal(a.some((n) => n.startsWith('library__')), false, 'off for the person who switched it');
  assert.equal(a.includes('kitchen__whoami'), true);
  assert.equal(b.includes('library__whoami'), true, 'still on for everyone else');
  const view = async (id) => (await (await fetch(`${base}/api/tools`, { headers: as(id) })).json()).mcpOff;
  assert.deepEqual(await view('sub-a'), ['library']);
  assert.deepEqual(await view('sub-b'), []);
  assert.equal((await switchServer('sub-a', 'library', false)).status, 200);
  assert.equal((await wireFor('sub-a', 'everything')).includes('library__whoami'), true, 'and back on');
});

test('a person\'s switch narrows a scoped model further, never widens it', async () => {
  assert.equal((await switchServer('sub-c', 'kitchen', true)).status, 200);
  const meal = await wireFor('sub-c', 'meal-time');
  assert.deepEqual(meal.filter((n) => n.includes('__')), [], 'meal-time is kitchen only, and kitchen is off');
});

test('switching an unknown server is refused', async () => {
  assert.equal((await switchServer('sub-a', 'nope', true)).status, 404);
  assert.equal((await switchServer('sub-a', 'library', 'yes')).status, 400);
});
