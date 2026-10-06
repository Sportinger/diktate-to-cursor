import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

from diktate.config import Config
from diktate.transcription import BYTES_PER_SECOND, Session
from test_transcription import Socket, result


class SilenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.session = Session(Config(api_key="test-key"), lambda *args: self.events.append(args))
        self.session.changed = asyncio.Event()

    def test_empty_results_do_not_count_as_speech(self):
        previous = self.session.last_speech_at
        self.session._final("")
        self.assertEqual(self.session.last_speech_at, previous)
        self.assertFalse(self.events)

    def test_delayed_or_repeated_words_use_actual_audio_time(self):
        self.session.audio.extend(bytes(BYTES_PER_SECOND * 10))
        self.session.last_speech_at = 80
        with patch("diktate.transcription.time.monotonic", return_value=100):
            self.session._mark_transcript_speech("Hallo.", [{"end": 9.0}])
        self.assertEqual(self.session.last_speech_at, 99.0)
        self.assertIn(("SilenceChanged", 1.0), self.events)
        self.session.audio.extend(bytes(BYTES_PER_SECOND * 5))
        with patch("diktate.transcription.time.monotonic", return_value=105):
            self.session._mark_transcript_speech("Hallo.", [{"end": 9.0}])
            self.assertEqual(self.session.last_speech_at, 99.0)
            self.session._mark_transcript_speech("Neue Wörter.", [{"end": 14.5}])
        self.assertEqual(self.session.last_speech_at, 104.5)

    async def test_speech_started_counts_before_any_text_arrives(self):
        self.session.audio.extend(bytes(BYTES_PER_SECOND * 2))
        self.session.ended = True
        self.session.last_speech_at = time.monotonic() - 10
        socket = Socket([json.dumps({"type": "SpeechStarted", "timestamp": 1.8})])
        with patch("diktate.transcription.connect", AsyncMock(return_value=socket)):
            await self.session._stream()
        self.assertTrue(any(event[0] == "SilenceChanged" for event in self.events))
        self.assertLess(self.session.silence_seconds(), 1)
        self.assertEqual(self.session.transcript.text, "")

    async def test_new_speech_prevents_stopping_at_old_deadline(self):
        self.session.last_speech_at = 70.1
        async def speak(_seconds):
            self.session._mark_speech()
            self.session.ended = True
        with patch("diktate.transcription.time.monotonic", return_value=100), \
                patch("diktate.transcription.asyncio.sleep", speak):
            await self.session._watch_silence()
        self.assertFalse(self.session.stop_requested.is_set())
        self.assertEqual(self.session.last_speech_at, 100)

    async def test_auto_stop_flushes_last_words_and_never_presses_enter(self):
        async def capture():
            self.session.audio.extend(bytes(3200))
            self.session.changed.set()
            while not self.session.stop_requested.is_set():
                await asyncio.sleep(0.005)
            self.session.ended = True
            self.session.changed.set()
        socket = Socket([result("Letzte Wörter.", duration=0.1)])
        with patch.object(self.session, "_capture", capture), \
                patch("diktate.transcription.AUTO_STOP_SECONDS", 0.03), \
                patch("diktate.transcription.connect", AsyncMock(return_value=socket)):
            await asyncio.wait_for(asyncio.to_thread(self.session.run), 2)
        self.assertTrue(self.session.stop_requested.is_set())
        self.assertIn(("StateChanged", "finishing", "streaming"), self.events)
        self.assertIn(("Finished", "Letzte Wörter."), self.events)
        self.assertNotIn(("SubmitRequested",), self.events)
        self.assertFalse(self.session.audio)
        self.assertFalse(any(event[0] == "Error" for event in self.events))
