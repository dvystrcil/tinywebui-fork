// An MCP server redeployed with different tool annotations (readOnlyHint,
// idempotentHint) must be believed without restarting TinyWebUI. The hub only
// hears about a redeploy when it reconnects (dead connection, or 404 on a
// forgotten session), so that is where the hints are re-read. The tool block
// sent to the model is left byte-identical, so the prompt cache survives.
//
// Approval runs before the call, and the reconnect happens during it, so the
// first call after a redeploy was approved against the OLD hint. When a tool
// LOSES readOnlyHint that call must not go out unasked: it is put to the
// approval gate again before it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHub } from '../server/mcp.ts';
import { Store } from '../server/store/index.ts';
import { toolExecutor } from '../server/chat/tool_executor.ts';
import { startMcpHttpServer } from './mcp-http-fixture.js';

/** A server whose `roll` tool carries `annotations`; `port` brings it back where an old one was. */
function startDice(annotations, port = 0, stateless = false) {
  return startMcpHttpServer({
    port,
    stateless,
    setup: (server, { calls }) => server.registerTool('roll', { description: 'Rolls a die.', annotations }, async (extra) => {
      calls.push({ tool: 'roll', sessionId: extra.sessionId });
      return { content: [{ type: 'text', text: 'rolled 4' }] };
    })
  });
}

/** Closes `fixture` and starts a new server on its port with new annotations: a redeploy. */
async function redeploy(fixture, annotations) {
  const { port } = new URL(fixture.url);
  await fixture.close();
  const next = await startDice(annotations, Number(port));
  // Let the client see its old sockets close, as it would long before a real
  // redeploy finished rolling out.
  await new Promise((r) => setTimeout(r, 50));
  return next;
}

async function hubOn(t, annotations) {
  let fixture = await startDice(annotations);
  const hub = new McpHub({ dice: { url: fixture.url } });
  await hub.connect();
  const state = { hub, fixture };
  t.after(async () => { await hub.close(); await state.fixture.close(); });
  return state;
}

const ctx = { store: null, chatId: 'c', budget: 8000, unattended: false, askUser: null, userId: null };

/** One call through a real executor in mode 'writes'; returns the result and what the user was asked. */
async function viaExecutor(hub, name, decision) {
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const asked = [];
  const exec = toolExecutor({
    cfg: { toolApproval: 'writes' }, chatId: chat.id, store, hub, emit: () => {},
    unattended: false, approve: async (call) => { asked.push(call.name); return decision; },
    askUser: null, footer: () => '', hooks: {}
  });
  const [out] = await exec.execute([{ id: 'c0', type: 'function', function: { name, arguments: '{}' } }], { round: 0 });
  return { result: out.message.content, asked };
}

test('a tool that gains readOnlyHint in a redeploy is read-only after the reconnect, with the tool block unchanged', async (t) => {
  const s = await hubOn(t, {});
  assert.equal(s.hub.isReadOnly('dice__roll'), false);
  const block = JSON.stringify(s.hub.tools);
  const routes = JSON.stringify([...s.hub.routes]);

  s.fixture = await redeploy(s.fixture, { readOnlyHint: true, idempotentHint: true });
  assert.equal(await s.hub.call('dice__roll', {}, ctx), 'rolled 4');

  assert.equal(s.hub.isReadOnly('dice__roll'), true);
  assert.equal(s.hub.isIdempotent('dice__roll'), true);
  assert.equal(JSON.stringify(s.hub.tools), block, 'the tool block is byte-identical: the prompt cache survives');
  assert.equal(JSON.stringify([...s.hub.routes]), routes);
});

test('after gaining readOnlyHint, the next call through the executor runs without asking', async (t) => {
  const s = await hubOn(t, {});
  s.fixture = await redeploy(s.fixture, { readOnlyHint: true });
  // The first call was approved against the old hint: one extra question, harmless.
  const first = await viaExecutor(s.hub, 'dice__roll', 'allow');
  assert.deepEqual(first.asked, ['dice__roll']);
  assert.equal(first.result, 'rolled 4');
  const second = await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.deepEqual(second.asked, [], 'read-only now: no approval card');
  assert.equal(second.result, 'rolled 4');
});

test('a tool that loses readOnlyHint is asked about before the first call after the redeploy is sent', async (t) => {
  const s = await hubOn(t, { readOnlyHint: true, idempotentHint: true });
  s.fixture = await redeploy(s.fixture, {});

  const denied = await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.deepEqual(denied.asked, ['dice__roll'], 'approved as read-only, no longer read-only: asked again');
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 0, 'denied: never sent');
  assert.doesNotMatch(denied.result, /rolled/);
  assert.equal(s.hub.isReadOnly('dice__roll'), false);
  assert.equal(s.hub.isIdempotent('dice__roll'), false);

  const allowed = await viaExecutor(s.hub, 'dice__roll', 'allow');
  assert.deepEqual(allowed.asked, ['dice__roll']);
  assert.equal(allowed.result, 'rolled 4');
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 1);
});

test('without a way to ask again, a call approved as read-only that no longer is is not sent', async (t) => {
  const s = await hubOn(t, { readOnlyHint: true });
  s.fixture = await redeploy(s.fixture, {});
  const result = await s.hub.call('dice__roll', {}, ctx);
  assert.match(result, /^Error: "dice__roll" was not called/);
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 0);
});

test('a redeploy that changes the tool list keeps the tool block as it was, and still updates hints', async (t) => {
  const s = await hubOn(t, {});
  const block = JSON.stringify(s.hub.tools);
  const { port } = new URL(s.fixture.url);
  await s.fixture.close();
  s.fixture = await startMcpHttpServer({
    port: Number(port),
    setup: (server, { calls }) => {
      server.registerTool('roll', { description: 'Rolls dice, now with a count.', annotations: { readOnlyHint: true } }, async (extra) => {
        calls.push({ tool: 'roll', sessionId: extra.sessionId });
        return { content: [{ type: 'text', text: 'rolled 4' }] };
      });
      server.registerTool('flip', { description: 'Flips a coin.' }, async () => ({ content: [{ type: 'text', text: 'heads' }] }));
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await s.hub.call('dice__roll', {}, ctx), 'rolled 4');
  assert.equal(JSON.stringify(s.hub.tools), block, 'not rebuilt behind the model\'s back');
  assert.equal(s.hub.routes.has('dice__flip'), false);
  assert.equal(s.hub.isReadOnly('dice__roll'), true);
});

test('a call approved before another call in its batch reconnected is checked again before it is sent', async (t) => {
  const s = await hubOn(t, { readOnlyHint: true });
  s.fixture = await redeploy(s.fixture, {});
  const store = new Store(':memory:');
  const chat = store.chats.create({ title: 't' });
  const asked = [];
  const exec = toolExecutor({
    cfg: { toolApproval: 'writes' }, chatId: chat.id, store, hub: s.hub, emit: () => {},
    unattended: false, approve: async (call) => { asked.push(call.name); return 'deny'; },
    askUser: null, footer: () => '', hooks: {}
  });
  // Both are approved (as read-only) before either runs; whoami's call is the one that reconnects.
  const out = await exec.execute([
    { id: 'a', type: 'function', function: { name: 'dice__whoami', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'dice__roll', arguments: '{}' } }
  ], { round: 0 });
  assert.equal(out[0].message.content, 'identity=null');
  assert.deepEqual(asked, ['dice__roll']);
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 0);
});

test('the re-send after a 404 is checked too: a forgotten session is how a redeploy usually shows up', async (t) => {
  const s = await hubOn(t, { readOnlyHint: true });
  s.fixture = await redeploy(s.fixture, {});
  // Not yet noticed as dead: the first send goes out on the old session and gets 404.
  s.hub.dead.delete('dice');
  const before = s.fixture.requests.length;
  const result = await s.hub.call('dice__roll', {}, ctx);
  assert.match(result, /^Error: "dice__roll" was not called/);
  assert.ok(s.fixture.requests.slice(before).some((r) => r.method === 'tools/call'), 'the first send did go out (and got 404)');
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 0, 'never ran');
});

/* ---------- a stateless server: a redeploy the client never notices ---------- */

// Our Go MCP servers run Streamable HTTP with Stateless: true (homelab#755).
// They have no session to forget, so a redeploy never answers 404 and the
// hub never reconnects: the next call simply lands on the new pod. Hints are
// therefore re-read before a call is approved, once they are older than
// hub.hintTtlMs.

async function statelessOn(t, annotations, ttl = 0) {
  const state = { fixture: await startDice(annotations, 0, true) };
  state.hub = new McpHub({ dice: { url: state.fixture.url } });
  state.hub.hintTtlMs = ttl;
  await state.hub.connect();
  t.after(async () => { await state.hub.close(); await state.fixture.close(); });
  return state;
}

async function redeployStateless(fixture, annotations) {
  const { port } = new URL(fixture.url);
  await fixture.close();
  return startDice(annotations, Number(port), true);
}

test('stateless: a tool that loses readOnlyHint is asked about on the first call after the redeploy', async (t) => {
  const s = await statelessOn(t, { readOnlyHint: true, idempotentHint: true });
  const block = JSON.stringify(s.hub.tools);
  s.fixture = await redeployStateless(s.fixture, {});
  const denied = await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.deepEqual(denied.asked, ['dice__roll'], 'no reconnect happened, and it still asked');
  assert.equal(s.fixture.calls.filter((c) => c.tool === 'roll').length, 0, 'denied: never sent');
  assert.equal(s.hub.isReadOnly('dice__roll'), false);
  assert.equal(s.hub.isIdempotent('dice__roll'), false);
  assert.equal(JSON.stringify(s.hub.tools), block, 'the tool block is byte-identical');
});

test('stateless: a tool that gains readOnlyHint runs without asking on the first call after the redeploy', async (t) => {
  const s = await statelessOn(t, {});
  const block = JSON.stringify(s.hub.tools);
  s.fixture = await redeployStateless(s.fixture, { readOnlyHint: true });
  const first = await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.deepEqual(first.asked, []);
  assert.equal(first.result, 'rolled 4');
  assert.equal(JSON.stringify(s.hub.tools), block);
});

test('stateless: hints are re-read at most once per hintTtlMs, not on every call', async (t) => {
  const s = await statelessOn(t, { readOnlyHint: true, idempotentHint: true }, 60_000);
  const lists = () => s.fixture.requests.filter((r) => r.method === 'tools/list').length;
  const before = lists();
  for (let i = 0; i < 3; i++) await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.equal(lists(), before, 'fresh hints are not read again');
  s.hub.hintsReadAt.set('dice', Date.now() - 60_001);
  await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.equal(lists(), before + 1, 'stale hints are read once');
});

test('stateless: a server whose tool list cannot be read keeps its hints, and the call still goes through approval', async (t) => {
  const s = await statelessOn(t, {});
  const { port } = new URL(s.fixture.url);
  await s.fixture.close();
  // Down: re-reading fails, the old hint (not read-only) stands and it asks.
  const r = await viaExecutor(s.hub, 'dice__roll', 'deny');
  assert.deepEqual(r.asked, ['dice__roll']);
  s.fixture = await startDice({}, Number(port), true);
});
