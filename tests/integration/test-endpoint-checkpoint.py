"""Restore a real Browser checkpoint through a second Endpoint's peer object fetch."""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import threading
import time
import uuid

from cluster_bridge import endpoint_command, SessionDriver

ROOT = Path(__file__).resolve().parents[2]


def wait_for(read, label, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out: " + label)


def peer_address():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return "127.0.0.1:" + str(listener.getsockname()[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path,
                        default=ROOT / "build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--browser", type=Path,
                        default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT / "develop/tmp/endpoint-checkpoint")
    args = parser.parse_args()
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    seed = uuid.uuid4().hex
    writing = True
    evidence = []
    control_private_key = base64.b64encode(os.urandom(32)).decode()
    session_id = uuid.uuid4().hex
    tenant = "checkpoint-tenant"

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/favicon.ico":
                self.send_error(404)
                return
            if self.path == "/dialog":
                script = "alert('stop blocker'); document.title='dialog-finished';"
            else:
                script = ""
                if writing:
                    script += f"""
                        document.cookie='persistent={seed}; Max-Age=3600; Path=/; SameSite=Lax';
                        document.cookie='session={seed}; Path=/; SameSite=Lax';
                        localStorage.setItem('checkpoint', {json.dumps(seed)});
                        sessionStorage.setItem('checkpoint', {json.dumps(seed)});
                    """
                script += """
                    const report = () => document.title = JSON.stringify({
                        cookie: document.cookie,
                        local: localStorage.getItem('checkpoint'),
                        session: sessionStorage.getItem('checkpoint')
                    });
                    report(); setInterval(report, 100);
                """
            body = ("<!doctype html><script>" + script + "</script>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"

    class Endpoint:
        def __init__(self, tag):
            self.tag = tag
            self.root = run / tag
            self.log = (run / (tag + ".log")).open("wb")
            address = peer_address()
            self.child = subprocess.Popen(
                endpoint_command(args.endpoint, args.browser, self.root,
                                 control_private_key=control_private_key, object_index=run / "objects.json",
                                 metrics_file=run / (tag + "-metrics.json"),
                                 peer={"listen": address, "address": address}),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                creationflags=subprocess.CREATE_NO_WINDOW)
            self.driver = SessionDriver(self.child,self.root,tenant)

        def call(self, method, ok=True, tenant_id=tenant, **fields):
            result=self.driver.rpc(method,tenant_id,ok=ok,**fields)
            evidence.extend(self.driver.evidence)
            self.driver.evidence.clear()
            return result if ok else result["error"]

        def open(self, epoch, checkpoint):
            self.driver.publish(sessionId=session_id,placementEpoch=epoch,checkpoint=checkpoint,run="running",commit=None)
            return self.driver.wait(lambda value:value["browser"]=="running" and value["converged"])

        def state(self):
            snapshot=self.driver.observe()
            for view in snapshot["views"]:
                if view["viewId"]=="1" and not view.get("loading") and not view.get("pending"):
                    try:
                        result=json.loads(view.get("title",""))
                        if not snapshot["recovery"]["pending"]:
                            return result,snapshot
                    except ValueError:
                        pass
            return None

        def stop(self):
            self.call("shutdown")
            self.child.wait(timeout=40)
            assert self.child.returncode == 0, (self.tag, self.child.returncode)

        def close(self):
            if self.child.poll() is None:
                self.child.kill()
                self.child.wait(timeout=10)
            self.log.close()

    endpoints = []
    try:
        source = Endpoint("source-node")
        endpoints.append(source)
        source.open(1, None)
        source.driver.view( viewId="1", url=origin + "/state", width=640, height=480,
                    visible=False, device={"deviceScaleFactor": 1})
        initial, initial_snapshot = wait_for(source.state, "initial storage")
        assert initial["local"] == seed and initial["session"] == seed, initial
        assert "persistent=" + seed in initial["cookie"] and "session=" + seed in initial["cookie"]
        source.driver.view( viewId="2", url=origin + "/dialog", width=320, height=240,
                    visible=False, device={"deviceScaleFactor": 1})
        wait_for(lambda: source.driver.observe()["blockers"]["pendingPageRequests"] > 0,
                 "page request blocker")
        source.driver.publish(run="stopped",commit="checkpoint-stop")
        blocked=source.driver.wait(lambda value:value["lastError"] is not None)
        assert blocked["lastError"]["code"]=="conflict",blocked
        source.call("view.close",viewId="2",force=True)
        source.driver.wait(lambda value:any(event["type"]=="view.closed" for event in source.driver.events))
        assert source.driver.observe()["data"]["state"]=="dirty"
        for event in list(source.driver.events):
            source.driver.acknowledge(event)
        committed=source.driver.wait(lambda value:value["browser"]=="stopped" and value["data"]["state"]=="clean")
        checkpoint=dict(base=committed["data"]["base"],objects=committed["checkpoint"]["objects"])
        writing = False
        # Restoration must use peer objects; neither the profile nor its copy record is copied.
        desired_views=[view for view in source.driver.document()["views"] if view["viewId"]=="1"]
        source.driver.placements.clear()
        source.driver.fence_revision += 1
        source.driver.send(dict(method="node.desired",connectionEpoch=source.driver.connection,revision=str(source.driver.fence_revision),sessions=[]))
        shutil.rmtree(source.root / "data/sessions" / session_id)
        target = Endpoint("different-absolute-target-root")
        endpoints.append(target)
        target.driver.publish(sessionId=session_id,placementEpoch=2,checkpoint=checkpoint["base"],run="running",commit=None,views=desired_views)
        target.driver.wait(lambda value:value["browser"]=="running" and value["converged"])
        restored, snapshot = wait_for(target.state, "restored storage and navigation", timeout=60)
        assert restored == initial, dict(initial=initial, restored=restored)
        assert snapshot["browserPid"] != initial_snapshot["browserPid"]
        assert snapshot["views"][0]["url"] == origin + "/state", snapshot
        assert source.root.resolve() != target.root.resolve()
        assert not (source.root / "data/sessions" / session_id).exists()
        inventory = target.call("object.inventory", cursor=None)["objects"]
        assert set(checkpoint["objects"]).issubset({item["id"] for item in inventory})
        subprocess.run(["taskkill", "/PID", str(snapshot["browserPid"]), "/T", "/F"],
                       check=True, capture_output=True)
        target.driver.wait(lambda value:value["browserPid"] not in (0,snapshot["browserPid"]) and value["browserIncarnation"]!=snapshot["browserIncarnation"])
        wait_for(target.state,"Browser recovery after unclean exit",timeout=60)
        final=target.driver.commit("checkpoint-stop")
        # Deleting a Tenant stops its running Browser without a checkpoint and removes every local copy.
        target.open(3, final["data"]["base"])
        running = wait_for(target.state, "warm reopen before deletion", timeout=60)[1]
        assert target.call("session.delete", tenant_id="", sessionId=session_id) == {"stopped": True}
        assert target.call("session.logs.read",ok=False,log="browser",maxBytes=128)["code"]=="conflict"
        leftovers = [path.name for path in (target.root / "data/sessions").iterdir()
                     if path.name.startswith(session_id)]
        assert not leftovers, leftovers
        assert subprocess.run(["tasklist", "/FI", f"PID eq {running['browserPid']}", "/NH"],
                              capture_output=True, text=True).stdout.find(str(running["browserPid"])) < 0
        assert target.call("session.delete", tenant_id="", sessionId=session_id) == {"stopped": False}
        wait_for(lambda: (run / "source-node-metrics.json").exists(), "metrics event")
        target.stop()
        source.stop()
        print(json.dumps(dict(restored=True, checkpoint=checkpoint["base"], evidence=str(run))))
    finally:
        (run / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        for endpoint in reversed(endpoints):
            endpoint.close()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
