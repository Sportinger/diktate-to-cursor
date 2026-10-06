"""Spoken commands, applied only to confirmed transcription results."""

import re

GO_WORD = re.compile(r"\bgo\b", re.IGNORECASE)
GO_PAIR = re.compile(r"(?=(\bgo[\s,.;:!?\-–—]*go\b))", re.IGNORECASE)
COMMAND_TAIL = re.compile(r"(?:\bgo\b|\bslash\b|/)[.,;:!?]*\s*$", re.IGNORECASE)
SLASH_WORD = re.compile(r"\bslash\b[.,;:!?]*", re.IGNORECASE)
SLASH_NAME = re.compile(r"/\s*[-–—]?\s*(\w+(?:-\w+)*)")
MAX_GO_GAP = 2.0


def format_slashes(text: str) -> str:
    text = SLASH_WORD.sub("/", text)
    text = SLASH_NAME.sub(lambda match: "/" + match[1].lower(), text)
    # Deepgram may add a sentence period to a standalone slash command.
    if re.fullmatch(r"/[\w-]+[.!?]+", text.strip()):
        text = text.rstrip().rstrip(".!?")
    return text.strip()


class DictationCommands:
    def __init__(self):
        self.pending = ""
        self.pending_go_time = None
        self.submit_requested = False

    def feed(self, text: str, words=()) -> tuple[str, bool]:
        if self.submit_requested or not text.strip():
            return "", False
        prefix = self.pending + " " if self.pending else ""
        combined = prefix + text.strip()
        go_times = {}
        current_go = list(GO_WORD.finditer(text.strip()))
        timed_go = [word for word in words if word.get("word", "").strip(".,;:!?").lower() == "go"]
        if len(current_go) == len(timed_go):
            for match, word in zip(current_go, timed_go):
                if "start" in word and "end" in word:
                    go_times[len(prefix) + match.start()] = (word["start"], word["end"])
        if self.pending_go_time is not None:
            go_times[0] = self.pending_go_time
        self.pending = ""
        self.pending_go_time = None
        for match in GO_PAIR.finditer(combined):
            start, end = match.span(1)
            pair = list(GO_WORD.finditer(combined, start, end))
            if len(pair) == 2:
                first, second = (go_times.get(word.start()) for word in pair)
                if first and second and second[0] - first[1] > MAX_GO_GAP:
                    continue
            self.submit_requested = True
            return format_slashes(combined[:start].rstrip(" \t,;:-–—")), True
        tail = COMMAND_TAIL.search(combined)
        if tail:
            self.pending = combined[tail.start():].strip()
            self.pending_go_time = go_times.get(tail.start())
            combined = combined[:tail.start()].rstrip()
        return format_slashes(combined), False

    def finish(self) -> str:
        tail, self.pending = self.pending, ""
        self.pending_go_time = None
        return format_slashes(tail)
