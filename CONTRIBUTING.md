# Contributing

Improvements, translations, bug reports, and compatibility fixes are welcome.

Include your Linux distribution, GNOME version, session type, keyboard layout, and what you expected when reporting a bug. Do not attach API keys, private configuration, recordings, transcripts, or screenshots containing personal material.

Set up a development environment without installing the desktop service:

```bash
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m unittest discover -s tests -v
node --check gnome-extension/extension.js
node --check gnome-extension/prefs.js
node --check gnome-extension/screenshot.js
node --check gnome-extension/delivery.js
node --check gnome-extension/raster.js
```

GNOME changes should also pass `bash tests/gnome_smoke.sh` on GNOME 50. It creates an isolated Wayland session and mocked D-Bus service. Its output and screenshots stay in ignored `.test-artifacts/`.

`tests/deepgram_speech_smoke.py` is a separate live test using synthetic speech. It needs an API key, contacts Deepgram, and incurs normal API usage. It is not part of CI or the offline test suite.

Preserve final-word delivery, exactly one Enter after pasting, recording cleanup, and the separation of personal configuration from project files. Contributions are made under the MIT license.
