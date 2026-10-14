import math
import struct
import unittest

from diktate.transcription import CaptureStartup, MAX_STARTUP_BYTES, TranscriptionError


class CaptureStartupTests(unittest.TestCase):
    def test_low_pitched_voice_is_not_mistaken_for_dc(self):
        samples = [round(6000 * math.sin(2 * math.pi * 85 * i / 16000)) for i in range(1600)]
        pcm = struct.pack('<1600h', *samples)
        self.assertEqual(CaptureStartup().feed(pcm), pcm)

    def test_clean_speech_is_preserved_without_waiting_for_silence(self):
        startup = CaptureStartup()
        frame = struct.pack('<hh', 4000, -4000) * 160
        for _ in range(4):
            self.assertEqual(startup.feed(frame), b'')
        self.assertEqual(startup.feed(frame), frame * 5)

    def test_brief_quiet_prefix_does_not_hide_power_on_transient(self):
        startup = CaptureStartup()
        self.assertEqual(startup.feed(bytes(640)), b'')
        for value in [-32768, -32768, -24000, -12000, -6000, -3000, -1500]:
            self.assertEqual(startup.feed(struct.pack('<h', value) * 320), b'')
        clean = struct.pack('<hh', 1000, -1000) * 160
        for _ in range(4):
            self.assertEqual(startup.feed(clean), b'')
        self.assertEqual(startup.feed(clean), clean * 5)

    def test_zero_mean_clipping_is_not_considered_ready(self):
        startup = CaptureStartup()
        clipped = struct.pack('<hh', 32767, -32768) * 800
        self.assertEqual(startup.feed(clipped), b'')

    def test_pipe_reads_can_split_samples(self):
        startup = CaptureStartup()
        pcm = struct.pack('<hh', 1200, -1200) * 800
        self.assertEqual(startup.feed(pcm[:317]), b'')
        self.assertEqual(startup.feed(pcm[317:]), pcm)

    def test_bad_microphone_fails_instead_of_announcing_ready(self):
        startup = CaptureStartup()
        bad = struct.pack('<h', -32768) * 320
        with self.assertRaisesRegex(TranscriptionError, 'kein stabiles Signal'):
            for _ in range(MAX_STARTUP_BYTES // len(bad)):
                startup.feed(bad)
        self.assertLessEqual(len(startup.pending), 3201)
