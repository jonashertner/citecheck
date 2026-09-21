// The JS finder against the Python one it was ported from (the OpenCaseLaw research
// client, https://github.com/jonashertner/opencaselaw, clients/python/src). Set
// OCL_CLIENT_SRC to that directory; without it the test is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCitations } from '../addin/js/parser.js';

const client = process.env.OCL_CLIENT_SRC || '';
const fixture = fileURLToPath(new URL('./fixtures/paragraphs.json', import.meta.url));

test('same references as the Python client on the shared paragraphs', { skip: (!client || !existsSync(client)) && 'OCL_CLIENT_SRC not set' }, () => {
  const program = 'import json,sys; sys.path.insert(0, sys.argv[1]); from opencaselaw_cli.documents import find_citations; ' +
    'print(json.dumps([[f["reference"], f["paragraph"] - 1] for f in find_citations(json.load(open(sys.argv[2], encoding="utf-8")))]))';
  const python = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', program, client, fixture], { encoding: 'utf8' }));
  const js = findCitations(JSON.parse(readFileSync(fixture, 'utf8'))).map((f) => [f.text, f.paragraph]);
  assert.deepEqual(js, python);
});
