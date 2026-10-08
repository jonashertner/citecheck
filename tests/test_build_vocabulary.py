"""The rules that decide what goes into the word list, on synthetic counts.

Columns of a count row: rulings, courts, capitalised, lower case, all capitals, after a title or
office, after a first name. `row(...)` takes the old five and places the name evidence as titles.
"""
import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))
import build_vocabulary as bv  # noqa: E402
from anon_engine import Vocabulary  # noqa: E402

ARGS = argparse.Namespace(min_docs=5, min_courts=2, or_docs=30, noun_docs=500, ratio=100.0, name_context=0.1,
                          unknown_min_docs=2000, named=0.25)
RESIDENTS = 8_000_000
TOTAL = 1_000_000


def widen(stats):
    return {w: (r if len(r) == bv.WIDTH else [r[0], r[1], r[2], r[3], 0, r[4], 0]) for w, r in stats.items()}


def decide(stats, names=(), bearers=None):
    common, report = bv.decide(widen(stats), set(names), bearers or {}, RESIDENTS, TOTAL, ARGS)
    return set(common), report


def test_frequent_words_from_several_courts_are_common():
    common, _ = decide({"beschwerde": [90_000, 80, 200_000, 1_000, 10], "kantonal": [5, 2, 0, 9, 0],
                        "einmalig": [4, 3, 2, 2, 0], "hauswort": [20, 1, 60, 0, 0], "sagl": [400, 1, 500, 0, 0]})
    assert common == {"beschwerde", "kantonal", "sagl"}    # 4 rulings, or 20 in one court, is not enough; 400 in one is


def test_a_name_stays_out_however_often_judges_carry_it():
    stats = {"seiler": [14_000, 3, 15_000, 1, 9_000], "meyer": [26_000, 40, 30_000, 14, 4_000]}
    common, _ = decide(stats, names={"seiler", "meyer"}, bearers={"seiler": 4_274, "meyer": 17_259})
    assert common == set()


def test_a_name_that_is_an_ordinary_word_is_common():
    stats = {
        "märz": [127_000, 90, 140_000, 0, 50],        # 74 residents, never after a title: ratio far above 100
        "recht": [118_000, 90, 150_000, 15_000, 10],
        "loi": [2_245, 30, 2_500, 32_000, 3],          # written in lower case far more often
        "müller": [14_000, 90, 16_000, 3, 6_000],      # 52,674 residents: a name
    }
    bearers = {"märz": 74, "recht": 19, "loi": 117, "müller": 52_674}
    common, report = decide(stats, names=set(bearers), bearers=bearers)
    assert common == {"märz", "recht", "loi"}
    assert report["names_treated_as_words"] == 3


def test_an_inflected_name_is_judged_like_the_name():
    stats = {"müllers": [900, 20, 950, 0, 400], "lehrers": [3_000, 40, 3_100, 5, 2]}
    common, _ = decide(stats, names={"müller", "lehrer"}, bearers={"müller": 52_674, "lehrer": 30})
    assert common == {"lehrers"}                           # "Lehrer" is a rare surname and an ordinary word


def test_a_word_on_no_list_is_a_name_when_the_corpus_writes_it_as_one():
    stats = {
        "ravnsborg": [40, 3, 120, 0, 90],              # "Mr Göran Ravnsborg"
        "kneubühler": [8_000, 4, 9_000, 0, 7_000],     # "Bundesrichter Kneubühler"
        "präsident": [60_000, 90, 70_000, 10, 30_000],  # follows "Herr" often, but is an office
        "hill": [300, 10, 300, 900, 200],              # mostly lower case: an ordinary word
    }
    common, report = decide(stats)
    assert common == {"präsident", "hill"}
    assert set(report["names_by_context_examples"]) == {"ravnsborg", "kneubühler"}


def test_a_name_only_on_wikidata_needs_much_evidence_to_count_as_a_word():
    stats = {"doorson": [300, 2, 320, 0, 5], "gericht": [500_000, 100, 600_000, 1_000, 10]}
    common, _ = decide(stats, names={"doorson", "gericht"})
    assert common == {"gericht"}


def test_acronyms_are_common_and_a_name_in_capitals_is_still_a_name():
    stats = {"zgb": [190_000, 60, 400_000, 0, 390_000, 0, 0], "rad": [9_000, 20, 12_000, 30, 11_000, 0, 0],
             "kaya": [36, 9, 60, 2, 40, 5, 30]}
    common, _ = decide(stats, names={"rad", "kaya"}, bearers={"rad": 40, "kaya": 2_000})
    assert common == {"zgb", "rad"}                        # RAD by its ratio; KAYA stays a name


def test_first_name_evidence_keeps_an_author_a_name_and_leaves_ordinary_words_alone():
    # "Ueli Kieser, ATSG-Kommentar": no title, but a first name before him. "Die Kosten": the count
    # never takes "Die" for a first name (FUNCTION_WORDS), so Kosten has next to no such evidence.
    stats = {"kieser": [7_000, 20, 8_000, 0, 0, 100, 3_000], "kosten": [500_000, 100, 900_000, 1_000, 0, 50, 200]}
    common, _ = decide(stats, names={"kieser", "kosten"}, bearers={"kieser": 153, "kosten": 12})
    assert common == {"kosten"}
    assert "die" in bv.FUNCTION_WORDS and "de" in bv.FUNCTION_WORDS


def test_the_written_list_is_sorted_by_bytes_and_carries_compound_exceptions(tmp_path):
    stats = {w: [100, 5, 200, 0, 0, 0, 0] for w in ["hof", "mann", "schnee", "last", "zürich", "zug"]}
    pkl = tmp_path / "stats.pkl"
    pkl.write_bytes(bv.pickle.dumps((stats, TOTAL, ["a.parquet", "b.parquet"])))
    names = tmp_path / "names"
    names.mkdir()
    (names / "bfs_surnames_canton.csv").write_text('"TIME_PERIOD","LASTNAME","GDEKT","RANG_KT","VALUE","OBS_STATUS"\n"2025","Hofmann","ZH","1","6121","A"\n', encoding="utf-8")
    out = tmp_path / "out"
    assert bv.main(["--from-stats", "--stats", str(pkl), "--names-dir", str(names), "--out", str(out)]) == 0
    manifest = json.loads((out / "vocabulary.json").read_text(encoding="utf-8"))
    lines = gzip.decompress((out / manifest["file"]).read_bytes()).decode().split("\n")
    assert lines[0] == "#ocl-vocabulary 1"
    body = [w for w in lines[1:] if w]
    assert body == sorted(body, key=lambda s: s.encode())
    assert "!hofmann" in body and "hofmann" not in body
    v = Vocabulary.open(out)
    assert "zürich" in v and "!hofmann" in v
    assert manifest["words"] == 6 and manifest["exceptions"] == 1


def test_names_that_are_words_carry_a_mark_for_the_check():
    stats = {
        "saldo": [20_000, 40, 2_000, 30_000, 0, 5, 20],          # capitalised 7 % of the time: "~saldo"
        "frei": [80_000, 90, 27_840, 112_629, 0, 50, 300],         # capitalised 25 %: German sentence starts, no mark
        "streit": [40_000, 90, 60_000, 400, 0, 30, 60],           # a noun and a name: "^streit"
        "müller": [59_000, 102, 106_621, 123, 0, 8_450, 30_105],  # written as a name: no mark, a name
    }
    bearers = {"saldo": 300, "streit": 9_000, "müller": 52_674, "frei": 13_860}   # Streit: frequent too, but 9,000 bearers keep the ratio low
    a = argparse.Namespace(**vars(ARGS))
    common, report = bv.decide(widen(stats), set(bearers), bearers, RESIDENTS, TOTAL, a)
    assert set(common) == {"saldo", "frei"}
    assert sorted(a.marked) == ["^streit", "~saldo"]
    assert report["lower_case_only"] == 1 and report["noun_names"] == 1
