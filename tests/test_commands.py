import asyncio
import struct
import unittest
from unittest.mock import AsyncMock, patch

from diktate.commands import DictationCommands
from diktate.config import Config
from diktate.transcription import BYTES_PER_SECOND, Session, TranscriptionError
from test_transcription import Socket, result


class CommandTests(unittest.TestCase):
    def test_slash_commands_and_word_boundaries(self):
        for spoken, expected in [("Slash Model.", "/model"), ("slash Zoom!", "/zoom"),
                                 ("SLASH-Zoom", "/zoom"), ("/ Model.", "/model"),
                                 ("Bitte slash model öffnen.", "Bitte /model öffnen."),
                                 ("Backslash und Slasher.", "Backslash und Slasher.")]:
            with self.subTest(spoken=spoken):
                self.assertEqual(DictationCommands().feed(spoken), (expected, False))

    def test_slash_can_span_results(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Slash."), ("", False))
        self.assertEqual(commands.feed("Model."), ("/model", False))

    def test_single_slash_is_flushed_on_stop(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Slash."), ("", False))
        self.assertEqual(commands.finish(), "/")

    def test_go_go_removes_command_and_discards_following_audio(self):
        for spoken in ["Slash model. Go, go.", "Slash model go go", "Slash model GO-GO!", "Slash model Gogo."]:
            with self.subTest(spoken=spoken):
                commands = DictationCommands()
                self.assertEqual(commands.feed(spoken), ("/model", True))
                self.assertEqual(commands.feed("Das darf nicht mehr mitgeschrieben werden."), ("", False))
                self.assertEqual(commands.finish(), "")

    def test_go_can_span_results_without_pasting_first_go(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Das ist mein Text. Go,"), ("Das ist mein Text.", False))
        self.assertEqual(commands.feed("Go."), ("", True))

    def test_single_go_and_similar_words_are_kept(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Ich spiele Go."), ("Ich spiele", False))
        self.assertEqual(commands.finish(), "Go.")
        self.assertEqual(commands.feed("Going, Google und Mango."), ("Going, Google und Mango.", False))
        self.assertFalse(commands.submit_requested)

    def test_an_intervening_word_prevents_submit(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Go,"), ("", False))
        self.assertEqual(commands.feed("bitte go."), ("Go, bitte", False))
        self.assertEqual(commands.finish(), "go.")
        self.assertFalse(commands.submit_requested)

    def test_long_pause_prevents_submit_even_across_results(self):
        commands = DictationCommands()
        self.assertEqual(commands.feed("Go.", [{"word": "go", "start": 0, "end": 0.3}]), ("", False))
        self.assertEqual(commands.feed("Go.", [{"word": "go", "start": 5, "end": 5.3}]), ("Go.", False))
        self.assertFalse(commands.submit_requested)
        self.assertEqual(commands.finish(), "Go.")

    def test_long_pause_inside_result_prevents_submit(self):
        commands = DictationCommands()
        words = [{"word": "go", "start": 0, "end": 0.3}, {"word": "go", "start": 4, "end": 4.3}]
        self.assertEqual(commands.feed("Go. Go.", words), ("Go.", False))
        self.assertFalse(commands.submit_requested)

    def test_go_go_alone_can_submit_existing_field(self):
        self.assertEqual(DictationCommands().feed("Go, go."), ("", True))


class SessionCommandTests(unittest.TestCase):
    def test_keyboard_submit_keeps_late_words_and_sends_once(self):
        for error in [None, TranscriptionError('Verbindung unterbrochen')]:
            with self.subTest(error=error):
                events = []
                session = Session(Config(), lambda *args: events.append(args))
                async def run():
                    session._final('Erste Wörter.')
                    session.stop(submit=True)
                    session.stop(submit=True)
                    session._final('Letzte Wörter.')
                    if error:
                        raise error
                with patch.object(session, '_run', run):
                    session.run()
                self.assertEqual(session.transcript.text, 'Erste Wörter. Letzte Wörter.')
                if error:
                    self.assertNotIn(('SubmitRequested',), events)
                else:
                    self.assertEqual(events.count(('SubmitRequested',)), 1)
                    self.assertLess(events.index(('Finished', session.transcript.text)),
                                    events.index(('SubmitRequested',)))

    def test_submit_is_emitted_once_after_finished_and_not_after_an_error(self):
        for error in [None, TranscriptionError("Verbindung unterbrochen")]:
            with self.subTest(error=error):
                events = []
                session = Session(Config(), lambda *args: events.append(args))
                async def run():
                    session._final("Slash Model. Go, go.")
                    session._final("Go, go. Das gehört nicht zum Diktat.")
                    if error:
                        raise error
                with patch.object(session, "_run", run):
                    session.run()
                self.assertTrue(session.stop_requested.is_set())
                self.assertEqual(session.transcript.text, "/model")
                self.assertIn(("Finished", "/model"), events)
                if error:
                    self.assertNotIn(("SubmitRequested",), events)
                else:
                    self.assertEqual(events.count(("SubmitRequested",)), 1)
                    self.assertLess(events.index(("Finished", "/model")), events.index(("SubmitRequested",)))

    def test_manual_stop_flushes_single_go_without_submitting(self):
        events = []
        session = Session(Config(), lambda *args: events.append(args))
        async def run():
            session._final("Ich spiele Go.")
        with patch.object(session, "_run", run):
            session.run()
        self.assertEqual(session.transcript.text, "Ich spiele Go.")
        self.assertIn(("Finished", "Ich spiele Go."), events)
        self.assertNotIn(("SubmitRequested",), events)


class TransportCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_provisional_go_go_does_not_stop_or_submit(self):
        events = []
        session = Session(Config(), lambda *args: events.append(args))
        session.changed = asyncio.Event()
        session.audio.extend(bytes(BYTES_PER_SECOND))
        session.ended = True
        socket = Socket([result("Go, go.", final=False), result("Ganz normaler Text.")])
        with patch("diktate.transcription.connect", AsyncMock(return_value=socket)):
            await session._stream()
        self.assertFalse(session.stop_requested.is_set())
        self.assertFalse(session.commands.submit_requested)
        self.assertEqual(session.transcript.text, "Ganz normaler Text.")

    async def test_chunk_times_are_absolute_and_no_chunks_are_sent_after_go_go(self):
        session = Session(Config(mode="chunks", chunk_seconds=1), lambda *args: None)
        session.changed = asyncio.Event()
        session.audio.extend(struct.pack("<h", 1200) * 16000 * 6)
        session.ended = True
        calls = []
        async def transcribe(client, pcm):
            calls.append(len(pcm))
            session.chunk_words = [{"word": "go", "start": 0.1, "end": 0.4}]
            return "Go."
        with patch.object(session, "_transcribe_chunk", transcribe):
            await session._chunks(0)
        self.assertTrue(session.commands.submit_requested)
        self.assertTrue(session.stop_requested.is_set())
        self.assertEqual(len(calls), 2)
        self.assertEqual(session.transcript.text, "")
