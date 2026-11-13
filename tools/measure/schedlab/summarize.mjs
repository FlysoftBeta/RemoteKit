import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const rows = (path) => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p,
    low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}
export function distribution(values) {
  values = values.filter(Number.isFinite);
  return {
    samples: values.length,
    mean: mean(values),
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}
function windowsOf(windows, start, end) {
  const result = [];
  for (const [low, high] of windows
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && low <= last[1]) last[1] = Math.max(last[1], high);
    else result.push([low, high]);
  }
  return result;
}
const insideWindows = (at, windows) => windows.some(([a, b]) => at >= a && at < b);
function stutter(frames, windows, duration, intervalAt) {
  let gaps = 0,
    spikes = 0;
  const rolling = [];
  for (let i = 0; i < frames.length; ++i) {
    const current = frames[i],
      previous = frames[i - 1];
    if (
      previous &&
      windows.some(([a, b]) => previous.arrival >= a && current.arrival < b) &&
      current.arrival - previous.arrival > 1.5 * intervalAt(current.arrival)
    )
      ++gaps;
    while (rolling.length && rolling[0].arrival < current.arrival - 1000) rolling.shift();
    const median = quantile(rolling.map((frame) => frame.latency).filter(Number.isFinite), 0.5);
    if (median !== null && current.latency > median + 8.3) ++spikes;
    rolling.push(current);
  }
  return {
    arrivalGaps: gaps,
    arrivalGapsPerMinute: (gaps * 60000) / duration,
    latencySpikes: spikes,
    latencySpikesPerMinute: (spikes * 60000) / duration,
  };
}
function counterDelta(points, field, start, end) {
  points = points.filter((point) => Number.isFinite(point[field]));
  const nearest = (time) =>
    points.reduce(
      (best, point) =>
        !best || Math.abs(point.epochMs - time) < Math.abs(best.epochMs - time) ? point : best,
      null,
    );
  const a = nearest(start),
    b = nearest(end);
  return a && b ? b[field] - a[field] : null;
}
function senderMetrics(snapshots, start, end) {
  const points = snapshots.flatMap((row) =>
    (row.encoder.senderRtcStats?.outbound ?? [])
      .filter((stream) => stream.kind === 'video')
      .map((stream) => ({ ...stream, epochMs: row.epochMs })),
  );
  const delta = (field) => counterDelta(points, field, start, end);
  const delay = delta('totalPacketSendDelay'),
    packets = delta('packetsSent');
  return {
    packetSendDelaySeconds: delay,
    meanPacketSendDelayMs: packets > 0 && delay !== null ? (delay * 1000) / packets : null,
    packetsSent: packets,
    retransmittedPackets: delta('retransmittedPacketsSent'),
    retransmittedBytes: delta('retransmittedBytesSent'),
    targetBitrateBps: distribution(
      points.filter((row) => row.epochMs >= start && row.epochMs < end).map((row) => row.targetBitrate),
    ),
  };
}
function receiverMetrics(records, start, end) {
  const points = records
    .filter((row) => row.type === 'stats')
    .flatMap((row) =>
      row.records
        .filter((item) => item.type === 'inbound-rtp' && (item.kind ?? item.mediaType) === 'video')
        .map((item) => ({ ...item, epochMs: row.epochMs })),
    );
  const delta = (field) => counterDelta(points, field, start, end);
  const decoded = delta('framesDecoded'),
    decodeTime = delta('totalDecodeTime');
  const jitterDelay = delta('jitterBufferDelay'),
    emitted = delta('jitterBufferEmittedCount');
  return {
    framesDecoded: decoded,
    framesDropped: delta('framesDropped'),
    freezeCount: delta('freezeCount'),
    meanDecodeMs: decoded > 0 && decodeTime !== null ? (decodeTime * 1000) / decoded : null,
    meanJitterBufferMs: emitted > 0 && jitterDelay !== null ? (jitterDelay * 1000) / emitted : null,
    jitterMs: distribution(
      points.filter((row) => row.epochMs >= start && row.epochMs < end).map((row) => row.jitter * 1000),
    ),
    decoderImplementations: [...new Set(points.map((row) => row.decoderImplementation).filter(Boolean))],
  };
}
function admissionMetrics(trace, epoch, inside) {
  return Object.fromEntries(
    ['normal', 'interactive'].map((kind) => {
      const events = trace.filter((row) => row.admission_class === kind && inside(epoch(row)));
      const grants = events.filter((row) => row.event === 'admission_grant');
      return [
        kind,
        {
          grants: grants.length,
          denials: events.filter((row) => row.event === 'admission_wait').length,
          waitMs: distribution(grants.map((row) => row.permit_wait_us / 1000)),
        },
      ];
    }),
  );
}
function metricRow(label, value) {
  const n = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
  return `| ${label} | ${n(value.latencyMs.p50)} | ${n(value.latencyMs.p95)} | ${n(value.latencyMs.p99)} | ${n(value.latencyMs.max)} | ${n(value.scrollStartMs?.p95)} | ${n(value.scrollFps)} | ${n(value.videoFps)} |`;
}
export function summaryTable(summaries) {
  return [
    '| Run | L50 ms | L95 ms | L99 ms | Lmax ms | Scroll start p95 ms | Scroll FPS | Video FPS |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summaries.map(({ label, aggregate }) => metricRow(label, aggregate)),
  ].join('\n');
}
export function summarize(directory) {
  const run = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
  const start = run.measurementStart,
    end = run.measurementEnd,
    duration = end - start;
  if (!start || !end || duration <= 0) throw Error('Run has no measurement window');
  const inside = (at) => at >= start && at < end;
  const receiver = rows(join(directory, 'receiver.jsonl'));
  const fixture = rows(join(directory, 'fixtures.jsonl'));
  const resources = rows(join(directory, 'resources.jsonl')).filter((row) => inside(row.epochMs));
  const tenants = [],
    allFrames = [],
    allEncoded = [],
    admissions = { normal: [], interactive: [] };
  const files = readdirSync(directory);
  for (const spec of run.tenants) {
    const id = spec.tenant;
    const trace = rows(
      join(
        directory,
        files.find((name) => new RegExp(`^server-\\d+-session-${id}\\.jsonl$`).test(name)),
      ),
    );
    const anchors = trace.filter((row) => row.event === 'clock_wall');
    if (!anchors.length) throw Error(`Tenant ${id}: no wall clock calibration`);
    const epoch = (row) => {
      const anchor = anchors.reduce((a, b) =>
        Math.abs(a.qpc - row.qpc) < Math.abs(b.qpc - row.qpc) ? a : b,
      );
      return (
        anchor.unix_time_us / 1000 +
        ((row.qpc - anchor.qpc) * 1000) / (row.qpc_frequency ?? anchor.qpc_frequency)
      );
    };
    const identity = (row) =>
      row.generation !== undefined && row.slot !== undefined && row.fence !== undefined
        ? `${row.generation}/${row.slot}/${row.fence}`
        : null;
    const begins = new Map(
      trace.filter((row) => row.event === 'render_begin').map((row) => [identity(row), row]),
    );
    const frames = new Map();
    const cookies = new Map();
    for (const row of trace) {
      if (!row.frame_id) continue;
      if (!frames.has(row.frame_id))
        frames.set(row.frame_id, { tenant: id, kind: spec.kind, frameId: row.frame_id, events: {} });
      const frame = frames.get(row.frame_id);
      if (row.event === 'slot_ready_observed') {
        const begin = begins.get(identity(row));
        if (begin) frame.begin = epoch(begin);
      }
      frame.events[row.event] = row;
      if (row.encoder && row.cookie) cookies.set(`${row.encoder}/${row.cookie}`, frame);
      if (row.event === 'encoded_return' && row.status === 0) {
        frame.rtpTimestamp = row.wire_rtp_timestamp;
        frame.encodedBytes = row.bytes;
        frame.qp = row.qp;
      }
    }
    for (const row of trace.filter((row) => row.brc)) {
      const frame = cookies.get(`${row.encoder}/${row.cookie}`);
      if (frame && frame.qp === undefined) frame.qp = row.brc.qp;
    }
    const encodedLog = rows(join(directory, `encoded-${id}.jsonl`));
    for (const row of encodedLog) {
      const frame = frames.get(row.frameId);
      if (frame) frame.key = row.key;
    }
    const arrivals = receiver
      .filter((row) => row.tenant === id && row.type === 'frames')
      .flatMap((row) => row.frames);
    const byRtp = new Map(arrivals.map((row) => [row.rtpTimestamp >>> 0, row]));
    const snapshots = rows(join(directory, `snapshots-${id}.jsonl`));
    const records = receiver.filter((row) => row.tenant === id);
    const commands = fixture.filter((row) => row.tenant === id);
    const windows =
      spec.kind === 'V'
        ? [[start, end]]
        : windowsOf(
            commands.filter((row) => row.type === 'scrollEnd').map((row) => [row.start, row.end + 100]),
            start,
            end,
          );
    const joined = [];
    let encodedCount = 0,
      matchedCount = 0;
    for (const frame of frames.values()) {
      const encoded = frame.events.encoded_return;
      const arrival = frame.rtpTimestamp === undefined ? undefined : byRtp.get(frame.rtpTimestamp >>> 0);
      if (encoded?.status === 0 && inside(epoch(encoded))) {
        ++encodedCount;
        if (arrival) ++matchedCount;
      }
      if (arrival && Number.isFinite(frame.begin)) {
        Object.assign(frame, arrival);
        frame.latency = frame.arrival - frame.begin;
        if (inside(frame.arrival)) joined.push(frame);
      }
    }
    joined.sort((a, b) => a.arrival - b.arrival);
    const firstAfter = (at) =>
      [...frames.values()]
        .filter((row) => Number.isFinite(row.arrival) && row.begin >= at && row.begin < at + 1500)
        .sort((a, b) => a.begin - b.begin)[0];
    const scrolls = commands
      .filter((row) => row.type === 'scrollStart' && inside(row.start))
      .map((row) => {
        const frame = firstAfter(row.start);
        return {
          command: row.command,
          start: row.start,
          firstBegin: frame?.begin ?? null,
          latency: frame?.latency ?? null,
          responseMs: frame ? frame.arrival - row.start : null,
        };
      });
    const updates = commands
      .filter((row) => row.type === 'contentUpdate' && inside(row.epochMs))
      .map((row) => {
        const frame = firstAfter(row.epochMs);
        return {
          update: row.update,
          epochMs: row.epochMs,
          responseMs: frame ? frame.arrival - row.epochMs : null,
        };
      });
    const motionDuration = windows.reduce((n, [a, b]) => n + b - a, 0);
    const motionFrames = joined.filter((row) => insideWindows(row.arrival, windows)).length;
    const admission = admissionMetrics(trace, epoch, inside);
    for (const kind of ['normal', 'interactive'])
      admissions[kind].push(
        ...trace
          .filter(
            (row) => row.event === 'admission_grant' && row.admission_class === kind && inside(epoch(row)),
          )
          .map((row) => row.permit_wait_us / 1000),
      );
    const measuredEncoded = [...frames.values()].filter(
      (row) => row.events.encoded_return?.status === 0 && inside(epoch(row.events.encoded_return)),
    );
    allEncoded.push(...measuredEncoded);
    const bytes = measuredEncoded.reduce((n, row) => n + (row.encodedBytes ?? 0), 0);
    const result = {
      tenant: id,
      kind: spec.kind,
      deliveredFrames: joined.length,
      deliveredFps: (joined.length * 1000) / duration,
      scrollFps: spec.kind.startsWith('S') && motionDuration ? (motionFrames * 1000) / motionDuration : null,
      videoFps: spec.kind === 'V' ? (joined.length * 1000) / duration : null,
      latencyMs: distribution(joined.map((row) => row.latency)),
      scrollStartMs: distribution(scrolls.map((row) => row.latency)),
      scrollResponseMs: distribution(scrolls.map((row) => row.responseMs)),
      updateContentMs: distribution(updates.map((row) => row.responseMs)),
      scrolls,
      updates,
      encoder: {
        bytes,
        meanBitrateMbps: (bytes * 8) / duration / 1000,
        frameBytes: distribution(measuredEncoded.map((row) => row.encodedBytes)),
        qp: distribution(measuredEncoded.map((row) => row.qp)),
        keyframes: measuredEncoded.filter((row) => row.key).length,
      },
      admission,
      stutter: stutter(
        joined,
        windows,
        duration,
        (at) => 1000 / (snapshots.filter((row) => row.epochMs <= at).at(-1)?.engine.targetFps || 60),
      ),
      sender: senderMetrics(snapshots, start, end),
      receiver: receiverMetrics(records, start, end),
      join: {
        encoded: encodedCount,
        matched: matchedCount,
        fraction: encodedCount ? matchedCount / encodedCount : null,
      },
      trace: {
        overwritten: trace.find((row) => row.event === 'trace_header')?.records_overwritten ?? 0,
        clockUncertaintyUs: distribution(anchors.map((row) => row.bracket_uncertainty_us)),
      },
    };
    tenants.push(result);
    allFrames.push(...joined);
    writeFileSync(
      join(directory, `frames-${id}.jsonl`),
      joined.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  }
  const byKind = Object.fromEntries(
    [...new Set(tenants.map((row) => row.kind))].map((kind) => {
      const frames = allFrames.filter((row) => row.kind === kind);
      const group = tenants.filter((row) => row.kind === kind);
      const encoded = allEncoded.filter((row) => row.kind === kind);
      return [
        kind,
        {
          latencyMs: distribution(frames.map((row) => row.latency)),
          encoderBytes: group.reduce((n, row) => n + row.encoder.bytes, 0),
          qp: distribution(encoded.map((row) => row.qp)),
          frameBytes: distribution(encoded.map((row) => row.encodedBytes)),
        },
      ];
    }),
  );
  const gpu = {};
  for (const engine of ['3D', 'VideoDecode', 'VideoProcessing', 'VideoEncode', 'Copy']) {
    const samples = resources
      .filter((row) => row.gpuValid)
      .flatMap((row) => {
        const matches = row.gpu.filter((item) => {
          const [high, low] = run.adapter.split(',').map(Number);
          const luid = `luid_0x${(high >>> 0).toString(16).padStart(8, '0')}_0x${(low >>> 0).toString(16).padStart(8, '0')}`;
          return item.engine === engine && item.instance.toLowerCase().includes(luid);
        });
        return matches.length ? [matches.reduce((n, item) => n + item.percent, 0)] : [];
      });
    gpu[engine] = distribution(samples);
  }
  const processGroups = [
    ...new Set(resources.flatMap((row) => row.cpu.map((item) => item.group.split('/')[0]))),
  ];
  const processes = Object.fromEntries(
    processGroups.map((group) => [
      group,
      Object.fromEntries(
        [
          ['cores', 'cores'],
          ['privateBytes', 'privateBytes'],
          ['workingSetBytes', 'workingSetBytes'],
        ].map(([key, field]) => [
          key,
          distribution(
            resources.map((row) =>
              row.cpu
                .filter((item) => item.group === group || item.group.startsWith(group + '/'))
                .reduce((n, item) => n + (item[field] ?? 0), 0),
            ),
          ),
        ]),
      ),
    ]),
  );
  const aggregate = {
    latencyMs: distribution(allFrames.map((row) => row.latency)),
    scrollStartMs: distribution(tenants.flatMap((row) => row.scrolls.map((scroll) => scroll.latency))),
    scrollResponseMs: distribution(tenants.flatMap((row) => row.scrolls.map((scroll) => scroll.responseMs))),
    scrollFps: mean(tenants.map((row) => row.scrollFps).filter(Number.isFinite)),
    videoFps: mean(tenants.map((row) => row.videoFps).filter(Number.isFinite)),
    updateContentMs: distribution(tenants.flatMap((row) => row.updates.map((update) => update.responseMs))),
    arrivalGapsPerMinute: tenants.reduce((n, row) => n + row.stutter.arrivalGapsPerMinute, 0),
    latencySpikesPerMinute: tenants.reduce((n, row) => n + row.stutter.latencySpikesPerMinute, 0),
    admission: Object.fromEntries(
      ['normal', 'interactive'].map((kind) => [
        kind,
        {
          grants: tenants.reduce((n, row) => n + row.admission[kind].grants, 0),
          denials: tenants.reduce((n, row) => n + row.admission[kind].denials, 0),
          waitMs: distribution(admissions[kind]),
        },
      ]),
    ),
    gpu,
    processes,
  };
  const summary = {
    label: run.label,
    case: {
      geometry: run.options?.geometry ?? 'F',
      count: run.count,
      mix: run.tenants.map((row) => row.kind),
      measurementStart: start,
      measurementEnd: end,
      durationMs: duration,
    },
    aggregate,
    byKind,
    tenants,
    definitions: {
      latency:
        'Receiver encoded-frame arrival epoch minus Comp Begin epoch, joined by wire RTP timestamp; wall clocks calibrated by nearest QPC anchor.',
      quantiles: 'Linear interpolation at (N - 1) * percentile.',
      scrollStart:
        'Latency of the first delivered frame whose Comp Begin follows each scroll start within 1500ms; response is arrival minus scroll start.',
      updateContent:
        'First delivered frame whose Comp Begin follows contentUpdate within 1500ms: arrival minus contentUpdate.',
      motion:
        'Scroll start through scrollEnd + 100ms, clipped and merged; video is continuous. FPS counts arrivals within these windows.',
      stutter:
        'Arrival gaps >1.5 target intervals in the same motion window; latency spikes > preceding 1s rolling median +8.3ms; per measurement minute.',
      admission:
        'Per-class admission_grant and admission_wait events during measurement; wait quantiles over granted permits, in milliseconds.',
      transport:
        'Cumulative stats deltas nearest measurement boundaries; mean packet send delay per packet, decode time per frame, jitter buffer delay per emitted frame.',
      gpu: 'Sum of valid GPU Engine counters for the ready-message LUID, including external activity; missing counters excluded, never zero.',
      processes:
        'GetProcessTimes and process memory for each owned tree; bench excludes explicitly registered Browser/receiver roots.',
    },
  };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const lines = [
    `# ${run.label}`,
    '',
    summaryTable([
      { label: run.label, aggregate },
      ...tenants.map((row) => ({ label: `${row.tenant} ${row.kind}`, aggregate: row })),
    ]),
    '',
    '| Class | Grants | Denials | Wait p50 ms | Wait p95 ms |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [kind, row] of Object.entries(aggregate.admission))
    lines.push(
      `| ${kind} | ${row.grants} | ${row.denials} | ${row.waitMs.p50 ?? '-'} | ${row.waitMs.p95 ?? '-'} |`,
    );
  lines.push(
    '',
    '```json',
    JSON.stringify(
      {
        byKind,
        gpu,
        processes,
        tenants: tenants.map((row) => ({ tenant: row.tenant, sender: row.sender, receiver: row.receiver })),
        definitions: summary.definitions,
      },
      null,
      2,
    ),
    '```',
    '',
  );
  writeFileSync(join(directory, 'summary.md'), lines.join('\n'));
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(summarize(resolve(process.argv[2])), null, 2));
}
