// The task pane. State lives in this module; the DOM is rebuilt from it with
// createElement and textContent only, so text from the draft is never parsed as HTML.
/* global Office */
import { fetchManifest, openIndex } from './index.js';
import { readDocx } from './docx.js';
import { checkDocument } from './check.js';
import { parseBgeKey } from './keys.js';
import * as word from './word.js';
import * as anon from './anon-pane.js';
import { LANGUAGES, courtName, formatDate, formatDateShort, formatNumber, language, setLanguage, t } from './i18n.js';

const INDEX_BASE = new URL('../index/', import.meta.url).href;
// Where a decision can be read. Used for links only: the pane never requests it; a
// click opens the address in the user's browser, like any link in a document.
const DECISION_BASE = 'https://mcp.opencaselaw.ch/entscheid/';
const STATUSES = ['found', 'differs', 'missing', 'unchecked'];
const $ = (id) => document.getElementById(id);

const state = {
  host: 'browser',          // 'word' | 'browser'
  index: null, manifest: null, listNote: null,
  file: null,               // outside Word: {name, paragraphs} of the chosen .docx
  result: null, filter: 'all', open: null,
  busy: false,
  mode: 'cites',            // 'cites' | 'anon'
};

// ── small DOM helpers ─────────────────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
const MARKS = {
  found: 'M3.5 8.5l3 3 6-7',
  differs: 'M3 6h10M3 10.5h10M10.5 2.5l-5 11',
  missing: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  unchecked: 'M3.5 8h9',
};
function mark(status) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', MARKS[status]);
  svg.append(path);
  return svg;
}

function alertUser(message) {
  $('alert').textContent = message || '';
  $('alert').hidden = !message;
}

function errorText(error, fallback = 'err_generic') {
  const key = { offline: 'err_offline', checksum: 'err_checksum', unsupported: 'err_unsupported', manifest: 'err_manifest' }[error && error.code];
  return key ? t(key) : t(fallback, { message: (error && error.message) || String(error) });
}

// ── what a finding says ───────────────────────────────────────────────────
function label(row, written) {
  const bge = parseBgeKey(row.key);
  if (!bge) return row.key;
  const collection = (/^(BGE|ATF|DTF)/.exec(written || '') || [])[1] || { fr: 'ATF', it: 'DTF' }[language()] || 'BGE';
  const part = { IA: 'Ia', IB: 'Ib' }[bge.part] || bge.part;
  return collection + ' ' + bge.volume + ' ' + part + ' ' + bge.page;
}

// A link to the decision, at the Erwägung when the list has it.
function decisionLink(row, text, pinpoint) {
  if (!row.id) return el('span', 'cite', text);
  const a = el('a', 'cite', text);
  // The cited number, or the first listed number below it (E. 3 when the list has 3.1, 3.2
  // and no line for 3 itself), the rule the check applies; none when neither is listed.
  const target = pinpoint && (row.enums.includes(pinpoint) ? pinpoint : row.enums.find((e) => e.startsWith(pinpoint) && /^[.a-z/]/.test(e.slice(pinpoint.length))));
  const anchor = target ? '#e-' + target.replace(/[^0-9a-z]+/g, '-') : '';
  a.href = DECISION_BASE + row.id.split('/').map(encodeURIComponent).join('/') + anchor;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = t('open_decision');
  return a;
}

const rowText = (row) => (row.date ? courtName(row) + ', ' + formatDate(row.date) : courtName(row));

function coverage(finding) {
  const court = finding.courtOfShape && state.manifest.courts && state.manifest.courts[finding.courtOfShape];
  if (!court || !court.first) return t('coverage_unknown');
  return t('coverage', {
    court: courtName({ court: finding.courtOfShape, canton: court.canton }), n: formatNumber(court.decisions),
    first: court.first.slice(0, 4), last: court.last.slice(0, 4),
  });
}

// The sentences of one finding, most important first.
function messages(f) {
  const out = [];
  if (f.status === 'missing') {
    // Only a neighbour the draft itself points to is named up front; mere nearness waits in the detail.
    const near = (f.suggestions || []).filter((s) => s.reason !== 'one_character').slice(0, 2).map((s) => label(s.row, f.text));
    out.push(t('not_in_list') + (near.length ? ' ' + t('similar') + ': ' + near.join(', ') + '.' : ''));
  }
  for (const issue of f.issues) {
    if (issue.kind === 'pinpoint') out.push(t('pin_absent', { pin: issue.written, nearby: issue.nearby.join(', ') + (issue.more ? ' …' : '') }));
    if (issue.kind === 'page') {
      out.push(issue.range.last === null || issue.written.every((p) => p < issue.range.first)
        ? t('page_before', { pages: issue.written.join(', '), first: issue.range.first })
        : t('page_outside', { pages: issue.written.join(', '), first: issue.range.first, last: issue.range.last }));
    }
    if (issue.kind === 'date_invalid') out.push(t('date_invalid', { written: issue.written }));
    if (issue.kind === 'date') out.push(t('date_differs', { written: formatDate(issue.written, { written: true }), listed: issue.listed.map((d) => formatDate(d)).join(', ') }));
    if (issue.kind === 'court') out.push(t('court_differs', { rows: issue.rows.map(rowText).join('; ') }));
  }
  if (f.status === 'unchecked') out.push(t(f.notes[0].kind === 'collection' ? 'collection' : 'unknown_shape'));
  if (f.rows.length && !f.issues.some((i) => i.kind === 'court')) {
    out.push(f.rows[0].date ? t('in_list', { court: courtName(f.rows[0]), date: formatDate(f.rows[0].date) }) : t('in_list_nodate', { court: courtName(f.rows[0]) }));
  }
  if (f.parsed && f.parsed.pinpoint && f.status !== 'missing' && !f.issues.some((i) => i.kind === 'pinpoint' || i.kind === 'court') &&
      !f.notes.some((n) => n.kind.startsWith('pinpoint_'))) out.push(t('pin_ok', { pin: f.parsed.pinpoint }));
  for (const note of f.notes) {
    if (note.kind === 'pinpoint_no_structure') out.push(t('pin_no_structure', { pin: note.written }));
    if (note.kind === 'pinpoint_parent_only') out.push(t('pin_parent_only', { pin: note.written, parent: note.parent }));
    if (note.kind === 'several') out.push(t('several', { rows: note.rows.map(rowText).join('; ') }));
    if (note.kind === 'page_inside') out.push(t('page_inside', { pages: note.written.join(', '), first: note.range.first, last: note.range.last }));
  }
  return out;
}

function suggestionText(f, s) {
  if (s.reason === 'contains_page') {
    const values = { page: f.parsed.bge.page, first: s.range.first, last: s.range.last };
    return s.range.last === null ? t('s_contains_page_open', values) : t('s_contains_page', values);
  }
  return t('s_' + s.reason);
}

const placeText = (f) => (f.where && f.where.part === 'footnote' ? t('footnote', { n: f.where.note + 1 })
  : f.where && f.where.part === 'endnote' ? t('endnote_n', { n: f.where.note + 1 }) : t('paragraph', { n: f.paragraph + 1 }));

// ── rendering ─────────────────────────────────────────────────────────────
function renderChrome() {
  document.documentElement.lang = language();
  const anonMode = state.mode === 'anon';
  document.title = anonMode ? t('a_title') : t('title');
  $('title').textContent = document.title;
  for (const [id, mode] of [['mode-cites', 'cites'], ['mode-anon', 'anon']]) {
    $(id).textContent = t(mode === 'cites' ? 'mode_cites' : 'mode_anon');
    $(id).setAttribute('aria-selected', String(state.mode === mode));
    $(id).tabIndex = state.mode === mode ? 0 : -1;
  }
  $('cite-head').hidden = $('cite-mode').hidden = anonMode;
  $('anon-head').hidden = $('anon-mode').hidden = !anonMode;
  $('check').textContent = state.busy === 'check' ? t('checking') : state.result ? t('recheck') : t('check');
  $('update').textContent = state.busy === 'update' ? t('updating') : t('update');
  $('check').disabled = Boolean(state.busy) || !state.index;
  $('update').disabled = Boolean(state.busy);
  $('paste').hidden = state.host === 'word';
  $('paste-label').textContent = t('paste_label');
  $('paste-hint').textContent = t('paste_hint');
  $('pick').textContent = t('pick_file');
  $('paste-label').hidden = $('paste-text').hidden = Boolean(state.file);
  $('file-line').textContent = state.file ? t('file_loaded', { name: state.file.name, n: formatNumber(state.file.paragraphs.length) }) : t('file_hint');
  $('privacy').textContent = anonMode ? t('a_privacy') : t('privacy');
  $('about-open').textContent = t('privacy_more');
  $('langs').setAttribute('aria-label', t('languages'));
  // Below 360px a menu stands in for the four buttons (the stylesheet shows one or the other).
  const menu = $('lang-select');
  menu.setAttribute('aria-label', t('languages'));
  if (!menu.options.length) {
    for (const code of LANGUAGES) { const o = el('option', null, code.toUpperCase()); o.value = code; menu.append(o); }
    menu.addEventListener('change', () => { setLanguage(menu.value); remember('language', menu.value); render(); });
  }
  menu.value = language();
  $('langs').replaceChildren(...LANGUAGES.map((code) => {
    const b = el('button', 'lang', code.toUpperCase());
    b.type = 'button';
    b.setAttribute('aria-pressed', String(code === language()));
    b.addEventListener('click', () => { setLanguage(code); remember('language', code); render(); });
    return b;
  }));
  if (state.manifest) {
    const m = state.manifest;
    $('list-line').textContent = m.sample
      ? t('list_sample', { n: formatNumber(m.decisions) })
      : t('list_of', { date: formatDate(m.generated) }) + '. ' + t('list_count', { n: formatNumber(m.decisions) }) + '.';
    $('list-line').classList.toggle('warn', Boolean(m.sample));
  }
  $('list-note').textContent = state.listNote ? t(state.listNote.key, state.listNote.values) : '';
  $('list-note').hidden = !state.listNote;
}

function renderResults() {
  const r = state.result;
  $('summary').hidden = $('results').hidden = !r || !r.findings.length;
  $('empty').hidden = Boolean(r && r.findings.length);
  if (!r || !r.findings.length) {
    $('empty-title').textContent = r ? t('none_title') : t('empty_title');
    $('empty-body').textContent = r ? t('none_body', { paragraphs: formatNumber(r.paragraphs) }) : t('empty_body');
    return;
  }
  const attention = r.counts.differs + r.counts.missing;
  $('verdict').textContent = attention ? t('summary_attention', { n: attention, total: r.findings.length }) : t('summary_clean', { n: r.findings.length });
  $('verdict').className = 'verdict ' + (attention ? 'verdict-attention' : 'verdict-clean');

  $('filters').replaceChildren(...['all', ...STATUSES].filter((s) => s === 'all' || r.counts[s]).map((s) => {
    const b = el('button', 'filter filter-' + s);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.filter === s));
    b.append(el('span', 'filter-n', String(s === 'all' ? r.findings.length : r.counts[s])), el('span', null, t(s)));
    b.addEventListener('click', () => { state.filter = s; state.open = null; renderResults(); });
    return b;
  }));

  const visible = r.findings.filter((f) => state.filter === 'all' || f.status === state.filter);
  $('margin').replaceChildren(...r.findings.map((f) => {
    const tick = el('span', 'tick tick-' + f.status + (f.id === state.open ? ' tick-open' : '') + (visible.includes(f) ? '' : ' tick-dim'));
    tick.style.top = (f.position * 100).toFixed(2) + '%';
    tick.addEventListener('click', () => openFinding(f.id, true));
    return tick;
  }));
  $('list').replaceChildren(...visible.map(renderFinding));
}

// The second line of a closed row: the result in short. "Gefunden · Bundesgericht · 17.01.2014";
// "Weicht ab: Erwägung, Datum" names what differs; the rest says its first sentence.
function compactLine(f, said) {
  const row = f.rows && f.rows[0];
  if (f.status === 'found' && row) return [t('found'), courtName(row), row.date ? formatDateShort(row.date) : null].filter(Boolean).join(' · ');
  if (f.status === 'differs' && f.issues.length) return t('differs') + ': ' + [...new Set(f.issues.map((i) => t('cat_' + i.kind)))].join(', ');
  return said[0] || '';
}

function renderFinding(f) {
  const open = f.id === state.open;
  const item = el('li', 'f f-' + f.status + (open ? ' f-open' : ''));
  item.id = 'f' + f.id;
  const said = messages(f);

  const head = el('button', 'f-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(mark(f.status), el('span', 'cite', f.text), el('span', 'f-line', compactLine(f, said)));
  head.addEventListener('click', () => openFinding(open ? null : f.id, false));
  item.append(head);
  if (!open) return item;

  const body = el('div', 'f-body');
  const context = el('p', 'ctx');
  const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');   // Word's footnote and comment marks
  context.append((f.context.before.length === 48 ? '… ' : '') + clean(f.context.before), el('mark', null, f.text), clean(f.context.after) + (f.context.after.length === 48 ? ' …' : ''));
  body.append(el('p', 'place', placeText(f)), context);
  // The row's second line said it in short; open, every sentence (the first again only where it was short).
  for (const sentence of (f.status === 'found' || f.status === 'differs' ? said : said.slice(1))) body.append(el('p', 'say', sentence));
  const readable = f.rows.filter((row) => row.id).slice(0, 3);
  if (readable.length) {
    const links = el('p', 'say open-links');
    readable.forEach((row, i) => {
      if (i) links.append(el('span', null, ', '));
      links.append(decisionLink(row, readable.length > 1 ? t('open_decision') + ' (' + rowText(row) + ')' : t('open_decision'), f.parsed && f.parsed.pinpoint));
    });
    body.append(links);
  }

  if (f.suggestions && f.suggestions.length) {
    body.append(el('p', 'sugg-title', t('similar')));
    const list = el('ul', 'sugg');
    for (const s of f.suggestions) {
      const li = el('li');
      li.append(decisionLink(s.row, label(s.row, f.text), f.parsed && f.parsed.pinpoint), el('span', 'sugg-why', rowText(s.row)), el('span', 'sugg-why', suggestionText(f, s)));
      list.append(li);
    }
    body.append(list);
  }
  if (f.status === 'missing') body.append(el('p', 'say coverage', coverage(f)));

  if (state.host === 'word') {
    const actions = el('div', 'f-actions');
    const showButton = el('button', 'quiet', t('show'));
    showButton.type = 'button';
    showButton.addEventListener('click', () => act(() => word.show(f)));
    actions.append(showButton);
    if (word.canComment() && f.status !== 'found') {
      const commentButton = el('button', 'quiet', t('comment'));
      commentButton.type = 'button';
      commentButton.addEventListener('click', async () => {
        const text = t('comment_prefix') + ' (' + formatDate(state.manifest.generated) + '): ' + said.join(' ') +
          (f.suggestions && f.suggestions.length ? ' ' + t('similar') + ': ' + f.suggestions.map((s) => label(s.row, f.text)).join(', ') + '.' : '');
        if (await act(() => word.comment(f, text))) { commentButton.textContent = t('commented'); commentButton.disabled = true; }
      });
      actions.append(commentButton);
    }
    body.append(actions);
  }
  item.append(body);
  return item;
}

function render() {
  renderChrome();
  if (state.mode === 'anon') anon.render(); else renderResults();
  renderAbout();
}

// The cite list (several MB) is loaded only when the cite check is used.
async function setMode(mode) {
  state.mode = mode;
  remember('mode', mode);
  render();
  if (mode === 'cites' && !state.index && !state.busy) await loadList(true);
}

function renderAbout() {
  $('about-title').textContent = t('about_title');
  $('about-1').textContent = t('about_1');
  $('about-2').textContent = t('about_2', { origin: location.origin });
  $('about-3').textContent = t('about_3');
  $('about-4').textContent = t('about_4');
  $('about-list-label').textContent = t('about_list');
  $('about-sha-label').textContent = t('about_sha');
  $('about-list').textContent = state.manifest ? state.manifest.file + ' (' + formatNumber(state.manifest.bytes) + ' B)' : '';
  $('about-sha').textContent = state.manifest ? state.manifest.sha256 : '';
  // What the last check took, stage by stage, on this computer: measured, not promised.
  const ms = (x) => (x === undefined ? '–' : formatNumber(Math.round(x)));
  const tm = state.mode === 'anon' ? anon.timings() : state.timings;
  $('about-timings-label').textContent = t('about_timings');
  $('about-timings').textContent = tm
    ? t(state.mode === 'anon' ? 'timings_anon' : 'timings_cites', Object.fromEntries(['read', 'list', 'words', 'check', 'render'].map((k) => [k, ms(tm[k])])))
    : '–';
  $('about-source').textContent = t('about_source');
  $('about-close').textContent = t('close');
}

// ── actions ───────────────────────────────────────────────────────────────
async function act(run) {
  alertUser('');
  try {
    const ok = await run();
    if (!ok) alertUser(t('show_failed'));
    return ok;
  } catch (error) {
    alertUser(errorText(error));
    return false;
  }
}

function openFinding(id, scroll) {
  state.open = id;
  const f = id === null ? null : state.result.findings[id];
  if (f && state.filter !== 'all' && f.status !== state.filter) state.filter = 'all';
  renderResults();
  if (!f) return;
  const node = $('f' + id);
  if (node && scroll) node.scrollIntoView({ block: 'nearest' });
  if (node) node.querySelector('.f-head').focus({ preventScroll: true });
  if (state.host === 'word') word.show(f).catch(() => {});
}

async function loadList(refresh) {
  state.busy = 'update';
  state.listNote = null;
  alertUser('');
  render();
  $('progress').hidden = true;
  try {
    const opened = await openIndex({
      base: INDEX_BASE, refresh,
      onProgress: (got, total) => {
        $('progress').hidden = false;
        $('bar').style.width = (total ? Math.min(100, (got / total) * 100) : 0) + '%';
        $('progress-text').textContent = t('loading') + ': ' + t('loading_progress', { got: (got / 1e6).toFixed(1), total: (total / 1e6).toFixed(1) });
      },
    });
    state.index = opened.index;
    state.manifest = opened.manifest;
    if (refresh && !opened.stale) state.askedAt = Date.now();
    const days = Math.floor((Date.now() - Date.parse(opened.manifest.generated)) / 86400000);
    if (opened.stale) state.listNote = { key: 'list_stale' };
    else if (!opened.persisted) state.listNote = { key: 'list_memory' };
    else if (days > 10 && !opened.manifest.sample) state.listNote = { key: 'list_old', values: { days } };
  } catch (error) {
    alertUser(errorText(error));
  } finally {
    $('progress').hidden = true;
    state.busy = false;
    render();
  }
}

async function runCheck() {
  // The draft is read while the list is asked about: two independent waits, run together.
  const t0 = performance.now();
  const reading = (async () => (state.host === 'word'
    ? word.readDocument()
    : state.file ? state.file.paragraphs
      : $('paste-text').value.split(/\n+/).map((text, index) => ({ text, where: { part: 'body', index } }))))()
    .then((paragraphs) => ({ paragraphs, ms: performance.now() - t0 }), (error) => ({ error }));
  // Every check first asks whether a newer list exists (a few KB); the list itself
  // is downloaded only when it changed. Unreachable: check with the list at hand.
  // Asked in the last ten minutes: the answer stands.
  if (!state.index || Date.now() - (state.askedAt || 0) > 600000) {
    try {
      const latest = await fetchManifest(INDEX_BASE);
      state.askedAt = Date.now();
      if (!state.manifest || latest.sha256 !== state.manifest.sha256) await loadList(true);
      else if (state.listNote && state.listNote.key === 'list_stale') state.listNote = null;
    } catch {
      if (state.index) state.listNote = { key: 'list_stale' };
    }
  }
  const listMs = performance.now() - t0;
  if (!state.index) return;
  state.busy = 'check';
  alertUser('');
  renderChrome();
  let t1;
  try {
    const read = await reading;
    if (read.error) {
      alertUser(errorText(read.error, 'err_read'));
      return;
    }
    t1 = performance.now();
    state.result = checkDocument(read.paragraphs, state.index);
    state.timings = { read: read.ms, list: listMs, check: performance.now() - t1 };
    state.filter = state.result.counts.differs + state.result.counts.missing ? state.filter : 'all';
    if (state.filter !== 'all' && !state.result.counts[state.filter]) state.filter = 'all';
    state.open = null;
  } finally {
    state.busy = false;
    const t2 = performance.now();
    render();
    if (state.timings && t1) state.timings.render = performance.now() - t2;
  }
}

// Outside Word: a .docx chosen or dropped is read in this page and checked at once.
async function takeFile(file) {
  if (!file) return;
  alertUser('');
  try {
    state.file = { name: file.name, paragraphs: await readDocx(await file.arrayBuffer()) };
    $('paste-text').value = '';
  } catch (error) {
    state.file = null;
    alertUser(t('err_docx', { message: (error && error.message) || String(error) }));
  }
  renderChrome();
  if (state.file && state.index) await runCheck();
}

// Remembered between sessions: the interface language, the mode and the placeholder style. Nothing about a document.
function remember(key, value) { try { localStorage.setItem('citecheck.' + key, value); } catch { /* private mode */ } }
function recall(key) { try { return localStorage.getItem('citecheck.' + key); } catch { return null; } }

async function start() {
  let info = null;
  if (typeof Office !== 'undefined' && Office.onReady) {
    info = await Promise.race([Office.onReady(), new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
  }
  state.host = info && info.host && word.inWord() ? 'word' : 'browser';
  const office = state.host === 'word' && Office.context ? Office.context.displayLanguage : null;
  // A link may name the language (?lang=fr, from the install page); a choice made in the pane wins.
  const linked = new URLSearchParams(location.search).get('lang');
  setLanguage(recall('language') || (LANGUAGES.includes(linked) ? linked : null) || office || navigator.language);

  // The ribbon has a button per check; "Anonymisierung prüfen" opens taskpane.html?mode=anon.
  const asked = new URLSearchParams(location.search).get('mode');
  // In Word the button says which check: "Zitate prüfen" opens the page without a mode, so it is
  // the cite check there, whatever was used last. In a browser the last mode is kept.
  state.mode = asked === 'anon' || asked === 'cites' ? asked
    : state.host === 'word' ? 'cites' : recall('mode') === 'anon' ? 'anon' : 'cites';
  anon.start(state.host);
  $('mode-cites').addEventListener('click', () => setMode('cites'));
  $('mode-anon').addEventListener('click', () => setMode('anon'));
  $('modes').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = state.mode === 'cites' ? 'anon' : 'cites';
    setMode(next).then(() => $(next === 'cites' ? 'mode-cites' : 'mode-anon').focus());
  });
  $('check').addEventListener('click', runCheck);
  $('update').addEventListener('click', () => loadList(true));
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => takeFile($('file').files[0]));
  $('paste-text').addEventListener('input', () => { if (state.file) { state.file = null; renderChrome(); } });
  const drop = $('drop');
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => takeFile(e.dataTransfer && e.dataTransfer.files[0]));
  $('about-open').addEventListener('click', () => { renderAbout(); $('about').showModal(); });
  $('about-close').addEventListener('click', () => $('about').close());
  render();
  if (state.mode === 'cites') await loadList(true);
}

start();
