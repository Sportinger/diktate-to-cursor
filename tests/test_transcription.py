import asyncio
import contextlib
import io
import json
import os
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from diktate.config import Config, config_path
from diktate.transcription import AuthenticationError, BYTES_PER_SECOND, Session, Transcript, wav_bytes


def result(text, start=0, duration=1, final=True):
    return json.dumps({"type": "Results", "start": start, "duration": duration,
                       "is_final": final, "channel": {"alternatives": [{"transcript": text}]}})


class Socket:
    def __init__(self, messages):
        self.messages = messages
        self.sent = []
        self.closed = asyncio.Event()

    async def send(self, value):
        self.sent.append(value)
        if isinstance(value, str) and json.loads(value)["type"] == "CloseStream":
            self.closed.set()

    async def close(self):
        pass

    def __aiter__(self):
        return self.receive()

    async def receive(self):
        await self.closed.wait()
        for message in self.messages:
            yield message


class TranscriptTests(unittest.TestCase):
    def test_spacing_and_empty_results(self):
        transcript = Transcript([])
        self.assertEqual(transcript.append(" Hallo Welt. "), "Hallo Welt.")
        self.assertEqual(transcript.append(""), "")
        self.assertEqual(transcript.append("Noch ein Satz."), " Noch ein Satz.")
        self.assertEqual(transcript.text, "Hallo Welt. Noch ein Satz.")

    def test_wav_has_correct_audio_format(self):
        pcm = bytes(BYTES_PER_SECOND)
        with wave.open(io.BytesIO(wav_bytes(pcm)), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 16000))
            self.assertEqual(audio.readframes(16000), pcm)

    def test_config_is_private_and_key_is_not_in_project(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"XDG_CONFIG_HOME": folder}, clear=True):
            Config(api_key="test-secret").save()
            self.assertEqual(config_path().stat().st_mode & 0o777, 0o600)
            self.assertEqual(Config.load().api_key, "test-secret")

    def test_invalid_configuration(self):
        with self.assertRaises(ValueError):
            Config(chunk_seconds=0).validate()
        with self.assertRaises(ValueError):
            Config(mode="invalid").validate()


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.events = []
        self.session = Session(Config(api_key="test-key"), lambda *args: self.events.append(args))
        self.session.changed = asyncio.Event()

    async def test_stream_waits_for_last_words_and_deduplicates_finals(self):
        self.session.audio = bytearray(bytes(BYTES_PER_SECOND * 2))
        self.session.ended = True
        socket = Socket([result("vorläufig", final=False), result("Hallo Welt."),
                         result("Hallo Welt."), result("Noch ein Satz.", 1)])
        with patch("diktate.transcription.connect", AsyncMock(return_value=socket)):
            await self.session._stream()
        self.assertEqual(self.session.transcript.text, "Hallo Welt. Noch ein Satz.")
        self.assertEqual([event for event in self.events if event[0] == "Final"],
                         [("Final", "Hallo Welt."), ("Final", " Noch ein Satz.")])
        self.assertEqual(self.session.transcript.committed_bytes, len(self.session.audio))
        self.assertEqual(json.loads(socket.sent[-1]), {"type": "CloseStream"})
        self.assertIn(("Interim", "vorläufig"), self.events)

    async def test_fallback_only_transcribes_uncommitted_audio(self):
        async def capture():
            self.session.audio = bytearray(struct.pack("<h", 1200) * 16000 * 2)
            self.session.ended = True
            self.session.changed.set()

        async def failed_stream():
            self.session._final("Bereits eingefügt.")
            self.session.transcript.committed_bytes = BYTES_PER_SECOND
            raise OSError("lost websocket")

        chunks = []

        async def transcribe(client, pcm):
            chunks.append(pcm)
            return "Restlicher Text."

        with patch.object(self.session, "_capture", capture), patch.object(self.session, "_stream", failed_stream), \
                patch.object(self.session, "_transcribe_chunk", transcribe):
            await self.session._run()
        self.assertEqual(sum(map(len, chunks)), BYTES_PER_SECOND)
        self.assertEqual(self.session.transcript.text, "Bereits eingefügt. Restlicher Text.")
        self.assertTrue(any(event[0] == "Notice" for event in self.events))

    async def test_authentication_failure_does_not_retry_as_chunks(self):
        async def capture():
            self.session.ended = True
            self.session.changed.set()

        with patch.object(self.session, "_capture", capture), \
                patch.object(self.session, "_stream", AsyncMock(side_effect=AuthenticationError("bad key"))), \
                patch.object(self.session, "_chunks", AsyncMock()) as chunks:
            with self.assertRaises(AuthenticationError):
                await self.session._run()
            chunks.assert_not_called()

    async def test_chunk_mode_flushes_short_tail(self):
        self.session.ended = True
        self.session.audio = bytearray(struct.pack("<h", 1200) * 2400)
        transcribe = AsyncMock(return_value="Kurzes Wort.")
        with patch.object(self.session, "_transcribe_chunk", transcribe):
            await self.session._chunks(0)
        transcribe.assert_awaited_once()
        self.assertEqual(self.session.transcript.text, "Kurzes Wort.")
        self.assertEqual(self.session.transcript.committed_bytes, 4800)

    async def test_rest_auth_error_is_explicit(self):
        client = AsyncMock()
        client.post.return_value = httpx.Response(401, request=httpx.Request("POST", "https://api.deepgram.com/v1/listen"))
        with self.assertRaises(AuthenticationError):
            await self.session._transcribe_chunk(client, bytes(3200))
        self.assertEqual(client.post.await_count, 1)

    async def test_http_transient_error_retries(self):
        client = AsyncMock()
        request = httpx.Request("POST", "https://api.deepgram.com/v1/listen")
        client.post.side_effect = [httpx.Response(503, request=request),
                                  httpx.Response(200, request=request, json={"results": {"channels": [{"alternatives": [{"transcript": "Hallo"}]}]}})]
        with patch("diktate.transcription.asyncio.sleep", AsyncMock()):
            self.assertEqual(await self.session._transcribe_chunk(client, bytes(3200)), "Hallo")
        self.assertEqual(client.post.await_count, 2)

    async def test_short_stop_before_connection_still_finishes(self):
        self.session.stop()
        self.session.audio = bytearray(bytes(3200))
        self.session.ended = True
        socket = Socket([result("Letztes Wort.", duration=0.1)])
        with patch("diktate.transcription.connect", AsyncMock(return_value=socket)):
            await self.session._stream()
        self.assertIn(("StateChanged", "finishing", "streaming"), self.events)
        self.assertEqual(self.session.transcript.text, "Letztes Wort.")


if __name__ == "__main__":
    unittest.main()
