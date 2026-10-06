"""Audio capture and Deepgram transports, independent of the desktop UI."""

import asyncio
import contextlib
import io
import json
import logging
import math
import struct
import threading
import wave
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from .config import Config
from .commands import DictationCommands

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
FRAME_BYTES = 3200  # 100 ms, mono PCM16
MAX_RECORDING_BYTES = BYTES_PER_SECOND * 60 * 30
LIVE_FLUSH_BYTES = BYTES_PER_SECOND * 2
logger = logging.getLogger(__name__)


class TranscriptionError(Exception):
    pass


class AuthenticationError(TranscriptionError):
    pass


def wav_bytes(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(pcm)
    return output.getvalue()


def rms(pcm: bytes) -> float:
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm[:len(pcm) // 2 * 2])
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0


@dataclass
class Transcript:
    parts: list[str]
    committed_bytes: int = 0

    @property
    def text(self):
        return " ".join(self.parts)

    def append(self, text: str) -> str:
        text = text.strip()
        if not text:
            return ""
        insertion = (" " if self.parts else "") + text
        self.parts.append(text)
        return insertion


class Session:
    """One recording. Callbacks run on the worker thread; marshal UI work."""

    def __init__(self, config: Config, emit):
        self.config = config
        self.emit = emit
        self.transcript = Transcript([])
        self.audio = bytearray()
        self.stop_requested = threading.Event()
        self.ended = False
        self.process = None
        self.loop = None
        self.changed = None
        self.capture_error = None
        self.commands = DictationCommands()
        self.transport = "chunks" if config.mode == "chunks" else "streaming"
        self.chunk_words = []

    def stop(self):
        self.stop_requested.set()
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._terminate_capture)

    def _terminate_capture(self):
        if self.process and self.process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self.process.terminate()

    def run(self):
        logger.info("Aufnahme gestartet: Mikrofon=%s, Modus=%s", self.config.microphone, self.config.mode)
        succeeded = False
        try:
            asyncio.run(self._run())
            succeeded = True
        except Exception as error:
            message = str(error) if isinstance(error, TranscriptionError) else "Aufnahme oder Verbindung fehlgeschlagen. Bitte Mikrofon und Netzwerk prüfen."
            logger.warning("Diktatfehler: %s", message)
            self.emit("Error", message)
        finally:
            self._commit(self.commands.finish())
            logger.info("Aufnahme beendet: %.1f Sekunden, %d erkannte Zeichen", len(self.audio) / BYTES_PER_SECOND, len(self.transcript.text))
            # Also preserve partial text after a network or microphone error.
            self.emit("Finished", self.transcript.text)
            if succeeded and self.commands.submit_requested:
                self.emit("SubmitRequested")
            self.emit("StateChanged", "idle", "")
            self.audio.clear()

    async def _run(self):
        self.loop = asyncio.get_running_loop()
        self.changed = asyncio.Event()
        capture = asyncio.create_task(self._capture())
        try:
            if self.config.mode == "chunks":
                self.emit("StateChanged", "recording", "chunks")
                await self._chunks(0)
            else:
                try:
                    await self._stream()
                except AuthenticationError:
                    raise
                except Exception:
                    if self.capture_error:
                        raise self.capture_error
                    if self.config.mode == "streaming":
                        raise TranscriptionError("Streaming unterbrochen. Der bisherige Text bleibt in der Zwischenablage.")
                    self.transport = "chunks"
                    self.emit("StateChanged", "finishing" if self.stop_requested.is_set() else "recording", "chunks")
                    self.emit("Notice", "Streaming nicht verfügbar – transkribiere in kurzen Abschnitten.")
                    await self._chunks(self.transcript.committed_bytes)
            await capture
            if self.capture_error:
                raise self.capture_error
        finally:
            self.stop_requested.set()
            self._terminate_capture()
            try:
                await asyncio.wait_for(asyncio.shield(capture), 3)
            except (TimeoutError, asyncio.CancelledError):
                if self.process and self.process.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        self.process.kill()
                capture.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await capture

    async def _capture(self):
        try:
            self.process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "pulse", "-i", self.config.microphone,
                "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            if self.stop_requested.is_set():
                self._terminate_capture()
            while True:
                frame = await self.process.stdout.read(FRAME_BYTES)
                if not frame:
                    break
                self.audio.extend(frame)
                self.changed.set()
                if len(self.audio) >= MAX_RECORDING_BYTES:
                    self.stop_requested.set()
                    self._terminate_capture()
                    self.emit("Notice", "Aufnahme nach 30 Minuten automatisch beendet.")
            code = await self.process.wait()
            if not self.stop_requested.is_set():
                self.capture_error = TranscriptionError(f"Mikrofonaufnahme beendet (Code {code}). Bitte die Mikrofonquelle prüfen.")
        except Exception:
            self.capture_error = TranscriptionError("Mikrofon konnte nicht geöffnet werden. FFmpeg und die Mikrofonquelle prüfen.")
        finally:
            self.ended = True
            self.changed.set()

    def _parameters(self):
        return {"model": self.config.model, "language": self.config.language,
                "smart_format": "true", "punctuate": "true"}

    async def _wait_audio(self):
        self.changed.clear()
        # Timeout also checks errors / end-of-capture without losing notifications.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.changed.wait(), 0.1)

    async def _stream(self):
        params = self._parameters() | {
            "encoding": "linear16", "sample_rate": SAMPLE_RATE, "channels": 1,
            "interim_results": "true", "endpointing": 150,
        }
        try:
            socket = await connect(
                "wss://api.deepgram.com/v1/listen?" + urlencode(params),
                additional_headers={"Authorization": "Token " + self.config.api_key},
                open_timeout=5, close_timeout=2, ping_interval=20,
            )
        except InvalidStatus as error:
            if error.response.status_code in (401, 403):
                raise AuthenticationError("Deepgram-Schlüssel ungültig oder ohne Berechtigung.") from None
            raise
        self.emit("StateChanged", "finishing" if self.stop_requested.is_set() else "recording", "streaming")
        closing = False
        seen = set()

        async def send_audio():
            nonlocal closing
            position = 0
            last_flush = 0
            quiet_bytes = 0
            while not self.ended or position < len(self.audio):
                if position < len(self.audio):
                    end = min(position + FRAME_BYTES, len(self.audio))
                    frame = bytes(self.audio[position:end])
                    await socket.send(frame)
                    quiet_bytes = quiet_bytes + len(frame) if rms(frame) < 250 else 0
                    position = end
                    # Flush at a brief word boundary, rather than cutting a word at
                    # an arbitrary timer. The connection stays open for more audio.
                    if (position - max(last_flush, self.transcript.committed_bytes) >= LIVE_FLUSH_BYTES and
                            quiet_bytes >= BYTES_PER_SECOND // 10):
                        await socket.send(json.dumps({"type": "Finalize"}))
                        last_flush = position
                else:
                    await self._wait_audio()
            if self.capture_error:
                raise self.capture_error
            closing = True
            await socket.send(json.dumps({"type": "CloseStream"}))

        async def receive_results():
            async for raw in socket:
                message = json.loads(raw)
                if message.get("type") == "Error":
                    raise TranscriptionError("Deepgram konnte den Audiostream nicht verarbeiten.")
                if message.get("type") != "Results":
                    continue
                alternatives = message.get("channel", {}).get("alternatives", [])
                text = alternatives[0].get("transcript", "") if alternatives else ""
                if message.get("is_final"):
                    start, duration = float(message.get("start", 0)), float(message.get("duration", 0))
                    marker = (start, duration, text)
                    if marker in seen:
                        continue
                    seen.add(marker)
                    self.transcript.committed_bytes = max(
                        self.transcript.committed_bytes,
                        min(len(self.audio), round((start + duration) * SAMPLE_RATE) * 2),
                    )
                    self._final(text, alternatives[0].get("words", []) if alternatives else [])
                    self.emit("Interim", "")
                else:
                    if not self.commands.submit_requested:
                        self.emit("Interim", text)
            if not closing:
                raise TranscriptionError("Streaming-Verbindung unterbrochen.")

        sender = asyncio.create_task(send_audio())
        receiver = asyncio.create_task(receive_results())
        try:
            done, _ = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if sender in done:
                # CloseStream returns the final words before closing the socket.
                await asyncio.wait_for(receiver, 8)
            else:
                await sender
        finally:
            for task in (sender, receiver):
                task.cancel()
            await asyncio.gather(sender, receiver, return_exceptions=True)
            await socket.close()

    def _commit(self, text):
        insertion = self.transcript.append(text)
        if insertion:
            self.emit("Final", insertion)

    def _final(self, text, words=()):
        output, submit = self.commands.feed(text, words)
        self._commit(output)
        if submit:
            self.stop()
            self.emit("StateChanged", "finishing", self.transport)

    def _chunk_end(self, position):
        available = len(self.audio) - position
        minimum = BYTES_PER_SECOND
        target = round(self.config.chunk_seconds * BYTES_PER_SECOND)
        maximum = target + BYTES_PER_SECOND
        if self.ended:
            return min(len(self.audio), position + maximum)
        if available < minimum:
            return None
        # Prefer a short pause; sustained speech is cut after the configured limit + 1s.
        limit = min(available, maximum)
        for end in range(minimum, limit + 1, FRAME_BYTES):
            tail = self.audio[position + end - FRAME_BYTES * 3:position + end]
            if rms(tail) < 250:
                return position + end
        return position + maximum if available >= maximum else None

    async def _chunks(self, position):
        async with httpx.AsyncClient(timeout=20) as client:
            while not self.ended or position < len(self.audio):
                end = self._chunk_end(position)
                if end is None:
                    await self._wait_audio()
                    continue
                pcm = bytes(self.audio[position:end])
                if not pcm:
                    break
                if rms(pcm) >= 100:
                    self.chunk_words = []
                    text = await self._transcribe_chunk(client, pcm)
                    offset = position / BYTES_PER_SECOND
                    words = [word | {"start": word["start"] + offset, "end": word["end"] + offset}
                             if "start" in word and "end" in word else word for word in self.chunk_words]
                    self._final(text, words)
                position = end
                self.transcript.committed_bytes = position
                self.emit("Interim", "")
                if self.commands.submit_requested:
                    break
            if self.capture_error:
                raise self.capture_error

    async def _transcribe_chunk(self, client, pcm):
        for attempt in range(3):
            try:
                response = await client.post(
                    "https://api.deepgram.com/v1/listen", params=self._parameters(),
                    headers={"Authorization": "Token " + self.config.api_key, "Content-Type": "audio/wav"},
                    content=wav_bytes(pcm),
                )
                if response.status_code in (401, 403):
                    raise AuthenticationError("Deepgram-Schlüssel ungültig oder ohne Berechtigung.")
                if response.status_code == 429 or response.status_code >= 500:
                    raise httpx.HTTPStatusError("Temporärer API-Fehler", request=response.request, response=response)
                if response.is_error:
                    raise TranscriptionError(f"Deepgram-Anfrage abgelehnt (HTTP {response.status_code}). Modell und Sprache prüfen.")
                alternative = response.json()["results"]["channels"][0]["alternatives"][0]
                self.chunk_words = alternative.get("words", [])
                return alternative["transcript"]
            except (httpx.TransportError, httpx.HTTPStatusError):
                if attempt == 2:
                    raise TranscriptionError("Deepgram ist nicht erreichbar. Der bisherige Text bleibt in der Zwischenablage.") from None
                await asyncio.sleep(0.5 * (attempt + 1))
