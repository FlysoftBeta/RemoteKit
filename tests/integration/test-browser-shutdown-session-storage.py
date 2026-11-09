"""Drive two production Browsers through the SDK; keep evidence in develop/tmp."""

import argparse
import base64
import ctypes as c
from contextlib import closing
import http.server
import json
import msvcrt
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]


def wait_for(read, label, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Timed out: " + label)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path,
                        default=Path("C:/src/chromium/src/out/dev/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path,
                        default=ROOT / "develop/tmp/browser-shutdown-session-storage")
    args = parser.parse_args()
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    browser_path = args.browser.resolve()
    transcript = []
    seed = uuid.uuid4().hex
    writing = True
    key = os.urandom(32)
    unload_hits = []

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/unload-fired":
                unload_hits.append(self.path)
                self.send_response(204)
                self.end_headers()
                return
            if self.path == "/favicon.ico":
                self.send_error(404)
                return
            script = ""
            if writing:
                script = f"""
                sessionStorage.setItem('value', {json.dumps(seed + ':')} + location.pathname);
                localStorage.setItem('value', {json.dumps(seed)});
                document.cookie = 'rk_shutdown={seed}; Path=/; Max-Age=3600; SameSite=Lax';
                """
            body = f"""<!doctype html><script>
                {script}
                window.onbeforeunload = () => 'Leave?';
                window.onunload = () => fetch('/unload-fired', {{keepalive:true}});
                document.title = JSON.stringify({{
                    session: sessionStorage.getItem('value'),
                    local: localStorage.getItem('value'), cookie: document.cookie
                }});
                </script>""".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    dll_directory = os.add_dll_directory(str(browser_path.parent))
    sdk = c.CDLL(str(browser_path.parent / "remotekit_sdk.dll"))
    sdk.remotekit_sdk_control_connect.argtypes = [c.c_char_p, c.POINTER(c.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [
        c.c_uint64, c.c_void_p, c.c_size_t, c.c_void_p,
        c.c_size_t, c.POINTER(c.c_size_t), c.c_uint32,
    ]
    sdk.remotekit_sdk_control_close.argtypes = [c.c_uint64]
    assert sdk.remotekit_sdk_initialize() == 0

    class Browser:
        def __init__(self, tag):
            self.tag = tag
            self.handle = c.c_uint64()
            self.process = None
            self.log = (run / (tag + ".log")).open("wb")
            channel = "RemoteKit.shutdownProbe." + uuid.uuid4().hex
            reader, writer = os.pipe()
            try:
                os.write(writer, key)
                os.close(writer)
                writer = None
                native_reader = msvcrt.get_osfhandle(reader)
                os.set_handle_inheritable(native_reader, True)
                startup = subprocess.STARTUPINFO()
                startup.lpAttributeList = {"handle_list": [native_reader]}
                self.process = subprocess.Popen([
                    str(browser_path), "--control-channel=" + channel,
                    "--session-id=1", "--tenant-id=shutdown-probe",
                    "--data-path=" + str(run / "data"),
                    "--profile-key-handle=" + str(native_reader),
                    "--remotekit-render-host=offscreen",
                    "--log-file=" + str(run / (tag + "-browser.log")),
                ], stdout=self.log, stderr=self.log, startupinfo=startup,
                    creationflags=subprocess.CREATE_NO_WINDOW)
            finally:
                os.close(reader)
                if writer is not None:
                    os.close(writer)
            wait_for(lambda: self.connect(channel), tag + " control")

        def connect(self, channel):
            assert self.process.poll() is None, (self.tag, self.process.returncode)
            return sdk.remotekit_sdk_control_connect(channel.encode(), c.byref(self.handle)) == 0

        def rpc(self, method, ok=True, **fields):
            request = dict(version=1, id=len(transcript) + 1, method=method, session="1", **fields)
            data = json.dumps(request).encode()
            output = c.create_string_buffer(1024 * 1024)
            size = c.c_size_t()
            status = sdk.remotekit_sdk_control_request(
                self.handle, data, len(data), output, len(output), c.byref(size), 10000)
            assert status == 0, (self.tag, method, status)
            response = json.loads(output.raw[:size.value])
            transcript.append(dict(browser=self.tag, request=request, response=response))
            assert response["ok"] is ok, response
            return response

        def view(self, view):
            return next(item for item in self.rpc("snapshot")["sessions"][0]["views"]
                        if item["view"] == view)

        def ready(self, view):
            def read():
                item = self.view(view)
                if (item["actual"] != 0 or item["pending"] or item.get("loading")
                        or not item.get("title", "").startswith("{")):
                    return None
                return json.loads(item["title"])
            return wait_for(read, self.tag + " view " + view)

        def create(self, view, path):
            self.rpc("view.create", view=view, url=origin + path, width=320,
                     height=240, device="desktop", visible=False)
            return self.ready(view)

        def unload(self, view):
            self.rpc("lifecycle", view=view, action="unload")
            wait_for(lambda: self.view(view)["actual"] == 3, "unload " + view)

        def export(self, view):
            begin = self.rpc("navigation.export.begin", view=view)
            data = bytearray()
            while len(data) < int(begin["size"]):
                chunk = self.rpc("navigation.export.chunk", view=view, transfer=begin["transfer"],
                                 offset=str(len(data)), length=256 * 1024)
                data.extend(base64.b64decode(chunk["data"]))
            self.rpc("navigation.transfer.cancel", view=view, transfer=begin["transfer"])
            return data

        def import_state(self, view, data, ok=True):
            begin = self.rpc("navigation.import.begin", view=view, size=str(len(data)))
            for offset in range(0, len(data), 256 * 1024):
                self.rpc("navigation.import.chunk", view=view, transfer=begin["transfer"],
                         offset=str(offset),
                         data=base64.b64encode(data[offset:offset + 256 * 1024]).decode())
            result = self.rpc("navigation.import.commit", view=view, transfer=begin["transfer"], ok=ok)
            if not ok:
                self.rpc("navigation.transfer.cancel", view=view, transfer=begin["transfer"])
            return result

        def shutdown(self):
            assert self.rpc("browser.shutdown")["accepted"]
            self.process.wait(timeout=20)
            assert self.process.returncode == 0, (self.tag, self.process.returncode)

        def close(self):
            if self.handle.value:
                sdk.remotekit_sdk_control_close(self.handle)
                self.handle.value = 0
            if self.process and self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.log.close()

    active = []
    try:
        first = Browser("first")
        active.append(first)
        saved = {}
        for view in ("1", "2", "3", "4"):
            assert first.create(view, "/view-" + view)["session"] == seed + ":/view-" + view
            if view == "2":
                first.unload(view)
            saved[view] = first.export(view)
            (run / ("view-" + view + ".bin")).write_bytes(saved[view])
        first.rpc("view.close", view="3", force=True)
        # The non-forced path closes naturally through WebContentsDelegate.
        first.rpc("view.close", view="4")
        wait_for(lambda: first.view("4").get("close_state") == "closed", "natural close")
        wait_for(lambda: len(unload_hits) == 1, "natural unload event")
        first.shutdown()
        assert len(unload_hits) == 1, unload_hits
        first.close()
        database = run / "data/session-1/profile-1/Network/Cookies"
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
            cookie = connection.execute(
                "SELECT value, encrypted_value FROM cookies WHERE name='rk_shutdown'").fetchone()
        assert cookie and cookie[0] == "" and bytes(cookie[1]).startswith(b"rk1"), cookie
        writing = False

        second = Browser("second")
        active.append(second)
        for view in saved:
            observed = second.create(view, "/blank-" + view)
            assert observed["session"] is None
            assert observed["local"] == seed and "rk_shutdown=" + seed in observed["cookie"]
            second.unload(view)
            if view == "1":
                old = bytearray(saved[view])
                magic_length = struct.unpack_from("<I", old, 4)[0]
                struct.pack_into("<i", old, 8 + ((magic_length + 3) & ~3), 1)
                assert second.import_state(view, old, ok=False)["error"]["code"] == "invalid_request"
            second.import_state(view, saved[view])
        second.rpc("storage.scavenge")
        for view in saved:
            second.rpc("lifecycle", view=view, action="restore")
            observed = second.ready(view)
            expected = seed + ":/view-" + view if view in ("1", "2") else None
            assert observed["session"] == expected, (view, observed)
            assert observed["local"] == seed and "rk_shutdown=" + seed in observed["cookie"]
        second.shutdown()
        assert len(unload_hits) == 1, unload_hits
        second.close()
        print("Browser shutdown, encrypted cookie flush, and persisted namespace restore verified:", run)
    finally:
        for browser in active:
            browser.close()
        server.shutdown()
        server.server_close()
        (run / "control.json").write_text(json.dumps(transcript, indent=2), encoding="utf-8")
        assert sdk.remotekit_sdk_shutdown() == 0
        dll_directory.close()


if __name__ == "__main__":
    main()
