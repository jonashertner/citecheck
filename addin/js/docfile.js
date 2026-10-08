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
function attr(el, name) {
  const m = new RegExp(`\\s${name.replace(/[.:]/g, '\\$&')}="([^"]*)"`).exec(el.attrs);
  return m ? unescape(m[1]) : null;
}
function setAttr(el, name, value) {
  const re = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}=")[^"]*(")`);
  if (re.test(el.attrs)) el.attrs = el.attrs.replace(re, `$1${escapeAttr(value)}$2`);
}
const kid = (el, name) => el.kids.find((k) => k.t === 'el' && k.name === name);

function walk(el, visit) {
  for (const k of el.kids) {
    if (k.t !== 'el') continue;
    if (visit(k) !== false) walk(k, visit);
  }
}

// A run is hidden when its properties say <w:vanish/> (and not w:val="0"/"false").
function hiddenRun(run) {
  const props = kid(run, 'w:rPr');
  const v = props && kid(props, 'w:vanish');
  return Boolean(v) && !/w:val="(?:0|false|off)"/.test(v.attrs);
}

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
function paragraphs(tree) {
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
        visit(k, p, state);
        continue;
      }
      if (!para) { visit(k, para, state); continue; }
      if (k.name === 'w:del' || k.name === 'w:moveFrom') { visit(k, para, { ...state, deleted: true }); continue; }
      if (k.name === 'w:r') { visit(k, para, { ...state, hidden: state.hidden || hiddenRun(k) }); continue; }
      if (k.name === 'w:t' || k.name === 'w:delText') {
        const s = textOf(k);
        if (state.deleted || k.name === 'w:delText') para.deleted += s;
        else if (state.hidden) para.hidden += s;
        else para.shown += s;
        continue;
      }
      if (k.name === 'w:instrText') { para.fields += textOf(k) + ' '; continue; }
      if (!state.deleted && !state.hidden) {
        if (k.name === 'w:tab') para.shown += '\t';
        else if (k.name === 'w:br' || k.name === 'w:cr') para.shown += ' ';
        else if (k.name === 'w:noBreakHyphen') para.shown += '\u2011';
      }
      visit(k, para, state);
    }
  };
  visit(tree, null, { deleted: false, hidden: false, note: null, author: null });
  return out;
}

const PROPERTIES = {
  'docProps/core.xml': ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:keywords', 'dc:description', 'cp:category', 'cp:contentStatus'],
  'docProps/app.xml': ['Company', 'Manager', 'HyperlinkBase'],
};

// [{text, where}] in reading order: what the reader sees first, then what the file carries besides.
export async function readFile(buffer, name = '') {
  const zip = entries(buffer);
  if (!zip.has('word/document.xml')) throw new Error('no word/document.xml: not a Word document');
  const shown = [];
  const besides = [];
  const add = (list, text, where) => { if (text && /[\p{L}\p{N}]/u.test(text)) list.push({ text, where }); };
  const order = (n) => TEXT_PARTS.findIndex(([re]) => re.test(n));
  const parts = [...zip.keys()].filter((n) => order(n) >= 0).sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'en', { numeric: true }));

  for (const file of parts) {
    const kind = TEXT_PARTS[order(file)][1];
    const tree = parseXml(await readEntry(buffer, zip.get(file)));
    paragraphs(tree).forEach((p, index) => {
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
    const tree = parseXml(await readEntry(buffer, zip.get('word/settings.xml')));
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
        if (target && (/^mailto:/i.test(target) || /attachedTemplate$/.test(attr(el, 'Type') || ''))) add(besides, target, { part: 'link', file });
      });
    }
  }
  add(besides, name.replace(/\.docx$/i, ''), { part: 'filename' });
  const files = [...zip.keys()];
  return {
    parts: [...shown, ...besides],
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
  'w:attachedTemplate', 'w:trackRevisions', 'w:proofState']);
const UNWRAP_ELEMENTS = new Set(['w:ins', 'w:moveTo']);
const REMOVE_PARTS = /^(?:word\/comments(?:Extended|Ids|Extensible)?\.xml|word\/people\.xml|docProps\/thumbnail\.\w+|docProps\/custom\.xml|customXml\/.*|word\/glossary\/.*|word\/_rels\/comments.*|word\/_rels\/people.*)$/;
const BLANK_PROPERTIES = new Set([...PROPERTIES['docProps/core.xml'], ...PROPERTIES['docProps/app.xml']]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Field codes and link targets have no place in a paragraph: there the forms are replaced
// wherever they stand as words, and runs of them ("Hans Müller") as one.
function patterns(replacements) {
  return replacements.filter((r) => r.forms && r.forms.length).map((r) => {
    const any = [...new Set(r.forms)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    return { re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${any})(?:[ \\-\u2011](?:${any}))*(?![\\p{L}\\p{N}_])`, 'gu'), placeholder: r.placeholder };
  });
}

const replaceAll = (s, pats) => pats.reduce((acc, p) => acc.replace(p.re, p.placeholder), s);

// Removes and unwraps in place: tracked changes accepted, comments and hidden runs gone.
function clean(el) {
  const kids = [];
  for (const k of el.kids) {
    if (k.t !== 'el') { kids.push(k); continue; }
    if (REMOVE_ELEMENTS.has(k.name)) continue;
    if (k.name === 'w:r' && (hiddenRun(k) || kid(k, 'w:commentReference'))) continue;
    clean(k);
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
    if (text !== null) { out.push({ node: el.name === 'w:t' ? el : null, start: pos, text }); pos += text.length; }
    return el.name !== 'w:t';
  });
  return out;
}

// Puts the placeholder at exactly the places the check showed, across formatting runs
// ("Mül" + "ler"): the first text node of the place takes it, the rest of the place is cut.
function replacePlaces(p, places) {
  for (const place of [...places].sort((a, b) => b.start - a.start)) {
    let put = false;
    for (const seg of segments(p)) {
      const s = Math.max(place.start, seg.start);
      const e = Math.min(place.end, seg.start + seg.text.length);
      if (s >= e || !seg.node) continue;
      const text = textOf(seg.node);
      const a = s - seg.start;
      const b = e - seg.start;
      setText(seg.node, text.slice(0, a) + (put ? '' : place.placeholder) + text.slice(b));
      put = true;
    }
  }
}

function anonymizePart(xml, pats, places) {
  const tree = parseXml(xml);
  clean(tree);
  let seq = 0;
  walk(tree, (el) => {
    // Separator notes are not paragraphs of the text; the reader skips them too.
    if ((el.name === 'w:footnote' || el.name === 'w:endnote') && NOTE_TYPES.test(el.attrs)) return false;
    if (el.name === 'w:p') {
      const here = places.get(seq++);
      if (here) replacePlaces(el, here);
    }
    if (el.name === 'w:instrText') setText(el, replaceAll(textOf(el), pats));
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

// replacements: [{placeholder: 'A.________', places: [{file, seq, start, end}], forms: ['Hans', 'Müller']}]
// `places` are where the check showed the person (file, paragraph sequence, offsets in its text);
// `forms` serve field codes and link targets, which have no place in a paragraph.
export async function anonymizedCopy(buffer, replacements) {
  const zip = entries(buffer);
  const pats = patterns(replacements);
  const places = new Map();                           // file -> seq -> [{start, end, placeholder}]
  for (const r of replacements) {
    for (const pl of r.places || []) {
      if (!places.has(pl.file)) places.set(pl.file, new Map());
      const bySeq = places.get(pl.file);
      if (!bySeq.has(pl.seq)) bySeq.set(pl.seq, []);
      bySeq.get(pl.seq).push({ start: pl.start, end: pl.end, placeholder: r.placeholder });
    }
  }
  const removed = new Set([...zip.keys()].filter((n) => REMOVE_PARTS.test(n)));
  const changed = new Map();

  for (const [file, entry] of zip) {
    if (removed.has(file)) continue;
    if (TEXT_PARTS.some(([re, kind]) => kind !== 'comment' && re.test(file)) || file === 'word/settings.xml') {
      changed.set(file, anonymizePart(await readEntry(buffer, entry), pats, places.get(file) || new Map()));
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
          if (/^mailto:/i.test(target)) setAttr(rel, 'Target', replaceAll(target, pats));
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
