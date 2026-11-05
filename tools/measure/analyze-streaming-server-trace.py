"""Join opt-in browser/endpoint/SDK traces to actual wire RTP and pixel markers.

QPC stages are CPU observations around real GPU/codec completion. Client stages
use the selected profile window and its browser timestamps, not physical scanout.
"""
import argparse
import bisect
import collections
import json
import re
import statistics
from pathlib import Path


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def dist(values):
    values = sorted(x for x in values if x is not None)
    if not values:
        return None
    return dict(n=len(values), mean=statistics.mean(values), p50=values[round((len(values)-1)*.5)],
                p95=values[round((len(values)-1)*.95)], p99=values[round((len(values)-1)*.99)],
                min=values[0], max=values[-1])


def osr_identity(row, producer_pid=None, generation=None):
    return (int(row['producer_pid'] if producer_pid is None else producer_pid),
            int(row['generation'] if generation is None else generation),
            int(row['slot']), int(row['fence']))


OSR_SEGMENTS = (
    ('comp_begin_to_rend', 'render_begin', 'rend_begin'),
    ('rend_queue', 'rend_begin', 'rend_pump'),
    ('rend_prepare_planes', 'rend_pump', 'rend_first_plane_issue'),
    ('rend_planes', 'rend_first_plane_issue', 'rend_last_plane_result'),
    ('rend_after_planes', 'rend_last_plane_result', 'rend_atlas_begin'),
    ('rend_atlas_cpu_before_signal', 'rend_atlas_begin', 'rend_atlas_signal_call'),
    ('rend_signal_and_flush_calls', 'rend_atlas_signal_call', 'rend_atlas_flush_return'),
    ('rend_signal_call_to_ready_observed', 'rend_atlas_signal_call', 'slot_ready_observed'),
    ('comp_begin_to_ready_observed', 'render_begin', 'slot_ready_observed'),
    ('comp_ready_to_adapt_begin', 'slot_ready_observed', 'comp_adapt_begin'),
    ('comp_adapt', 'comp_adapt_begin', 'comp_adapt_return'),
    ('comp_adapt_to_sdk_submit', 'comp_adapt_return', 'sdk_texture_submit'),
    ('comp_ready_to_sdk_submit', 'slot_ready_observed', 'sdk_texture_submit'),
    ('sdk_encode_enter_to_worker_enqueue', 'sdk_encode_enter', 'worker_enqueue'),
    ('worker_dequeue_to_hardware_submit', 'worker_dequeue', 'hardware_submit'),
    ('hardware_submit_to_complete', 'hardware_submit', 'hardware_complete'),
    ('comp_begin_to_encoded_return', 'render_begin', 'encoded_return'),
)


def osr_points(points, ready, begins, browser_events, adapt, frequency):
    identity = osr_identity(ready)
    points['slot_ready_observed'] = int(ready['qpc'])
    if begin := begins.get(identity):
        points['render_begin'] = int(begin['qpc'])
    points.update(adapt)
    per_plane = collections.defaultdict(dict)
    for stage, row in browser_events.get((frequency, identity), []):
        qpc = int(row['qpc'])
        if stage in ('rend_plane_issue', 'rend_plane_result'):
            per_plane[int(row['view'])][stage] = qpc
        else:
            points[stage] = qpc
    issues = [plane['rend_plane_issue'] for plane in per_plane.values()
              if 'rend_plane_issue' in plane]
    results = [plane['rend_plane_result'] for plane in per_plane.values()
               if 'rend_plane_result' in plane]
    if issues:
        points['rend_first_plane_issue'] = min(issues)
    if results:
        points['rend_last_plane_result'] = max(results)
    return [
        {'view': view, 'pointsQpc': plane,
         'issueToResultMs': (plane['rend_plane_result']-plane['rend_plane_issue'])*1000/frequency
         if len(plane) == 2 else None}
        for view, plane in sorted(per_plane.items())
    ]


def rate_spans(rows, freq, qpc_wall, window_start, window_end):
    pending, result = {}, collections.defaultdict(list)
    starts = {'worker_set_rates_begin', 'mfx_reset_begin', 'mfx_get_params_begin'}
    returns = {event.removesuffix('_begin')+'_return' for event in starts}
    for row in sorted((row for row in rows if 'qpc' in row), key=lambda row: int(row['qpc'])):
        event = row['event']
        encoder = int(row.get('encoder', 0))
        if event in starts:
            pending[(encoder, event)] = row
        elif event in returns:
            begin_name = event.removesuffix('_return')+'_begin'
            if (begin := pending.pop((encoder, begin_name), None)) is not None:
                start, end = int(begin['qpc']), int(row['qpc'])
                if qpc_wall(start) <= window_end and qpc_wall(end) >= window_start:
                    result[event.removesuffix('_return')].append({
                        'encoder': encoder, 'startQpc': start, 'endQpc': end,
                        'ms': (end-start)*1000/freq, 'status': row['status'],
                        'bitrateBps': begin.get('bitrate_bps'), 'fps': begin.get('fps'),
                        'pending': begin.get('queue'),
                    })
    return {name: {'durationMs': dist([span['ms'] for span in spans]),
                   'spans': spans}
            for name, spans in result.items()}


def analyze_input(root, rows, browser_inputs, freq, qpc_wall, report):
    by_client = collections.defaultdict(lambda: collections.defaultdict(list))
    by_browser = collections.defaultdict(lambda: collections.defaultdict(list))
    for row in rows:
        if 'client_sequence' in row:
            by_client[int(row['client_sequence'])][int(row['peer'])].append(row)
        if 'browser_sequence' in row:
            by_browser[int(row['browser_sequence'])][row['event']].append(row)
    remote_path = root/'remote-input.jsonl'
    start, end = report['startedWall'], report['startedWall']+report['elapsedMs']
    remote = collections.defaultdict(list)
    if remote_path.exists():
        for row in read_lines(remote_path):
            if start <= row.get('handlerWall', row['wall']) <= end:
                remote[row['stimulus']].append(row)
    sends = {r['stimulus']: r for r in report['inputSends'] if r.get('stimulus') is not None}
    pairs = (
        ('endpoint_callback_to_comp_enqueue', 'input_dc_received', 'input_comp_queue'),
        ('comp_event_queue', 'input_comp_queue', 'input_comp_dequeue'),
        ('comp_route_to_input_queue', 'input_comp_dequeue', 'input_worker_queue'),
        ('endpoint_input_queue', 'input_worker_queue', 'input_worker_begin'),
        ('endpoint_input_admission', 'input_worker_begin', 'input_browser_assigned'),
        ('browser_rpc_lock', 'input_rpc_lock_wait', 'input_rpc_lock_acquired'),
        ('sdk_control_call', 'input_rpc_sdk_call', 'input_rpc_sdk_return'),
        ('sdk_call_to_browser_dispatch', 'input_rpc_sdk_call', 'input_browser_dispatch'),
        ('browser_dispatch_call', 'input_browser_dispatch', 'input_browser_dispatch_return'),
        ('browser_dispatch_return_to_sdk_return', 'input_browser_dispatch_return', 'input_rpc_sdk_return'),
    )
    samples = []
    origin = report['timeOrigin']
    for input_sample in report['inputSamples']:
        stimulus = input_sample['sequence']
        send = sends.get(stimulus)
        handlers = remote.get(stimulus, [])
        handler = handlers[0] if len(handlers) == 1 else None
        marker = input_sample.get('marker')
        peer_rows = by_client.get(int(send['sequence']), {}) if send else {}
        input_rows = next(iter(peer_rows.values())) if len(peer_rows) == 1 else []
        points = {r['event']: int(r['qpc']) for r in input_rows}
        assigned = next((r for r in input_rows if r['event'] == 'input_browser_assigned'), None)
        browser_sequence = int(assigned['browser_sequence']) if assigned else None
        attempts = []
        browser = {}
        if browser_sequence:
            rpc_rows = by_browser[browser_sequence]
            for stage, stage_rows in rpc_rows.items():
                if len(stage_rows) == 1:
                    points[stage] = int(stage_rows[0]['qpc'])
                if stage == 'input_rpc_sdk_call':
                    attempts = stage_rows
            pids = {int(r['producer_pid']) for r in attempts if 'producer_pid' in r}
            if len(pids) == 1:
                browser = browser_inputs.get((freq, next(iter(pids)), browser_sequence), {})
                points.update({stage: int(r['qpc']) for stage, r in browser.items()})
        segments = {name: (points[b]-points[a])*1000/freq for name, a, b in pairs if a in points and b in points}
        if send:
            segments['viewer_event_to_dc_send'] = send['at']-input_sample['eventAt']
            if 'input_dc_received' in points:
                segments['dc_send_to_endpoint_callback_wall'] = qpc_wall(points['input_dc_received'])-(origin+send['at'])
        if handler:
            handler_wall = handler.get('handlerWall', handler['wall'])
            if 'input_browser_dispatch' in points:
                stage = ('browser_dispatch_to_page_handler_wall' if 'handlerWall' in handler
                         else 'browser_dispatch_to_handler_draw_return_wall')
                segments[stage] = handler_wall-qpc_wall(points['input_browser_dispatch'])
            if 'handlerWall' in handler:
                segments['handler_entry_to_draw_return_wall'] = handler['wall']-handler_wall
            if marker:
                stage = ('page_handler_to_marker_observed_wall' if 'handlerWall' in handler
                         else 'handler_draw_return_to_marker_observed_wall')
                segments[stage] = marker['observedWall']-handler_wall
        samples.append(dict(stimulus=stimulus, clientSequence=send['sequence'] if send else None,
                            peer=next(iter(peer_rows)) if len(peer_rows) == 1 else None,
                            browserSequence=browser_sequence, rpcAttempts=len(attempts),
                            pageHandler=handler, pageHandlerMatches=len(handlers), browserStages=browser,
                            pointsQpc=points, segmentsMs=segments))
    names = sorted(set().union(*(r['segmentsMs'].keys() for r in samples)))
    return dict(samples=samples, stagesMs={name: dist([r['segmentsMs'].get(name) for r in samples])
                                           for name in names})


def analyze(root, profile=None):
    direct_path = root/(profile or 'video-profile.json')
    direct = json.loads(direct_path.read_text(encoding='utf-8-sig'))
    reports = {str(view['session']): direct for view in direct['actualLayout']['views']}
    osr_events = collections.defaultdict(list)
    osr_headers = {}
    browser_inputs = collections.defaultdict(dict)
    for path in (root/'browser-trace').glob('*.json'):
        doc = json.loads(path.read_text(encoding='utf-8-sig'))
        pid = int(doc['pid'])
        if doc.get('schema') == 'remotekit-osr-trace-v1':
            generation, frequency = int(doc['generation']), int(doc['qpc_frequency'])
            osr_headers[(pid, generation)] = {key: value for key, value in doc.items() if key != 'events'}
            for row in doc['events']:
                if 'browser_sequence' in row:
                    browser_inputs[(frequency, pid, int(row['browser_sequence']))][row['stage']] = row
                    continue
                identity = osr_identity(row, pid, generation)
                osr_events[(frequency, identity)].append((row['stage'], row))
    sdk = {}
    for path in (root/'server-trace').glob('sdk-*.jsonl'):
        rows = read_lines(path)
        sdk[(int(rows[0]['pid']), int(rows[0]['peer']))] = rows
    result = {'case': root.name, 'profile': direct_path.name, 'semantics':
              'Native stages are QPC observations; video rVFC and expectedDisplayTime are browser timestamps',
              'tenants': []}
    for path in sorted((root/'server-trace').glob('server-*.jsonl')):
        rows = read_lines(path)
        header = rows[0]
        report = reports.get(str(header['session']))
        if not report:
            continue
        freq = int(header['qpc_frequency'])
        wall = sorted((int(r['qpc']), float(r['unix_time_us'])/1000) for r in rows if r['event'] == 'clock_wall')
        wall_qpc = [r[0] for r in wall]
        def qpc_wall(qpc):
            n = max(0, min(len(wall)-1, bisect.bisect_left(wall_qpc, qpc)))
            return wall[n][1] + (qpc-wall[n][0])*1000/freq
        by_frame = collections.defaultdict(list)
        ready_by_frame, begins = {}, {}
        adapt_by_frame = collections.defaultdict(dict)
        by_cookie = collections.defaultdict(list)
        by_rtp = collections.defaultdict(dict)
        for r in rows:
            if 'frame_id' in r:
                by_frame[int(r['frame_id'])].append(r)
            if r['event'] == 'slot_ready_observed' and 'producer_pid' in r:
                ready_by_frame[int(r['frame_id'])] = r
            elif r['event'] == 'render_begin' and 'producer_pid' in r:
                begins[osr_identity(r)] = r
            elif r['event'].startswith('comp_adapt_'):
                adapt_by_frame[int(r['frame_id'])][r['event']] = int(r['qpc'])
            if 'cookie' in r:
                by_cookie[int(r['cookie'])].append(r)
            if 'rtp_timestamp' in r:
                by_rtp[(int(r.get('encoder', 0)), int(r['rtp_timestamp']))][r['event']] = r
        window_start, window_end = report['startedWall'], report['startedWall']+report['elapsedMs']
        raw_native = {int(r['rtpTimestamp']): r for r in report.get('rawVideoFrames', []) if 'rtpTimestamp' in r}
        markers = {int(r['rtp']): r for r in report.get('samples', []) if r.get('rtp') is not None}
        observation_stage = 'video_observation'
        receive_to_observation = f'receive_to_{observation_stage}'
        sdk_rows = sdk.get((int(header['pid']), next((int(r['peer']) for r in rows if 'peer' in r), 0)), [])
        sdk_events = collections.defaultdict(dict)
        sdk_submits = collections.defaultdict(list)
        for r in sdk_rows[1:]:
            sdk_events[(int(r['encoder']), int(r['rtp_timestamp']))][r['event']] = r
            if r['event'] == 'texture_submit': sdk_submits[int(r['frame_id'])].append(r)
        streams, samples = [], []
        native_presents = []
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
            points = {'encoded_return': int(end['qpc'])}
            if 'capture_qpc' in end:
                points['capture_end'] = int(end['capture_qpc'])
            ready = ready_by_frame.get(fid)
            planes = osr_points(points, ready, begins, osr_events, adapt_by_frame[fid], freq) if ready else []
            events = by_rtp[(encoder, rtp)]
            # VPP records have no encoder field; frame_id+input RTP disambiguate them.
            for r in by_frame[fid]:
                if int(r.get('rtp_timestamp', -1)) == rtp:
                    points[r['event']] = int(r['qpc'])
            for r in by_cookie[int(end.get('cookie', 0))]:
                if int(r.get('encoder', 0)) == encoder and r['event'].startswith(('mfx_submit', 'mfx_vpp_submit')):
                    points[r['event']] = int(r['qpc'])
            for name, row in sdk_events[(encoder, rtp)].items():
                points['sdk_'+name] = int(row['qpc'])
            submits = [r for r in sdk_submits[fid] if int(r['qpc']) <= points.get('sdk_encode_enter', 0)]
            if submits: points['sdk_texture_submit'] = int(submits[-1]['qpc'])
            pairs = [('sdk_texture_submit_to_encode_enter','sdk_texture_submit','sdk_encode_enter'),
                     ('worker_queue','worker_enqueue','worker_dequeue'),
                     ('vpp','vpp_submit','vpp_complete'),
                     ('vpp_blt_call','vpp_submit','vpp_blt_return'),
                     ('vpp_wait_call','vpp_wait_begin','vpp_wait_return'),
                     ('mfx_submit_to_complete','mfx_submit_begin','hardware_complete'),
                     ('hardware_complete_to_encoded_return','hardware_complete','encoded_return'),
                     ('capture_end_to_encoded_return','capture_end','encoded_return')]
            if ready:
                pairs.extend(OSR_SEGMENTS)
            segments = {name: (points[b]-points[a])*1000/freq if a in points and b in points else None for name,a,b in pairs}
            row = dict(frame_id=fid, input_rtp=rtp, wire_rtp=wire, pointsQpc=points, segmentsMs=segments)
            if ready:
                pid, generation, slot, fence = osr_identity(ready)
                row['source'] = dict(producerPid=pid, generation=generation, slot=slot, value=fence)
                row['planes'] = planes
            elif begins:
                missing['wire_without_osr_ready'] += 1
            native = raw_native.get(wire)
            if in_window:
                streams.append(row)
                if native:
                    origin = report['timeOrigin']
                    receive, presentation = native.get('receiveTime'), native.get('presentationTime')
                    native_stages = {}
                    if receive is not None:
                        native_stages['encoded_return_to_receive'] = origin+receive-end_wall
                    if receive is not None and presentation is not None:
                        native_stages['receive_to_compositor_submission'] = presentation-receive
                    if 'processingDuration' in native:
                        native_stages['decoder_processing'] = native['processingDuration']*1000
                    if presentation is not None and 'at' in native:
                        native_stages['compositor_submission_to_rvfc'] = native.get('at', native.get('now'))-presentation
                    row['videoStagesMs'] = native_stages
                    native_presents.append(native_stages)
            if wire not in markers:
                continue
            marker, native = markers[wire], raw_native.get(wire)
            if not native: missing['native_rtp'] += 1
            origin = report.get('timeOrigin')
            if origin is None: missing['client_time_origin'] += 1
            marker_segments = dict(segments)
            marker_segments[f'render_to_{observation_stage}'] = marker['renderToObservedMs']
            marker_segments[f'{observation_stage}_to_marker_complete'] = marker['markerCompletedAt']-marker['observedAt']
            marker_segments[receive_to_observation] = marker['observedAt']-native['receiveTime'] if native and 'receiveTime' in native else None
            render_ms = marker['renderToObservedMs']
            marker_segments['render_to_receive'] = (render_ms-marker_segments[receive_to_observation]
                if render_ms is not None and marker_segments[receive_to_observation] is not None else None)
            if native:
                marker_segments['native_processing_duration'] = native.get('processingDuration', 0)*1000 if 'processingDuration' in native else None
                marker_segments[f'native_presentation_to_{observation_stage}'] = marker['observedAt']-native['presentationTime'] if 'presentationTime' in native else None
                marker_segments['native_receive_to_presentation'] = native['presentationTime']-native['receiveTime'] if 'presentationTime' in native and 'receiveTime' in native else None
                if marker_segments['native_receive_to_presentation'] is not None and marker_segments['native_processing_duration'] is not None:
                    marker_segments['native_receive_to_presentation_minus_processing'] = marker_segments['native_receive_to_presentation']-marker_segments['native_processing_duration']
            if origin is not None and render_ms is not None:
                render_wall = origin+marker['observedAt']-marker['renderToObservedMs']
                marker_segments['render_to_capture_end'] = qpc_wall(points['capture_end'])-render_wall if 'capture_end' in points else None
                if ready and 'render_begin' in points:
                    marker_segments['render_to_comp_begin'] = qpc_wall(points['render_begin'])-render_wall
                marker_segments['encoded_return_to_receive'] = origin+native['receiveTime']-end_wall if native and 'receiveTime' in native else None
                if marker_segments['encoded_return_to_receive'] is not None and 'capture_end' in points:
                    marker_segments['closure_error'] = (marker_segments['render_to_capture_end']+segments['capture_end_to_encoded_return']+marker_segments['encoded_return_to_receive']+marker_segments[receive_to_observation]-marker['renderToObservedMs'])
            row = dict(row, marker=marker, native=native, segmentsMs=marker_segments)
            samples.append(row)
        all_names = set().union(*(r['segmentsMs'].keys() for r in streams+samples))
        summary = {name: dist([r['segmentsMs'].get(name) for r in streams]) for name in sorted(all_names)}
        sampled = {name: dist([r['segmentsMs'].get(name) for r in samples]) for name in sorted(all_names)}
        video_stages = {name: dist([r.get(name) for r in native_presents])
                        for name in sorted(set().union(*(r.keys() for r in native_presents)))}
        inputs = analyze_input(root, rows, browser_inputs, freq, qpc_wall, report)
        clock = report.get('clockSample')
        clock_validation = None
        if clock:
            clock_validation = dict(clock,
                meaning='Control wall-clock roundtrip bracket, separate from monotonic native QPC joins')
        missing['marker_without_server_wire'] = len(set(markers)-{r['wire_rtp'] for r in samples})
        osr_producers = sorted({osr_identity(r)[:2] for r in begins.values()})
        osr = None
        if osr_producers:
            in_window = lambda r: 'qpc' in r and window_start <= qpc_wall(int(r['qpc'])) <= window_end
            render_counts = collections.Counter(r['event'] for r in rows if in_window(r))
            rejected = collections.Counter(str(r['status']) for r in rows
                                           if r['event'] == 'render_reject' and in_window(r))
            osr = dict(
                traceHeaders=[osr_headers[key] for key in osr_producers if key in osr_headers],
                counts={name: render_counts[name] for name in ('render_begin', 'render_reject',
                        'render_wake', 'slot_ready_observed', 'worker_rates_requested')},
                rejectReasons=rejected,
                rateSpans=rate_spans(rows, freq, qpc_wall, window_start, window_end),
                missingRendBegin=sum('rend_begin' not in r['pointsQpc'] for r in streams if 'source' in r),
                missingAtlasSignal=sum('rend_atlas_signal_call' not in r['pointsQpc']
                                       for r in streams if 'source' in r))
        result['tenants'].append(dict(tenant=header['tenant'], session=header['session'], tenantIndex=report['tenantIndex'],
            serverHeader=header, osr=osr, input=inputs, videoStagesMs=video_stages,
            wireTimeline=streams, clockSample=clock, clockValidation=clock_validation, timeOrigin=report.get('timeOrigin'),
            wireFrames=len(streams), markerJoins=len(samples), missing=dict(missing), allWireStagesMs=summary,
            sampledStagesMs=sampled, samples=samples))
    output_name = f'server-trace-analysis-{direct_path.stem}.json' if profile else 'server-trace-analysis.json'
    (root/output_name).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    for tenant in result['tenants']:
        print(json.dumps(dict(case=root.name, tenant=tenant['tenantIndex'], wire=tenant['wireFrames'], markers=tenant['markerJoins'],
             missing=tenant['missing'], sampled=tenant['sampledStagesMs']), ensure_ascii=False))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', nargs='+', type=Path)
    parser.add_argument('--profile', help='Report filename within each case, e.g. video-profile-clean.json')
    args = parser.parse_args()
    if args.profile and (Path(args.profile).name != args.profile or Path(args.profile).suffix != '.json'):
        parser.error('--profile must be a JSON filename within the case')
    for case in args.cases:
        analyze(case, args.profile)
