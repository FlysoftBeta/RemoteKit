"""Join opt-in CopyOutput events; elapsed is a flush batch, not pure-copy GPU time."""
import argparse
import collections
import json
import re
import statistics
from pathlib import Path


def dist(values):
    values = sorted(values)
    if not values:
        return None
    return {"n": len(values), "mean": statistics.mean(values),
            "p50": values[round((len(values)-1)*.5)],
            "p95": values[round((len(values)-1)*.95)], "max": values[-1]}


PAIRS = {
    "request_to_gpu_dispatch_ms": ("Created", "GpuDispatch"),
    "gpu_dispatch_to_flush_ms": ("GpuDispatch", "FlushBegin"),
    "flush_cpu_ms": ("FlushBegin", "FlushReturn"),
    "flush_return_to_submitted_ms": ("FlushReturn", "Submitted"),
    "submitted_to_finished_ms": ("Submitted", "Finished"),
    "flush_begin_to_finished_ms": ("FlushBegin", "Finished"),
    "finished_to_mailbox_ms": ("Finished", "MailboxReady"),
    "mailbox_to_send_result_ms": ("MailboxReady", "ResultSent"),
    "request_to_send_result_ms": ("Created", "ResultSent"),
}


def summarize(rows):
    fields = sorted({k for r in rows for k in r["milliseconds"]})
    return {"requests": len(rows), "milliseconds": {
        field: dist([r["milliseconds"][field] for r in rows if field in r["milliseconds"]])
        for field in fields},
        "elapsed_available": sum('flush_batch_gpu_elapsed_ms' in r['milliseconds'] for r in rows),
        "submitted_callback_count": sum('Submitted' in r['phases'] for r in rows),
        "explicit_submit_count": sum('SubmitBegin' in r['phases'] for r in rows),
        "explicit_submit_skipped_count": sum('SubmitSkipped' in r['phases'] for r in rows),
        "semaphore_counts": dict(collections.Counter(str(r['phases']['FlushBegin'].get('semaphore_count')) for r in rows)),
        "finished_inside_async_check": sum(r.get("finished_inside_async_check", False) for r in rows),
        "slowest_request": max(rows, key=lambda r: r["milliseconds"]["request_to_send_result_ms"], default=None)}


def measurement_windows(case):
    reports = {row['tenantId']: row['metrics'] for row in map(json.loads,
        (case/'metrics/client-metrics.jsonl').read_text(encoding='utf-8-sig').splitlines())
        if row.get('metrics', {}).get('kind') == 'streaming-benchmark'}
    windows = {}
    for source in (case/'server-trace').glob('server-*.jsonl'):
        # Clock anchors precede frame records. Do not parse a shutdown-truncated
        # final frame merely to obtain the already committed clock anchors.
        rows = []
        with source.open(encoding='utf-8-sig') as stream:
            for line in stream:
                rows.append(json.loads(line))
                if {'clock_wall', 'clock_sdk'} <= {row.get('event') for row in rows}:
                    break
        header = rows[0]
        report = reports.get(header['tenant'])
        if not report:
            continue
        wall = next(row for row in rows if row['event'] == 'clock_wall')
        clock = next(row for row in rows if row['event'] == 'clock_sdk')
        qpc = (int(clock['qpc_before'])+int(clock['qpc_after']))/2
        offset = wall['unix_time_us']+(qpc-int(wall['qpc']))*1e6/header['qpc_frequency']-clock['capture_time_us']
        start = report['startedWall']*1000-offset
        windows[str(header['session'])] = [start, start+report['elapsedMs']*1000]
    return windows


def analyze(path, window=None):
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    events = document.get("traceEvents", document) if isinstance(document, dict) else document
    active, requests, checks = {}, [], []
    check_active = {}
    counts, unjoined = collections.Counter(), collections.Counter()
    for event in sorted(events, key=lambda e: e.get("ts", 0)):
        name = event.get("name", "")
        if not name.startswith("RemoteKitCopy"):
            continue
        counts[name] += 1
        args = event.get("args", {})
        phase = name.removeprefix("RemoteKitCopy")
        ts = event.get("ts", 0)
        pid, tid = event.get("pid"), event.get("tid")
        if phase in ("AsyncCheckBegin", "AsyncCheckReturn"):
            key = (pid, tid, args.get("output_surface_id"))
            if phase == "AsyncCheckBegin":
                check_active[key] = ts
            elif key in check_active:
                checks.append({"pid": pid, "tid": tid, "surface": key[2],
                               "begin": check_active.pop(key), "end": ts})
            continue
        ident = args.get("request_id")
        if ident is None:
            continue
        key = (pid, ident)
        if phase == "Created":
            row = {"pid": pid, "request_id": ident, "capture_counter": args.get("capture_counter"),
                   "created_us": ts, "phases": {}, "phase_counts": collections.Counter()}
            active[key] = row
            requests.append(row)
        if key not in active:
            unjoined[phase] += 1
            continue  # Trace may start after request creation; never invent a join.
        row = active[key]
        row["phase_counts"][phase] += 1
        row["phases"][phase] = {"ts": ts, "tid": tid, **args}
        if phase == "ResultSent":
            # Other CopyOutput producers can reuse the freed request address
            # without a capturer Created event. Never attach them to this life.
            active.pop(key)
    complete = []
    for row in requests:
        phases = row["phases"]
        row["milliseconds"] = {}
        for field, (start, end) in PAIRS.items():
            if start in phases and end in phases:
                row["milliseconds"][field] = (phases[end]["ts"]-phases[start]["ts"])/1000
        finish = phases.get("Finished")
        if finish and "FlushBegin" in phases:
            surface = phases["FlushBegin"].get("output_surface_id")
            observed = [c for c in checks if c["pid"] == row["pid"] and
                        c["tid"] == finish["tid"] and c["surface"] == surface and
                        c["begin"] <= finish["ts"] <= c["end"]]
            row["finished_inside_async_check"] = bool(observed)
            if observed:
                row["async_check"] = observed[0]
            if finish.get("elapsed_available"):
                elapsed = finish["flush_batch_elapsed_ns"]/1e6
                row["milliseconds"]["flush_batch_gpu_elapsed_ms"] = elapsed
                if "submitted_to_finished_ms" in row["milliseconds"]:
                    row["milliseconds"]["submission_to_finished_minus_batch_elapsed_ms"] = (
                        row["milliseconds"]["submitted_to_finished_ms"]-elapsed)
        row["complete_mappable"] = all(p in phases for p in
            ("Created", "GpuDispatch", "FlushBegin", "FlushReturn", "Finished", "MailboxReady", "ResultSent"))
        if row["complete_mappable"]:
            complete.append(row)
    fields = sorted({k for r in complete for k in r["milliseconds"]})
    backends = collections.Counter((r["phases"]["FlushBegin"].get("backend_kind"),
                                    r["phases"]["FlushBegin"].get("backend_api")) for r in complete)
    extent = [min(e['ts'] for e in events if e.get('ts', 0)>0), max(e['ts'] for e in events if 'ts' in e)]
    steady = [r for r in complete if window and window[0] <= r['created_us'] and
              r['phases']['ResultSent']['ts'] <= window[1]]
    return {"file": str(path.resolve()), "event_counts": dict(counts), "unjoined_phases": dict(unjoined),
            "trace_extent_us": extent, "measurement_window_us": window,
            "measurement_overlap_ms": max(0, min(extent[1], window[1])-max(extent[0], window[0]))/1000 if window else None,
            "full_recording": summarize(complete), "measurement_window": summarize(steady),
            "requests_created": len(requests), "complete_mappable_requests": len(complete),
            "backends": [{"kind": key[0], "api": key[1], "requests": count} for key, count in backends.items()],
            "milliseconds": {f: dist([r["milliseconds"][f] for r in complete if f in r["milliseconds"]]) for f in fields},
            "finished_inside_async_check": sum(r.get("finished_inside_async_check", False) for r in complete),
            "duplicate_phases": [r for r in requests if any(n > 1 for n in r["phase_counts"].values())],
            "oldest_complete_request": max(complete, key=lambda r: r["milliseconds"]["request_to_send_result_ms"], default=None),
            "requests": requests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("traces", nargs="*", type=Path)
    parser.add_argument("--case", type=Path, help="Case root supplies sample windows; only wholly contained requests enter steady statistics")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    windows = measurement_windows(args.case) if args.case else {}
    traces = args.traces or (sorted((args.case/'official-trace').glob('*.json')) if args.case else [])
    if not traces:
        parser.error('Provide trace paths or --case')
    result = {"semantics": {
        "identity": "PID + request pointer + creation timestamp; capture_counter bridges browser source trace",
        "submitted": "Skia submitted callback, not an OS/GPU execution timestamp",
        "elapsed": "Supported, nonzero flush-batch GPU elapsed; may contain earlier unflushed work",
        "residual": "Not pure observation latency: includes queueing, timing overlap, scheduling and callback checks",
        "scope": "Whole recorded trace; startup/steady-state windows must be kept distinct"},
        "traces": [analyze(p, windows.get(re.match(r'session-(\d+)-', p.name)[1])
                           if re.match(r'session-(\d+)-', p.name) else None) for p in traces]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    for item in result["traces"]:
        print(json.dumps({k: v for k, v in item.items() if k not in
                         ("requests", "duplicate_phases", "oldest_complete_request")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
