"""build/check_live_list.py with stubbed manifests (no network)."""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_live_list", Path(__file__).resolve().parents[1] / "build" / "check_live_list.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

NOW = datetime(2026, 10, 8, 7, 0, tzinfo=timezone.utc)


def manifest(day, time="19:56:01"):
    return {"file": f"cite-index-{day}-abc.tsv.gz", "generated": f"{day}T{time}Z", "decisions": 1078001}


def run(live, mirror):
    lists = {check.LIVE: live, check.MIRROR: mirror}
    return check.main([], fetch=lists.__getitem__, now=NOW)


def test_current_list_passes(capsys):
    assert run(manifest("2026-10-07"), manifest("2026-10-07")) == 0
    assert "ok: serving cite-index-2026-10-07" in capsys.readouterr().out


def test_one_skipped_build_is_tolerated():
    assert run(manifest("2026-10-06"), manifest("2026-10-06")) == 0


def test_build_stopped_fails(capsys):
    assert run(manifest("2026-10-05"), manifest("2026-10-05")) == 1
    assert "59 h old" in capsys.readouterr().err


def test_stuck_deploy_fails(capsys):
    assert run(manifest("2026-10-06"), manifest("2026-10-07", "18:00:00")) == 1
    assert "the site still serves cite-index-2026-10-06" in capsys.readouterr().err


def test_fresh_upload_not_yet_deployed_passes():
    assert run(manifest("2026-10-07"), manifest("2026-10-08", "02:30:00")) == 0


def test_unreadable_manifest_is_its_own_exit_code():
    def fail(url):
        raise OSError("HTTP 503")
    assert check.main([], fetch=fail, now=NOW) == 3
