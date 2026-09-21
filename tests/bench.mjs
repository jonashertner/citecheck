// Not a test: builds a synthetic list of the size of the corpus (1.1 M labels) and
// times what the pane does with it.  node tests/bench.mjs
import { gzipSync } from 'node:zlib';
import { CiteIndex } from '../addin/js/index.js';
import { checkDocument } from '../addin/js/check.js';

let seed = 7;
const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) % n; };   // mulberry32
const enums = () => { const out = []; for (let i = 1; i <= 3 + rnd(6); i++) { out.push(String(i)); for (let j = 1; j <= rnd(5); j++) out.push(i + '.' + j); } return out.join(','); };
const keys = new Map();
const chambers = ['1B', '1C', '2C', '4A', '5A', '6B', '8C', '9C'];
while (keys.size < 1_100_000) {
  const year = 2000 + rnd(27);
  const date = `${year}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
  const kind = rnd(10);
  const key = kind < 5 ? `${chambers[rnd(8)]}_${1 + rnd(4000)}/${year}` : kind < 7 ? `${'ABCDEF'[rnd(6)]}-${1 + rnd(7000)}/${year}` : `${['VB', 'LB', 'SB', 'ZK', 'HC'][rnd(5)]}.${year}.${String(rnd(99999)).padStart(5, '0')}`;
  if (!keys.has(key)) keys.set(key, `${key}\t${kind < 5 ? 'bger' : kind < 7 ? 'bvger' : 'zh_gerichte'}\t${kind < 7 ? 'CH' : 'ZH'}\t${date}\t${rnd(4) ? enums() : ''}`);
}
const enc = new TextEncoder();
const lines = [...keys.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map((e) => e[1]);
const bytes = enc.encode('#ocl-cite-index 1\n' + lines.join('\n') + '\n');
console.log(`labels ${lines.length.toLocaleString()}  unpacked ${(bytes.length / 1e6).toFixed(1)} MB  gzip ${(gzipSync(bytes, { level: 9 }).length / 1e6).toFixed(1)} MB`);

const index = new CiteIndex(bytes);
const sample = [...keys.keys()].filter((_, i) => i % 1100 === 0);
let t0 = performance.now();
for (const k of sample) if (!index.has(k)) throw new Error('lost ' + k);
console.log(`exact lookup: ${((performance.now() - t0) / sample.length * 1000).toFixed(1)} µs each (${sample.length} keys, all found)`);

const paragraphs = [];
for (let i = 0; i < 400; i++) paragraphs.push({ text: `Erwägung ${i}: vgl. Urteil ${sample[i]} E. 2.1 sowie Urteil 4A_${9000 + i}/2031 E. 3 und weiteren Text ohne Verweis.`, where: { part: 'body', index: i } });
t0 = performance.now();
const r = checkDocument(paragraphs, index);
console.log(`draft with ${r.findings.length} references (half of them misspelt, each searched one edit away): ${(performance.now() - t0).toFixed(0)} ms`, r.counts);
