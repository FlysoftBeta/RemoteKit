#!/usr/bin/env python3
"""Exercise desired convergence, RPC replay and event retirement against the real Browser."""
import argparse
import http.server
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid
from cluster_bridge import endpoint_command, SessionDriver

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path, default=ROOT/"build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--browser", type=Path, default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT/"develop/tmp/service-smoke")
    parser.add_argument("--tenants", type=int, default=1)
    parser.add_argument("--recovery", action="store_true")
    parser.add_argument("--snapshot-lifecycle", action="store_true")
    parser.add_argument("--device-info", action="store_true")
    args = parser.parse_args()
    run = args.work_dir.resolve()/uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_):
            pass
        def do_GET(self):
            body = b"""<!doctype html><script>
              localStorage.visits=String(Number(localStorage.visits||0)+1);
              const report=()=>document.title=JSON.stringify({visits:localStorage.visits,width:innerWidth,height:innerHeight,
                dpr:devicePixelRatio,mobile:navigator.userAgentData?.mobile,platform:navigator.platform});
              report();addEventListener('resize',report);
              </script>"""
            self.send_response(200)
            self.send_header("Content-Type","text/html")
            self.end_headers()
            self.wfile.write(body)
    fixture = http.server.ThreadingHTTPServer(("127.0.0.1",0),Fixture)
    threading.Thread(target=fixture.serve_forever,daemon=True).start()
    origin = "http://127.0.0.1:"+str(fixture.server_port)
    with (run/"stderr.log").open("wb") as log:
        root = run/"state"
        child = subprocess.Popen(endpoint_command(args.endpoint,args.browser,root),
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        driver = SessionDriver(child,root)
        try:
            for index in range(args.tenants):
                tenant = "service-"+str(index)
                driver.publish(tenant,run="stopped",commit=None)
                driver.wait(lambda value:value["converged"] and value["browser"]=="stopped",tenant)
                invalid = driver.document(tenant)
                invalid.update(run="running",commit="invalid",revision=str(int(invalid["revision"])+1))
                rejected = driver.send(invalid,ok=False)
                assert rejected["error"]["code"]=="invalid_request", rejected
                driver.publish(tenant,run="running",commit=None)
                driver.wait(lambda value:value["converged"] and value["browser"]=="running",tenant)
                state = driver.view(tenant,viewId="1",url=origin+"/initial",width=640,height=480,visible=True)
                instance = state["views"][0]["instance"]
                driver.send(driver.document(tenant))
                driver.wait(lambda value:value["views"][0]["instance"]==instance,tenant)
                ready = driver.wait(lambda value:value["views"] and value["views"][0].get("title","").startswith("{") and not value["views"][0].get("loading"),tenant)
                report = json.loads(ready["views"][0]["title"])
                assert report["visits"]=="1" and report["dpr"]==1 and report["mobile"] is False,report
                operation = dict(viewId="1",url=origin+"/navigate",browserIncarnation=ready["browserIncarnation"],
                    operationId=str(uuid.uuid4()),operationGeneration=str(uuid.uuid4()),operationSequence="1")
                op_id = str(uuid.uuid4())
                result = driver.rpc("view.navigate",tenant,op_id=op_id,**operation)
                assert driver.rpc("view.navigate",tenant,op_id=op_id,replay=True,**operation)==result
                conflict = driver.rpc("view.navigate",tenant,op_id=op_id,ok=False,**dict(operation,url=origin+"/conflict"))
                assert conflict["error"]["code"]=="conflict",conflict
                unknown = driver.rpc("view.navigate",tenant,op_id="not-retained",replay=True,ok=False,**operation)
                assert unknown["error"]["code"]=="outcome_unknown",unknown
                driver.wait(lambda value:value["views"] and '"visits":"2"' in value["views"][0].get("title",""),tenant)
                if args.recovery:
                    pid = driver.observe(tenant)["browserPid"]
                    subprocess.run(["taskkill","/PID",str(pid),"/F"],check=True,capture_output=True)
                    recovered = driver.wait(lambda value:value["browserPid"] not in (0,pid) and len(value["views"])==1 and not value["recovery"]["pending"],tenant)
                    assert recovered["browserIncarnation"] != ready["browserIncarnation"]
                    stale = driver.rpc("view.navigate",tenant,op_id=op_id,replay=True,ok=False,**operation)
                    assert stale["error"]["code"]=="conflict",stale
                if args.snapshot_lifecycle:
                    driver.publish(tenant,run="stopped",commit=None)
                    stopped = driver.wait(lambda value:value["converged"] and value["browser"]=="stopped",tenant)
                    for _ in range(3):
                        assert driver.observe(tenant)["browserPid"]==0
                    driver.publish(tenant,run="running",commit=None)
                    driver.wait(lambda value:value["converged"] and value["browser"]=="running" and len(value["views"])==1,tenant)
                driver.rpc("view.close",tenant,viewId="1",force=True)
                driver.wait(lambda value:len(value["views"])==0 and any(event["tenantId"]==tenant and event["type"]=="view.closed" for event in driver.events),tenant)
                event = next(event for event in driver.events if event["tenantId"]==tenant and event["type"]=="view.closed")
                driver.publish(tenant,quality=dict(effectiveDpr=1))
                driver.wait(lambda value:value["converged"] and value["views"]==[],tenant)
                driver.acknowledge(event)
                driver.publish(tenant,views=[])
                driver.wait(lambda value:int(value["events"]["ackedThrough"]) >= int(event["seq"]),tenant)
                committed = driver.commit("service-finished-"+str(index),tenant)
                assert committed["data"]["committed"]["requestId"]=="service-finished-"+str(index)
            driver.rpc("shutdown",tenant="")
            child.wait(timeout=70)
            assert child.returncode==0,child.returncode
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            fixture.shutdown()
            (run/"evidence.json").write_text(json.dumps(driver.evidence,indent=2),encoding="utf-8")
    print(json.dumps(dict(evidence=str(run))))


if __name__ == "__main__":
    main()
