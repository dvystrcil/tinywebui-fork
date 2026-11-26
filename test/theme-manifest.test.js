// The picker is built from manifest.json, and the loader trusts it: a line
// naming a file that is not there is a theme that silently does nothing, and a
// rule outside [data-theme="<id>"] leaks into every other look
// (web/public/themes/README.md, "The smallest theme").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THEMES = fileURLToPath(new URL('../web/public/themes/', import.meta.url));
const { themes } = JSON.parse(readFileSync(join(THEMES, 'manifest.json'), 'utf8'));

// One Ring and Sky Armada are the operator's own: they are served from a
// ConfigMap in the private deploy repo (dvystrcil/tinywebui, fork/themes/),
// mounted over themes/<id>/ and this manifest. The public image must not
// carry them, or name them in its picker.
const PERSONAL = ['one-ring', 'sky-armada'];

test('the personal themes are not in the image', () => {
  for (const id of PERSONAL) {
    assert.ok(!themes.some((t) => t.id === id), `${id} is not in the shipped manifest`);
    assert.ok(!existsSync(join(THEMES, id)), `web/public/themes/${id}/ is not shipped`);
  }
});

test('the shared scenery driver stays: the personal themes import it', () => {
  assert.ok(existsSync(join(THEMES, 'drivers', 'scene-kit.js')));
});

for (const t of themes) {
  test(`${t.id}: its files are there, in its own folder`, () => {
    assert.match(t.id, /^[a-z0-9-]+$/);
    for (const f of [t.file, t.js].filter(Boolean)) {
      assert.ok(f.startsWith(`${t.id}/`), `${f} sits under ${t.id}/`);
      assert.ok(existsSync(join(THEMES, f)), `${f} exists`);
    }
  });

  test(`${t.id}: every rule is scoped to the theme`, () => {
    const css = readFileSync(join(THEMES, t.file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
    // Keyframe steps (0%, from, to) are not selectors.
    const selectors = [...css.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim())
      .filter((s) => s && !s.startsWith('@') && !/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(s));
    const scope = `[data-theme="${t.id}"]`;
    // Split on top-level commas only: `:not(pre, table)` is one selector.
    const parts = (s) => s.split(/,(?![^(]*\))/);
    const leaks = selectors.flatMap(parts).map((s) => s.trim()).filter((s) => !s.includes(scope));
    assert.deepEqual(leaks, [], `rules outside ${scope}`);
  });

  if (t.js) {
    test(`${t.id}: its scenery exports mount() and builds on scene-kit`, () => {
      const js = readFileSync(join(THEMES, t.js), 'utf8');
      assert.match(js, /export\s+function\s+mount\s*\(/);
      assert.match(js, /from\s+'\.\.\/drivers\/scene-kit\.js'/);
      // Offline is the default (README, house rules): assets come from the theme's own folder.
      assert.doesNotMatch(js, /https?:\/\//);
    });
  }
}
