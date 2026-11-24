// systemPromptAppend (tinywebui-fork#7): a model entry adds to the prompt it
// would otherwise run with, instead of replacing it, so a workspace prompt
// keeps the default's tool and honesty rules without a copy that drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trustedServer } from './trusted-helpers.js';
import { configProblems, DEFAULTS } from '../server/config/config.ts';
import { effectiveConfig } from '../server/config/models.ts';
import { configSchema } from '../server/cli.ts';

const models = [
  { id: 'plain', model: 'vendor/a' },
  { id: 'extends', model: 'vendor/a', systemPromptAppend: 'You are the fiction one.' },
  { id: 'both', model: 'vendor/a', systemPrompt: 'Own base.', systemPromptAppend: 'And this.' }
];
const cfg = { ...DEFAULTS, authMode: 'local', model: 'plain', models };

test('systemPromptAppend adds to the default systemPrompt', () => {
  assert.equal(effectiveConfig(cfg, 'extends').systemPrompt, `${DEFAULTS.systemPrompt}\n\nYou are the fiction one.`);
  assert.equal(effectiveConfig(cfg, 'plain').systemPrompt, DEFAULTS.systemPrompt, 'an entry without it is unchanged');
});

test('systemPromptAppend adds to an override systemPrompt on the same entry', () => {
  assert.equal(effectiveConfig(cfg, 'both').systemPrompt, 'Own base.\n\nAnd this.');
});

test('systemPromptAppend adds to the operator\'s top-level systemPrompt', () => {
  assert.equal(effectiveConfig({ ...cfg, systemPrompt: 'House rules.' }, 'extends').systemPrompt, 'House rules.\n\nYou are the fiction one.');
});

test('a role\'s systemPrompt replaces the whole prompt, systemPromptAppend included', () => {
  assert.equal(effectiveConfig(cfg, 'extends', { systemPrompt: 'Role says.' }).systemPrompt, 'Role says.');
});

test('systemPromptAppend is a known entry setting, and must be a string', () => {
  assert.deepEqual(configProblems(cfg), []);
  assert.match(configProblems({ ...cfg, models: [{ id: 'plain', systemPromptAppend: 3 }] }).join(), /models\[0\]\.systemPromptAppend must be a string/);
  const entry = configSchema().properties.models.items.properties;
  assert.equal(entry.systemPromptAppend.type, 'string');
  assert.match(entry.systemPromptAppend.description, /appended/i);
});

test('a turn on a systemPromptAppend entry sends the default and the appended text', async () => {
  const seen = [];
  const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.writeHead(404); return res.end(); }
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const port = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
  let srv;
  try {
    ({ srv } = await trustedServer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'extends', models }));
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tinysuite-user-id': 'sub-alice' }, body: JSON.stringify({ message: 'hi' })
    });
    await res.text();
    const system = seen.at(-1).messages[0].content;
    assert.ok(system.startsWith(`${DEFAULTS.systemPrompt}\n\nYou are the fiction one.`), system.slice(0, 200));
  } finally {
    await srv?.shutdown(); fake.close();
  }
});

test('saving the Models page keeps a model\'s systemPromptAppend, though it has no field there yet', async () => {
  const { fromConfig, buildPatch } = await import('../web/src/panels/settings/draft.ts');
  const draft = fromConfig({ models: [{ id: 'fiction', systemPromptAppend: 'Story first.' }, { id: 'plain' }], connectors: [] });
  const patch = buildPatch(draft, { admin: true, lockedKeys: new Set() });
  assert.equal(patch.models.find((m) => m.id === 'fiction').systemPromptAppend, 'Story first.');
  assert.equal('systemPromptAppend' in patch.models.find((m) => m.id === 'plain'), false, 'unset stays unset');
});
