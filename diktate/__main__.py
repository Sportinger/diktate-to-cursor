import argparse
import asyncio
import json
import subprocess


def main():
    parser = argparse.ArgumentParser(description="Deepgram-Diktat am Cursor für GNOME/Wayland")
    parser.add_argument("command", nargs="?", default="serve",
                        choices=["serve", "install", "uninstall", "start", "toggle", "stop", "status", "doctor"])
    args = parser.parse_args()
    if args.command == "serve":
        from .service import Service
        Service().run()
    elif args.command in {"install", "uninstall"}:
        from .install import install, uninstall
        (install if args.command == "install" else uninstall)()
    elif args.command == "start":
        from .install import UUID
        from gi.repository import Gio
        settings = Gio.Settings.new("org.gnome.shell")
        enabled = settings.get_strv("enabled-extensions")
        if UUID not in enabled:
            settings.set_strv("enabled-extensions", enabled + [UUID])
        disabled = settings.get_strv("disabled-extensions")
        settings.set_strv("disabled-extensions", [item for item in disabled if item != UUID])
        Gio.Settings.sync()
        subprocess.run(["systemctl", "--user", "start", "diktate-to-cursor.service"], check=True)
        subprocess.run(["gnome-extensions", "enable", UUID], check=True)
    elif args.command == "doctor":
        asyncio.run(doctor())
    else:
        from gi.repository import Gio, GLib
        from .service import BUS_NAME, OBJECT_PATH, INTERFACE
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        method = {"toggle": "Toggle", "stop": "Stop", "status": "GetState"}[args.command]
        reply = connection.call_sync(BUS_NAME, OBJECT_PATH, INTERFACE, method,
                                     GLib.Variant("()", ()), None, Gio.DBusCallFlags.NONE, 5000, None)
        if args.command == "status":
            print(json.dumps(reply.unpack(), ensure_ascii=False))


async def doctor():
    """Check both APIs with synthetic silence; never open the microphone."""
    import shutil
    import httpx
    from websockets.asyncio.client import connect
    from urllib.parse import urlencode
    from .config import Config
    from .transcription import SAMPLE_RATE, BYTES_PER_SECOND, wav_bytes
    config = Config.load()
    print("FFmpeg:", shutil.which("ffmpeg") or "FEHLT")
    print("Deepgram-Schlüssel:", "vorhanden" if config.api_key else "FEHLT")
    if not config.api_key:
        return
    params = {"model": config.model, "language": config.language}
    headers = {"Authorization": "Token " + config.api_key}
    failures = []
    try:
        query = params | {"encoding": "linear16", "sample_rate": SAMPLE_RATE, "channels": 1}
        async with connect("wss://api.deepgram.com/v1/listen?" + urlencode(query),
                           additional_headers=headers, open_timeout=8) as socket:
            await socket.send(bytes(BYTES_PER_SECOND))
            await socket.send(json.dumps({"type": "CloseStream"}))
            async with asyncio.timeout(10):
                async for _ in socket:
                    pass
        print("Deepgram-Streaming: OK (synthetische Stille)")
    except Exception as error:
        failures.append(type(error).__name__)
        print("Deepgram-Streaming: FEHLER (" + type(error).__name__ + ")")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post("https://api.deepgram.com/v1/listen", params=params,
                                         headers=headers | {"Content-Type": "audio/wav"},
                                         content=wav_bytes(bytes(BYTES_PER_SECOND)))
            response.raise_for_status()
        print("Deepgram-Chunks: OK (synthetische Stille)")
    except Exception as error:
        failures.append(type(error).__name__)
        print("Deepgram-Chunks: FEHLER (" + type(error).__name__ + ")")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
