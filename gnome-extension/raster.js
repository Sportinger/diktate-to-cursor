// Optional integration with the Raster tiling terminal:
// ask which tile has keyboard focus and type text straight into a tile, via the `raster` CLI.
// Nothing happens unless the focused window is Raster and the CLI is installed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

// Wayland app id / WM class of the Raster window.
const APP_IDS = ['raster-terminal'];
const QUERY_TIMEOUT_MS = 1500;
const TYPE_TIMEOUT_MS = 5000;
// The extension types on behalf of the user, never as one of Raster's tiles.
const PANE_VARIABLES = ['RASTER_PANE_ID', 'RASTER_PANE_KIND', 'RASTER_PANE_ADDR'];

export function isRasterWindow(window) {
    if (!window)
        return false;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const ids = [window.get_wm_class(), window.get_gtk_application_id?.(), app?.get_id()?.replace(/\.desktop$/, '')];
    return ids.some(id => id && APP_IDS.includes(id));
}

function findBinary() {
    // DIKTATE_RASTER_BIN allows custom installs and the isolated smoke test.
    const override = GLib.getenv('DIKTATE_RASTER_BIN');
    if (override)
        return override;
    const found = GLib.find_program_in_path('raster');
    if (found)
        return found;
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'raster']);
    return GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null;
}

export class RasterBridge {
    constructor(cancellable) {
        this._cancellable = cancellable;
    }

    get available() {
        return Boolean(findBinary());
    }

    // The focused tile as {id, label}, or null when Raster cannot tell.
    async focused() {
        const output = await this._run(['focused', '--json'], '', QUERY_TIMEOUT_MS);
        if (output === null)
            return null;
        try {
            const pane = JSON.parse(output);
            if (typeof pane?.id !== 'string')
                return null;
            const name = pane.spec?.name ?? '';
            return {id: pane.id, label: pane.spec?.project ? `${pane.spec.project}/${name}` : name};
        } catch (error) {
            return null;
        }
    }

    // Paste `text` into the tile without changing focus, optionally followed by Enter. Resolves true on success.
    async type(pane, text, enter = false) {
        // Text travels on stdin so it never shows up in the process list.
        const args = ['type', pane, '--json'];
        if (!text)
            args.push('--text', '');
        if (enter)
            args.push('--enter');
        return await this._run(args, text ?? '', TYPE_TIMEOUT_MS) !== null;
    }

    _run(args, input, timeout) {
        const binary = findBinary();
        if (!binary || this._cancellable.is_cancelled())
            return Promise.resolve(null);
        return new Promise(resolve => {
            let process;
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_SILENCE,
                });
                for (const name of PANE_VARIABLES)
                    launcher.unsetenv(name);
                process = launcher.spawnv([binary, ...args]);
            } catch (error) {
                resolve(null);
                return;
            }
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                timer = 0;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(input, this._cancellable, (proc, result) => {
                if (timer)
                    GLib.source_remove(timer);
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    resolve(proc.get_successful() ? stdout ?? '' : null);
                } catch (error) {
                    resolve(null);
                }
            });
        });
    }
}
