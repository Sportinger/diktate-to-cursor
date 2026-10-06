#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m diktate install
