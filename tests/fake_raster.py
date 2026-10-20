#!/usr/bin/env python3
"""Stand-in for the `raster` CLI in the isolated GNOME smoke test: answers `focused`, logs `type`."""
import json
import os
import sys
from pathlib import Path

artifacts = Path(os.environ["DIKTATE_TEST_ARTIFACTS"])
args = sys.argv[1:]
if args[:1] == ["focused"]:
    focus_file = artifacts / "raster-focus.txt"
    pane = focus_file.read_text().strip() if focus_file.exists() else "pane-1"
    print(json.dumps({"id": pane, "spec": {"project": "demo", "name": pane}}))
elif args[:1] == ["type"] and len(args) > 1:
    if (artifacts / "raster-fail.txt").exists():
        print(json.dumps({"error": {"code": "not_found", "message": "test"}}))
        sys.exit(1)
    text = args[args.index("--text") + 1] if "--text" in args else sys.stdin.read()
    entry = {"pane": args[1], "text": text, "enter": "--enter" in args, "pane_env": os.environ.get("RASTER_PANE_ID")}
    with open(artifacts / "raster.jsonl", "a", encoding="utf-8") as log:
        log.write(json.dumps(entry) + "\n")
    print('"ok"')
else:
    sys.exit(2)
