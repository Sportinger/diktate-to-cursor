// One dictation's destination: the window focused when recording started (or a Raster tile),
// the finished segments still waiting for it, and a pending Enter.
import Shell from 'gi://Shell';
import St from 'gi://St';

import {isRasterWindow} from './raster.js';

// mode: 'window'    paste while the start window has focus (no start window: whatever is focused)
//       'resolving' asking Raster which tile had focus; segments wait
//       'raster'    type straight into that Raster tile, wherever focus is now
//       'clipboard' the start window closed; text only goes to the clipboard
export class Delivery {
    constructor(window, raster) {
        this.window = window ?? null;
        // Without a focused window at start, text follows the focus as before.
        this.targeted = Boolean(window);
        this.mode = 'window';
        this.pane = null;
        this.label = window ? windowLabel(window) : '';
        this.queue = [];
        this.submit = false;
        this.text = '';
        this.finalText = null;
        this.recording = true;
        this.backupDirty = false;
        this.busy = false;
        this.noticeShown = false;
        // Clipboard text when recording started: a backup may replace it, but not something copied later.
        this.clipboardAtStart = undefined;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            this.clipboardAtStart = text;
        });
        this._unmanaged = window?.connect('unmanaged', () => this._windowClosed());
        if (window && raster.available && isRasterWindow(window)) {
            this.mode = 'resolving';
            raster.focused().then(pane => {
                if (this.mode !== 'resolving')
                    return;
                if (pane) {
                    this.mode = 'raster';
                    this.pane = pane.id;
                    this.label = pane.label ? `Raster · ${pane.label}` : 'Raster';
                } else {
                    this.mode = this.window ? 'window' : 'clipboard';
                }
            });
        }
    }

    add(text) {
        this.queue.push(text);
        this.text += text;
        this.backupDirty = true;
    }

    finish(text) {
        this.finalText = text;
        this.text = text;
        this.backupDirty = true;
    }

    // True while the start window has focus (always true without a start window).
    get focused() {
        if (this.mode === 'clipboard')
            return false;
        return !this.targeted || global.display.focus_window === this.window;
    }

    get hasWork() {
        return this.queue.length > 0 || this.submit || this.finalText !== null;
    }

    get done() {
        return !this.recording && !this.hasWork && !this.busy && this.mode !== 'resolving';
    }

    // Raster could not deliver: continue like an ordinary window.
    fallBack() {
        this.mode = this.window ? 'window' : 'clipboard';
        this.pane = null;
    }

    destroy() {
        if (this._unmanaged && this.window)
            this.window.disconnect(this._unmanaged);
        this._unmanaged = 0;
    }

    _windowClosed() {
        this.window.disconnect(this._unmanaged);
        this._unmanaged = 0;
        this.window = null;
        // A Raster tile outlives its window; everything else must not land in a random window.
        if (this.mode === 'window')
            this.mode = 'clipboard';
    }
}

function windowLabel(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const label = app?.get_name() || window.get_title() || 'Startfenster';
    return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}
