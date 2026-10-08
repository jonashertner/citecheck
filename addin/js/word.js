// Everything that touches the Word document. Three operations: read the text,
// select a place, attach a comment. Nothing here writes to the body of the draft.
/* global Office, Word */

export function inWord() {
  return typeof Word !== 'undefined' && typeof Word.run === 'function' &&
    typeof Office !== 'undefined' && Office.context && Office.context.host === Office.HostType.Word;
}

function supports(version) {
  try { return Office.context.requirements.isSetSupported('WordApi', version); } catch { return false; }
}

export const canComment = () => inWord() && supports('1.4');
const canReadFootnotes = () => supports('1.5');

// Paragraphs of the body, then of the footnotes and endnotes, as [{text, where}].
export async function readDocument() {
  return Word.run(async (context) => {
    const body = context.document.body.paragraphs;
    body.load('items/text');
    let notes = null;
    let endnotes = null;
    if (canReadFootnotes()) {
      notes = context.document.body.footnotes;
      notes.load('items');
      endnotes = context.document.body.endnotes;
      endnotes.load('items');
    }
    await context.sync();
    const out = body.items.map((p, index) => ({ text: p.text || '', where: { part: 'body', index } }));
    for (const [part, list] of [['footnote', notes], ['endnote', endnotes]]) {
      if (!list || !list.items.length) continue;
      const perNote = list.items.map((n) => { const ps = n.body.paragraphs; ps.load('items/text'); return ps; });
      await context.sync();
      perNote.forEach((ps, note) => ps.items.forEach((p, index) => out.push({ text: p.text || '', where: { part, note, index } })));
    }
    return out;
  });
}

// The range of a finding: the nth occurrence of its written text in its paragraph.
async function locate(context, finding) {
  const { where } = finding;
  let paragraphs;
  if (where.part === 'footnote' || where.part === 'endnote') {
    const notes = where.part === 'footnote' ? context.document.body.footnotes : context.document.body.endnotes;
    notes.load('items');
    await context.sync();
    if (!notes.items[where.note]) return null;
    paragraphs = notes.items[where.note].body.paragraphs;
  } else {
    paragraphs = context.document.body.paragraphs;
  }
  paragraphs.load('items');
  await context.sync();
  const paragraph = paragraphs.items[where.index];
  if (paragraph) {
    const hits = paragraph.search(finding.text, { matchCase: true });
    hits.load('items');
    await context.sync();
    if (hits.items.length) return hits.items[Math.min(finding.nth, hits.items.length - 1)];
  }
  // The paragraph moved since the check: the first occurrence anywhere in the body.
  const anywhere = context.document.body.search(finding.text, { matchCase: true });
  anywhere.load('items');
  await context.sync();
  return anywhere.items[0] || null;
}

export async function show(finding) {
  return Word.run(async (context) => {
    const range = await locate(context, finding);
    if (!range) return false;
    range.select();
    await context.sync();
    return true;
  });
}

export async function comment(finding, text) {
  return Word.run(async (context) => {
    const range = await locate(context, finding);
    if (!range) return false;
    range.insertComment(text);
    await context.sync();
    return true;
  });
}

// ── the anonymization check ───────────────────────────────────────────────
// The whole file as Word holds it, through the common file API that every Word
// since 2016 offers (unlike reading comments or tracked changes one by one).
export function readFile() {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(Office.FileType.Compressed, { sliceSize: 4194304 }, (result) => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) { reject(result.error); return; }
      const file = result.value;
      const slices = [];
      const next = (i) => file.getSliceAsync(i, (slice) => {
        if (slice.status !== Office.AsyncResultStatus.Succeeded) { file.closeAsync(); reject(slice.error); return; }
        slices.push(new Uint8Array(slice.value.data));
        if (i + 1 < file.sliceCount) { next(i + 1); return; }
        file.closeAsync();
        const out = new Uint8Array(slices.reduce((n, s) => n + s.length, 0));
        let at = 0;
        for (const s of slices) { out.set(s, at); at += s.length; }
        resolve(out.buffer);
      });
      next(0);
    });
  });
}

// Word's search syntax: ^ is its escape; a non-breaking space is ^s, a non-breaking hyphen ^~.
// (Spelled with split/join: the test that keeps this module from writing to the document flags any .replace.)
const SEARCH_CODES = [['^', '^^'], ['\u00a0', '^s'], ['\u202f', '^s'], ['\u2011', '^~']];
export const searchText = (text) => SEARCH_CODES.reduce((s, [from, to]) => s.split(from).join(to), text.slice(0, 200));
export const wholeWord = (text) => /^[\p{L}\p{N}]+$/u.test(text);

const HEADER_TYPES = { default: 'Primary', first: 'FirstPage', even: 'EvenPages' };

// Selects the nth occurrence of `text` in one part of the document: the body, a footnote
// or endnote (by its number), or the header or footer of a section (by index and type).
export async function showPlace({ text, nth, part, note = 0, section = 0, type = 'default' }) {
  return Word.run(async (context) => {
    let scope;
    if (part === 'footnote' || part === 'endnote') {
      if (!canReadFootnotes()) return false;
      const notes = part === 'footnote' ? context.document.body.footnotes : context.document.body.endnotes;
      notes.load('items');
      await context.sync();
      if (!notes.items[note]) return false;
      scope = notes.items[note].body;
    } else if (part === 'header' || part === 'footer') {
      const sections = context.document.sections;
      sections.load('items');
      await context.sync();
      const s = sections.items[section] || sections.items[0];
      if (!s) return false;
      scope = part === 'header' ? s.getHeader(HEADER_TYPES[type] || 'Primary') : s.getFooter(HEADER_TYPES[type] || 'Primary');
    } else {
      scope = context.document.body;
    }
    const hits = scope.search(searchText(text), { matchCase: true, matchWholeWord: wholeWord(text) });
    hits.load('items');
    await context.sync();
    const range = hits.items[Math.min(nth, hits.items.length - 1)];
    if (!range) return false;
    range.select();
    await context.sync();
    return true;
  });
}

// The document's file name, as Word knows it ("" for a new, unsaved one).
export function fileName() {
  try {
    const url = (Office.context.document && Office.context.document.url) || '';
    return decodeURIComponent(url.split(/[?#]/)[0].split(/[\\/]/).pop() || '');      // SharePoint adds ?web=1
  } catch {
    return '';
  }
}

export const canOpenCopy = () => inWord() && supports('1.3');

// Opens the anonymized copy as a new, unsaved document; the open one is not touched.
export async function openCopy(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return Word.run(async (context) => {
    context.application.createDocument(btoa(binary)).open();
    await context.sync();
    return true;
  });
}
