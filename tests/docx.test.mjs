import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocx } from '../addin/js/docx.js';
import { checkDocument } from '../addin/js/check.js';
import { fixtureIndex } from './helpers.mjs';

const path = join(mkdtempSync(join(tmpdir(), 'citecheck-')), 'draft.docx');
execFileSync(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./make_fixture_docx.py', import.meta.url)), path]);
const file = readFileSync(path);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

test('a .docx is read as the draft stands: runs joined, deletions left out, footnotes last', async () => {
  const paragraphs = await readDocx(buffer);
  assert.deepEqual(paragraphs.map((p) => p.text), [
    'Vgl. BGE 140 III 115 E. 2.3 sowie Urteil A\u20114843/2020.',
    '',
    'Müller & Söhne, Urteil 4A_747/2012',
    'Im Textfeld: 4C.230/2006',
    'Aussen\tdanach Zeile',
    'BGE 140 III 134 S. 136.',
    'Urteil 9C_1/2020.',
  ]);
  assert.deepEqual(paragraphs.slice(-2).map((p) => p.where), [{ part: 'footnote', note: 0, index: 0 }, { part: 'footnote', note: 1, index: 0 }]);
});

test('and checked like a document open in Word', async () => {
  const r = checkDocument(await readDocx(buffer), fixtureIndex().index);
  assert.deepEqual(r.findings.map((f) => [f.text, f.status]), [
    ['BGE 140 III 115 E. 2.3', 'found'], ['A\u20114843/2020', 'found'], ['4A_747/2012', 'found'], ['4C.230/2006', 'found'],
    ['BGE 140 III 134 S. 136', 'found'], ['9C_1/2020', 'missing'],
  ]);
});

test('a file that is not a .docx is refused with a reason', async () => {
  await assert.rejects(readDocx(new TextEncoder().encode('plain text, certainly not a zip archive').buffer), /not a zip/);
});
