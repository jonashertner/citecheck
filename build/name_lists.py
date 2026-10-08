"""Person names, for building the vocabulary only: never shipped with the add-in.

Reads from one directory:
  bfs_surnames_canton.csv   BFS, Nachnamen der ständigen Wohnbevölkerung nach Kanton
                            (dam-api.bfs.admin.ch asset 36752521; LASTNAME, VALUE)
  bfs_first_m.csv,          BFS, Männliche / Weibliche Vornamen der Bevölkerung nach
  bfs_first_f.csv           Jahrgang (assets 36752513, 36752506; firstname, VALUE)
  wd_Q101352.tsv,           Wikidata labels of family names / given names, one
  wd_Q202444.tsv            "label"@lang per line (QLever query, see README)

Returns (names, bearers, first_names, residents): every name part in lower case;
residents bearing each BFS name part (surname or first name); first names, as a
dict of how many residents bear each as a first name (0 for a Wikidata-only
given name); the BFS population total.
Multi-word names count per part ("De Luca" → "luca"); particles are skipped.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

PARTICLES = {"von", "van", "de", "da", "di", "del", "della", "du", "des", "der", "le", "la",
             "dos", "das", "do", "el", "al", "bin", "ben", "ibn", "zu", "zur", "zum", "den", "ter", "ten"}
PART = re.compile(r"[^\W\d_]{2,}")
LABEL = re.compile(r'^"(.*)"@[a-z\-]+$')


def _parts(name: str):
    for p in PART.findall(name):
        low = p.lower()
        if low not in PARTICLES:
            yield low


def load_names(directory: Path):
    directory = Path(directory)
    bearers: dict[str, int] = {}
    first_names: dict[str, int] = {}
    residents = 0
    for file, column in (("bfs_surnames_canton.csv", "LASTNAME"), ("bfs_first_m.csv", "firstname"), ("bfs_first_f.csv", "firstname")):
        path = directory / file
        if not path.exists():
            continue
        with open(path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                n = int(row["VALUE"] or 0)
                if column == "LASTNAME":
                    residents += n
                for p in _parts(row[column]):
                    bearers[p] = bearers.get(p, 0) + n
                    if column == "firstname":
                        first_names[p] = first_names.get(p, 0) + n
    names = set(bearers)
    for file, given in (("wd_Q101352.tsv", False), ("wd_Q202444.tsv", True)):
        path = directory / file
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = LABEL.match(line.strip())
                if not m:
                    continue
                for p in _parts(m.group(1)):
                    names.add(p)
                    if given:
                        first_names.setdefault(p, 0)
    return names, bearers, first_names, max(residents, 1)
