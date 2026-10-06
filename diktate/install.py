import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from gi.repository import Gio, GLib

from .config import Config, config_path

UUID = "diktate-to-cursor@local"
ROOT = Path(__file__).resolve().parent.parent


def _write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def install():
    if not shutil.which("ffmpeg"):
        raise SystemExit("FFmpeg fehlt. Bitte mit sudo apt install ffmpeg installieren.")
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    config = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    extension = data / "gnome-shell/extensions" / UUID
    extension.mkdir(parents=True, exist_ok=True)
    for file in (ROOT / "gnome-extension").iterdir():
        if file.is_dir():
            shutil.copytree(file, extension / file.name, dirs_exist_ok=True)
        else:
            shutil.copy2(file, extension / file.name)
    subprocess.run(["glib-compile-schemas", str(extension / "schemas")], check=True)

    # Store an existing environment key privately; never put it in a service unit.
    if not config_path().exists():
        Config.load().save()
    python = Path(sys.executable).absolute()
    executable = shlex.quote(str(python))
    project = shlex.quote(str(ROOT))
    _write(config / "systemd/user/diktate-to-cursor.service", f"""[Unit]
Description=Deepgram-Diktat am Cursor
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=dbus
BusName=io.github.diktate.Cursor
WorkingDirectory={project}
ExecStart={executable} -m diktate serve
Restart=on-failure
RestartSec=2
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=graphical-session.target
""")
    _write(data / "dbus-1/services/io.github.diktate.Cursor.service", f"""[D-BUS Service]
Name=io.github.diktate.Cursor
Exec={executable} -m diktate serve
SystemdService=diktate-to-cursor.service
""")
    desktop_exec = str(python).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
    _write(data / "applications/io.github.diktate.Cursor.desktop", f"""[Desktop Entry]
Type=Application
Name=Diktate to Cursor
Comment=Deepgram-Diktat direkt am Cursor
Icon=audio-input-microphone
Exec="{desktop_exec}" -m diktate start
Terminal=false
Categories=Utility;Audio;
""")
    settings = Gio.Settings.new("org.gnome.shell")
    enabled = settings.get_strv("enabled-extensions")
    if UUID not in enabled:
        settings.set_strv("enabled-extensions", enabled + [UUID])
    disabled = settings.get_strv("disabled-extensions")
    if UUID in disabled:
        settings.set_strv("disabled-extensions", [item for item in disabled if item != UUID])
    Gio.Settings.sync()
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "diktate-to-cursor.service"], check=True)
    subprocess.run(["gnome-extensions", "enable", UUID], capture_output=True)
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = connection.call_sync("org.gnome.Shell.Extensions", "/org/gnome/Shell/Extensions",
                                 "org.gnome.Shell.Extensions", "GetExtensionInfo", GLib.Variant("(s)", (UUID,)),
                                 None, Gio.DBusCallFlags.NONE, 5000, None)
    info = reply.unpack()[0]
    print("Installiert. Diktatdienst läuft. Konfiguration: " + str(config_path()))
    if not info:
        print("GNOME lädt die neue Erweiterung nach einmaligem Ab- und Anmelden. Danach erscheint das Mikrofon im Tray.")
    else:
        print("GNOME-Erweiterung: " + str(info.get("state", "unbekannt")))
        installed_version = json.loads((ROOT / "gnome-extension/metadata.json").read_text())["version"]
        loaded_version = info.get("version")
        if loaded_version != installed_version:
            print(f"GNOME verwendet noch Version {loaded_version}; installiert ist Version {installed_version}. "
                  "Einmal ab- und anmelden, damit der neue Erweiterungscode geladen wird.")


def uninstall():
    subprocess.run(["gnome-extensions", "disable", UUID], capture_output=True)
    subprocess.run(["systemctl", "--user", "disable", "--now", "diktate-to-cursor.service"], capture_output=True)
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    config = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    shutil.rmtree(data / "gnome-shell/extensions" / UUID, ignore_errors=True)
    for file in [config / "systemd/user/diktate-to-cursor.service",
                 data / "dbus-1/services/io.github.diktate.Cursor.service",
                 data / "applications/io.github.diktate.Cursor.desktop"]:
        file.unlink(missing_ok=True)
    settings = Gio.Settings.new("org.gnome.shell")
    for key in ("enabled-extensions", "disabled-extensions"):
        settings.set_strv(key, [item for item in settings.get_strv(key) if item != UUID])
    Gio.Settings.sync()
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    print("Deinstalliert. Persönliche Einstellungen bleiben in " + str(config_path()))
