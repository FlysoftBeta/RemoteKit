"""Import storage through Endpoint and read it from a real Browser page."""

import argparse
import http.server
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

from cluster_bridge import endpoint_command

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path,
                        default=ROOT / "build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--browser", type=Path,
                        default=Path("C:/src/chromium/src/out/dev/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT / "develop/tmp/session-import")
    args = parser.parse_args()
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    evidence = []
    values = [["ascii", "value"], ["caf\u00e9", "\u00ff"],
              ["\u4e2d\u6587", "\u6c49\u5b57\U0001f680"], ["", ""], ["nul", "a\0b"]]

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            body = ("<!doctype html><script>document.title=JSON.stringify({"
                    "cookie:document.cookie,storage:Object.entries(localStorage),"
                    "ua:navigator.userAgent});</script>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    replies = queue.Queue()
    serial = 0
    with (run / "endpoint.log").open("wb") as log:
        child = subprocess.Popen(
            endpoint_command(args.endpoint, args.browser, run / "state"),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)

        def read():
            for line in child.stdout:
                replies.put(json.loads(line))

        threading.Thread(target=read, daemon=True).start()

        def call(method, error=None, **fields):
            nonlocal serial
            serial += 1
            request = {"id": str(serial), "method": method, "tenantId": "import-test", **fields}
            child.stdin.write((json.dumps(request) + "\n").encode())
            child.stdin.flush()
            reply = replies.get(timeout=40)
            evidence.append({"request": request, "response": reply})
            assert reply["id"] == str(serial), reply
            if error:
                assert not reply["ok"] and reply["error"]["code"] == error, reply
                return reply["error"]
            assert reply["ok"], reply
            return reply["result"]

        def cookie(name="imported", **fields):
            return {"name": name, "value": "yes", "domain": "127.0.0.1", "path": "/",
                    "hostOnly": True, "secure": False, "httpOnly": False,
                    "sameSite": "lax", "expires": None, **fields}

        def finish(job):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status = call("session.storage.importStatus", job=job["job"],
                              browserIncarnation=job["browserIncarnation"])
                assert status["accepted"], status
                if status["state"] == "done":
                    return status
                assert status["state"] == "pending", status
                time.sleep(0.05)
            raise AssertionError("import did not finish")

        try:
            call("session.storage.importStatus", error="conflict", job="1",
                 browserIncarnation="stale")
            identity = call("session.identity")
            assert identity["accepted"] and identity["userAgent"], identity
            assert set(identity["metadata"]) == {
                "brands", "fullVersionList", "platform", "platformVersion", "architecture",
                "bitness", "wow64", "model", "mobile"}, identity
            for invalid in [
                {"cookies": [cookie("must_not_apply")],
                 "localStorage": [{"origin": origin + "/path", "items": values}]},
                {"cookies": [cookie("must_not_apply")],
                 "localStorage": [{"origin": "file:///tmp", "items": values}]},
                {"cookies": [{}] * 4097, "localStorage": []},
                {"cookies": [cookie(value="x" * 4097)], "localStorage": []},
                {"cookies": [cookie(sameSite="invalid")], "localStorage": []},
                {"cookies": [cookie(expires="tomorrow")], "localStorage": []},
                {"cookies": [], "localStorage": [{"origin": origin, "items": []}] * 257},
                {"cookies": [cookie("must_not_apply")], "localStorage": [
                    {"origin": origin, "items": [["key", "x" * (256 * 1024)]]}]},
                {"cookies": [], "localStorage": [{"origin": origin, "items": [["key", 1]]}]},
            ]:
                call("session.storage.import", error="invalid_request", **invalid)
            job = call("session.storage.import", cookies=[
                cookie(), cookie("http_only", httpOnly=True),
                cookie("persistent", expires=int(time.time() * 1000) + 3600000),
                cookie("__Secure-invalid")], localStorage=[{"origin": origin, "items": values}])
            assert job["accepted"] and job["job"].isdecimal(), job
            result = finish(job)
            assert result["cookies"] == {"applied": 3, "rejected": 1}, result
            assert result["localStorage"] == {"applied": len(values), "rejected": 0}, result
            call("session.storage.importStatus", error="conflict", job=job["job"],
                 browserIncarnation=job["browserIncarnation"])
            call("session.storage.importStatus", error="conflict", job="999999",
                 browserIncarnation=job["browserIncarnation"])
            stale = call("session.storage.importStatus", error="conflict", job="1",
                         browserIncarnation="stale")
            assert stale["message"] == "stale_browser_incarnation", stale
            call("view.ensure", viewId="1", url=origin, width=640, height=480,
                 visible=False, device={"deviceScaleFactor": 1})
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                snapshot = call("session.snapshot")
                view = snapshot["views"][0]
                if view.get("title", "").startswith("{") and not view.get("loading"):
                    observed = json.loads(view["title"])
                    break
                time.sleep(0.05)
            else:
                raise AssertionError("page did not report imported storage")
            assert dict(observed["storage"]) == dict(values), observed
            assert set(observed["cookie"].split("; ")) == {"imported=yes", "persistent=yes"}, observed
            assert observed["ua"] == identity["userAgent"], observed
            jobs = [call("session.storage.import", cookies=[], localStorage=[]) for _ in range(16)]
            call("session.storage.import", error="limit_exceeded", cookies=[], localStorage=[])
            for empty in jobs:
                result = finish(empty)
                assert result["cookies"] == result["localStorage"] == {"applied": 0, "rejected": 0}
            call("shutdown")
            child.wait(timeout=20)
            assert child.returncode == 0, child.returncode
        finally:
            if child.poll() is None:
                child.stdin.close()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            server.shutdown()
            (run / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(f"Session import readback and lifecycle verified; evidence: {run}")


if __name__ == "__main__":
    main()
