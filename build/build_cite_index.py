#!/usr/bin/env python3
"""Build the cite list the Word add-in checks against.

    python build/build_cite_index.py --pack verification_pack.sqlite --out addin/index

Input, one of two:
  --pack            the OpenCaseLaw verification pack (one SQLite file, weekly;
                    `ocl pack pull`), standard library only
  --dataset-dir     the nightly corpus files of the OpenCaseLaw pipeline: the
                    per-court Parquet export (needs pyarrow), decisions.db for
                    the docket aliases and decision_structure.db for the
                    Erwägung numbers; both databases are opened read-only and
                    the reads use covering indexes only
Output, written to a temporary name and renamed:

    cite-index-<date>-<hash>.tsv.gz   one line per (label, decision), sorted by label
    index.json                 manifest: date, counts, SHA-256, courts covered

A line is  key \\t court \\t canton \\t date \\t e-numbers \\t decision id . It holds
no text of any decision and no citation string: the list answers "is there a decision
under this label, and does it have an Erwägung with this number", nothing else.
Standard library only. The output is byte-for-byte reproducible from the pack.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
HEADER = "#ocl-cite-index 1"
_PARTS = {"I", "IA", "IB", "II", "III", "IV", "V"}
# The corpus writes a BGE row's own label "140 III 115" and, for the volumes before 80, "73_II_6".
_BGE_BARE = re.compile(r"^(?:(?:BGE|ATF|DTF)[\s_]+)?(\d{1,3})[\s_]+(Ia|Ib|III|II|IV|I|V)[\s_]+(\d{1,4})$", re.IGNORECASE)
_FEDERAL = re.compile(r"(\d[A-Z]{1,2})[ _.](\d{1,5}/\d{4})")
_SPACES = str.maketrans({c: " " for c in "\u00a0\u2007\u2009\u202f"} | {c: "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"})
_ENUM = re.compile(r"^\d+(?:\.\d+)*(?:[a-z]{1,2})?(?:/[a-z]{1,2})*$")


# ── keys: the same two functions as addin/js/keys.js ──────────────────────
def bge_key(volume, part, page) -> str | None:
    part = str(part).upper()
    if part not in _PARTS:
        return None
    return f"BGE {int(volume):03d} {part} {int(page):04d}"


def docket_key(docket: str) -> str:
    s = (docket or "").translate(_SPACES).upper()
    s = _FEDERAL.sub(r"\1_\2", s)
    s = re.sub(r"\s*/\s*", "/", s)
    return re.sub(r"\s+", " ", s).strip()


def key_for(court: str, docket: str) -> str | None:
    docket = (docket or "").strip()
    if not docket:
        return None
    if court in ("bge", "bge_egmr"):
        m = _BGE_BARE.match(docket.translate(_SPACES))
        if m:
            return bge_key(*m.groups())
    key = docket_key(docket)
    return key if key and "\t" not in key and "\n" not in key and not key.startswith("#") else None


def _natural(e_number: str):
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in re.findall(r"\d+|[a-z]+|[./]", e_number)]


# ── sources ───────────────────────────────────────────────────────────────
class PackSource:
    """The verification pack: meta, paragraphs, decisions, aliases."""

    def __init__(self, pack: Path):
        self.con = sqlite3.connect(f"{pack.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
        self.meta = dict(self.con.execute("SELECT key, value FROM meta").fetchall())
        self.generated = self.meta.get("built_at")
        self.generation = self.meta.get("db_generation")
        self.name = "OpenCaseLaw verification pack"

    def enums(self):
        return self.con.execute("SELECT decision_id, e_number FROM paragraphs")

    def decisions(self):
        return self.con.execute("SELECT decision_id, court, canton, decision_date, docket_number, docket_number_2, canonical_decision_id FROM decisions")

    def aliases(self):
        try:
            return self.con.execute("SELECT alias_docket_norm, canonical_decision_id FROM aliases").fetchall()
        except sqlite3.OperationalError:
            return []

    def close(self):
        self.con.close()


class CorpusSource:
    """The nightly corpus: Parquet export + decisions.db aliases + decision_structure.db numbers."""

    _COLUMNS = ["decision_id", "court", "canton", "decision_date", "docket_number", "docket_number_2"]

    def __init__(self, dataset_dir: Path, decisions_db: Path, structure_db: Path):
        self.files = sorted(p for p in dataset_dir.glob("*.parquet") if not p.name.startswith("."))
        if not self.files:
            raise FileNotFoundError(f"no *.parquet in {dataset_dir}")
        self.decisions_db = decisions_db
        self.structure_db = structure_db
        newest = max(p.stat().st_mtime for p in self.files)
        self.generated = datetime.fromtimestamp(newest, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.generation = str(int(newest))
        self.name = "OpenCaseLaw nightly corpus export"

    def enums(self):
        con = sqlite3.connect(f"{self.structure_db.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
        try:
            # (decision_id, e_number) is the primary key: the read is a covering-index scan.
            yield from con.execute("SELECT decision_id, e_number FROM erwaegungen_paragraph")
        finally:
            con.close()

    def decisions(self):
        import pyarrow.parquet as pq  # noqa: WPS433  (only this source needs it)
        for path in self.files:
            table = pq.read_table(path, columns=self._COLUMNS)
            for row in zip(*(table.column(c).to_pylist() for c in self._COLUMNS)):
                yield (*row, None)

    def aliases(self):
        con = sqlite3.connect(f"{self.decisions_db.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
        try:
            return con.execute("SELECT alias_docket_norm, canonical_decision_id FROM decision_docket_aliases").fetchall()
        except sqlite3.OperationalError:
            return []
        finally:
            con.close()

    def close(self):
        pass


# ── build ─────────────────────────────────────────────────────────────────
def build(source, out_dir: Path, *, sample: bool = False, log=lambda m: print(m, file=sys.stderr, flush=True)) -> dict:
    if isinstance(source, Path):
        source = PackSource(source)

    log("reading Erwägung numbers")
    enums: dict[str, list[str]] = {}
    for decision_id, e_number in source.enums():
        e = (e_number or "").strip().lower()
        if _ENUM.match(e):
            enums.setdefault(decision_id, []).append(e)

    log("reading decisions")
    decisions = {}
    courts: dict[str, dict] = {}
    lines: dict[tuple, dict] = {}     # (key, court, canton, date) -> {"enums": set, "id": decision id}

    def add(key, court, canton, date, decision_id, canonical):
        line = lines.setdefault((key, court, canton, date), {"enums": set(), "id": canonical or decision_id})
        line["enums"].update(enums.get(decision_id, ()))

    for decision_id, court, canton, date, d1, d2, canonical in source.decisions():
        court, canton, date = court or "", canton or "", (date or "")[:10]
        decisions[decision_id] = (court, canton, date, canonical)
        c = courts.setdefault(court, {"canton": canton, "decisions": 0, "with_numbering": 0, "first": None, "last": None})
        c["decisions"] += 1
        c["with_numbering"] += 1 if decision_id in enums else 0
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            c["first"] = min(c["first"] or date, date)
            c["last"] = max(c["last"] or date, date)
        for docket in (d1, d2):
            key = key_for(court, docket)
            if key:
                add(key, court, canton, date, decision_id, canonical)

    log("reading docket aliases")
    for alias, decision_id in source.aliases():
        if decision_id in decisions:
            court, canton, date, canonical = decisions[decision_id]
            key = key_for(court, (alias or "").replace("_", " "))
            if key:
                add(key, court, canton, date, decision_id, canonical)
    source.close()

    log(f"sorting {len(lines):,} lines")
    ordered = sorted(lines.items(), key=lambda kv: (kv[0][0].encode("utf-8"), kv[0][1:]))
    clean = lambda s: re.sub(r"[\t\n\r]", " ", s or "")
    body = "\n".join([HEADER] + ["\t".join((*k, ",".join(sorted(v["enums"], key=_natural)), clean(v["id"]))) for k, v in ordered]) + "\n"
    raw = body.encode("utf-8")

    generated = source.generated or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / "cite-index.tsv.gz.tmp"
    with open(tmp, "wb") as fh, gzip.GzipFile(filename="", mode="wb", fileobj=fh, compresslevel=9, mtime=0) as gz:
        gz.write(raw)
    blob = tmp.read_bytes()
    # The name carries the content's hash: a cache between server and pane can never
    # hand out an older list under the name of a newer one.
    name = f"cite-index-{generated[:10]}-{hashlib.sha256(blob).hexdigest()[:8]}.tsv.gz"
    os.replace(tmp, out_dir / name)

    manifest = {
        "schema": SCHEMA, "file": name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
        "unpacked_bytes": len(raw), "generated": generated, "pack_generation": source.generation,
        "decisions": len(decisions), "labels": len(ordered),
        "with_numbering": sum(1 for d in decisions if d in enums),
        "source": source.name, "licence": "CC0-1.0",
        "courts": {k: courts[k] for k in sorted(courts)},
    }
    # A whole range of BGE volumes keyed wrongly is invisible in the totals (the first
    # list lacked volumes 1-79): the manifest names the span and any volume without a line.
    volumes = sorted({int(k[0][4:7]) for k, _ in ordered if k[0].startswith("BGE ")})
    if volumes:
        absent = [v for v in range(volumes[0], volumes[-1] + 1) if v not in set(volumes)]
        manifest["bge_volumes"] = {"first": volumes[0], "last": volumes[-1], "absent": absent}
        if absent or (volumes[0] > 1 and not sample):
            log(f"WARNING: BGE volumes start at {volumes[0]}, absent in between: {absent}")
    if sample:
        manifest["sample"] = True   # the pane then says the list is not fit for work
    tmp = out_dir / "index.json.tmp"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, out_dir / "index.json")   # last: a reader never sees a manifest without its file
    for old in out_dir.glob("cite-index-*.tsv.gz"):
        if old.name != name:
            old.unlink()
    log(f"{name}: {len(blob):,} bytes ({len(raw):,} unpacked), {len(decisions):,} decisions, {len(ordered):,} labels")
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pack", type=Path, help="verification_pack.sqlite (weekly)")
    ap.add_argument("--dataset-dir", type=Path, help="directory of the per-court Parquet export (nightly)")
    ap.add_argument("--decisions-db", type=Path, help="decisions.db, for the docket aliases (with --dataset-dir)")
    ap.add_argument("--structure-db", type=Path, help="decision_structure.db, for the Erwägung numbers (with --dataset-dir)")
    ap.add_argument("--out", required=True, type=Path, help="directory served as <add-in>/index/")
    ap.add_argument("--sample", action="store_true", help="mark the list as a sample (test data); the add-in warns")
    args = ap.parse_args(argv)
    if args.pack:
        if not args.pack.is_file():
            print(f"no such pack: {args.pack}", file=sys.stderr)
            return 2
        source = PackSource(args.pack)
    elif args.dataset_dir and args.decisions_db and args.structure_db:
        for path in (args.dataset_dir, args.decisions_db, args.structure_db):
            if not path.exists():
                print(f"no such path: {path}", file=sys.stderr)
                return 2
        source = CorpusSource(args.dataset_dir, args.decisions_db, args.structure_db)
    else:
        ap.error("give --pack, or --dataset-dir with --decisions-db and --structure-db")
    build(source, args.out, sample=args.sample)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
