import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

export default class Harness extends Extension {
    enable() {
        this._run().catch(error => {
            const path = GLib.getenv('DIKTATE_TEST_ARTIFACTS');
            GLib.file_set_contents(`${path}/shell-error.txt`, `${error.message}\n${error.stack}`);
            console.error(`DIKTATE SMOKE: ${error.stack}`);
        });
    }

    async _run() {
        await wait(1500);
        Main.overview.hide();
        const real = Main.extensionManager.lookup('diktate-to-cursor@local');
        if (!real?.stateObj || real.error)
            throw new Error(`Extension failed: ${real?.error}`);
        const extension = real.stateObj;
        if (!extension._accelerators.length)
            throw new Error('No ^ accelerators registered');
        const keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const manager = Keyboard.getInputSourceManager();
        if (manager.currentSource?.id !== 'de')
            throw new Error('German keyboard layout is not active');
        for (let i = 0; i < 50; i++) {
            const app = global.display.focus_window && Shell.WindowTracker.get_default().get_window_app(global.display.focus_window);
            if (global.display.focus_window?.get_title() === 'Diktate smoke test')
                break;
            await wait(100);
        }
        if (!global.display.focus_window)
            throw new Error('Text field did not get focus');
        await wait(500);
        const press = async (duration = 60) => {
            const time = GLib.get_monotonic_time();
            keyboard.notify_key(time, 41, Clutter.KeyState.PRESSED);
            await wait(duration);
            keyboard.notify_key(GLib.get_monotonic_time(), 41, Clutter.KeyState.RELEASED);
        };
        await press(850);
        await wait(100);
        if (extension._state !== 'recording' || !extension._overlay.visible || extension._title.text !== 'höre...')
            throw new Error(`Recording UI incorrect: ${extension._state}, ${extension._overlay.visible}, ${extension._title.text}; mode=${Main.actionMode}`);
        if (!extension._icon.get_style().includes('#ff4545'))
            throw new Error('Recording icon is not red');
        const path = GLib.getenv('DIKTATE_TEST_ARTIFACTS');
        const image = Gio.File.new_for_path(`${path}/overlay.png`);
        const stream = image.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        await press();
        await wait(80);
        if (!extension._overlay.visible || !extension._title.text ||
            !'höre...'.startsWith(extension._title.text) || extension._title.text.length >= 7)
            throw new Error(`Stop did not visibly erase the listening text: ${extension._title.text}`);
        await wait(520);
        if (extension._state !== 'idle' || extension._overlay.visible)
            throw new Error('Overlay did not disappear after stop');
        await wait(600);
        const file = Gio.File.new_for_path(`${path}/client.json`);
        if (!file.query_exists(null))
            throw new Error('Text insertion or final clipboard failed');
        // A physical Enter must follow all queued pastes, without held modifiers.
        const submittedFile = Gio.File.new_for_path(`${path}/submitted.json`);
        if (submittedFile.query_exists(null))
            throw new Error('Manual stop unexpectedly pressed Enter');
        const keyval = (value, state) => keyboard.notify_keyval(GLib.get_monotonic_time(), value, state);
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
        await wait(200);
        await press();
        keyval(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        await wait(750);
        if (submittedFile.query_exists(null))
            throw new Error('Enter was pressed while Shift was held');
        await wait(250);
        if (extension._state !== 'finishing' || extension._overlay.visible)
            throw new Error('Overlay stayed visible while waiting for final transcription');
        keyval(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        for (let i = 0; i < 30 && !submittedFile.query_exists(null); i++)
            await wait(100);
        if (!submittedFile.query_exists(null))
            throw new Error('Voice command did not press Enter');
        const [, submittedBytes] = submittedFile.load_contents(null);
        const submitted = JSON.parse(new TextDecoder().decode(submittedBytes));
        if (submitted.text !== '/model test' || submitted.clipboard !== '/model test' || submitted.enters !== 1)
            throw new Error(`Incorrect voice submission: ${JSON.stringify(submitted)}`);
        extension.openPreferences();
        let preferences = false;
        for (let i = 0; i < 50; i++) {
            preferences = global.display.list_all_windows().some(window => window.get_title() === 'Diktate to Cursor');
            if (preferences)
                break;
            await wait(100);
        }
        if (!preferences)
            throw new Error('Preferences window did not open');
        global.display.list_all_windows().find(window => window.get_title() === 'Diktate to Cursor')
            .delete(global.get_current_time());
        for (let i = 0; i < 30; i++) {
            if (!global.display.list_all_windows().some(window => window.get_title() === 'Diktate to Cursor'))
                break;
            await wait(100);
        }
        await Main.extensionManager.disableExtension('diktate-to-cursor@local');
        const textWindow = global.display.list_all_windows().find(window => window.get_title() === 'Diktate smoke test');
        if (!textWindow)
            throw new Error('Text window disappeared');
        for (let i = 0; i < 30; i++) {
            textWindow.activate(global.get_current_time());
            if (global.display.focus_window === textWindow && Main.actionMode === Shell.ActionMode.NORMAL)
                break;
            await wait(100);
        }
        if (global.display.focus_window !== textWindow || Main.actionMode !== Shell.ActionMode.NORMAL)
            throw new Error('Text window did not regain focus after closing preferences');
        await wait(200);
        await press();
        keyboard.notify_key(GLib.get_monotonic_time(), 57, Clutter.KeyState.PRESSED);
        await wait(60);
        keyboard.notify_key(GLib.get_monotonic_time(), 57, Clutter.KeyState.RELEASED);
        let client;
        for (let i = 0; i < 20; i++) {
            await wait(100);
            const [, stateBytes] = Gio.File.new_for_path(`${path}/client-state.json`).load_contents(null);
            client = JSON.parse(new TextDecoder().decode(stateBytes));
            if (client.text.endsWith('^'))
                break;
        }
        if (!client.text.endsWith('^'))
            throw new Error(`Caret did not work after disabling the extension: ${client.text}`);
        GLib.file_set_contents(`${path}/shell.json`, JSON.stringify({hotkey: true, noAutorepeat: true, recordingOverlay: true, redIcon: true, stop: true, stopAnimation: true, hiddenWhileFinishing: true, enterAfterPaste: true, modifiersDeferred: true, preferences: true, restoredCaret: true}));
        console.log('DIKTATE SMOKE: PASS');
    }

    disable() {}
}
