// Every hiding place of a .docx, read; and the anonymized copy, written and read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, anonymizedCopy, parseXml, serialize, crc32 } from '../addin/js/docfile.js';
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
  assert.match(where(parts, 'field')[0], /Partei_Mueller/);       // inside a field name, not a word of its own: shown by the check below
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

  // The re-check of the copy: no form of the name is left; the field name "Partei_Mueller"
  // was not a word of its own, so it was not replaced, and the check shows it.
  const recheck = check(parts, vocabulary);
  const left = recheck.entries.filter((e) => /m(ü|ue)ller|hans/i.test(e.text));
  assert.deepEqual(left.map((e) => [e.text, e.occurrences.map((o) => parts[o.part].where.part)]), [['Mueller', ['field']]]);
});

test('crc32 matches the zip standard', () => {
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});
