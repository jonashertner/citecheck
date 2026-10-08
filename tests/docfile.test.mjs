// Every hiding place of a .docx, read; and the anonymized copy, written and read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, anonymizedCopy, verifyCopy, parseXml, serialize, crc32 } from '../addin/js/docfile.js';
import { entries, rawEntry } from '../addin/js/docx.js';
import { check } from '../addin/js/anon.js';
import { Vocabulary } from '../addin/js/vocabulary.js';

const python = process.env.PYTHON || 'python3';
const dir = mkdtempSync(join(tmpdir(), 'citecheck-anon-'));
const path = join(dir, 'Urteil Müller.docx');
execFileSync(python, [new URL('./make_fixture_anon_docx.py', import.meta.url).pathname, path]);
const bytes = readFileSync(path);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const vocabulary = new Vocabulary(new Uint8Array(readFileSync(new URL('./fixtures/anon_vocabulary.txt', import.meta.url))));
const kinds = (parts) => [...new Set(parts.map((p) => p.where.part))].sort();
const where = (parts, kind) => parts.filter((p) => p.where.part === kind).map((p) => p.text);

test('the XML tree serialises back byte for byte', () => {
  const xml = '<?xml version="1.0"?>\n<a x="1"><b/><c y=\'2\'>t &amp; u<!-- note --></c><![CDATA[<raw>]]></a>';
  assert.equal(serialize(parseXml(xml)), xml);
});

test('reads every part of the file, and says what it read where', async () => {
  const { parts, notes } = await readFile(buffer, 'Urteil Müller.docx');
  assert.deepEqual(kinds(parts), ['alt', 'body', 'comment', 'deleted', 'endnote', 'field', 'filename', 'footer', 'footnote', 'header', 'hidden', 'link', 'property', 'custom'].sort());
  assert.equal(where(parts, 'body')[0], 'Der Beschwerdeführer Hans Müller wohnt in Zürich.');           // across two runs
  assert.equal(where(parts, 'body')[1], 'Müllers Antrag und MÜLLER selbst sowie A.________.');        // insertion kept, deletion not
  assert.equal(where(parts, 'body')[2], 'Sichtbarer Text. Auch sichtbar.');                           // w:vanish w:val="0" is visible
  assert.deepEqual(where(parts, 'hidden'), ['Notiz: Müller anrufen.']);
  assert.deepEqual(where(parts, 'deleted'), [' sowie Hans Müller']);
  assert.deepEqual(where(parts, 'comment'), ['Müller noch ersetzen']);
  assert.ok(where(parts, 'property').includes('Peter Kunz'));             // the comment's author, a property of its own
  assert.deepEqual(parts.filter((p) => p.where.part === 'footnote').map((p) => [p.where.note, p.where.index, p.text]), [[0, 0, 'Aussage von Müller vom 3. Mai.'], [0, 1, 'Zweiter Absatz.']]);
  assert.deepEqual([where(parts, 'header'), where(parts, 'footer'), where(parts, 'endnote')], [['Verfahren Müller gegen Kanton'], ['Entwurf Müller'], ['Akten Müller.']]);
  assert.deepEqual(where(parts, 'alt'), ['Foto von Hans Müller', 'Müller']);
  assert.match(where(parts, 'field')[0], /Partei_Mueller/);
  const props = where(parts, 'property');
  for (const v of ['Urteil Müller', 'Rita Gerber', 'Kanzlei Gerber', 'Hans Müller']) assert.ok(props.includes(v), v);
  assert.match(where(parts, 'custom')[0], /Hans Müller/);
  assert.ok(where(parts, 'link').some((l) => l === 'mailto:hans.mueller@gmail.com') && where(parts, 'link').some((l) => /hmueller/.test(l)));
  assert.deepEqual(where(parts, 'filename'), ['Urteil Müller']);
  assert.deepEqual(notes, { images: 1, embedded: 0, thumbnail: true });
});

test('the check sees the name wherever the file holds it', async () => {
  const { parts } = await readFile(buffer, 'Urteil Müller.docx');
  const r = check(parts, vocabulary);
  const muller = r.entries.find((e) => e.text === 'Müller');
  const seen = new Set(muller.occurrences.map((o) => parts[o.part].where.part));
  for (const kind of ['body', 'hidden', 'deleted', 'comment', 'header', 'footer', 'footnote', 'endnote', 'alt', 'property', 'custom', 'filename']) assert.ok(seen.has(kind), kind);
  assert.ok(r.entries.some((e) => e.label === 'email'));
});

test('the anonymized copy: names replaced, hidden content gone, the rest untouched', async () => {
  // As the pane does it: the places the check showed for the person, plus the forms for field codes and links.
  const read = await readFile(buffer, 'Urteil Müller.docx');
  const shown = check(read.parts, vocabulary).entries.filter((e) => /^(?:Hans|Müller|Müllers|MÜLLER)$/.test(e.text) || e.label === 'email');
  const places = shown.flatMap((e) => e.occurrences).filter((o) => o.visible)
    .map((o) => { const w = read.parts[o.part].where; return { file: w.file, seq: w.seq, start: o.start, end: o.end }; });
  const replacements = [{ placeholder: 'A.________', places, forms: ['Hans', 'Müller', 'Müllers', 'MÜLLER', 'Mueller', 'hans.mueller@gmail.com'] }];
  const copy = await anonymizedCopy(buffer, replacements);
  const { parts, notes } = await readFile(copy, 'kopie.docx');
  assert.deepEqual(where(parts, 'body').slice(0, 3), [
    'Der Beschwerdeführer A.________ A.________ wohnt in Zürich.',
    'A.________ Antrag und A.________ selbst sowie A.________.',
    'Sichtbarer Text. Auch sichtbar.',
  ]);
  assert.deepEqual([where(parts, 'header'), where(parts, 'footer'), where(parts, 'footnote')[0], where(parts, 'endnote')],
    [['Verfahren A.________ gegen Kanton'], ['Entwurf A.________'], 'Aussage von A.________ vom 3. Mai.', ['Akten A.________.']]);
  for (const kind of ['hidden', 'deleted', 'comment', 'alt', 'custom', 'property']) assert.deepEqual(where(parts, kind), [], kind);
  // Only the places the check showed are replaced: the clerk of the court, also a Hans, keeps his name.
  assert.ok(where(parts, 'body').includes('Gerichtsschreiber Hans Wiprächtiger.'));
  assert.deepEqual(where(parts, 'link'), ['mailto:A.________']);
  assert.match(where(parts, 'field')[0], /Partei_A\.________/);  // an underscore parts words, in the check and in the copy alike
  assert.equal(notes.thumbnail, false);

  const zip = entries(copy);
  for (const gone of ['word/comments.xml', 'docProps/custom.xml', 'docProps/thumbnail.jpeg', 'customXml/item1.xml']) assert.ok(!zip.has(gone), gone);
  const original = entries(buffer);
  assert.deepEqual(rawEntry(copy, zip.get('word/styles.xml')), rawEntry(buffer, original.get('word/styles.xml')));
  const text = (name) => new TextDecoder().decode(execFileSync(python, ['-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', join(dir, 'copy.docx'), name]));
  writeFileSync(join(dir, 'copy.docx'), new Uint8Array(copy));
  assert.equal(execFileSync(python, ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).testzip())', join(dir, 'copy.docx')], { encoding: 'utf8' }).trim(), 'None');
  assert.doesNotMatch(text('[Content_Types].xml'), /comments|custom\.xml/);
  assert.doesNotMatch(text('word/_rels/document.xml.rels'), /comments\.xml|customXml/);
  assert.doesNotMatch(text('_rels/.rels'), /thumbnail|custom\.xml/);
  assert.doesNotMatch(text('word/settings.xml'), /docVar|trackRevisions|attachedTemplate/);
  assert.doesNotMatch(text('word/document.xml'), /commentReference|w:del |vanish\/>|Müller/);

  // The re-check of the copy: no form of the name is left, not even inside the field name.
  const recheck = check(parts, vocabulary);
  const left = recheck.entries.filter((e) => /m(ü|ue)ller|hans/i.test(e.text));
  assert.deepEqual(left.map((e) => e.text), []);
});

test('crc32 matches the zip standard', () => {
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('Word test 2026-10-08: style-hidden text, content controls, https targets, non-breaking hyphens, combining umlauts', async () => {
  const p = join(dir, 'surfaces.docx');
  execFileSync(python, [new URL('./make_fixture_surfaces_docx.py', import.meta.url).pathname, p]);
  const raw = readFileSync(p);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const read = await readFile(buf, '');
  // read: hidden by a style (through basedOn), the control's name and tag, the decoded link target
  assert.deepEqual(where(read.parts, 'hidden'), ['Benno Unsichtbar benno@example.org']);
  assert.equal(where(read.parts, 'body')[0], 'Sichtbar. ');
  const props = read.parts.filter((x) => x.where.name === 'content control').map((x) => x.text);
  assert.deepEqual(props, ['Partei Emma Musterperson', 'lukas.sdt@example.org']);
  assert.deepEqual(where(read.parts, 'link'), ['https://example.org/qa/Emma Musterperson?email=emma.link@example.org']);
  const r = check(read.parts, vocabulary);
  assert.ok(r.entries.some((e) => e.label === 'email' && e.text === 'emma.link@example.org'), 'the e-mail inside the link target');
  // a double name joined by a non-breaking hyphen is one mention; a combining umlaut is one person
  const lea = r.people.find((x) => /Lea/.test(x.name));
  assert.equal(lea.mentions[0].text, 'Lea Brunner‑Keller');
  const hans = r.people.find((x) => /Hans/.test(x.name));
  assert.equal(hans.mentions[0].text, 'Hans Müller');

  // the copy: everything ticked, as the pane would
  const body = (o) => read.parts[o.part].where;
  const replacements = [
    { placeholder: 'A.________', forms: ['Lea', 'Brunner', 'Keller'], places: lea.mentions.map((o) => ({ file: body(o).file, seq: body(o).seq, start: o.start, end: o.end })) },
    { placeholder: 'B.________', forms: ['Hans', 'Müller'], places: hans.mentions.map((o) => ({ file: body(o).file, seq: body(o).seq, start: o.start, end: o.end })) },
    { placeholder: '[…]', forms: ['emma.link@example.org', 'Emma', 'Musterperson'], places: [] },
  ];
  const copy = await anonymizedCopy(buf, replacements);
  const again = await readFile(copy, '');
  assert.deepEqual(where(again.parts, 'body'), ['Sichtbar. ', 'Inhalt des Steuerelements.', 'Weiterer Link', 'Der Sohn A.________ bestritt dies.', 'B.________ sagt aus.']);
  assert.deepEqual(where(again.parts, 'hidden'), []);
  assert.deepEqual(again.parts.filter((x) => x.where.name === 'content control'), []);
  const xml = (name) => new TextDecoder().decode(execFileSync(python, ['-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', join(dir, 'surfaces-copy.docx'), name]));
  writeFileSync(join(dir, 'surfaces-copy.docx'), new Uint8Array(copy));
  assert.doesNotMatch(xml('word/document.xml'), /Benno|Musterperson|lukas|noBreakHyphen|w:alias|w:tag/);
  assert.doesNotMatch(xml('word/_rels/document.xml.rels'), /Emma|emma\.link/);
});

test('deep check N3: a copy written from the document as it is now keeps a bold set after the check', async () => {
  const make = (name, ...flags) => {
    const path = join(dir, name);
    execFileSync(python, [new URL('./make_fixture_surfaces_docx.py', import.meta.url).pathname, path, ...flags]);
    const raw = readFileSync(path);
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  };
  const checked = make('n3-checked.docx');
  const now = make('n3-now.docx', '--bold');
  const read = await readFile(checked, '');
  const later = await readFile(now, '');
  // what the pane compares: every part reads the same, so the places stand
  assert.deepEqual(later.parts.map((p) => [p.where.part, p.where.file, p.where.seq, p.text]), read.parts.map((p) => [p.where.part, p.where.file, p.where.seq, p.text]));
  const hans = check(read.parts, vocabulary).people.find((p) => /Hans/.test(p.name));
  const w = (o) => read.parts[o.part].where;
  const copy = await anonymizedCopy(now, [{ placeholder: 'B.________', forms: ['Hans'], places: hans.mentions.map((o) => ({ file: w(o).file, seq: w(o).seq, start: o.start, end: o.end })) }]);
  writeFileSync(join(dir, 'n3-copy.docx'), new Uint8Array(copy));
  const xml = execFileSync(python, ['-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode())', join(dir, 'n3-copy.docx')], { encoding: 'utf8' });
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Sichtbar\. <\/w:t>/);
  assert.match(xml, /B\.________ sagt aus\./);
});

// ── deep check 2026-10-09: surfaces and the integrity of the copy ─────────
const integrity = async (mode) => {
  const path = join(dir, `integrity-${mode}.docx`);
  execFileSync(python, [new URL('./make_fixture_integrity_docx.py', import.meta.url).pathname, path, mode]);
  const raw = readFileSync(path);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return { buf, read: await readFile(buf, '') };
};
const placeOf = (read, part, text, find) => {
  const p = read.parts.find((x) => x.where.part === part && x.text.includes(find));
  const start = p.text.indexOf(find);
  return { file: p.where.file, seq: p.where.seq, start, end: start + find.length, text: find };
};
const partXml = (buf, name) => {
  writeFileSync(join(dir, 'x.docx'), new Uint8Array(buf));
  return execFileSync(python, ['-c', 'import sys,zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', join(dir, 'x.docx'), name], { encoding: 'utf8' });
};

test('SURF-01: a hidden text box cleaned away does not move a place onto the next paragraph', async () => {
  const { buf, read } = await integrity('textbox');
  const pl = placeOf(read, 'body', 'Kontakt', 'lea.person@example.org');
  const replacements = [{ placeholder: '[…]', forms: ['lea.person@example.org'], places: [pl] }];
  const ledger = { replaced: 0, skipped: [] };
  const copy = await anonymizedCopy(buf, replacements, ledger);
  const again = await readFile(copy, '');
  assert.deepEqual(where(again.parts, 'body').filter((x) => x.trim()), ['Vor dem Feld. ', 'Kontakt: […], bitte.', 'This separate paragraph must stay exactly as written.']);
  assert.deepEqual([ledger.replaced, ledger.skipped.length], [1, 0]);
  assert.deepEqual(verifyCopy(read, again, replacements), []);
});

test('verifyCopy: a copy that changed anything but the ticked places is caught', async () => {
  const { buf, read } = await integrity('textbox');
  const pl = placeOf(read, 'body', 'Kontakt', 'lea.person@example.org');
  const copy = await anonymizedCopy(buf, [{ placeholder: '[…]', forms: [], places: [pl] }]);
  const again = await readFile(copy, '');
  // checked against a ticked place that was not replaced, and a stale place text: both differ
  assert.equal(verifyCopy(read, again, [{ placeholder: '[…]', places: [pl] }, { placeholder: 'X', places: [{ ...pl, start: 0, end: 7 }] }]).length, 1);
  const stale = { replaced: 0, skipped: [] };
  await anonymizedCopy(buf, [{ placeholder: '[…]', places: [{ ...pl, text: 'someone.else@example.org' }] }], stale);
  assert.deepEqual([stale.replaced, stale.skipped.length], [0, 1]);         // a place that no longer reads so is left alone
});

test('SURF-02: an e-mail in a simple field instruction is read and replaced', async () => {
  const { buf, read } = await integrity('simple');
  assert.ok(where(read.parts, 'field').some((f) => f.includes('lea.simple@example.org')));
  const copy = await anonymizedCopy(buf, [{ placeholder: '[…]', forms: ['lea.simple@example.org'], places: [] }]);
  assert.doesNotMatch(partXml(copy, 'word/document.xml'), /lea\.simple/);
});

test('SURF-03, SURF-04: hidden by the default style; w:val=\'false\' in single quotes is visible', async () => {
  const d = await integrity('default');
  assert.deepEqual([where(d.read.parts, 'body').filter((x) => x), where(d.read.parts, 'hidden')], [['Sichtbar mit eigener Vorlage.'], ['Versteckt durch die Standardvorlage.']]);
  const copy = await anonymizedCopy(d.buf, []);
  assert.doesNotMatch(partXml(copy, 'word/document.xml'), /Standardvorlage/);
  const q = await integrity('quotes');
  assert.deepEqual([where(q.read.parts, 'body').filter((x) => x), where(q.read.parts, 'hidden')], [['Sichtbar trotz vanish.'], ['Versteckt.']]);
  assert.match(partXml(await anonymizedCopy(q.buf, []), 'word/document.xml'), /Sichtbar trotz vanish\./);
});

test('SURF-05: the Word namespace under another prefix is read and replaced', async () => {
  const { buf, read } = await integrity('alias');
  assert.deepEqual(where(read.parts, 'body').filter((x) => x), ['Hans Muster wohnt hier.', 'Zweiter Absatz.']);
  const pl = placeOf(read, 'body', 'Hans', 'Hans Muster');
  const copy = await anonymizedCopy(buf, [{ placeholder: 'A.________', forms: [], places: [pl] }]);
  const again = await readFile(copy, '');
  assert.deepEqual(where(again.parts, 'body').filter((x) => x), ['A.________ wohnt hier.', 'Zweiter Absatz.']);
});

test('URL: a name replaced in a link target leaves its escaped delimiters as they were', async () => {
  const { buf } = await integrity('url');
  const copy = await anonymizedCopy(buf, [{ placeholder: 'A.________', forms: ['Emma'], places: [] }]);
  assert.match(partXml(copy, 'word/_rels/document.xml.rels'), /Target="https:\/\/example\.org\/a%2Fb\?x=1%26y%3D2&amp;name=A\.________%20Muster"/);
});
