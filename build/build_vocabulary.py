#!/usr/bin/env python3
"""Build the vocabulary of the anonymization check: the words that cannot identify anyone.

    python build/build_vocabulary.py --mirror-dir /data/hf --names-dir /data/names --out addin/data

A word is common when it occurs in at least --min-docs published rulings from
at least --min-courts courts, and it is not a person's name. A word that is
also a name (on the BFS lists of surnames and first names of the Swiss
resident population, or a Wikidata family or given name) stays common only
when the corpus uses it as an ordinary word:

  - it is written in lower case at least as often as capitalised ("loi",
    "neu", "stark"), or
  - it is at least --ratio times more frequent among rulings than among
    residents, and fewer than --name-context of its occurrences follow a
    title, an office or a first name ("März", "Recht", "Basler" are common;
    "Seiler", "Aubry", "Meyer" are names however often judges carry them).

Names that the check's compound rule would explain (Hof+mann, Zimmer+mann) are
written as exceptions, "!hofmann", so the check never explains them.

Input: the per-court Parquet files of the OpenCaseLaw corpus (HuggingFace
mirror voilaj/swiss-caselaw, data/*.parquet, CC0), read one file at a time;
with --download the files are fetched, read and deleted one by one. Name lists:
see build/name_lists.py. --holdout N leaves out every ruling whose id hashes
to 0 mod N, for the benchmark (build/bench_anon.py).

Output, written to a temporary name and renamed, the manifest last:
    vocabulary-<date>-<sha8>.txt.gz   "#ocl-vocabulary 1", then one word per line, sorted by UTF-8
    vocabulary.json                   manifest: date, counts, SHA-256, sources, parameters
"""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import os
import pickle
import re
import sys
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from anon_engine import compound_split  # noqa: E402
from name_lists import load_names  # noqa: E402

SCHEMA = 1
HEADER = "#ocl-vocabulary 1"
HF_TREE = "https://huggingface.co/api/datasets/voilaj/swiss-caselaw/tree/main/data"
HF_FILE = "https://huggingface.co/datasets/voilaj/swiss-caselaw/resolve/main/data/"
WORD = re.compile(r"[^\W\d_]{2,}")
MAIL_URL = re.compile(r"\S+@\S+|(?:https?://|www\.)\S+", re.I)
SOFT = re.compile(r"\xad|(?<=[^\W\d_])-\n(?=[^\W\d_])")
# A title, an office or a salutation just before a word makes it a name.
NAME_BEFORE = re.compile(
    r"(?:Herrn?|Frau|Monsieur|Madame|Mme|M\.|Me|Dr\.|Prof\.|Signor[ae]?|Sig\.|Sig\.ra|avv\.|Mr\.?|Mrs\.?|Ms\.?|Miss|Judge|"
    r"Rechtsanw[äa]lt(?:in)?|F[üu]rsprecher(?:in)?|Advokat(?:in)?|Bundesrichter(?:in)?|"
    r"Oberrichter(?:in)?|Richter(?:in)?|Gerichtsschreiber(?:in)?|Präsident(?:in)?|juge|"
    r"greffi(?:er|ère)|procureur|giudice|cancelliere|Staatsanw[äa]lt(?:in)?)\s+$")
# Words that open sentences and are also listed as first names (from names like "Maria de la Cruz"):
# "Die Kosten" must not read as a first name and a surname.
FUNCTION_WORDS = set("""
der die das des dem den ein eine einer eines einem einen im am zum zur vom beim ins ans mit für auf aus bei nach
von zu und oder auch nicht sowie gemäss wegen dass als wie so da wo wer was er sie es wir ihr ihm ihn sein seine
ihre unser jeder diese dieser dieses jene alle kein keine mehr nur noch schon bis seit über unter vor hinter
le la les l du de des un une et en au aux il elle ils elles on dans par pour sur avec sans sous chez entre ce
cette ces son sa ses leur qui que quoi dont où mais ou donc ni car si lo gli i della del dello dei degli delle nel
nella con per tra fra su da al alla e o ma che chi cui questo questa the a an of in on at by for with from and
or but as is it this that to
""".split())
# Titles and offices themselves follow titles ("Prof. Dr.", "Herr Präsident"): never names by context.
NOT_BY_CONTEXT = {"dr", "prof", "med", "iur", "lic", "phil", "rer", "pol", "oec", "mlaw", "blaw", "llm", "pd", "dipl", "ing",
                  "herr", "herrn", "frau", "präsident", "präsidentin", "richter", "richterin", "bundesrichter", "bundesrichterin",
                  "president", "judge", "registrar", "juge", "président", "présidente", "presidente", "giudice", "me", "mr", "mrs", "ms"}
# Columns: rulings, courts, capitalised, lower case, all capitals, after a title or office,
# after a first name (BFS list, written capitalised)
DOCS, COURTS, CAP, LOW, UPPER, TITLED, FIRSTED = range(7)
WIDTH = 7


def holdout_of(decision_id: str, n: int) -> bool:
    return n > 0 and int(hashlib.md5(decision_id.encode()).hexdigest(), 16) % n == 0


def _count_group(job):
    path, group, holdout, first_names = job
    import pyarrow.parquet as pq
    names = pq.ParquetFile(path).schema_arrow.names
    id_column = next((c for c in ("decision_id", "id", "doc_id") if c in names), None)
    table = pq.ParquetFile(path).read_row_group(group, columns=[c for c in (id_column, "full_text") if c])
    texts = table.column("full_text").to_pylist()
    # A file without an id column: the text itself decides the held-out share.
    ids = table.column(id_column).to_pylist() if id_column else [(t or "")[:200] for t in texts]
    stats: dict[str, list[int]] = {}
    docs = 0
    for decision_id, text in zip(ids, texts):
        if not text or len(text) < 300 or holdout_of(decision_id or "", holdout):
            continue
        docs += 1
        text = MAIL_URL.sub(" ", SOFT.sub("", text))
        seen = set()
        prev_end, prev_low, prev_cap = -10, "", False
        for m in WORD.finditer(text):
            token = m.group()
            low = token.lower()
            row = stats.get(low)
            if row is None:
                row = stats[low] = [0] * WIDTH
            if low not in seen:
                seen.add(low)
                row[DOCS] += 1
            start = m.start()
            if token[0] != low[0]:
                row[CAP] += 1
                if token.isupper():
                    row[UPPER] += 1
                if NAME_BEFORE.search(text, max(0, start - 40), start):
                    row[TITLED] += 1
                elif prev_end == start - 1 and text[prev_end] == " " and prev_cap and prev_low in first_names:
                    row[FIRSTED] += 1
            else:
                row[LOW] += 1
            prev_end, prev_low, prev_cap = m.end(), low, token[0] != low[0]
    return stats, docs


def count_file(path: Path, holdout: int, first_names: frozenset, workers: int):
    import pyarrow.parquet as pq
    groups = pq.ParquetFile(path).metadata.num_row_groups
    merged: dict[str, list[int]] = {}
    docs = 0
    with ProcessPoolExecutor(workers) as pool:
        for stats, n in pool.map(_count_group, [(path, g, holdout, first_names) for g in range(groups)]):
            docs += n
            for k, row in stats.items():
                into = merged.get(k)
                if into is None:
                    merged[k] = row
                else:
                    for i in range(WIDTH):
                        if i != COURTS:
                            into[i] += row[i]
    for row in merged.values():
        row[COURTS] = 1
    return merged, docs


def hf_files() -> list[str]:
    with urllib.request.urlopen(HF_TREE, timeout=60) as r:
        # data/delta-<date>.parquet repeats the day's rulings already in the court files.
        return sorted(f["path"].split("/")[-1] for f in json.load(r)
                      if f["path"].endswith(".parquet") and not f["path"].split("/")[-1].startswith("delta-"))


def decide(stats, names, bearers, residents, total_docs, a) -> tuple[list[str], dict]:
    """The common words, plus marked lines: "~word" a name that is ordinary in lower case only,
    "^word" a name that is also a noun ("Streit", "Sommer"), common after an article."""
    common, kept_names, report_context = [], [], []
    lower_only, nouns = [], []
    for low, row in stats.items():
        if row[DOCS] < a.min_docs or (row[COURTS] < a.min_courts and row[DOCS] < a.or_docs):
            continue
        # Written mostly in capitals and on no name list: an acronym ("ZGB", "SchKG"). A listed
        # name in capitals ("KAYA" in a heading) is judged as a name below.
        if row[UPPER] * 2 >= row[CAP] and row[CAP] >= 5 and len(low) <= 6 and low not in names:
            common.append(low)
            continue
        # On no list, but the corpus writes it as a name ("Mr Resul Sadak", "Bundesrichter Kneubühler").
        if (low not in NOT_BY_CONTEXT and row[TITLED] + row[FIRSTED] >= a.named * max(1, row[CAP])
                and row[LOW] < row[CAP] and row[CAP] >= 5):
            report_context.append(low)
            continue
        # "müllers", "müllerin": an inflected name is judged like the name.
        stem = next((low[:-len(x)] for x in ("s", "es", "in") if low.endswith(x) and low[:-len(x)] in names), None)
        if low in names or stem:
            used_lower = row[LOW] >= row[CAP]
            share = row[DOCS] / total_docs
            people = bearers.get(low, 0) or bearers.get(stem or "", 0)
            ratio = share / (people / residents) if people else float("inf")
            named = (row[TITLED] + row[FIRSTED]) / max(1, row[CAP])
            # A Wikidata-only name (no Swiss bearers) needs more evidence, unless the corpus, in many
            # rulings of many courts, never writes it as a name: "Armut", "Rentner", "Kaffee", "Word".
            never_named = (row[DOCS] >= a.unknown_word_docs and row[COURTS] >= a.unknown_word_courts
                           and row[TITLED] + row[FIRSTED] < 0.01 * max(1, row[CAP]))
            if people == 0 and row[DOCS] < a.unknown_min_docs and not used_lower and not never_named:
                continue
            if not (used_lower or (ratio >= a.ratio and named < a.name_context)):
                if row[DOCS] >= a.noun_docs and named < 0.05 and row[LOW] * 10 < row[CAP]:
                    nouns.append(low)
                continue
            kept_names.append((low, people))
            # "gara", "bataille": capitalised under 10 % of the time, so a capital mid-sentence is the name.
            # Not "frei" or "mit" (16-25 %): German capitalises them at every sentence start.
            if row[CAP] * 10 <= row[LOW]:
                lower_only.append(low)
        common.append(low)
    hidden = sum(p for _, p in kept_names)
    a.marked = ["~" + w for w in lower_only] + ["^" + w for w in nouns]
    return sorted(common), {"lower_case_only": len(lower_only), "noun_names": len(nouns),
                            "noun_names_examples": sorted(nouns, key=lambda w: -stats[w][DOCS])[:30],
                            "names_by_context": len(report_context),
                            "names_by_context_examples": sorted(report_context, key=lambda w: -stats[w][DOCS])[:40],
                            "names_treated_as_words": len(kept_names),
                            "residents_bearing_them": hidden,
                            "examples": [w for w, p in sorted(kept_names, key=lambda x: -x[1])[:40]]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=False)
    src.add_argument("--mirror-dir", type=Path, help="directory of per-court *.parquet files")
    src.add_argument("--download", type=Path, metavar="WORK_DIR", help="fetch each file from the HF mirror into WORK_DIR, read it, delete it")
    ap.add_argument("--names-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--holdout", type=int, default=0, help="leave out ids hashing to 0 mod N")
    ap.add_argument("--min-docs", type=int, default=5)
    ap.add_argument("--min-courts", type=int, default=2)
    ap.add_argument("--or-docs", type=int, default=30, help="common from this many rulings even in one court (Italian: mostly Ticino)")
    ap.add_argument("--noun-docs", type=int, default=500, help="a listed name in this many rulings, almost never written as a name, is a noun name (^)")
    ap.add_argument("--ratio", type=float, default=100.0)
    ap.add_argument("--name-context", type=float, default=0.1)
    ap.add_argument("--unknown-min-docs", type=int, default=2000)
    ap.add_argument("--unknown-word-docs", type=int, default=100,
                    help="a Wikidata-only name in this many rulings, never written as a name, is a word")
    ap.add_argument("--unknown-word-courts", type=int, default=10)
    ap.add_argument("--named", type=float, default=0.25,
                    help="a word on no list is a name when this share of its capitalised occurrences follows a title, office or first name")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--only", nargs="*", help="court files to read (default: all)")
    ap.add_argument("--stats", type=Path, help="keep the corpus counts here; with --from-stats, decide again without reading the corpus")
    ap.add_argument("--from-stats", action="store_true")
    a = ap.parse_args(argv)

    names, bearers, first_names, residents = load_names(a.names_dir)
    # Evidence "after a first name": only first names that many residents bear and that are no function word.
    first_names = {f for f, n in first_names.items() if n >= 50 and len(f) >= 3 and f not in FUNCTION_WORDS}
    print(f"names: {len(names):,} ({len(bearers):,} with bearer counts)", file=sys.stderr)

    if a.from_stats:
        stats, total_docs, files = pickle.loads(a.stats.read_bytes())
        return finish(stats, total_docs, files, names, bearers, residents, a)
    if not (a.mirror_dir or a.download):
        ap.error("--mirror-dir or --download (or --from-stats)")
    files = (sorted(p.name for p in a.mirror_dir.glob("*.parquet") if not p.name.startswith("delta-"))
             if a.mirror_dir else hf_files())
    if a.only:
        files = [f for f in files if f.removesuffix(".parquet") in set(a.only)]
    stats: dict[str, list[int]] = {}
    total_docs = 0
    for i, name in enumerate(files, 1):
        if a.mirror_dir:
            path = a.mirror_dir / name
        else:
            a.download.mkdir(parents=True, exist_ok=True)
            path = a.download / name
            urllib.request.urlretrieve(HF_FILE + name, path)
        try:
            counts, docs = count_file(path, a.holdout, frozenset(first_names), a.workers)
        finally:
            if a.download:
                path.unlink(missing_ok=True)
        total_docs += docs
        for k, row in counts.items():
            into = stats.get(k)
            if into is None:
                stats[k] = row
            else:
                for j in range(WIDTH):
                    into[j] += row[j]
        # Words seen in one ruling only cannot become common; drop them early to bound memory.
        if i % 10 == 0:
            stats = {k: r for k, r in stats.items() if r[DOCS] > 1 or r[CAP] + r[LOW] > 1}
        print(f"[{i}/{len(files)}] {name}: {docs:,} rulings, {len(stats):,} words so far", file=sys.stderr)

    if a.stats:
        a.stats.write_bytes(pickle.dumps((stats, total_docs, files), protocol=pickle.HIGHEST_PROTOCOL))
    return finish(stats, total_docs, files, names, bearers, residents, a)


def finish(stats, total_docs, files, names, bearers, residents, a) -> int:
    common, report = decide(stats, names, bearers, residents, total_docs, a)
    vocabulary = set(common)
    exceptions = sorted(n for n in names if n not in vocabulary and len(n) >= 6
                        and compound_split(n, vocabulary.__contains__))
    lines = [HEADER] + sorted(common + ["!" + n for n in exceptions] + getattr(a, "marked", []), key=lambda s: s.encode())
    data = gzip.compress(("\n".join(lines) + "\n").encode(), compresslevel=9, mtime=0)
    digest = hashlib.sha256(data).hexdigest()
    stamp = datetime.now(timezone.utc)
    file = f"vocabulary-{stamp:%Y-%m-%d}-{digest[:8]}.txt.gz"
    a.out.mkdir(parents=True, exist_ok=True)
    tmp = a.out / (file + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, a.out / file)
    manifest = {
        "schema": SCHEMA, "file": file, "bytes": len(data), "sha256": digest,
        "generated": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "words": len(common), "exceptions": len(exceptions),
        "rulings": total_docs, "courts": len(files), "holdout": a.holdout,
        "parameters": {"min_docs": a.min_docs, "min_courts": a.min_courts, "or_docs": a.or_docs, "noun_docs": a.noun_docs, "ratio": a.ratio,
                       "name_context": a.name_context, "unknown_min_docs": a.unknown_min_docs, "unknown_word_docs": a.unknown_word_docs,
                       "unknown_word_courts": a.unknown_word_courts, "named": a.named},
        "names": {"total": len(names), "with_bearers": len(bearers), **report},
        "sources": ["OpenCaseLaw corpus, HuggingFace voilaj/swiss-caselaw (CC0)",
                    "Bundesamt für Statistik: Nachnamen und Vornamen der ständigen Wohnbevölkerung (opendata.swiss)",
                    "Wikidata family names and given names (CC0)"],
    }
    for old in a.out.glob("vocabulary-*.txt.gz"):
        if old.name != file:
            old.unlink()
    tmp = a.out / "vocabulary.json.tmp"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, a.out / "vocabulary.json")
    print(json.dumps({k: manifest[k] for k in ("file", "bytes", "words", "exceptions", "rulings")}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
