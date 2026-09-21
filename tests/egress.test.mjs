// The data-flow guarantee, as tests. If one of these fails, the claim "the draft
// does not leave the device" needs to be looked at again before anything ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../addin/', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const scripts = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js'));
const code = (file) => read('js/' + file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the page carries the policy that confines it to its own origin', () => {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('taskpane.html'))[1];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['connect-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'", 'https://appsforoffice.microsoft.com']);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  for (const values of Object.values(directives)) for (const v of values) assert.ok(!/unsafe|\*/.test(v), v);
});

test('the only foreign resource in the page is office.js', () => {
  const foreign = [...read('taskpane.html').matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(foreign.filter((u) => u !== 'https://github.com/jonashertner/citecheck'), ['https://appsforoffice.microsoft.com/lib/1/hosted/office.js']);
  assert.ok(!/url\(|@import/.test(read('css/pane.css')), 'the stylesheet loads nothing');
});

test('only index.js talks to the network, and only to the list next to the page', () => {
  for (const file of scripts) {
    const source = code(file);
    for (const api of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'RTCPeerConnection', 'importScripts', 'eval(', 'new Function', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!source.includes(api), `${file} uses ${api}`);
    }
    // Two absolute addresses are allowed: the SVG namespace, and the base of the decision links.
    const named = source.replace('http://www.w3.org/2000/svg', '').replace("const DECISION_BASE = 'https://mcp.opencaselaw.ch/entscheid/';", '');
    assert.ok(!/https?:\/\//.test(named), `${file} names an absolute URL`);
    if (file !== 'index.js') assert.ok(!/\bfetch\(/.test(source), `${file} calls fetch`);
  }
  const fetches = [...code('index.js').matchAll(/fetch\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["base + 'index.json'", 'base + manifest.file']);
  assert.match(code('index.js'), /\^\[A-Za-z0-9\._-\]\+\$/, 'the list file name cannot leave the directory');
});

test('the decision address is only ever a link the user clicks, never a request', () => {
  const uses = code('app.js').split('\n').filter((line) => line.includes('DECISION_BASE') && !line.includes('const DECISION_BASE'));
  assert.deepEqual(uses.map((line) => line.trim().slice(0, 25)), ['a.href = DECISION_BASE + ']);
  assert.match(code('app.js'), /a\.rel = 'noopener noreferrer'/);
});

test('Word is asked to read, select and comment, nothing else', () => {
  const calls = [...code('word.js').matchAll(/\.(insert\w+|delete\w*|clear|set\w+|replace\w*|save|close)\(/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['insertComment']);
});
