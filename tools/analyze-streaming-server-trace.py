"""Join opt-in browser/endpoint/SDK traces to actual wire RTP and pixel markers.

QPC stages are CPU observations around real GPU/codec completion. The client
endpoint is the JS drawImage return timestamp, not a physical display present.
"""
import argparse
import bisect
import collections
import json
import re
import statistics
from pathlib import Path
from streaming_metrics import load_metrics


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def dist(values):
    values = sorted(x for x in values if x is not None)
    if not values:
        return None
    return dict(n=len(values), mean=statistics.mean(values), p50=values[round((len(values)-1)*.5)],
                p95=values[round((len(values)-1)*.95)], p99=values[round((len(values)-1)*.99)],
                min=values[0], max=values[-1])


def analyze(root):
    envelopes = load_metrics(root/'metrics/client-metrics.jsonl')
    reports = {r['tenantId']: r['metrics'] for r in envelopes
               if r.get('metrics', {}).get('kind') == 'streaming-benchmark'}
    browsers = {}
    for path in (root/'browser-trace').glob('*.json'):
        doc = json.loads(path.read_text(encoding='utf-8-sig'))
        browsers.setdefault(int(doc['pid']), []).append(doc)
    browser_pids = dict(re.findall(r'session (\d+) browser pid (\d+)',
                                  (root/'control.err').read_text(encoding='utf-8-sig', errors='replace')))
    sdk = {}
    for path in (root/'server-trace').glob('sdk-*.jsonl'):
        rows = read_lines(path)
        sdk[(int(rows[0]['pid']), int(rows[0]['peer']))] = rows
    result = {'case': root.name, 'semantics': 'CPU observations; client paint is JS drawImage return', 'tenants': []}
    for path in sorted((root/'server-trace').glob('server-*.jsonl')):
        rows = read_lines(path)
        header = rows[0]
        report = reports.get(header['tenant'])
        if not report:
            continue
        freq = int(header['qpc_frequency'])
        wall = sorted((int(r['qpc']), float(r['unix_time_us'])/1000) for r in rows if r['event'] == 'clock_wall')
        wall_qpc = [r[0] for r in wall]
        def qpc_wall(qpc):
            n = max(0, min(len(wall)-1, bisect.bisect_left(wall_qpc, qpc)))
            return wall[n][1] + (qpc-wall[n][0])*1000/freq
        clocks = [r for r in rows if r['event'] == 'clock_sdk']
        def mono_qpc(us):
            r = min(clocks, key=lambda r: abs(r['capture_time_us']-us))
            return (int(r['qpc_before'])+int(r['qpc_after']))/2 + (us-r['capture_time_us'])*freq/1e6
        by_frame = collections.defaultdict(list)
        by_cookie = collections.defaultdict(list)
        by_rtp = collections.defaultdict(dict)
        for r in rows:
            if 'frame_id' in r:
                by_frame[int(r['frame_id'])].append(r)
            if 'cookie' in r:
                by_cookie[int(r['cookie'])].append(r)
            if 'rtp_timestamp' in r:
                by_rtp[(int(r.get('encoder', 0)), int(r['rtp_timestamp']))][r['event']] = r
        browser_docs = browsers.get(int(browser_pids.get(str(header['session']), 0)), [])
        publications = {(int(d['generation']), int(r.get('source_frame_id', r['serial']))): r
                        for d in browser_docs for r in d.get('events', []) if r['stage'] == 'atlas_publish'}
        callbacks = {(int(d['generation']), int(r.get('capture_time_us', r['source_us']))): r
                     for d in browser_docs for r in d.get('events', []) if r['stage'] == 'capture_callback'}
        window_start, window_end = report['startedWall'], report['startedWall']+report['elapsedMs']
        capture_rows = [r for d in browser_docs for r in d.get('events', []) if r['stage'] == 'capture_callback']
        def browser_count(stage):
            return sum(1 for d in browser_docs for r in d.get('events', [])
                       if r['stage'] == stage and 'qpc' in r and window_start <= qpc_wall(int(r['qpc'])) <= window_end)
        edges = []
        for r in capture_rows:
            if not r.get('capture_begin_us'): continue
            a, b = qpc_wall(mono_qpc(r['capture_begin_us'])), qpc_wall(mono_qpc(r['source_us']))
            if b >= window_start and a <= window_end:
                edges.extend([(max(a, window_start), 1), (min(b, window_end), -1)])
        active = peak = 0
        for _, delta in sorted(edges):
            active += delta; peak = max(peak, active)
        raw_native = {int(r['rtpTimestamp']): r for r in report.get('rawVideoFrames', []) if 'rtpTimestamp' in r}
        markers = {int(r['rtp']): r for r in report.get('samples', []) if r.get('rtp') is not None}
        paints = {int(r['rtp']): r for r in report.get('paintedFrames', []) if r.get('rtp') is not None}
        sdk_rows = sdk.get((int(header['pid']), next((int(r['peer']) for r in rows if 'peer' in r), 0)), [])
        sdk_events = collections.defaultdict(dict)
        sdk_submits = collections.defaultdict(list)
        for r in sdk_rows[1:]:
            sdk_events[(int(r['encoder']), int(r['rtp_timestamp']))][r['event']] = r
            if r['event'] == 'texture_submit': sdk_submits[int(r['frame_id'])].append(r)
        streams, samples = [], []
        missing = collections.Counter()
        for end in rows:
            if end['event'] != 'encoded_return' or end.get('status') != 0 or 'wire_rtp_timestamp' not in end:
                continue
            end_wall = qpc_wall(int(end['qpc']))
            wire = int(end['wire_rtp_timestamp'])
            in_window = report['startedWall'] <= end_wall <= report['startedWall']+report['elapsedMs']
            if not in_window and wire not in markers:
                continue
            fid, rtp, wire = int(end['frame_id']), int(end['rtp_timestamp']), int(end['wire_rtp_timestamp'])
            encoder = int(end['encoder'])
            points = {'encoded_return': int(end['qpc']), 'capture_end': int(end['capture_qpc'])}
            events = by_rtp[(encoder, rtp)]
            # VPP records have no encoder field; frame_id+input RTP disambiguate them.
            for r in by_frame[fid]:
                if int(r.get('rtp_timestamp', -1)) == rtp:
                    points[r['event']] = int(r['qpc'])
            for r in by_cookie[int(end.get('cookie', 0))]:
                if r['event'].startswith('mfx_submit'):
                    points[r['event']] = int(r['qpc'])
            prior = [r for r in by_frame[fid] if r['event'] == 'atlas_private_copy_complete' and r['qpc'] <= end['qpc']]
            if prior:
                copied = prior[-1]
                points['copy_complete'] = int(copied['qpc'])
                submit = next((r for r in by_frame[fid] if r['event'] == 'atlas_private_copy_submit'), None)
                if submit:
                    points['copy_submit'] = int(submit['qpc'])
                    gen = int(submit['generation'])
                    pub = publications.get((gen, int(submit['source_frame_id'])))
                    cb = callbacks.get((gen, int(submit['capture_time_us'])))
                    if pub: points['atlas_publish'] = int(pub['qpc'])
                    if cb:
                        points['capture_callback'] = int(cb['qpc'])
                        if cb.get('capture_begin_us'): points['capture_begin'] = mono_qpc(cb['capture_begin_us'])
            for name, row in sdk_events[(encoder, rtp)].items():
                points['sdk_'+name] = int(row['qpc'])
            submits = [r for r in sdk_submits[fid] if int(r['qpc']) <= points.get('sdk_encode_enter', 0)]
            if submits: points['sdk_texture_submit'] = int(submits[-1]['qpc'])
            pairs = [('capture_begin_to_end', 'capture_begin','capture_end'),
                     ('capture_end_to_callback','capture_end','capture_callback'),
                     ('callback_to_publish','capture_callback','atlas_publish'),
                     ('publish_to_copy_submit','atlas_publish','copy_submit'),
                     ('copy','copy_submit','copy_complete'),
                     ('copy_to_encode_enter','copy_complete','sdk_encode_enter'),
                     ('copy_to_sdk_texture_submit','copy_complete','sdk_texture_submit'),
                     ('sdk_texture_submit_to_encode_enter','sdk_texture_submit','sdk_encode_enter'),
                     ('worker_queue','worker_enqueue','worker_dequeue'),
                     ('vpp','vpp_submit','vpp_complete'),
                     ('vpp_blt_call','vpp_submit','vpp_blt_return'),
                     ('vpp_wait_call','vpp_wait_begin','vpp_wait_return'),
                     ('mfx_submit_to_complete','mfx_submit_begin','hardware_complete'),
                     ('hardware_complete_to_encoded_return','hardware_complete','encoded_return'),
                     ('capture_end_to_encoded_return','capture_end','encoded_return')]
            segments = {name: (points[b]-points[a])*1000/freq if a in points and b in points else None for name,a,b in pairs}
            row = dict(frame_id=fid, input_rtp=rtp, wire_rtp=wire, pointsQpc=points, segmentsMs=segments)
            if in_window:
                streams.append(row)
            if wire not in markers:
                continue
            marker, native = markers[wire], raw_native.get(wire)
            if not native: missing['native_rtp'] += 1
            origin = report.get('timeOrigin')
            if origin is None: missing['client_time_origin'] += 1
            marker_segments = dict(segments)
            marker_segments['render_to_draw_submit'] = marker['renderToObservedMs']
            marker_segments['draw_submit_to_marker_complete'] = marker['markerCompletedAt']-marker['observedAt']
            marker_segments['receive_to_draw_submit'] = marker['observedAt']-native['receiveTime'] if native and 'receiveTime' in native else None
            marker_segments['render_to_receive'] = marker['renderToObservedMs']-marker_segments['receive_to_draw_submit'] if marker_segments['receive_to_draw_submit'] is not None else None
            if native:
                marker_segments['native_processing_duration'] = native.get('processingDuration', 0)*1000 if 'processingDuration' in native else None
                marker_segments['native_presentation_to_draw_submit'] = marker['observedAt']-native['presentationTime'] if 'presentationTime' in native else None
                marker_segments['native_receive_to_presentation'] = native['presentationTime']-native['receiveTime'] if 'presentationTime' in native and 'receiveTime' in native else None
                if marker_segments['native_receive_to_presentation'] is not None and marker_segments['native_processing_duration'] is not None:
                    marker_segments['native_receive_to_presentation_minus_processing'] = marker_segments['native_receive_to_presentation']-marker_segments['native_processing_duration']
            if origin is not None:
                render_wall = origin+marker['observedAt']-marker['renderToObservedMs']
                marker_segments['render_to_capture_begin'] = qpc_wall(points['capture_begin'])-render_wall if 'capture_begin' in points else None
                marker_segments['render_to_capture_end'] = qpc_wall(points['capture_end'])-render_wall
                marker_segments['encoded_return_to_receive'] = origin+native['receiveTime']-end_wall if native and 'receiveTime' in native else None
                if marker_segments['encoded_return_to_receive'] is not None:
                    marker_segments['closure_error'] = (marker_segments['render_to_capture_end']+segments['capture_end_to_encoded_return']+marker_segments['encoded_return_to_receive']+marker_segments['receive_to_draw_submit']-marker['renderToObservedMs'])
            row = dict(row, marker=marker, native=native, segmentsMs=marker_segments)
            samples.append(row)
        all_names = set().union(*(r['segmentsMs'].keys() for r in streams+samples))
        summary = {name: dist([r['segmentsMs'].get(name) for r in streams]) for name in sorted(all_names)}
        sampled = {name: dist([r['segmentsMs'].get(name) for r in samples]) for name in sorted(all_names)}
        clock = report.get('clockSample')
        clock_validation = None
        if clock and report.get('timeOrigin') is not None:
            half_span = (clock['performanceAfter']-clock['performanceBefore'])/2
            clock_validation = dict(wallMinusTimeOriginMs=clock['wallTime']-(report['timeOrigin']+(clock['performanceAfter']+clock['performanceBefore'])/2),
                                    bracketHalfSpanMs=half_span, dateNowQuantizationMs=1,
                                    closureMeaning='arithmetic consistency, not independent clock calibration')
        missing['marker_without_server_wire'] = len(set(markers)-{r['wire_rtp'] for r in samples})
        result['tenants'].append(dict(tenant=header['tenant'], session=header['session'], tenantIndex=report['tenantIndex'],
            serverHeader=header, clockSample=clock, clockValidation=clock_validation, timeOrigin=report.get('timeOrigin'),
            frameCounts=dict(captureCallbacks=browser_count('capture_callback'), atlasPublications=browser_count('atlas_publish'),
                             captureCallbackFps=browser_count('capture_callback')*1000/report['elapsedMs'],
                             atlasPublicationFps=browser_count('atlas_publish')*1000/report['elapsedMs'],
                             successfulCallbackIntervalOverlapMax=peak,
                             actualCopyOutputRequests=None, resurrectedFrames=None,
                             meaning='Callbacks include resurrected frames; JS RAF/render rates are separate source-probe fields'),
            wireFrames=len(streams), markerJoins=len(samples), missing=dict(missing), allWireStagesMs=summary,
            sampledStagesMs=sampled, samples=samples))
    (root/'server-trace-analysis.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    for tenant in result['tenants']:
        print(json.dumps(dict(case=root.name, tenant=tenant['tenantIndex'], wire=tenant['wireFrames'], markers=tenant['markerJoins'],
             missing=tenant['missing'], sampled=tenant['sampledStagesMs']), ensure_ascii=False))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', nargs='+', type=Path)
    args = parser.parse_args()
    for case in args.cases:
        analyze(case)
