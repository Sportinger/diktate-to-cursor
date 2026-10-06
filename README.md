# Diktate to Cursor

Ein Diktierwerkzeug für **GNOME unter Linux, einschließlich Wayland**. Es lebt als Mikrofon-Symbol in der oberen Leiste und transkribiert mit Deepgram Nova-3.

- **`^` drücken:** Aufnahme starten. Erneut drücken: stoppen. Gedrückthalten löst keine mehrfachen Umschaltungen aus.
- **Während der Aufnahme:** rotes Mikrofon und ein großes, weißes **„höre...“** unten mittig auf dem aktiven Bildschirm, ohne Hintergrund. Das Overlay nimmt keinen Tastaturfokus an.
- **Live-Text:** vorläufige Wörter erscheinen schon während des Sprechens im Overlay. Bestätigte Abschnitte werden direkt in die aktive Anwendung eingefügt. Kurze Sprechpausen reichen aus; zusätzlich werden nach mindestens zwei Sekunden bei einer kurzen leisen Stelle neue Ergebnisse angefordert, ohne mitten im Wort abzuschneiden.
- **Nach dem Stoppen:** letzte Wörter werden noch verarbeitet; danach liegt das vollständige Diktat automatisch in der Zwischenablage. Das Overlay verschwindet.
- **Fallback:** wenn Streaming nicht verfügbar ist oder abbricht, werden die noch nicht bestätigten Audiodaten in kurzen Abschnitten transkribiert. Bereits eingefügter Text wird nicht erneut transkribiert.
- **„Slash Model“ / „Slash Zoom“ sagen:** schreibt `/model` bzw. `/zoom`. Das funktioniert auch mit anderen Befehlsnamen und über Abschnittsgrenzen hinweg.
- **„go go“ sagen:** zwei direkt aufeinanderfolgende „go“ beenden die Aufnahme. Der letzte Text wird eingefügt, danach drückt das Werkzeug Enter im aktiven Textfeld. Die Befehlswörter erscheinen weder im Text noch in der Zwischenablage. Es reagiert auf bestätigte Ergebnisse; einzelne „go“ bleiben normaler Text. Wenn Wortzeiten verfügbar sind, dürfen zwischen den beiden „go“ höchstens zwei Sekunden liegen. Beim Stoppen mit `^` wird kein Enter gedrückt.

## Installation

Voraussetzungen: GNOME Shell 45–50, Python ≥3.11, Python-GObject (`gi`), GTK 4/Libadwaita für die Einstellungen und FFmpeg mit PulseAudio-Unterstützung. Getestet auf Ubuntu mit **GNOME 50.1 und Wayland**. PipeWire funktioniert über seine PulseAudio-Schnittstelle. Andere Desktop-Umgebungen und Windows sind derzeit nicht implementiert.

Auf Ubuntu bei Bedarf:

```bash
sudo apt install python3-venv python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 ffmpeg
```

Im Projektordner:

```bash
./install.sh
```

Die Installation legt die GNOME-Erweiterung und einen Benutzerdienst an und aktiviert beide. Das Tool startet anschließend automatisch bei jeder GNOME-Anmeldung und zeigt sein Mikrofon-Symbol; eine Aufnahme beginnt erst mit `^`. Der Dienst ist für `graphical-session.target` aktiviert und startet nach einem Absturz automatisch neu. Ein vorhandener `DEEPGRAM_API_KEY` wird in einer privaten Konfigurationsdatei gespeichert. Ansonsten den Schlüssel später über **Mikrofon → Einstellungen** eintragen.

**Nach der ersten Installation einmal ab- und wieder anmelden.** GNOME muss die neu installierte Erweiterung einlesen. Anschließend erscheint das Mikrofon automatisch. Die Installation benötigt keine Root-Rechte, sofern die Systempakete bereits vorhanden sind. Den Projektordner nach der Installation nicht verschieben: Der Dienst verwendet dessen virtuelle Python-Umgebung.

## Benutzung und Einstellungen

Ein Textfeld anklicken, `^` drücken, sprechen und mit `^` beenden. Alternativ im Tray-Menü **Aufnahme starten/stoppen** wählen.

Die reservierte Taste `^` erreicht während aktivierter Erweiterung das Textfeld nicht. Andere Kombinationen wie `Shift` mit derselben Taste bleiben verfügbar. In den GNOME-Erweiterungen lässt sich das Werkzeug deaktivieren; danach ist `^` wieder eine normale Taste.

Die Texteingabe folgt dem aktuellen Fokus. Ein Wechsel in ein anderes Textfeld leitet folgende Abschnitte dorthin. Während Menüs, Übersicht oder gedrückte Modifikatortasten die Eingabe blockieren, wartet das Einfügen. Das Werkzeug verwendet die Zwischenablage und `Ctrl+V`; erkannte Terminal-Anwendungen erhalten `Ctrl+Shift+V`. Anwendungen mit abweichenden Einfüge-Tastenkürzeln benötigen eine entsprechende Anpassung. Bei einer ausgewählten Textstelle ersetzt normales Einfügen die Auswahl. Das eingebettete Terminal eines Editors wird nicht gesondert erkannt.

Im Menü **Einstellungen**:

| Einstellung | Vorgabe |
| --- | --- |
| Sprache | Automatisch mehrsprachig (`multi`), einschließlich Deutsch und Englisch |
| Modell | `nova-3` |
| Übertragung | Streaming mit automatischem Chunk-Fallback |
| Mikrofon | `default`, also die GNOME-Standardquelle |
| Chunk-Länge | 3 Sekunden, bevorzugt an Sprechpausen; bei durchgängiger Sprache spätestens nach 4 Sekunden |

Für eine bestimmte Mikrofonquelle deren Namen aus `ffmpeg -sources pulse` eintragen. Einstellungsänderungen gelten ab der nächsten Aufnahme. Beim Sperren des Bildschirms oder Deaktivieren der Erweiterung endet eine laufende Aufnahme. Eine einzelne Aufnahme endet spätestens nach 30 Minuten.

Audiodaten werden ausschließlich während der Aufnahme im Arbeitsspeicher gehalten und an Deepgram übertragen. Es werden keine Audiodateien lokal gespeichert. Das Werkzeug verwendet keine Rauschunterdrückung oder Hochpassfilter; es wandelt das Mikrofonsignal nur in mono, 16 kHz, PCM16 um.

Der API-Schlüssel liegt in `~/.config/diktate-to-cursor/config.json` (Dateirechte `0600`), nicht im Repository oder in der Dienstdefinition. Bei einem Fehler bleibt bereits erkannter Text als letztes Diktat verfügbar; Audiodaten werden nach Ende der Sitzung aus dem Arbeitsspeicher entfernt. Das Werkzeug speichert keine Transkript-Historie.

## Steuerung und Diagnose

```bash
./run.sh             # Dienst starten und Erweiterung aktivieren
./run.sh status      # Aufnahmezustand
./run.sh toggle      # Aufnahme starten/stoppen
./run.sh stop        # Aufnahme stoppen
./run.sh doctor      # Deepgram-Streaming und REST mit synthetischer Stille prüfen
```

```bash
systemctl --user restart diktate-to-cursor.service
journalctl --user -u diktate-to-cursor.service -n 40
gnome-extensions info diktate-to-cursor@local
```

**Diktat deaktivieren** im Tray-Menü entfernt das Symbol und gibt den Hotkey frei. Über `./run.sh` oder den Eintrag **Diktate to Cursor** im Anwendungsmenü wieder aktivieren.

Deinstallation (persönliche Konfiguration bleibt erhalten):

```bash
.venv/bin/python -m diktate uninstall
```

## Entwicklung und Tests

Der Python-Dienst übernimmt Mikrofonaufnahme mit 100-ms-PCM-Paketen, Deepgram-WebSocket, REST-Fallback und Aufnahmezustand. Die GNOME-Erweiterung übernimmt globalen Hotkey, Tray, Overlay, Zwischenablage und virtuelle Tastatureingabe. Beide kommunizieren über den Session-D-Bus `io.github.diktate.Cursor`.

```bash
.venv/bin/python -m unittest discover -s tests -v
node --check gnome-extension/extension.js
node --check gnome-extension/prefs.js
bash tests/gnome_smoke.sh
.venv/bin/python tests/deepgram_speech_smoke.py
```

Der GNOME-Test startet eine separate, virtuelle Wayland-Sitzung und verwendet einen simulierten Diktatdienst sowie ein echtes GTK-Textfeld. Er prüft `^`, das rote Symbol, Overlay, Einfügen, die endgültige Zwischenablage und genau eine Enter-Taste nach allen Einfügungen. Gedrücktes Shift verzögert sowohl Einfügen als auch Enter. Er benötigt GNOME 50. Der Deepgram-Sprachtest überträgt ausschließlich mit FFmpeg/Flite erzeugte Testsprache und prüft Streaming, Chunk-Fallback sowie „Slash Model, go go“; er benötigt einen gültigen API-Schlüssel und verursacht normale API-Nutzung. Der Diagnosebefehl öffnet kein Mikrofon.

Ergebnisse der Desktop-Tests liegen in `.test-artifacts/` und werden nicht eingecheckt. Änderungen an bereits geladenem GNOME-Erweiterungscode erfordern eine neue Shell-Sitzung; ein Neustart des Python-Dienstes reicht nur für Änderungen am Dienst.

Verwendete API-Dokumentation: [Deepgram Live Audio](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [Interim Results und Endpointing](https://developers.deepgram.com/docs/understand-endpointing-interim-results), [Finalize](https://developers.deepgram.com/docs/finalize), [CloseStream](https://developers.deepgram.com/docs/close-stream), [GNOME-Erweiterungen](https://gjs.guide/extensions/development/creating.html).
