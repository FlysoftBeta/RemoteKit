"""Historical capture-path evidence only; not a validator for render slots. Join opt-in Viz paint flush GPU timings, without summing overlapping scopes."""
import argparse
import collections
import importlib.util
import json
import re
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "copy_profile", Path(__file__).with_name("analyze-copy-output-profile.py"))
copy_profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copy_profile)


def summarize(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row["begin"]["scope"]].append(row)
    return {scope: {
        "flushes": len(items),
        "gpu_elapsed_ms": copy_profile.dist([
            r["finished"]["flush_batch_elapsed_ns"] / 1e6 for r in items
            if r.get("finished", {}).get("elapsed_available")]),
        "cpu_flush_ms": copy_profile.dist([
            (r["return"]["ts"] - r["begin"]["ts"]) / 1000 for r in items
            if "return" in r]),
        "submitted_to_finished_ms": copy_profile.dist([
            (r["finished"]["ts"] - r["submitted"]["ts"]) / 1000 for r in items
            if "finished" in r and "submitted" in r]),
        "elapsed_unavailable": sum(not r.get("finished", {}).get("elapsed_available")
                                   for r in items),
        "surfaces": [dict(zip(("width", "height", "color_type", "sample_count",
                                 "context_id", "output_surface_id"), key), count=n)
                     for key, n in collections.Counter(
                         tuple(r["begin"].get(k) for k in
                               ("width", "height", "color_type", "sample_count",
                                "context_id", "output_surface_id"))
                         for r in items).items()],
    } for scope, items in groups.items()}


def analyze(path, window):
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    events = document.get("traceEvents", []) if isinstance(document, dict) else document
    rows, counts, unsupported = {}, collections.Counter(), []
    unjoined = collections.Counter()
    for event in sorted(events, key=lambda e: e.get("ts", 0)):
        name = event.get("name", "")
        if not name.startswith("RemoteKitViz"):
            continue
        counts[name] += 1
        args = {**event.get("args", {}), "ts": event.get("ts"),
                "tid": event.get("tid")}
        if name == "RemoteKitVizUnsupported":
            unsupported.append(args)
        if "scope_id" not in args:
            continue
        key = (event.get("pid"), args["scope_id"])
        if name == "RemoteKitVizFlushBegin":
            rows[key] = {"pid": key[0], "scope_id": key[1], "begin": args}
        elif key in rows:
            field = {"RemoteKitVizFlushReturn": "return",
                     "RemoteKitVizSubmitted": "submitted",
                     "RemoteKitVizFinished": "finished",
                     "RemoteKitVizPassIdentity": "identity"}.get(name)
            if field:
                rows[key][field] = args
        else:
            unjoined[name] += 1
    rows = list(rows.values())
    steady = [r for r in rows if window and "finished" in r
              and window[0] <= r["begin"]["ts"]
              and r["finished"]["ts"] <= window[1]]
    extent = [min((e["ts"] for e in events if e.get("ts", 0) > 0), default=0),
              max((e["ts"] for e in events if "ts" in e), default=0)]
    return {"file": str(path), "event_counts": dict(counts),
            "trace_extent_us": extent, "measurement_window_us": window,
            "measurement_overlap_ms": max(0, min(extent[1], window[1]) -
                                           max(extent[0], window[0])) / 1000 if window else None,
            "measurement_begin_counts": dict(collections.Counter(
                r["begin"]["scope"] for r in rows if window and
                window[0] <= r["begin"]["ts"] <= window[1])),
            "unjoined": dict(unjoined),
            "unsupported": unsupported, "full_recording": summarize(rows),
            "measurement_window": summarize(steady), "flushes": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", type=Path, required=True)
    args = parser.parse_args()
    windows = copy_profile.measurement_windows(args.case)
    result = {"semantics": {
        "elapsed": "Ganesh GPU elapsed of the existing paint flush batch; may include earlier unflushed work and GPU dependencies, not pure shader busy time",
        "identity": "PID + scope_id; frame is output-local swap sequence, child pass is an ordinal plus mailbox, not Viz numeric render pass ID",
        "cpu": "Trace timestamps are CPU flush/callback observation times, not hardware execution anchors",
        "overlap": "Same-context flush boundaries separate submitted batches, but renderer, CopyOutput and Viz timer intervals may overlap or include dependencies; no totals or subtraction are computed",
        "availability": "Absent finish or unsupported/zero elapsed is unknown, never zero cost",
        "window": "measurement_window includes only flush begin and finished callback wholly contained in the real client interval; measurement_begin_counts reports cadence independently of late callbacks",
    }, "traces": []}
    for path in sorted((args.case / "official-trace").glob("*.json")):
        match = re.match(r"session-(\d+)-", path.name)
        result["traces"].append(analyze(path, windows.get(match[1]) if match else None))
    (args.case / "viz-gpu-summary.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for trace in result["traces"]:
        print(json.dumps({k: v for k, v in trace.items() if k != "flushes"}))


if __name__ == "__main__":
    main()
