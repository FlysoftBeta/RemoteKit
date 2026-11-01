"""Inspect Chromium's own legacy-JSON startup trace, without inventing GPU timings."""
import argparse
import collections
import json
import re
import statistics
from pathlib import Path
from streaming_metrics import load_metrics


def distribution(values):
    values = sorted(values)
    if not values: return None
    return dict(n=len(values), mean=statistics.mean(values), p50=values[round((len(values)-1)*.5)],
                p95=values[round((len(values)-1)*.95)], max=values[-1])


def spans(events):
    stacks, pending, result = collections.defaultdict(list), collections.defaultdict(list), []
    def async_key(event):
        ident = event.get('id2', event.get('id'))
        owner = None if isinstance(ident, dict) and 'global' in ident else event.get('pid')
        return owner, json.dumps(ident, sort_keys=True), event.get('scope'), event.get('cat')
    for event in sorted(events, key=lambda e: e.get('ts', 0)):
        phase = event.get('ph')
        if phase == 'X' and 'dur' in event:
            result.append(dict(event, durationUs=event['dur']))
        elif phase == 'B': stacks[(event.get('pid'), event.get('tid'))].append(event)
        elif phase == 'E':
            stack = stacks[(event.get('pid'), event.get('tid'))]
            if stack:
                begin = stack.pop()
                result.append(dict(begin, durationUs=event['ts']-begin['ts']))
        elif phase in ('b', 'S'):
            key = async_key(event)
            pending[key].append(event)
        elif phase in ('e', 'F'):
            key = async_key(event)
            if pending[key]:
                begin = pending[key].pop()
                result.append(dict(begin, durationUs=event['ts']-begin['ts'], endArgs=event.get('args', {})))
    return result


def analyze(case):
    browser_pids = dict(re.findall(r'session (\d+) browser pid (\d+)',
        (case/'control.err').read_text(encoding='utf-8-sig', errors='replace')))
    browser_callbacks = []
    reports = {r['tenantId']: r['metrics'] for r in load_metrics(case/'metrics/client-metrics.jsonl')
               if r.get('metrics', {}).get('kind') == 'streaming-benchmark'}
    session_windows = {}
    for source in (case/'server-trace').glob('server-*.jsonl'):
        rows = [json.loads(line) for line in source.read_text(encoding='utf-8-sig').splitlines()]
        header = rows[0]; report = reports.get(header['tenant'])
        if not report: continue
        wall = next(r for r in rows if r['event'] == 'clock_wall')
        clock = next(r for r in rows if r['event'] == 'clock_sdk')
        qpc = (int(clock['qpc_before'])+int(clock['qpc_after']))/2
        clock_wall_us = wall['unix_time_us']+(qpc-int(wall['qpc']))*1e6/header['qpc_frequency']
        offset = clock_wall_us-clock['capture_time_us']
        start = report['startedWall']*1000-offset
        session_windows[str(header['session'])] = (start, start+report['elapsedMs']*1000)
    for path in (case/'browser-trace').glob('*.json'):
        browser = json.loads(path.read_text(encoding='utf-8-sig'))
        browser_callbacks.extend(dict(r, browserPid=browser['pid']) for r in browser.get('events', [])
                                 if r.get('stage') == 'capture_callback')
    output = {'case': case.name, 'gpuTimingSemantics': 'Only disabled-by-default-gpu.device spans are hardware timer output; CPU task duration is not GPU execution', 'files': []}
    timeline = []
    for path in sorted((case/'official-trace').glob('*.json')):
        document = json.loads(path.read_text(encoding='utf-8-sig'))
        events = document['traceEvents'] if isinstance(document, dict) else document
        duration_events = spans(events)
        processes = {str(e['pid']): e.get('args', {}).get('name') for e in events if e.get('name') == 'process_name'}
        counts = collections.Counter(e.get('name') for e in events)
        categories = collections.Counter(e.get('cat') for e in events)
        selected = [e for e in duration_events if e.get('name') in ('Capture', 'FrameInUse', 'CopyOutputRequest', 'SkiaOutputSurfaceImplOnGpu::CopyOutput')]
        for e in selected:
            timeline.append(dict(file=path.name, **e))
        duration_summary = {name: distribution([e['durationUs']/1000 for e in selected if e.get('name') == name])
                            for name in ('Capture', 'FrameInUse', 'CopyOutputRequest', 'SkiaOutputSurfaceImplOnGpu::CopyOutput')}
        device = [e for e in duration_events if 'disabled-by-default-gpu.device' in e.get('cat', '')]
        service = [e for e in duration_events if 'disabled-by-default-gpu.service' in e.get('cat', '')]
        joins = []
        session_match = re.match(r'session-(\d+)-', path.name)
        expected_browser_pid = int(browser_pids.get(session_match[1], 0)) if session_match else 0
        window = session_windows.get(session_match[1]) if session_match else None
        in_window = lambda e: not window or window[0] <= e['ts']+e.get('durationUs', 0) <= window[1]
        for e in selected:
            if e.get('name') != 'Capture': continue
            number = e.get('args', {}).get('frame_number')
            if number is None: continue
            candidates = [b for b in browser_callbacks if b.get('source_counter') == number
                          and b['browserPid'] == expected_browser_pid]
            if candidates:
                closest = min(candidates, key=lambda b: abs(e['ts']-b.get('capture_begin_us', 0)))
                joins.append(dict(frameNumber=number, browserPid=closest['browserPid'], officialBeginUs=e['ts'],
                                  browserMetadataBeginUs=closest.get('capture_begin_us'),
                                  beginDeltaUs=e['ts']-closest.get('capture_begin_us', 0)))
        captures = sorted((e for e in selected if e['name'] == 'Capture'), key=lambda e:e['ts'])
        copy_associations = []
        for request in (e for e in selected if e['name'] == 'CopyOutputRequest'):
            previous = [e for e in captures if e['pid'] == request['pid'] and e['tid'] == request['tid'] and e['ts'] <= request['ts']]
            if not previous: continue
            capture = previous[-1]
            if request['ts']-capture['ts'] > 10000: continue
            copy_associations.append(dict(frameNumber=capture.get('args',{}).get('frame_number'),
                captureStartUs=capture['ts'], requestStartUs=request['ts'],
                requestEndUs=request['ts']+request['durationUs'],
                createAfterCaptureBeginMs=(request['ts']-capture['ts'])/1000,
                captureEndAfterResultMs=(capture['ts']+capture['durationUs']-request['ts']-request['durationUs'])/1000,
                inMeasurementWindow=in_window(capture)))
        polling = [e for e in duration_events if e.get('name') == 'ThreadControllerImpl::RunTask'
                   and e.get('args',{}).get('src_func') == 'ScheduleDelayedGPUTaskFromGPUThread'
                   and 'skia_output_surface_dependency_impl' in e.get('args',{}).get('src_file','') and in_window(e)]
        polling.sort(key=lambda e:e['ts'])
        flow_starts = {(e.get('pid'), e.get('id')): e for e in events
                       if e.get('cat') == 'toplevel.flow' and e.get('ph') == 's'}
        flow_ends = {(e.get('pid'),e.get('tid'),e.get('ts')): e for e in events
                     if e.get('cat') == 'toplevel.flow' and e.get('ph') == 'f'}
        poll_flows = []
        for e in polling:
            finish = flow_ends.get((e['pid'],e['tid'],e['ts']))
            post = flow_starts.get((finish['pid'],finish['id'])) if finish else None
            if not post: continue
            annotation = e.get('args',{}).get('chrome_task_annotator',{})
            requested = annotation.get('task_delay_us')
            poll_flows.append(dict(flowId=finish['id'],pid=e['pid'],tid=e['tid'],postUs=post['ts'],runUs=e['ts'],
                requestedDelayUs=requested,delayPolicy=annotation.get('delay_policy'),
                postToRunMs=(e['ts']-post['ts'])/1000,
                lateBeyondRequestedMs=(e['ts']-post['ts']-requested)/1000 if requested is not None else None))
        steady = [e for e in selected if in_window(e)]
        steady_associations = [r for r in copy_associations if r['inMeasurementWindow']]
        output['files'].append(dict(file=path.name, bytes=path.stat().st_size, processes=processes,
            eventCount=len(events), categories=dict(categories), topEventNames=counts.most_common(35),
            durationMs=duration_summary, gpuDeviceSpanCount=len(device), gpuServiceSpanCount=len(service),
            gpuDeviceDurationMs=distribution([e['durationUs']/1000 for e in device]),
            gpuDeviceNames=collections.Counter(e['name'] for e in device).most_common(25),
            resurrectionInstantCount=counts.get('UsingResurrectedFrame', 0),
            copyOutputRequestCount=sum(1 for e in events if e.get('name') == 'CopyOutputRequest' and e.get('ph') in ('B','b','S','X')),
            sourceCounterJoinCount=len(joins), sourceCounterJoinExamples=joins[:8],
            sourceCounterBeginDeltaUs=distribution([j['beginDeltaUs'] for j in joins]),
            measurementWindowTimeTicksUs=window,
            observedTraceTimeTicksUs=[min(e['ts'] for e in events if e.get('ts',0)>0), max(e['ts'] for e in events if 'ts' in e)],
            steadyDurationMs={name:distribution([e['durationUs']/1000 for e in steady if e['name']==name]) for name in duration_summary},
            sameThreadCopyRequestAssociations=len(steady_associations),
            copyRequestAssociationMeaning='Closest preceding Capture begin on the same pid/tid, within 10ms; one capturer per source process in these cases',
            copyRequestCreationAfterCaptureBeginMs=distribution([r['createAfterCaptureBeginMs'] for r in steady_associations]),
            captureEndAfterCopyResultMs=distribution([r['captureEndAfterResultMs'] for r in steady_associations]),
            copyRequestAssociationExamples=steady_associations[:5],
            delayedGpuPolling=dict(count=len(polling), taskDurationMs=distribution([e['durationUs']/1000 for e in polling]),
                runGapMs=distribution([(b['ts']-a['ts'])/1000 for a,b in zip(polling,polling[1:])]),
                flowMatched=len(poll_flows), postToRunMs=distribution([e['postToRunMs'] for e in poll_flows]),
                lateBeyondRequestedMs=distribution([e['lateBeyondRequestedMs'] for e in poll_flows if e['lateBeyondRequestedMs'] is not None]),
                flowExamples=poll_flows[:5], delayPolicies=collections.Counter(e['delayPolicy'] for e in poll_flows),
                meaning='post→run uses exact toplevel.flow ids; run gaps alone are not queue latency; no actual GPU-ready timestamp'),
            steadyGpuDeviceDurationMs=distribution([e['durationUs']/1000 for e in device if in_window(e)])))
    (case/'official-trace-summary.json').write_text(json.dumps(output, indent=2), encoding='utf-8')
    (case/'official-capture-timeline.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in timeline), encoding='utf-8')
    print(json.dumps(output))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', type=Path)
    analyze(parser.parse_args().case)
