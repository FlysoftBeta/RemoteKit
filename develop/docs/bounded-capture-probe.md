# Bounded capture admission experiment

The cap reduces pending capture requests but does not improve this workload overall. It remains disabled by default. The later low-throughput cohort has long capture intervals even with one request pending; limiting the queue does not establish the duration of actual GPU execution.

## Implementation and reproduction

Patch `patches/0001-bounded-capture-pending.patch` adds the disabled `RemoteKitBoundedCapture` feature. `max_pending` is clamped to 1–10; the feature's default parameter is 2. The admission count is `next_capture_frame_number_ - next_delivery_frame_number_`, which includes completed requests waiting for ordered delivery. It does not confuse requests with consumer-held frames. Damage/content version are updated before admission is checked. A blocked last change is retained; freeing a slot schedules one weak, generation-safe refresh after the remaining minimum capture period. Stop cancels the timer and resets admission state. Frame resource/fence/lease completion behavior is unchanged.

Standard flags are passed using `endpoint_service --browser-enable-features=RemoteKitBoundedCapture:max_pending/2`. The formal prepare tool exposes `-CaptureMaxPending 1|2`; zero leaves the feature disabled. Actual browser command-line flags and measured callback interval overlaps are retained. The patch was checked by formal revert/status/apply and rebuilt with browser, demo and SDK. The independent endpoint CMake build and CTest passed.

All comparisons below use frozen service SHA256 `99b4df2f83a1de47464c8aa1e9eff18bcfaf7ab803e61fe7eaf7c4a9cb08460c`, the same compiled Viz feature, client bundle `6eeae285e6251afc76b43ff3b19526985a4775e0471e2b37744a76e294fb2011`, four 1920×1080/DPR1 pages, d1/TU1/VBR, unset playout extension and default client flags. Each peer has its own 24 Mbps/10 ms RTT relay budget. Each performance run has 5 s warmup and 20 s measurement. The successful performance cases have complete traces and resource sampling covering their measurement windows.

## Results

Renderer columns count JavaScript render calls, not captures. Capture callbacks can include resurrection; current browser traces do not directly label actual CopyOutput versus resurrection. Atlas publication, encoder completion and decode are separate stages in `develop/tmp/bounded-capture-summary.json`.

| Pending cap | Marker Hz | Renderer render/s | Capture callbacks/s | Decode/s | JS canvas submissions/s | Render→canvas p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| Disabled | 0 | 20.6–21.2 | 20.5–21.1 | 12.8–13.7 | 8.9–9.1 | Not sampled |
| 1 | 0 | 29.7–29.9 | 9.5–11.1 | 9.3–11.0 | 8.3–9.0 | Not sampled |
| 2 | 0 | 26.7–27.2 | 12.1–12.6 | 11.7–12.3 | 8.6–9.1 | Not sampled |
| Disabled | 1 | 20.1–20.4 | 20.1–20.4 | 11.7–12.4 | 8.0–8.5 | 1044–1092 |
| 1 | 1 | 46.5–48.0 | 1.55–1.65 | About 1.6 | 1.60–1.65 | 897–937 |
| 2 | 1 | 42.3–44.1 | 3.15–3.30 | About 3.2 | 3.15–3.30 | 893–1019 |
| 2 + ready gate + direct | 0 | 42.7–43.9 | 3.20–3.30 | About 3.2 | About 3.2 | Not sampled |

Successful capture begin/end interval overlaps reach exactly one or two in the enabled runs. Early marker0 capture p50 is 159–163 ms without admission limiting, 87–101 ms with cap1, and 124–135 ms with cap2. Later cap1/cap2 runs have capture p50 about 599–637 ms, matching their observed 1.6/3.2 callbacks/s. They do not have 46 new captures/s: the faster column is renderer JavaScript. The last marker0 combination also stays around 3.2 callbacks/s, so the later behavior cannot be attributed solely to marker readback.

The current trace cannot separate GPU scheduling, execution and finished-callback observation inside that capture interval. Physical-engine busy is not treated as shader execution time. Per-process CPU, per-role/physical-engine GPU counters, observer readback costs, native video metadata and same-wire stage distributions remain in each case directory.

## Resurrection and final-change checks

Official `CanResurrectFrame` requires matching content version and size. Each admission rewrites `capture_begin_time`, including resurrection. A resurrected frame takes the synchronous delivery path rather than CopyOutput, so a long interval is not explained by simply retaining its old begin timestamp. Direct request/resurrection classification is left missing until an official trace records those events.

The first static check used renderer-call counts as the expected pixel sequence and found a 152/153 discrepancy in one tenant. That is not sufficient evidence of a lost frame and is retained as inconclusive.

The corrected source probe records the actual marker arguments immediately after `drawMarker` returns successfully. It does not read back or flush the source GPU. In `develop/tmp/bounded-stop-cap2-proof`, the final source marker sequences are 154, 143, 145 and 145; synchronous client CRC reads match all four sequences and their modulo-32-bit source timestamps. Closing and reopening the same-size output advances generation 1→2 and produces a fresh wire RTP. This confirms the observed final source marker was delivered and the output can restart. It does not turn the negative throughput result into a recommended default.

## Evidence and tooling

- `develop/tmp/bounded-capture-summary.json`: all seven successful performance cases and separated frame stages.
- `develop/tmp/bounded1080-{default,cap2}-{m0,m1}` and `bounded1080-cap1-{m0-v2,m1}`: raw metrics, server/SDK/browser traces and resource summaries.
- `develop/tmp/bounded1080-cap2-combo-m0`: the already-started combination; no further combination sweep was run.
- `develop/tmp/bounded-stop-cap2-proof`: actual source marker and client CRC evidence, generation restart.

Two initial cap1 launches failed before video because Windows PowerShell 5 serialized a JSON-array roundtrip as `{value,Count}`. They are not performance results. The prepare tool now keeps a native argument array throughout and saves the actual endpoint arguments for review.

No encoding or default capture policy was changed. The next approved comparison is a short official Viz/GPU trace and the separately identified CSS compositor fixture, preserving the canvas workload results above.
