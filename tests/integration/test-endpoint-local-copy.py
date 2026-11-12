"""Hard Endpoint restarts preserve dirty and never-committed Browser Profiles."""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

from cluster_bridge import endpoint_command

ROOT = Path(__file__).resolve().parents[2]


def wait_for(read, label):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Timed out: " + label)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path,
                        default=ROOT / "build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--browser", type=Path,
                        default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT / "develop/tmp/endpoint-local-copy")
    args = parser.parse_args()
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    control_key = base64.b64encode(os.urandom(32)).decode()
    expected = ""
    writing = True
    evidence = []

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            script = ""
            if writing:
                script = f"localStorage.setItem('state', {json.dumps(expected)});"
            script += "document.title = localStorage.getItem('state') || 'missing';"
            body = ("<!doctype html><script>" + script + "</script>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{fixture.server_port}/"

    class Endpoint:
        def __init__(self, root, incarnation, session_id):
            self.root = root
            self.session_id = session_id
            self.serial = 0
            self.log = (run / f"{root.name}-{incarnation}.log").open("wb")
            self.child = subprocess.Popen(
                endpoint_command(args.endpoint, args.browser, root,
                                 control_private_key=control_key,
                                 object_index=run / "objects.json"),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                creationflags=subprocess.CREATE_NO_WINDOW)
            self.replies = queue.Queue()

            def read():
                for line in self.child.stdout:
                    self.replies.put(json.loads(line))

            threading.Thread(target=read, daemon=True).start()

        def call(self, method, **fields):
            self.serial += 1
            request = dict(id=str(self.serial), method=method, tenantId="local-copy", **fields)
            self.child.stdin.write((json.dumps(request) + "\n").encode())
            self.child.stdin.flush()
            reply = self.replies.get(timeout=100)
            evidence.append(dict(request=request, response=reply))
            assert reply.get("id") == str(self.serial) and reply.get("ok"), reply
            return reply["result"]

        def open(self, checkpoint):
            self.call("session.open", sessionId=self.session_id, placementEpoch=1,
                      checkpoint=checkpoint, profileKey=base64.b64encode(bytes([7]) * 32).decode())

        def state(self):
            snapshot = self.call("session.snapshot")
            return next((view for view in snapshot["views"]
                         if view.get("title") == expected and not view.get("pending")
                         and not view.get("loading")), None)

        def hard_kill(self):
            pid = int((self.root / "endpoint.pid").read_text())
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=True, capture_output=True)
            self.child.wait(timeout=20)
            self.log.close()

        def close(self):
            if self.child.poll() is None:
                self.call("shutdown")
                self.child.wait(timeout=70)
                assert self.child.returncode == 0
            self.log.close()

    endpoints = []
    try:
        for committed in (False, True):
            session_id = uuid.uuid4().hex
            root = run / ("committed" if committed else "never-committed")
            endpoint = Endpoint(root, "first", session_id)
            endpoints.append(endpoint)
            endpoint.open(None)
            expected = uuid.uuid4().hex
            writing = True
            endpoint.call("view.ensure", viewId="1", url=origin + "initial", width=640,
                          height=480, visible=False, device={"deviceScaleFactor": 1})
            wait_for(endpoint.state, "initial Browser write")
            checkpoint = None
            if committed:
                checkpoint = endpoint.call("session.stop", placementEpoch=1, commit="baseline")["base"]
                endpoint.open(checkpoint)
                expected = uuid.uuid4().hex
                endpoint.call("view.ensure", viewId="1", url=origin + "dirty", width=640,
                              height=480, visible=False, device={"deviceScaleFactor": 1})
                wait_for(endpoint.state, "post-checkpoint Browser write")
            # Let Chromium flush its localStorage backing store, then kill the Endpoint itself.
            time.sleep(10)
            copy_path = root / "data/sessions" / (session_id + ".copy.json")
            before = json.loads(copy_path.read_text())
            assert before["state"] == "dirty" and before["stoppedCleanly"] is False
            profile = root / "data/sessions" / session_id
            local_db = next(profile.rglob("Local Storage/leveldb/CURRENT"))
            wait_for(lambda: any(path.stat().st_size > 0 for path in local_db.parent.glob("*.log")),
                     "localStorage writes reach LevelDB")
            identity = local_db.stat().st_ino
            endpoint.hard_kill()
            writing = False
            restarted = Endpoint(root, "restart", session_id)
            endpoints.append(restarted)
            restarted.open(checkpoint)
            assert local_db.stat().st_ino == identity, "restore replaced the local Profile"
            restarted.call("view.ensure", viewId="1", url=origin + "read", width=640,
                           height=480, visible=False, device={"deviceScaleFactor": 1})
            wait_for(restarted.state, "dirty Profile survives hard Endpoint restart")
            restarted.close()
            report = json.loads((root / "copy-report.json").read_text())
            assert report["sessions"][0]["copy"]["state"] == "dirty"
        print(json.dumps(dict(localCopyReused=True, evidence=str(run))))
    finally:
        (run / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        for endpoint in reversed(endpoints):
            endpoint.close()
        fixture.shutdown()
        fixture.server_close()


if __name__ == "__main__":
    main()
