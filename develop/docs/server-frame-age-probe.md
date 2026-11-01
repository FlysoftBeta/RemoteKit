# Same-RTP server frame-age probe

The large upstream age is inside Chromium capture and the GPU pipeline, with an additional receiver delay. The encoder API and network forwarding do not explain hundreds of milliseconds. The ready-gate experiment removes a confirmed endpoint GPU queue blockage, but does not improve the final four-tenant canvas rate or latency.

## Conditions and instrumentation

Release/component browser, actual UHD630/QSV, d1/TU1/VBR, unchanged congestion control and unset RTP playout delay. Each peer has an independent 24 Mbps downstream UDP relay and 5 ms delay each direction. Chrome 89 is headed in independent contexts, default client flags, DPR1, 5 s warmup and 20 s measurement. Canvas animation fixture SHA256 is `bee998b6276a4a3df0320d55f302be5dbcab60a7a79599170bbd5554dcc021c0`.

`REMOTEKIT_SERVER_TRACE` enables bounded endpoint/SDK records. Browser trace adds QPC, actual capture begin/end metadata and source publication serial. Endpoint `atlas_private_copy_*` bridges that source serial/generation to its independent cache frame cookie; worker/SDK input RTP then bridges to the actual wire RTP. Source leases still end after the real GPU fence; no shared ABI or steady frame IPC was added. JSON serialization happens after peer close.

`tools/analyze-streaming-server-trace.py CASE...` produces `CASE/server-trace-analysis.json`, with per-wire stage distributions, each sampled marker's QPC points/native metadata, missing joins and clock checks. The client now saves `timeOrigin`, `startedAt` and a performance/Date.now bracket. The new four-tenant cases join every valid marker to a successful server wire RTP. Date.now quantization is 1 ms; the measured wall/origin deltas fit that bound. The near-zero closure residual is arithmetic consistency, not an independent clock calibration.

## Initial baseline and trace overhead

| Case | Source FPS | Decode FPS | Canvas submissions/s | Physical 3D busy |
|---|---:|---:|---:|---:|
| 720×1 trace off | 53.55 | 53.29 | 31.94 | 65.98% |
| 720×1 trace on | 53.30 | 52.99 | 31.79 | 65.70% |
| 720×4 trace on, marker0 | 46.2–46.6 | 20.0–21.7 | 11.3–12.1 | 98.74% |
| 1080×4 trace on, marker0 | 19.6–19.8 | 12.4–12.6 | 9.1–9.6 | 99.21% |

The single-tenant off/on comparison uses the same executable. No material instrumentation loss appeared in this pair. Per-PID CPU and per-role/physical-engine values remain in each `resource-summary.json`; physical-engine busy includes scheduling and waiting, not just shader execution. The Intel engine named VideoDecode includes encoder work and is not classified as a receiver decoder from its name.

## What capture begin/end mean

Local official source sets capture begin immediately before reserving the frame buffer (`frame_sink_video_capturer_impl.cc:892`). It sets capture end on `OnFrameReadyForDelivery` after the completed CopyOutput result (`:1490`), before its ordered-delivery queue. The mappable ARGB route explicitly waits for GPU finished callbacks before returning the result (`skia_output_surface_impl_on_gpu.cc:1073–1096`). Consequently this interval contains buffer reservation, CopyOutput scheduling, GPU work and completion observation; it is not a GPU execution timestamp.

The old four-tenant 1080 marker case has capture duration p50 roughly 390–404 ms, p95 435–444 ms, and up to nine overlapping begin/end intervals per tenant. Four720 also reaches nine; single720 reaches one. Official capture design limit is ten in flight, with eleven pool buffers (`frame_sink_video_capturer_impl.h:174–176`). This proves substantial pipeline depth, not which GPU substage consumes it. The later same-bundle gate pair reaches five overlapping intervals and roughly 200–230 ms capture means. These cohorts remain separate; the cause of that changed source timing has not been established.

## Ready-gate A/B and complete sampled timeline

Both cases use service `eeeecf6700dd14f9e5dff35e5ef9c118ee430e8a8ae1efc99334e6929a1276db` and client bundle `8262ebf846419faf4f53e7003b7d5f90f6c7b6b9fa9c5cfeedd2d3c2666be601`. `REMOTEKIT_ATLAS_READY_GATE=1` observes ready completion before queuing the original GPU Wait/copy. It preserves slot/lease/fence semantics.

| Per-tenant stage | Gate off | Gate on |
|---|---:|---:|
| Marker render→capture begin, mean ms | 95–112 | 107–116 |
| Capture begin→end, mean ms | 201–231 | 181–223 |
| Capture end→encoded return, p50 ms | 125–141 | 61–98 |
| VPP wait, p50 ms | 41–46 | 4.7–7.4 |
| Encoded return→native last-packet receive, mean ms | 10–12 | 9–11 |
| Native receive→JS canvas draw return, mean ms | 289–483 | 537–687 |
| Decode FPS | 11.5–12.1 | 13.7–14.4 |
| Canvas submissions/s | 6.4–7.0 | 6.35–6.90 |
| Render→canvas draw return p95, ms | 906–1223 | 1133–1218 |

Use the JSON's same-frame means to close totals; individual stage percentiles cannot be added. VPP Blt CPU calls are about 1 ms; the old 40 ms VPP span is predominantly the actual fence wait. SDK texture submission→Encode and completion callback overhead are small. The new per-frame native processing/presentation fields split the receiver part only to the extent Chrome89 exposes; residual time is not labelled pure decoder or jitter-buffer time.

The confirmed local issue is a new not-yet-ready atlas GPU Wait blocking older ready work on the same endpoint immediate context. The gate improves that server segment and decode throughput. More frames then accumulate in receiver presentation: final latency and visible canvas throughput do not improve. Default behavior has not been changed by this experiment.

## Client direct-copy experiment

The opt-in single-plane route removes the intermediate atlas snapshot; it falls back for multiple planes, late metadata or no matching current renderer. Four1080 gives 6.65–7.18 submissions/s and p95 967–1311 ms, with no consistent latency improvement over its matching snapshot cohort. In the later single720 cohort both source rates are 31–32 rather than the earlier 53; snapshot gives 22 submissions/s and p95 405 ms, direct gives 30.5 and 156 ms. These results are not combined with the old 53 FPS cohort. The changed source cadence remains a separate observation; a false legacy high-resolution-timer flag alone does not identify its cause.

The direct720 endpoint trace is complete after explicit awaited `/api/rtc/close`; the matching snapshot720 trace is truncated and is marked missing. Its resource profiler also expired before the delayed direct720 run, so that run has no GPU/CPU result. The prepare tool now gives the profiler a 300 s horizon. The benchmark's old fire-and-forget disconnect was corrected to wait for the close response before destroying the context.

Canvas "paint" is the JS timestamp after `drawImage` returns. It is not GPU completion or physical display present. Marker readback/CRC is measured separately and can block subsequent callbacks. The four-tenant cases retain that cost, actual visibility and packet/relay counters in raw metrics.

## Reproducible evidence

- `develop/tmp/trace-720-t1-{off,on}`: instrumentation calibration.
- `develop/tmp/trace-{720,1080}-t4-marker0`: throughput and PID/engine baseline.
- `develop/tmp/trace-1080-t4-marker1`: old capture-depth cohort.
- `develop/tmp/trace-gate1080-{off,on}-clock/server-trace-analysis.json`: exact wall/performance/QPC joins and complete timeline.
- `develop/tmp/trace-direct1080-t4`, `trace-snapshot720-t1`, `trace-direct720-t1`: same-bundle client experiment, with the stated missing records.

The next discriminating capture measurement is an existing official GPU/Viz trace that separates CopyOutput queueing, GPU submission/execution and finished-callback observation. Capture concurrency/admission is another bounded candidate; changing it requires an explicit architecture choice. Neither the current trace nor engine utilization establishes a hardware latency floor.
