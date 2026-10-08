// The Word host module against a stand-in for Word's object model: which range a stale
// citation row may select or comment. Deep check 2026-10-09, N2: deleting one of two
// identical citations after the check made the row comment on the other one.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeWord(paragraphTexts) {
  const log = [];
  const paragraphs = paragraphTexts.map((text, index) => ({
    text,
    search(needle) {
      const items = [];
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        items.push({ paragraph: index, at, select() { log.push(['select', index, at]); }, insertComment(c) { log.push(['comment', index, at, c]); } });
      }
      return { items, load() {} };
    },
  }));
  const body = {
    paragraphs: { items: paragraphs, load() {} },
    search(needle) { return { items: paragraphs.flatMap((p) => p.search(needle).items), load() {} }; },
  };
  globalThis.Office = { context: { host: 'Word', requirements: { isSetSupported: () => true } }, HostType: { Word: 'Word' } };
  globalThis.Word = { run: async (fn) => fn({ document: { body }, sync: async () => {} }) };
  return log;
}

const { show, comment } = await import('../addin/js/word.js');
const cite = 'BGE 136 III 513 E. 2.9';
const para = `Vgl. ${cite} und erneut ${cite}.`;
const second = { text: cite, nth: 1, where: { part: 'body', index: 0 }, paragraphText: para };

test('an unchanged duplicate: the second row selects and comments on the second citation', async () => {
  const log = fakeWord([para]);
  assert.equal(await show(second), true);
  assert.equal(await comment(second, 'note'), true);
  assert.deepEqual(log, [['select', 0, para.lastIndexOf(cite)], ['comment', 0, para.lastIndexOf(cite), 'note']]);
});

test('the second citation deleted: the stale row refuses, no comment on the first', async () => {
  const log = fakeWord([para.replace(/ und erneut BGE 136 III 513 E\. 2\.9/, ' und erneut ENTFERNT')]);
  assert.equal(await show(second), false);
  assert.equal(await comment(second, 'note'), false);
  assert.deepEqual(log, []);
});

test('the first citation deleted, a paragraph inserted before: refused, not a guess', async () => {
  const first = { text: cite, nth: 0, where: { part: 'body', index: 0 }, paragraphText: para };
  let log = fakeWord([para.replace(`Vgl. ${cite}`, 'Vgl. ENTFERNT')]);
  assert.equal(await comment(second, 'note'), false);           // nth 1 no longer exists
  assert.equal(await comment(first, 'note'), false);            // nth 0 would now be the former second
  assert.deepEqual(log, []);
  log = fakeWord(['Ein neuer Absatz.', para]);
  assert.equal(await comment(second, 'note'), false);           // paragraph 0 is another paragraph now
  assert.deepEqual(log, []);
});
