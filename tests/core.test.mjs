import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bgeKey, docketKey } from '../addin/js/keys.js';
import { findCitations, parseReference } from '../addin/js/parser.js';
import { checkDocument } from '../addin/js/check.js';
import { fixtureIndex } from './helpers.mjs';

const { index } = fixtureIndex();
const check = (...texts) => checkDocument(texts.map((text, i) => ({ text, where: { body: i } })), index);
const only = (text) => { const r = check(text); assert.equal(r.findings.length, 1, JSON.stringify(r.findings.map((f) => f.text))); return r.findings[0]; };

test('keys agree with the cases shared with the Python builder', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/key_cases.json', import.meta.url)));
  for (const [written, key] of cases.docket) assert.equal(docketKey(written), key);
  for (const [[v, p, n], key] of cases.bge) assert.equal(bgeKey(v, p, n), key);
});

test('index: exact lookup, shared keys, first and last line, neighbours', () => {
  assert.equal(index.lookup('4A_747/2012').length, 1);
  assert.equal(index.lookup('K 2015/3').length, 2);
  assert.equal(index.lookup('4A_747/2013').length, 0);
  assert.equal(index.lookup('4A_747').length, 0);              // a prefix is not a hit
  assert.equal(index.lookup('4A_747/20122').length, 0);
  assert.ok(index.has('ZK1 2023 26') === false && index.has('VB.2023.00538'));
  assert.equal(index.lookup('#ocl-cite-index 1').length, 0);
  const n = index.neighbours('BGE 140 III 0120');
  assert.equal(n.before.key, 'BGE 140 III 0115');
  assert.equal(n.after.key, 'BGE 140 III 0134');
  assert.equal(index.neighbours('!').before, null);
  assert.equal(index.neighbours('~~~').after, null);
});

test('parser reads label, Erwägung, pages, date and court', () => {
  const p = parseReference('Urteil des Bundesgerichts 4A_747/2012 vom 5. April 2013 E. 3.1');
  assert.deepEqual([p.dockets, p.date, p.pinpoint, [...p.courts].sort()], [['4A_747/2012'], '2013-04-05', '3.1', ['bge', 'bger']]);
  const q = parseReference('ATF 140 III 115 consid. 2.3 p. 118');
  assert.deepEqual([q.bge.volume, q.bge.part, q.bge.page, q.pinpoint, q.pages], [140, 'III', 115, '2.3', [118]]);
  assert.equal(parseReference('Obergericht des Kantons Zürich LB190012-O').canton, 'ZH');
});

test('non-breaking spaces and hyphens from Word do not hide a reference', () => {
  const f = findCitations(['vgl. BGE\u00a0140\u00a0III\u00a0115 E.\u00a02.3 und Urteil A\u20114843/2020 E. 2']);
  assert.equal(f.length, 2);
  assert.equal(f[0].text, 'BGE\u00a0140\u00a0III\u00a0115 E.\u00a02.3');   // the draft's own characters, for selection
});

test('found: decision and Erwägung exist', () => {
  const f = only('Das Bundesgericht hat dies in BGE 140 III 115 E. 2.3 S. 118 bestätigt.');
  assert.equal(f.status, 'found');
  assert.equal(f.rows[0].date, '2014-02-11');
});

test('differs: the Erwägung is not in the decision, siblings are offered', () => {
  const f = only('BGE 140 III 115 E. 2.7');
  assert.equal(f.status, 'differs');
  assert.deepEqual(f.issues[0], { kind: 'pinpoint', written: '2.7', state: 'absent', nearby: ['2.1', '2.2', '2.3'], more: false });
});

test('differs: page outside the decision, date, court', () => {
  assert.deepEqual(only('BGE 140 III 115 S. 140').issues[0], { kind: 'page', written: [140], range: { first: 115, last: 133 } });
  assert.equal(only('BGE 140 III 134 S. 900').status, 'found');   // last of its part in the list: no upper bound
  const d = only('Urteil 4A_747/2012 vom 5. Mai 2013');
  assert.deepEqual(d.issues[0], { kind: 'date', written: '2013-05-05', listed: ['2013-04-05'] });
  const c = only('Urteil des Bundesverwaltungsgerichts 4A_747/2012');
  assert.equal(c.issues[0].kind, 'court');
});

test('missing: near labels for typing errors', () => {
  const far = only('Urteil 8C_312/2019');                        // nothing near
  assert.equal(far.status, 'missing');
  assert.deepEqual(far.suggestions, []);
  assert.deepEqual(only('Urteil 4A_774/2021').suggestions.map((s) => s.row.key), ['4A_774/2012']);   // year digits swapped
  const digit = only('Urteil 4A_747/2013 E. 3');
  assert.deepEqual(digit.suggestions.map((s) => s.row.key), ['4A_747/2012']);
  const chamber = only('Urteil 5A_747/2012');
  assert.deepEqual(chamber.suggestions.map((s) => s.row.key), ['4A_747/2012']);
  assert.equal(chamber.courtOfShape, 'bger');
  const transposed = only('Urteil 4A_477/2012');
  assert.deepEqual(transposed.suggestions.map((s) => s.row.key), ['4A_747/2012']);
});

test('what the draft says ranks the near labels; a wrong date looks for the number it belongs to', () => {
  const dated = only('Urteil 4A_774/2013 vom 20. Juni 2013');                 // 4A_774/2012 has that date
  assert.deepEqual(dated.suggestions.map((s) => [s.row.key, s.reason]), [['4A_774/2012', 'one_character_same_date']]);
  const wrongNumber = only('Urteil 4A_774/2012 vom 5. April 2013');          // exists, but the date is 4A_747/2012's
  assert.equal(wrongNumber.status, 'differs');
  assert.deepEqual(wrongNumber.suggestions.map((s) => s.row.key), ['4A_747/2012']);
  assert.deepEqual(only('Urteil 4A_747/2012 vom 5. Mai 2013').suggestions, []);
});

test('the last BGE of a part has no known end: a far page is not placed in it', () => {
  assert.deepEqual(only('BGE 140 III 999').suggestions.filter((s) => s.reason === 'contains_page'), []);
  assert.equal(only('BGE 140 III 150').suggestions[0].reason, 'contains_page');   // 134 + 16
});

test('missing BGE: the pinpoint page was written as the first page; wrong part', () => {
  const page = only('BGE 140 III 118');
  assert.equal(page.status, 'missing');
  assert.deepEqual(page.suggestions[0], { reason: 'contains_page', row: page.suggestions[0].row, range: { first: 115, last: 133 } });
  assert.equal(page.suggestions[0].row.key, 'BGE 140 III 0115');
  const part = only('BGE 140 II 115');
  assert.ok(part.suggestions.some((s) => s.reason === 'other_part' && s.row.key === 'BGE 140 III 0115'));
});

test('early BGE volumes and year-only dates', () => {
  const f = only('ATF 73 II 6 consid. 4');
  assert.deepEqual([f.status, f.rows[0].date], ['found', '1947-01-01']);
  assert.equal(only('BGE 73 II 6 E. 9').issues[0].kind, 'pinpoint');
});

test('pre-2007 and spaced spellings, aliases, the file number of a BGE', () => {
  assert.equal(only('Urteil 4C.230/2006').status, 'found');
  assert.equal(only('Urteil 4P.166/2006').status, 'found');
  assert.equal(only('Urteil 4A 999/2013').rows[0].court, 'bge');
});

test('cantonal: court scope, shared file numbers, loose labels', () => {
  assert.equal(only('Obergericht des Kantons Zürich LB190012-O vom 12. September 2019').status, 'found');
  const sg = only('Entscheid des Kantonsgerichts St. Gallen K 2015/3');
  assert.deepEqual(sg.rows.map((r) => r.court), ['sg_gerichte']);
  const loose = check('Siehe VB.2023.00538 und VB.2023.00539 sowie ZR 110 Nr. 23.');
  assert.deepEqual(loose.findings.map((f) => [f.text, f.status]), [['VB.2023.00538', 'found'], ['VB.2023.00539', 'unchecked'], ['ZR 110 Nr. 23', 'unchecked']]);
  // statutes, SR numbers and dates are not case references
  assert.equal(check('Art. 8 ZGB (SR 210) vom 10.12.1907, in Kraft seit 1.1.1912; AS 2010 1739.').findings.length, 0);
});

test('a number whose sub-numbers are listed exists (BGE extracts list 4.1, 4.2 without 4)', () => {
  assert.equal(only('Urteil A-4843/2020 E. 1').status, 'found');       // listed: 1.1, 1.2
  const r = check('BGE 140 III 16 E. 4');                              // no numbering at all
  assert.equal(r.findings[0].notes[0].kind, 'pinpoint_no_structure');
});

test('pinpoint notes: lettered below an indexed parent, no numbering at all', () => {
  assert.equal(only('Urteil A-4843/2020 E. 2a').status, 'found');
  const lettered = only('Urteil A-4843/2020 E. 3b');
  assert.deepEqual([lettered.status, lettered.notes[0].kind], ['found', 'pinpoint_parent_only']);
  const none = only('Urteil 4A_774/2012 E. 2');
  assert.deepEqual([none.status, none.notes[0].kind], ['found', 'pinpoint_no_structure']);
});

test('nth counts every earlier occurrence, also one inside a longer reference (Word bug 2026-09-22)', () => {
  const r = check('Vgl. BGE 140 III 115 E. 2.3 S. 118; gilt dies; vgl. nochmals BGE 140 III 115.');
  assert.deepEqual(r.findings.map((f) => [f.text, f.nth]), [['BGE 140 III 115 E. 2.3 S. 118', 0], ['BGE 140 III 115', 1]]);
});

test('every occurrence is placed; repeated text gets its own nth', () => {
  const r = check('BGE 140 III 115 und nochmals BGE 140 III 115.', 'Kein Zitat.', 'Urteil 9C_1/2020');
  assert.deepEqual(r.findings.map((f) => [f.paragraph, f.nth]), [[0, 0], [0, 1], [2, 0]]);
  assert.ok(r.findings[0].position < r.findings[1].position && r.findings[1].position < r.findings[2].position);
  assert.deepEqual(r.counts, { found: 2, differs: 0, missing: 1, unchecked: 0 });
});
