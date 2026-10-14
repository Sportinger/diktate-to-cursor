"""Fake recorder + real Wayland text field for the isolated GNOME smoke test."""
import json
import os
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gio, GLib

from diktate.service import BUS_NAME, INTERFACE, INTROSPECTION, OBJECT_PATH

artifacts = Path(sys.argv[1])
state = "idle"
connection = None
buffer = None
application = None
clipboard_text = None
toggle_count = 0
capture_ready = False
enter_count = 0


def emit(name, *args):
    connection.emit_signal(None, OBJECT_PATH, INTERFACE, name,
                           GLib.Variant("(d)" if name == "SilenceChanged" else "(" + "s" * len(args) + ")", args))


def call(conn, sender, path, interface, method, args, invocation):
    global state, toggle_count, capture_ready
    if method == 'TestScreenshotClipboard':
        clipboard = Gdk.Display.get_default().get_clipboard()
        def texture_ready(clipboard, result):
            try:
                texture = clipboard.read_texture_finish(result)
                data = {'width': texture.get_width(), 'height': texture.get_height()}
                (artifacts / 'client-screenshot.json').write_text(json.dumps(data))
                invocation.return_value(None)
            except Exception as error:
                invocation.return_dbus_error('io.github.diktate.TestError', str(error))
        clipboard.read_texture_async(None, texture_ready)
        return
    if method == "GetState":
        invocation.return_value(GLib.Variant("(ss)", (state, "streaming" if state != "idle" else "")))
        return
    if method == "GetSilence":
        invocation.return_value(GLib.Variant("(d)", (0.0,)))
        return
    if method == "GetCaptureReady":
        invocation.return_value(GLib.Variant("(b)", (capture_ready,)))
        return
    if method == "Toggle":
        toggle_count += 1
        if state == "idle":
            capture_ready = False
            state = "recording"
            emit("StateChanged", state, "streaming")
            def ready():
                global capture_ready
                if state == 'recording':
                    capture_ready = True
                    emit('CaptureReady')
                return GLib.SOURCE_REMOVE
            GLib.timeout_add(250, ready)
            if toggle_count == 3:
                def voice_submit():
                    global state
                    state = "finishing"
                    emit("StateChanged", state, "streaming")
                    emit("Final", "/model")
                    def finish_submit():
                        global state
                        emit("Final", " test")
                        emit("Finished", "/model test")
                        emit("SubmitRequested")
                        state = "idle"
                        emit("StateChanged", state, "")
                        return GLib.SOURCE_REMOVE
                    GLib.timeout_add(900, finish_submit)
                    return GLib.SOURCE_REMOVE
                GLib.timeout_add(250, voice_submit)
                invocation.return_value(None)
                return
            emit("Interim", "Hallo Welt.")
            GLib.timeout_add(200, lambda: emit("Final", "Hallo Welt.") or GLib.SOURCE_REMOVE)
        else:
            state = "finishing"
            emit("StateChanged", state, "streaming")
            emit("Final", " Noch ein Satz.")
            emit("Finished", "Hallo Welt. Noch ein Satz.")
            state = "idle"
            emit("StateChanged", state, "")
    elif method == 'StopAndSubmit':
        state = 'finishing'
        emit('StateChanged', state, 'streaming')
        def finish_keyboard_submit():
            global state
            emit('Final', ' Noch ein Satz.')
            emit('Finished', 'Hallo Welt. Noch ein Satz.')
            emit('SubmitRequested')
            state = 'idle'
            emit('StateChanged', state, '')
            return GLib.SOURCE_REMOVE
        GLib.timeout_add(150, finish_keyboard_submit)
    elif method == "Stop":
        state = "idle"
    invocation.return_value(None)


def acquired(conn, name):
    global connection
    connection = conn
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION.replace('</interface>',
        '<method name="TestScreenshotClipboard"/></interface>'))
    connection.register_object(OBJECT_PATH, node.interfaces[0], call, None, None)


owner = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, acquired, None, None)
loop = GLib.MainLoop()


def start_app():
    global application, Gtk, Gdk
    socket = Path(os.environ["XDG_RUNTIME_DIR"]) / os.environ["WAYLAND_DISPLAY"]
    if not socket.exists():
        return GLib.SOURCE_CONTINUE
    from gi.repository import Gdk, Gtk
    application = Gtk.Application(application_id="io.github.diktate.Smoke")

    def activate(app):
        global buffer
        window = Gtk.ApplicationWindow(application=app, title="Diktate smoke test", default_width=700, default_height=340)
        view = Gtk.TextView(top_margin=28, left_margin=28, right_margin=28, bottom_margin=28)
        buffer = view.get_buffer()
        controller = Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        def pressed(_controller, keyval, _keycode, _modifiers):
            global enter_count
            if keyval != Gdk.KEY_Return:
                return False
            enter_count += 1
            start, end = buffer.get_bounds()
            submitted = buffer.get_text(start, end, True)
            def read(clipboard, result):
                (artifacts / "submitted.json").write_text(json.dumps({"text": submitted,
                    "clipboard": clipboard.read_text_finish(result), "enters": enter_count}))
            Gdk.Display.get_default().get_clipboard().read_text_async(None, read)
            return True
        controller.connect('key-pressed', pressed)
        view.add_controller(controller)
        window.set_child(view)
        window.present()
        view.grab_focus()

    application.connect("activate", activate)
    application.register(None)
    application.activate()
    GLib.timeout_add(100, check)
    return GLib.SOURCE_REMOVE


def check():
    global clipboard_text
    expected = "Hallo Welt. Noch ein Satz."
    start, end = buffer.get_bounds()
    text = buffer.get_text(start, end, True)
    (artifacts / "client-state.json").write_text(json.dumps({"text": text, "toggles": toggle_count}))
    if text != expected:
        return GLib.SOURCE_CONTINUE

    def read(clipboard, result):
        global clipboard_text
        try:
            clipboard_text = clipboard.read_text_finish(result)
        except GLib.Error:
            # An image-only screenshot may replace the previous dictation.
            return
        if clipboard_text == expected:
            (artifacts / "client.json").write_text(json.dumps({"text": text, "clipboard": clipboard_text, "toggles": toggle_count}))

    Gdk.Display.get_default().get_clipboard().read_text_async(None, read)
    return GLib.SOURCE_CONTINUE


GLib.timeout_add(100, start_app)
GLib.timeout_add_seconds(45, lambda: loop.quit() or GLib.SOURCE_REMOVE)
loop.run()
Gio.bus_unown_name(owner)
