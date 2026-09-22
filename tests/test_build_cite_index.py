import gzip
import hashlib
import json
import pytest
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "build"))
sys.path.insert(0, str(ROOT / "tests"))
import build_cite_index as b  # noqa: E402
from make_fixture_pack import make  # noqa: E402


def test_keys_agree_with_the_shared_cases():
    cases = json.loads((ROOT / "tests/fixtures/key_cases.json").read_text())
    for written, key in cases["docket"]:
        assert b.docket_key(written) == key
    for (vol, part, page), key in cases["bge"]:
        assert b.bge_key(vol, part, page) == key


def test_build_is_sorted_verified_and_reproducible(tmp_path):
    pack = make(tmp_path / "pack.sqlite")
    manifest = b.build(pack, tmp_path / "a", log=lambda m: None)
    again = b.build(pack, tmp_path / "b", log=lambda m: None)
    assert manifest["sha256"] == again["sha256"]
    blob = (tmp_path / "a" / manifest["file"]).read_bytes()
    assert hashlib.sha256(blob).hexdigest() == manifest["sha256"] and len(blob) == manifest["bytes"]
    lines = gzip.decompress(blob).decode().splitlines()
    assert lines[0] == b.HEADER
    keys = [line.split("\t")[0].encode() for line in lines[1:]]
    assert keys == sorted(keys)
    rows = {line.split("\t")[0]: line.split("\t") for line in lines[1:]}
    assert rows["BGE 140 III 0115"][4:] == ["1,2,2.1,2.2,2.3,3,3.1,3.2,4", "bge_140_III_115"]
    assert rows["4P_166/2006"][5] == "bger_4C_230_2006"          # an alias leads to the decision it names
    assert rows["4A_747/2012"][4].endswith("4,5,10")            # natural order
    assert "4A_999/2013" in rows and rows["4A_999/2013"][1] == "bge"   # the BGE's own file number
    assert "4P_166/2006" in rows                                 # docket alias
    assert rows["HC/2018/391"][2] == "VD"
    assert rows["BGE 073 II 0006"][4] == "3,4,5,6" and "73_II_6" not in rows   # early volumes are keyed like the rest
    assert sum(1 for line in lines if line.startswith("K 2015/3\t")) == 2
    assert manifest["decisions"] == 14 and manifest["with_numbering"] == 4
    assert manifest["bge_volumes"] == {"first": 73, "last": 140, "absent": list(range(74, 140))}
    assert manifest["courts"]["bger"] == {"canton": "CH", "decisions": 3, "with_numbering": 1, "first": "2006-10-02", "last": "2013-06-20"}
    assert not any("\t".join(r).count("x") for r in rows.values() if r[0].startswith("BGE"))  # no decision text


def test_old_index_files_are_removed(tmp_path):
    pack = make(tmp_path / "pack.sqlite")
    out = tmp_path / "out"
    out.mkdir()
    (out / "cite-index-2020-01-01.tsv.gz").write_bytes(b"old")
    b.build(pack, out, log=lambda m: None)
    names = sorted(p.name for p in out.iterdir())
    assert len(names) == 2 and names[1] == "index.json" and re.fullmatch(r"cite-index-2026-01-04-[0-9a-f]{8}\.tsv\.gz", names[0])


def test_the_nightly_corpus_gives_the_same_list_as_the_pack(tmp_path):
    pytest.importorskip("pyarrow")
    from make_fixture_pack import make_corpus
    pack = make(tmp_path / "pack.sqlite")
    from_pack = b.build(pack, tmp_path / "a", log=lambda m: None)
    dataset, decisions_db, structure_db = make_corpus(tmp_path / "corpus")
    from_corpus = b.build(b.CorpusSource(dataset, decisions_db, structure_db), tmp_path / "b", log=lambda m: None)
    lines = lambda d, m: gzip.decompress((d / m["file"]).read_bytes()).decode().splitlines()
    assert lines(tmp_path / "b", from_corpus) == lines(tmp_path / "a", from_pack)
    assert from_corpus["source"] == "OpenCaseLaw nightly corpus export"
    assert from_corpus["courts"] == from_pack["courts"]
