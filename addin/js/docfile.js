// Everything a .docx carries, and the anonymized copy of it.
//
// readFile(buffer, name) reads every part a reader might not see: the body,
// footnotes, endnotes, headers and footers (what the reader sees), and comments,
// tracked deletions, hidden text, field codes, image descriptions, document
// properties, document variables, the template path, data that case-management
// systems store in customXml/, link targets and the file name (what the reader
// does not see). The anonymization check runs over all of it.
//
// anonymizedCopy(buffer, replacements) writes a new .docx: confirmed words
// replaced by placeholders wherever they are written, even across formatting
// runs; tracked changes accepted (deletions gone); comments, hidden text,
// properties, the page thumbnail, custom XML, document variables, the template
// path and building blocks removed. The open document is never touched.
//
// No library: the zip is read with the browser's DecompressionStream and
// written with CompressionStream; the XML is held in a small tree that
// serialises back byte for byte where nothing changed.

import { entries, readEntry, rawEntry } from './docx.js';

const encoder = new TextEncoder();

// ── a small XML tree ──────────────────────────────────────────────────────
const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^'">/]|\/(?!>))*)(\/?)>|[^<]+/g;

export function parseXml(xml) {
  const root = { t: 'el', name: '#root', attrs: '', kids: [], self: false };
  const stack = [root];
  XML_TOKEN.lastIndex = 0;
  for (let m; (m = XML_TOKEN.exec(xml));) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      const at = stack.map((e) => e.name).lastIndexOf(m[1]);
      if (at > 0) stack.length = at;            // closes the element and anything left open in it
    } else if (m[2] !== undefined) {
      const el = { t: 'el', name: m[2], attrs: m[3], kids: [], self: m[4] === '/' };
      top.kids.push(el);
      if (!el.self) stack.push(el);
    } else {
      top.kids.push({ t: m[0][0] === '<' ? 'raw' : 'text', raw: m[0] });
    }
  }
  return root;
}

export function serialize(node) {
  if (node.t === 'text' || node.t === 'raw') return node.raw;
  const inner = node.kids.map(serialize).join('');
  if (node.name === '#root') return inner;
  return node.self ? `<${node.name}${node.attrs}/>` : `<${node.name}${node.attrs}>${inner}</${node.name}>`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, n) => {
  if (n[0] !== '#') return ENTITIES[n] ?? all;
  const code = n[1] === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : all;
});
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

const textOf = (el) => unescape(el.kids.filter((k) => k.t === 'text').map((k) => k.raw).join(''));
function setText(el, s) {
  el.kids = s ? [{ t: 'text', raw: escapeText(s) }] : [];
  el.self = false;
  if (!/xml:space=/.test(el.attrs)) el.attrs += ' xml:space="preserve"';
}
// Attribute values in either quote: w:val="false" and w:val='false' are the same.
function attr(el, name) {
  const m = new RegExp(`\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(el.attrs);
  return m ? unescape(m[1] !== undefined ? m[1] : m[2]) : null;
}
function setAttr(el, name, value) {
  const re = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  if (re.test(el.attrs)) el.attrs = el.attrs.replace(re, `$1"${escapeAttr(value)}"`);
}
const kid = (el, name) => el.kids.find((k) => k.t === 'el' && k.name === name);

function walk(el, visit) {
  for (const k of el.kids) {
    if (k.t !== 'el') continue;
    if (visit(k) !== false) walk(k, visit);
  }
}

// WordprocessingML under another prefix ("q:p" for "w:p") is the same document: it is read
// and written under the usual "w:". A file that also uses "w:" for something else is refused.
const MAIN_NS = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*["'](?:http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/wordprocessingml\/main)["']/;
export function wordXml(xml) {
  const m = MAIN_NS.exec(xml);
  if (!m || m[1] === 'w') return xml;
  const p = m[1].replace(/[.]/g, '\\.');
  if (new RegExp(`xmlns:w\\s*=`).test(xml)) throw new Error('the Word namespace is under "' + m[1] + ':" and "w:" means something else: not supported');
  return xml.replace(/<[^>]*>/g, (tag) => tag
    .replace(new RegExp(`^<(/?)${p}:`), '<$1w:')
    .replace(new RegExp(`(\\s)${p}:`, 'g'), '$1w:')
    .replace(new RegExp(`xmlns:${p}(\\s*=)`), 'xmlns:w$1'));
}

// <w:vanish/> in run properties: true, false (w:val="0") or null (not said).
function vanish(props) {
  const v = props && kid(props, 'w:vanish');
  if (!v) return null;
  const val = attr(v, 'w:val');
  return val === null || !/^(?:0|false|off)$/i.test(val.trim());
}

// Whether a style hides its text, following basedOn: {id: true|false} for the styles that say so.
// Also the document's defaults: the default paragraph style (w:default="1"), which governs a
// paragraph that names none, and the run defaults under w:docDefaults.
function hiddenStyles(stylesXml) {
  const own = new Map();
  let defaultParagraph = null;
  let base = null;
  if (stylesXml) {
    walk(parseXml(wordXml(stylesXml)), (el) => {
      if (el.name === 'w:rPrDefault') { base = vanish(kid(el, 'w:rPr')); return false; }
      if (el.name !== 'w:style') return true;
      const based = kid(el, 'w:basedOn');
      own.set(attr(el, 'w:styleId'), { vanish: vanish(kid(el, 'w:rPr')), based: based ? attr(based, 'w:val') : null });
      if (attr(el, 'w:type') === 'paragraph' && /^(?:1|true|on)$/i.test(attr(el, 'w:default') || '')) defaultParagraph = attr(el, 'w:styleId');
      return false;
    });
  }
  const hidden = (id, depth = 0) => {
    const st = id && own.get(id);
    if (!st || depth > 20) return null;
    return st.vanish !== null ? st.vanish : hidden(st.based, depth + 1);
  };
  hidden.defaultParagraph = defaultParagraph;
  hidden.base = base;
  return hidden;
}

const NO_STYLES = Object.assign(() => null, { defaultParagraph: null, base: null });

// A run is hidden when its properties say <w:vanish/>, or else its character style,
// or else its paragraph's style: Word's order.
function hiddenRun(run, styles = NO_STYLES, paragraphStyle = null) {
  const props = kid(run, 'w:rPr');
  const direct = vanish(props);
  if (direct !== null) return direct;
  const rStyle = props && kid(props, 'w:rStyle');
  const byRun = rStyle ? styles(attr(rStyle, 'w:val')) : null;
  if (byRun !== null) return byRun;
  const byParagraph = styles(paragraphStyle || styles.defaultParagraph);
  if (byParagraph !== null) return byParagraph;
  return Boolean(styles.base);
}

const paragraphStyleOf = (p) => {
  const pPr = kid(p, 'w:pPr');
  const ps = pPr && kid(pPr, 'w:pStyle');
  return ps ? attr(ps, 'w:val') : null;
};

// ── reading ───────────────────────────────────────────────────────────────
const TEXT_PARTS = [
  [/^word\/document\.xml$/, 'body'],
  [/^word\/footnotes\.xml$/, 'footnote'],
  [/^word\/endnotes\.xml$/, 'endnote'],
  [/^word\/header\d*\.xml$/, 'header'],
  [/^word\/footer\d*\.xml$/, 'footer'],
  [/^word\/comments\.xml$/, 'comment'],
];
const NOTE_TYPES = /w:type="(?:separator|continuationSeparator|continuationNotice)"/;

// The paragraphs of one part: what is shown, what is hidden, what was deleted.
function paragraphs(tree, styles) {
  const out = [];
  const note = { n: -1, at: null, paras: 0 };
  const visit = (el, para, state) => {
    for (const k of el.kids) {
      if (k.t !== 'el') continue;
      if ((k.name === 'w:footnote' || k.name === 'w:endnote' || k.name === 'w:comment')) {
        if (NOTE_TYPES.test(k.attrs)) continue;
        note.n++;
        visit(k, para, { ...state, note: note.n, author: attr(k, 'w:author') });
        continue;
      }
      if (k.name === 'w:p') {
        const inNote = state.note === null ? out.length : (note.paras = (note.at === state.note ? note.paras + 1 : 0), note.at = state.note, note.paras);
        const p = { shown: '', hidden: '', deleted: '', fields: '', note: state.note, author: state.author, inNote, seq: out.length };
        out.push(p);
        visit(k, p, { ...state, pStyle: paragraphStyleOf(k) });
        continue;
      }
      if (!para) { visit(k, para, state); continue; }
      if (k.name === 'w:del' || k.name === 'w:moveFrom') { visit(k, para, { ...state, deleted: true }); continue; }
      if (k.name === 'w:r') { visit(k, para, { ...state, hidden: state.hidden || hiddenRun(k, styles, state.pStyle) }); continue; }
      if (k.name === 'w:t' || k.name === 'w:delText') {
        const s = textOf(k);
        if (state.deleted || k.name === 'w:delText') para.deleted += s;
        else if (state.hidden) para.hidden += s;
        else para.shown += s;
        continue;
      }
      if (k.name === 'w:instrText') { para.fields += textOf(k) + ' '; continue; }
      if (k.name === 'w:fldSimple') para.fields += (attr(k, 'w:instr') || '') + ' ';      // and its result text below
      if (!state.deleted && !state.hidden) {
        if (k.name === 'w:tab') para.shown += '\t';
        else if (k.name === 'w:br' || k.name === 'w:cr') para.shown += ' ';
        else if (k.name === 'w:noBreakHyphen') para.shown += '\u2011';
      }
      visit(k, para, state);
    }
  };
  visit(tree, null, { deleted: false, hidden: false, note: null, author: null, pStyle: null });
  return out;
}

// A link target as a reader would read it: "Emma%20Muster" is "Emma Muster".
function readableTarget(target) {
  try { return decodeURIComponent(target); } catch { return target; }
}

// The target as read, and for each character read, the stretch of the raw target it came from
// ("%C3%BC" is one "ü"). An invalid escape is read as it stands.
function decodeWithSpans(raw) {
  let text = '';
  const spans = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '%' && /^%[0-9A-Fa-f]{2}/.test(raw.slice(i))) {
      const lead = parseInt(raw.slice(i + 1, i + 3), 16);
      const n = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
      const piece = raw.slice(i, i + 3 * n);
      if (n && new RegExp(`^(?:%[0-9A-Fa-f]{2}){${n}}$`).test(piece)) {
        try {
          const ch = decodeURIComponent(piece);
          for (let k = 0; k < ch.length; k++) spans.push([i, i + piece.length]);
          text += ch;
          i += piece.length;
          continue;
        } catch { /* an invalid sequence: read as it stands */ }
      }
    }
    spans.push([i, i + 1]);
    text += raw[i];
    i++;
  }
  return { text, spans };
}

// The target with the confirmed names replaced where they stand, the rest of it byte for byte:
// "%2F", "%26", "%3D" stay escaped, so the link still means what it meant.
function replaceTarget(target, pats) {
  const { text, spans } = decodeWithSpans(target);
  const hits = [];
  for (const pat of pats) for (const m of text.matchAll(pat.re)) hits.push([m.index, m.index + m[0].length, pat.placeholder]);
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  let end = 0;
  for (const [a, b, placeholder] of hits) {
    if (a < end || a === b) continue;
    out += target.slice(at, spans[a][0]) + encodeURIComponent(placeholder);
    at = spans[b - 1][1];
    end = b;
  }
  return out + target.slice(at);
}

const PROPERTIES = {
  'docProps/core.xml': ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:keywords', 'dc:description', 'cp:category', 'cp:contentStatus'],
  'docProps/app.xml': ['Company', 'Manager', 'HyperlinkBase'],
};

// For each header and footer file, the first section that uses it and how
// ({'word/header2.xml': {section: 1, type: 'default'}}), for showing a place in Word.
async function headerSections(buffer, zip) {
  const out = {};
  if (!zip.has('word/_rels/document.xml.rels')) return out;
  const targets = {};
  walk(parseXml(await readEntry(buffer, zip.get('word/_rels/document.xml.rels'))), (el) => {
    if (el.name === 'Relationship') targets[attr(el, 'Id')] = resolve('word/_rels/document.xml.rels', attr(el, 'Target') || '');
  });
  let section = 0;
  walk(parseXml(wordXml(await readEntry(buffer, zip.get('word/document.xml')))), (el) => {
    if (el.name !== 'w:sectPr') return true;
    for (const k of el.kids) {
      if (k.t !== 'el' || (k.name !== 'w:headerReference' && k.name !== 'w:footerReference')) continue;
      const file = targets[attr(k, 'r:id')];
      if (file && !(file in out)) out[file] = { section, type: attr(k, 'w:type') || 'default' };
    }
    section++;
    return false;
  });
  return out;
}

// [{text, where}] in reading order: what the reader sees first, then what the file carries besides.
export async function readFile(buffer, name = '') {
  const zip = entries(buffer);
  if (!zip.has('word/document.xml')) throw new Error('no word/document.xml: not a Word document');
  const shown = [];
  const besides = [];
  const add = (list, text, where) => { if (text && /[\p{L}\p{N}]/u.test(text)) list.push({ text, where }); };
  const order = (n) => TEXT_PARTS.findIndex(([re]) => re.test(n));
  const parts = [...zip.keys()].filter((n) => order(n) >= 0).sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'en', { numeric: true }));
  const styles = hiddenStyles(zip.has('word/styles.xml') ? await readEntry(buffer, zip.get('word/styles.xml')) : null);

  for (const file of parts) {
    const kind = TEXT_PARTS[order(file)][1];
    const tree = parseXml(wordXml(await readEntry(buffer, zip.get(file))));
    paragraphs(tree, styles).forEach((p, index) => {
      // In a note, `index` counts the note's own paragraphs, as Word's notes collection does.
      const where = p.note !== null && p.note !== undefined && kind !== 'comment'
        ? { part: kind, file, note: p.note, index: p.inNote, seq: p.seq }
        : { part: kind, file, index, seq: p.seq };
      if (kind === 'comment') add(besides, p.shown, { part: 'comment', file, index, note: p.note });
      else { shown.push({ text: p.shown, where }); }
      add(besides, p.hidden, { part: 'hidden', of: kind, file, index });
      add(besides, p.deleted, { part: 'deleted', of: kind, file, index });
      // Field codes: keywords (MERGEFIELD, HYPERLINK) and switches (\\* MERGEFORMAT) are Word's, the rest may be data.
      add(besides, p.fields.replace(/\\[*@#!a-z]\s*\S*|"[^"]*\.dot[mx]?"|(?<![\p{L}\p{N}_])[A-Z]{2,}(?![\p{L}\p{N}_])/gu, ' ').replace(/\s+/g, ' ').trim(),
        { part: 'field', of: kind, file, index });
    });
    walk(tree, (el) => {
      if (el.name === 'wp:docPr' || el.name === 'pic:cNvPr') {
        for (const a of ['descr', 'title']) add(besides, attr(el, a), { part: 'alt', file });
      }
      if (el.name === 'w:del' || el.name === 'w:ins' || el.name === 'w:comment') add(besides, attr(el, 'w:author'), { part: 'property', name: 'author of a change', file });
      // A content control's name and tag: set by a template or a case-management system.
      if (el.name === 'w:alias' || el.name === 'w:tag') add(besides, attr(el, 'w:val'), { part: 'property', name: 'content control', file });
    });
  }
  for (const [file, names] of Object.entries(PROPERTIES)) {
    if (!zip.has(file)) continue;
    const tree = parseXml(await readEntry(buffer, zip.get(file)));
    walk(tree, (el) => { if (names.includes(el.name)) add(besides, textOf(el), { part: 'property', name: el.name.replace(/^\w+:/, ''), file }); });
  }
  if (zip.has('docProps/custom.xml')) {
    const tree = parseXml(await readEntry(buffer, zip.get('docProps/custom.xml')));
    walk(tree, (el) => {
      if (el.name === 'property') {
        const value = []; walk(el, (v) => { value.push(textOf(v)); });
        add(besides, value.join(' ').trim(), { part: 'property', name: attr(el, 'name') || 'custom', file: 'docProps/custom.xml' });
        return false;
      }
    });
  }
  if (zip.has('word/settings.xml')) {
    const tree = parseXml(wordXml(await readEntry(buffer, zip.get('word/settings.xml'))));
    walk(tree, (el) => { if (el.name === 'w:docVar') add(besides, attr(el, 'w:val'), { part: 'property', name: attr(el, 'w:name') || 'variable', file: 'word/settings.xml' }); });
  }
  for (const [file, entry] of zip) {
    if (/^customXml\/item\d+\.xml$/.test(file)) {
      const text = unescape((await readEntry(buffer, entry)).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      add(besides, text, { part: 'custom', file });
    }
    if (/_rels\/[^/]*\.rels$/.test(file)) {
      walk(parseXml(await readEntry(buffer, entry)), (el) => {
        const target = el.name === 'Relationship' && attr(el, 'Target');
        // Where links lead (mailto:, https://…) and the template's path: not shown on the page.
        if (target && (attr(el, 'TargetMode') === 'External' || /^mailto:/i.test(target) || /attachedTemplate$/.test(attr(el, 'Type') || ''))) add(besides, readableTarget(target), { part: 'link', file });
      });
    }
  }
  add(besides, name.replace(/\.docx$/i, ''), { part: 'filename' });
  const files = [...zip.keys()];
  return {
    parts: [...shown, ...besides],
    sections: await headerSections(buffer, zip),
    notes: {
      images: files.filter((f) => /^word\/media\//.test(f)).length,
      embedded: files.filter((f) => /^word\/embeddings\//.test(f)).length,
      thumbnail: files.some((f) => /^docProps\/thumbnail\./.test(f)),
    },
  };
}

// ── the anonymized copy ───────────────────────────────────────────────────
const REMOVE_ELEMENTS = new Set(['w:del', 'w:moveFrom', 'w:moveFromRangeStart', 'w:moveFromRangeEnd', 'w:moveToRangeStart',
  'w:moveToRangeEnd', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:rPrChange', 'w:pPrChange', 'w:sectPrChange',
  'w:tblPrChange', 'w:tblGridChange', 'w:trPrChange', 'w:tcPrChange', 'w:numberingChange', 'w:docVars',
  'w:attachedTemplate', 'w:trackRevisions', 'w:proofState', 'w:alias', 'w:tag', 'w:dataBinding']);
const UNWRAP_ELEMENTS = new Set(['w:ins', 'w:moveTo']);
const REMOVE_PARTS = /^(?:word\/comments(?:Extended|Ids|Extensible)?\.xml|word\/people\.xml|docProps\/thumbnail\.\w+|docProps\/custom\.xml|customXml\/.*|word\/glossary\/.*|word\/_rels\/comments.*|word\/_rels\/people.*)$/;
const BLANK_PROPERTIES = new Set([...PROPERTIES['docProps/core.xml'], ...PROPERTIES['docProps/app.xml']]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Field codes and link targets have no place in a paragraph: there the forms are replaced
// wherever they stand as words, and runs of them ("Hans Müller") as one.
function patterns(replacements) {
  return replacements.filter((r) => r.forms && r.forms.length).map((r) => {
    const any = [...new Set(r.forms)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    return { re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${any})(?:[ \\u00a0\\-\u2011](?:${any}))*(?![\\p{L}\\p{N}])`, 'gu'), placeholder: r.placeholder };
  });
}

const replaceAll = (s, pats) => pats.reduce((acc, p) => acc.replace(p.re, p.placeholder), s);

// Removes and unwraps in place: tracked changes accepted, comments and hidden runs gone
// (hidden by their own properties or by a style).
function clean(el, styles, pStyle = null) {
  const kids = [];
  for (const k of el.kids) {
    if (k.t !== 'el') { kids.push(k); continue; }
    if (REMOVE_ELEMENTS.has(k.name)) continue;
    if (k.name === 'w:r' && (hiddenRun(k, styles, pStyle) || kid(k, 'w:commentReference'))) continue;
    clean(k, styles, k.name === 'w:p' ? paragraphStyleOf(k) : pStyle);
    if (UNWRAP_ELEMENTS.has(k.name)) kids.push(...k.kids);
    else kids.push(k);
  }
  el.kids = kids;
}

// The paragraph's text as the reader built it: w:t nodes, and tabs, breaks and
// non-breaking hyphens as one character each that belongs to no node.
function segments(p) {
  const out = [];
  let pos = 0;
  walk(p, (el) => {
    if (el.name === 'w:p') return false;               // a nested paragraph (text box) is its own
    let text = null;
    if (el.name === 'w:t') text = textOf(el);
    else if (el.name === 'w:tab') text = '\t';
    else if (el.name === 'w:br' || el.name === 'w:cr') text = ' ';
    else if (el.name === 'w:noBreakHyphen') text = '\u2011';
    if (text !== null) { out.push({ node: el.name === 'w:t' ? el : null, el, start: pos, text }); pos += text.length; }
    return el.name !== 'w:t';
  });
  return out;
}

// Puts the placeholder at exactly the places the check showed, across formatting runs
// ("Mül" + "ler"): the first text node of the place takes it, the rest of the place is cut.
// A place is replaced only where the paragraph still reads, there, what the check showed.
function replacePlaces(p, places, ledger) {
  const shown = segments(p).map((seg) => seg.text).join('');
  for (const place of [...places].sort((a, b) => b.start - a.start)) {
    if (place.text !== undefined && shown.slice(place.start, place.end) !== place.text) {
      if (ledger) ledger.skipped.push(place);
      continue;
    }
    if (ledger) ledger.replaced++;
    let put = false;
    for (const seg of segments(p)) {
      const s = Math.max(place.start, seg.start);
      const e = Math.min(place.end, seg.start + seg.text.length);
      if (s >= e) continue;
      if (!seg.node) {
        // A non-breaking hyphen inside the name ("Müller‑Meier") goes with it: an empty text node in its place.
        if (seg.el.name === 'w:noBreakHyphen' && s === seg.start && e === seg.start + seg.text.length) {
          Object.assign(seg.el, { name: 'w:t', attrs: '', kids: [], self: true });
        }
        continue;
      }
      const text = textOf(seg.node);
      const a = s - seg.start;
      const b = e - seg.start;
      setText(seg.node, text.slice(0, a) + (put ? '' : place.placeholder) + text.slice(b));
      put = true;
    }
  }
}

function anonymizePart(xml, pats, places, styles, ledger) {
  const tree = parseXml(wordXml(xml));
  // Paragraphs are numbered as the reader numbered them, before cleaning removes any (a hidden
  // text box inside a paragraph): a place stays with its own paragraph, never the next one.
  const bySeq = [];
  walk(tree, (el) => {
    // Separator notes are not paragraphs of the text; the reader skips them too.
    if ((el.name === 'w:footnote' || el.name === 'w:endnote') && NOTE_TYPES.test(el.attrs)) return false;
    if (el.name === 'w:p') bySeq.push(el);
    return true;
  });
  clean(tree, styles);
  for (const [seq, here] of places) {
    if (bySeq[seq]) replacePlaces(bySeq[seq], here, ledger);
    else if (ledger) ledger.skipped.push(...here);
  }
  walk(tree, (el) => {
    if (el.name === 'w:instrText') setText(el, replaceAll(textOf(el), pats));
    if (el.name === 'w:fldSimple' && attr(el, 'w:instr') !== null) setAttr(el, 'w:instr', replaceAll(attr(el, 'w:instr'), pats));
    if (el.name === 'wp:docPr' || el.name === 'pic:cNvPr') { setAttr(el, 'descr', ''); setAttr(el, 'title', ''); }
    return true;
  });
  return serialize(tree);
}

function resolve(from, target) {
  const parts = from.split('/').slice(0, -2);                 // word/_rels/document.xml.rels -> word
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return target.startsWith('/') ? target.slice(1) : parts.join('/');
}

// replacements: [{placeholder: 'A.________', places: [{file, seq, start, end, text}], forms: ['Hans', 'Müller']}]
// `ledger` ({replaced: 0, skipped: []}), when given, counts the places replaced and lists those
// whose paragraph no longer read `text` there (left untouched).
// `places` are where the check showed the person (file, paragraph sequence, offsets in its text);
// `forms` serve field codes and link targets, which have no place in a paragraph.
export async function anonymizedCopy(buffer, replacements, ledger = null) {
  const zip = entries(buffer);
  const pats = patterns(replacements);
  const places = new Map();                           // file -> seq -> [{start, end, placeholder}]
  for (const r of replacements) {
    for (const pl of r.places || []) {
      if (!places.has(pl.file)) places.set(pl.file, new Map());
      const bySeq = places.get(pl.file);
      if (!bySeq.has(pl.seq)) bySeq.set(pl.seq, []);
      bySeq.get(pl.seq).push({ start: pl.start, end: pl.end, text: pl.text, placeholder: r.placeholder });
    }
  }
  const removed = new Set([...zip.keys()].filter((n) => REMOVE_PARTS.test(n)));
  const changed = new Map();
  const styles = hiddenStyles(zip.has('word/styles.xml') ? await readEntry(buffer, zip.get('word/styles.xml')) : null);

  for (const [file, entry] of zip) {
    if (removed.has(file)) continue;
    if (TEXT_PARTS.some(([re, kind]) => kind !== 'comment' && re.test(file)) || file === 'word/settings.xml') {
      changed.set(file, anonymizePart(await readEntry(buffer, entry), pats, places.get(file) || new Map(), styles, ledger));
    } else if (PROPERTIES[file]) {
      const tree = parseXml(await readEntry(buffer, entry));
      walk(tree, (el) => { if (BLANK_PROPERTIES.has(el.name)) { el.kids = []; } return true; });
      changed.set(file, serialize(tree));
    } else if (/_rels\/[^/]*\.rels$/.test(file)) {
      const tree = parseXml(await readEntry(buffer, entry));
      tree.kids.forEach((root) => {
        if (root.t !== 'el') return;
        root.kids = root.kids.filter((rel) => {
          if (rel.t !== 'el' || rel.name !== 'Relationship') return true;
          const target = attr(rel, 'Target') || '';
          if (/attachedTemplate$/.test(attr(rel, 'Type') || '')) return false;
          if (attr(rel, 'TargetMode') !== 'External' && removed.has(resolve(file, target))) return false;
          if (attr(rel, 'TargetMode') === 'External' || /^mailto:/i.test(target)) setAttr(rel, 'Target', replaceTarget(target, pats));
          return true;
        });
      });
      changed.set(file, serialize(tree));
    } else if (file === '[Content_Types].xml') {
      const tree = parseXml(await readEntry(buffer, entry));
      tree.kids.forEach((root) => {
        if (root.t !== 'el') return;
        root.kids = root.kids.filter((o) => !(o.t === 'el' && o.name === 'Override' && removed.has((attr(o, 'PartName') || '').replace(/^\//, ''))));
      });
      changed.set(file, serialize(tree));
    }
  }
  return writeZip(buffer, zip, removed, changed);
}

// ── zip writing ───────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function writeZip(buffer, zip, removed, changed) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, entry] of zip) {
    if (removed.has(name)) continue;
    let data; let crc; let size; let method;
    if (changed.has(name)) {
      const plain = encoder.encode(changed.get(name));
      data = await deflate(plain); crc = crc32(plain); size = plain.length; method = 8;
    } else {
      data = rawEntry(buffer, entry); crc = entry.crc; size = entry.size; method = entry.method;
    }
    const nameBytes = encoder.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, 0, true); local.setUint16(12, 0x0021, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true); head.setUint16(8, 0x0800, true);
    head.setUint16(10, method, true); head.setUint16(12, 0, true); head.setUint16(14, 0x0021, true);
    head.setUint32(16, crc, true); head.setUint32(20, data.length, true); head.setUint32(24, size, true);
    head.setUint16(28, nameBytes.length, true); head.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(head.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = central.length / 2;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out.buffer;
}

// The copy against what it must be, independently of the check: every visible paragraph of the
// original, with exactly the ticked places replaced and nothing else changed. Paragraphs that are
// empty in either (a hidden text box, cleaned away) are left out. Returns the paragraphs that differ.
const VISIBLE_KINDS = new Set(['body', 'footnote', 'endnote', 'header', 'footer']);
export function verifyCopy(original, copy, replacements) {
  const at = new Map();                                   // file|seq -> [{start, end, placeholder}]
  for (const r of replacements) {
    for (const pl of r.places || []) {
      const key = pl.file + '|' + pl.seq;
      if (!at.has(key)) at.set(key, []);
      at.get(key).push({ ...pl, placeholder: r.placeholder });
    }
  }
  const byFile = (parts, expected) => {
    const files = new Map();
    for (const p of parts) {
      if (!VISIBLE_KINDS.has(p.where.part)) continue;
      let text = p.text;
      if (expected) {
        for (const pl of (at.get(p.where.file + '|' + p.where.seq) || []).sort((a, b) => b.start - a.start)) {
          text = text.slice(0, pl.start) + pl.placeholder + text.slice(pl.end);
        }
      }
      if (!text.trim()) continue;
      if (!files.has(p.where.file)) files.set(p.where.file, []);
      files.get(p.where.file).push(text);
    }
    return files;
  };
  const want = byFile(original.parts, true);
  const got = byFile(copy.parts, false);
  const differ = [];
  for (const file of new Set([...want.keys(), ...got.keys()])) {
    const a = want.get(file) || [];
    const b = got.get(file) || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) differ.push({ file, index: i, expected: a[i], actual: b[i] });
    }
  }
  return differ;
}
