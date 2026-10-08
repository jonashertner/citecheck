#!/usr/bin/env python3
"""Measure the anonymization check on published rulings it has never seen.

    python build/bench_anon.py --vocabulary VOCAB_DIR --names-dir NAMES --work WORK \
        --report docs/benchmark-anonymization.md [--ocl-repo ~/caselaw-repo-1]

The vocabulary must have been built with --holdout 10; the benchmark reads only
the held-out rulings (id hashing to 0 mod 10) of the courts below, from the
HuggingFace mirror, and only those that use placeholders (anonymized ones).

Measured:
  list length       entries shown per ruling, per language
  missed occurrence one placeholder occurrence turned back into a name, in eight
                    written forms; is the name shown?
  forgotten person  every occurrence of one placeholder turned back
  identifiers       a synthetic AHV number, IBAN, mobile, address, plate, parcel,
                    birth date inserted next to a placeholder
  real leaks        the alert-tier findings of OpenCaseLaw's daily check
                    (scripts/anonymization_check.py) in the same rulings: is each shown?
The report holds figures only, never a value from a ruling.
"""
from __future__ import annotations

import argparse
import collections
import json
import random
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from anon_engine import P, Vocabulary, check, iban_valid  # noqa: E402
from build_vocabulary import HF_FILE, holdout_of  # noqa: E402
from name_lists import load_names  # noqa: E402

COURTS = ["bger", "bvger", "bstger", "zh_obergericht", "zh_sozialversicherungsgericht", "zh_verwaltungsgericht",
          "be_verwaltungsgericht", "be_zivilstraf", "bs_appellationsgericht", "sg_versicherungsgericht",
          "lu_gerichte", "ag_strafgericht", "vd_findinfo", "ge_gerichte", "ti_gerichte", "fr_gerichte",
          "ne_gerichte", "vs_gerichte"]
FIRST = ["Hans", "Marie", "Luca", "Ana", "Daniel", "Fatima", "Peter", "Sandra", "Mehmet", "Giulia", "Thomas", "Aisha"]


def sample_rulings(work: Path, per_court: int, seed: int) -> list[dict]:
    import pyarrow.parquet as pq
    cache = work / "holdout-sample.jsonl"
    if cache.exists():
        return [json.loads(line) for line in cache.open(encoding="utf-8")]
    rng = random.Random(seed)
    out = []
    for court in COURTS:
        path = work / f"{court}.parquet"
        try:
            urllib.request.urlretrieve(HF_FILE + f"{court}.parquet", path)
        except Exception as e:                               # a court missing from the mirror
            print(f"skip {court}: {e}", file=sys.stderr)
            continue
        rows = []
        table = pq.read_table(path, columns=["decision_id", "language", "full_text"])
        for did, lang, text in zip(*(table.column(c).to_pylist() for c in ("decision_id", "language", "full_text"))):
            if text and len(text) >= 1500 and holdout_of(did or "", 10) and len(P["placeholder"].findall(text)) >= 3:
                rows.append({"court": court, "id": did, "language": lang or "?", "text": as_in_word(text)})
        path.unlink()
        out += rng.sample(rows, min(per_court, len(rows)))
        print(f"{court}: {len(rows):,} held-out anonymized, {min(per_court, len(rows))} sampled", file=sys.stderr)
    with cache.open("w", encoding="utf-8") as fh:
        for r in out:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return out


SOFT = re.compile(r"\xad|(?<=[^\W\d_])-[ \t]*\r?\n[ \t]*(?=[^\W\d_])")


def as_in_word(text: str) -> str:
    """Corpus texts come from PDF and HTML, with words broken at line ends ("Be-\nschwerde");
    a Word document holds the word whole. Joined here, as the word list build does."""
    return SOFT.sub("", text)


def run(text: str, vocabulary):
    return check([{"text": text, "where": {"part": "body", "index": 0}}], vocabulary)


def shown_at(result, a: int, b: int) -> bool:
    return any(o["start"] < b and a < o["end"] for e in result["entries"] for o in e["occurrences"])


def body_placeholders(text: str):
    n = len(text)
    return [m for m in P["placeholder"].finditer(text) if 2500 < m.start() < n - 800]


def ean13(digits12: str) -> str:
    s = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(digits12))
    return digits12 + str((10 - s % 10) % 10)


def iban(rng) -> str:
    while True:
        bban = "".join(rng.choice("0123456789") for _ in range(17))
        for check_digits in range(2, 99):
            s = f"CH{check_digits:02d}{bban}"
            if iban_valid(s):
                return " ".join(s[i:i + 4] for i in range(0, 21, 4))


def forms(rng, surname: str, first: str) -> dict[str, tuple[str, str]]:
    """name form -> (text to insert, the part that must be shown)."""
    fold = surname.replace("ü", "ue").replace("ö", "oe").replace("ä", "ae")
    return {
        "surname": (surname, surname),
        "first and surname": (f"{first} {surname}", surname),
        "possessive": (surname + "s", surname + "s"),
        "capitals": (surname.upper(), surname.upper()),
        "initial and surname": (f"{first[0]}. {surname}", surname),
        "double surname": (f"{surname}-{rng.choice(['Meier', 'Rossi', 'Favre', 'Krasniqi'])}", surname),
        "e-mail": (f"{first.lower()}.{fold.lower()}@gmail.com", f"{first.lower()}.{fold.lower()}@gmail.com"),
        "umlaut spelt out": (fold, fold),
    }


def pct(hit: int, total: int) -> str:
    return f"{100 * hit / total:.1f} % ({hit:,}/{total:,})" if total else "n/a"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--vocabulary", type=Path, required=True)
    ap.add_argument("--names-dir", type=Path, required=True)
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    ap.add_argument("--ocl-repo", type=Path, help="caselaw-repo-1, for the real-leak comparison")
    ap.add_argument("--per-court", type=int, default=400)
    ap.add_argument("--trials", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    a.work.mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.seed)

    vocabulary = Vocabulary.open(a.vocabulary)
    manifest = json.loads((a.vocabulary / "vocabulary.json").read_text(encoding="utf-8"))
    rulings = sample_rulings(a.work, a.per_court, a.seed)
    for r in rulings:
        r["text"] = as_in_word(r["text"])
    names, bearers, first_names, residents = load_names(a.names_dir)
    surnames = [n for n in bearers if n not in first_names and len(n) >= 3]
    weights = [bearers[n] for n in surnames]

    # 1. list length
    t0 = time.perf_counter()
    lengths, kinds = collections.defaultdict(list), collections.defaultdict(collections.Counter)
    for r in rulings:
        res = run(r["text"], vocabulary)
        lengths[r["language"]].append(len(res["entries"]))
        kinds[r["language"]].update(e["kind"] for e in res["entries"])
    per_ruling = (time.perf_counter() - t0) / max(1, len(rulings))

    # 2. missed occurrence, 3. forgotten person, 4. identifiers
    def pick_surname(weighted: bool) -> str:
        n = rng.choices(surnames, weights)[0] if weighted else rng.choice(surnames)
        return n[:1].upper() + n[1:]

    missed = collections.defaultdict(lambda: [0, 0])
    for _ in range(a.trials):
        r = rng.choice(rulings)
        phs = body_placeholders(r["text"])
        if not phs:
            continue
        m = rng.choice(phs)
        weighted = rng.random() < 0.5
        surname, first = pick_surname(weighted), rng.choice(FIRST)
        for form, (insert, must) in forms(rng, surname, first).items():
            text = r["text"][:m.start()] + insert + r["text"][m.end():]
            at = m.start() + insert.index(must)
            hit = shown_at(run(text, vocabulary), at, at + len(must))
            for key in (form, f"{form}|{'by bearers' if weighted else 'uniform'}"):
                missed[key][0] += hit
                missed[key][1] += 1

    forgotten = [0, 0]
    for _ in range(a.trials // 3):
        r = rng.choice(rulings)
        counts = collections.Counter(m.group() for m in P["placeholder"].finditer(r["text"]))
        if not counts:
            continue
        target = rng.choice(sorted(counts))
        surname = pick_surname(rng.random() < 0.5)
        text = r["text"].replace(target, surname)
        res = run(text, vocabulary)
        forgotten[0] += any(surname in o["text"] for e in res["entries"] for o in e["occurrences"])
        forgotten[1] += 1

    ident = collections.defaultdict(lambda: [0, 0])
    for _ in range(a.trials // 3):
        r = rng.choice(rulings)
        phs = body_placeholders(r["text"])
        if not phs:
            continue
        m = rng.choice(phs)
        cases = {
            "AHV number": "Sozialversicherungsnummer " + ".".join(re.findall(r"..?.?.?", ean13("756" + "".join(rng.choice("0123456789") for _ in range(9))))),
            "IBAN": "Konto " + iban(rng),
            "mobile": "Natel 079 " + f"{rng.randint(100, 999)} {rng.randint(10, 99)} {rng.randint(10, 99)}",
            "address": f"wohnhaft an der Musterweg {rng.randint(1, 99)}, {rng.randint(1000, 9658)} Wängi",
            "number plate": f"Personenwagen mit dem Kontrollschild ZH {rng.randint(10000, 999999)}",
            "parcel": f"Parzelle Nr. {rng.randint(100, 9999)}",
            "birth date": f"geboren am {rng.randint(1, 28)}. März 19{rng.randint(40, 99)}",
        }
        for label, phrase in cases.items():
            insert = m.group() + ", " + phrase + ","
            text = r["text"][:m.start()] + insert + r["text"][m.end():]
            at = m.start() + len(m.group()) + 2
            ident[label][0] += shown_at(run(text, vocabulary), at, at + len(phrase))
            ident[label][1] += 1

    # 5. real leaks found by the daily check
    real = None
    if a.ocl_repo:
        sys.path.insert(0, str(a.ocl_repo / "scripts"))
        import anonymization_check as daily
        real = collections.defaultdict(lambda: [0, 0])
        for r in rulings:
            hits = [h for h in daily.find_hits(r["text"]) if h["tier"] == "alert"]
            if not hits:
                continue
            res = run(r["text"], vocabulary)
            for h in hits:
                real[h["detector"]][0] += shown_at(res, h["start"], h["end"])
                real[h["detector"]][1] += 1

    write_report(a.report, manifest, rulings, lengths, kinds, per_ruling, missed, forgotten, ident, real)
    print(a.report.read_text(encoding="utf-8"))
    return 0


def q(values, p):
    v = sorted(values)
    return v[int(p * (len(v) - 1))] if v else 0


def write_report(path, manifest, rulings, lengths, kinds, per_ruling, missed, forgotten, ident, real):
    courts = collections.Counter(r["court"] for r in rulings)
    lines = [
        "# Anonymization check: benchmark", "",
        f"Vocabulary `{manifest['file']}`: {manifest['words']:,} words, {manifest['exceptions']:,} name exceptions,",
        f"built from {manifest['rulings']:,} rulings with every tenth ruling held out. Measured on",
        f"{len(rulings):,} held-out anonymized rulings from {len(courts)} courts. Generated by `build/bench_anon.py`;",
        "figures only, no value from any ruling.", "",
        "## What a clerk reads", "",
        "| Language | Rulings | Entries shown: median | p90 | p99 | none at all | words / numbers / identifiers |",
        "|---|---|---|---|---|---|---|",
    ]
    for lang, v in sorted(lengths.items(), key=lambda kv: -len(kv[1])):
        k = kinds[lang]
        lines.append(f"| {lang} | {len(v):,} | {statistics.median(v):g} | {q(v, .9)} | {q(v, .99)} | "
                     f"{sum(1 for x in v if x == 0) / len(v):.0%} | {k['word']:,} / {k['number']:,} / {k['identifier']:,} |")
    lines += ["", f"Time: {per_ruling * 1000:.0f} ms per ruling (Python, one core).", "",
              "## A missed occurrence", "",
              "One placeholder in the body turned back into a name. Surnames from the BFS list, half drawn",
              "by how many residents carry them (Müller often), half uniformly (rare names as often as common).", "",
              "| Written form | Shown | by bearers | uniform |", "|---|---|---|---|"]
    for form in ["surname", "first and surname", "possessive", "capitals", "initial and surname",
                 "double surname", "e-mail", "umlaut spelt out"]:
        h, t = missed[form]
        lines.append(f"| {form} | {pct(h, t)} | {pct(*missed[form + '|by bearers'])} | {pct(*missed[form + '|uniform'])} |")
    lines += ["", f"A forgotten person (every occurrence of one placeholder turned back): shown in {pct(*forgotten)}.", "",
              "## Identifiers", "", "| Inserted next to a placeholder | Shown |", "|---|---|"]
    for label, (h, t) in ident.items():
        lines.append(f"| {label} | {pct(h, t)} |")
    if real is not None:
        lines += ["", "## Real leaks", "",
                  "Alert-tier findings of OpenCaseLaw's daily check in the same rulings (values never printed).", "",
                  "| Detector | Shown |", "|---|---|"]
        for det, (h, t) in sorted(real.items()):
            lines.append(f"| {det} | {pct(h, t)} |")
    n = manifest["names"]
    if "names_by_context" in n:
        lines += ["", "## Names found by their context", "",
                  f"{n['names_by_context']:,} words are on no name list but written as names in the corpus (after a",
                  "title, an office or a first name: \"Bundesrichter Kneubühler\", \"Mr Resul Sadak\"); they are kept out of",
                  "the word list. Most frequent: " + ", ".join(n["names_by_context_examples"][:25]) + "."]
    lines += ["", "## Names the vocabulary treats as words", "",
              f"{n['names_treated_as_words']:,} name forms are used by the corpus as ordinary words and are therefore",
              f"explained wherever they occur; together {n['residents_bearing_them']:,} residents bear one of them",
              "(as surname or first name). Largest: " + ", ".join(n["examples"][:25]) + ".", ""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
