import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, ahvValid, ibanValid, compoundSplit, fold } from '../addin/js/anon.js';
import { Vocabulary } from '../addin/js/vocabulary.js';

const vocabulary = new Vocabulary(new Uint8Array(readFileSync(new URL('./fixtures/anon_vocabulary.txt', import.meta.url))));
const cases = JSON.parse(readFileSync(new URL('./fixtures/anon_cases.json', import.meta.url), 'utf8'));
const run = (i) => check(cases[i].parts, vocabulary);
const shown = (r) => r.entries.map((e) => e.text);
const entry = (r, text) => r.entries.find((e) => e.text === text);

test('vocabulary: exact words only, the header and exception lines are not words', () => {
  assert.ok(vocabulary.has('beschwerde') && vocabulary.has('zürich') && vocabulary.has('!hofmann'));
  assert.ok(!vocabulary.has('hofmann') && !vocabulary.has('#ocl-vocabulary 1') && !vocabulary.has('beschwerd') && !vocabulary.has(''));
  assert.throws(() => new Vocabulary(new TextEncoder().encode('words\n')), /schema 1/);
});

test('helpers: AHV and IBAN check digits, compounds, grouping key', () => {
  assert.ok(ahvValid('756.1234.5678.97') && !ahvValid('756.1234.5678.98'));
  assert.ok(ibanValid('CH93 0076 2011 6238 5295 7') && !ibanValid('CH93 0076 2011 6238 5295 8'));
  const has = (w) => vocabulary.has(w);
  assert.ok(compoundSplit('schneelast', has) && compoundSplit('hofplan', has) && !compoundSplit('hofmann', (w) => w === 'hof'));
  assert.ok(!compoundSplit('rossibianchi', has));
  assert.equal(fold('MÜLLER'), fold('Mueller'));
});

test('every kind of identifier is shown with its label; offices are explained', () => {
  const r = run(0);
  const labels = Object.fromEntries(r.entries.filter((e) => e.kind === 'identifier').map((e) => [e.label + ':' + e.text, true]));
  for (const key of ['address:Bahnhofstrasse 12, 8001 Zürich', 'phone:079 123 45 67', 'ahv:756.1234.5678.97', 'ahv:260.68.476.118',
    'iban:CH93 0076 2011 6238 5295 7', 'plate:ZH 123456', 'parcel:1234', 'birthdate:12. März 1980', 'insured:756.9999.8888.77',
    'email:hans.mueller@gmail.com', 'profile:facebook.com/hans.mueller.77']) assert.ok(labels[key], key);
  assert.deepEqual(r.explained.public, { address: 1, email: 1, iban: 1, phone: 1 });   // CSS, info@zh.ch, Staatskasse, Polizeiposten
  assert.ok(!shown(r).includes('Tribschenstrasse 21, 6005 Luzern') && !shown(r).includes('044 411 71 17'));
});

test('an inflected name stays shown even where the word list holds the inflected form ("müllers")', () => {
  assert.ok(vocabulary.has('müllers'));
  assert.ok(entry(run(0), 'Müller').forms.includes('Müllers'));
});

test('one person, every form: Müller, Müllers, MÜLLER, in a comment and in a tracked deletion', () => {
  const r = run(0);
  const e = entry(r, 'Müller');
  assert.deepEqual(e.forms, ['MÜLLER', 'Müller', 'Müllers']);
  assert.equal(e.occurrences.length, 5);
  assert.equal(e.occurrences.filter((o) => !o.visible).length, 2);
  assert.ok(entry(r, 'Weber').hidden);
  const hans = r.people.find((p) => p.name === 'Hans Müller');
  assert.ok(hans, 'Hans Müller is one person');
});

test('the document makes public: bench, counsel, authors, case names; common words stay out', () => {
  const r = run(0);
  assert.deepEqual(r.explained.court, ['Aubry', 'Feller', 'Girardin', 'Seiler']);
  assert.deepEqual(r.explained.counsel, ['Kunz', 'Peter']);
  assert.deepEqual([r.explained.author, r.explained.case], [['Schmid'], ['Doorson']]);
  for (const name of ['Seiler', 'Kunz', 'Schmid', 'Doorson']) assert.ok(!shown(r).includes(name), name);
  assert.deepEqual(run(1).explained.counsel, ['Dupont', 'Jean']);
});

test('a category the document anonymizes is not explained: counsel written as B.________', () => {
  const r = run(2);
  assert.deepEqual(r.explained.anonymized_roles, ['counsel']);
  assert.ok(shown(r).includes('Kunz'));
  assert.deepEqual(r.explained.court, ['Meier']);
});

test('numbers: common shapes explained, an unknown long number shown', () => {
  const r = run(0);
  assert.ok(shown(r).includes('7123456'));
  for (const v of ['140', '115', '4A_747/2012', '12\'345.50', '3.2.1', '12/11/63-64', '98765432']) assert.ok(!shown(r).includes(v), v);
});

test('compounds of common words are explained, listed name compounds are not', () => {
  const r = run(0);
  assert.ok(!shown(r).includes('Schneelast') && shown(r).includes('Hofmann'));
});

test('anonymized or not: placeholders counted, a ruling without them lists its names', () => {
  assert.ok(run(0).anonymized);
  assert.equal(run(0).placeholders['A.________'], 3);
  const r = run(3);
  assert.ok(!r.anonymized);
  assert.deepEqual(shown(r).filter((t) => /^[A-Z][a-z]+$/.test(t)), ['Mario', 'Rossi', 'Anna', 'Bianchi']);
  assert.equal(entry(r, 'Rossi').occurrences.length, 3);
});

test('bench blocks and citations as courts write them; a party with a file reference stays shown', () => {
  const r = run(4);
  const names = shown(r);
  for (const n of ['Wullschleger', 'Gelzer', 'Kobler', 'ZEHETBAUER', 'GHAVAMI', 'RAPP', 'Häfelin', 'Haller', 'Thurnherr', 'Donatsch', 'Hohl', 'LOCHER', 'GALEAZZI']) {
    assert.ok(!names.includes(n), n + ' should be explained');
  }
  assert.ok(names.includes('Krasniqi'), 'a party in brackets with a file reference is not an author');
  assert.ok(r.explained.court.includes('Wullschleger') && r.explained.author.includes('Häfelin'));
});

test('not a leak: letterheads, offices, prisons, counsel, look-alikes; the real ones beside them are', () => {
  const r = run(5);
  const ids = r.entries.filter((e) => e.kind === 'identifier').map((e) => e.label + ':' + e.text);
  assert.deepEqual(ids.sort(), ['address:Musterweg 12, 8000 Zürich', 'birthdate:4. Mai 1971', 'phone:079 555 66 77']);
});

test('names that are also words: shown as names, explained as words', () => {
  const r = run(6);
  const places = r.entries.flatMap((e) => e.occurrences.map((o) => o.text + '@' + o.start));
  // The words: "Im Streit", "den Saldo", "am Schweizer Handelsplatz", "kein Schweizer".
  // The names: "zahlte Saldo", "Streit bestritt" (a sentence start, but no article), "Dr. Saldo".
  assert.deepEqual(places.sort(), ['Saldo@30', 'Saldo@96', 'Streit@44'].sort());
});

test('a role in a comment makes no one public: the name stays shown in the text and in the comment', () => {
  const e = entry(run(7), 'Krasniqi');
  assert.ok(e, 'Krasniqi is shown');
  assert.equal(e.occurrences.length, 2);
});

test('people, not words: one row per person, the full name as written, ambiguous mentions apart', () => {
  const r = run(8);
  const names = r.people.map((p) => [p.name, p.mentions.map((m) => m.text)]);
  assert.deepEqual(names, [
    ['Anna Müller', ['Anna Müller', 'Anna Müller-Keller']],
    ['Hans Müller', ['Hans Müller', 'HANS MÜLLER', 'H. Müller', 'Hans']],
    ['Müller-Meier', ['Müller-Meier']],
  ]);
  // "Müller" alone and "Müllers" fit three people: the clerk decides; the genitive s stays
  assert.deepEqual(r.ambiguous.map((a) => [a.name, a.candidates, a.mentions.map((m) => m.text)]),
    [['Müller', [0, 1, 2], ['Müller', 'Müller']]]);
  assert.ok(r.explained.counsel.includes('Kunz'), 'RA is counsel');
});

test('Word test 2026-10-08: combining umlaut, date forms, one-letter e-mail, a party with the judge\'s name, non-breaking spaces', () => {
  const r = run(9);
  const hans = r.people.find((p) => p.mentions[0].part === 0);
  assert.deepEqual([hans.mentions[0].text, hans.mentions[0].start, hans.mentions[0].end], ['Hans Müller', 0, 12]);   // as written in the file
  assert.deepEqual(r.entries.filter((e) => e.label === 'birthdate').map((e) => e.text), ['1980-03-12', '12/03/1980', '3. März 1971']);
  assert.deepEqual(r.entries.filter((e) => e.label === 'email').map((e) => e.text), ['a@example.invalid']);   // x@ is a mask
  assert.deepEqual(r.explained.court, ['Seiler']);
  assert.ok(r.people.some((p) => p.name === 'Seiler' && p.mentions[0].part === 3), 'the party Seiler is shown');
  assert.deepEqual(r.people.filter((p) => p.mentions[0].part === 4).map((p) => p.name), ['Anna Keller', 'Peter Brunner']);
});

test('gaps 2026-10-08: an address after "wohnhaft" beside an office, a genitive that splits as a compound, a name in lower case', () => {
  const r = run(10);
  const where = (e) => e.occurrences.map((o) => [o.part, o.text]);
  assert.deepEqual(r.entries.filter((e) => e.label === 'address').map(where), [[[0, 'Bahnhofstrasse 12, 8001 Zürich']]]);
  assert.ok(r.entries.some((e) => e.occurrences.some((o) => o.part === 1 && o.text === 'Schneedies')), 'schnee + dies, but "Schneedie" is no word');
  const hans = r.people.find((p) => p.name === 'Hans Müller');
  assert.deepEqual(hans.mentions.map((m) => m.text), ['Hans Müller', 'müller', 'müller']);   // the genitive s stays
  // after "Herr" a word is a name ("Saldo" is in the word list), an office is not
  assert.deepEqual(r.entries.filter((e) => e.occurrences.some((o) => o.part === 3)).map((e) => e.text), ['Saldo']);
});

test('deep check N1: a public surname does not hide another person who bears it', () => {
  const r = run(11);
  const anna = r.people.find((p) => /Anna/.test(p.name));
  assert.deepEqual(anna.mentions.slice(0, 2).map((m) => [m.part, m.text]), [[0, 'Anna Müller'], [1, 'Anna Müller']]);
  // the bare "Müller" may be either person: shown, not explained as the judge's
  assert.ok(r.people.concat(r.ambiguous).some((p) => p.mentions.some((m) => m.part === 1 && m.text === 'Müller')));
  assert.deepEqual(r.explained.court, ['Hans', 'Müller']);
  const judge = run(12);
  assert.deepEqual([judge.people, judge.ambiguous], [[], []]);             // only the judge: nothing to show
});

test('deep check A19/A20: labels past Z, never one already used', async () => {
  const { freeLabels, labelOf } = await import('../addin/js/anon-pane.js');
  const free = freeLabels([], []);
  assert.deepEqual([free[0], free[25], free[26], free[27]], ['A', 'Z', 'AA', 'AB']);           // person 27 is AA, not A again
  const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + '.________');
  assert.equal(freeLabels(all, [])[0], 'AA');                                                  // A to Z in the document: AA, not X
  assert.equal(freeLabels(['B.________'], ['A.________', 'AA.'])[0], 'C');
  assert.deepEqual([labelOf('AB.________'), labelOf('C.'), labelOf('[…]')], ['AB', 'C', '']);
});

test('deep check A10-A12: whole e-mail addresses beyond ASCII, a labelled four-digit patient number', () => {
  const r = run(13);
  assert.deepEqual(r.entries.filter((e) => e.kind === 'identifier').map((e) => [e.label, e.text]),
    [['email', 'jürg.müller@example.ch'], ['email', 'anna@müller-treuhand.ch'], ['insured', '1234'], ['insured', '5678']]);
});

test('acceptance 2026-10-09: the arrow keys go to the next place Word can show, and stop at the ends', async () => {
  const { nextPlace } = await import('../addin/js/anon-pane.js');
  const visible = [0, 2, 3];                                   // place 1 is in a comment: not shown in Word
  assert.deepEqual([nextPlace(visible, -1, 1), nextPlace(visible, -1, -1)], [0, 3]);   // from no place: first, last
  assert.deepEqual([nextPlace(visible, 0, 1), nextPlace(visible, 2, 1), nextPlace(visible, 3, 1)], [2, 3, 3]);
  assert.deepEqual([nextPlace(visible, 3, -1), nextPlace(visible, 0, -1)], [2, 0]);
  assert.equal(nextPlace([], -1, 1), -1);
});

test('live retest A14: a name in lower case only is a person; a single unknown word is counted, not shown', () => {
  const r = run(14);
  // "hans müller", "Hans Müller" and the decomposed umlaut are one person, each place as written
  assert.deepEqual(r.people.map((p) => [p.name, p.mentions.map((m) => [m.part, m.text, m.start, m.end])]),
    [['hans müller', [[0, 'hans müller', 0, 11], [2, 'Hans Müller', 0, 11], [3, 'hans müller', 0, 12]]]]);
  assert.deepEqual(r.ambiguous, []);
  // "ernst" alone: not shown, not explained, counted; prose in lower case is common words
  assert.ok(!r.entries.some((e) => e.occurrences.some((o) => o.part === 1 || o.part === 4)));
  assert.equal(r.explained.unassessed, 1);
  const judge = run(15);
  assert.deepEqual(judge.explained.court, ['Hans', 'Müller']);
  assert.deepEqual(judge.people.map((p) => [p.name, p.mentions.map((m) => m.text)]), [['anna müller', ['anna müller']]]);
});
