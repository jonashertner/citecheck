"""build/nginx/count_downloads.sh against a synthetic tier1 log directory."""
import gzip
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "build" / "nginx" / "count_downloads.sh"
UA = '"Mozilla/5.0 (Windows NT 10.0)"'


def line(addr, ts, uri="/citecheck/manifest.xml", status=200, method="GET", ua=UA):
    return f'{addr} {ts}+00:00 "{method} {uri}" {status} 0.001 {ua}\n'


# reverse DNS without the network: the stub knows two cloud addresses
RDNS_STUB = """case $1 in
  192.0.2.10) echo 10.2.0.192.bc.googleusercontent.com. ;;
  192.0.2.11) echo crawl-192-0-2-11.googlebot.com. ;;
esac
"""


def make_logs(d: Path):
    # oldest file: 09-23 is the partial first day and must never be recorded
    with gzip.open(d / "tier1.log-20260924-00.gz", "wt") as fh:
        fh.write(line("198.51.100.9", "2026-09-23T23:59:00"))
        fh.write(line("198.51.100.1", "2026-09-24T08:00:00"))
        fh.write(line("198.51.100.1", "2026-09-24T08:05:00", status=304))
        fh.write(line("203.0.113.7", "2026-09-24T09:00:00"))  # ours
        fh.write(line("198.51.100.2", "2026-09-24T10:00:00", status=404))
        fh.write(line("198.51.100.3", "2026-09-24T11:00:00", method="HEAD"))
    (d / "tier1.log-20260926-00").write_text(
        line("198.51.100.4", "2026-09-25T12:00:00", uri="/entscheid/x")  # zero day
        + line("198.51.100.5", "2026-09-26T07:00:00", uri="/citecheck/manifest.xml?v=2")
    )
    (d / "tier1.log").write_text(line("198.51.100.6", "2026-09-27T01:00:00"))
    (d / "exclude").write_text("# our Mac\n203.0.113.7  # mini\n")
    (d / "rdns.sh").write_text(RDNS_STUB)


def run(d: Path, *args):
    env = {"PATH": "/usr/bin:/bin", "CITECHECK_LOG_DIR": str(d),
           "CITECHECK_EXCLUDE": str(d / "exclude"), "CITECHECK_TODAY": "2026-09-27",
           "CITECHECK_SINCE": "2026-09-01", "CITECHECK_RDNS": f"sh {d / 'rdns.sh'}"}
    return subprocess.run(["sh", str(SCRIPT), *args], env=env, text=True,
                          capture_output=True, check=True).stdout


def test_print_counts_every_day_in_every_rotated_file(tmp_path):
    make_logs(tmp_path)
    out = run(tmp_path).splitlines()
    by_day = {l.split()[0]: (int(l.split()[1]), int(l.split()[3]), int(l.split()[5])) for l in out}
    assert by_day["2026-09-24"] == (2, 1, 0)   # 200 + 304, one address; ours, 404, HEAD not
    assert by_day["2026-09-25"] == (0, 0, 0)
    assert by_day["2026-09-26"] == (1, 1, 0)   # query string still counts
    assert by_day["2026-09-27"] == (1, 1, 0)


def test_record_appends_complete_days_once(tmp_path):
    make_logs(tmp_path)
    rec = tmp_path / "downloads.tsv"
    run(tmp_path, "--record", str(rec))
    assert rec.read_text().splitlines() == [
        "day\tdownloads\tunique\tbots",
        "2026-09-24\t2\t1\t0",
        "2026-09-25\t0\t0\t0",   # measured zero, recorded as such
        "2026-09-26\t1\t1\t0",
    ]                          # 09-23 partial and 09-27 (today) left out
    first = rec.read_text()
    run(tmp_path, "--record", str(rec))
    assert rec.read_text() == first


def test_days_before_since_are_ignored(tmp_path):
    make_logs(tmp_path)
    (tmp_path / "tier1.log.2.gz").write_bytes(
        gzip.compress(line("198.51.100.8", "2026-04-13T10:00:00", uri="/x").encode()))
    days = [l.split()[0] for l in run(tmp_path).splitlines()]
    assert "2026-04-13" not in days
    rec = tmp_path / "downloads.tsv"
    run(tmp_path, "--record", str(rec))
    # the April file is now the oldest, so 09-23 counts as a full day
    assert rec.read_text().splitlines()[1] == "2026-09-23\t1\t1\t0"


def test_missing_exclude_file_counts_everyone(tmp_path):
    make_logs(tmp_path)
    (tmp_path / "exclude").unlink()
    by_day = {l.split()[0]: int(l.split()[1]) for l in run(tmp_path).splitlines()}
    assert by_day["2026-09-24"] == 3


def test_crawlers_and_link_scanners_are_counted_apart(tmp_path):
    make_logs(tmp_path)
    edge = '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0"'
    (tmp_path / "tier1.log").write_text(
        line("198.51.100.6", "2026-09-27T01:00:00")
        + line("66.249.73.194", "2026-09-27T02:00:00",
               ua='"Mozilla/5.0 (Linux; Android 6.0.1) Mobile Safari/537.36 (compatible; GoogleOther)"')
        + line("57.141.20.41", "2026-09-27T03:00:00",
               ua='"Mozilla/5.0 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))"')
        + line("192.0.2.10", "2026-09-27T08:41:34", ua=edge)   # mail-link scanner, browser agent
        + line("198.51.100.7", "2026-09-27T08:41:35", ua=edge)  # the person who got the mail
        + line("192.0.2.11", "2026-09-27T09:00:00", ua=edge)
        + line("198.51.100.8", "2026-09-27T10:00:00", ua='"curl/8.7.1"')
    )
    by_day = {l.split()[0]: (int(l.split()[1]), int(l.split()[3]), int(l.split()[5])) for l in run(tmp_path).splitlines()}
    assert by_day["2026-09-27"] == (3, 3, 4)


def test_old_three_column_record_gets_the_new_header(tmp_path):
    make_logs(tmp_path)
    rec = tmp_path / "downloads.tsv"
    rec.write_text("day\tdownloads\tunique\n2026-09-24\t5\t5\n")
    run(tmp_path, "--record", str(rec))
    assert rec.read_text().splitlines() == [
        "day\tdownloads\tunique\tbots",
        "2026-09-24\t5\t5",       # old row kept as recorded
        "2026-09-25\t0\t0\t0",
        "2026-09-26\t1\t1\t0",
    ]
