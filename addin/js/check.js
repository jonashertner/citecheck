// Checks found references against the cite list. Pure functions: no DOM, no
// network, no Word. Every finding says what was compared and what the list
// holds; nothing here judges whether a decision supports the draft.
//
// status   found      the decision is in the list and nothing written contradicts it
//          differs    the decision is in the list, a written detail is not
//                     (Erwägung, page, date, court)
//          missing    nothing in the list under this label; near labels are offered
//          unchecked  looks like a reference, in a form the list cannot answer
import { bgeKey, docketKey, parseBgeKey } from './keys.js';
import { findCitations, findLoose, pinpointParent } from './parser.js';

const FEDERAL_FAMILY = new Set(['bger', 'bge', 'bge_egmr']);
const DIGITS = '0123456789';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BGE_PARTS = ['I', 'IA', 'IB', 'II', 'III', 'IV', 'V'];

function inScope(parsed, row) {
  if (parsed.courts.size) {
    if (parsed.courts.has(row.court)) return true;
    return [...parsed.courts].some((c) => FEDERAL_FAMILY.has(c)) && FEDERAL_FAMILY.has(row.court);
  }
  if (parsed.canton) return row.canton.toUpperCase() === parsed.canton || row.court.toLowerCase().startsWith(parsed.canton.toLowerCase() + '_');
  return true;
}

// Which court a label's shape belongs to, for the coverage note on a miss.
function courtOfShape(parsed) {
  if (parsed.bge && parsed.bgeFirst) return 'bge';
  const d = parsed.dockets[0] || '';
  if (/^\d[A-Z]{1,2}[ _.]\d{1,5}\/\d{4}$/.test(d)) return 'bger';
  if (/^[A-Z]{1,2}-\d{1,5}\/\d{4}$/.test(d)) return 'bvger';
  if (parsed.courts.size === 1) return [...parsed.courts][0];
  return null;
}

// Labels one typing error away: a wrong, missing, extra or swapped character.
function* oneEditAway(key) {
  const seen = new Set([key]);
  const emit = function* (candidate) {
    if (!seen.has(candidate)) { seen.add(candidate); yield candidate; }
  };
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    const pool = DIGITS.includes(c) ? DIGITS : LETTERS.includes(c) ? LETTERS : null;
    if (pool) for (const r of pool) yield* emit(key.slice(0, i) + r + key.slice(i + 1));
    if (pool) yield* emit(key.slice(0, i) + key.slice(i + 1));
    if (i + 1 < key.length && key[i + 1] !== c) yield* emit(key.slice(0, i) + key[i + 1] + c + key.slice(i + 2));
  }
  for (let i = 0; i <= key.length; i++) {
    const around = (key[i - 1] || '') + (key[i] || '');
    const pool = /\d/.test(around) ? DIGITS : /[A-Z]/.test(around) ? LETTERS : '';
    for (const r of pool) yield* emit(key.slice(0, i) + r + key.slice(i));
  }
}

// In a dense series nearly every number has neighbours one character away, so
// nearness alone says little. What the draft itself says decides the order: a
// neighbour with the written date first, then one that has the written Erwägung,
// then the court named. Without any of these the neighbours are only "similar".
function suggestDockets(index, key, parsed, { dateOnly = false } = {}) {
  const out = [];
  for (const candidate of oneEditAway(key)) {
    for (const row of index.lookup(candidate)) {
      const date = Boolean(parsed.date) && row.date === parsed.date;
      const pin = Boolean(parsed.pinpoint) && row.enums.some((e) => e === parsed.pinpoint || e.startsWith(parsed.pinpoint + '.'));
      if (dateOnly && !date) continue;
      out.push({ reason: date ? 'one_character_same_date' : 'one_character', row, score: (date ? 0 : 4) + (pin ? 0 : 2) + (inScope(parsed, row) ? 0 : 1) });
    }
  }
  out.sort((a, b) => a.score - b.score);
  const best = out.length && out[0].score < 4 ? out.filter((s) => s.score < 4) : out;
  return best.slice(0, 3).map(({ score, ...s }) => s);
}

function bgeRange(index, row) {
  const at = parseBgeKey(row.key);
  const next = parseBgeKey((index.neighbours(row.key).after || {}).key);
  const last = next && next.volume === at.volume && next.part === at.part ? next.page - 1 : null;
  return { first: at.page, last };
}

function suggestBge(index, parsed) {
  const { volume, part, page } = parsed.bge;
  const key = bgeKey(volume, part, page);
  const out = [];
  // The cited page may be the pinpoint page: the decision that contains it.
  const before = index.neighbours(key).before;
  const at = before && parseBgeKey(before.key);
  if (at && at.volume === volume && at.part === part.toUpperCase()) {
    const range = bgeRange(index, before);
    // The last decision of a part in the list has no known end: only a page close to its start counts.
    if (range.last === null ? page - range.first <= 40 : page <= range.last) out.push({ reason: 'contains_page', row: before, range });
  }
  for (const other of BGE_PARTS) {
    if (other === part.toUpperCase()) continue;
    for (const row of index.lookup(bgeKey(volume, other, page))) out.push({ reason: 'other_part', row });
  }
  const digits = String(volume).padStart(3, '0') + String(page).padStart(4, '0');
  for (const candidate of oneEditAway(digits)) {
    if (candidate.length !== 7 || /\D/.test(candidate)) continue;
    const k = bgeKey(candidate.slice(0, 3), part, candidate.slice(3));
    for (const row of index.lookup(k)) if (!out.some((o) => o.row.key === row.key)) out.push({ reason: 'one_character', row });
    if (out.length >= 6) break;
  }
  return out.slice(0, 4);
}

// The Erwägung against the decision's own numbering.
function checkPinpoint(pinpoint, rows) {
  const withNumbers = rows.filter((r) => r.enums.length);
  if (!withNumbers.length) return { state: 'no_structure' };
  // A published extract may list 4.1 and 4.2 without a line for 4 itself: a number
  // with listed sub-numbers exists.
  const covers = (e) => e === pinpoint || (e.startsWith(pinpoint) && /^[.a-z/]/.test(e.slice(pinpoint.length)));
  if (withNumbers.some((r) => r.enums.some(covers))) return { state: 'exists' };
  const parent = pinpointParent(pinpoint);
  if (parent && withNumbers.some((r) => r.enums.includes(parent))) return { state: 'parent_only', parent };
  // What the decision does have at that place: the siblings, or the top level.
  const stem = pinpoint.includes('.') ? pinpoint.slice(0, pinpoint.lastIndexOf('.') + 1) : '';
  const depth = pinpoint.split('.').length;
  const enums = withNumbers[0].enums;
  let nearby = enums.filter((e) => e.startsWith(stem) && e.split('.').length === depth);
  if (!nearby.length) nearby = enums.filter((e) => !e.includes('.'));
  return { state: 'absent', nearby: nearby.slice(0, 14), more: nearby.length > 14 };
}

function checkOne(index, parsed) {
  const useBge = parsed.bge && (parsed.bgeFirst || !parsed.dockets.length);
  const key = useBge ? bgeKey(parsed.bge.volume, parsed.bge.part, parsed.bge.page) : docketKey(parsed.dockets[0]);
  const all = index.lookup(key);
  const rows = all.filter((r) => inScope(parsed, r));
  const result = { key, label: useBge ? 'bge' : 'docket', status: 'found', rows, issues: [], notes: [] };

  if (!all.length) {
    result.status = 'missing';
    result.suggestions = useBge ? suggestBge(index, parsed) : suggestDockets(index, key, parsed);
    result.courtOfShape = courtOfShape(parsed);
    return result;
  }
  if (!rows.length) {
    result.rows = all;
    result.status = 'differs';
    result.issues.push({ kind: 'court', named: [...parsed.courts], canton: parsed.canton, rows: all });
    return result;
  }
  // 1 January is how the corpus writes a decision of which only the year is known.
  const dated = rows.filter((r) => r.date && !r.date.endsWith('-01-01'));
  if (parsed.date && !useBge && dated.length === rows.length && dated.every((r) => r.date !== parsed.date)) {
    result.status = 'differs';
    result.issues.push({ kind: 'date', written: parsed.date, listed: [...new Set(rows.map((r) => r.date))] });
    // The number may be the typing error, not the date: neighbours decided on the written date.
    result.suggestions = suggestDockets(index, key, parsed, { dateOnly: true });
  }
  if (parsed.pinpoint) {
    const pin = checkPinpoint(parsed.pinpoint, rows);
    if (pin.state === 'absent') {
      result.status = 'differs';
      result.issues.push({ kind: 'pinpoint', written: parsed.pinpoint, ...pin });
    } else if (pin.state !== 'exists') {
      result.notes.push({ kind: 'pinpoint_' + pin.state, written: parsed.pinpoint, parent: pin.parent });
    }
  }
  if (useBge && parsed.pages.length) {
    const range = bgeRange(index, rows[0]);
    const outside = parsed.pages.filter((p) => p < range.first || (range.last !== null && p > range.last));
    if (outside.length) {
      result.status = 'differs';
      result.issues.push({ kind: 'page', written: outside, range });
    }
  }
  if (rows.length > 1 && new Set(rows.map((r) => r.court + r.date)).size > 1) result.notes.push({ kind: 'several', rows });
  return result;
}

// paragraphs: [{text, where}] in reading order; `where` is opaque to this module.
// Returns {findings, counts, paragraphs}; a finding carries its place in the
// document (paragraph, start, end, position 0..1) and the check result.
export function checkDocument(paragraphs, index) {
  const texts = paragraphs.map((p) => p.text);
  const lengths = texts.map((t) => t.length + 1);
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const offsets = [];
  lengths.reduce((sum, n, i) => { offsets[i] = sum; return sum + n; }, 0);

  const found = findCitations(texts);
  const memo = new Map();
  const findings = found.map((f) => {
    const memoKey = f.text;
    if (!memo.has(memoKey)) memo.set(memoKey, checkOne(index, f.parsed));
    return { ...f, ...memo.get(memoKey) };
  });

  for (const loose of findLoose(texts, found)) {
    const rows = loose.collection ? [] : index.lookup(docketKey(loose.text));
    findings.push({
      ...loose, parsed: null, key: docketKey(loose.text), label: 'docket', rows, issues: [],
      status: rows.length ? 'found' : 'unchecked',
      notes: rows.length ? [] : [{ kind: loose.collection ? 'collection' : 'unknown_shape' }],
    });
  }

  findings.sort((a, b) => a.paragraph - b.paragraph || a.start - b.start);
  const nth = new Map();
  findings.forEach((f, i) => {
    f.id = i;
    f.where = paragraphs[f.paragraph].where;
    f.position = (offsets[f.paragraph] + f.start) / total;
    // Which occurrence of the written text within its paragraph, for selection.
    const k = f.paragraph + '\u0000' + f.text;
    f.nth = nth.get(k) || 0;
    nth.set(k, f.nth + 1);
    const text = texts[f.paragraph];
    f.context = { before: text.slice(Math.max(0, f.start - 48), f.start), after: text.slice(f.end, f.end + 48) };
  });
  const counts = { found: 0, differs: 0, missing: 0, unchecked: 0 };
  for (const f of findings) counts[f.status]++;
  return { findings, counts, paragraphs: paragraphs.length };
}
