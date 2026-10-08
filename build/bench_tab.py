#!/usr/bin/env python3
"""The anonymization check on the Text Anonymization Benchmark (TAB).

    python build/bench_tab.py --tab echr_test.json --vocabulary addin/data

TAB (Pilán et al., Computational Linguistics 2022; MIT licence;
github.com/NorskRegnesentral/text-anonymization-benchmark) holds English
judgments of the European Court of Human Rights, annotated by several people:
which spans identify someone directly (names, application numbers) or
indirectly (dates, places, nationalities, occupations). An entity counts as
protected only when every one of its mentions is caught.

The check is not built to TAB's norm: it treats application numbers, dates,
places and nationalities as public, as Swiss courts do, and leaves combinations
to the clerk. So the figure that compares like with like is the one for person
names. All figures are printed, per annotator and averaged.

A mention is caught when every word of it, other than a title (Mr, Mrs, Ms,
Dr) or a particle, lies in something the check shows.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from anon_engine import Vocabulary, check  # noqa: E402

SKIP = {"mr", "mrs", "ms", "dr", "miss", "sir", "lord", "lady", "prof", "von", "van", "de", "da", "di", "del", "der",
        "le", "la", "du", "bin", "ben", "al", "el", "the", "and", "of"}
TOKEN = re.compile(r"[^\W_]{2,}")


def caught(mention: dict, spans: list[tuple[int, int]]) -> bool:
    a = mention["start_offset"]
    for m in TOKEN.finditer(mention["span_text"]):
        if m.group().lower() in SKIP:
            continue
        s, e = a + m.start(), a + m.end()
        if not any(x < e and s < y for x, y in spans):
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tab", type=Path, nargs="+", required=True)
    ap.add_argument("--vocabulary", type=Path, required=True)
    a = ap.parse_args(argv)
    vocabulary = Vocabulary.open(a.vocabulary)
    tally = collections.defaultdict(lambda: [0, 0])        # (group, annotator) -> [caught, total]
    shown_per_doc = []
    for path in a.tab:
        for doc in json.loads(path.read_text(encoding="utf-8")):
            result = check([{"text": doc["text"], "where": {"part": "body", "index": 0}}], vocabulary)
            spans = [(o["start"], o["end"]) for e in result["entries"] for o in e["occurrences"]]
            shown_per_doc.append(len(result["entries"]))
            for annotator, ann in doc["annotations"].items():
                entities = collections.defaultdict(list)
                for m in ann["entity_mentions"]:
                    if m["identifier_type"] in ("DIRECT", "QUASI"):
                        entities[m["entity_id"]].append(m)
                for mentions in entities.values():
                    kind = "DIRECT" if any(m["identifier_type"] == "DIRECT" for m in mentions) else "QUASI"
                    groups = [kind, kind + ":" + mentions[0]["entity_type"]]
                    ok = all(caught(m, spans) for m in mentions)
                    for g in groups:
                        tally[(g, annotator)][0] += ok
                        tally[(g, annotator)][1] += 1
    groups = sorted({g for g, _ in tally}, key=lambda g: (g.split(":")[0], -sum(t for (h, _), (_, t) in tally.items() if h == g)))
    print(f"{len(shown_per_doc)} judgments; entries shown per judgment: median {sorted(shown_per_doc)[len(shown_per_doc) // 2]}")
    print(f"{'entities':24} {'recall (micro over annotators)':>32}   per annotator")
    for g in groups:
        rows = [(ann, c, t) for (h, ann), (c, t) in tally.items() if h == g]
        c, t = sum(r[1] for r in rows), sum(r[2] for r in rows)
        per = ", ".join(f"{ann}: {100 * c_ / t_:.0f} %" for ann, c_, t_ in sorted(rows) if t_)
        print(f"{g:24} {100 * c / t:>8.1f} %  ({c:,}/{t:,})       {per[:120]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
