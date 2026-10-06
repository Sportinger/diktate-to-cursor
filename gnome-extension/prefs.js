import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DiktatePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(620, 560);
        const folder = GLib.build_filenamev([GLib.get_user_config_dir(), 'diktate-to-cursor']);
        const file = Gio.File.new_for_path(GLib.build_filenamev([folder, 'config.json']));
        let config = {};
        try {
            const [ok, contents] = file.load_contents(null);
            if (ok)
                config = JSON.parse(new TextDecoder().decode(contents));
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`Diktate-Einstellungen: ${error.message}`);
        }
        const page = new Adw.PreferencesPage({title: 'Diktat', icon_name: 'audio-input-microphone-symbolic'});
        window.add(page);
        const group = new Adw.PreferencesGroup({title: 'Deepgram', description: '^ startet und stoppt. Änderungen gelten ab der nächsten Aufnahme.'});
        page.add(group);
        const key = new Adw.PasswordEntryRow({title: 'Deepgram API-Schlüssel', text: config.api_key ?? ''});
        group.add(key);
        const language = new Adw.ComboRow({title: 'Sprache',
            model: Gtk.StringList.new(['Deutsch', 'Automatisch (Deutsch, Englisch u. a.)', 'English']),
            selected: Math.max(0, ['de', 'multi', 'en'].indexOf(config.language ?? 'multi'))});
        group.add(language);
        const model = new Adw.EntryRow({title: 'Modell', text: config.model ?? 'nova-3'});
        group.add(model);
        const mode = new Adw.ComboRow({title: 'Übertragung',
            model: Gtk.StringList.new(['Streaming mit automatischem Fallback', 'Nur Streaming', 'Nur kurze Abschnitte']),
            selected: Math.max(0, ['auto', 'streaming', 'chunks'].indexOf(config.mode ?? 'auto'))});
        group.add(mode);
        const audio = new Adw.PreferencesGroup({title: 'Mikrofon', description: '„default“ verwendet das Mikrofon aus den GNOME-Klangeinstellungen.'});
        page.add(audio);
        const source = new Adw.EntryRow({title: 'PulseAudio-/PipeWire-Quelle', text: config.microphone ?? 'default'});
        audio.add(source);
        const seconds = new Adw.SpinRow({title: 'Chunk-Länge (Sekunden)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 0.5, value: config.chunk_seconds ?? 3}), digits: 1});
        audio.add(seconds);
        const save = new Gtk.Button({label: 'Einstellungen speichern', css_classes: ['suggested-action'],
            halign: Gtk.Align.CENTER, margin_top: 18, margin_bottom: 18});
        const saveRow = new Adw.PreferencesGroup();
        saveRow.add(save);
        page.add(saveRow);
        save.connect('clicked', () => {
            const values = {
                api_key: key.text.trim(), language: ['de', 'multi', 'en'][language.selected],
                model: model.text.trim(), mode: ['auto', 'streaming', 'chunks'][mode.selected],
                microphone: source.text.trim(), chunk_seconds: seconds.value,
            };
            if (!values.model || !values.microphone) {
                window.add_toast(new Adw.Toast({title: 'Modell und Mikrofon dürfen nicht leer sein.'}));
                return;
            }
            try {
                GLib.mkdir_with_parents(folder, 0o700);
                file.replace_contents(JSON.stringify(values, null, 2) + '\n', null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                window.add_toast(new Adw.Toast({title: 'Einstellungen gespeichert'}));
            } catch (error) {
                window.add_toast(new Adw.Toast({title: 'Speichern fehlgeschlagen'}));
                console.error(`Diktate-Einstellungen: ${error.message}`);
            }
        });
    }
}
