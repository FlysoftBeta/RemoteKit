"""Summarize saved streaming cases; preserve raw observations and their clocks."""
import argparse
import json
import statistics
from pathlib import Path


def distribution(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return {"n": len(values), "p50": values[round((len(values)-1)*.50)],
            "p95": values[round((len(values)-1)*.95)],
            "p99": values[round((len(values)-1)*.99)],
            "mean": statistics.mean(values), "min": values[0], "max": values[-1]}


def series(values):
    return {"count": len(values),
            "fps": (len(values)-1)*1000/(values[-1]-values[0]) if len(values)>1 and values[-1]>values[0] else None,
            "intervalMs": distribution([b-a for a, b in zip(values, values[1:])])}


def analyze(case):
    records = [json.loads(line)["metrics"] for line in (case/"metrics/client-metrics.jsonl").read_text(encoding="utf-8").splitlines()]
    clients = [record for record in records if record.get("kind") == "streaming-benchmark"]
    output = []
    source_documents = [json.loads(path.read_text(encoding="utf-8")) for path in (case/"source-trace").glob("*.json")]
    for client in clients:
        index = client["tenantIndex"]
        start = client["startedWall"]
        end = start + client["elapsedMs"]
        chunks = sorted((record for record in records if record.get("kind") == "presentation-raw-chunk" and record["tenantIndex"] == index), key=lambda record: record["part"])
        if chunks:
            if len(chunks) != chunks[0]["chunks"]:
                raise ValueError("Missing raw presentation chunks")
            raw = json.loads("".join(chunk["text"] for chunk in chunks))
            (case/f"presentation-raw-{index}.json").write_text(json.dumps(raw), encoding="utf-8")
        result = {"config": client["config"], "tenantIndex": index,
                  "source": {}, "browser": [], "receiver": {
                      "markerFps": client.get("observedFps"),
                      "markerSamplesPerSecond": client.get("markerSamplesPerSecond"),
                      "authorizedRtpFps": client.get("authorizedFrameFps", client.get("displayFps")),
                      "displayPaintFps": client.get("displayFps") if client.get("frameCountStage") == "viewport-paint-v2" else None,
                      "displayPerSecondFrames": client.get("displayPerSecondFrames") if client.get("frameCountStage") == "viewport-paint-v2" else None,
                      "frameCountStage": client.get("frameCountStage", "authorized-snapshot; not Viewport paint"),
                      "authorizedPerSecondFrames": client.get("authorizedPerSecondFrames", client.get("displayPerSecondFrames")),
                      "markerPerSecondSamples": client["perSecondFrames"],
                      "latency": client["renderToObservedMs"],
                      "markerTimestampMeaning": client.get("markerTimestampMeaning", "after synchronous marker readback/CRC"),
                      "clientRaf": series(client.get("clientRaf", [])),
                      "rawVideoCallbacks": series([frame["now"] for frame in client.get("rawVideoFrames", [])]),
                      "presentation": client.get("presentation"),
                      "visibility": client["visibility"], "invalidMarkers": client["invalid"]}}
        source = next((document for document in source_documents if "timeOrigin" in document and document.get("run") == client["config"]["id"]+f"-{index}"), None)
        if source:
            source_start, source_end = start-source["timeOrigin"], end-source["timeOrigin"]
            result["sourceClientWindowMs"] = [source_start, source_end]
            result["source"] = {name: series([value for value in source[name] if source_start<=value<=source_end]) for name in ("raf", "renders")}
        # Browser QPC origin is distinct from wall time. This is a declared
        # steady middle 20-second window, not an exact cross-clock alignment.
        for path in (case/"browser-trace").glob("*.json"):
            trace = json.loads(path.read_text(encoding="utf-8"))
            if not trace["events"]:
                continue
            origin = trace["events"][0]["at_us"]
            summary = {"file": path.name, "window": "first trace event +5s through +25s",
                       "timerHighResStart": trace["timer_high_resolution_start"], "timerHighResStop": trace["timer_high_resolution_stop"]}
            for stage in ("capture_callback", "atlas_publish", "source_read_done", "poll"):
                summary[stage] = series([event["at_us"]/1000 for event in trace["events"] if event["stage"] == stage and origin+5000000<=event["at_us"]<=origin+25000000])
            result["browser"].append(summary)
        samples = client["rtcSamples"]
        first, last = samples[0], samples[-1]
        seconds = (last["at"]-first["at"])/1000
        for namespace, names in (("rtc", ("framesReceived", "framesDecoded", "keyFramesDecoded", "bytesReceived")), ("endpoint", ("atlasCopies", "encodeSubmitted", "encodeCompleted", "encodeDropped"))):
            for name in names:
                a, b = (first.get(namespace) or {}).get(name), (last.get(namespace) or {}).get(name)
                result["receiver"][name+"PerSecond"] = (b-a)/seconds if a is not None and b is not None else None
        result["receiver"]["lastEndpoint"] = last.get("endpoint")
        load = next((document for document in source_documents if document.get("kind") == "host-load"), None)
        if load:
            rows = [row for row in load["samples"] if start<=row[0]-row[3]/2<=end]
            result["hostLoad"] = {"logicalCpus": load["logicalCpus"], "systemCpuPercent": distribution([row[1] for row in rows]), "probeCpuCores": distribution([row[2] for row in rows])}
        output.append(result)
    (case/"summary.json").write_text(json.dumps(output, indent=2), encoding="utf-8")
    for result in output:
        receiver = result["receiver"]
        print(json.dumps({"case": case.name, "tenant": result["tenantIndex"], "sourceRafFps": result["source"].get("raf", {}).get("fps"), "decodedFps": receiver.get("framesDecodedPerSecond"), "authorizedRtpFps": receiver["authorizedRtpFps"], "markerFps": receiver["markerFps"], "markerSampleHz": receiver["markerSamplesPerSecond"], "latency": receiver["latency"], "hostLoad": result.get("hostLoad")}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", type=Path, nargs="+")
    for case_path in parser.parse_args().cases:
        analyze(case_path)
