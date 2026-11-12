"""Launch the authenticated local-node bridge for JSONL integration probes."""
import json
from pathlib import Path


def endpoint_command(endpoint, browser, data_path, *, control_private_key=None, object_index=None,
                     metrics_file=None, **config):
    root = Path(data_path).resolve()
    command = [
        "node", str(Path(__file__).with_name("cluster-bridge.mjs")),
        "--endpoint=" + str(Path(endpoint).resolve()),
        "--node-root=" + str(root),
        "--config=" + json.dumps(config),
    ]
    for name, value in (
        ("control-private-key", control_private_key),
        ("browser", Path(browser).resolve()),
        ("object-index", object_index),
        ("metrics-file", metrics_file),
    ):
        if value is not None:
            command.append("--" + name + "=" + str(value))
    return command

import copy
import hashlib
import queue
import threading
import time
import uuid


class SessionDriver:
    """Control-side desired documents and observed snapshots for native probes."""

    def __init__(self, process, root, tenant="tenant"):
        self.process = process
        self.root = Path(root)
        self.tenant = tenant
        self.serial = 0
        self.ready = queue.Queue()
        self.responses = {}
        self.observations = {}
        self.events = []
        self.signals = []
        self.condition = threading.Condition()
        self.evidence = []
        self.path = self.root / "driver-desired.json"
        self.desired = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.fence_revision = 1

        def receive():
            for line in process.stdout:
                message = json.loads(line)
                with self.condition:
                    if message.get("event") == "test.ready":
                        self.ready.put(message)
                    elif message.get("event") == "session.observed":
                        self.observations[message["tenantId"]] = message
                    elif message.get("event") == "session.event":
                        if not any(event["streamId"] == message["streamId"] and event["seq"] == message["seq"] for event in self.events):
                            self.events.append(message)
                    elif message.get("event") == "rtc.signal":
                        self.signals.append(message)
                    elif "id" in message:
                        self.responses[message["id"]] = message
                    self.condition.notify_all()
        threading.Thread(target=receive, daemon=True).start()
        identity = self.ready.get(timeout=60)
        self.connection = identity["connectionEpoch"]
        self.incarnation = identity["endpointIncarnation"]
        self.placements = {value["tenantId"]: value for value in identity["placements"]}

    def send(self, request, *, ok=True, timeout=100):
        self.serial += 1
        request = dict(request, id=str(self.serial))
        started = time.monotonic()
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        self.process.stdin.flush()
        with self.condition:
            if not self.condition.wait_for(lambda: request["id"] in self.responses or self.process.poll() is not None, timeout):
                raise TimeoutError(request["method"])
            response = self.responses.pop(request["id"], None)
        self.evidence.append(dict(request=request, response=response, elapsedSeconds=time.monotonic()-started))
        if response is None or response.get("ok") is not ok:
            raise RuntimeError(response)
        return response.get("result", response)

    def document(self, tenant=None):
        tenant = tenant or self.tenant
        if tenant not in self.desired:
            self.desired[tenant] = dict(method="session.desired", connectionEpoch=self.connection, tenantId=tenant,
                sessionId=hashlib.sha256(tenant.encode()).hexdigest()[:32], placementEpoch=1, revision="0",
                run="stopped", commit=None, profileKey="BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", checkpoint=None,
                sitePreferences=dict(sites={}), mediaPolicy=dict(maxFps=60,degradationPreference="balanced",audio=False),
                quality=dict(effectiveDpr=1), clipboard=dict(revision="0",value=dict(text="",html="")), views=[],
                authorization=dict(connectionId=None,epoch=0,unlocked=False,files=dict(requests=[])),
                lock=dict(leaseId="probe",epoch=1,state="unlocked"))
        return copy.deepcopy(self.desired[tenant])

    def publish(self, tenant=None, **fields):
        tenant = tenant or self.tenant
        document = self.document(tenant)
        document.update(fields)
        document["connectionEpoch"] = self.connection
        document["revision"] = str(int(document["revision"]) + 1)
        placement = dict(tenantId=tenant,sessionId=document["sessionId"],placementEpoch=document["placementEpoch"],dataState="dirty")
        if self.placements.get(tenant) != placement:
            self.placements[tenant] = placement
            self.fence_revision += 1
            self.send(dict(method="node.desired",connectionEpoch=self.connection,revision=str(self.fence_revision),sessions=list(self.placements.values())))
        self.send(document)
        self.desired[tenant] = document
        self.path.write_text(json.dumps(self.desired),encoding="utf-8")
        return document

    def view(self, tenant=None, **configuration):
        tenant = tenant or self.tenant
        document = self.document(tenant)
        view_id = configuration["viewId"]
        current = next((value for value in document["views"] if value["viewId"] == view_id), None)
        view = dict(viewId=view_id,presence="ensure",url="about:blank",width=640,height=480,visible=False,
                    device=dict(mode="desktop",deviceScaleFactor=document["quality"]["effectiveDpr"]),occludedBottom=0,occlusionRevision="1")
        if current:
            view.update(current)
        view.update(configuration)
        view["device"] = dict(mode="desktop",deviceScaleFactor=view["device"].get("deviceScaleFactor",1))
        document["quality"]["effectiveDpr"] = view["device"]["deviceScaleFactor"]
        views = [value for value in document["views"] if value["viewId"] != view_id] + [view]
        for value in views:
            value["device"] = dict(view["device"])
        published = self.publish(tenant,views=views,quality=document["quality"])
        return self.wait(lambda value: int(value["applied"]["viewsRevision"]) >= int(published["revision"]) and any(item["viewId"] == view_id for item in value["views"]),tenant)

    def observe(self, tenant=None):
        return self.send(dict(method="test.observe",tenantId=tenant or self.tenant))

    def wait(self, predicate, tenant=None, timeout=60):
        tenant = tenant or self.tenant
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            with self.condition:
                value = self.observations.get(tenant)
                if value is not None and predicate(value):
                    return copy.deepcopy(value)
                self.condition.wait(timeout=0.1)
        raise AssertionError(self.observations.get(tenant))

    def rpc(self, method, tenant=None, *, op_id=None, replay=False, ok=True, **params):
        tenant = self.tenant if tenant is None else tenant
        node = method.startswith("object.") or method in ("shutdown","node.logs.search","session.cold.delete","session.delete")
        target = self.placements.get(tenant)
        if not node and target is None:
            raise AssertionError("Publish node.desired before a Session RPC")
        if method.startswith("view.") or method.startswith("session.storage.") or method == "session.identity":
            params.setdefault("browserIncarnation",self.observations.get(tenant,{}).get("browserIncarnation"))
        return self.send(dict(method=method,tenantId=tenant,sessionId=None if node else target["sessionId"],
            placementEpoch=None if node else target["placementEpoch"],endpointIncarnation=self.incarnation,
            opId=op_id or str(uuid.uuid4()),replay=replay,params=params),ok=ok)

    def acknowledge(self, event):
        result = self.send(dict(method="session.events.ack",tenantId=event["tenantId"],sessionId=event["sessionId"],
            placementEpoch=event["placementEpoch"],connectionEpoch=self.connection,streamId=event["streamId"],upTo=event["seq"]))
        with self.condition:
            self.events = [value for value in self.events if value["streamId"] != event["streamId"] or int(value["seq"]) > int(event["seq"])]
        return result

    def commit(self, token, tenant=None):
        tenant = tenant or self.tenant
        self.publish(tenant,run="stopped",commit=token)
        observed = self.wait(lambda value:value["browser"] == "stopped" and value["data"] is not None and value["data"]["state"] == "clean",tenant,timeout=100)
        self.desired[tenant]["checkpoint"] = observed["data"]["base"]
        self.path.write_text(json.dumps(self.desired),encoding="utf-8")
        return observed
