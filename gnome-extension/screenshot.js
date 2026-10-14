import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

export class ScreenshotController {
    constructor(settings, onCopied) {
        this._settings = settings;
        this.busy = false;
        this._enabled = true;
        this._selector = null;
        this._frozenDesktop = null;
        this._lastFile = null;
        this._onCopied = onCopied;
    }

    async capture(mode = 'area') {
        if (this.busy || !this._enabled)
            return;
        this.busy = true;
        let stream = null;
        let copied = false;
        try {
            let area = mode === 'screen' ? Main.layoutManager.currentMonitor : null;
            // Capture before opening the selector: both the preview and the saved
            // crop must use this texture, even while applications keep animating.
            const [content, scale] = await new Shell.Screenshot().screenshot_stage_to_content();
            if (!this._enabled)
                return;
            if (mode !== 'screen') {
                this._frozenDesktop = new St.Widget({
                    x: 0, y: 0,
                    width: global.stage.width,
                    height: global.stage.height,
                    content,
                    reactive: false,
                });
                Main.uiGroup.add_child(this._frozenDesktop);
                const selector = new Screenshot.SelectArea();
                selector.add_style_class_name('diktate-screenshot-selection');
                this._selector = selector;
                area = await selector.selectAsync();
                this._selector = null;
                this._clearFrozenDesktop();
            }
            if (!this._enabled || !area || area.width < 2 || area.height < 2)
                return;

            stream = Gio.MemoryOutputStream.new_resizable();
            const x = Math.round(area.x * scale);
            const y = Math.round(area.y * scale);
            const right = Math.round((area.x + area.width) * scale);
            const bottom = Math.round((area.y + area.height) * scale);
            await Shell.Screenshot.composite_to_stream(content.get_texture(),
                x, y, right - x, bottom - y, scale, null, 0, 0, 1, stream);
            stream.close(null);
            const {png, width, height} = this._prepareImage(stream.steal_as_bytes());
            if (!this._enabled)
                return;
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', png);
            copied = true;
            this._lastFile = null;
            this._onCopied?.(false);

            const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
                GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
            const folder = GLib.build_filenamev([pictures, 'Screenshots']);
            GLib.mkdir_with_parents(folder, 0o700);
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
            const file = Gio.File.new_for_path(GLib.build_filenamev([
                folder, `Screenshot-${stamp}-${GLib.uuid_string_random().slice(0, 8)}.png`]));
            file.replace_contents(png.get_data(), null, false,
                Gio.FileCreateFlags.PRIVATE, null);

            this._lastFile = file;
            this._onCopied?.(true);
            Main.notify('Screenshot kopiert',
                `${width} × ${height} Pixel · PNG · In der Zwischenablage und unter Bilder/Screenshots gespeichert.`);
        } catch (error) {
            if (this._enabled) {
                console.error(`Diktate-Screenshot: ${error.message}`);
                Main.notify(copied ? 'Screenshot kopiert' : 'Screenshot fehlgeschlagen', copied
                    ? 'Das Bild liegt in der Zwischenablage, konnte aber nicht als Datei gespeichert werden.'
                    : `Die Aufnahme ist fehlgeschlagen: ${error.message}`);
            }
        } finally {
            this._clearFrozenDesktop();
            if (stream && !stream.is_closed())
                stream.close(null);
            this._selector = null;
            this.busy = false;
        }
    }

    _prepareImage(bytes) {
        const input = Gio.MemoryInputStream.new_from_bytes(bytes);
        let image;
        try {
            image = GdkPixbuf.Pixbuf.new_from_stream(input, null);
        } finally {
            input.close(null);
        }
        if (this._settings.get_string('screenshot-quality') === 'compact') {
            const ratio = Math.min(1, 1920 / Math.max(image.width, image.height));
            if (ratio < 1) {
                image = image.scale_simple(Math.max(1, Math.round(image.width * ratio)),
                    Math.max(1, Math.round(image.height * ratio)), GdkPixbuf.InterpType.HYPER);
                const [, buffer] = image.save_to_bufferv('png', [], []);
                bytes = GLib.Bytes.new(buffer);
            }
        }
        return {png: bytes, width: image.width, height: image.height};
    }

    copyPath() {
        if (this._lastFile)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
                GLib.shell_quote(this._lastFile.get_path()));
    }

    _clearFrozenDesktop() {
        this._frozenDesktop?.destroy();
        this._frozenDesktop = null;
    }

    destroy() {
        this._enabled = false;
        // Release the modal grab too, including when GNOME locks the screen.
        this._selector?._grabHelper.ungrab();
        this._selector = null;
        this._clearFrozenDesktop();
    }
}
