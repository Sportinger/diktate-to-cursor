import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ScreenshotController} from './screenshot.js';

const BUS = 'io.github.diktate.Cursor';
const PATH = '/io/github/diktate/Cursor';
const LISTENING_TEXT = 'höre...';
const STARTING_TEXT = 'starte...';
const READY_FLASH_SECONDS = 0.6;
const STOP_ANIMATION_MS = 500;
const PAUSE_EFFECT_START_SECONDS = 8;
const PAUSE_EFFECT_MAX_SECONDS = 20;
const LANGUAGES = [['de', 'Deutsch'], ['en', 'Englisch'], ['multi', 'Automatisch mehrsprachig']];
const SCREENSHOT_QUALITIES = [['full', 'Volle Auflösung · PNG verlustfrei'], ['compact', 'Kompakt · maximal 1920 Pixel']];
const MODIFIERS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.META_MASK | Clutter.ModifierType.MOD5_MASK;

export default class DiktateExtension extends Extension {
    enable() {
        this._state = 'idle';
        this._captureReady = false;
        this._enterBinding = false;
        this._readyFlashUntil = 0;
        this._mode = '';
        this._lastText = '';
        this._pendingClipboard = null;
        this._pasteQueue = [];
        this._submitPending = false;
        this._timeouts = new Set();
        this._stopAnimation = [];
        this._closingOverlay = false;
        this._pauseStartedAt = 0;
        this._pauseStyle = null;
        this._enabled = true;
        this._settings = this.getSettings();
        this._screenshots = new ScreenshotController(this._settings,
            saved => this._screenshotPathItem.setSensitive(saved));
        this._cancellable = new Gio.Cancellable();
        const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
        this._keyboard = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._button = new PanelMenu.Button(0.0, 'Diktate to Cursor');
        this._icon = new St.Icon({icon_name: 'audio-input-microphone-symbolic', style_class: 'system-status-icon'});
        this._button.add_child(this._icon);
        this._toggleItem = new PopupMenu.PopupMenuItem('Aufnahme starten  ·  ^');
        this._toggleItem.connect('activate', () => this._toggle());
        this._button.menu.addMenuItem(this._toggleItem);
        this._statusItem = new PopupMenu.PopupMenuItem('Bereit', {reactive: false});
        this._button.menu.addMenuItem(this._statusItem);
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._languageItem = new PopupMenu.PopupSubMenuMenuItem('Sprache: Deutsch');
        this._languageChoices = new Map();
        for (const [code, label] of LANGUAGES) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._selectLanguage(code));
            this._languageChoices.set(code, item);
            this._languageItem.menu.addMenuItem(item);
        }
        this._languageItem.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            'Gilt ab der nächsten Aufnahme', {reactive: false}));
        this._button.menu.addMenuItem(this._languageItem);
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshLanguage();
        });
        // Handle the secondary button explicitly across GNOME versions.
        this._button.connect('captured-event', (_actor, event) => {
            const type = event.type();
            if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE) &&
                event.get_button() === 3) {
                if (type === Clutter.EventType.BUTTON_PRESS)
                    this._button.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._copyItem = new PopupMenu.PopupMenuItem('Letztes Diktat kopieren');
        this._copyItem.setSensitive(false);
        this._copyItem.connect('activate', () => this._setClipboard(this._lastText));
        this._button.menu.addMenuItem(this._copyItem);
        const screenshot = new PopupMenu.PopupMenuItem('Screenshot-Bereich  ·  Shift + Alt + S');
        screenshot.connect('activate', () => this._takeScreenshot());
        this._button.menu.addMenuItem(screenshot);
        this._screenshotScreenItem = new PopupMenu.PopupMenuItem('Screenshot: ganzer Bildschirm');
        this._screenshotScreenItem.connect('activate', () => this._takeScreenshot('screen'));
        this._button.menu.addMenuItem(this._screenshotScreenItem);
        this._screenshotQualityItem = new PopupMenu.PopupSubMenuMenuItem('Screenshot-Qualität');
        this._screenshotQualityChoices = new Map();
        for (const [value, label] of SCREENSHOT_QUALITIES) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._settings.set_string('screenshot-quality', value));
            this._screenshotQualityChoices.set(value, item);
            this._screenshotQualityItem.menu.addMenuItem(item);
        }
        this._button.menu.addMenuItem(this._screenshotQualityItem);
        this._qualityChanged = this._settings.connect('changed::screenshot-quality',
            () => this._refreshScreenshotQuality());
        this._refreshScreenshotQuality();
        this._screenshotPathItem = new PopupMenu.PopupMenuItem('Letzten Screenshot-Pfad kopieren');
        this._screenshotPathItem.setSensitive(false);
        this._screenshotPathItem.connect('activate', () => this._screenshots.copyPath());
        this._button.menu.addMenuItem(this._screenshotPathItem);
        const settings = new PopupMenu.PopupMenuItem('Einstellungen …');
        settings.connect('activate', () => this.openPreferences());
        this._button.menu.addMenuItem(settings);
        const quit = new PopupMenu.PopupMenuItem('Diktat deaktivieren');
        quit.connect('activate', () => Main.extensionManager.disableExtension(this.uuid));
        this._button.menu.addMenuItem(quit);
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._overlay = new St.BoxLayout({vertical: true, reactive: false, can_focus: false,
            style_class: 'diktate-overlay', visible: false});
        this._title = new St.Label({text: LISTENING_TEXT, style_class: 'diktate-title', x_align: Clutter.ActorAlign.CENTER});
        this._title.set_pivot_point(0.5, 0.5);
        this._preview = new St.Label({text: '', style_class: 'diktate-preview', x_align: Clutter.ActorAlign.CENTER});
        this._preview.clutter_text.line_wrap = true;
        this._preview.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._overlay.add_child(this._title);
        this._overlay.add_child(this._preview);
        Main.layoutManager.addChrome(this._overlay, {trackFullscreen: false});
        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => this._positionOverlay());

        // Mutter grabs and consumes the key before it reaches any Wayland/X11 app.
        // IGNORE_AUTOREPEAT ensures holding ^ does not toggle repeatedly.
        const action = Main.wm.addKeybinding('diktate-toggle-recording', this.getSettings(),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => this._toggle());
        const screenshotAction = Main.wm.addKeybinding('diktate-screenshot', this.getSettings(),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => this._takeScreenshot());
        if (screenshotAction === Meta.KeyBindingAction.NONE)
            Main.notify('Diktate to Cursor', 'Shift + Alt + S ist bereits belegt. Screenshots sind über das Mikrofon-Menü möglich.');
        this._accelerators = action === Meta.KeyBindingAction.NONE ? [] : [action];
        // Wayland's compositor input method can consume a dead accent before
        // Mutter checks shortcuts. Let our reserved key reach the keybinding.
        // InjectionManager restores the GObject virtual method on disable.
        this._injections = new InjectionManager();
        const extension = this;
        if (Main.inputMethod) {
            this._injections.overrideMethod(Object.getPrototypeOf(Main.inputMethod), 'vfunc_filter_key_event', original => function (event) {
                if (extension._enabled && Main.actionMode === Shell.ActionMode.NORMAL &&
                    !(event.get_state() & MODIFIERS) &&
                    extension._accelerators.includes(global.display.get_keybinding_action(event.get_key_code(), 0)))
                    return false;
                return original.call(this, event);
            });
        }
        if (!this._accelerators.length)
            Main.notify('Diktate to Cursor', 'Die Taste ^ ist bereits belegt. Die Aufnahme ist über das Tray-Menü möglich.');

        this._signalSubscription = Gio.DBus.session.signal_subscribe(BUS, BUS, null, PATH, null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _interface, signal, args) => {
                this._onSignal(signal, args.deep_unpack());
            });
        this._ownerWatch = Gio.bus_watch_name(Gio.BusType.SESSION, BUS, Gio.BusNameWatcherFlags.NONE,
            () => this._call('GetState', new GLib.Variant('()', []), reply => {
                const [state, mode] = reply.deep_unpack();
                this._setState(state, mode);
            }), () => {
                if (this._state !== 'idle')
                    Main.notify('Diktate to Cursor', 'Der Diktatdienst wurde beendet.');
                this._setState('idle', '');
            });
        this._pump = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._drainPaste();
            this._updatePauseVisual();
            return GLib.SOURCE_CONTINUE;
        });
        this._call('GetState', new GLib.Variant('()', []), reply => {
            const [state, mode] = reply.deep_unpack();
            this._setState(state, mode);
        });
    }

    _configFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_config_dir(), 'diktate-to-cursor', 'config.json']));
    }

    _readConfig() {
        try {
            const [, contents] = this._configFile().load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return {};
            throw error;
        }
    }

    _refreshLanguage() {
        try {
            const code = this._readConfig().language ?? 'de';
            const label = LANGUAGES.find(([language]) => language === code)?.[1] ?? code;
            this._languageItem.label.text = `Sprache: ${label}`;
            for (const [language, item] of this._languageChoices)
                item.setOrnament(language === code ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        } catch (error) {
            this._languageItem.label.text = 'Sprache: Einstellungen nicht lesbar';
        }
    }

    _selectLanguage(code) {
        try {
            const config = this._readConfig();
            config.language = code;
            const file = this._configFile();
            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
            file.replace_contents(JSON.stringify(config, null, 2) + '\n', null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._refreshLanguage();
        } catch (error) {
            Main.notify('Diktate to Cursor', 'Die Sprache konnte nicht gespeichert werden. Bitte die Einstellungen prüfen.');
        }
    }

    _call(method, args = new GLib.Variant('()', []), callback = null) {
        Gio.DBus.session.call(BUS, PATH, BUS, method, args, null,
            Gio.DBusCallFlags.NONE, 5000, this._cancellable, (connection, result) => {
                try {
                    const reply = connection.call_finish(result);
                    if (this._enabled)
                        callback?.(reply);
                } catch (error) {
                    if (this._enabled)
                        Main.notify('Diktate to Cursor', 'Diktatdienst nicht erreichbar. Bitte den Dienst neu starten.');
                }
            });
    }

    _refreshScreenshotQuality() {
        const selected = this._settings.get_string('screenshot-quality');
        this._screenshotQualityItem.label.text = selected === 'compact'
            ? 'Screenshot-Qualität: Kompakt' : 'Screenshot-Qualität: Volle Auflösung';
        for (const [value, item] of this._screenshotQualityChoices)
            item.setOrnament(value === selected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
    }

    _takeScreenshot(mode = 'area') {
        this._button.menu.close(BoxPointer.PopupAnimation.NONE);
        return this._screenshots.capture(mode);
    }

    _stopAndSubmit() {
        if (this._state !== 'recording' || this._closingOverlay)
            return;
        this._button.menu.close();
        this._animateStopOverlay();
        this._call('StopAndSubmit');
    }

    _toggle() {
        if (this._state === 'finishing' ||
            (this._state === 'idle' && (this._pendingClipboard !== null || this._pasteQueue.length ||
                this._pasting || this._submitPending)))
            return;
        this._button.menu.close();
        if (this._state === 'recording')
            this._animateStopOverlay();
        this._call('Toggle');
    }

    _onSignal(signal, args) {
        if (signal === 'StateChanged')
            this._setState(...args);
        else if (signal === 'Interim' && this._state === 'recording' && !this._closingOverlay)
            this._preview.text = args[0].slice(-180);
        else if (signal === 'Final')
            this._pasteQueue.push(args[0]);
        else if (signal === 'SilenceChanged')
            this._setSilence(args[0]);
        else if (signal === 'CaptureReady')
            this._setCaptureReady(true);
        else if (signal === 'Finished') {
            this._lastText = args[0];
            this._copyItem.setSensitive(Boolean(this._lastText));
            this._pendingClipboard = this._lastText;
        } else if (signal === 'SubmitRequested') {
            this._submitPending = true;
        } else if (signal === 'Error' || signal === 'Notice') {
            Main.notify('Diktate to Cursor', args[0]);
        }
    }

    _setState(state, mode) {
        if (!this._enabled)
            return;
        const starting = state === 'recording' && this._state === 'idle';
        this._state = state;
        this._mode = mode;
        if (state === 'recording' && !this._enterBinding) {
            const action = Main.wm.addKeybinding('diktate-stop-and-submit', this.getSettings(),
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL, () => this._stopAndSubmit());
            this._enterBinding = action !== Meta.KeyBindingAction.NONE;
        } else if (state !== 'recording' && this._enterBinding) {
            Main.wm.removeKeybinding('diktate-stop-and-submit');
            this._enterBinding = false;
        }
        if (starting) {
            this._captureReady = false;
            this._readyFlashUntil = 0;
            this._cancelStopAnimation();
            this._closingOverlay = false;
            this._preview.text = '';
            this._title.set_width(-1);
            this._setSilence(0);
            this._call('GetSilence', new GLib.Variant('()', []), reply => {
                if (this._state === 'recording')
                    this._setSilence(reply.deep_unpack()[0]);
            });
            this._call('GetCaptureReady', new GLib.Variant('()', []), reply => {
                // A readiness signal may arrive before an older false reply.
                if (reply.deep_unpack()[0])
                    this._setCaptureReady(true);
            });
        }
        const recording = state === 'recording';
        this._icon.set_style(recording ? 'color: #ff4545;' : state === 'finishing' ? 'color: #ffbd59;' : null);
        this._toggleItem.label.text = recording ? 'Aufnahme stoppen  ·  ^' : state === 'finishing' ? 'Diktat wird abgeschlossen …' : 'Aufnahme starten  ·  ^';
        this._toggleItem.setSensitive(state !== 'finishing');
        const transport = mode === 'streaming' ? 'Live-Streaming' : mode === 'chunks' ? 'Kurze Abschnitte' : 'Verbinde …';
        this._statusItem.label.text = state === 'idle' ? 'Bereit' : transport;
        if (recording && !this._closingOverlay) {
            this._title.text = this._captureReady ? LISTENING_TEXT : STARTING_TEXT;
            this._overlay.show();
            this._positionOverlay();
        } else if (state === 'finishing') {
            this._animateStopOverlay();
        } else if (state === 'idle' && !this._stopAnimation.length) {
            this._resetPauseVisual();
            this._overlay.hide();
            this._title.text = '';
            this._preview.text = '';
        }
    }

    _setCaptureReady(ready) {
        if (this._state !== 'recording' || this._closingOverlay)
            return;
        if (ready && !this._captureReady)
            this._readyFlashUntil = GLib.get_monotonic_time() / 1e6 + READY_FLASH_SECONDS;
        this._captureReady = ready;
        this._title.text = ready ? LISTENING_TEXT : STARTING_TEXT;
        this._updatePauseVisual();
    }

    _animateStopOverlay() {
        if (this._closingOverlay)
            return;
        this._closingOverlay = true;
        this._readyFlashUntil = 0;
        this._resetPauseVisual();
        const text = this._title.text || (this._captureReady ? LISTENING_TEXT : STARTING_TEXT);
        this._title.text = text;
        // Keep the left edge fixed while removing characters from the right.
        this._title.set_width(this._title.get_preferred_width(-1)[1]);
        this._preview.text = '';
        this._overlay.show();
        this._positionOverlay();
        for (let removed = 1; removed <= text.length; removed++) {
            // Quadratic ease-in: erase slowly at first, then accelerate.
            const delay = Math.floor(STOP_ANIMATION_MS * Math.sqrt(removed / text.length));
            this._stopAnimation.push(this._later(delay, () => {
                this._title.text = text.slice(0, text.length - removed);
                if (removed === text.length) {
                    this._overlay.hide();
                    this._stopAnimation = [];
                }
            }));
        }
    }

    _cancelStopAnimation() {
        for (const id of this._stopAnimation) {
            if (this._timeouts.delete(id))
                GLib.source_remove(id);
        }
        this._stopAnimation = [];
    }

    _setSilence(seconds) {
        if (!Number.isFinite(seconds))
            return;
        this._pauseStartedAt = GLib.get_monotonic_time() / 1e6 - Math.max(0, seconds);
        this._updatePauseVisual();
    }

    _resetPauseVisual(style = null) {
        this._title.set_scale(1, 1);
        this._title.set_translation(0, 0, 0);
        if (this._pauseStyle !== style) {
            this._title.set_style(style);
            this._pauseStyle = style;
        }
    }

    _updatePauseVisual() {
        if (this._state !== 'recording' || this._closingOverlay)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        const silence = Math.max(0, now - this._pauseStartedAt);
        const progress = Math.min(1, Math.max(0, (silence - PAUSE_EFFECT_START_SECONDS) /
            (PAUSE_EFFECT_MAX_SECONDS - PAUSE_EFFECT_START_SECONDS)));
        if (progress === 0) {
            const readyStyle = this._captureReady && now < this._readyFlashUntil
                ? 'color: #57e389; text-shadow: 0px 0px 8px rgba(87,227,137,0.55);' : null;
            this._resetPauseVisual(readyStyle);
            return;
        }
        const strength = progress * progress * (3 - 2 * progress);
        const scale = 1 + 0.15 * strength;
        this._title.set_scale(scale, scale);
        this._title.set_translation(Math.sin(now * 16) * 1.6 * strength,
            Math.sin(now * 21) * 0.8 * strength, 0);
        const greenBlue = Math.round(255 - (255 - 69) * strength);
        const style = `color: rgb(255,${greenBlue},${greenBlue}); ` +
            `text-shadow: 0px 0px ${Math.round(8 * strength)}px rgba(255,69,69,${(0.45 * strength).toFixed(2)});`;
        if (style !== this._pauseStyle) {
            this._title.set_style(style);
            this._pauseStyle = style;
        }
    }

    _positionOverlay() {
        if (!this._overlay)
            return;
        const index = global.display.focus_window?.get_monitor();
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const width = Math.min(720, monitor.width - 80);
        this._overlay.set_size(width, 160);
        this._overlay.set_position(monitor.x + Math.round((monitor.width - width) / 2), monitor.y + monitor.height - 220);
    }

    _setClipboard(text) {
        if (text)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _later(milliseconds, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            this._timeouts.delete(id);
            if (this._enabled)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _drainPaste() {
        if (this._pasting)
            return;
        if (!this._pasteQueue.length) {
            if (this._pendingClipboard !== null) {
                this._setClipboard(this._pendingClipboard);
                this._pendingClipboard = null;
            }
            if (this._submitPending && this._canType()) {
                this._submitPending = false;
                const time = GLib.get_monotonic_time();
                this._keyboard.notify_keyval(time, Clutter.KEY_Return, Clutter.KeyState.PRESSED);
                this._keyboard.notify_keyval(time, Clutter.KEY_Return, Clutter.KeyState.RELEASED);
            }
            return;
        }
        // Wait while a menu, lock screen, overview, or held modifier owns input.
        if (!this._canType()) {
            // The completed dictation must be available even without a text field.
            if (this._pendingClipboard !== null)
                this._setClipboard(this._pendingClipboard);
            return;
        }
        this._pasting = true;
        this._currentInsertion = this._pasteQueue.shift();
        this._setClipboard(this._currentInsertion);
        this._later(35, () => {
            if (!this._canType()) {
                // Clipboard still holds this segment; postpone the paste without dropping it.
                this._pasteQueue.unshift(this._currentInsertion);
                this._pasting = false;
                return;
            }
            const time = GLib.get_monotonic_time();
            const app = Shell.WindowTracker.get_default().get_window_app(global.display.focus_window);
            const identity = `${app?.get_id() ?? ''} ${global.display.focus_window.get_wm_class() ?? ''}`;
            const terminal = /terminal|ptyxis|tilix|konsole|alacritty|kitty|wezterm|terminator|foot/i.test(identity);
            this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            if (terminal)
                this._keyboard.notify_keyval(time, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(time, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            if (terminal)
                this._keyboard.notify_keyval(time, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._keyboard.notify_keyval(time, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            // Leave the segment available long enough for the application to request it.
            this._later(180, () => { this._pasting = false; });
        });
    }

    _canType() {
        return Main.actionMode === Shell.ActionMode.NORMAL && !this._button.menu.isOpen && !this._screenshots.busy &&
            Boolean(global.display.focus_window) && !(global.get_pointer()[2] & MODIFIERS);
    }

    disable() {
        this._enabled = false;
        this._screenshots?.destroy();
        if (this._qualityChanged)
            this._settings.disconnect(this._qualityChanged);
        // Stop capture when GNOME locks or the extension is disabled.
        Gio.DBus.session.call(BUS, PATH, BUS, 'Stop', new GLib.Variant('()', []), null,
            Gio.DBusCallFlags.NO_AUTO_START, 1000, null, null);
        this._cancellable?.cancel();
        this._injections?.clear();
        if (this._signalSubscription)
            Gio.DBus.session.signal_unsubscribe(this._signalSubscription);
        if (this._ownerWatch)
            Gio.bus_unwatch_name(this._ownerWatch);
        if (this._pump)
            GLib.source_remove(this._pump);
        for (const id of this._timeouts ?? [])
            GLib.source_remove(id);
        Main.wm.removeKeybinding('diktate-toggle-recording');
        Main.wm.removeKeybinding('diktate-screenshot');
        if (this._enterBinding)
            Main.wm.removeKeybinding('diktate-stop-and-submit');
        if (this._monitorSignal)
            Main.layoutManager.disconnect(this._monitorSignal);
        this._overlay?.destroy();
        this._button?.destroy();
        this._overlay = null;
        this._button = null;
        this._keyboard = null;
        this._pasteQueue = [];
        this._pasting = false;
        this._submitPending = false;
        this._stopAnimation = [];
    }
}
