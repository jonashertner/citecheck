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

// Paragraphs of the body, then of the footnotes, as [{text, where}].
export async function readDocument() {
  return Word.run(async (context) => {
    const body = context.document.body.paragraphs;
    body.load('items/text');
    let notes = null;
    if (canReadFootnotes()) {
      notes = context.document.body.footnotes;
      notes.load('items');
    }
    await context.sync();
    const out = body.items.map((p, index) => ({ text: p.text || '', where: { part: 'body', index } }));
    if (notes && notes.items.length) {
      const perNote = notes.items.map((n) => { const ps = n.body.paragraphs; ps.load('items/text'); return ps; });
      await context.sync();
      perNote.forEach((ps, note) => ps.items.forEach((p, index) => out.push({ text: p.text || '', where: { part: 'footnote', note, index } })));
    }
    return out;
  });
}

// The range of a finding: the nth occurrence of its written text in its paragraph.
async function locate(context, finding) {
  const { where } = finding;
  let paragraphs;
  if (where.part === 'footnote') {
    const notes = context.document.body.footnotes;
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
