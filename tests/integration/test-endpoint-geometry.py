#!/usr/bin/env python3
"""Exercise desired geometry, output transactions and automatic persistence retry."""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("recovery_test",ROOT/"tests/integration/test-endpoint-recovery.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint",type=Path,default=ROOT/"build/endpoint/endpoint/endpoint_service.exe")
    parser.add_argument("--browser",type=Path,default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir",type=Path,default=ROOT/"develop/tmp/geometry-regression")
    args=parser.parse_args()
    run=args.work_dir/str(time.time_ns())
    run.mkdir(parents=True)
    service=module.Service(args,run,run/"state")
    try:
        initial,_=service.start()
        session=initial["sessionId"]
        device=dict(mode="desktop",deviceScaleFactor=1)
        first=service.view(viewId="1",url="about:blank",width=7000,height=800,visible=True,device=device)
        identity=(first["views"][0]["instance"],first["views"][0]["document"])
        portrait=service.view(viewId="1",width=800,height=7000,visible=True,device=device)
        assert (portrait["views"][0]["width"],portrait["views"][0]["height"])==(800,7000)
        landscape=service.view(viewId="1",width=7000,height=800,visible=True,device=device)
        view=landscape["views"][0]
        assert (view["width"],view["height"])==(7000,800) and identity==(view["instance"],view["document"])
        desired=service.driver.document()
        desired["views"][0].update(width=8192,height=8192)
        sent=service.driver.publish(views=desired["views"])
        failed=service.wait(lambda value:value["observedRevision"]==sent["revision"] and value["lastError"] is not None)
        assert (failed["views"][0]["width"],failed["views"][0]["height"])==(7000,800)
        database=sqlite3.connect(run/"state/data/sessions"/session/"session.db",timeout=0)
        database.execute("BEGIN IMMEDIATE")
        desired["views"][0].update(width=1600,height=1200)
        sent=service.driver.publish(views=desired["views"])
        blocked=service.wait(lambda value:value["observedRevision"]==sent["revision"] and value["lastError"] is not None)
        assert (blocked["views"][0]["width"],blocked["views"][0]["height"])==(7000,800)
        database.rollback()
        repaired=service.wait(lambda value:value["converged"] and value["applied"]["viewsRevision"]==sent["revision"])
        assert (repaired["views"][0]["width"],repaired["views"][0]["height"])==(1600,1200)
        saved=[json.loads(row[0]) for row in database.execute("SELECT config FROM views")]
        assert (saved[0]["width"],saved[0]["height"])==(1600,1200)
        database.close()
        half=service.view(viewId="1",width=8192,height=2000,visible=True,device=dict(mode="desktop",deviceScaleFactor=.5))
        assert half["views"][0]["deviceScaleFactor"]==.5
        for index in range(1,5):
            service.view(viewId=str(index),url="about:blank",width=2100,height=1000,visible=True,device=device)
        packed=service.snapshot()
        assert len(packed["views"])==4 and all(view["width"]==2100 and view["height"]==1000 for view in packed["views"])
        assert packed["converged"]
        service.close()
        print(json.dumps(dict(evidence=str(run))))
    finally:
        if service.process.poll() is None:
            service.close()
        (run/"evidence.json").write_text(json.dumps(service.evidence,indent=2),encoding="utf-8")


if __name__=="__main__":
    main()
