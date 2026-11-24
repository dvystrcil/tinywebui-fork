// A chat runs on its own model: the one it started with, or the one picked
// while it was open. A person's pick elsewhere (or a new default) never
// relabels or reroutes it, and every assistant turn records the catalog entry
// it ran with, since several entries can share one provider model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { trustedServer } from './trusted-helpers.js';

// Every request's system prompt, which is what tells two entries on one provider model apart.
const systems = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
    const sent = JSON.parse(body);
    const system = sent.messages.find((m) => m.role === 'system');
    systems.push(typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, hold);
  });
});
// How long each reply takes: long enough, where a test needs it, to act while a turn runs.
let hold = 0;
const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));

// Two presets on one provider model, differing only in prompt.
const models = [
  { id: 'radar', label: 'Tech Radar', model: 'vendor/shared', systemPrompt: 'PRESET-RADAR' },
  { id: 'everyday', label: 'Everyday', model: 'vendor/shared', systemPrompt: 'PRESET-EVERYDAY' },
  { id: 'secret', label: 'Admins only', model: 'vendor/huge' }
];
const { srv, base, as, dir, seedChat } = await trustedServer({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'radar', models,
  access: { roles: { user: { features: ['chat', 'model-picker'], models: ['radar', 'everyday'] } } }
});
test.after(async () => { await srv.shutdown(); fake.close(); });
const alice = as({ id: 'sub-alice' });
const bob = as({ id: 'sub-bob' });

const send = async (who, chatId, message) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': who }, body: JSON.stringify({ chatId, message })
  });
  await res.text(); // drained: the turn is over
};
const lastSystem = () => systems.at(-1) || '';

async function rows(chatId) {
  const { Store } = await import('../server/store/index.ts');
  const store = new Store(join(dir, 'chats.db'));
  try { return store.messages.list(chatId); } finally { store.close(); }
}

test('assistant message records its catalog entry id', async () => {
  await seedChat({ id: 'sub-alice' }, { id: 'old-chat', content: 'from before' });
  await send('sub-alice', 'rec-1', 'hello');
  const assistant = (await rows('rec-1')).filter((r) => r.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].entry_id, 'radar');
  assert.equal(assistant[0].model, 'vendor/shared', 'the provider id is still kept beside it');
  assert.equal((await rows('old-chat'))[0].entry_id, null, 'rows written without one stay null');
});

test('a chat keeps its own preset when the default changes', async (t) => {
  t.after(() => alice('/api/me/prefs', { method: 'POST', body: { model: null } }));
  await send('sub-alice', 'keep-1', 'first');
  assert.match(lastSystem(), /PRESET-RADAR/);

  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: 'everyday' } })).status, 200);
  const here = (await alice('/api/auth/me?chat=keep-1')).data;
  assert.equal(here.model, 'radar', 'the open chat still shows the preset it ran with');
  assert.equal(here.modelLabel, 'Tech Radar');
  assert.equal((await alice('/api/auth/me')).data.model, 'everyday', 'new chats start from the new default');

  await send('sub-alice', 'keep-1', 'second');
  assert.match(lastSystem(), /PRESET-RADAR/, 'and its next turn runs on it');
  assert.deepEqual((await rows('keep-1')).filter((r) => r.role === 'assistant').map((r) => r.entry_id), ['radar', 'radar']);

  await send('sub-alice', 'keep-2', 'a new chat');
  assert.match(lastSystem(), /PRESET-EVERYDAY/);
});

test('picking a model in one chat leaves the others alone', async () => {
  await send('sub-alice', 'pick-a', 'a');
  await send('sub-alice', 'pick-b', 'b');

  const picked = await alice('/api/chats/pick-a/model', { method: 'POST', body: { model: 'everyday' } });
  assert.equal(picked.status, 200);
  assert.equal(picked.data.model, 'everyday');
  assert.equal((await alice('/api/auth/me?chat=pick-a')).data.modelLabel, 'Everyday');
  assert.equal((await alice('/api/auth/me?chat=pick-b')).data.model, 'radar', 'the other chat is untouched');
  assert.equal((await alice('/api/auth/me')).data.model, 'radar', 'so is the default for new chats');

  await send('sub-alice', 'pick-a', 'again');
  assert.match(lastSystem(), /PRESET-EVERYDAY/);
  await send('sub-alice', 'pick-b', 'again');
  assert.match(lastSystem(), /PRESET-RADAR/);
});

test('a chat\'s model is limited to the role, and only its owner sets it', async () => {
  await send('sub-alice', 'guard-1', 'hi');
  assert.equal((await alice('/api/chats/guard-1/model', { method: 'POST', body: { model: 'secret' } })).status, 403);
  assert.equal((await alice('/api/chats/guard-1/model', { method: 'POST', body: { model: 'nope' } })).status, 403);
  assert.equal((await alice('/api/chats/guard-1/model', { method: 'POST', body: { model: 7 } })).status, 400);
  assert.equal((await bob('/api/chats/guard-1/model', { method: 'POST', body: { model: 'everyday' } })).status, 404);
  assert.equal((await bob('/api/auth/me?chat=guard-1')).data.model, 'radar', 'someone else\'s chat id reads as no chat');
  assert.equal((await alice('/api/auth/me?chat=guard-1')).data.model, 'radar');
});

test('a fork starts on the model of the chat it came from', async () => {
  // The default is radar, so only the source chat's own pick can make the fork everyday.
  assert.equal((await alice('/api/me/prefs', { method: 'POST', body: { model: null } })).data.model, 'radar');
  await send('sub-alice', 'fork-src', 'question');
  await alice('/api/chats/fork-src/model', { method: 'POST', body: { model: 'everyday' } });
  const out = await alice('/api/chats/fork-src/questions/0/fork', { method: 'POST', body: { at: 'answer' } });
  assert.equal(out.status, 201);
  assert.equal((await alice(`/api/auth/me?chat=${out.data.chat.id}`)).data.model, 'everyday');
});

test('a pick made while a turn runs holds for the follow-up queued behind it', async (t) => {
  hold = 400;
  t.after(() => { hold = 0; });
  const turn = send('sub-alice', 'queued-1', 'first');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await alice('/api/chats/queued-1/queue', { method: 'POST', body: { id: 'f1', kind: 'followup', message: 'then this' } })).status, 200);
  assert.equal((await alice('/api/chats/queued-1/model', { method: 'POST', body: { model: 'everyday' } })).status, 200);
  await turn;
  for (let i = 0; i < 40 && (await rows('queued-1')).filter((r) => r.role === 'assistant').length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await rows('queued-1')).filter((r) => r.role === 'assistant').map((r) => r.entry_id), ['radar', 'everyday']);
  assert.equal((await alice('/api/auth/me?chat=queued-1')).data.model, 'everyday', 'the pick was not undone');
});

test('without accounts, a pick in a chat changes that chat, not the deployment\'s model', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { start } = await import('../server/server.ts');
  const local = await start({
    port: 0, host: '127.0.0.1', configFile: false, mcpServers: {},
    dbPath: join(mkdtempSync(join(tmpdir(), 'tinywebui-chat-model-')), 'chats.db'),
    config: { authMode: 'local', autoTitle: false, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'radar', models }
  });
  try {
    const at = `http://127.0.0.1:${local.address().port}`;
    const call = async (path, body) => {
      const res = await fetch(`${at}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: res.status, data: path === '/api/chat' ? await res.text() : await res.json() };
    };
    await call('/api/chat', { chatId: 'solo-a', message: 'a' });
    await call('/api/chat', { chatId: 'solo-b', message: 'b' });
    assert.equal((await call('/api/chats/solo-a/model', { model: 'everyday' })).status, 200);
    assert.equal((await call('/api/config')).data.model, 'radar', 'the configured model did not move');
    assert.equal((await call('/api/auth/me?chat=solo-a')).data.model, 'everyday');
    assert.equal((await call('/api/auth/me?chat=solo-b')).data.model, 'radar');
    await call('/api/chat', { chatId: 'solo-a', message: 'again' });
    assert.match(lastSystem(), /PRESET-EVERYDAY/);
  } finally { await local.shutdown(); }
});
