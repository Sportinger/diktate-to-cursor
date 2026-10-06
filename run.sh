#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [ "$#" -eq 0 ]; then
    set -- start
fi
exec .venv/bin/python -m diktate "$@"
