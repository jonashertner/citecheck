// The anonymization check. One rule: everything the file carries is either
// explained or shown.
//
// A word or number is explained when it is
//   common      a word found in many published rulings and not a person's name
//               (the vocabulary), or a number of a common shape (date, amount,
//               legal reference, docket, section, count)
//   public      made public by the document: the bench, counsel and officials
//               named with their office, authors and case names in citations,
//               unless the document anonymizes that category itself
//   placeholder A.________, [...], X.
// Everything else is shown. A recognised identifier (AHV number, IBAN, phone,
// e-mail, street address, number plate, parcel, birth date, insured-person,
// ZEMIS, document or account number) is always shown, with its label, unless
// its context makes it an office's.
//
// Pure: no DOM, no network, no Word. The Python twin, build/anon_engine.py, is
// this module line for line; tests/anon_parity.test.mjs holds the two to the
// same output. The patterns live once, in anon-patterns.js.

import { PATTERNS, MACROS } from './anon-patterns.js';

const VISIBLE = new Set(['body', 'footnote', 'endnote', 'header', 'footer']);
const PARTICLES = new Set(['von', 'van', 'de', 'da', 'di', 'del', 'della', 'du', 'des', 'der', 'le', 'la', 'zur', 'zum']);
const TITLES = new Set(['dr', 'prof', 'pd', 'lic', 'iur', 'med', 'phil', 'rer', 'pol', 'oec', 'mlaw', 'll']);
const IDENTIFIERS = ['ahv', 'ahv_old', 'iban', 'insured', 'zemis', 'document_no', 'account',
  'parcel', 'birthdate', 'email', 'url', 'phone', 'plate', 'address'];
const LABEL = { ahv_old: 'ahv', document_no: 'document', url: 'profile' };
const VALUE_GROUP = new Set(['ahv_old', 'insured', 'zemis', 'document_no', 'account', 'parcel', 'birthdate']);
const RANK = { identifier: 0, word: 1, number: 1 };
const LINKS = ['', 's', 'es', 'n', 'en', 'er', 'e'];

// Each pattern three ways: g to walk the text, y to match at a position, plain to test.
function compile(source, flags) {
  source = source.replace(/\{<W\}|\{W>\}|\{[LWw]\}/g, (macro) => MACROS[macro]);   // one pass: values hold braces
  const extra = flags.includes('i') ? 'i' : '';
  return { g: new RegExp(source, 'dgu' + extra), y: new RegExp(source, 'yu' + extra), t: new RegExp(source, 'u' + extra) };
}
const P = Object.fromEntries(Object.entries(PATTERNS).map(([name, [source, flags]]) => [name, compile(source, flags)]));

// matchAll walks a copy of the pattern, so walks can nest.
const all = (name, text) => text.matchAll(P[name].g);
function at(name, text, pos) {
  const re = P[name].y;
  re.lastIndex = pos;
  return re.exec(text);
}
const test = (name, text) => P[name].t.test(text);
const matchStart = (name, text) => at(name, text, 0);

// ── small helpers, each mirrored in anon_engine.py ────────────────────────
export function ahvValid(s) {
  const d = s.replace(/[^0-9]/g, '').split('').map(Number);
  if (d.length !== 13) return false;
  const sum = d.slice(0, 12).reduce((acc, x, i) => acc + x * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

export function ibanValid(s) {
  s = s.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  let remainder = 0;
  for (const c of s.slice(4) + s.slice(0, 4)) {
    const v = parseInt(c, 36);
    if (Number.isNaN(v)) return false;
    for (const digit of String(v)) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function fold(word) {
  return word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')
    .split('ß').join('ss').split('ae').join('a').split('oe').join('o').split('ue').join('u');
}

const isUpper = (c) => c !== c.toLowerCase();
const digitsOf = (s) => (s.match(/[0-9]/g) || []).length;

// An author: at the start of a citation ("(", ";", "vgl.", "in:", "/", "StGB-"), with a literature
// marker in the same clause and no reference to the file ("act. 7"), which would make it a party's statement.
function cited(text, a, b) {
  if (!test('citation_start', text.slice(Math.max(0, a - 60), a))) return false;
  const after = text.slice(b, b + 200);
  const m = matchStart('literature', after);
  return Boolean(m) && !test('file_reference', after.slice(0, m[0].length));
}

// True at the start of a paragraph or sentence, where any word is capitalised.
// After "Dr.", "vgl." or an initial a sentence does not start.
function sentenceStart(text, a) {
  const before = text.slice(Math.max(0, a - 40), a);
  if (!before.trim() || /\n[ \t]*$/.test(before)) return true;
  if (test('abbreviation_end', before)) return false;
  return test('sentence_end', before);
}

// A noun name used as an adjective: "Schweizer Handelsplatz", "Zürcher Verwaltungsgericht".
function adjective(text, b, has) {
  const m = /^ ([\p{L}\p{Nl}\p{No}]{2,})/u.exec(text.slice(b, b + 40));
  return Boolean(m) && isUpper(m[1][0]) && has(m[1].toLowerCase());
}

export function compoundSplit(word, has, depth = 0) {
  const n = word.length;
  if (n < 7 || depth > 3) return false;
  for (let i = n - 4; i > 2; i--) {
    if (!has(word.slice(i))) continue;
    const head = word.slice(0, i);
    for (const link of LINKS) {
      if (link && !head.endsWith(link)) continue;
      const h = head.slice(0, head.length - link.length);
      if (h.length >= 3 && (has(h) || compoundSplit(h, has, depth + 1))) return true;
    }
  }
  return false;
}

// ── the check ─────────────────────────────────────────────────────────────
class Joined {
  constructor(parts) {
    this.parts = parts;
    this.starts = [];
    let pos = 0;
    for (const p of parts) {
      this.starts.push(pos);
      pos += p.text.length + 2;
    }
    this.text = parts.map((p) => p.text).join('\n\n');
  }

  index(start) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.starts[mid] <= start) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  locate(start, end) {
    const i = this.index(start);
    return { part: i, start: start - this.starts[i], end: end - this.starts[i] };
  }

  // Where the run of parts of the same kind as the one at `start` ends.
  endOfKind(start) {
    let i = this.index(start);
    const kind = (this.parts[i].where && this.parts[i].where.part) || 'body';
    while (i + 1 < this.parts.length && ((this.parts[i + 1].where && this.parts[i + 1].where.part) || 'body') === kind) i++;
    return this.starts[i] + this.parts[i].text.length;
  }

  kind(start) {
    const p = this.parts[this.index(start)];
    return (p.where && p.where.part) || 'body';
  }
}

class Spans {
  constructor() { this.items = []; }
  overlaps(a, b) { return this.items.some(([s, e]) => s < b && a < e); }
  add(a, b) { this.items.push([a, b]); }
}

const CUT = /\n\s*\n|[a-zäöüéèàç]{3,}\.\s|(?<![\p{L}\p{N}_])(?:gegen|contre|contro|Parteien|Parties|Parti)(?![\p{L}\p{N}_])/gu;

// The words before `start` that say whose it is: back to a blank line, a sentence end,
// the party separator ("gegen") or the last anonymized person, at most `width` characters.
function whose(text, start, width) {
  const before = text.slice(Math.max(0, start - width), start);
  let cut = 0;
  CUT.lastIndex = 0;
  for (let m; (m = CUT.exec(before));) cut = m.index + m[0].length;
  for (const m of all('placeholder', before)) cut = Math.max(cut, m.index + m[0].length);
  return before.slice(cut);
}

const isPublic = (text, start, width = 80) => test('not_a_person', whose(text, start, width));
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

function identifiers(t, taken, explained, pub) {
  const text = t.text;
  const out = [];
  for (const name of IDENTIFIERS) {
    for (const m of all(name, text)) {
      const group = VALUE_GROUP.has(name) ? 1 : 0;
      const value = m[group];
      const [a, b] = m.indices[group];
      if (taken.overlaps(a, b) || explained.overlaps(a, b)) continue;
      const label = LABEL[name] || name;
      if (name === 'ahv' && !ahvValid(value)) continue;
      if (name === 'iban') {
        if (!ibanValid(value)) continue;
        if (test('not_a_person', whose(text, a, 170) + text.slice(b, b + 40).split(/[\n,;.]/)[0])) { explained.add(a, b); bump(pub, 'iban'); continue; }
      }
      if (name === 'account' && isPublic(text, m.index, 120)) { explained.add(a, b); bump(pub, 'account'); continue; }
      if (name === 'email') {
        const at = value.indexOf('@');
        const local = value.slice(0, at);
        const domain = value.slice(at + 1);
        if (test('masked_local', local) || test('masked_domain', domain) || (!test('freemail', domain) && (test('public_mail', domain) || isPublic(text, a)))) { explained.add(a, b); bump(pub, 'email'); continue; }
      }
      if (name === 'url' && !test('social', value)) { explained.add(a, b); continue; }
      // A landline in a letterhead or beside an office: "Postfach … Telefon … Fax …".
      if (name === 'phone' && !matchStart('mobile', value) && (isPublic(text, a) || matchStart('letterhead', text.slice(b, b + 40)))) { explained.add(a, b); bump(pub, 'phone'); continue; }
      if (name === 'plate' && !test('plate_context', text.slice(Math.max(0, a - 60), a))) continue;
      if (name === 'address' && (value.includes('_') || isPublic(text, a, 150) || matchStart('letterhead', text.slice(b, b + 40)))) { explained.add(a, b); bump(pub, 'address'); continue; }
      taken.add(a, b);
      out.push({ kind: 'identifier', label, start: a, end: b, text: value });
    }
  }
  return out;
}

function runs(text, pos) {
  const m = at('name_run', text, pos);
  if (!m) return [[], pos];
  const names = [];
  let end = pos;
  for (const w of all('word', m[0])) {
    const token = w[0];
    const low = token.toLowerCase();
    if (TITLES.has(low) || PARTICLES.has(low)) { end = pos + w.index + token.length; continue; }
    if (!isUpper(token[0]) || at('role', text, pos + w.index)) break;
    names.push(token);
    end = pos + w.index + token.length;
  }
  return [names, end];
}

function roles(t, has) {
  const text = t.text;
  const found = { court: new Set(), counsel: new Set(), official: new Set() };
  const surnames = { court: new Set(), counsel: new Set(), official: new Set() };
  const anonymized = new Set();
  const spans = [];
  for (const m of all('role', text)) {
    if (!VISIBLE.has(t.kind(m.index))) continue;     // a comment or a property makes no one public
    const category = ['court', 'counsel', 'official'].find((k) => m.groups[k] !== undefined);
    let pos = m.index + m[0].length;
    if (at('placeholder', text, pos) || at('initial', text, pos)) { anonymized.add(category); continue; }
    for (let i = 0; i < 8; i++) {
      const [names, end] = runs(text, pos);
      if (!names.length) break;
      // "…Kunz, Beschwerdeführer," and "avocat à Genève": common words are not names.
      if (!names.every((n) => has(n.toLowerCase()))) {
        for (const n of names) found[category].add(n);
        surnames[category].add(names[names.length - 1]);   // only the surname stands for the person elsewhere
      }
      spans.push([category, m.index, end]);
      const join = matchStart('run_join', text.slice(end, end + 20));
      if (!join || at('role', text, end + join[0].length)) break;
      pos = end + join[0].length;
    }
  }
  // The bench block at the head of a ruling: from "Besetzung", "Composition", "Siégeant" … to the
  // first party marker. Parties never stand in it; every capitalised word in it is the court's.
  for (const m of all('bench_open', text)) {
    if (!VISIBLE.has(t.kind(m.index))) continue;
    const start = m.index + m[0].length;
    let end = Math.min(text.length, start + 700, t.endOfKind(start));
    const close = P.bench_close.t.exec(text.slice(start, end));
    if (close) end = start + close.index;
    let run = [];
    let last = 0;
    for (const w of all('word', text.slice(start, end))) {
      const token = w[0];
      // A run of names ends at punctuation: "Wullschleger (Vorsitz)" is a name and an office.
      if (run.length && /[^\s-]/.test(text.slice(start + last, start + w.index))) {
        surnames.court.add(run[run.length - 1]);
        run = [];
      }
      last = w.index + token.length;
      if (TITLES.has(token.toLowerCase())) continue;
      if (at('role', text, start + w.index)) {          // "Bundesrichterin" is the office, not a name
        if (run.length) { surnames.court.add(run[run.length - 1]); run = []; }
        continue;
      }
      if (isUpper(token[0]) && !has(token.toLowerCase())) {
        found.court.add(token);
        run.push(token);
      } else if (run.length) {
        surnames.court.add(run[run.length - 1]);          // the last of a run of names is the surname
        run = [];
      }
    }
    if (run.length) surnames.court.add(run[run.length - 1]);
    spans.push(['court', start, end]);
  }
  for (const k of anonymized) { delete found[k]; delete surnames[k]; }
  return [found, surnames, anonymized, spans.filter(([k]) => !anonymized.has(k)).map(([, a, b]) => [a, b])];
}

export function check(parts, vocabulary) {
  const t = new Joined(parts);
  const text = t.text;
  const taken = new Spans();
  const explained = new Spans();
  const pub = {};
  const has = (w) => vocabulary.has(w);

  const placeholders = {};
  for (const m of all('placeholder', text)) {
    explained.add(m.index, m.index + m[0].length);
    bump(placeholders, m[0].replace(/_{2,}/g, '________'));
  }
  let initials = 0;
  for (const _ of all('initial', text)) initials++;      // eslint-disable-line no-unused-vars

  const shown = identifiers(t, taken, explained, pub);
  const [byOffice, officeSurnames, anonymizedRoles, officeSpans] = roles(t, has);
  for (const [a, b] of officeSpans) explained.add(a, b);
  const officeWords = new Map();
  for (const [k, ws] of Object.entries(officeSurnames)) for (const w of ws) officeWords.set(w.toLowerCase(), k);   // the later office wins, as in Python

  const counts = { common: 0, numbers: 0 };
  const inflected = [];                              // common words ending in s/es: "Müllers"
  const named = { court: new Set(), counsel: new Set(), official: new Set(), author: new Set(), case: new Set() };
  for (const [k, ws] of Object.entries(byOffice)) for (const w of ws) named[k].add(w);

  for (const m of all('word', text)) {
    const a = m.index;
    const token = m[0];
    const b = a + token.length;
    if (!isUpper(token[0]) || taken.overlaps(a, b) || explained.overlaps(a, b)) continue;
    const low = token.toLowerCase();
    const listed = ['', 's', 'es', 'n'].some((x) => has('!' + low.slice(0, low.length - x.length)));
    const title = token.length > 1 && token.slice(1) === token.slice(1).toLowerCase();
    if (has(low) || (!listed && compoundSplit(low, has))) {
      // "~saldo": ordinary in lower case; "Saldo" in mid-sentence is the name.
      if (!(title && has('~' + low) && !sentenceStart(text, a) && !test('det_before', text.slice(Math.max(0, a - 25), a)))) {
        counts.common++;
        if (low.endsWith('s')) inflected.push([a, b, token]);
        continue;
      }
    } else if (has('^' + low) && (test('det_before', text.slice(Math.max(0, a - 25), a)) || adjective(text, b, has))) {
      counts.common++;                                 // "^streit": "der Streit" is the noun, "Streit" alone the name
      continue;
    }
    if (officeWords.has(low)) { named[officeWords.get(low)].add(token); continue; }
    const after = text.slice(b, b + 90);
    if (matchStart('author_after', after) || cited(text, a, b)) { named.author.add(token); continue; }
    if (matchStart('case_after', after)) { named.case.add(token); continue; }
    shown.push({ kind: 'word', label: null, start: a, end: b, text: token });
  }

  // A common word whose stem is shown here is that name inflected ("Müllers" beside "Müller").
  const stems = new Set(shown.filter((x) => x.kind === 'word').map((x) => fold(x.text)));
  for (const [a, b, token] of inflected) {
    const k = fold(token);
    if (stems.has(k.slice(0, -1)) || (k.endsWith('es') && stems.has(k.slice(0, -2)))) {
      counts.common--;
      shown.push({ kind: 'word', label: null, start: a, end: b, text: token });
    }
  }

  for (const m of all('code', text)) {
    const a = m.index;
    let value = m[0];
    while (value && ".'’/-".includes(value[value.length - 1])) value = value.slice(0, -1);
    const b = a + value.length;
    if (!value || taken.overlaps(a, b) || explained.overlaps(a, b)) continue;
    if (digitsOf(value) <= 4 || matchStart('date', value) || matchStart('amount', value) ||
        matchStart('section', value) || matchStart('span', value) || matchStart('reference', value) ||
        test('ref_before', text.slice(Math.max(0, a - 40), a)) || test('docket_before', text.slice(Math.max(0, a - 12), a)) ||
        matchStart('unit_after', text.slice(b, b + 20))) {
      counts.numbers++;
      continue;
    }
    shown.push({ kind: 'number', label: null, start: a, end: b, text: value });
  }

  return assemble(t, shown, placeholders, initials, counts, named, pub, anonymizedRoles);
}

const byCodePoint = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

function assemble(t, shown, placeholders, initials, counts, named, pub, anonymizedRoles) {
  shown.sort((x, y) => x.start - y.start);
  const words = new Set(shown.filter((s) => s.kind === 'word').map((s) => fold(s.text)));

  const keyOf = (s) => {
    if (s.kind === 'word') {
      const k = fold(s.text);
      for (const suffix of ['s', 'es']) {
        if (k.endsWith(suffix) && words.has(k.slice(0, -suffix.length))) return 'w:' + k.slice(0, -suffix.length);
      }
      return 'w:' + k;
    }
    if (s.kind === 'identifier') return 'i:' + s.label + ':' + s.text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    return 'n:' + s.text;
  };

  const entries = new Map();
  for (const s of shown) {
    const k = keyOf(s);
    if (!entries.has(k)) entries.set(k, { key: k, kind: s.kind, label: s.label, occurrences: [] });
    const where = t.locate(s.start, s.end);
    where.text = s.text;
    where.visible = VISIBLE.has(t.kind(s.start));
    entries.get(k).occurrences.push(where);
  }

  const out = [];
  for (const e of entries.values()) {
    const forms = new Map();
    for (const o of e.occurrences) forms.set(o.text, (forms.get(o.text) || 0) + 1);
    let best = null;
    for (const [f, n] of forms) if (best === null || n > forms.get(best)) best = f;   // first seen wins a tie
    e.text = best;
    e.forms = [...forms.keys()].sort(byCodePoint);
    e.hidden = !e.occurrences.some((o) => o.visible);
    out.push(e);
  }
  out.sort((x, y) => RANK[x.kind] - RANK[y.kind] || x.occurrences[0].part - y.occurrences[0].part || x.occurrences[0].start - y.occurrences[0].start);
  out.forEach((e, i) => { e.id = i; });

  const anonymized = Object.values(placeholders).reduce((s, n) => s + n, 0) >= 3 || initials >= 5;
  const sortedNames = (set) => [...set].sort(byCodePoint);
  return {
    anonymized,
    placeholders: Object.fromEntries(Object.entries(placeholders).sort((x, y) => y[1] - x[1] || byCodePoint(x[0], y[0]))),
    entries: out,
    persons: persons(t, out),
    explained: {
      common: counts.common, numbers: counts.numbers,
      court: sortedNames(named.court), counsel: sortedNames(named.counsel), official: sortedNames(named.official),
      author: sortedNames(named.author), case: sortedNames(named.case),
      public: Object.fromEntries(Object.entries(pub).sort((x, y) => byCodePoint(x[0], y[0]))),
      anonymized_roles: [...anonymizedRoles].sort(byCodePoint),
    },
  };
}

// Shown words written next to each other ("Hans Müller") are one person.
function persons(t, entries) {
  const parent = entries.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const occ = [];
  for (const e of entries) {
    if (e.kind !== 'word') continue;
    for (const o of e.occurrences) occ.push([t.starts[o.part] + o.start, t.starts[o.part] + o.end, e.id]);
  }
  occ.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  for (let k = 0; k + 1 < occ.length; k++) {
    const [, b1, i] = occ[k];
    const [a2, , j] = occ[k + 1];
    if (i !== j && /^[ -]$/.test(t.text.slice(b1, a2))) parent[root(j)] = root(i);
  }
  const groups = new Map();
  for (const e of entries) {
    if (e.kind !== 'word') continue;
    const r = root(e.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e.id);
  }
  return [...groups.values()].sort((x, y) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}
