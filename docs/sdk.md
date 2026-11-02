# RemoteKit C ABI SDK

The SDK is built by Chromium GN; its consumer is a separate CMake project.
Consumers include `remotekit_sdk.h` and, for streaming, `remotekit_rtc.h`, and link the DLL import library. No
Chromium, libc++, Abseil, or WebRTC C++ types cross the boundary.

The SDK provides a local binary Mojo message-pipe roundtrip, isolated named-channel
JSON control of the browser process, and WebRTC PeerConnection/SDP/ICE/DataChannel
through `remotekit_rtc.h`. A custom H.264 encoder factory calls endpoint-owned
hardware encoders through C callbacks. Browser playback-target PCM is submitted
through the audio export and sent as Opus; this is not system audio capture.

The Windows client also uses worker-thread `control_open_atlas` and
`control_command_token` helpers. Atlas setup returns caller-owned mapping,
ready/consumed fence, and three texture handles, already duplicated into this
process. The mapping ABI is exported as `include/remotekit/shared_atlas.h`.
Frame polling and GPU waits do not call Mojo. `BUSY` means an operation was not
accepted; retry only with the same valid token/sequence within a deadline.
Windows scan-code and DomKey helpers retain the native layout. The caller keeps
the DLL loaded until SDK shutdown and the caller thread's TLS cleanup finish.
The registry lock covers lookup and lifecycle changes only. Each control channel
serializes its own requests; an operation lease keeps the channel alive while
close cancels pending work and shutdown drains active operations. A slow channel
does not hold the registry lock across its transport wait.

From the repository root, apply the patch manifest and build/export the SDK:

```powershell
python3 tools/patchset.py --chromium-root C:/src/chromium/src apply
python3 tools/chromium.py build --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination C:/tmp/remotekit-sdk
```

The export contains `include/remotekit_sdk.h`, `lib/remotekit_sdk.lib`, and
`bin/remotekit_sdk.dll` plus every file in the GN-generated
`remotekit_sdk.runtime_deps`. A component build also requires the dependency DLLs
in that manifest; copy the complete `bin` tree alongside the consumer. Do not
assume the main DLL is self-contained. A non-component GN build may reduce that
runtime set while retaining the same C ABI.

`manifest.json` records Chromium HEAD, the SHA-256 of `args.gn`, actual PE
architecture, compiler identity, component/runtime layout, and the exported API
scope. The exporter requires Git and the Chromium clang-cl binary
from the build source tree.

From a Visual Studio developer shell, compile and run the standalone consumer:

```powershell
cmake -S sdk -B build/sdk-smoke -G Ninja -DSDK_ROOT=C:/tmp/remotekit-sdk
cmake --build build/sdk-smoke
ctest --test-dir build/sdk-smoke --output-on-failure
```

On this workspace's VS18 Community installation, `tools\verify-sdk.cmd` runs the same
steps with the bundled CMake/Ninja; its optional first argument is the exported
SDK directory and defaults to `sdk/dist/dev`.

The smoke program initializes the SDK, verifies a binary payload including NUL
and 0xff in both directions through a local pipe, probes the WebRTC clock, and
shuts down. It also checks empty messages, invalid arguments, and terminal
shutdown behavior. The host must call shutdown before unloading the DLL. Shutdown is
terminal, and initialization is idempotent before shutdown. These lifecycle
calls are for a standalone process; do not initialize a second Mojo runtime
inside an existing `ContentMain` process. Initialization starts an IO thread and
ScopedIPCSupport for control connections. Shutdown closes all channels, releases
IPC support, stops the IO thread, and shuts down the core before AtExit cleanup.

`remotekit_control_smoke CHANNEL_NAME` sends one UTF-8 JSON snapshot request to a
browser launched with `--control-channel=CHANNEL_NAME` and prints the raw reply.
`remotekit_control_client CHANNEL_NAME` connects once and exchanges newline-delimited
requests/replies through stdin/stdout until EOF. Diagnostics go to stderr and any
transport error causes a nonzero exit. Both clients include only the SDK C header.

The independent client uses IsolatedConnection, so the browser's ContentMain
broker graph is not merged with the SDK's broker graph. The channel name is
ASCII `[A-Za-z0-9_.-]`, 1..128 bytes. Connect can wait for the operating system's
named-pipe timeout; all control calls belong on a worker thread, never a UI thread.

`control_request` exchanges one raw message each way, with a 1 MiB limit and an
active-request timeout of 1..30000ms. The browser validates JSON and UTF-8. Calls
on the same channel are serialized; different channels can use separate worker
threads. A transport failure on a valid channel, including timeout or an undersized response buffer, closes
and invalidates that handle. Reconnect before retrying. BUFFER_TOO_SMALL reports
the required size but discards that connection, preventing an old reply from
being mistaken for the response to another request. Successful replies are not
NUL-terminated. A structured Browser application rejection (`ok:false`) is still
a successful transport exchange and does not invalidate the channel. Browser
responses exceeding the protocol budget return a bounded `response_too_large`
application error instead of intentionally breaking a healthy connection.

Verified on official Chromium `157.0.8103.15`, x64 component build: GN shared
library linked successfully, exporter copied the full runtime manifest, and an
independent MSVC 19.51 CMake consumer linked and passed CTest (1/1). Only the pure
C SDK header was included by the consumer.

## Streaming ownership

The RTC interface uses ABI version 2; the original control SDK remains version 1.
RTC creation rejects a mismatched ABI. Shared atlas metadata is also version 2
(`SharedAtlasView` 112 bytes, mapping 7296 bytes), separating page DPR from atlas
pixels per DIP. Rebuild browser, SDK and endpoint together when updating these interfaces.

The endpoint submits an immutable D3D11 texture with a frame lease. Successful
submission transfers one release obligation to the SDK; failure leaves it with
the caller. An asynchronous encoder must retain the lease before returning from
its encode callback and release it only after hardware completion. A COM reference
alone does not prevent a texture pool from overwriting its contents.

Encoded completions carry Annex B H.264 and the original RTP timestamp. Encoder
IDs are never reused; late completions are rejected after destruction. Peer close
is a callback barrier, and every peer must close before SDK shutdown or DLL unload.
The endpoint drains hardware jobs before freeing callback context.

`remotekit_rtc_encoded` returns the actual outgoing RTP timestamp through its
optional third argument. Use this value for receiver correlation: WebRTC adds a
random sender offset to the input timestamp.

`remotekit_rtc_request_stats` asynchronously delivers sender statistics, with at
most one request in flight; request at 1 Hz. Missing fields remain absent.
Sender `availableOutgoingBitrate` describes the video sending path; the same
field on the receiving client's peer describes its outgoing direction instead.

`remotekit_rtc_set_playout_delay(peer, min_ms, max_ms)` requests the negotiated
RTP playout-delay extension. Both limits must be multiples of 10 ms, with
`0 <= min <= max <= 40950`. The default is unset. `-1,-1` is a no-op only before
an explicit configuration; cancelling afterwards returns `INVALID_STATE` and
keeps the request. Recreate the peer to restore default receiver behavior.
Updating an explicit pair remains supported. This additive export keeps ABI 2;
the updated endpoint requires an SDK containing it. Statistics report the
requested limits, not a measured end-to-end delay guarantee.

The reliable ordered DataChannel is named `remotekit`. Client messages and
authorization boundaries are described in [streaming protocol](streaming-protocol.md).
Runtime and hardware validation results are maintained in [current state](current-state.zh-CN.md).

## Runtime media policy and capture clocks

`remotekit_rtc_submit_audio(peer, pcm, frames, generation, sequence, sample_index, first_sample_qpc, discontinuity)` is an additive audio export. It accepts interleaved S16 stereo at 48 kHz, 480 frames per block, on a dedicated audio thread. PCM is copied during the call; success means accepted, not remotely played. Generation and sample index preserve the source timeline, and the first sample uses local QPC. Audio is negotiated only for a receiving client; video-only peers remain supported. The updated Endpoint requires the corresponding SDK export. See [audio ownership and lifecycle](audio-and-files.zh-CN.md).

`remotekit_rtc_set_media_policy(peer, target_bps, max_bps, fps)` is an additive export. It adjusts sender limits without resetting congestion-control start bitrate. Repeating the same policy is a no-op; an FPS-only change does not reset bandwidth estimation. Endpoint reports requested and actually applied policy separately; missing exports return explicit unsupported behavior.

Capture metadata is mapped from the original QPC timestamp to wall time before the SDK changes timestamp domains. `captureWallTimeMs`, `captureMonotonicMs`, `captureClockUncertaintyMs`, and decimal `sourceCaptureId` are optional and paired with actual wire RTP/epoch. Missing capture time is omitted, never replaced by ready/encode time. This does not change frame ABI or add Browser–Endpoint frame IPC. See [feedback timing](media-feedback.md).
