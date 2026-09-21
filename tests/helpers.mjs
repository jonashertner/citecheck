// Builds the fixture index with the real builder and opens it like the add-in does.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { CiteIndex } from '../addin/js/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON || 'python3';

export function fixtureIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'citecheck-'));
  execFileSync(python, [join(root, 'tests/make_fixture_pack.py'), join(dir, 'pack.sqlite')]);
  execFileSync(python, [join(root, 'build/build_cite_index.py'), '--pack', join(dir, 'pack.sqlite'), '--out', join(dir, 'index')], { stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(dir, 'index/index.json'), 'utf8'));
  const bytes = new Uint8Array(gunzipSync(readFileSync(join(dir, 'index', manifest.file))));
  return { index: new CiteIndex(bytes), manifest };
}
