// The two engines of the anonymization check, held to the same output: the
// JavaScript one in the pane and the Python one behind the vocabulary build and
// the benchmark. Python's standard library is all this needs, so it always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { check } from '../addin/js/anon.js';
import { Vocabulary } from '../addin/js/vocabulary.js';

const root = new URL('..', import.meta.url).pathname;
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const program = 'import json,sys; sys.path.insert(0, sys.argv[1]); from anon_engine import check, Vocabulary; ' +
  'v = Vocabulary.open(sys.argv[2]); print(json.dumps([check(c["parts"], v) for c in json.load(open(sys.argv[3], encoding="utf-8"))], ensure_ascii=False))';

test('JavaScript and Python give the same result on every fixture', () => {
  const cases = JSON.parse(readFileSync(fixture('anon_cases.json'), 'utf8'));
  const vocabulary = new Vocabulary(new Uint8Array(readFileSync(fixture('anon_vocabulary.txt'))));
  const python = JSON.parse(execFileSync(process.env.PYTHON || 'python3',
    ['-c', program, root + 'build', fixture('anon_vocabulary.txt'), fixture('anon_cases.json')], { encoding: 'utf8' }));
  const js = cases.map((c) => check(c.parts, vocabulary));
  assert.equal(js.length, python.length);
  js.forEach((result, i) => assert.deepEqual(result, python[i], cases[i].name));
});
