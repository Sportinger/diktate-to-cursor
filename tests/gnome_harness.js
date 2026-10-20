import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import St from 'gi://St';
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
        const pointer = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const [buttonX, buttonY] = extension._button.get_transformed_position();
        const [buttonWidth, buttonHeight] = extension._button.get_transformed_size();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), buttonX + buttonWidth / 2, buttonY + buttonHeight / 2);
        await wait(100);
        pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.PRESSED);
        await wait(60);
        pointer.notify_button(GLib.get_monotonic_time(), 3, Clutter.ButtonState.RELEASED);
        await wait(150);
        if (!extension._button.menu.isOpen || extension._languageItem.label.text !== 'Sprache: Deutsch')
            throw new Error(`Right click failed: open=${extension._button.menu.isOpen}, label=${extension._languageItem.label.text}, position=${global.get_pointer()}, target=${buttonX},${buttonY},${buttonWidth},${buttonHeight}`);
        const configFile = extension._configFile();
        GLib.mkdir_with_parents(configFile.get_parent().get_path(), 0o700);
        configFile.replace_contents(JSON.stringify({api_key: 'test-key', microphone: 'test-source'}),
            null, false, Gio.FileCreateFlags.PRIVATE, null);
        extension._languageChoices.get('en').activate(null);
        let selectedConfig = extension._readConfig();
        if (selectedConfig.language !== 'en' || selectedConfig.api_key !== 'test-key' || selectedConfig.microphone !== 'test-source')
            throw new Error('Language selection was not saved or changed unrelated settings');
        extension._button.menu.open();
        if (extension._languageItem.label.text !== 'Sprache: Englisch')
            throw new Error('Language selection was not reflected in the menu');
        extension._languageChoices.get('de').activate(null);
        if (extension._readConfig().language !== 'de')
            throw new Error('Could not switch back to German');
        extension._button.menu.close();
        await wait(200);
        const press = async (duration = 60) => {
            const time = GLib.get_monotonic_time();
            keyboard.notify_key(time, 41, Clutter.KeyState.PRESSED);
            await wait(duration);
            keyboard.notify_key(GLib.get_monotonic_time(), 41, Clutter.KeyState.RELEASED);
        };
        const heldPress = press(850);
        await wait(100);
        if (extension._state !== 'recording' || extension._title.text !== 'starte...')
            throw new Error('Overlay claimed to listen before microphone readiness');
        if (extension._title.get_style())
            throw new Error('Readiness flash appeared before microphone readiness');
        await wait(300);
        const readyColor = extension._title.get_theme_node().get_foreground_color();
        if (extension._title.text !== 'höre...' || readyColor.red !== 87 ||
            readyColor.green !== 227 || readyColor.blue !== 137)
            throw new Error('Microphone readiness did not flash green');
        const flashUntil = extension._readyFlashUntil;
        extension._onSignal('CaptureReady', []);
        if (extension._readyFlashUntil !== flashUntil)
            throw new Error('Duplicate readiness signal restarted the flash');
        await heldPress;
        await wait(100);
        if (extension._title.get_style())
            throw new Error('Readiness flash did not return to white');
        if (extension._state !== 'recording' || !extension._overlay.visible || extension._title.text !== 'höre...')
            throw new Error(`Recording UI incorrect: ${extension._state}, ${extension._overlay.visible}, ${extension._title.text}; mode=${Main.actionMode}`);
        if (!extension._icon.get_style().includes('#ff4545'))
            throw new Error('Recording icon is not red');
        extension._onSignal('SilenceChanged', [7]);
        if (extension._title.scale_x !== 1 || extension._title.get_style())
            throw new Error('Pause effects started before 8 seconds');
        extension._onSignal('SilenceChanged', [12]);
        const middleScale = extension._title.scale_x;
        extension._onSignal('SilenceChanged', [20]);
        const maximumScale = extension._title.scale_x;
        if (middleScale <= 1 || maximumScale <= middleScale || !extension._title.get_theme_node().get_text_shadow())
            throw new Error('Pause did not gradually increase scale and glow');
        const color = extension._title.get_theme_node().get_foreground_color();
        if (color.red !== 255 || color.green !== 69 || color.blue !== 69)
            throw new Error('Pause warning did not turn red');
        extension._onSignal('SilenceChanged', [27]);
        if (extension._title.scale_x !== maximumScale)
            throw new Error('Pause effects kept growing beyond 20 seconds');
        extension._onSignal('SilenceChanged', [0]);
        if (extension._title.scale_x !== 1 || extension._title.translation_x !== 0 ||
            extension._title.translation_y !== 0 || extension._title.get_style())
            throw new Error('Speech did not reset pause effects');
        const path = GLib.getenv('DIKTATE_TEST_ARTIFACTS');
        const image = Gio.File.new_for_path(`${path}/overlay.png`);
        const stream = image.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        await press();
        await wait(80);
        if (extension._title.text !== 'höre...')
            throw new Error('Stop animation did not start slowly');
        await wait(120);
        if (!extension._overlay.visible || !extension._title.text ||
            !'höre...'.startsWith(extension._title.text) || extension._title.text.length >= 7)
            throw new Error(`Stop did not visibly erase the listening text: ${extension._title.text}`);
        await wait(300);
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
        // Physical Enter must be intercepted, flush late words, and submit once.
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
        await wait(100);
        await press();
        await wait(350);
        keyval(Clutter.KEY_Return, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_Return, Clutter.KeyState.RELEASED);
        await wait(1000);
        const [, keyboardSubmittedBytes] = submittedFile.load_contents(null);
        const keyboardSubmitted = JSON.parse(new TextDecoder().decode(keyboardSubmittedBytes));
        if (extension._state !== 'idle' || extension._enterBinding || keyboardSubmitted.enters !== 2 ||
            keyboardSubmitted.text !== 'Hallo Welt. Noch ein Satz.')
            throw new Error(`Physical Enter did not finish and submit once: ${JSON.stringify(keyboardSubmitted)}`);

        // Dictation stays with the window where it started, even after clicking elsewhere.
        const readJson = name => JSON.parse(new TextDecoder().decode(
            Gio.File.new_for_path(`${path}/${name}`).load_contents(null)[1]));
        const clipboardText = () => new Promise(resolve =>
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)));
        const findWindow = async title => {
            for (let i = 0; i < 60; i++) {
                const found = global.display.list_all_windows().find(window => window.get_title() === title);
                if (found)
                    return found;
                await wait(100);
            }
            throw new Error(`Window did not appear: ${title}`);
        };
        const focusWindow = async window => {
            for (let i = 0; i < 30 && global.display.focus_window !== window; i++) {
                window.activate(global.get_current_time());
                await wait(60);
            }
            if (global.display.focus_window !== window)
                throw new Error(`Could not focus ${window.get_title()}`);
        };
        const until = async (check, message) => {
            for (let i = 0; i < 40; i++) {
                if (check())
                    return;
                await wait(100);
            }
            throw new Error(message());
        };
        const rasterLog = () => {
            const file = Gio.File.new_for_path(`${path}/raster.jsonl`);
            if (!file.query_exists(null))
                return [];
            return new TextDecoder().decode(file.load_contents(null)[1]).trim().split('\n').map(line => JSON.parse(line));
        };
        const setRasterFocus = pane => GLib.file_set_contents(`${path}/raster-focus.txt`, pane);
        const pressReturn = () => {
            keyval(Clutter.KEY_Return, Clutter.KeyState.PRESSED);
            keyval(Clutter.KEY_Return, Clutter.KeyState.RELEASED);
        };
        const startWindow = global.display.focus_window;
        extension._call('TestOpenWindows');
        const otherWindow = await findWindow('Diktate other window');
        const rasterWindow = await findWindow('Fake Raster');
        // New windows take focus once they are first drawn; let that settle.
        await wait(1500);
        await focusWindow(startWindow);
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_a, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
        await wait(200);
        await press();
        await focusWindow(otherWindow);
        await wait(1500);
        let seen = readJson('client-state.json');
        if (seen.text !== '' || seen.other !== '' || extension._current?.queue.length !== 1)
            throw new Error(`Dictation was pasted into the wrong window: ${JSON.stringify(seen)}`);
        if (!extension._hint.visible || !extension._hint.text.startsWith('wartet auf '))
            throw new Error(`Waiting hint missing: ${extension._hint.text}`);
        if (extension._enterBinding || await clipboardText() !== 'Hallo Welt.')
            throw new Error('Waiting dictation captured Enter elsewhere or did not keep the clipboard backup');
        pressReturn();
        await wait(300);
        seen = readJson('client-state.json');
        if (extension._state !== 'recording' || seen.other !== '\n')
            throw new Error(`Enter in another window was taken as submit: ${JSON.stringify(seen)}, ${extension._state}, ${extension._enterBinding}, ${global.display.focus_window?.get_title()}`);
        await press();
        await wait(900);
        seen = readJson('client-state.json');
        if (extension._state !== 'idle' || seen.text !== '' || !extension._icon.get_style()?.includes('#8ab4f8') ||
            !extension._statusItem.label.text.startsWith('Text wartet auf '))
            throw new Error(`Stopped dictation did not wait calmly: ${JSON.stringify(seen)}, ${extension._statusItem.label.text}`);
        if (await clipboardText() !== 'Hallo Welt. Noch ein Satz.')
            throw new Error('Clipboard backup does not hold the full dictation');
        await focusWindow(startWindow);
        await until(() => readJson('client-state.json').text === 'Hallo Welt. Noch ein Satz.',
            () => `Waiting dictation was not pasted on return: ${JSON.stringify(readJson('client-state.json'))}`);
        await until(() => !extension._deliveries.length && !extension._icon.get_style(),
            () => 'Delivered dictation did not clear the waiting state');
        if (readJson('client-state.json').other !== '\n')
            throw new Error('Other window received dictated text');

        // Raster: text goes straight into the tile that had focus, wherever the focus is now.
        setRasterFocus('pane-1');
        await focusWindow(rasterWindow);
        await press();
        await wait(100);
        await focusWindow(otherWindow);
        await until(() => rasterLog().length === 1, () => `Raster tile got no text: ${JSON.stringify(rasterLog())}`);
        let entry = rasterLog()[0];
        if (entry.pane !== 'pane-1' || entry.text !== 'Hallo Welt.' || entry.enter || entry.pane_env !== null)
            throw new Error(`Incorrect Raster delivery: ${JSON.stringify(entry)}`);
        if (extension._current?.mode !== 'raster' || !extension._hint.text.startsWith('schreibt in Raster'))
            throw new Error(`Raster target not shown: ${extension._current?.mode}, ${extension._hint.text}`);
        pressReturn();
        await wait(300);
        if (extension._state !== 'recording' || readJson('client-state.json').other !== '\n\n')
            throw new Error('Enter outside Raster was captured');
        await focusWindow(rasterWindow);
        setRasterFocus('pane-2');
        await wait(150);
        pressReturn();
        await until(() => rasterLog().length === 2, () => 'Enter in another tile was not forwarded');
        entry = rasterLog()[1];
        if (entry.pane !== 'pane-2' || entry.text !== '' || !entry.enter || extension._state !== 'recording')
            throw new Error(`Enter in another tile was misrouted: ${JSON.stringify(entry)}`);
        setRasterFocus('pane-1');
        pressReturn();
        await until(() => rasterLog().length === 4, () => `Raster submit incomplete: ${JSON.stringify(rasterLog())}`);
        const [, finalEntry, submitEntry] = rasterLog().slice(1);
        if (finalEntry.pane !== 'pane-1' || finalEntry.text !== ' Noch ein Satz.' || finalEntry.enter ||
            submitEntry.pane !== 'pane-1' || submitEntry.text !== '' || !submitEntry.enter)
            throw new Error(`Raster submit misrouted: ${JSON.stringify(rasterLog())}`);
        await wait(200);
        seen = readJson('client-state.json');
        if (extension._state !== 'idle' || extension._enterBinding || seen.text !== 'Hallo Welt. Noch ein Satz.' ||
            seen.other !== '\n\n' || await clipboardText() !== 'Hallo Welt. Noch ein Satz.')
            throw new Error(`Raster dictation leaked into windows: ${JSON.stringify(seen)}`);

        // Raster unreachable: fall back to waiting for the Raster window.
        GLib.file_set_contents(`${path}/raster-fail.txt`, '1');
        await press();
        const fallback = extension._current;
        await until(() => fallback.mode === 'window' && fallback.noticeShown,
            () => `No fallback when Raster fails: ${fallback.mode}`);
        await press();
        await until(() => !extension._deliveries.length, () => 'Fallback dictation was not delivered to the Raster window');
        Gio.File.new_for_path(`${path}/raster-fail.txt`).delete(null);
        if (rasterLog().length !== 4 || readJson('client-state.json').text !== 'Hallo Welt. Noch ein Satz.')
            throw new Error('Fallback dictation went elsewhere');

        // The start window closes: never paste into another window, keep the text on the clipboard.
        await focusWindow(otherWindow);
        await press();
        await focusWindow(startWindow);
        otherWindow.delete(global.get_current_time());
        await until(() => !global.display.list_all_windows().includes(otherWindow), () => 'Other window did not close');
        await wait(1500);
        if (extension._current?.mode !== 'clipboard' || extension._enterBinding ||
            !extension._hint.text.startsWith('Startfenster geschlossen') || await clipboardText() !== 'Hallo Welt.')
            throw new Error(`Closed start window not handled: ${extension._current?.mode}, ${extension._hint.text}`);
        await press();
        await wait(900);
        if (readJson('client-state.json').text !== 'Hallo Welt. Noch ein Satz.' || extension._deliveries.length ||
            await clipboardText() !== 'Hallo Welt. Noch ein Satz.')
            throw new Error('Dictation for a closed window was pasted elsewhere');
        rasterWindow.delete(global.get_current_time());
        await focusWindow(startWindow);

        const screenshotHotkey = async () => {
            keyval(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            keyval(Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
            keyval(Clutter.KEY_s, Clutter.KeyState.PRESSED);
            keyval(Clutter.KEY_s, Clutter.KeyState.RELEASED);
            keyval(Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
            keyval(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            await wait(200);
        };
        const changingContent = new St.Widget({
            x: 450, y: 200, width: 201, height: 121,
            style: 'background-color: #e04020;',
        });
        Main.uiGroup.add_child(changingContent);
        await wait(100);
        const readTestArea = async () => {
            const captureStream = Gio.MemoryOutputStream.new_resizable();
            await new Shell.Screenshot().screenshot_area(450, 200, 201, 121, captureStream);
            captureStream.close(null);
            const input = Gio.MemoryInputStream.new_from_bytes(captureStream.steal_as_bytes());
            try {
                return GdkPixbuf.Pixbuf.new_from_stream(input, null);
            } finally {
                input.close(null);
            }
        };
        const pixel = pixbuf => {
            const offset = 60 * pixbuf.get_rowstride() + 100 * pixbuf.get_n_channels();
            return Array.from(pixbuf.get_pixels().slice(offset, offset + 3));
        };
        const referenceImage = await readTestArea();
        await screenshotHotkey();
        if (!extension._screenshots.busy || !extension._screenshots._selector?.visible)
            throw new Error('Shift+Alt+S did not open screenshot selection');
        const frozenPreview = await readTestArea();
        changingContent.set_style('background-color: #2060e0;');
        await wait(250);
        const changedPreview = await readTestArea();
        if (JSON.stringify(pixel(frozenPreview)) !== JSON.stringify(pixel(changedPreview)))
            throw new Error('Screenshot preview changed with the live desktop');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 450, 200);
        await wait(80);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        await wait(80);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 650, 320);
        await wait(100);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        for (let i = 0; i < 40 && extension._screenshots.busy; i++)
            await wait(100);
        if (extension._screenshots.busy)
            throw new Error('Screenshot did not complete on mouse release');
        if (extension._screenshots._frozenDesktop)
            throw new Error('Frozen desktop remained after selection');
        const liveImage = await readTestArea();
        if (JSON.stringify(pixel(liveImage)) === JSON.stringify(pixel(referenceImage)))
            throw new Error('Live content did not change behind the frozen desktop');
        changingContent.destroy();
        extension._call('TestScreenshotClipboard');
        const screenshotResult = Gio.File.new_for_path(`${path}/client-screenshot.json`);
        for (let i = 0; i < 30 && !screenshotResult.query_exists(null); i++)
            await wait(100);
        if (!screenshotResult.query_exists(null))
            throw new Error('Screenshot could not be pasted as an image and text');
        const [, screenshotBytes] = screenshotResult.load_contents(null);
        const screenshotData = JSON.parse(new TextDecoder().decode(screenshotBytes));
        if (screenshotData.width !== 201 || screenshotData.height !== 121)
            throw new Error(`Incorrect screenshot clipboard: ${JSON.stringify(screenshotData)}`);
        extension._screenshotPathItem.activate(null);
        const screenshotPathText = await new Promise(resolve =>
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)));
        const [, screenshotPaths] = GLib.shell_parse_argv(screenshotPathText);
        if (screenshotPaths.length !== 1 || !Gio.File.new_for_path(screenshotPaths[0]).query_exists(null))
            throw new Error('Screenshot terminal path does not point to the saved image');
        const croppedImage = GdkPixbuf.Pixbuf.new_from_file(screenshotPaths[0]);
        if (JSON.stringify(pixel(croppedImage)) !== JSON.stringify(pixel(referenceImage)))
            throw new Error('Screenshot did not preserve the original frame without the selection overlay');
        Gio.File.new_for_path(screenshotPaths[0]).copy(Gio.File.new_for_path(`${path}/cropped.png`),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        if (extension._settings.get_string('screenshot-quality') !== 'full')
            throw new Error('Screenshots must default to full resolution');
        const source = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 3440, 1440);
        source.fill(0xabcdefff);
        const [, sourceBuffer] = source.save_to_bufferv('png', [], []);
        const sourceBytes = GLib.Bytes.new(sourceBuffer);
        let prepared = extension._screenshots._prepareImage(sourceBytes);
        if (prepared.width !== 3440 || prepared.height !== 1440 || !prepared.png.equal(sourceBytes))
            throw new Error('Full-resolution screenshot was altered');
        extension._screenshotQualityChoices.get('compact').activate(null);
        if (!extension._screenshotQualityItem.label.text.includes('Kompakt'))
            throw new Error('Screenshot quality menu did not update');
        prepared = extension._screenshots._prepareImage(sourceBytes);
        const compactImage = GdkPixbuf.Pixbuf.new_from_stream(
            Gio.MemoryInputStream.new_from_bytes(prepared.png), null);
        if (compactImage.width !== 1920 || compactImage.height !== 804)
            throw new Error('Compact screenshot did not preserve its aspect ratio');
        const [, smallBuffer] = croppedImage.save_to_bufferv('png', [], []);
        const smallBytes = GLib.Bytes.new(smallBuffer);
        if (!extension._screenshots._prepareImage(smallBytes).png.equal(smallBytes))
            throw new Error('Compact screenshot enlarged a small image');
        extension._screenshotQualityChoices.get('full').activate(null);
        extension._button.menu.open();
        extension._screenshotScreenItem.activate(null);
        for (let i = 0; i < 40 && extension._screenshots.busy; i++)
            await wait(100);
        const screenImage = GdkPixbuf.Pixbuf.new_from_file(extension._screenshots._lastFile.get_path());
        if (screenImage.width !== 1280 || screenImage.height !== 720 || extension._button.menu.isOpen)
            throw new Error('Full-screen screenshot or closing the menu failed');
        await screenshotHotkey();
        keyval(Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyval(Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await wait(300);
        if (extension._screenshots.busy || extension._screenshots._frozenDesktop)
            throw new Error('Escape did not cancel screenshot selection');
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
        await screenshotHotkey();
        await Main.extensionManager.disableExtension('diktate-to-cursor@local');
        await wait(150);
        if (extension._screenshots.busy || extension._screenshots._frozenDesktop)
            throw new Error('Disabling the extension left screenshot selection active');
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
        GLib.file_set_contents(`${path}/shell.json`, JSON.stringify({screenshotFrozenPreview: true, screenshotFrozenCrop: true, screenshotFullResolution: true, screenshotCompact: true, screenshotScreen: true, screenshotCrop: true, screenshotImageClipboard: true, screenshotPath: true, screenshotCancel: true, screenshotDisable: true, physicalEnterSubmit: true, stayWithStartWindow: true, enterOnlyInStartWindow: true, clipboardBackup: true, rasterTile: true, rasterEnterOtherTile: true, rasterFallback: true, closedStartWindow: true, rightClickLanguage: true, hotkey: true, noAutorepeat: true, recordingOverlay: true, greenReadyFlash: true, redIcon: true, pauseEffects: true, redPauseWarning: true, speechReset: true, stop: true, stopAnimation: true, hiddenWhileFinishing: true, enterAfterPaste: true, modifiersDeferred: true, preferences: true, restoredCaret: true}));
        console.log('DIKTATE SMOKE: PASS');
    }

    disable() {}
}
