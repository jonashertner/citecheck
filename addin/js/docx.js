// Reads the paragraphs of a .docx in the browser, for use outside Word. A .docx is a
// zip of XML files; the two that matter are inflated with the browser's own
// DecompressionStream and scanned for paragraph text. No library, no upload: the file
// is read from disk into this page's memory and nowhere else.

const decoder = new TextDecoder();

function u16(view, at) { return view.getUint16(at, true); }
function u32(view, at) { return view.getUint32(at, true); }

// name -> {method, offset, compressedSize} from the zip's central directory.
function entries(buffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 66000); at--) {
    if (u32(view, at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const out = new Map();
  let at = u32(view, end + 16);
  for (let i = 0, n = u16(view, end + 10); i < n; i++) {
    if (u32(view, at) !== 0x02014b50) throw new Error('damaged zip directory');
    const nameLength = u16(view, at + 28);
    const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));
    out.set(name, { method: u16(view, at + 10), compressedSize: u32(view, at + 20), offset: u32(view, at + 42) });
    at += 46 + nameLength + u16(view, at + 30) + u16(view, at + 32);
  }
  return out;
}

async function readEntry(buffer, entry) {
  const view = new DataView(buffer);
  if (u32(view, entry.offset) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = entry.offset + 30 + u16(view, entry.offset + 26) + u16(view, entry.offset + 28);
  const data = new Uint8Array(buffer, start, entry.compressedSize);
  if (entry.method === 0) return decoder.decode(data);
  if (entry.method !== 8) throw new Error('unsupported zip compression');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return decoder.decode(await new Response(stream).arrayBuffer());
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, name) => {
    if (name[0] !== '#') return ENTITIES[name] ?? all;
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });
}

// Paragraph texts of one WordprocessingML part, in order. Text that tracked changes
// mark as deleted (w:delText) is not part of the draft and is left out. A paragraph
// inside another (a text box) is its own paragraph.
const TOKEN = /<w:(p|t|delText|tab|br|cr|noBreakHyphen|footnote)(?=[\s>/])([^>]*)>|<\/w:(p|t|delText|footnote)>|([^<]+)/g;
export function paragraphsOf(xml) {
  const out = [];
  const open = [];                 // paragraphs being read, innermost last
  let inText = false;
  let skipNote = false;            // separator pseudo-footnotes
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml)) !== null) {
    const [, tag, attributes, closing, text] = m;
    const selfClosing = attributes !== undefined && attributes.endsWith('/');
    if (tag === 'footnote') skipNote = /w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(attributes);
    else if (closing === 'footnote') skipNote = false;
    else if (tag === 'p' && selfClosing) { if (!skipNote) out.push(''); }   // an empty paragraph still counts, as in Word
    else if (tag === 'p' && !selfClosing) open.push({ text: '' });
    else if (closing === 'p' && open.length) { const p = open.pop(); if (!skipNote) out.push(p.text); }
    else if (tag === 't' && !selfClosing) inText = true;
    else if (closing === 't') inText = false;
    else if (!open.length) continue;
    else if (tag === 'tab') open[open.length - 1].text += '\t';
    else if (tag === 'br' || tag === 'cr') open[open.length - 1].text += ' ';
    else if (tag === 'noBreakHyphen') open[open.length - 1].text += '\u2011';
    else if (text !== undefined && inText) open[open.length - 1].text += unescapeXml(text);
  }
  return out;
}

// [{text, where}] like word.readDocument(): the body, then the footnotes.
export async function readDocx(buffer) {
  const zip = entries(buffer);
  const main = zip.get('word/document.xml');
  if (!main) throw new Error('no word/document.xml: not a Word document');
  const out = paragraphsOf(await readEntry(buffer, main)).map((text, index) => ({ text, where: { part: 'body', index } }));
  const notes = zip.get('word/footnotes.xml');
  if (notes) {
    // Without note boundaries here, footnote paragraphs are numbered in sequence.
    paragraphsOf(await readEntry(buffer, notes)).forEach((text, index) => out.push({ text, where: { part: 'footnote', note: index, index: 0 } }));
  }
  return out;
}
