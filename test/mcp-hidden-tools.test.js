// A server's own `hiddenTools`: tools from that server the deployment never
// offers, set with the server rather than in the global disabledTools. A key
// set in code is locked in the UI, so a code-set disabledTools would make every
// tool switch in the composer fail; hiddenTools leaves those switches free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startMcpHttpServer } from './mcp-http-fixture.js';
import { hiddenToolsProblems } from '../server/mcp_hidden.ts';

const fixture = await startMcpHttpServer({
  setup: (server) => server.registerTool('publish', { description: 'Publishes.', inputSchema: { id: z.string() } }, async () => ({ content: [{ type: 'text', text: 'done' }] }))
});
const dir = mkdtempSync(join(tmpdir(), 'tinywebui-hidden-'));
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, dbPath: join(dir, 'chats.db'),
  mcpServers: { flow: { url: fixture.url, hiddenTools: ['publish'] } },
  config: { authMode: 'local', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', autoTitle: false }
});
test.after(async () => { await srv.shutdown(); await fixture.close(); });
const base = `http://127.0.0.1:${srv.address().port}`;
const tools = async () => { const r = await fetch(`${base}/api/tools`); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };

test('a hidden tool is never offered, and its siblings are', async () => {
  const flow = (await tools()).servers.find((s) => s.name === 'flow');
  assert.deepEqual(flow.tools.map((t) => t.name), ['flow__whoami']);
});

test('the global tool switches still work with servers set in code', async () => {
  const res = await fetch(`${base}/api/tools/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'flow__whoami', disabled: true }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).disabledTools, ['flow__whoami']);
});

test('hiddenTools must be a list of tool names', () => {
  assert.deepEqual(hiddenToolsProblems('flow', { url: 'u' }), []);
  assert.deepEqual(hiddenToolsProblems('flow', { url: 'u', hiddenTools: ['publish'] }), []);
  assert.deepEqual(hiddenToolsProblems('flow', { url: 'u', hiddenTools: 'publish' }), ['mcpServers.flow.hiddenTools must be a list of tool names']);
  assert.deepEqual(hiddenToolsProblems('flow', { url: 'u', hiddenTools: [''] }), ['mcpServers.flow.hiddenTools must be a list of tool names']);
});
