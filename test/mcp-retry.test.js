// A remote MCP server that is not up when the hub connects -- still starting
// after a reboot, say -- is retried on its own and can be retried by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHub } from '../server/mcp.ts';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer } from './mcp-http-fixture.js';

const local = { type: 'function', function: { name: 'local_tool', description: '', parameters: { type: 'object', properties: {} } } };

/** A port that was just in use and now has nothing listening. */
async function downServer() {
  const probe = await startMcpHttpServer();
  const { port } = new URL(probe.url);
  await probe.close();
  return { url: `http://127.0.0.1:${port}/mcp`, port: Number(port) };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('an unreachable server says why, and is tried again until it comes up', async (t) => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 20, max: 40 };
  await hub.connect();
  hub.registerLocal(local, () => 'ok');
  t.after(() => hub.close());

  assert.match(hub.errors.join(), /^remote: fetch failed \(.*ECONNREFUSED/);
  const [row] = hub.inventory().servers;
  assert.equal(row.status, 'error');
  assert.equal(row.retry.attempts, 1);
  assert.equal(typeof row.retry.nextAt, 'number');

  const fixture = await startMcpHttpServer({ port: down.port });
  t.after(() => fixture.close());
  // Connected and done: open() records the client before its tools are listed.
  await until(() => hub.clients.has('remote') && !hub.attaching.has('remote'));

  assert.deepEqual(hub.errors, []);
  const [up] = hub.inventory().servers;
  assert.equal(up.status, 'ok');
  assert.equal(up.retry, null);
  // In front of the built-ins, where it would have been had it been up from the start.
  assert.deepEqual(hub.tools.map((t) => t.function.name), ['remote__whoami', 'local_tool']);
  assert.equal(await hub.call('remote__whoami', {}, {}), 'identity=null');
});

test('retry() connects now, without waiting for the next attempt', async (t) => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 60_000, max: 60_000 };
  await hub.connect();
  t.after(() => hub.close());
  assert.equal(await hub.retry('remote'), false);
  assert.equal(hub.inventory().servers[0].retry.attempts, 2);

  const fixture = await startMcpHttpServer({ port: down.port });
  t.after(() => fixture.close());
  const [first, second] = await Promise.all([hub.retry('remote'), hub.retry('remote')]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(hub.tools.map((t) => t.function.name), ['remote__whoami']);
  // Already connected: nothing to do, and no second copy of its tools.
  assert.equal(await hub.retry('remote'), true);
  assert.equal(hub.tools.length, 1);
});

test('a server this hub starts itself is not retried on its own', async (t) => {
  const hub = new McpHub({ broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] } });
  hub.retryDelay = { first: 10, max: 10 };
  await hub.connect();
  t.after(() => hub.close());
  const [row] = hub.inventory().servers;
  assert.equal(row.status, 'error');
  assert.equal(row.retry.attempts, 1);
  assert.equal(row.retry.nextAt, null);
});

test('closing the hub stops its retries', async () => {
  const down = await downServer();
  const hub = new McpHub({ remote: { url: down.url } });
  hub.retryDelay = { first: 20, max: 20 };
  await hub.connect();
  await hub.close();
  const fixture = await startMcpHttpServer({ port: down.port });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hub.clients.has('remote'), false);
  assert.equal(await hub.retry('remote'), false);
  await fixture.close();
});

/* ---------- a shared connection whose session the server forgot ---------- */

// A remote server that restarts (a redeploy) forgets every session. Its next
// request on the old one gets 404, which per the streamable-HTTP spec means
// "start a new session". The call never ran, so it is safe to send again.

async function sharedHub(t, setup) {
  const fixture = await startMcpHttpServer({ setup });
  const hub = new McpHub({ remote: { url: fixture.url } });
  await hub.connect();
  t.after(async () => { await hub.close(); await fixture.close(); });
  return { hub, fixture };
}

const ctx = { store: null, chatId: 'c', budget: 8000, unattended: false, askUser: null, userId: null };

test('a shared connection the server forgot is replaced, and the call is sent again', async (t) => {
  const { hub, fixture } = await sharedHub(t);
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  const first = fixture.calls.at(-1).sessionId;
  await fixture.dropSession(first);
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  const second = fixture.calls.at(-1).sessionId;
  assert.notEqual(second, first);
  // And it stays fixed: later calls ride the new session, not 404 forever.
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  assert.equal(fixture.calls.at(-1).sessionId, second);
});

test('a non-idempotent shared call on a forgotten session is sent again once: it never ran', async (t) => {
  const { hub, fixture } = await sharedHub(t, (server, { calls }) => server.registerTool('write', {}, async (extra) => {
    calls.push({ tool: 'write', sessionId: extra.sessionId });
    return { content: [{ type: 'text', text: 'written' }] };
  }));
  assert.equal(await hub.call('remote__write', {}, ctx), 'written');
  await fixture.dropSession(fixture.calls.at(-1).sessionId);
  assert.equal(await hub.call('remote__write', {}, ctx), 'written');
  assert.equal(fixture.calls.filter((c) => c.tool === 'write').length, 2, 'once per call, never twice');
});

test('any other HTTP error on a shared call is reported, not retried or reconnected', async (t) => {
  const { hub, fixture } = await sharedHub(t);
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  const session = fixture.calls.at(-1).sessionId;
  const before = fixture.requests.length;
  fixture.failNext(503);
  assert.match(await hub.call('remote__whoami', {}, ctx), /^Error calling remote__whoami: Streamable HTTP error/);
  assert.equal(fixture.requests.length, before + 1, 'sent once, not repeated');
  // The session was fine all along, so the next call keeps it.
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  assert.equal(fixture.calls.at(-1).sessionId, session);
  assert.equal(fixture.requests.filter((r) => r.method === 'initialize').length, 1, 'never reconnected');
});

test('calls that hit the same forgotten session share one new connection', async (t) => {
  const { hub, fixture } = await sharedHub(t);
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  await fixture.dropSession(fixture.calls.at(-1).sessionId);
  const results = await Promise.all([1, 2, 3].map(() => hub.call('remote__whoami', {}, ctx)));
  assert.deepEqual(results, ['identity=null', 'identity=null', 'identity=null']);
  assert.equal(fixture.requests.filter((r) => r.method === 'initialize').length, 2, 'one reconnect, not one per call');
  assert.equal(new Set(fixture.calls.slice(1).map((c) => c.sessionId)).size, 1);
});

test('a call that hits 404 after another already reconnected uses that connection, not a third', async (t) => {
  const { hub, fixture } = await sharedHub(t);
  const live = hub.clients.get('remote');
  // A call still on the old connection, whose 404 arrives only after the
  // replacement is already in place.
  hub.clients.set('remote', {
    callTool: async () => { hub.clients.set('remote', live); throw new StreamableHTTPError(404, 'Session not found'); },
    close: async () => {}
  });
  assert.equal(await hub.call('remote__whoami', {}, ctx), 'identity=null');
  assert.equal(fixture.requests.filter((r) => r.method === 'initialize').length, 1, 'the live connection was kept');
  assert.equal(hub.clients.get('remote'), live);
});
