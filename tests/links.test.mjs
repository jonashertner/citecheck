// The decision links the pane builds, checked without a DOM: the anchor rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../addin/js/app.js', import.meta.url), 'utf8');
const body = /function decisionLink\(row, text, pinpoint\) \{([\s\S]*?)\n\}/.exec(app)[1];
// The function is evaluated with a minimal `el` and `t`, enough to read back href.
const decisionLink = new Function('row', 'text', 'pinpoint', 'el', 't', 'DECISION_BASE', body);
const el = (tag, cls, txt) => ({ tag, cls, txt, set href(v) { this._href = v; }, get href() { return this._href; } });
const link = (row, pin) => decisionLink(row, 'x', pin, el, () => '', 'https://mcp.opencaselaw.ch/entscheid/')._href;

test('anchor: the cited number when listed, else the first number below it, else none', () => {
  const row = { id: 'bger_4A_747_2012', enums: ['1', '2', '3.1', '3.2', '3.3', '4'] };
  assert.equal(link(row, '3.2'), 'https://mcp.opencaselaw.ch/entscheid/bger_4A_747_2012#e-3-2');
  assert.equal(link(row, '3'), 'https://mcp.opencaselaw.ch/entscheid/bger_4A_747_2012#e-3-1');   // reported: no fragment at all
  assert.equal(link(row, '9'), 'https://mcp.opencaselaw.ch/entscheid/bger_4A_747_2012');
  assert.equal(link(row, null), 'https://mcp.opencaselaw.ch/entscheid/bger_4A_747_2012');
  assert.equal(link({ id: 'bge_140 III 320', enums: [] }, '2'), 'https://mcp.opencaselaw.ch/entscheid/bge_140%20III%20320');
});
