"""Elevated VSS crash recovery with real Profile writes and Control version selection."""

import argparse
import base64
import concurrent.futures
import ctypes
import hashlib
import http.server
import json
import os
from pathlib import Path
import random
import socket
import sqlite3
import struct
import subprocess
import threading
import time
import uuid

from cluster_bridge import endpoint_command, SessionDriver

ROOT = Path(__file__).resolve().parents[2]


def wait_for(read, label, timeout=150):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("Timed out: " + label)


def peer_address():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return "127.0.0.1:" + str(listener.getsockname()[1])


def pipe_checks(node_id, root):
    name = "\\\\.\\pipe\\remotekit-snapshot-" + node_id

    def connect():
        try:
            return open(name, "r+b", buffering=0)
        except OSError:
            return None

    def receive(pipe):
        def read(size):
            result = b""
            while len(result) < size:
                part = pipe.read(size - len(result))
                assert part, "snapshot pipe disconnected"
                result += part
            return result
        size = struct.unpack("<I", read(4))[0]
        return read(size)

    def request(pipe, method, **fields):
        body = json.dumps(dict(method=method, **fields)).encode()
        pipe.write(struct.pack("<I", len(body)) + body)
        return json.loads(receive(pipe))

    pipe = wait_for(connect, "snapshot pipe")
    try:
        for path in ("../escape", "C:/Windows", "/absolute", "file:stream"):
            reply = request(pipe, "snapshot.take", root=str(root), paths=[path])
            assert reply["error"]["code"] == "invalid_request", reply
        reply = request(pipe, "snapshot.take", root=str(root.parent), paths=["file"])
        assert reply["error"]["code"] == "invalid_request", reply
        outside = root.parent / "outside"
        outside.mkdir()
        (outside / "secret").write_text("outside")
        os.symlink(outside, root / "reparse", target_is_directory=True)
        reply = request(pipe, "snapshot.take", root=str(root), paths=["reparse/secret"])
        assert reply["error"]["code"] == "invalid_request", reply
        (root / "reparse").unlink()
    finally:
        pipe.close()
    (root / "snapshot-probe").write_bytes(b"point-in-time")
    barrier = threading.Barrier(2)

    def take():
        client = wait_for(connect, "concurrent snapshot pipe")
        barrier.wait(timeout=10)
        reply = request(client, "snapshot.take", root=str(root), paths=["snapshot-probe"])
        assert reply["ok"], reply
        return client, reply["result"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(take) for _ in range(2)]
        leases = [future.result(timeout=120) for future in futures]
    try:
        assert leases[0][1]["takenAt"] == leases[1][1]["takenAt"], leases
        assert leases[0][1]["snapshotId"] != leases[1][1]["snapshotId"]
        (root / "snapshot-probe").write_bytes(b"new live data")
        for client, snapshot in leases:
            reply = request(client, "snapshot.read", snapshotId=snapshot["snapshotId"],
                            path="snapshot-probe", offset=0, length=1024)
            assert reply["ok"]
            assert receive(client) == b"point-in-time"
            reply = request(client, "snapshot.read", snapshotId=snapshot["snapshotId"],
                            path="not-selected", offset=0, length=1)
            assert reply["error"]["code"] == "invalid_request"
            assert request(client, "snapshot.release", snapshotId=snapshot["snapshotId"])["ok"]
    finally:
        for client, _ in leases:
            client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path, default=ROOT / "build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--snapshot", type=Path, default=ROOT / "build/endpoint/endpoint/remotekit_snapshot.exe")
    parser.add_argument("--browser", type=Path, default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT / "develop/tmp/endpoint-versions")
    args = parser.parse_args()
    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError("VSS integration requires elevation; run this script with sudo")
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    control_key = base64.b64encode(os.urandom(32)).decode()
    session = uuid.uuid4().hex
    tenant = "versions"
    latest_written = 0
    writing = True

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            nonlocal latest_written
            if self.path.startswith("/written/"):
                latest_written = max(latest_written, int(self.path.split("/")[-1]))
                self.send_response(204)
                self.end_headers()
                return
            if self.path == "/favicon.ico":
                self.send_error(404)
                return
            script = """
              const opening = indexedDB.open('versions', 1);
              opening.onupgradeneeded = () => opening.result.createObjectStore('counter');
              opening.onsuccess = () => {
                const db = opening.result;
                const report = () => {
                  const tx = db.transaction('counter', 'readonly');
                  const get = tx.objectStore('counter').get('value');
                  get.onsuccess = () => document.title = JSON.stringify({
                    idb: get.result || 0, local: Number(localStorage.getItem('counter') || 0),
                    cookie: Number(document.cookie.match(/counter=(\d+)/)?.[1] || 0)
                  });
                };
                report();
            """
            if writing:
                script += """
                  let busy = false;
                  setInterval(() => {
                    if (busy) return;
                    busy = true;
                    const value = Number(localStorage.getItem('counter') || 0) + 1;
                    const tx = db.transaction('counter', 'readwrite', {durability:'strict'});
                    tx.objectStore('counter').put(value, 'value');
                    tx.oncomplete = () => {
                      localStorage.setItem('counter', String(value));
                      document.cookie = `counter=${value}; Max-Age=3600; Path=/; SameSite=Lax`;
                      fetch('/written/' + value);
                      busy = false;
                      report();
                    };
                  }, 50);
                """
            script += "};"
            body = ("<!doctype html><script>" + script + "</script>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}/"
    index_file = run / "objects.json"
    nodes = []
    snapshots = []
    results = []

    class Endpoint:
        def __init__(self, tag, versions=False):
            self.root = run / tag
            self.log = (run / (tag + ".log")).open("wb")
            environment = dict(os.environ)
            if versions:
                environment.update(REMOTEKIT_TEST_VERSION_INTERVAL_MS="3000", REMOTEKIT_TEST_VERSION_CHECK_MS="1000")
            address = peer_address()
            self.child = subprocess.Popen(endpoint_command(
                args.endpoint, args.browser, self.root, control_private_key=control_key,
                object_index=index_file, peer={"listen": address, "address": address}),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW)
            nodes.append(self)
            self.driver = SessionDriver(self.child, self.root, tenant)

        def open(self, epoch, checkpoint):
            self.driver.publish(sessionId=session, placementEpoch=epoch, run="running", commit=None, checkpoint=checkpoint)
            self.driver.wait(
                lambda value: value["browser"] == "running" and value["converged"],
                timeout=180,
            )
            self.driver.view(viewId="1", url=origin, width=640, height=480, visible=True)

        def state(self):
            for view in self.driver.observe()["views"]:
                try:
                    state = json.loads(view.get("title", ""))
                    if set(state) == {"idb", "local", "cookie"}:
                        return state
                except (ValueError, TypeError):
                    pass
            return None

        def objects(self):
            result = set()
            cursor = None
            while True:
                page = self.driver.rpc("object.inventory", "", cursor=cursor)
                result.update(item["id"] for item in page["objects"])
                cursor = page["next"]
                if cursor is None:
                    return result

        def replicate(self, ids):
            index = json.loads(index_file.read_text())
            for offset in range(0, len(ids), 128):
                batch = ids[offset:offset + 128]
                sources = {id: index[tenant + "/" + id]["sources"] for id in batch}
                self.driver.rpc("object.fetch", "", ids=batch, sources=sources)

        def kill(self):
            if self.child.poll() is None:
                pid = int((self.root / "endpoint.pid").read_text())
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=True, capture_output=True)
                self.child.wait(timeout=30)

        def close(self):
            if self.child.poll() is None:
                self.driver.rpc("shutdown", "")
                self.child.wait(timeout=60)
            self.log.close()

    def integrity(directory):
        checked = []
        for path in directory.rglob("*"):
            if not path.is_file() or path.name.endswith(("-wal", "-shm", "-journal")):
                continue
            with path.open("rb") as content:
                if content.read(16) != b"SQLite format 3\0":
                    continue
            connection = sqlite3.connect(str(path))
            try:
                assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)], path
                checked.append(str(path.relative_to(directory)))
            finally:
                connection.close()
        assert "session.db" in checked, checked
        assert any("profile" in name.lower() for name in checked), checked
        return checked

    def select(versions, available):
        reply = subprocess.run(["node", "--import", "tsx", str(ROOT / "tests/integration/select-complete-version.mts")],
            input=json.dumps(dict(versions=versions, available=sorted(available))), text=True,
            cwd=ROOT / "control", capture_output=True, check=True)
        return json.loads(reply.stdout)

    try:
        for scenario in ("kill", "missing"):
            writing = True
            source = Endpoint(scenario + "-source", versions=True)
            identity = json.loads((source.root / "node.json").read_text())
            snapshot_log = (run / (scenario + "-snapshot.log")).open("wb")
            shadow = subprocess.Popen([str(args.snapshot), "--data-root=" + str(source.root / "data"),
                "--node-id=" + identity["nodeId"], "--supervisor-pid=" + str(os.getpid())],
                stdout=snapshot_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
            snapshots.append((shadow, snapshot_log))
            pipe_checks(identity["nodeId"], source.root / "data")
            source.open(1, None)
            wait_for(lambda: latest_written >= 10, "continuous IndexedDB writes")
            replica = Endpoint(scenario + "-replica")
            versions = []
            for _ in range(3):
                previous = versions[-1]["manifestId"] if versions else None
                observed = source.driver.wait(lambda value: value.get("checkpoint") is not None and
                    value["checkpoint"].get("kind") == "running" and
                    value["checkpoint"]["manifestId"] != previous, timeout=90)
                checkpoint = observed["checkpoint"]
                assert observed["data"]["state"] == "dirty"
                versions.append(checkpoint)
                replica.replicate(checkpoint["objects"])
            time.sleep(random.uniform(0.1, 1.5))
            source.kill()
            writing = False
            available = replica.objects()
            if scenario == "missing":
                unique = set(versions[-1]["objects"]) - set(versions[-2]["objects"]) - {versions[-1]["manifestId"]}
                assert unique, "newest version has a changed data chunk"
                missing = random.choice(sorted(unique))
                replica.driver.rpc("object.delete", "", ids=[missing])
                available.remove(missing)
            selected = select(versions, available)
            expected = versions[-2 if scenario == "missing" else -1]
            assert selected["manifestId"] == expected["manifestId"], (selected, expected)
            states = []
            for restore in range(2):
                target = Endpoint(f"{scenario}-restore-{restore}")
                target.open(2, selected["manifestId"])
                state = wait_for(target.state, "restored Profile counter")
                assert 0 < state["idb"] <= latest_written + 1, (state, latest_written)
                assert 0 <= state["local"] <= latest_written + 1 and 0 <= state["cookie"] <= latest_written + 1
                states.append(state)
                target.driver.commit("verify-integrity")
                checked = integrity(target.root / "data/sessions" / session)
                target.close()
            assert states[0] == states[1], ("restores of the same version differ", states)
            results.append(dict(scenario=scenario, selected=selected, state=states[0], sqlite=checked))
            replica.close()
            shadow.terminate()
            shadow.wait(timeout=30)
            snapshot_log.close()
        (run / "result.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(json.dumps(dict(evidence=str(run), results=results)))
    finally:
        for node in reversed(nodes):
            if node.child.poll() is None:
                node.kill()
            node.log.close()
        for shadow, log in snapshots:
            if shadow.poll() is None:
                shadow.terminate()
                shadow.wait(timeout=30)
            log.close()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
