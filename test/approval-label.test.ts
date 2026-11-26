// The approval card has to say which MCP server a tool comes from: two servers
// can expose the same short name (kroger__get_current_datetime and
// tinysearch__get_current_datetime), and a card that drops the prefix makes the
// one you are asked about look like the one that was auto-approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolParts, toolLabel } from '../web/src/model/turn_model.ts';

test('an MCP tool splits into its short name and its server', () => {
  assert.deepEqual(toolParts('kroger__get_current_datetime'), { tool: 'get_current_datetime', server: 'kroger' });
});

test('a built-in tool has no server', () => {
  assert.deepEqual(toolParts('web_search'), { tool: 'web_search', server: '' });
});

test('the label keeps the short name first and names the server after it', () => {
  assert.equal(toolLabel('kroger__get_current_datetime'), 'get_current_datetime · kroger');
  assert.notEqual(toolLabel('kroger__get_current_datetime'), toolLabel('tinysearch__get_current_datetime'));
  assert.equal(toolLabel('web_search'), 'web_search');
});

test('the approval card shows the server in its text and its aria-label', () => {
  const src = readFileSync(new URL('../web/src/chat/transcript/ApprovalPrompt.vue', import.meta.url), 'utf8');
  assert.match(src, /:aria-label="`Approve \$\{toolLabel\(pending\.name\)\}`"/);
  assert.match(src, /\{\{ parts\.server \}\}/);
  assert.doesNotMatch(src, /\{\{ short\(pending\.name\) \}\}/);
});
