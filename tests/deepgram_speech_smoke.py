"""Optional live API test using synthetic speech only, never the microphone."""
import asyncio
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from diktate.config import Config
from diktate.transcription import FRAME_BYTES, Session


async def test_mode(mode, pcm):
    config = Config.load()
    config.language = "en"
    config.mode = mode
    events = []
    early_finals = []
    def emit(*args):
        events.append(args)
        if args[0] == 'Final' and not session.ended:
            early_finals.append(args[1])
    session = Session(config, emit)

    async def capture():
        for position in range(0, len(pcm), FRAME_BYTES):
            session.audio.extend(pcm[position:position + FRAME_BYTES])
            session.changed.set()
            await asyncio.sleep(0.1)
        session.ended = True
        session.changed.set()

    with patch.object(session, "_capture", capture):
        await session._run()
    assert len(session.transcript.text) > 30, f"{mode}: no useful transcript"
    assert "dictation" in session.transcript.text.lower(), f"{mode}: test speech not recognized"
    assert session.transcript.text.lower().rstrip(". ").endswith("appear"), f"{mode}: final words missing"
    assert early_finals, f"{mode}: no text arrived during the recording"
    finals = [event for event in events if event[0] == "Final"]
    assert "".join(event[1] for event in finals) == session.transcript.text
    print(f"{mode}: OK, {len(finals)} Abschnitte, davon {len(early_finals)} während der Aufnahme, letzte Wörter vollständig, {len(session.transcript.text)} Zeichen")


async def test_voice_commands(mode, pcm):
    config = Config.load()
    config.mode = mode
    config.language = "multi"
    events = []
    session = Session(config, lambda *args: events.append(args))

    async def capture():
        for position in range(0, len(pcm), FRAME_BYTES):
            if session.stop_requested.is_set():
                break
            session.audio.extend(pcm[position:position + FRAME_BYTES])
            session.changed.set()
            await asyncio.sleep(0.1)
        session.ended = True
        session.changed.set()

    with patch.object(session, "_capture", capture):
        await asyncio.to_thread(session.run)
    assert not any(event[0] == "Error" for event in events), events
    assert session.transcript.text == "/model", f"{mode}: wrong slash command: {session.transcript.text!r}"
    assert events.count(("SubmitRequested",)) == 1, f"{mode}: go go was not recognized"
    assert session.stop_requested.is_set()
    assert events.index(("Finished", "/model")) < events.index(("SubmitRequested",))
    print(f"{mode}: Sprachbefehle OK, /model eingefügt, go go entfernt, Aufnahme beendet und Enter angefordert")


async def main():
    pcm = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "flite=text='Hello world. This is a dictation test. The final sentence must also appear.':voice=slt",
        "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ], check=True, capture_output=True).stdout
    await test_mode("streaming", pcm)
    await test_mode("chunks", pcm)
    commands = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "flite=text='Slash model. Go, go.':voice=slt", "-af", "apad=pad_dur=1",
        "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ], check=True, capture_output=True).stdout
    await test_voice_commands("streaming", commands)
    await test_voice_commands("chunks", commands)


asyncio.run(main())
