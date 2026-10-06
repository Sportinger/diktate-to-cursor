import signal
import logging
import threading

from gi.repository import Gio, GLib

from .config import Config
from .transcription import Session

BUS_NAME = "io.github.diktate.Cursor"
OBJECT_PATH = "/io/github/diktate/Cursor"
INTERFACE = BUS_NAME
INTROSPECTION = """
<node><interface name="io.github.diktate.Cursor">
  <method name="Toggle"/>
  <method name="Stop"/>
  <method name="GetState"><arg name="state" type="s" direction="out"/><arg name="mode" type="s" direction="out"/></method>
  <method name="GetSilence"><arg name="seconds" type="d" direction="out"/></method>
  <signal name="StateChanged"><arg type="s"/><arg type="s"/></signal>
  <signal name="Interim"><arg type="s"/></signal>
  <signal name="Final"><arg type="s"/></signal>
  <signal name="Finished"><arg type="s"/></signal>
  <signal name="Error"><arg type="s"/></signal>
  <signal name="Notice"><arg type="s"/></signal>
  <signal name="SubmitRequested"/>
  <signal name="SilenceChanged"><arg type="d"/></signal>
</interface></node>
"""


class Service:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.connection = None
        self.session = None
        self.worker = None
        self.state = "idle"
        self.mode = ""

    def emit(self, name, *args):
        def deliver():
            if name == "StateChanged":
                self.state, self.mode = args
                if self.state == "idle":
                    self.session = None
            if self.connection:
                self.connection.emit_signal(None, OBJECT_PATH, INTERFACE, name,
                                            GLib.Variant("(d)" if name == "SilenceChanged" else "(" + "s" * len(args) + ")", args))
            return GLib.SOURCE_REMOVE
        GLib.idle_add(deliver)

    def toggle(self):
        if self.state == "finishing":
            return
        if self.session:
            self.stop()
            return
        try:
            config = Config.load()
            if not config.api_key:
                self.emit("Error", "Deepgram-Schlüssel fehlt. Bitte über das Tray-Menü die Einstellungen öffnen.")
                return
        except Exception:
            self.emit("Error", "Einstellungen konnten nicht geladen werden. Bitte die Konfiguration prüfen.")
            return
        self.state = "recording"
        self.mode = "connecting"
        self.emit("StateChanged", self.state, self.mode)
        self.session = Session(config, self.emit)
        self.worker = threading.Thread(target=self.session.run, name="deepgram-recording", daemon=True)
        self.worker.start()

    def stop(self):
        if self.session and self.state != "finishing":
            self.state = "finishing"
            self.emit("StateChanged", self.state, self.mode)
            self.session.stop()

    def _call(self, connection, sender, path, interface, method, params, invocation):
        if method == "Toggle":
            self.toggle()
            invocation.return_value(None)
        elif method == "Stop":
            self.stop()
            invocation.return_value(None)
        elif method == "GetState":
            invocation.return_value(GLib.Variant("(ss)", (self.state, self.mode)))
        elif method == "GetSilence":
            silence = self.session.silence_seconds() if self.session else 0.0
            invocation.return_value(GLib.Variant("(d)", (silence,)))
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "Unbekannte Methode.")

    def _bus_acquired(self, connection, name):
        self.connection = connection
        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        connection.register_object(OBJECT_PATH, node.interfaces[0], self._call, None, None)

    def run(self):
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
        owner = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                                 self._bus_acquired, None, lambda *_: self.loop.quit())

        def shutdown(*_):
            self.stop()
            # Let final results and clipboard updates reach the Shell before exiting.
            def wait_for_worker():
                if self.worker and self.worker.is_alive():
                    return GLib.SOURCE_CONTINUE
                self.loop.quit()
                return GLib.SOURCE_REMOVE
            GLib.timeout_add(100, wait_for_worker)
            return GLib.SOURCE_REMOVE

        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, shutdown)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, shutdown)
        self.loop.run()
        Gio.bus_unown_name(owner)
