import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path


def config_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "diktate-to-cursor/config.json"


@dataclass
class Config:
    api_key: str = ""
    language: str = "multi"
    model: str = "nova-3"
    mode: str = "auto"
    microphone: str = "default"
    chunk_seconds: float = 3.0

    def validate(self):
        if self.mode not in {"auto", "streaming", "chunks"}:
            raise ValueError("Modus muss auto, streaming oder chunks sein.")
        if not 1 <= self.chunk_seconds <= 10:
            raise ValueError("Chunk-Länge muss zwischen 1 und 10 Sekunden liegen.")
        if not self.language.strip() or not self.model.strip() or not self.microphone.strip():
            raise ValueError("Sprache, Modell und Mikrofon dürfen nicht leer sein.")

    @classmethod
    def load(cls):
        path = config_path()
        values = json.loads(path.read_text()) if path.exists() else {}
        config = cls(**{k: v for k, v in values.items() if k in cls.__dataclass_fields__})
        config.api_key = config.api_key or os.environ.get("DEEPGRAM_API_KEY", "")
        config.validate()
        return config

    def save(self):
        self.validate()
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".config-")
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(asdict(self), file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
