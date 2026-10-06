import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BUS = 'io.github.diktate.Cursor';
const PATH = '/io/github/diktate/Cursor';
const MODIFIERS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.META_MASK | Clutter.ModifierType.MOD5_MASK;

export default class DiktateExtension extends Extension {
    enable() {
        this._state = 'idle';
        this._mode = '';
        this._lastText = '';
        this._pendingClipboard = null;
        this._pasteQueue = [];
        this._submitPending = false;
        this._timeouts = new Set();
        this._enabled = true;
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
        this._copyItem = new PopupMenu.PopupMenuItem('Letztes Diktat kopieren');
        this._copyItem.setSensitive(false);
        this._copyItem.connect('activate', () => this._setClipboard(this._lastText));
        this._button.menu.addMenuItem(this._copyItem);
        const settings = new PopupMenu.PopupMenuItem('Einstellungen …');
        settings.connect('activate', () => this.openPreferences());
        this._button.menu.addMenuItem(settings);
        const quit = new PopupMenu.PopupMenuItem('Diktat deaktivieren');
        quit.connect('activate', () => Main.extensionManager.disableExtension(this.uuid));
        this._button.menu.addMenuItem(quit);
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._overlay = new St.BoxLayout({vertical: true, reactive: false, can_focus: false,
            style_class: 'diktate-overlay', visible: false});
        this._title = new St.Label({text: 'höre...', style_class: 'diktate-title', x_align: Clutter.ActorAlign.CENTER});
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
            return GLib.SOURCE_CONTINUE;
        });
        this._call('GetState', new GLib.Variant('()', []), reply => {
            const [state, mode] = reply.deep_unpack();
            this._setState(state, mode);
        });
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

    _toggle() {
        if (this._state === 'finishing' ||
            (this._state === 'idle' && (this._pendingClipboard !== null || this._pasteQueue.length ||
                this._pasting || this._submitPending)))
            return;
        this._button.menu.close();
        this._call('Toggle');
    }

    _onSignal(signal, args) {
        if (signal === 'StateChanged')
            this._setState(...args);
        else if (signal === 'Interim')
            this._preview.text = args[0].slice(-180);
        else if (signal === 'Final')
            this._pasteQueue.push(args[0]);
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
        if (starting)
            this._preview.text = '';
        const recording = state === 'recording';
        this._icon.set_style(recording ? 'color: #ff4545;' : state === 'finishing' ? 'color: #ffbd59;' : null);
        this._toggleItem.label.text = recording ? 'Aufnahme stoppen  ·  ^' : state === 'finishing' ? 'Diktat wird abgeschlossen …' : 'Aufnahme starten  ·  ^';
        this._toggleItem.setSensitive(state !== 'finishing');
        const transport = mode === 'streaming' ? 'Live-Streaming' : mode === 'chunks' ? 'Kurze Abschnitte' : 'Verbinde …';
        this._statusItem.label.text = state === 'idle' ? 'Bereit' : transport;
        this._title.text = recording ? 'höre...' : 'schreibe...';
        this._overlay.visible = state !== 'idle';
        if (this._overlay.visible)
            this._positionOverlay();
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
        return Main.actionMode === Shell.ActionMode.NORMAL && !this._button.menu.isOpen &&
            Boolean(global.display.focus_window) && !(global.get_pointer()[2] & MODIFIERS);
    }

    disable() {
        this._enabled = false;
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
        if (this._monitorSignal)
            Main.layoutManager.disconnect(this._monitorSignal);
        if (this._lastText)
            this._setClipboard(this._lastText);
        this._overlay?.destroy();
        this._button?.destroy();
        this._overlay = null;
        this._button = null;
        this._keyboard = null;
        this._pasteQueue = [];
        this._pasting = false;
        this._submitPending = false;
    }
}
