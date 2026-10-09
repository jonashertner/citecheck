// The anonymization mode of the pane. It reads everything the file carries,
// shows what the check could not explain, lets the clerk tick what to replace
// and writes a new, anonymized copy, which it checks again before handing it
// out. The open document is never written to.
//
// State lives here; the DOM is rebuilt from it with createElement and
// textContent only, so text from the document is never parsed as HTML.

import { check, fold } from './anon.js';
import { openVocabulary } from './index.js';
import { readFile, anonymizedCopy, verifyCopy } from './docfile.js';
import * as word from './word.js';
import { formatNumber, t } from './i18n.js';

const DATA_BASE = new URL('../data/', import.meta.url).href;
const VISIBLE = new Set(['body', 'footnote', 'endnote', 'header', 'footer']);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// A to Z, then AA to ZZ: a ruling with more than 26 people, or a document that already uses
// A to Z, still gives every person a label of its own.
const LABELS = [...LETTERS, ...LETTERS.flatMap((a) => LETTERS.map((b) => a + b))];
export const labelOf = (placeholder) => (/^[A-Z]{1,3}/.exec(placeholder || '') || [''])[0];

// The labels still free, in order, given the placeholders in the document and those already chosen.
export function freeLabels(inDocument, chosen) {
  const used = new Set([...inDocument, ...chosen].map(labelOf));
  return LABELS.filter((l) => !used.has(l));
}
const BLANK = '[…]';
// What the copy drops by itself; field codes and link targets stay unless replaced.
const REMOVED = new Set(['comment', 'deleted', 'hidden', 'alt', 'property', 'custom', 'filename']);
const $ = (id) => document.getElementById(id);

const state = {
  host: 'browser',
  vocabulary: null,
  file: null,            // outside Word: {name, buffer}
  read: null,            // {parts, notes} of the file last checked
  checked: null,         // the bytes of that file: the copy is made from exactly these
  result: null,
  rows: [],              // what the clerk decides on: one per person, ambiguous name, identifier or number
  decide: new Map(),     // row key -> {replace, ok, placeholder}
  style: 'long',
  open: null,
  step: -1,              // the place shown in the open row (-1: none chosen yet)
  compact: false,        // the header folded after a result
  busy: false,
  copy: null,            // {left, opened, url, name}
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function say(message) {
  $('a-alert').textContent = message || '';
  $('a-alert').hidden = !message;
}

const letter = (i) => (state.style === 'long' ? i + '.________' : i + '.');

// ── from the check's result to the rows the clerk decides on ──────────────
// One row per person (every way the name is written), per name that fits several
// people, per identifier and per number.
function buildRows(result, parts) {
  const placed = (o) => ({ ...o, kind: parts[o.part].where.part });
  const words = result.entries.filter((e) => e.kind === 'word').flatMap((e) => e.occurrences);
  // The forms serve field codes and link targets: the names as written and each word in them.
  const formsOf = (mentions) => {
    const forms = new Set(mentions.map((m) => m.text));
    for (const m of mentions) {
      for (const o of words) if (o.part === m.part && o.start >= m.start && o.end <= m.end) forms.add(o.text);
    }
    return [...forms];
  };
  const nameRow = (g, key) => {
    const occurrences = g.mentions.map(placed);
    return {
      key,
      kind: 'word',
      label: null,
      person: /[\s\-‑]/u.test(g.name),
      text: g.name,
      forms: formsOf(g.mentions),
      variants: [...new Set(g.mentions.map((m) => m.text))].filter((x) => x !== g.name),
      removed: occurrences.every((o) => REMOVED.has(o.kind)),
      occurrences,
      hidden: occurrences.every((o) => !o.visible),
    };
  };
  // A key names the row across checks; two rows never share one.
  const taken = new Set();
  const keyOf = (base) => {
    let key = base;
    for (let n = 2; taken.has(key); n++) key = base + '#' + n;
    taken.add(key);
    return key;
  };
  const people = result.people.map((g) => nameRow(g, keyOf('p:' + fold(g.name))));
  const ambiguous = result.ambiguous.map((g) => ({
    ...nameRow(g, keyOf('m:' + fold(g.name))),
    ambiguous: true,
    candidates: g.candidates.map((i) => people[i].key),
  }));
  const others = result.entries.filter((e) => e.kind !== 'word').map((e) => {
    const occurrences = e.occurrences.map(placed);
    return {
      key: e.key, kind: e.kind, label: e.label, person: false, text: e.text, forms: e.forms,
      variants: e.forms.filter((f) => f !== e.text),
      removed: occurrences.every((o) => REMOVED.has(o.kind)),
      occurrences,
      hidden: occurrences.every((o) => !o.visible),
    };
  });
  const first = (r) => r.occurrences[0];
  const byPlace = (x, y) => first(x).part - first(y).part || first(x).start - first(y).start;
  return [
    ...others.filter((r) => r.kind === 'identifier').sort(byPlace),
    ...[...people, ...ambiguous, ...others.filter((r) => r.kind !== 'identifier')].sort(byPlace),
  ];
}

// A name that fits several people takes the letter of the first of them until the clerk
// chooses, for the row or place by place ("Herr Müller" is A, "Frau Müller" is B).
function placeAt(row, i) {
  const d = state.decide.get(row.key);
  return (d.each && d.each.get(i)) || placeholderOf(row);
}

function placeholderOf(row) {
  const d = state.decide.get(row.key);
  if (d.placeholder || !row.ambiguous) return d.placeholder;
  const first = state.decide.get(row.candidates[0]);
  return first ? first.placeholder : BLANK;
}

// The labels to choose from: A to Z, every longer label in use, and the next free longer one.
function choices() {
  const inUse = new Set([...state.decide.values()].map((d) => labelOf(d.placeholder)).filter((l) => l.length > 1));
  const docs = new Set(Object.keys(state.result.placeholders).map(labelOf));
  const next = LABELS.slice(26).find((l) => !inUse.has(l) && !docs.has(l));
  return LABELS.filter((l, i) => i < 26 || inUse.has(l) || l === next).map(letter);
}

// Labels not used by the placeholders already in the document, in order of first appearance.
function assignPlaceholders() {
  const kept = [...state.decide.values()].map((d) => d.placeholder).filter((x) => x && x !== BLANK);   // kept from the last check
  const free = freeLabels(Object.keys(state.result.placeholders), kept);
  let next = 0;
  for (const row of state.rows) {
    const d = state.decide.get(row.key);
    if (d && (d.placeholder || row.ambiguous)) continue;
    // Past ZZ there is no label left: such a person gets […], never another person's letter.
    const placeholder = row.ambiguous ? null : row.kind === 'word' && next < free.length ? letter(free[next++]) : BLANK;
    state.decide.set(row.key, { replace: d ? d.replace : false, ok: d ? d.ok : false, placeholder });
  }
}

function restyle(style) {
  state.style = style;
  for (const d of state.decide.values()) {
    if (d.placeholder && d.placeholder !== BLANK) d.placeholder = letter(labelOf(d.placeholder));
  }
}

// ── reading and checking ──────────────────────────────────────────────────
async function ensureVocabulary() {
  if (state.vocabulary) return true;
  try {
    const opened = await openVocabulary({ base: DATA_BASE });
    state.vocabulary = opened.vocabulary;
    state.wordList = { manifest: opened.manifest, stale: opened.stale };
    return true;
  } catch {
    say(t('a_err_vocab'));
    return false;
  }
}

async function fileBytes() {
  if (state.host === 'word') return word.readFile();
  return state.file && state.file.buffer;
}

export const timings = () => state.timings;
export const wordList = () => state.wordList;

export async function runCheck() {
  say('');
  state.busy = 'check';
  render();
  const t0 = performance.now();
  let t1;
  try {
    // The word list and the file: two independent waits, run together.
    const since = (p) => p.then((value) => ({ value, ms: performance.now() - t0 }), (error) => ({ error }));
    const [words, file] = await Promise.all([since(ensureVocabulary()), since(fileBytes())]);
    if (!words.value) return;
    if (file.error) { say(t('a_err_file', { message: (file.error && file.error.message) || String(file.error) })); return; }
    const buffer = file.value;
    if (!buffer) return;
    state.checked = buffer;
    t1 = performance.now();
    state.read = await readFile(buffer, state.host === 'word' ? word.fileName() : state.file.name);
    state.result = check(state.read.parts, state.vocabulary);
    state.timings = { words: words.ms, read: file.ms, check: performance.now() - t1 };
    const before = state.decide;
    state.rows = buildRows(state.result, state.read.parts);
    state.decide = new Map(state.rows.filter((r) => before.has(r.key)).map((r) => [r.key, before.get(r.key)]));
    // Letters chosen place by place hold only while the places are the same.
    for (const r of state.rows) {
      const d = state.decide.get(r.key);
      if (d && d.each && d.eachFor !== placesKey(r)) d.each = null;
    }
    assignPlaceholders();
    state.copy = null;
    state.open = null;
  } catch (error) {
    say(t('err_generic', { message: (error && error.message) || String(error) }));
  } finally {
    state.busy = false;
    const t2 = performance.now();
    render();
    if (state.timings && t1) state.timings.render = performance.now() - t2;
  }
}

// ── the copy ──────────────────────────────────────────────────────────────
let previousUrl = null;

// Unchanged means: every part reads the same. Bytes may differ between two reads of
// an unchanged document (Word may rewrite a timestamp), so they are not compared.
async function same(a, b) {
  const text = async (buffer) => JSON.stringify((await readFile(buffer, '')).parts.map((p) => [p.where.part, p.where.file, p.where.seq, p.text]));
  return (await text(a)) === (await text(b));
}

async function makeCopy() {
  say('');
  state.busy = 'copy';
  state.copy = null;
  render();
  try {
    // The copy is made from the document as it is now, so an edit made after the check (bold,
    // a picture) is in it. Places are paragraph and offset in the checked text: if any part reads
    // differently now, the places may be wrong, and a fresh check comes first.
    const buffer = state.host === 'word' ? await word.readFile() : state.checked;
    if (state.host === 'word' && !(await same(buffer, state.checked))) {
      say(t('a_changed'));
      return;
    }
    const ticked = state.rows.filter((r) => state.decide.get(r.key).replace);
    const replacements = ticked.flatMap((r) => {
      const byPlaceholder = new Map();
      r.occurrences.forEach((o, i) => {
        if (!o.visible) return;
        const w = state.read.parts[o.part].where;
        const placeholder = placeAt(r, i);
        if (!byPlaceholder.has(placeholder)) byPlaceholder.set(placeholder, []);
        byPlaceholder.get(placeholder).push({ file: w.file, seq: w.seq, start: o.start, end: o.end, text: o.text });
      });
      if (!byPlaceholder.size) byPlaceholder.set(placeholderOf(r), []);
      return [...byPlaceholder].map(([placeholder, places], k) => ({ placeholder, forms: k ? [] : r.forms, places }));
    });
    const copy = await anonymizedCopy(buffer, replacements, { replaced: 0, skipped: [] });
    // The copy is read and checked like any document before it is handed out.
    const read = await readFile(copy, '');
    const again = check(read.parts, state.vocabulary);
    const replacedKeys = new Set(ticked.flatMap((r) => r.forms.map(fold)));
    // Left over: a ticked form anywhere, anything in what the copy must have removed,
    // and a name or an initial standing next to a placeholder the copy wrote
    // ("H. A.________", "A.________-Keller"): what was missed of a name just replaced.
    const leftAt = new Set();
    for (const e of again.entries) {
      for (const o of e.occurrences) {
        if (replacedKeys.has(fold(o.text)) || REMOVED.has(read.parts[o.part].where.part)) leftAt.add(o.part + ':' + o.start);
      }
    }
    const written = [...new Set(replacements.map((r) => r.placeholder))].filter((p) => p !== BLANK);
    if (written.length) {
      const ph = '(?:' + written.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      const beside = new RegExp('(?<![\\p{L}\\p{N}_])\\p{Lu}\\.[ \\u00a0]?' + ph + '|' + ph + '[\\-\\u2011]\\p{Lu}|\\p{Lu}\\p{L}+[\\-\\u2011]' + ph, 'gu');
      read.parts.forEach((p, i) => {
        if (!VISIBLE.has(p.where.part)) return;
        for (const m of p.text.matchAll(beside)) leftAt.add(i + ':' + m.index);
      });
    }
    const left = leftAt.size;
    // What the copy still holds by the clerk's choice: shown, neither ticked nor confirmed.
    const open = state.rows.filter((r) => !r.removed && !state.decide.get(r.key).replace && !state.decide.get(r.key).ok).length;
    const name = ((state.file && state.file.name) || 'Entscheid.docx').replace(/\.docx$/i, '') + ' anonymisiert.docx';
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    // The copy against the original, independently of the check: every visible paragraph with
    // exactly the ticked places replaced, nothing else changed. A copy that differs is not handed out.
    const differ = verifyCopy(state.read, read, replacements);
    if (differ.length) {
      state.copy = { broken: differ.length };
      return;
    }
    state.copy = { left, open, ticked: ticked.length, name };
    if (!left && word.canOpenCopy()) {
      state.copy.opened = await word.openCopy(copy);
    } else {
      state.copy.url = previousUrl = URL.createObjectURL(new Blob([copy], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    }
  } catch (error) {
    say(t('err_generic', { message: (error && error.message) || String(error) }));
  } finally {
    state.busy = false;
    render();
  }
}

// ── showing a place in Word ───────────────────────────────────────────────
// Which occurrence of the text this place is in its part of the document (the body,
// one note, one header), counted as Word's search counts them,
// and how often the text stands in that part in all: Word must find it as often, or the place moved.
function placeOf(o) {
  const parts = state.read.parts;
  const w = parts[o.part].where;
  const same = (x) => x.where.part === w.part && x.where.file === w.file && x.where.note === w.note;
  const escaped = o.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = word.wholeWord(o.text) ? new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'gu') : new RegExp(escaped, 'gu');
  let nth = 0;
  let total = 0;
  parts.forEach((x, i) => {
    if (!same(x)) return;
    const count = (s) => (s.match(re) || []).length;
    total += count(x.text);
    if (i < o.part) nth += count(x.text);
    if (i === o.part) nth += count(x.text.slice(0, o.start));
  });
  const section = (state.read.sections || {})[w.file] || {};
  return { text: o.text, nth, total, part: o.kind, note: w.note, section: section.section, type: section.type };
}

async function show(row, i) {
  const o = row.occurrences[i];
  if (state.host !== 'word' || !o.visible) return;
  try {
    const ok = await word.showPlace(placeOf(o));
    say(ok ? '' : t('show_failed'));
  } catch (error) {
    say(t('err_generic', { message: (error && error.message) || String(error) }));
  }
}

// ── rendering ─────────────────────────────────────────────────────────────
function placeName(o) {
  const where = state.read.parts[o.part].where;
  if (o.kind === 'body') return t('paragraph', { n: where.index + 1 });
  if (o.kind === 'footnote') return t('footnote', { n: where.note + 1 });
  return t('part_' + o.kind);
}

// The place in its sentence; ticked, struck through with what it becomes beside it
// ("~~Hans Müller~~ A.________"): <del> and <ins> with a real space and, for screen readers,
// the words "ersetzt durch" between them.
function contextOf(o, becomes) {
  const text = state.read.parts[o.part].text;
  // Cut at a word boundary, and only where the context really is cut.
  const before = o.start > 60 ? text.slice(o.start - 60, o.start).replace(/^\S*\s/, '') : text.slice(0, o.start);
  const after = o.end + 60 < text.length ? text.slice(o.end, o.end + 60).replace(/\s\S*$/, '') : text.slice(o.end);
  const p = el('p', 'ctx');
  p.append((o.start > 60 ? '… ' : '') + before);
  if (becomes) {
    p.append(el('del', 'was', o.text), ' ', el('span', 'sr-only', t('a_replaced_by') + ' '), el('ins', 'becomes', becomes));
  } else {
    p.append(el('mark', null, o.text));
  }
  p.append(after + (o.end + 60 < text.length ? ' …' : ''));
  return p;
}

function describe(row) {
  if (row.kind === 'identifier') return t('lab_' + row.label);
  if (row.kind === 'number') return t('lab_number');
  if (row.ambiguous) {
    const list = row.candidates.map((key) => state.rows.find((r) => r.key === key))
      .map((r) => (placeholderOf(r) === BLANK ? '' : labelOf(placeholderOf(r)) + ' ') + r.text);
    return t('lab_ambiguous', { list: list.join(', ') });
  }
  return row.person ? t('lab_person') : t('lab_word');
}

// What the row is, in a word or two: "Person", "E-Mail-Adresse", "Mehrdeutig".
function shortLabel(row) {
  if (row.kind === 'identifier') return t('lab_' + row.label);
  if (row.kind === 'number') return t('lab_number');
  if (row.ambiguous) return t('lab_short_ambiguous');
  return row.person ? t('lab_short_person') : t('lab_short_word');
}

// What happens to it, in words (colour only supports it): open, becomes A.________, kept.
function stateOf(row) {
  const d = state.decide.get(row.key);
  if (row.removed) return t('a_removed');
  if (d.replace) return t('a_state_replace', { p: [...new Set(row.occurrences.map((o, i) => placeAt(row, i)))].join(' ') });
  return d.ok ? t('a_state_keep') : t('a_state_open');
}

// The place the arrow keys go to: among the places Word can show (the visible ones), the next or
// previous one; from no place yet, Down is the first and Up the last; at either end it stays.
export function nextPlace(visible, current, by) {
  if (!visible.length) return -1;
  const at = visible.indexOf(current);
  if (at < 0) return by > 0 ? visible[0] : visible[visible.length - 1];
  return visible[Math.max(0, Math.min(visible.length - 1, at + by))];
}

// In an open row, the arrow keys go from place to place: each is marked here, focused, and shown in Word.
function step(row, by) {
  const visible = row.occurrences.map((o, i) => (o.visible ? i : -1)).filter((i) => i >= 0);
  const next = nextPlace(visible, state.step, by);
  if (next < 0) return;
  state.step = next;
  render();
  const button = document.querySelector(`[data-focus="place:${CSS.escape(row.key)}:${next}"]`);
  if (button) button.focus({ preventScroll: false });
  show(row, next);
}

function renderRow(row) {
  const d = state.decide.get(row.key);
  const li = el('li', 'a-row' + (d.replace ? ' a-replace' : '') + (d.ok ? ' a-ok' : '') + (state.open === row.key ? ' a-open' : '') + (row.kind === 'identifier' ? ' a-identifier' : ''));
  li.id = 'r-' + state.rows.indexOf(row);

  const head = el('div', 'a-head');
  const box = el('input', 'a-tick');
  box.dataset.focus = 'tick:' + row.key;
  box.type = 'checkbox';
  box.checked = d.replace;
  box.setAttribute('aria-label', t('a_replace') + ': ' + row.text);
  box.addEventListener('change', () => { d.replace = box.checked; if (d.replace) d.ok = false; state.copy = null; render(); });
  const hit = el('label', 'a-hit');
  hit.append(box);

  const name = el('button', 'a-name');
  name.dataset.focus = 'name:' + row.key;
  name.type = 'button';
  name.setAttribute('aria-expanded', String(state.open === row.key));
  name.append(el('span', 'a-forms', row.text));
  if (d.replace) name.append(el('span', 'a-becomes', [...new Set(row.occurrences.map((o, i) => placeAt(row, i)))].join(' ')));
  // Opening a row shows its places here; Word moves only when a place is chosen (click or arrow key).
  name.addEventListener('click', () => { state.open = state.open === row.key ? null : row.key; state.step = -1; render(); });
  li.addEventListener('keydown', (e) => {
    if (state.open !== row.key || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    step(row, e.key === 'ArrowDown' ? 1 : -1);
  });

  if (row.removed) {
    box.disabled = true;
    box.checked = true;
    box.setAttribute('aria-label', t('a_removed'));
  }
  const chip = el('select', 'a-chip');
  chip.dataset.focus = 'chip:' + row.key;
  chip.setAttribute('aria-label', t('a_replace') + ': ' + row.text + ', ' + t('a_by'));
  const options = row.kind === 'word' ? [...choices(), BLANK] : [BLANK, ...choices()];
  for (const value of options) {
    const opt = el('option', null, value === BLANK ? BLANK : labelOf(value));      // the label; the row shows the whole placeholder
    opt.value = value;
    opt.selected = value === placeAt(row, 0);
    chip.append(opt);
  }
  chip.addEventListener('change', () => { d.placeholder = chip.value; d.each = null; d.replace = true; d.ok = false; state.copy = null; render(); });
  head.append(hit, name);
  if (!row.removed) head.append(chip);
  li.append(head);

  // Where it stands: per kind of place, with a count where there are several.
  const kinds = new Map();
  for (const o of row.occurrences) kinds.set(o.kind, (kinds.get(o.kind) || 0) + 1);
  // (the count of places follows on the same line)
  const where = [...kinds].map(([k, n]) => (k === 'body' && n === 1 ? placeName(row.occurrences[0]) : t('part_' + k)));
  const open = state.open === row.key;
  const line = el('div', 'a-line');
  const n = row.occurrences.length;
  const meta = el('p', 'a-meta', [shortLabel(row), where.join(', '), n === 1 ? t('a_places_one') : t('a_places_n', { n })].join(' · ') + ' · ');
  meta.append(el('span', 'a-state', stateOf(row)));
  line.append(meta);
  if (open) {
    line.append(el('p', null, describe(row).replace(/[^.]$/, '$&.')));
    if (row.variants.length) line.append(el('p', null, t('a_variants', { list: row.variants.join(', ') })));
  }
  if (row.hidden) line.append(el('p', null, row.removed ? t('a_removed') : t('a_kept')));
  li.append(line);

  if (open) {
    const body = el('div', 'a-body');
    const list = el('ol', 'a-places');
    row.occurrences.slice(0, 40).forEach((o, i) => {
      const item = el('li', i === state.step ? 'a-current' : null);
      const place = el('button', 'a-place', placeName(o));
      place.type = 'button';
      place.dataset.focus = 'place:' + row.key + ':' + i;
      place.disabled = state.host !== 'word' || !o.visible;
      place.addEventListener('click', () => { state.step = i; render(); show(row, i); });
      item.append(place);
      if (row.ambiguous && o.visible) item.append(' ', placeChip(row, i));
      item.append(contextOf(o, d.replace ? placeAt(row, i) : null));
      list.append(item);
    });
    body.append(list);
    if (state.host === 'word' && row.occurrences.length > 1) body.append(el('p', 'a-steps', t('a_steps')));
    const actions = el('div', 'f-actions');
    const ok = el('button', 'quiet', d.ok ? t('a_ok_undo') : t('a_ok'));
    ok.dataset.focus = 'ok:' + row.key;
    ok.type = 'button';
    ok.addEventListener('click', () => { d.ok = !d.ok; if (d.ok) d.replace = false; render(); });
    actions.append(ok);
    if (state.host === 'word' && word.canComment() && row.occurrences[0].kind === 'body') {
      const c = el('button', 'quiet', t('comment'));
      c.type = 'button';
      c.addEventListener('click', async () => {
        const o = row.occurrences[0];
        if (await word.commentPlace(placeOf(o), t('a_comment', { label: describe(row) }))) {
          c.textContent = t('commented'); c.disabled = true;
        }
      });
      actions.append(c);
    }
    body.append(actions);
    li.append(body);
  }
  return li;
}

const placesKey = (row) => row.occurrences.map((o) => o.part + ':' + o.start).join(' ');

// The letter for one place of a name that fits several people.
function placeChip(row, i) {
  const d = state.decide.get(row.key);
  const chip = el('select', 'a-chip a-chip-place');
  chip.dataset.focus = 'placechip:' + row.key + ':' + i;
  chip.setAttribute('aria-label', t('a_replace') + ': ' + row.occurrences[i].text + ', ' + placeName(row.occurrences[i]) + ', ' + t('a_by'));
  for (const value of [...choices(), BLANK]) {
    const opt = el('option', null, value === BLANK ? BLANK : labelOf(value));
    opt.value = value;
    opt.selected = value === placeAt(row, i);
    chip.append(opt);
  }
  chip.addEventListener('change', () => {
    if (!d.each) d.each = new Map();
    d.eachFor = placesKey(row);
    d.each.set(i, chip.value);
    d.replace = true; d.ok = false; state.copy = null; render();
  });
  return chip;
}

function renderGroup(container, title, rows) {
  container.replaceChildren();
  if (!rows.length) return;
  const head = el('div', 'a-group-head');
  head.append(el('h2', null, title));
  const choosable = rows.filter((r) => !r.removed);
  if (choosable.length > 1) {
    const all = choosable.every((r) => state.decide.get(r.key).replace);
    const toggle = el('button', 'link', all ? t('a_select_none') : t('a_select_all'));
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      for (const r of choosable) { const d = state.decide.get(r.key); d.replace = !all; if (d.replace) d.ok = false; }
      state.copy = null;
      render();
    });
    head.append(toggle);
  }
  container.append(head);
  const ol = el('ol', 'a-list');
  ol.append(...rows.map(renderRow));
  container.append(ol);
}

// The draft's margin: one mark per place in the visible text, red until decided.
function renderMargin() {
  const parts = state.read.parts;
  const lengths = parts.map((p) => (VISIBLE.has(p.where.part) ? p.text.length + 1 : 0));
  const total = lengths.reduce((s, n) => s + n, 0) || 1;
  const offsets = [];
  lengths.reduce((s, n, i) => { offsets[i] = s; return s + n; }, 0);
  const marks = [];
  state.rows.forEach((row, i) => {
    const d = state.decide.get(row.key);
    for (const o of row.occurrences) {
      if (!o.visible) continue;
      const tick = el('span', 'tick ' + (d.replace ? 'tick-replaced' : d.ok ? 'tick-found' : 'tick-missing') + (state.open === row.key ? ' tick-open' : ''));
      tick.style.top = ((offsets[o.part] + o.start) / total) * 100 + '%';
      tick.addEventListener('click', () => { state.open = row.key; render(); $('r-' + i)?.scrollIntoView({ block: 'nearest' }); });
      marks.push(tick);
    }
  });
  $('a-margin').replaceChildren(...marks);
}

function renderWhy() {
  const x = state.result.explained;
  const dl = $('a-why');
  dl.replaceChildren();
  const add = (label, value) => { if (value) dl.append(el('dt', null, label), el('dd', null, value)); };
  add(t('why_placeholders'), Object.entries(state.result.placeholders).map(([p, n]) => p + ' ' + t('a_times', { n })).join(', '));
  add(t('why_court'), x.court.join(', '));
  add(t('why_counsel'), x.counsel.join(', '));
  add(t('why_official'), x.official.join(', '));
  add(t('why_author'), x.author.join(', '));
  add(t('why_case'), x.case.join(', '));
  add(t('why_public'), Object.entries(x.public).map(([k, n]) => t('lab_' + k) + ' ' + t('a_times', { n })).join(', '));
  add(t('why_common'), t('why_common_n', { words: formatNumber(x.common), numbers: formatNumber(x.numbers) }));
  if (x.anonymized_roles.length) dl.append(el('dd', 'why-wide', t('why_anonymized_roles', { roles: x.anonymized_roles.map((r) => t('role_' + r)).join(', ') })));
}

// Rebuilding the list would drop the keyboard focus; it returns to the same control.
export function render() {
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focus;
  draw();
  if (focused) {
    const again = [...document.querySelectorAll('[data-focus]')].find((n) => n.dataset.focus === focused);
    if (again) again.focus({ preventScroll: true });
  }
}

function draw() {
  $('a-purpose').textContent = t('a_purpose');
  $('a-preview-label').textContent = t('a_preview_label');
  $('a-preview').textContent = t('a_preview');
  $('a-removed-title').textContent = t('a_removed_title');
  $('a-feedback').textContent = t('a_feedback');
  $('a-check').textContent = state.busy === 'check' ? t('a_checking') : state.result ? t('a_recheck') : t('a_check');
  $('a-check').className = state.result ? 'quiet wide' : 'primary';      // once there is a result, the copy is the main action
  $('a-check').disabled = Boolean(state.busy) || (state.host !== 'word' && !state.file);
  $('a-file').hidden = state.host === 'word';
  $('a-pick').textContent = state.file ? t('a_other_file') : t('pick_file');
  $('a-file-line').textContent = state.file ? state.file.name : t('a_drop');
  $('a-file').classList.toggle('loaded', Boolean(state.file));
  $('a-why-open').textContent = t('a_why');
  $('a-limit').textContent = t('a_limit');
  $('a-style-label').textContent = t('a_style');
  $('a-copy').textContent = state.busy === 'copy' ? t('a_copying') : t('a_copy');
  $('a-copy-note').textContent = t('a_copy_note');

  const r = state.result;
  $('a-summary').hidden = $('a-results').hidden = $('a-copybar').hidden = !r;
  // After a check the results get the room: the purpose gives way to one line naming what was
  // checked, and the preview notice folds (it stays one click away, never gone).
  $('a-purpose').hidden = Boolean(r);
  // In Word, one line names the document checked (outside Word the file line above does).
  const name = state.host === 'word' ? word.fileName() : '';
  $('a-scope').hidden = !r || !name;
  $('a-scope').textContent = name ? t('a_scope', { name }) : '';
  if (Boolean(r) !== state.compact) { state.compact = Boolean(r); $('a-preview-box').open = !r; }
  $('a-empty').hidden = Boolean(r);
  $('a-empty-title').textContent = t('a_empty_title');
  $('a-empty-body').textContent = t('a_empty_body');
  if (!r) return;

  const decide = state.rows.filter((row) => !row.removed);
  const open = decide.filter((row) => !state.decide.get(row.key).ok && !state.decide.get(row.key).replace).length;
  const n = decide.length;
  const hiddenOnly = state.rows.length - n;
  const verdict = !n ? t('a_clean') : !r.anonymized ? (n === 1 ? t('a_raw_one') : t('a_raw', { n: formatNumber(n) }))
    : n === 1 ? t('a_attention_one') : t('a_attention', { n: formatNumber(n) });
  $('a-verdict').textContent = verdict;
  // Green only when the check shows nothing: a decision made is not a file verified.
  $('a-verdict').className = 'verdict ' + (n ? 'verdict-attention' : 'verdict-clean');
  const replace = decide.filter((row) => state.decide.get(row.key).replace).length;
  const kept = decide.filter((row) => state.decide.get(row.key).ok).length;
  $('a-tally').hidden = !n;
  $('a-tally').textContent = n ? t('a_tally', { n: formatNumber(n), r: formatNumber(replace), k: formatNumber(kept), o: formatNumber(open) }) : '';
  $('a-explained').textContent = (hiddenOnly ? t('a_hidden_note', { n: formatNumber(hiddenOnly) }) + ' ' : '') +
    t('a_explained', { words: formatNumber(r.explained.common), numbers: formatNumber(r.explained.numbers) });
  renderWhy();

  renderGroup($('a-text'), t('a_in_text'), state.rows.filter((row) => !row.hidden));
  renderGroup($('a-file-group'), t('a_in_file'), state.rows.filter((row) => row.hidden));
  const notes = [];
  if (state.read.notes.images) notes.push(t('a_images', { n: state.read.notes.images }));
  if (state.read.notes.embedded) notes.push(t('a_embedded', { n: state.read.notes.embedded }));
  $('a-limit').textContent = [...notes, t('a_limit')].join(' ');
  renderMargin();

  const style = $('a-style');
  if (!style.options.length) {
    for (const [value, label] of [['long', 'A.________'], ['short', 'A.']]) {
      const opt = el('option', null, label); opt.value = value; style.append(opt);
    }
  }
  style.value = state.style;
  $('a-copy').disabled = Boolean(state.busy);
  const result = $('a-copy-result');
  result.replaceChildren();
  result.hidden = !state.copy;
  if (state.copy) {
    const c = state.copy;
    result.className = 'copy-result ' + (c.broken || c.left || c.open ? 'copy-left' : 'copy-clean');
    if (c.broken) {
      result.append(t('a_copy_broken', { n: c.broken }));
      return;
    }
    // Says what was done, never more: the ticked places, what the clerk left, the saved file still to check.
    const said = [c.left ? t('a_copy_left', { n: c.left }) : !c.ticked ? t('a_copy_none') : c.opened ? t('a_copy_opened') : t('a_copy_ready')];
    if (c.open) said.push(c.open === 1 ? t('a_copy_open_one') : t('a_copy_open', { n: c.open }));
    if (state.host === 'word') said.push(t('a_copy_saved'));
    result.append(said.join(' ') + ' ');
    if (c.url) {
      const a = el('a', null, t('a_download'));
      a.href = c.url;
      a.download = c.name;
      result.append(a);
    }
  }
}

export function start(host) {
  state.host = host;
  try { if (localStorage.getItem('citecheck.placeholder') === 'short') state.style = 'short'; } catch { /* private mode */ }
  $('a-check').addEventListener('click', runCheck);
  $('a-copy').addEventListener('click', makeCopy);
  $('a-style').addEventListener('change', () => {
    restyle($('a-style').value);
    try { localStorage.setItem('citecheck.placeholder', state.style); } catch { /* private mode */ }
    state.copy = null;
    render();
  });
  $('a-why-open').addEventListener('click', () => {
    const why = $('a-why');
    why.hidden = !why.hidden;
    $('a-why-open').setAttribute('aria-expanded', String(!why.hidden));
  });
  const take = async (file) => {
    if (!file) return;
    state.file = { name: file.name, buffer: await file.arrayBuffer() };
    state.result = null;
    state.decide = new Map();
    render();
    await runCheck();
  };
  $('a-pick').addEventListener('click', () => $('a-input').click());
  $('a-input').addEventListener('change', () => take($('a-input').files[0]));
  const drop = $('a-drop');
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => take(e.dataTransfer && e.dataTransfer.files[0]));
}
