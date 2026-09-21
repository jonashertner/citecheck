import gzip
import hashlib
import json
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
    assert rows["BGE 140 III 0115"][4] == "1,2,2.1,2.2,2.3,3,3.1,3.2,4"
    assert rows["4A_747/2012"][4].endswith("4,5,10")            # natural order
    assert "4A_999/2013" in rows and rows["4A_999/2013"][1] == "bge"   # the BGE's own file number
    assert "4P_166/2006" in rows                                 # docket alias
    assert rows["HC/2018/391"][2] == "VD"
    assert sum(1 for line in lines if line.startswith("K 2015/3\t")) == 2
    assert manifest["decisions"] == 13 and manifest["with_numbering"] == 3
    assert manifest["courts"]["bger"] == {"canton": "CH", "decisions": 3, "with_numbering": 1, "first": "2006-10-02", "last": "2013-06-20"}
    assert not any("\t".join(r).count("x") for r in rows.values() if r[0].startswith("BGE"))  # no decision text


def test_old_index_files_are_removed(tmp_path):
    pack = make(tmp_path / "pack.sqlite")
    out = tmp_path / "out"
    out.mkdir()
    (out / "cite-index-2020-01-01.tsv.gz").write_bytes(b"old")
    b.build(pack, out, log=lambda m: None)
    assert sorted(p.name for p in out.iterdir()) == ["cite-index-2026-01-04.tsv.gz", "index.json"]
