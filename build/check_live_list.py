#!/usr/bin/env python3
"""Check that the cite list the pane loads is current.

    python build/check_live_list.py [--max-age-hours 48] [--deploy-lag-hours 6]

Reads two public files: index.json as the Pages site serves it, and index.json
on the HuggingFace mirror, where the nightly build uploads. Fails when the
served list is older than --max-age-hours (the build has stopped, whatever the
cause), or when the mirror has held a newer list for more than
--deploy-lag-hours without the site serving it (the Pages deploy has stopped:
in October 2026 a run that never got a runner blocked every deploy for two
days). Exit 0 when current, 1 when stale, 3 when a file could not be read.
Read-only: two GET requests.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone

LIVE = "https://jonashertner.github.io/citecheck/index/index.json"
MIRROR = "https://huggingface.co/datasets/voilaj/swiss-caselaw/resolve/main/artifacts/cite_index/index.json"


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "citecheck-freshness", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def _age_hours(manifest: dict, now: datetime) -> float:
    generated = datetime.strptime(manifest["generated"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (now - generated).total_seconds() / 3600


def problems(live: dict, mirror: dict, now: datetime, max_age_hours: float, deploy_lag_hours: float) -> list[str]:
    found = []
    live_age = _age_hours(live, now)
    if live_age > max_age_hours:
        found.append(f"served list {live['file']} is {live_age:.0f} h old (limit {max_age_hours:.0f} h)")
    mirror_age = _age_hours(mirror, now)
    if mirror["file"] != live["file"] and mirror["generated"] > live["generated"] and mirror_age > deploy_lag_hours:
        found.append(f"mirror has {mirror['file']} since {mirror_age:.0f} h, the site still serves {live['file']}")
    return found


def main(argv=None, fetch=fetch, now=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--max-age-hours", type=float, default=48)
    ap.add_argument("--deploy-lag-hours", type=float, default=6)
    args = ap.parse_args(argv)
    now = now or datetime.now(timezone.utc)
    try:
        live, mirror = fetch(LIVE), fetch(MIRROR)
    except Exception as exc:  # noqa: BLE001 - any read failure is reported the same way
        print(f"could not read a list manifest: {exc}", file=sys.stderr)
        return 3
    found = problems(live, mirror, now, args.max_age_hours, args.deploy_lag_hours)
    for message in found:
        print("STALE: " + message, file=sys.stderr)
    if not found:
        print(f"ok: serving {live['file']} ({live['decisions']:,} decisions, {_age_hours(live, now):.0f} h old)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
