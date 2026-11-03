# Loopback hotfix build verification — 2026-11-03

## Result and boundary

The existing `out/dev` formal Browser, SDK and BeginFrame probe are up to date with the audio-placement fix and synchronous Viz admission fix. Incremental build verification and all targeted CPU probes passed. SDK export is complete. The unchanged Release Endpoint target is already up to date. This is build/CPU evidence; real Browser device enumeration, audio PCM delivery, RTC lifetime and GPU/runtime acceptance remain pending root GO.

No Control changes, full test suite, performance matrix, GPU experiment, clean build, new output directory or user-process termination was performed.

## Build and patch evidence

- Ran `C:/src/depot_tools/python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_begin_frame_probe` against existing `C:/src/chromium/src/out/dev`: exit 0, `ninja: no work to do`, `14.59s Build Succeeded: 0 steps`. This resumes the interrupted build and verifies its outputs rather than claiming a new compile.
- Browser and probe output mtimes are `2026-11-02T23:10:01Z` (07:10:01 UTC+8). The formal `browser/main_delegate.cc` and `browser/begin_frame_probe.cc` staged files are byte-identical to repository source.
- `tools/patchset.py --chromium-root C:/src/chromium/src status` reports all 11 patches applied. Its isolated snapshot reverses applied deltas in reverse order and replays the full series in order. The same verification was repeated while producing the manifest; the real Chromium tree was untouched.
- Patch 0011 SHA256 is `d1045e1e20327d0f1361753d45622729df39d9ec0177784b88108916ee99b40c`, matching `patches/manifest.json`.
- Exported with `tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev`; all 195 runtime dependencies, three public headers and the import library were checked byte-for-byte against their sources.
- `ninja -C build/endpoint-package -n endpoint_service` after export reports no work. Existing CMake cache is Release; no Endpoint rebuild was necessary.
- `git diff --check` passed (only existing CRLF-to-LF informational warnings).

## Probe results

The default run passed all three real DisplayScheduler lifecycle cases. `--mojo-stale`, `--mojo-sync` (wait=1), and `--mojo-sync-fast` (wait=0) passed with exit 0.

The six negative runs `--mojo-sync-duplicate`, `--mojo-pending-duplicate`, `--mojo-foreign`, `--mojo-future`, `--mojo-unproven-old`, and `--mojo-duplicate` each exited `2147483651` (`0x80000003`) and emitted the required `Check failed:` fatal. They did not pass silently. The new duplicate probes fail specifically at `!display_finished_current_frame_`.

Per-run logs and full fatal stacks: `develop/tmp/loopback-hotfix-build/`. Machine-readable paths, sizes, UTC mtimes, hashes, exact probe output and patch states: `develop/tmp/loopback-hotfix-build-manifest.json`.

## Artifact identity

| Artifact | SHA256 |
| --- | --- |
| `C:/src/chromium/src/out/dev/remotekit_browser.exe` | `dc6351322e7b934d2c4d7e172d158cce06b6157227787e360f259fa3c712b501` |
| `C:/src/chromium/src/out/dev/remotekit_sdk.dll` | `c41fff82d4792410ed33095adced1d2d22cdc436e91e453e91f1dfc454e9e04f` |
| `C:/src/chromium/src/out/dev/remotekit_sdk.dll.lib` | `42b811ddb737cf8b9e53798d3d4d0462e3e18bec070a7c6d5a8d36b70a8ee6d5` |
| `C:/src/chromium/src/out/dev/remotekit_begin_frame_probe.exe` | `00bd0f768ed3d3c8d250e693b1c3daf744bacb92819a90d4cbe5ac69befcff5f` |
| `build/endpoint-package/endpoint/endpoint_service.exe` | `ef383b7656ce052d9dc573b6a93eac81c0596bbf08949402312557bc555ed6c8` |

QA may use the Browser/runtime tree at `C:/src/chromium/src/out/dev`, SDK at `sdk/dist/dev` and existing Release Endpoint above. No runtime acceptance has been inferred from these probes.

## 后续实际验收

本轮已完成[增量构建及原生正反例](loopback-hotfix-build-20261103.md)和[89/157真实运行](loopback-crash-runtime-qa-20261103.md)。上文pending说明为该步骤创建时状态；新包仍须独立验收，不能由源码运行替代。
