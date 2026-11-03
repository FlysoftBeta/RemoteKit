# Audio device monitoring routing regression

## Evidence and change

The released `1e13f11` package's actual Session Browser log contains repeated
`services/audio/service.cc:166` fatal `enable_remote_client_support_` checks.
At 06:54:08.771 and 06:54:22.891 these precede the Browser launches visible in
the supplied Endpoint log. The task trace identifies
`MediaDevicesManager::HandleEnumerateDevicesRequest`.

RemoteKit supplies its own `AudioManager`, so Chromium creates an embedded
audio service with remote-client support disabled. Windows device monitoring
instead tests the raw `AudioServiceOutOfProcess` feature, enabled by default,
and attempts to bind the remote-only DeviceNotifier. That assertion runs in
the Browser process. Endpoint producer retirement and new RTC peers follow
the Browser exit. Unreachable ICE candidate errors do not explain this fatal.

Formal Browser startup now explicitly disables `AudioServiceOutOfProcess`
before FeatureList initialization, consistently with the existing custom
in-process playback target. The demo does not receive this override. No
assertion was removed, and no system capture path was introduced.

The same log also contains independent Viz BeginFrame CHECK failures; this
audio correction does not claim to fix those.

## Targeted runtime acceptance

Build evidence and runtime results are pending; source review alone is not
acceptance. Serve `tools/audio-files-qa-server.mts` in an isolated run directory
and navigate the formal Browser to its loopback `/audio-device-probe` route.
The fixture uses no startup flags to alter audio placement. It subscribes to
`devicechange` and executes its first `enumerateDevices()` before any playback,
then repeats ten times. Check `audio-device-probe passed`, all ten event
receipts, the same Browser PID/incarnation, and no Browser audio fatal. The
pre-playback first request covers the initial service placement that was
missing from the earlier oscillator-only sound test; subsequent requests
exercise monitoring reuse. No physical device change is required or claimed.

Click `Start playback` through the actual remote input path. Verify the
`audio-device-playback` receipt and the Viewer audio receiver using the
existing `tools/audio-files-qa-browser.js` analyser: nonzero received PCM with
left ~440Hz and right ~880Hz. An AudioContext `running` receipt alone is not
proof of PCM delivery. Confirm the Browser PID/incarnation still matches,
enumeration completes during playback, and the Browser log has neither the
audio fatal nor a new unexpected restart. Inventory only this run's child
processes if checking that no standalone Audio Service launched; do not
inspect or terminate unrelated user processes.

## 后续实际验收

本轮已完成[增量构建及原生正反例](loopback-hotfix-build-20261103.md)和[89/157真实运行](loopback-crash-runtime-qa-20261103.md)。上文pending说明为该步骤创建时状态；新包仍须独立验收，不能由源码运行替代。
