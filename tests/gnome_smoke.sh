#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project_dir="$PWD"
test_root="$(mktemp -d -t diktate-gnome.XXXXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
export XDG_DATA_HOME="$test_root/data"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_CACHE_HOME="$test_root/cache"
export XDG_STATE_HOME="$test_root/state"
export WAYLAND_DISPLAY="diktate-smoke-$$"
export GDK_BACKEND=wayland
export DIKTATE_TEST_ARTIFACTS="$project_dir/.test-artifacts"
# The optional Raster integration talks to a stand-in, never to a real Raster terminal.
export DIKTATE_RASTER_BIN="$project_dir/tests/fake_raster.py"
unset RASTER_SOCK RASTER_PANE_ID RASTER_PANE_KIND RASTER_PANE_ADDR
mkdir -p "$DIKTATE_TEST_ARTIFACTS" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
printf 'XDG_PICTURES_DIR="%s/pictures"\n' "$test_root" > "$XDG_CONFIG_HOME/user-dirs.dirs"
rm -f "$DIKTATE_TEST_ARTIFACTS/client-screenshot.json"
rm -f "$DIKTATE_TEST_ARTIFACTS/client.json" "$DIKTATE_TEST_ARTIFACTS/shell.json" "$DIKTATE_TEST_ARTIFACTS/shell-error.txt" "$DIKTATE_TEST_ARTIFACTS/submitted.json"
rm -f "$DIKTATE_TEST_ARTIFACTS/raster.jsonl" "$DIKTATE_TEST_ARTIFACTS/raster-focus.txt" "$DIKTATE_TEST_ARTIFACTS/raster-fail.txt"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/diktate-to-cursor@local" "$XDG_DATA_HOME/gnome-shell/extensions/diktate-smoke@local"
cp -r gnome-extension/* "$XDG_DATA_HOME/gnome-shell/extensions/diktate-to-cursor@local/"
glib-compile-schemas "$XDG_DATA_HOME/gnome-shell/extensions/diktate-to-cursor@local/schemas"
cp tests/gnome_harness.js "$XDG_DATA_HOME/gnome-shell/extensions/diktate-smoke@local/extension.js"
cat > "$XDG_DATA_HOME/gnome-shell/extensions/diktate-smoke@local/metadata.json" <<'JSON'
{"uuid":"diktate-smoke@local","name":"Diktate smoke test","description":"Isolated integration test","shell-version":["50"],"version":1}
JSON
export DIKTATE_TEST_ROOT="$test_root"
dbus-run-session -- bash -c '
set -euo pipefail
gsettings set org.gnome.shell enabled-extensions "['\''diktate-to-cursor@local'\'', '\''diktate-smoke@local'\'']"
gsettings set org.gnome.desktop.input-sources sources "[('\''xkb'\'', '\''de'\'')]"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "'\''50.1'\''"
.venv/bin/python tests/gnome_client.py "$DIKTATE_TEST_ARTIFACTS" > "$DIKTATE_TEST_ARTIFACTS/client.log" 2>&1 &
client_pid=$!
gnome-shell --headless --virtual-monitor 1280x720 --wayland --wayland-display "$WAYLAND_DISPLAY" --no-x11 > "$DIKTATE_TEST_ARTIFACTS/shell.log" 2>&1 &
shell_pid=$!
trap '\''kill "$client_pid" "$shell_pid" 2>/dev/null || true'\'' EXIT
for ((i=0;i<1200;i++)); do
    if [ -f "$DIKTATE_TEST_ARTIFACTS/shell.json" ]; then
        cat "$DIKTATE_TEST_ARTIFACTS/shell.json"
        cat "$DIKTATE_TEST_ARTIFACTS/client.json"
        exit 0
    fi
    if [ -f "$DIKTATE_TEST_ARTIFACTS/shell-error.txt" ]; then
        cat "$DIKTATE_TEST_ARTIFACTS/shell-error.txt"
        exit 1
    fi
    if ! kill -0 "$shell_pid" 2>/dev/null; then
        tail -n 35 "$DIKTATE_TEST_ARTIFACTS/shell.log"
        exit 1
    fi
    sleep 0.1
done
tail -n 40 "$DIKTATE_TEST_ARTIFACTS/shell.log"
cat "$DIKTATE_TEST_ARTIFACTS/client.log"
exit 1
' 2> "$DIKTATE_TEST_ARTIFACTS/bus.log"
test_result=$?
# Session helpers may still be writing their state for a moment after the bus closes.
rm -rf -- "$test_root" 2>/dev/null || { sleep 1; rm -rf -- "$test_root"; }
exit "$test_result"
