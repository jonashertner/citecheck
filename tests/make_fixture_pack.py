"""A tiny verification pack with invented decisions, for tests only (schema of
scripts/build_verification_pack.py in the OpenCaseLaw repository)."""
import sqlite3
import zlib
from pathlib import Path

DECISIONS = [
    # decision_id, court, canton, date, docket, docket_2
    ("bge_140_III_115", "bge", "CH", "2014-02-11", "140 III 115", "4A_999/2013"),
    ("bge_140_III_134", "bge", "CH", "2014-03-04", "140 III 134", None),
    ("bge_140_III_16", "bge", "CH", "2013-12-03", "140 III 16", None),
    ("bge_140_II_202", "bge", "CH", "2014-04-01", "140 II 202", None),
    ("bge_73_II_6", "bge", "CH", "1947-01-01", "73_II_6", None),          # early volumes: underscores, year-only date
    ("bger_4A_747_2012", "bger", "CH", "2013-04-05", "4A_747/2012", None),
    ("bger_4A_774_2012", "bger", "CH", "2013-06-20", "4A_774/2012", None),
    ("bger_4C_230_2006", "bger", "CH", "2006-10-02", "4C.230/2006", None),
    ("bvger_A-4843_2020", "bvger", "CH", "2021-05-17", "A-4843/2020", None),
    ("zh_obergericht_LB190012", "zh_obergericht", "ZH", "2019-09-12", "LB190012-O", None),
    ("zh_vger_VB.2023.00538", "zh_verwaltungsgericht", "ZH", "2024-01-25", "VB.2023.00538", None),
    ("vd_HC_2018_391", "vd_gerichte", "VD", "2018-07-02", "HC / 2018 / 391", None),
    ("sg_K_2015_3", "sg_gerichte", "SG", "2015-08-19", "K 2015/3", None),
    ("ag_K_2015_3", "ag_gerichte", "AG", "2015-02-02", "K 2015/3", None),
]
PARAGRAPHS = {
    "bge_140_III_115": ["1", "2", "2.1", "2.2", "2.3", "3", "3.1", "3.2", "4"],
    "bger_4A_747_2012": ["1", "2", "3", "3.1", "3.2", "3.3", "4", "10", "5"],
    "bge_73_II_6": ["3", "4", "5", "6"],
    "bvger_A-4843_2020": ["1.1", "1.2", "2", "2a", "3"],
}


def make(path: Path) -> Path:
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE decisions (decision_id TEXT PRIMARY KEY, court TEXT, canton TEXT, language TEXT, decision_date TEXT,
            docket_number TEXT, docket_number_2 TEXT, citation_string_de TEXT, citation_string_fr TEXT, citation_string_it TEXT,
            canonical_url TEXT, source_url TEXT, content_hash TEXT, canonical_decision_id TEXT, has_full_text INTEGER);
        CREATE TABLE aliases (alias_docket_norm TEXT, canonical_decision_id TEXT);
        CREATE TABLE paragraphs (decision_id TEXT, e_number TEXT, depth INTEGER, parent TEXT, text_z BLOB,
            PRIMARY KEY (decision_id, e_number)) WITHOUT ROWID;
    """)
    con.executemany("INSERT INTO meta VALUES (?,?)", [("schema_version", "2"), ("built_at", "2026-01-04T05:00:00+00:00"), ("db_generation", "fixture")])
    con.executemany("INSERT INTO decisions (decision_id, court, canton, decision_date, docket_number, docket_number_2, canonical_decision_id) VALUES (?,?,?,?,?,?,?)",
                    [(*d, d[0]) for d in DECISIONS])
    con.execute("INSERT INTO aliases VALUES ('4P_166/2006', 'bger_4C_230_2006')")
    for decision_id, numbers in PARAGRAPHS.items():
        con.executemany("INSERT INTO paragraphs VALUES (?,?,0,NULL,?)", [(decision_id, n, zlib.compress(b"x")) for n in numbers])
    con.commit()
    con.close()
    return path


if __name__ == "__main__":
    import sys
    make(Path(sys.argv[1]))


def make_corpus(directory: Path) -> tuple[Path, Path, Path]:
    """The same invented decisions as the nightly corpus files: per-court Parquet,
    decisions.db with the docket aliases, decision_structure.db with the numbers."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    directory.mkdir(parents=True, exist_ok=True)
    dataset = directory / "dataset"
    dataset.mkdir(exist_ok=True)
    cols = ["decision_id", "court", "canton", "decision_date", "docket_number", "docket_number_2"]
    by_court: dict[str, list] = {}
    for row in DECISIONS:
        by_court.setdefault(row[1], []).append(row)
    for court, rows in by_court.items():
        table = pa.table({c: [r[i] for r in rows] for i, c in enumerate(cols)} | {"full_text": ["x" * 10] * len(rows)})
        pq.write_table(table, dataset / f"{court}.parquet")
    decisions_db = directory / "decisions.db"
    con = sqlite3.connect(decisions_db)
    con.execute("CREATE TABLE decision_docket_aliases (court TEXT, alias_docket TEXT, alias_docket_norm TEXT, canonical_decision_id TEXT, extraction_method TEXT)")
    con.execute("INSERT INTO decision_docket_aliases VALUES ('bger', '4P.166/2006', '4P_166/2006', 'bger_4C_230_2006', 'caption')")
    con.commit(); con.close()
    structure_db = directory / "decision_structure.db"
    con = sqlite3.connect(structure_db)
    con.execute("CREATE TABLE erwaegungen_paragraph (decision_id TEXT, e_number TEXT, depth INTEGER, parent TEXT, text TEXT, PRIMARY KEY (decision_id, e_number))")
    for decision_id, numbers in PARAGRAPHS.items():
        con.executemany("INSERT INTO erwaegungen_paragraph VALUES (?,?,0,NULL,'x')", [(decision_id, n) for n in numbers])
    con.commit(); con.close()
    return dataset, decisions_db, structure_db
