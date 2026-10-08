#!/usr/bin/env python3
"""The anonymization check: the Python twin of addin/js/anon.js.

    python build/anon_engine.py ruling.txt --vocabulary addin/data

One rule: everything the file carries is either explained or shown.

A word or number is explained when it is
  common      a word found in many published rulings and not a person's name
              (the vocabulary), or a number of a common shape (date, amount,
              legal reference, docket, section, count)
  public      made public by the document: the bench, counsel and officials
              named with their office, authors and case names in citations,
              unless the document anonymizes that category itself
  placeholder A.________, [...], X.
Everything else is shown. A recognised identifier (AHV number, IBAN, phone,
e-mail, street address, number plate, parcel, birth date, insured-person,
ZEMIS, document or account number) is always shown, with its label, unless
its context makes it an office's.

The patterns live once, in addin/js/anon-patterns.js, as strict JSON; this
module reads them from there so the two engines cannot drift apart. The logic
below is mirrored line for line in anon.js; tests/anon_parity.test.mjs holds
them to the same output. Standard library only.
"""
from __future__ import annotations

import argparse
import bisect
import gzip
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATTERN_FILE = ROOT / "addin" / "js" / "anon-patterns.js"
MACROS = {"{<W}": r"(?<!\w)", "{W>}": r"(?!\w)", "{L}": r"[^\W\d_]", "{W}": r"\w", "{w}": r"\w"}
VISIBLE = ("body", "footnote", "endnote", "header", "footer")
PARTICLES = {"von", "van", "de", "da", "di", "del", "della", "du", "des", "der", "le", "la", "zur", "zum"}
TITLES = {"dr", "prof", "pd", "lic", "iur", "med", "phil", "rer", "pol", "oec", "mlaw", "ll"}
# Identifier detectors in the order they claim text; a later match that overlaps
# an earlier claim is dropped.
IDENTIFIERS = ("ahv", "ahv_old", "iban", "insured", "zemis", "document_no", "account",
               "parcel", "birthdate", "email", "url", "phone", "plate", "address")
LABEL = {"ahv_old": "ahv", "document_no": "document", "url": "profile"}
# Detectors whose pattern names its value in group 1 ("Parzelle Nr. 1234": the number).
VALUE_GROUP = {"ahv_old", "insured", "zemis", "document_no", "account", "parcel", "birthdate"}
RANK = {"identifier": 0, "word": 1, "number": 1}


def load_patterns(path: Path = PATTERN_FILE) -> dict[str, re.Pattern]:
    source = path.read_text(encoding="utf-8")
    block = source.split("/* patterns:begin */", 1)[1].split("/* patterns:end */", 1)[0]
    table = json.loads(block[block.index("{"):block.rindex("}") + 1])
    out = {}
    for name, (pattern, flags) in table.items():
        pattern = re.sub(r"\{<W\}|\{W>\}|\{[LWw]\}", lambda m: MACROS[m.group()], pattern)
        pattern = re.sub(r"\(\?<([A-Za-z]\w*)>", r"(?P<\1>", pattern)
        out[name] = re.compile(pattern, re.IGNORECASE if "i" in flags else 0)
    return out


P = load_patterns()


# ── small helpers, each mirrored in anon.js ───────────────────────────────
def ahv_valid(s: str) -> bool:
    d = [int(c) for c in re.sub(r"[^0-9]", "", s)]
    if len(d) != 13:
        return False
    return (10 - sum(x * (3 if i % 2 else 1) for i, x in enumerate(d[:12])) % 10) % 10 == d[12]


def iban_valid(s: str) -> bool:
    s = re.sub(r"\s", "", s).upper()
    if not 15 <= len(s) <= 34:
        return False
    digits = "".join(str(int(c, 36)) for c in s[4:] + s[:4])
    remainder = 0
    for c in digits:                                # piecewise, as JavaScript must do it
        remainder = (remainder * 10 + int(c)) % 97
    return remainder == 1


def fold(word: str) -> str:
    """The grouping key: lower case, no diacritics, ae/oe/ue as a/o/u, ß as ss."""
    s = unicodedata.normalize("NFD", word.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("ß", "ss").replace("ae", "a").replace("oe", "o").replace("ue", "u")


def is_upper(c: str) -> bool:
    return c != c.lower()


def digits_of(s: str) -> int:
    return sum(1 for c in s if "0" <= c <= "9")


class Vocabulary:
    """The common words: one sorted, lower-case word per line after a header.
    A line "!name" marks a name the compound rule must not explain (Hof+mann)."""

    HEADER = "#ocl-vocabulary 1"

    def __init__(self, words):
        self.words = set(words)

    @classmethod
    def open(cls, path: Path) -> "Vocabulary":
        path = Path(path)
        if path.is_dir():
            manifest = json.loads((path / "vocabulary.json").read_text(encoding="utf-8"))
            path = path / manifest["file"]
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rt", encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        if not lines or not lines[0].startswith(cls.HEADER):
            raise ValueError("not a vocabulary (schema 1)")
        return cls(w for w in lines[1:] if w)

    def __contains__(self, word: str) -> bool:
        return word in self.words


# ── the check ─────────────────────────────────────────────────────────────
class _Text:
    """All parts joined by a blank line, with a map back to (part, offset)."""

    def __init__(self, parts):
        self.parts = parts
        self.starts = []
        pos = 0
        for p in parts:
            self.starts.append(pos)
            pos += len(p["text"]) + 2
        self.text = "\n\n".join(p["text"] for p in parts)

    def index(self, start: int) -> int:
        return bisect.bisect_right(self.starts, start) - 1

    def locate(self, start: int, end: int) -> dict:
        i = self.index(start)
        return {"part": i, "start": start - self.starts[i], "end": end - self.starts[i]}

    def end_of_kind(self, start: int) -> int:
        """Where the run of parts of the same kind as the one at `start` ends."""
        i = bisect.bisect_right(self.starts, start) - 1
        kind = self.parts[i].get("where", {}).get("part", "body")
        while i + 1 < len(self.parts) and self.parts[i + 1].get("where", {}).get("part", "body") == kind:
            i += 1
        return self.starts[i] + len(self.parts[i]["text"])

    def kind(self, start: int) -> str:
        i = bisect.bisect_right(self.starts, start) - 1
        return self.parts[i].get("where", {}).get("part", "body")


class _Spans:
    """Claimed stretches of text; a position is taken when a span covers it."""

    def __init__(self):
        self.items = []

    def overlaps(self, a: int, b: int) -> bool:
        return any(s < b and a < e for s, e in self.items)

    def add(self, a: int, b: int) -> None:
        self.items.append((a, b))


_CUT = re.compile(r"\n\s*\n|[a-zäöüéèàç]{3,}\.\s|(?<!\w)(?:gegen|contre|contro|Parteien|Parties|Parti)(?!\w)")


def _whose(text: str, start: int, width: int) -> str:
    """The words before `start` that say whose it is: back to a blank line, a
    sentence end, the party separator ("gegen") or the last anonymized person
    (in "A.________, vertreten durch Rechtsanwalt X, Bahnhofstrasse 1" the
    address is counsel's; in "A.________, wohnhaft Musterweg 12" the person's),
    at most `width` characters."""
    before = text[max(0, start - width):start]
    cut = 0
    for m in _CUT.finditer(before):
        cut = m.end()
    for m in P["placeholder"].finditer(before):
        cut = max(cut, m.end())
    return before[cut:]


def _public(text: str, start: int, end: int, width: int = 80) -> bool:
    """An office's, an insurer's, a company's or counsel's: said just before."""
    return bool(P["not_a_person"].search(_whose(text, start, width)))


def _cited(text: str, a: int, b: int) -> bool:
    """An author: at the start of a citation ("(", ";", "vgl.", "in:", "/", "StGB-"), with a
    literature marker in the same clause (edition, volume, editor, commentary, marginal number)
    and no reference to the file ("act. 7", "pièce 3"), which would make it a party's statement."""
    if not P["citation_start"].search(text[max(0, a - 60):a]):
        return False
    after = text[b:b + 200]
    m = P["literature"].match(after)
    return bool(m) and not P["file_reference"].search(after[:m.end()])


def _sentence_start(text: str, a: int) -> bool:
    """True at the start of a paragraph or sentence, where any word is capitalised.
    After "Dr.", "vgl." or an initial a sentence does not start."""
    before = text[max(0, a - 40):a]
    if not before.strip() or before.rstrip(" \t").endswith("\n"):
        return True
    if P["abbreviation_end"].search(before):
        return False
    return bool(P["sentence_end"].search(before))


def _adjective(text: str, b: int, vocabulary) -> bool:
    """A noun name used as an adjective: "Schweizer Handelsplatz", "Zürcher Verwaltungsgericht"."""
    m = re.match(r" ([^\W\d_]{2,})", text[b:b + 40])
    return bool(m) and is_upper(m.group(1)[0]) and m.group(1).lower() in vocabulary


LINKS = ("", "s", "es", "n", "en", "er", "e")


def compound_split(word: str, has, depth: int = 0) -> bool:
    """True when `word` is two or more common words joined ("schneelast",
    "quartiergestaltungspläne"), with a linking s, es, n, en, er or e."""
    n = len(word)
    if n < 7 or depth > 3:
        return False
    for i in range(n - 4, 2, -1):
        if not has(word[i:]):
            continue
        head = word[:i]
        for link in LINKS:
            if link and not head.endswith(link):
                continue
            h = head[:len(head) - len(link)]
            if len(h) >= 3 and (has(h) or compound_split(h, has, depth + 1)):
                return True
    return False


def _identifiers(t: _Text, taken: _Spans, explained: _Spans, public: dict) -> list[dict]:
    text = t.text
    out = []
    for name in IDENTIFIERS:
        for m in P[name].finditer(text):
            group = 1 if name in VALUE_GROUP else 0
            a, b = m.start(group), m.end(group)
            value = m.group(group)
            if taken.overlaps(a, b) or explained.overlaps(a, b):
                continue
            label = LABEL.get(name, name)
            if name == "ahv" and not ahv_valid(value):
                continue
            if name == "iban":
                if not iban_valid(value):
                    continue
                around = _whose(text, a, 170) + re.split(r"[\n,;.]", text[b:b + 40], maxsplit=1)[0]
                if P["not_a_person"].search(around):
                    explained.add(a, b); public["iban"] = public.get("iban", 0) + 1
                    continue
            if name == "account" and _public(text, m.start(), b, 120):
                explained.add(a, b); public["account"] = public.get("account", 0) + 1
                continue
            if name == "email":
                local, _, domain = value.partition("@")
                if P["masked_local"].search(local) or P["masked_domain"].search(domain) or (not P["freemail"].search(domain) and (P["public_mail"].search(domain) or _public(text, a, b))):
                    explained.add(a, b); public["email"] = public.get("email", 0) + 1
                    continue
            if name == "url":
                if not P["social"].search(value):
                    explained.add(a, b)
                    continue
            # A landline in a letterhead or beside an office: "Postfach … Telefon … Fax …".
            if name == "phone" and not P["mobile"].match(value) and (_public(text, a, b) or P["letterhead"].match(text[b:b + 40])):
                explained.add(a, b); public["phone"] = public.get("phone", 0) + 1
                continue
            if name == "plate" and not P["plate_context"].search(text[max(0, a - 60):a]):
                continue
            if name == "address":
                if "_" in value or _public(text, a, b, 150) or P["letterhead"].match(text[b:b + 40]):
                    explained.add(a, b); public["address"] = public.get("address", 0) + 1
                    continue
            taken.add(a, b)
            out.append({"kind": "identifier", "label": label, "start": a, "end": b, "text": value})
    return out


def _runs(text: str, at: int):
    """The capitalised names in a run starting at `at`, and where the run ends."""
    m = P["name_run"].match(text, at)
    if not m:
        return [], at
    names, end = [], at
    for w in P["word"].finditer(m.group()):
        token = w.group()
        low = token.lower()
        if low in TITLES or low in PARTICLES:
            end = at + w.end()
            continue
        if not is_upper(token[0]) or P["role"].match(text, at + w.start()):
            break
        names.append(token)
        end = at + w.end()
    return names, end


def _roles(t: _Text, vocabulary) -> tuple[dict, dict, set, list]:
    """Names made public by their office, per category; categories the document
    anonymizes; the spans of office and names ("Rechtsanwalt Dr. Peter Kunz")."""
    text = t.text
    found = {"court": set(), "counsel": set(), "official": set()}
    surnames = {"court": set(), "counsel": set(), "official": set()}
    anonymized = set()
    spans = []
    for m in P["role"].finditer(text):
        if t.kind(m.start()) not in VISIBLE:
            continue                                   # a comment or a property makes no one public
        category = next(k for k in ("court", "counsel", "official") if m.group(k))
        at = m.end()
        if P["placeholder"].match(text, at) or P["initial"].match(text, at):
            anonymized.add(category)
            continue
        for _ in range(8):
            names, end = _runs(text, at)
            if not names:
                break
            # "…Kunz, Beschwerdeführer," and "avocat à Genève": common words are not names.
            if not all(n.lower() in vocabulary for n in names):
                found[category].update(names)
                surnames[category].add(names[-1])       # only the surname stands for the person elsewhere
            spans.append((category, m.start(), end))
            join = P["run_join"].match(text[end:end + 20])
            if not join or P["role"].match(text, end + join.end()):
                break
            at = end + join.end()
    # The bench block at the head of a ruling: from "Besetzung", "Composition", "Siégeant" … to the
    # first party marker. Parties never stand in it; every capitalised word in it is the court's.
    for m in P["bench_open"].finditer(text):
        if t.kind(m.start()) not in VISIBLE:
            continue
        start = m.end()
        end = min(len(text), start + 700, t.end_of_kind(start))
        close = P["bench_close"].search(text[start:end])
        if close:
            end = start + close.start()
        run = []
        last = 0
        for w in P["word"].finditer(text[start:end]):
            token = w.group()
            # A run of names ends at punctuation: "Wullschleger (Vorsitz)" is a name and an office.
            if run and re.search(r"[^\s\-]", text[start + last:start + w.start()]):
                surnames["court"].add(run[-1])
                run = []
            last = w.end()
            if token.lower() in TITLES:
                continue
            if P["role"].match(text, start + w.start()):       # "Bundesrichterin" is the office, not a name
                if run:
                    surnames["court"].add(run[-1])
                    run = []
                continue
            if is_upper(token[0]) and token.lower() not in vocabulary:
                found["court"].add(token)
                run.append(token)
            elif run:
                surnames["court"].add(run[-1])       # the last of a run of names is the surname
                run = []
        if run:
            surnames["court"].add(run[-1])
        spans.append(("court", start, end))
    keep = lambda d: {k: v for k, v in d.items() if k not in anonymized}  # noqa: E731
    return keep(found), keep(surnames), anonymized, [(a, b) for k, a, b in spans if k not in anonymized]


def check(parts: list[dict], vocabulary) -> dict:
    """parts: [{text, where: {part: 'body'|'footnote'|..., ...}}] in reading order."""
    t = _Text(parts)
    text = t.text
    taken, explained = _Spans(), _Spans()
    public: dict[str, int] = {}

    placeholders: dict[str, int] = {}
    for m in P["placeholder"].finditer(text):
        explained.add(m.start(), m.end())
        form = re.sub(r"_{2,}", "________", m.group())
        placeholders[form] = placeholders.get(form, 0) + 1
    initials = sum(1 for _ in P["initial"].finditer(text))

    shown = _identifiers(t, taken, explained, public)
    by_office, office_surnames, anonymized_roles, office_spans = _roles(t, vocabulary)
    for a, b in office_spans:
        explained.add(a, b)
    office_words = {w.lower(): k for k, ws in office_surnames.items() for w in ws}

    counts = {"common": 0, "numbers": 0}
    inflected = []                                   # common words ending in s/es: "Müllers"
    named: dict[str, set] = {"court": set(), "counsel": set(), "official": set(), "author": set(), "case": set()}
    for k, ws in by_office.items():
        named[k].update(ws)

    for m in P["word"].finditer(text):
        a, b = m.start(), m.end()
        token = m.group()
        if not is_upper(token[0]) or taken.overlaps(a, b) or explained.overlaps(a, b):
            continue
        low = token.lower()
        listed = any("!" + low[:len(low) - len(x)] in vocabulary for x in ("", "s", "es", "n"))
        title = len(token) > 1 and token[1:] == token[1:].lower()
        if low in vocabulary or (not listed and compound_split(low, vocabulary.__contains__)):
            # "~saldo": ordinary in lower case; "Saldo" in mid-sentence is the name.
            if not (title and "~" + low in vocabulary and not _sentence_start(text, a)
                    and not P["det_before"].search(text[max(0, a - 25):a])):
                counts["common"] += 1
                if low.endswith("s"):
                    inflected.append((a, b, token))
                continue
        elif "^" + low in vocabulary and (P["det_before"].search(text[max(0, a - 25):a]) or _adjective(text, b, vocabulary)):
            counts["common"] += 1                   # "^streit": "der Streit" is the noun, "Streit" alone the name
            continue
        if low in office_words:
            named[office_words[low]].add(token)
            continue
        after = text[b:b + 90]
        if P["author_after"].match(after) or _cited(text, a, b):
            named["author"].add(token)
            continue
        if P["case_after"].match(after):
            named["case"].add(token)
            continue
        shown.append({"kind": "word", "label": None, "start": a, "end": b, "text": token})

    # A common word whose stem is shown here is that name inflected ("Müllers" beside "Müller").
    stems = {fold(x["text"]) for x in shown if x["kind"] == "word"}
    for a, b, token in inflected:
        k = fold(token)
        if (k[:-1] in stems) or (k.endswith("es") and k[:-2] in stems):
            counts["common"] -= 1
            shown.append({"kind": "word", "label": None, "start": a, "end": b, "text": token})

    for m in P["code"].finditer(text):
        a, b = m.start(), m.end()
        value = m.group()
        while value and value[-1] in ".'’/-":
            value = value[:-1]
            b -= 1
        if not value or taken.overlaps(a, b) or explained.overlaps(a, b):
            continue
        if (digits_of(value) <= 4 or P["date"].match(value) or P["amount"].match(value)
                or P["section"].match(value) or P["span"].match(value) or P["reference"].match(value)
                or P["ref_before"].search(text[max(0, a - 40):a]) or P["docket_before"].search(text[max(0, a - 12):a])
                or P["unit_after"].match(text[b:b + 20])):
            counts["numbers"] += 1
            continue
        shown.append({"kind": "number", "label": None, "start": a, "end": b, "text": value})

    return _assemble(t, shown, placeholders, initials, counts, named, public, anonymized_roles, vocabulary)


def _assemble(t, shown, placeholders, initials, counts, named, public, anonymized_roles, vocabulary) -> dict:
    shown.sort(key=lambda s: s["start"])
    words = {fold(s["text"]) for s in shown if s["kind"] == "word"}

    def key_of(s):
        if s["kind"] == "word":
            k = fold(s["text"])
            for suffix in ("s", "es"):
                if k.endswith(suffix) and k[:-len(suffix)] in words:
                    return "w:" + k[:-len(suffix)]
            return "w:" + k
        if s["kind"] == "identifier":
            return "i:" + s["label"] + ":" + re.sub(r"[\W_]", "", s["text"]).lower()
        return "n:" + s["text"]

    entries: dict[str, dict] = {}
    for s in shown:
        k = key_of(s)
        e = entries.setdefault(k, {"key": k, "kind": s["kind"], "label": s["label"], "occurrences": []})
        where = t.locate(s["start"], s["end"])
        where["text"] = s["text"]
        where["visible"] = t.kind(s["start"]) in VISIBLE
        e["occurrences"].append(where)

    out = []
    for e in entries.values():
        forms: dict[str, int] = {}
        for o in e["occurrences"]:
            forms[o["text"]] = forms.get(o["text"], 0) + 1
        e["text"] = max(forms, key=lambda f: (forms[f], -e["occurrences"].index(next(o for o in e["occurrences"] if o["text"] == f))))
        e["forms"] = sorted(forms)
        e["hidden"] = not any(o["visible"] for o in e["occurrences"])
        out.append(e)
    out.sort(key=lambda e: (RANK[e["kind"]], e["occurrences"][0]["part"], e["occurrences"][0]["start"]))
    for i, e in enumerate(out):
        e["id"] = i

    people, ambiguous = _people(t, [x for x in shown if x["kind"] == "word"], vocabulary)
    anonymized = sum(placeholders.values()) >= 3 or initials >= 5
    return {
        "anonymized": anonymized,
        "placeholders": dict(sorted(placeholders.items(), key=lambda kv: (-kv[1], kv[0]))),
        "entries": out,
        "people": people,
        "ambiguous": ambiguous,
        "explained": {
            "common": counts["common"], "numbers": counts["numbers"],
            **{k: sorted(v) for k, v in named.items()},
            "public": dict(sorted(public.items())),
            "anonymized_roles": sorted(anonymized_roles),
        },
    }


_LINK = re.compile(r"[ \-‑]")
_HALF_AFTER = re.compile(r"[\-‑]([^\W\d_]{2,})")
_HALF_BEFORE = re.compile(r"(?<!\w)([^\W\d_]{2,})[\-‑]\Z")
_INITIAL_BEFORE = re.compile(r"(?<![\w.])([A-Z])\.[  ]?\Z")


def _people(t: _Text, words: list[dict], has) -> tuple[list[dict], list[dict]]:
    """People, not words. A mention is a name as written: shown words next to each
    other ("Hans Müller"), with the other half of a double name where that half is
    a name made public elsewhere ("Müller-Meier"), and a capital initial before it
    ("H. Müller"). A person is a full name, in any order and case ("MÜLLER Hans");
    a longer name holding exactly one person's name is that person ("Anna
    Müller-Keller" is Anna Müller). A single word ("Müller", "Hans", "Müllers")
    belongs to the one person it fits; where it fits several it is ambiguous and
    the clerk decides; where it fits none it is a person of its own.
    Returns (people, ambiguous), each mention a place in the parts."""
    text = t.text
    stems = {fold(w["text"]) for w in words}

    runs = []
    for w in sorted(words, key=lambda w: w["start"]):
        last = runs[-1] if runs else None
        if (last and t.index(last["end"]) == t.index(w["start"])
                and _LINK.fullmatch(text[last["end"]:w["start"]] or "x")):
            last["end"] = w["end"]
            last["names"].append(w["text"])
        else:
            runs.append({"start": w["start"], "end": w["end"], "names": [w["text"]]})

    def half(name):
        return is_upper(name[0]) and name.lower() not in has

    mentions = []
    for r in runs:
        i = t.index(r["start"])
        lo, hi = t.starts[i], t.starts[i] + len(t.parts[i]["text"])
        start, end, names = r["start"], r["end"], list(r["names"])
        m = _HALF_AFTER.match(text[end:min(hi, end + 40)])
        if m and half(m.group(1)):
            end += m.end()
            names.append(m.group(1))
        m = _HALF_BEFORE.search(text[max(lo, start - 40):start])
        if m and half(m.group(1)):
            start -= len(m.group(0))
            names.insert(0, m.group(1))
        m = _INITIAL_BEFORE.search(text[max(lo, start - 4):start])
        initial = m.group(1).lower() if m else None
        if m:
            start -= len(m.group(0))
        tokens = []
        for k, name in enumerate(names):
            f = fold(name)
            if f.endswith("s") and f[:-1] in stems:
                f = f[:-1]
                if k == len(names) - 1 and end == r["end"]:
                    end -= 1                     # the genitive s stays: "A.________s Anwalt"
            tokens.append(f)
        mentions.append({"start": start, "end": end, "tokens": sorted(set(tokens)), "initial": initial})

    people: list[dict] = []
    full = sorted((i for i, m in enumerate(mentions) if len(m["tokens"]) >= 2),
                  key=lambda i: (len(mentions[i]["tokens"]), mentions[i]["start"]))
    for i in full:
        toks = set(mentions[i]["tokens"])
        fits = [k for k, q in enumerate(people) if q["tokens"] == toks] or \
               [k for k, q in enumerate(people) if q["tokens"] <= toks]
        if len(fits) == 1:
            people[fits[0]]["mentions"].append(i)
        else:
            people.append({"tokens": toks, "mentions": [i]})
    named = len(people)
    ambiguous: dict[str, dict] = {}
    alone: dict[str, int] = {}
    for i, m in enumerate(mentions):
        if len(m["tokens"]) >= 2:
            continue
        tok = m["tokens"][0]
        fits = [k for k in range(named) if tok in people[k]["tokens"]
                and (m["initial"] is None or any(x != tok and x.startswith(m["initial"]) for x in people[k]["tokens"]))]
        if len(fits) == 1:
            people[fits[0]]["mentions"].append(i)
        elif fits:
            if tok not in ambiguous:
                ambiguous[tok] = {"mentions": [], "candidates": set()}
            ambiguous[tok]["mentions"].append(i)
            ambiguous[tok]["candidates"].update(fits)
        elif tok in alone:
            people[alone[tok]]["mentions"].append(i)
        else:
            alone[tok] = len(people)
            people.append({"tokens": {tok}, "mentions": [i]})

    def group(ms):
        ms = sorted(ms, key=lambda i: mentions[i]["start"])
        places, texts = [], []
        for i in ms:
            m = mentions[i]
            where = t.locate(m["start"], m["end"])
            where["text"] = text[m["start"]:m["end"]]
            where["visible"] = t.kind(m["start"]) in VISIBLE
            places.append(where)
            texts.append(where["text"])
        # the fullest form, the most frequent among those, the first among those
        name = max(texts, key=lambda x: (len(x.split()), texts.count(x), -texts.index(x)))
        return {"name": name, "mentions": places}

    order = sorted(range(len(people)), key=lambda k: min(mentions[i]["start"] for i in people[k]["mentions"]))
    rank = {k: n for n, k in enumerate(order)}
    out_people = [group(people[k]["mentions"]) for k in order]
    out_ambiguous = []
    for a in ambiguous.values():
        g = group(a["mentions"])
        g["candidates"] = sorted(rank[k] for k in a["candidates"])
        out_ambiguous.append(g)
    out_ambiguous.sort(key=lambda g: (g["mentions"][0]["part"], g["mentions"][0]["start"]))
    return out_people, out_ambiguous


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("file", type=Path, help="plain text, one paragraph per line")
    ap.add_argument("--vocabulary", type=Path, default=ROOT / "addin" / "data")
    args = ap.parse_args(argv)
    vocabulary = Vocabulary.open(args.vocabulary)
    lines = args.file.read_text(encoding="utf-8").split("\n")
    result = check([{"text": line, "where": {"part": "body", "index": i}} for i, line in enumerate(lines)], vocabulary)
    for e in result["entries"]:
        print(f"{e['kind']:10} {e['label'] or '':10} {e['text']:30} {len(e['occurrences'])}×  {', '.join(e['forms'])}")
    print(json.dumps(result["explained"], ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
