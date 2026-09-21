// The cite list: one sorted text file, held as bytes and searched in place.
//
//   #ocl-cite-index 1
//   key \t court \t canton \t date \t e-numbers (comma separated) \t decision id
//
// Lines are sorted by the UTF-8 bytes of the key, so a lookup is a binary search
// over the buffer and a million decisions cost their file size in memory, not a
// million objects. Several decisions may share a key (the same file number at
// two courts); their lines are adjacent.

const NL = 10;
const TAB = 9;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class CiteIndex {
  constructor(bytes) {
    this.bytes = bytes;
    const end = bytes.indexOf(NL);
    const header = decoder.decode(bytes.subarray(0, end < 0 ? 0 : end));
    if (!/^#ocl-cite-index 1\b/.test(header)) throw new Error('not a cite index (schema 1)');
  }

  _lineStart(pos) {
    const b = this.bytes;
    while (pos > 0 && b[pos - 1] !== NL) pos--;
    return pos;
  }

  _lineEnd(pos) {
    const end = this.bytes.indexOf(NL, pos);
    return end < 0 ? this.bytes.length : end;
  }

  // Compares the key of the line at `start` with the query bytes.
  _compare(start, q) {
    const b = this.bytes;
    let i = 0;
    for (;; i++) {
      const c = start + i < b.length ? b[start + i] : NL;
      const keyEnded = c === TAB || c === NL;
      if (keyEnded || i === q.length) return keyEnded ? (i === q.length ? 0 : -1) : 1;
      if (c !== q[i]) return c < q[i] ? -1 : 1;
    }
  }

  // Offset of the first line whose key is >= the query.
  _lowerBound(q) {
    let lo = 0;
    let hi = this.bytes.length;
    while (lo < hi) {
      const start = this._lineStart((lo + hi) >>> 1);
      if (this._compare(start, q) < 0) lo = Math.min(this._lineEnd(start) + 1, this.bytes.length);
      else hi = start;
    }
    return lo;
  }

  _row(start) {
    if (start >= this.bytes.length) return null;
    const line = decoder.decode(this.bytes.subarray(start, this._lineEnd(start)));
    if (!line || line[0] === '#') return null;
    const [key, court, canton, date, enums, id] = line.split('\t');
    return { key, court, canton: canton || '', date: date || '', enums: enums ? enums.split(',') : [], id: id || '' };
  }

  // Every decision filed under the key.
  lookup(key) {
    const q = encoder.encode(key);
    const rows = [];
    let pos = this._lowerBound(q);
    while (pos < this.bytes.length && this._compare(pos, q) === 0) {
      const row = this._row(pos);
      if (row) rows.push(row);
      pos = this._lineEnd(pos) + 1;
    }
    return rows;
  }

  has(key) {
    const q = encoder.encode(key);
    const pos = this._lowerBound(q);
    return pos < this.bytes.length && this._compare(pos, q) === 0;
  }

  // The last row with a key below the query, and the first with a key above it.
  neighbours(key) {
    const q = encoder.encode(key);
    const at = this._lowerBound(q);
    const before = at > 0 ? this._row(this._lineStart(at - 1)) : null;
    let pos = at;
    while (pos < this.bytes.length && this._compare(pos, q) === 0) pos = this._lineEnd(pos) + 1;
    return { before, after: this._row(pos) };
  }
}

// ── download, verification, cache ─────────────────────────────────────────
const DB = 'citecheck';
const STORE = 'index';

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    let open;
    try { open = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => { open.result.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { open.result.close(); reject(tx.error); };
    };
  });
}

async function cached() {
  try { return (await idb('readonly', (s) => s.get('current'))) || null; } catch { return null; }
}

async function store(entry) {
  try { await idb('readwrite', (s) => s.put(entry, 'current')); return true; } catch { return false; }
}

export async function forget() {
  try { await idb('readwrite', (s) => s.delete('current')); } catch { /* nothing cached */ }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

async function gunzip(buffer) {
  if (typeof DecompressionStream === 'undefined') throw Object.assign(new Error('no DecompressionStream'), { code: 'unsupported' });
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchManifest(base) {
  const response = await fetch(base + 'index.json', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('index.json: HTTP ' + response.status);
  const manifest = await response.json();
  if (manifest.schema !== 1 || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '') || !/^[A-Za-z0-9._-]+$/.test(manifest.file || '')) {
    throw Object.assign(new Error('index.json is not a schema 1 manifest'), { code: 'manifest' });
  }
  return manifest;
}

async function download(base, manifest, onProgress) {
  const response = await fetch(base + manifest.file, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(manifest.file + ': HTTP ' + response.status);
  const total = manifest.bytes || Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const gz = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { gz.set(c, offset); offset += c.length; }
  const digest = await sha256Hex(gz.buffer);
  if (digest !== manifest.sha256) throw Object.assign(new Error('checksum mismatch'), { code: 'checksum' });
  return gz.buffer;
}

// Opens the cite list. `refresh: true` asks the server whether a newer list
// exists; without it the cached list is used as it is and nothing is requested.
// Returns {index, manifest, source: 'cache' | 'download', stale, persisted}.
export async function openIndex({ base, refresh = true, onProgress } = {}) {
  const have = await cached();
  let manifest = null;
  let offline = null;
  if (refresh || !have) {
    try { manifest = await fetchManifest(base); } catch (e) { offline = e; }
  }
  if (have && (!manifest || manifest.sha256 === have.manifest.sha256)) {
    return { index: new CiteIndex(await gunzip(have.gz)), manifest: have.manifest, source: 'cache', stale: Boolean(offline), persisted: true };
  }
  if (!manifest) throw Object.assign(new Error('the cite list cannot be reached'), { code: 'offline', cause: offline });
  const gz = await download(base, manifest, onProgress);
  const index = new CiteIndex(await gunzip(gz));
  const persisted = await store({ manifest, gz, stored: new Date().toISOString() });
  return { index, manifest, source: 'download', stale: false, persisted };
}
