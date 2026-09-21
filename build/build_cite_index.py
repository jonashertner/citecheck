#!/usr/bin/env python3
"""Build the cite list the Word add-in checks against.

    python build/build_cite_index.py --pack verification_pack.sqlite --out addin/index

Input: the OpenCaseLaw verification pack (one SQLite file; `ocl pack pull`, or
scripts/build_verification_pack.py in the OpenCaseLaw repository). It is opened
read-only. Output, written to a temporary name and renamed:

    cite-index-<date>.tsv.gz   one line per (label, decision), sorted by label
    index.json                 manifest: date, counts, SHA-256, courts covered

A line is  key \\t court \\t canton \\t date \\t e-numbers . It holds no text of
any decision and no citation string: the list answers "is there a decision
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
_BGE_BARE = re.compile(r"^(?:BGE\s+)?(\d{1,3})\s+(Ia|Ib|III|II|IV|I|V)\s+(\d{1,4})$", re.IGNORECASE)
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


# ── build ─────────────────────────────────────────────────────────────────
def build(pack: Path, out_dir: Path, *, sample: bool = False, log=lambda m: print(m, file=sys.stderr, flush=True)) -> dict:
    con = sqlite3.connect(f"{pack.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())

    log("reading Erwägung numbers")
    enums: dict[str, list[str]] = {}
    for decision_id, e_number in con.execute("SELECT decision_id, e_number FROM paragraphs"):
        e = (e_number or "").strip().lower()
        if _ENUM.match(e):
            enums.setdefault(decision_id, []).append(e)

    log("reading decisions")
    decisions = {}
    courts: dict[str, dict] = {}
    lines: dict[tuple, set] = {}
    for decision_id, court, canton, date, d1, d2 in con.execute(
            "SELECT decision_id, court, canton, decision_date, docket_number, docket_number_2 FROM decisions"):
        court, canton, date = court or "", canton or "", (date or "")[:10]
        decisions[decision_id] = (court, canton, date)
        c = courts.setdefault(court, {"canton": canton, "decisions": 0, "with_numbering": 0, "first": None, "last": None})
        c["decisions"] += 1
        c["with_numbering"] += 1 if decision_id in enums else 0
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            c["first"] = min(c["first"] or date, date)
            c["last"] = max(c["last"] or date, date)
        for docket in (d1, d2):
            key = key_for(court, docket)
            if key:
                lines.setdefault((key, court, canton, date), set()).update(enums.get(decision_id, ()))

    log("reading docket aliases")
    try:
        aliases = con.execute("SELECT alias_docket_norm, canonical_decision_id FROM aliases").fetchall()
    except sqlite3.OperationalError:
        aliases = []
    for alias, decision_id in aliases:
        if decision_id in decisions:
            court, canton, date = decisions[decision_id]
            key = key_for(court, (alias or "").replace("_", " "))
            if key:
                lines.setdefault((key, court, canton, date), set()).update(enums.get(decision_id, ()))
    con.close()

    log(f"sorting {len(lines):,} lines")
    ordered = sorted(lines.items(), key=lambda kv: (kv[0][0].encode("utf-8"), kv[0][1:]))
    body = "\n".join([HEADER] + ["\t".join((*k, ",".join(sorted(v, key=_natural)))) for k, v in ordered]) + "\n"
    raw = body.encode("utf-8")

    generated = meta.get("built_at") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    name = f"cite-index-{generated[:10]}.tsv.gz"
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / (name + ".tmp")
    with open(tmp, "wb") as fh, gzip.GzipFile(filename="", mode="wb", fileobj=fh, compresslevel=9, mtime=0) as gz:
        gz.write(raw)
    blob = tmp.read_bytes()
    os.replace(tmp, out_dir / name)

    manifest = {
        "schema": SCHEMA, "file": name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
        "unpacked_bytes": len(raw), "generated": generated, "pack_generation": meta.get("db_generation"),
        "decisions": len(decisions), "labels": len(ordered),
        "with_numbering": sum(1 for d in decisions if d in enums),
        "source": "OpenCaseLaw verification pack", "licence": "CC0-1.0",
        "courts": {k: courts[k] for k in sorted(courts)},
    }
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
    ap.add_argument("--pack", required=True, type=Path, help="verification_pack.sqlite")
    ap.add_argument("--out", required=True, type=Path, help="directory served as <add-in>/index/")
    ap.add_argument("--sample", action="store_true", help="mark the list as a sample (test data); the add-in warns")
    args = ap.parse_args(argv)
    if not args.pack.is_file():
        print(f"no such pack: {args.pack}", file=sys.stderr)
        return 2
    build(args.pack, args.out, sample=args.sample)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
