#!/usr/bin/env python3
"""Build the cite list from the nightly corpus and publish it to the HuggingFace
mirror, from where the Pages site fetches it.

    python build/publish_cite_index.py --repo-dir /opt/caselaw/repo --out /var/lib/citecheck/index

Waits, bounded, while the nightly pipeline (publish.py) is running: the build
reads decisions.db, and a scan of that file during the build window is not
allowed. Then builds with build_cite_index.py --dataset-dir, uploads index.json
and the list to artifacts/cite_index/ in the dataset repository and removes
older lists there. HF_TOKEN comes from the environment (the publish unit's
.env.publish). Exit 0 on success, 2 when the pipeline never finished within
--wait-hours, 1 on any other failure. Nothing here touches the corpus files.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ID = "voilaj/swiss-caselaw"
REMOTE_DIR = "artifacts/cite_index"


def _log(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + message, file=sys.stderr, flush=True)


def pipeline_running() -> bool:
    out = subprocess.run(["pgrep", "-f", "publish.py"], capture_output=True, text=True).stdout.split()
    return any(pid != str(os.getpid()) for pid in out)


def wait_for_pipeline(hours: float) -> bool:
    deadline = time.time() + hours * 3600
    while pipeline_running():
        if time.time() > deadline:
            return False
        _log("publish.py is running; waiting 10 min")
        time.sleep(600)
    return True


def upload(out_dir: Path, manifest: dict, token: str) -> None:
    from huggingface_hub import HfApi  # noqa: WPS433
    api = HfApi(token=token)
    api.upload_file(path_or_fileobj=str(out_dir / manifest["file"]), path_in_repo=f"{REMOTE_DIR}/{manifest['file']}",
                    repo_id=REPO_ID, repo_type="dataset", commit_message=f"cite index {manifest['generated'][:10]}")
    api.upload_file(path_or_fileobj=str(out_dir / "index.json"), path_in_repo=f"{REMOTE_DIR}/index.json",
                    repo_id=REPO_ID, repo_type="dataset", commit_message=f"cite index manifest {manifest['generated'][:10]}")
    for path in api.list_repo_files(REPO_ID, repo_type="dataset"):
        name = path.rsplit("/", 1)[-1]
        if path.startswith(REMOTE_DIR + "/cite-index-") and name != manifest["file"]:
            api.delete_file(path, repo_id=REPO_ID, repo_type="dataset", commit_message=f"remove superseded {name}")
            _log(f"removed {path}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-dir", type=Path, default=Path("/opt/caselaw/repo"))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--wait-hours", type=float, default=6)
    ap.add_argument("--no-upload", action="store_true")
    args = ap.parse_args(argv)
    output = args.repo_dir / "output"
    if not wait_for_pipeline(args.wait_hours):
        _log("publish.py still running; giving up for today")
        return 2
    cmd = [sys.executable, str(HERE / "build_cite_index.py"), "--dataset-dir", str(output / "dataset"),
           "--decisions-db", str(output / "decisions.db"), "--structure-db", str(output / "decision_structure.db"), "--out", str(args.out)]
    _log("building: " + " ".join(cmd))
    if subprocess.run(["nice", "-n", "19", "ionice", "-c", "3", *cmd]).returncode != 0:
        return 1
    manifest = json.loads((args.out / "index.json").read_text(encoding="utf-8"))
    _log(f"built {manifest['file']}: {manifest['decisions']:,} decisions, {manifest['labels']:,} labels, {manifest['bytes']:,} bytes")
    if args.no_upload:
        return 0
    token = os.environ.get("HF_TOKEN")
    if not token:
        _log("HF_TOKEN is not set; not uploading")
        return 1
    upload(args.out, manifest, token)
    _log(f"uploaded to {REPO_ID}/{REMOTE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
