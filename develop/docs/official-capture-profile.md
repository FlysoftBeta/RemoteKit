# Official capture profile: measured stages and remaining gap

The slow capture is an asynchronous CopyOutput request lifetime. It is not hundreds of milliseconds of CPU copying. Existing GPU timers cover renderer contexts, so this trace does not yet identify the actual GPU interval for that particular CopyOutput. Completion-check tasks also show long post-to-run delays; their contribution to this request's latency is not yet quantified.

## Controlled workload and probe impact

All three cases use four 1920×1080/DPR1 pages, default Chrome89 flags, snapshot rendering, disabled capture cap and ready gate, d1/TU1/VBR, unset RTP playout delay, and independent 24 Mbps/10 ms RTT peer budgets. Service is `1ff67332346267a3e4dbb1f4ccec0050347cdeaac9945d9a83cb188d4f4202b6`; client bundle is `9e067b56d3b20de4351b7636e3c7d589a1b54f5720e4d2540435433634e146e4`. The later focus-only client build is not substituted into these cases.

| Case | Renderer JS render/s | Decode/s | JS canvas draw submissions/s | Capture begin→end p50 ms |
|---|---:|---:|---:|---:|
| Canvas, official trace off | 20.4–20.7 | 12.6–13.2 | 9.0–9.3 | 394–398 |
| Canvas, official trace on | 19.6–19.8 | 11.6–12.2 | 8.3–9.1 | 386–411 |
| CSS compositor, trace off | 23.1–24.1 | 11.5–12.1 | 8.1–9.0 | 327–354 |

The official trace affects load; these are diagnostic results, not an improvement. It starts on browser launch and stops after 16 seconds. Sessions 1/2 finish tracing before the formal client sample window; sessions 3/4 overlap approximately 3.5/8.5 seconds of that window. The analyzer keeps full-startup and overlapping-window statistics separate.

The CSS source is genuinely different: every served record identifies `dom-compositor-scroll-v1`, original HTML SHA256 `099400e36c57128ffd39e472c49bdbc05cc475684e6484f4c2d8adde0c23b5ea`. Saved served HTML and hashes are in `official-css-off/source-trace`. This workload improves capture duration modestly but does not remove the slow capture or improve final throughput. It does not replace the canvas workload results.

Per-PID CPU and per-role/physical-engine GPU load are in each case's `resource-summary.json`. Engine busy is not equated with shader execution; the Intel VideoDecode engine name is not assumed to mean only receiver decoding.

## A concrete slow capture

`official-canvas-on/official-trace/session-4-6064690767147.json`, capture counter **153**, GPU process **14232**. It matches browser **29876** `source_counter=153`; metadata begin and the official Capture begin differ by 176 µs. Times below are relative to metadata begin `606479730411 µs`.

| Point | Relative ms | Reliable association |
|---|---:|---|
| Capture metadata begin, before frame reservation | 0 | Browser metadata and source counter |
| Official Capture begin | 0.176 | Counter 153, Viz thread 8948 |
| CopyOutputRequest construction | 0.232 | Same thread, immediately inside this Capture call |
| GPU-thread CopyOutput dispatch | Unresolved | Five candidate tasks occur during the request; no request identifier in those events |
| Actual GPU execution for this copy | Missing | Existing device markers name renderer contexts, not this copy |
| CopyOutputRequest SendResult | 304.455 | The same request's pointer-based asynchronous track ends successfully |
| Capture metadata end / result processed | 307.611 | Counter 153 |
| Browser capture callback | 308.388 | Counter 153, browser QPC |

The request's lifetime is **304.223 ms**. Result processing to metadata end is **3.156 ms**, and delivery to the browser callback adds **0.777 ms**. The five GPU-thread CPU tasks last 1.2–2.8 ms; choosing one as this request's dispatch would be an unsupported inference. In the overlapping steady window, request construction after Capture begin is about 0.03 ms and result-to-Capture-end is about 1 ms. The large interval is before result delivery.

`UsingResurrectedFrame` occurs zero times in these official traces. This directly classifies this workload; it does not retroactively label every callback in the earlier cap experiments as a new CopyOutput.

## Completion-check scheduling

The official task arguments identify `ScheduleDelayedGPUTaskFromGPUThread`, policy `FLEXIBLE_NO_SOONER`, requested delay **2000 µs**. Exact `toplevel.flow` IDs join each post to its run, rather than interpreting gaps between separate runs as queue delay.

For session4's overlapping window, all 205 tasks match: post→run p50 **47.092 ms**, p95 **61.074 ms**, max **183.495 ms**. The CPU task body has p50 approximately **0.022 ms**. Example flow **38019** posts at `606482531587 µs` and runs at `606482582487 µs`: **50.9 ms** elapsed, **48.9 ms beyond the requested delay**.

This is measured scheduling delay. It does not reveal when the copy's GPU work actually became ready, so it cannot alone explain the full 304 ms request. The current delayed-work site uses an ordinary two-millisecond `PostDelayedTask`; no timer/poll policy has been changed.

## Next diagnostic points, without changing behavior

The next approved patch will use one request identity through creation/capture counter, GPU dispatch, FlushSurface entry/return, actual submit branch/return, submitted callback, finished callback/SendResult and CheckAsyncWorkCompletion. It will record backend and semaphore count.

Ganesh exposes `supportedGpuStats`, `GrFlushInfo::fGpuStatsFlags`, `fFinishedWithStatsProc` and `fSubmittedProc`. Supported elapsed stats describe this flush batch and can include earlier unflushed work; they are not automatically pure-copy execution. Unsupported timing will stay missing. Callback wrappers must forward the original finished callback exactly once and retain its existing ownership/completion semantics.

One relevant branch is visible in local source: `FlushAndSubmitCopyOutput` explicitly calls Ganesh `submit()` only when end semaphores are nonempty. The trace does not record the actual backend, semaphore count or submission callback for this request. That condition is a profiling target, not evidence to force a submit or change synchronization.

## Reproduction and artifacts

`tools/prepare-streaming-case.ps1 -OfficialTrace` passes standard startup tracing flags into an independent case directory. The 32 MiB trace buffer expands to 47–72 MB JSON per session. Native filenames include Session and launch QPC to avoid restart overwrite. `tools/analyze-official-capture-trace.py CASE` produces `official-trace-summary.json` and selected event timelines, including explicit flow pairs and source-counter checks.

The three cases are `develop/tmp/official-canvas-off`, `official-canvas-on`, and `official-css-off`. The full official traces and generated analysis remain under `develop/tmp`; no source image readback or global display/power/session change was added.
